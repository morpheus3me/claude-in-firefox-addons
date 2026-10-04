#!/usr/bin/env node

// Native Messaging Host for Open Claude in Firefox extension.
// Launched by Firefox when the extension calls connectNative().
// Bridges between Firefox native messaging (stdin/stdout, 4-byte LE length prefix + JSON)
// and the MCP server (TCP on localhost).

import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadOrCreateToken, clientHandshake } from "./auth.js";

const DEFAULT_PORT = 18765;

function getPort() {
  const configPath = path.join(
    os.homedir(),
    ".config",
    "open-claude-in-firefox",
    "config.json"
  );
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    return config.port || DEFAULT_PORT;
  } catch {
    return DEFAULT_PORT;
  }
}

// --- Native messaging protocol (Firefox <-> this process) ---

function readNativeMessage(buffer) {
  const messages = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const len = buffer.readUInt32LE(offset);
    if (offset + 4 + len > buffer.length) break;
    const json = buffer.subarray(offset + 4, offset + 4 + len).toString("utf-8");
    try {
      messages.push(JSON.parse(json));
    } catch (e) {
      // skip malformed
    }
    offset += 4 + len;
  }
  return { messages, remainder: buffer.subarray(offset) };
}

function writeNativeMessage(obj) {
  const json = JSON.stringify(obj);
  const buf = Buffer.from(json, "utf-8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(buf.length, 0);
  process.stdout.write(Buffer.concat([header, buf]));
}

// --- TCP connection to MCP server ---

let tcpSocket = null;
let tcpReady = false; // true only after the MCP server has authenticated itself
let reconnectTimer = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 60; // 30 seconds at 500ms intervals
const MAX_LINE_BYTES = 64 * 1024 * 1024;
const TCP_PORT = getPort();

let AUTH_TOKEN;
try {
  AUTH_TOKEN = loadOrCreateToken();
} catch (e) {
  process.stderr.write(`open-claude-in-firefox native host: cannot load auth token: ${e.message}\n`);
  process.exit(1);
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setInterval(() => {
    reconnectAttempts++;
    if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
      // MCP server is gone — exit cleanly so we don't linger as a zombie
      clearInterval(reconnectTimer);
      process.exit(0);
    }
    if (!tcpSocket) connectTcp();
  }, 500);
}

function connectTcp() {
  if (tcpSocket) return;

  const socket = new net.Socket();
  tcpSocket = socket;
  tcpReady = false;

  socket.connect(TCP_PORT, "127.0.0.1", () => {
    clientHandshake(socket, AUTH_TOKEN, "native", (err, rest) => {
      if (err) {
        process.stderr.write(`open-claude-in-firefox native host: ${err.message}\n`);
        socket.destroy();
        return;
      }
      reconnectAttempts = 0;
      if (reconnectTimer) {
        clearInterval(reconnectTimer);
        reconnectTimer = null;
      }
      tcpReady = true;
      startForwarding(socket, rest);
    });
  });

  socket.on("error", () => {});

  socket.on("close", () => {
    if (tcpSocket === socket) {
      tcpSocket = null;
      tcpReady = false;
    }
    scheduleReconnect();
  });
}

// Forward newline-delimited JSON from the (authenticated) MCP server to the extension.
function startForwarding(socket, initial) {
  let tcpBuffer = initial;

  const drain = () => {
    let newlineIdx;
    while ((newlineIdx = tcpBuffer.indexOf(10)) !== -1) {
      const line = tcpBuffer.subarray(0, newlineIdx).toString("utf-8").trim();
      tcpBuffer = tcpBuffer.subarray(newlineIdx + 1);
      if (!line) continue;
      try {
        writeNativeMessage(JSON.parse(line));
      } catch {
        // skip malformed
      }
    }
    if (tcpBuffer.length > MAX_LINE_BYTES) socket.destroy();
  };

  socket.on("data", (chunk) => {
    tcpBuffer = Buffer.concat([tcpBuffer, chunk]);
    drain();
  });
  drain();
}

// --- Main: bridge stdin (from extension) <-> TCP (to MCP server) ---

let stdinBuffer = Buffer.alloc(0);

process.stdin.on("data", (chunk) => {
  stdinBuffer = Buffer.concat([stdinBuffer, chunk]);
  const { messages, remainder } = readNativeMessage(stdinBuffer);
  stdinBuffer = remainder;

  for (const msg of messages) {
    // Forward to MCP server via TCP, but never to an unauthenticated peer
    if (tcpReady && tcpSocket && !tcpSocket.destroyed) {
      tcpSocket.write(JSON.stringify(msg) + "\n");
    }
  }
});

process.stdin.on("end", () => {
  // Extension disconnected
  if (tcpSocket) tcpSocket.destroy();
  process.exit(0);
});

// Start TCP connection
connectTcp();
