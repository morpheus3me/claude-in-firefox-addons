// Shared authentication for the local TCP channel between mcp-server.js
// (primary), client MCP servers, and native-host.js.
//
// A random secret is stored in ~/.config/open-claude-in-firefox/auth-token
// (mode 0600, directory 0700), so only the current OS user can read it.
// Connections authenticate with an HMAC challenge-response in BOTH directions:
// the connector proves it knows the secret, and the server proves it back.
// The secret itself is never sent over the socket, so a process squatting on
// the port learns nothing and cannot pass itself off as the primary.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const CONFIG_DIR = path.join(os.homedir(), ".config", "open-claude-in-firefox");
const TOKEN_PATH = path.join(CONFIG_DIR, "auth-token");
const PROTOCOL = "oc-ff-auth-v1";
const HANDSHAKE_TIMEOUT_MS = 3000;
const MAX_HANDSHAKE_LINE = 4096;
const IS_POSIX = process.platform !== "win32";

function checkOwnership(p, expectedMode) {
  if (!IS_POSIX) return;
  const st = fs.statSync(p);
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
    throw new Error(`${p} is not owned by the current user; refusing to use it.`);
  }
  if ((st.mode & 0o077) !== 0) fs.chmodSync(p, expectedMode);
}

function readToken() {
  checkOwnership(TOKEN_PATH, 0o600);
  const token = fs.readFileSync(TOKEN_PATH, "utf-8").trim();
  if (!/^[0-9a-f]{64}$/.test(token)) throw new Error(`Invalid auth token in ${TOKEN_PATH}`);
  return token;
}

// Returns the shared secret, creating it on first use.
export function loadOrCreateToken() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  checkOwnership(CONFIG_DIR, 0o700);

  try {
    return readToken();
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }

  // Write to a private temp file, then hard-link it into place. link() fails
  // if the target exists, so concurrent creators never see a half-written file.
  const tmp = path.join(CONFIG_DIR, `.auth-token.${process.pid}.${crypto.randomBytes(4).toString("hex")}`);
  fs.writeFileSync(tmp, crypto.randomBytes(32).toString("hex") + "\n", { mode: 0o600, flag: "wx" });
  try {
    fs.linkSync(tmp, TOKEN_PATH);
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
  return readToken();
}

function mac(token, direction, role, serverNonce, clientNonce) {
  return crypto
    .createHmac("sha256", token)
    .update(`${PROTOCOL}|${direction}|${role}|${serverNonce}|${clientNonce}`)
    .digest("hex");
}

function safeEqualHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, "utf-8"), Buffer.from(b, "utf-8"));
}

const isNonce = (n) => typeof n === "string" && /^[0-9a-f]{32}$/.test(n);

// Reads newline-delimited JSON lines from a socket until `onLine` returns true.
// Hands any bytes after the final consumed line to `done(null, rest)`.
function readHandshakeLines(socket, onLine, done) {
  let buffer = Buffer.alloc(0);
  let finished = false;

  const finish = (err, rest) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    socket.removeListener("data", onData);
    socket.removeListener("close", onClose);
    done(err, rest);
  };

  const timer = setTimeout(() => finish(new Error("handshake timed out")), HANDSHAKE_TIMEOUT_MS);
  const onClose = () => finish(new Error("connection closed during handshake"));

  function onData(chunk) {
    buffer = Buffer.concat([buffer, chunk]);
    let idx;
    while ((idx = buffer.indexOf(10)) !== -1) {
      const line = buffer.subarray(0, idx).toString("utf-8").trim();
      buffer = buffer.subarray(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return finish(new Error("malformed handshake message"));
      }
      let result;
      try {
        result = onLine(msg);
      } catch (e) {
        return finish(e);
      }
      if (result === true) return finish(null, buffer);
    }
    if (buffer.length > MAX_HANDSHAKE_LINE) finish(new Error("handshake message too large"));
  }

  socket.on("data", onData);
  socket.on("close", onClose);
}

// Server side. Calls done(null, { role, rest }) once the peer is authenticated.
export function serverHandshake(socket, token, allowedRoles, done) {
  const serverNonce = crypto.randomBytes(16).toString("hex");
  let role = null;

  readHandshakeLines(
    socket,
    (msg) => {
      if (msg.type !== "auth_hello" || !allowedRoles.includes(msg.role) || !isNonce(msg.nonce)) {
        throw new Error("unexpected handshake message");
      }
      if (!safeEqualHex(msg.mac, mac(token, "c2s", msg.role, serverNonce, msg.nonce))) {
        throw new Error("authentication failed");
      }
      role = msg.role;
      socket.write(
        JSON.stringify({ type: "auth_ok", mac: mac(token, "s2c", role, serverNonce, msg.nonce) }) + "\n"
      );
      return true;
    },
    (err, rest) => (err ? done(err) : done(null, { role, rest }))
  );

  socket.write(JSON.stringify({ type: "auth_challenge", protocol: PROTOCOL, nonce: serverNonce }) + "\n");
}

// Connector side. Calls done(null, rest) only after the server has proven it
// knows the secret; nothing else should be sent or trusted before that.
export function clientHandshake(socket, token, role, done) {
  const clientNonce = crypto.randomBytes(16).toString("hex");
  let serverNonce = null;

  readHandshakeLines(
    socket,
    (msg) => {
      if (serverNonce === null) {
        if (msg.type !== "auth_challenge" || msg.protocol !== PROTOCOL || !isNonce(msg.nonce)) {
          throw new Error("server did not send a valid auth challenge");
        }
        serverNonce = msg.nonce;
        socket.write(
          JSON.stringify({
            type: "auth_hello",
            role,
            nonce: clientNonce,
            mac: mac(token, "c2s", role, serverNonce, clientNonce),
          }) + "\n"
        );
        return false;
      }
      if (msg.type !== "auth_ok" || !safeEqualHex(msg.mac, mac(token, "s2c", role, serverNonce, clientNonce))) {
        throw new Error("server failed to authenticate (another process may be using the port)");
      }
      return true;
    },
    done
  );
}
