// Background script for Open Claude in Firefox extension.
// Handles: native messaging, Firefox WebExtension APIs, tool dispatch, window management,
// and the safety layer (tab allowlist, per-site permissions, plan approval,
// confirmation of high-risk actions).

self.addEventListener("unhandledrejection", (event) => {
  event.preventDefault();
});

const NATIVE_HOST_NAME = "com.anthropic.open_claude_in_firefox";
const PROMPT_TIMEOUT_MS = 120000;

const DEFAULT_SETTINGS = {
  requireSitePermission: true, // ask before Claude reads or acts on a site for the first time
  requirePlanApproval: true, // update_plan opens an approval dialog
  confirmHighRisk: true, // confirm purchases, submissions, deletions, credentials, JS execution
};

// Keys in storage.session (cleared when Firefox restarts, so stale tab/window
// IDs can never be reused to adopt a tab the user opened) and storage.local.
const S_WINDOW = "mcpWindowId";
const S_TABS = "mcpTabIds";
const S_SITE_HOSTS = "sessionSiteHosts"; // exact hosts allowed for this session
const S_PLAN_DOMAINS = "sessionPlanDomains"; // domains (incl. subdomains) from approved plans
const S_JS_HOSTS = "sessionJsHosts"; // hosts where javascript_tool is allowed this session
const L_SETTINGS = "settings";
const L_ALWAYS_HOSTS = "alwaysAllowedHosts";

// --- State ---
let nativePort = null;
let mcpWindowId = null;
const mcpTabs = new Set(); // tabs Claude may control: created by Claude, or opened by those tabs
const consoleMessages = new Map(); // tabId -> [{level, text, timestamp, url}]
const networkRequests = new Map(); // tabId -> [{url, method, status, type, timestamp, requestId}]
const screenshotStore = new Map(); // imageId -> base64
const consoleInterceptors = new Set(); // tabIds with interceptor installed

// --- Storage helpers ---
async function sessionGet(key, fallback) {
  try {
    const v = (await chrome.storage.session.get(key))[key];
    return v === undefined ? fallback : v;
  } catch {
    return fallback;
  }
}

async function sessionSet(key, value) {
  try {
    await chrome.storage.session.set({ [key]: value });
  } catch {}
}

async function localGet(key, fallback) {
  try {
    const v = (await chrome.storage.local.get(key))[key];
    return v === undefined ? fallback : v;
  } catch {
    return fallback;
  }
}

async function getSettings() {
  return { ...DEFAULT_SETTINGS, ...(await localGet(L_SETTINGS, {})) };
}

async function addToSessionList(key, value) {
  const list = await sessionGet(key, []);
  if (!list.includes(value)) {
    list.push(value);
    await sessionSet(key, list);
  }
}

// --- Keep-alive alarm ---
chrome.alarms.create("keepalive", { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "keepalive") {
    if (!nativePort) connectNativeHost();
  }
});

// --- Native messaging ---
function connectNativeHost() {
  if (nativePort) return;
  try {
    nativePort = chrome.runtime.connectNative(NATIVE_HOST_NAME);

    nativePort.onMessage.addListener((msg) => {
      if (msg.type === "tool_request" && msg.id) {
        handleToolRequest(msg.id, msg.tool, msg.args || {});
      }
    });

    nativePort.onDisconnect.addListener(() => {
      nativePort = null;
      setTimeout(connectNativeHost, 2000);
    });
  } catch (e) {
    nativePort = null;
    setTimeout(connectNativeHost, 2000);
  }
}

function sendResponse(id, result) {
  if (!nativePort) return;
  try {
    nativePort.postMessage({ id, type: "tool_response", result });
  } catch {
    // Port disconnected
  }
}

function sendError(id, error) {
  if (!nativePort) return;
  try {
    nativePort.postMessage({ id, type: "tool_error", error: String(error) });
  } catch {
    // Port disconnected
  }
}

function textResult(text) {
  return { content: [{ type: "text", text }] };
}

// --- User prompts (permission / plan / high-risk dialogs) ---
// Each prompt opens confirm.html in its own popup window. Only that page, in
// that window, may read the prompt or answer it.
const pendingPrompts = new Map(); // promptId -> { data, resolve, timer, windowReady, windowId }
const CONFIRM_URL = chrome.runtime.getURL("confirm.html");

function finishPrompt(id, decision) {
  const entry = pendingPrompts.get(id);
  if (!entry) return;
  pendingPrompts.delete(id);
  clearTimeout(entry.timer);
  if (entry.windowId != null) chrome.windows.remove(entry.windowId).catch(() => {});
  entry.resolve(decision);
}

function askUser(data) {
  const id = crypto.randomUUID();
  return new Promise((resolve) => {
    const entry = { data, resolve, windowId: null };
    entry.timer = setTimeout(() => finishPrompt(id, "timeout"), PROMPT_TIMEOUT_MS);
    entry.windowReady = chrome.windows
      .create({ url: `${CONFIRM_URL}#${id}`, type: "popup", width: 480, height: 560, focused: true })
      .then((win) => {
        entry.windowId = win.id;
        return win.id;
      })
      .catch(() => {
        finishPrompt(id, "error");
        return null;
      });
    pendingPrompts.set(id, entry);
  });
}

chrome.windows.onRemoved.addListener((windowId) => {
  for (const [id, entry] of pendingPrompts) {
    if (entry.windowId === windowId) finishPrompt(id, "deny");
  }
  if (windowId === mcpWindowId) {
    mcpWindowId = null;
    sessionSet(S_WINDOW, null);
  }
});

const PROMPT_DECISIONS = {
  site: ["deny", "session", "always"],
  plan: ["deny", "approve"],
  action: ["deny", "once"],
  javascript: ["deny", "once", "session"],
};

function isPromptSender(sender) {
  return sender.id === chrome.runtime.id && typeof sender.url === "string" && sender.url.startsWith(CONFIRM_URL);
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.type !== "prompt_get" && msg?.type !== "prompt_decision") return false;
  const entry = pendingPrompts.get(msg.id);
  if (!entry || !isPromptSender(sender)) {
    reply({ error: "unknown prompt" });
    return false;
  }
  entry.windowReady.then((windowId) => {
    if (sender.tab && sender.tab.windowId !== windowId) {
      reply({ error: "unknown prompt" });
      return;
    }
    if (msg.type === "prompt_get") {
      reply({ data: entry.data });
    } else if (PROMPT_DECISIONS[entry.data.kind]?.includes(msg.decision)) {
      reply({ ok: true });
      finishPrompt(msg.id, msg.decision);
    } else {
      reply({ error: "invalid decision" });
    }
  });
  return true;
});

// --- Site permissions ---
function hostMatchesExact(host, entry) {
  return host === entry || host === `www.${entry}` || `www.${host}` === entry;
}

function hostMatchesDomain(host, domain) {
  return host === domain || host.endsWith(`.${domain}`);
}

// Pages without a site (blank tabs) need no permission; other non-web pages are off limits.
function classifyUrl(urlStr) {
  let url;
  try {
    url = new URL(urlStr || "about:blank");
  } catch {
    return { kind: "invalid" };
  }
  if (url.protocol === "http:" || url.protocol === "https:") return { kind: "web", host: url.hostname.toLowerCase() };
  if (["about:blank", "about:newtab", "about:home"].includes(url.href)) return { kind: "blank" };
  return { kind: "restricted", protocol: url.protocol };
}

async function isHostAllowed(host) {
  const always = await localGet(L_ALWAYS_HOSTS, []);
  if (always.some((e) => hostMatchesExact(host, e))) return true;
  const sessionHosts = await sessionGet(S_SITE_HOSTS, []);
  if (sessionHosts.some((e) => hostMatchesExact(host, e))) return true;
  const planDomains = await sessionGet(S_PLAN_DOMAINS, []);
  return planDomains.some((d) => hostMatchesDomain(host, d));
}

const sitePromptsInFlight = new Map(); // host -> Promise<decision>

// Returns null if allowed, or a tool result explaining the refusal.
async function ensureSiteAllowed(urlStr, purpose) {
  const target = classifyUrl(urlStr);
  if (target.kind === "blank") return null;
  if (target.kind !== "web") {
    return textResult(`Claude cannot ${purpose} on this page (${urlStr}). Only http(s) sites are supported.`);
  }

  const settings = await getSettings();
  if (!settings.requireSitePermission) return null;
  if (await isHostAllowed(target.host)) return null;

  let pending = sitePromptsInFlight.get(target.host);
  if (!pending) {
    pending = askUser({ kind: "site", host: target.host, url: urlStr, purpose });
    sitePromptsInFlight.set(target.host, pending);
    pending.finally(() => sitePromptsInFlight.delete(target.host));
  }
  const decision = await pending;

  if (decision === "always") {
    const always = await localGet(L_ALWAYS_HOSTS, []);
    if (!always.includes(target.host)) {
      always.push(target.host);
      await chrome.storage.local.set({ [L_ALWAYS_HOSTS]: always });
    }
    return null;
  }
  if (decision === "session") {
    await addToSessionList(S_SITE_HOSTS, target.host);
    return null;
  }
  const why = decision === "timeout" ? "did not respond to the permission request" : "declined permission";
  return textResult(
    `Permission denied: the user ${why} for ${target.host}. Do not retry or try to work around this; ask the user how they would like to proceed.`
  );
}

// --- High-risk action detection ---
const RISK_KEYWORDS =
  /\b(buy|purchase|pay|checkout|check out|place order|order now|subscribe|unsubscribe|delete|remove|send|submit|confirm|transfer|withdraw|publish|share|sign up|register|book now|donate|accept|agree)\b|購買|購物車結帳|結帳|付款|支付|下單|訂購|訂閱|刪除|移除|送出|傳送|發送|提交|確認|轉帳|匯款|提款|發布|發佈|發表|分享|註冊|捐款|同意/i;

function describeRisk(action, info) {
  if (!info) return null;
  const label = info.text ? `"${info.text}"` : `<${info.tag}>`;
  if (action === "click") {
    if (info.isSubmit) return `Submit a form by clicking ${label}`;
    if (info.text && RISK_KEYWORDS.test(info.text)) return `Click ${label}`;
    return null;
  }
  if (action === "enter") {
    if (info.isSubmit || (info.inForm && info.tag === "input")) return `Press Enter to submit a form (focused: ${label})`;
    if (info.text && RISK_KEYWORDS.test(info.text) && ["button", "a"].includes(info.tag)) return `Press Enter on ${label}`;
    return null;
  }
  if (action === "input") {
    if (info.isPassword) return `Enter text into a password field (${label})`;
    if (info.isPayment) return `Enter text into a payment field (${label})`;
    return null;
  }
  return null;
}

// Returns null if the action may proceed, or a tool result if the user declined.
async function confirmIfHighRisk(tab, action, inspectMsg, summary) {
  const settings = await getSettings();
  if (!settings.confirmHighRisk) return null;
  let info = null;
  try {
    info = (await sendContentMessage(tab.id, { type: "inspectTarget", ...inspectMsg }))?.result;
  } catch {}
  const risk = describeRisk(action, info);
  if (!risk) return null;
  const decision = await askUser({
    kind: "action",
    host: classifyUrl(tab.url).host || "",
    url: tab.url,
    title: tab.title || "",
    description: risk,
    detail: summary,
  });
  if (decision === "once") return null;
  return textResult(
    `The user did not approve this high-risk action (${risk}). It was not performed. Do not retry; ask the user how to proceed.`
  );
}

// --- MCP tabs: only tabs Claude created (or that they opened) can be controlled ---
async function saveMcpTabs() {
  await sessionSet(S_TABS, [...mcpTabs]);
}

function addMcpTab(tabId) {
  mcpTabs.add(tabId);
  saveMcpTabs();
}

async function pruneMcpTabs() {
  for (const id of [...mcpTabs]) {
    try {
      await chrome.tabs.get(id);
    } catch {
      mcpTabs.delete(id);
    }
  }
  await saveMcpTabs();
}

async function createMcpTab() {
  if (mcpWindowId !== null) {
    try {
      await chrome.windows.get(mcpWindowId);
      const tab = await chrome.tabs.create({ windowId: mcpWindowId, url: "about:blank", active: true });
      addMcpTab(tab.id);
      return tab;
    } catch {
      mcpWindowId = null;
    }
  }
  const win = await chrome.windows.create({ focused: true, url: "about:blank" });
  mcpWindowId = win.id;
  await sessionSet(S_WINDOW, mcpWindowId);
  win.tabs.forEach((t) => mcpTabs.add(t.id));
  await saveMcpTabs();
  return win.tabs[0];
}

async function ensureMcpTabs(createIfEmpty) {
  await pruneMcpTabs();
  if (mcpTabs.size === 0 && createIfEmpty) await createMcpTab();
}

async function getMcpTabList() {
  const tabs = [];
  for (const id of mcpTabs) {
    try {
      tabs.push(await chrome.tabs.get(id));
    } catch {}
  }
  return tabs;
}

function formatTabContext(tabs) {
  const available = tabs.map((t) => ({
    tabId: t.id,
    title: t.title || "Untitled",
    url: t.url || "",
  }));

  let text = `Tab Context:\n- Available tabs:\n`;
  for (const t of available) {
    text += `  • tabId ${t.tabId}: "${t.title}" (${t.url})\n`;
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ availableTabs: available, mcpWindowId }) + "\n\n" + text,
      },
    ],
  };
}

async function isInGroup(tabId) {
  if (!mcpTabs.has(tabId)) return false;
  try {
    await chrome.tabs.get(tabId);
    return true;
  } catch {
    return false;
  }
}

// Returns { tab } if Claude may work in this tab, or { denied: toolResult }.
async function guardTab(tabId, purpose) {
  if (!(await isInGroup(tabId))) {
    return {
      denied: textResult(
        `Tab ${tabId} is not one of Claude's tabs. Use tabs_context_mcp / tabs_create_mcp to get a tab Claude created.`
      ),
    };
  }
  const tab = await chrome.tabs.get(tabId);
  const denied = await ensureSiteAllowed(tab.url, purpose);
  return denied ? { denied } : { tab };
}

// Tabs opened by Claude's tabs (links with target=_blank, popups) join the
// allowlist, like Chrome tab groups. They still need site permission.
chrome.tabs.onCreated.addListener((tab) => {
  if (tab.openerTabId !== undefined && mcpTabs.has(tab.openerTabId)) addMcpTab(tab.id);
});

// Clean up when tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
  if (mcpTabs.delete(tabId)) saveMcpTabs();
  consoleMessages.delete(tabId);
  networkRequests.delete(tabId);
  consoleInterceptors.delete(tabId);
});

// --- Network monitoring via webRequest (Claude's tabs only) ---
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (!mcpTabs.has(details.tabId)) return;
    const reqs = networkRequests.get(details.tabId) || [];
    reqs.push({
      url: details.url,
      method: details.method,
      status: 0,
      type: details.type || "Other",
      timestamp: Date.now(),
      requestId: details.requestId,
    });
    if (reqs.length > 1000) reqs.splice(0, reqs.length - 1000);
    networkRequests.set(details.tabId, reqs);
  },
  { urls: ["<all_urls>"] }
);

chrome.webRequest.onCompleted.addListener(
  (details) => {
    if (!mcpTabs.has(details.tabId)) return;
    const reqs = networkRequests.get(details.tabId) || [];
    for (let i = reqs.length - 1; i >= 0; i--) {
      if (reqs[i].requestId === details.requestId) {
        reqs[i].status = details.statusCode;
        const ctHeader = details.responseHeaders?.find(
          (h) => h.name.toLowerCase() === "content-type"
        );
        if (ctHeader) reqs[i].mimeType = ctHeader.value.split(";")[0].trim();
        break;
      }
    }
    networkRequests.set(details.tabId, reqs);
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

chrome.webRequest.onErrorOccurred.addListener(
  (details) => {
    if (!mcpTabs.has(details.tabId)) return;
    const reqs = networkRequests.get(details.tabId) || [];
    for (let i = reqs.length - 1; i >= 0; i--) {
      if (reqs[i].requestId === details.requestId) {
        reqs[i].status = -1;
        reqs[i].error = details.error;
        break;
      }
    }
    networkRequests.set(details.tabId, reqs);
  },
  { urls: ["<all_urls>"] }
);

// --- Key code mapping ---
const KEY_MAP = {
  enter: "Enter", return: "Enter", tab: "Tab", escape: "Escape", esc: "Escape",
  backspace: "Backspace", delete: "Delete", space: "Space", " ": "Space",
  arrowup: "ArrowUp", arrowdown: "ArrowDown", arrowleft: "ArrowLeft", arrowright: "ArrowRight",
  up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight",
  home: "Home", end: "End", pageup: "PageUp", pagedown: "PageDown",
  f1: "F1", f2: "F2", f3: "F3", f4: "F4", f5: "F5", f6: "F6",
  f7: "F7", f8: "F8", f9: "F9", f10: "F10", f11: "F11", f12: "F12",
};

function parseKeyCombo(keyStr) {
  const parts = keyStr.split("+").map((p) => p.trim().toLowerCase());
  let modifiers = 0;
  let key = "";
  for (const part of parts) {
    if (part === "ctrl" || part === "control") modifiers |= 2;
    else if (part === "alt") modifiers |= 1;
    else if (part === "shift") modifiers |= 8;
    else if (part === "meta" || part === "cmd" || part === "command" || part === "win" || part === "windows") modifiers |= 4;
    else key = KEY_MAP[part] || part;
  }
  return { key, modifiers };
}

function parseModifierString(modStr) {
  if (!modStr) return 0;
  let modifiers = 0;
  const parts = modStr.split("+").map((p) => p.trim().toLowerCase());
  for (const part of parts) {
    if (part === "ctrl" || part === "control") modifiers |= 2;
    else if (part === "alt") modifiers |= 1;
    else if (part === "shift") modifiers |= 8;
    else if (part === "meta" || part === "cmd" || part === "command" || part === "win" || part === "windows") modifiers |= 4;
  }
  return modifiers;
}

// --- Content script communication ---
async function sendContentMessage(tabId, message) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, message);
    return response;
  } catch {
    // Content script might not be injected yet, try injecting
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    });
    return chrome.tabs.sendMessage(tabId, message);
  }
}

// --- Resolve ref to coordinates ---
async function resolveRefToCoordinates(tabId, ref) {
  const resp = await sendContentMessage(tabId, { type: "getRefCoordinates", ref });
  if (resp?.result) return [resp.result.x, resp.result.y];
  return null;
}

// --- Screenshot helper ---
// Firefox uses tabs.captureVisibleTab() — the tab must be active in its window.
async function takeScreenshot(tabId) {
  const tab = await chrome.tabs.get(tabId);

  // Activate the tab so captureVisibleTab captures the right content
  if (!tab.active) {
    await chrome.tabs.update(tabId, { active: true });
    await sleep(100);
  }

  let dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
    format: "jpeg",
    quality: 55,
  });
  let base64 = dataUrl.replace(/^data:image\/jpeg;base64,/, "");

  if (base64.length > 500000) {
    dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: "jpeg",
      quality: 30,
    });
    base64 = dataUrl.replace(/^data:image\/jpeg;base64,/, "");
  }

  const imageId = `screenshot_${Date.now()}`;
  screenshotStore.set(imageId, base64);
  const keys = Array.from(screenshotStore.keys());
  while (keys.length > 10) screenshotStore.delete(keys.shift());

  return { base64, imageId };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Console interceptor ---
// Installs a console override in the page's MAIN world to capture log messages.
// Messages before the interceptor is installed are not captured.
async function ensureConsoleInterceptor(tabId) {
  if (consoleInterceptors.has(tabId)) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => {
        if (window.__firefoxConsoleInterceptor) return;
        window.__firefoxConsoleInterceptor = true;
        window.__firefoxConsoleQueue = [];
        const methods = ["log", "info", "warn", "error", "debug"];
        for (const level of methods) {
          const orig = console[level].bind(console);
          console[level] = function (...args) {
            orig(...args);
            window.__firefoxConsoleQueue.push({
              level,
              text: args
                .map((a) => {
                  try {
                    return typeof a === "object" && a !== null
                      ? JSON.stringify(a)
                      : String(a);
                  } catch {
                    return String(a);
                  }
                })
                .join(" "),
              url: location.href,
              timestamp: Date.now(),
            });
            if (window.__firefoxConsoleQueue.length > 1000) {
              window.__firefoxConsoleQueue.splice(
                0,
                window.__firefoxConsoleQueue.length - 1000
              );
            }
          };
        }
      },
    });
    consoleInterceptors.add(tabId);
  } catch {}
}

// Normalizes a plan domain like "https://www.GitHub.com/foo" to "github.com".
// Returns null for anything that is not a plain hostname.
function normalizeDomain(input) {
  let d = String(input || "").trim().toLowerCase();
  d = d.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/[/?#].*$/, "").replace(/:\d+$/, "");
  d = d.replace(/^\*\./, "").replace(/^www\./, "").replace(/\.$/, "");
  if (d === "localhost") return d;
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d)) return null;
  return d;
}

// javascript_tool can do anything the page can, so it is always treated as
// high risk. The user may allow it for the rest of the session on one site.
async function confirmJavascript(tab, code) {
  const settings = await getSettings();
  if (!settings.confirmHighRisk) return null;
  const host = classifyUrl(tab.url).host || "";
  if ((await sessionGet(S_JS_HOSTS, [])).includes(host)) return null;
  const decision = await askUser({
    kind: "javascript",
    host,
    url: tab.url,
    title: tab.title || "",
    description: "Run JavaScript in the page",
    detail: code.length > 2000 ? code.slice(0, 2000) + "\n…" : code,
  });
  if (decision === "session") {
    await addToSessionList(S_JS_HOSTS, host);
    return null;
  }
  if (decision === "once") return null;
  return textResult(
    `The user did not approve running JavaScript on ${host}. It was not executed. Do not retry; ask the user how to proceed.`
  );
}

// --- Tool handlers ---
const toolHandlers = {
  async tabs_context_mcp(args) {
    await ensureMcpTabs(args.createIfEmpty);
    if (mcpTabs.size === 0) {
      return textResult("No MCP tabs exist. Use createIfEmpty: true to create one.");
    }
    return formatTabContext(await getMcpTabList());
  },

  async tabs_create_mcp(args) {
    await pruneMcpTabs();
    const tab = await createMcpTab();
    const result = formatTabContext(await getMcpTabList());
    result.content[0].text = `Created new tab. Tab ID: ${tab.id}\n\n` + result.content[0].text;
    return result;
  },

  async navigate(args) {
    const { url, tabId } = args;
    if (!(await isInGroup(tabId)))
      return textResult(`Tab ${tabId} is not one of Claude's tabs. Use tabs_context_mcp / tabs_create_mcp first.`);

    if (url === "back") {
      await chrome.tabs.goBack(tabId);
    } else if (url === "forward") {
      await chrome.tabs.goForward(tabId);
    } else {
      let targetUrl = String(url).trim();
      if (!/^https?:\/\//i.test(targetUrl) && targetUrl !== "about:blank") {
        // Only http(s) is allowed: reject javascript:, data:, file:, about:, moz-extension:, etc.
        if (/^[a-z][a-z0-9+.-]*:\/\//i.test(targetUrl) || /^(javascript|data|file|about|blob|moz-extension|view-source|chrome|resource):/i.test(targetUrl)) {
          return textResult(`Unsupported URL scheme in "${url}". Only http and https URLs can be opened.`);
        }
        targetUrl = "https://" + targetUrl;
      }
      try {
        new URL(targetUrl);
      } catch {
        return { content: [{ type: "text", text: `Invalid URL: "${url}". Could not parse as a valid URL.` }] };
      }
      const denied = await ensureSiteAllowed(targetUrl, "open this site");
      if (denied) return denied;
      await chrome.tabs.update(tabId, { url: targetUrl });
      // Console interceptor needs re-install after navigation
      consoleInterceptors.delete(tabId);
    }

    await new Promise((resolve) => {
      const listener = (updatedTabId, info) => {
        if (updatedTabId === tabId && info.status === "complete") {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
      setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }, 10000);
    });

    const tab = await chrome.tabs.get(tabId);
    const tabs = await getMcpTabList();
    const loading = tab.status !== "complete" ? " (still loading)" : "";
    const text =
      `Navigated to ${tab.url}${loading}.\n## Pages\n` +
      tabs.map((t, i) => `${i + 1}: ${t.url}${t.id === tabId ? " [selected]" : ""}`).join("\n");

    return { content: [{ type: "text", text }] };
  },

  async computer(args) {
    const { action, tabId } = args;
    if (action === "wait") {
      // Touches no page content, so only tab membership matters.
      if (!(await isInGroup(tabId))) return textResult(`Tab ${tabId} is not one of Claude's tabs.`);
      const duration = Math.min(args.duration || 1, 30);
      await sleep(duration * 1000);
      return textResult(`Waited for ${duration} second${duration !== 1 ? "s" : ""}`);
    }
    const guard = await guardTab(tabId, action === "screenshot" || action === "zoom" ? "view this site" : "interact with this site");
    if (guard.denied) return guard.denied;
    const tab = guard.tab;

    let coordinate = args.coordinate;
    if (args.ref && !coordinate) {
      const coords = await resolveRefToCoordinates(tabId, args.ref);
      if (!coords)
        return { content: [{ type: "text", text: `Could not resolve ref "${args.ref}" to coordinates.` }] };
      coordinate = coords;
    }

    const modifiers = parseModifierString(args.modifiers);

    switch (action) {
      case "screenshot": {
        const { base64, imageId } = await takeScreenshot(tabId);
        let dims = "";
        try {
          const vpResult = await chrome.scripting.executeScript({
            target: { tabId },
            world: "MAIN",
            func: () => window.innerWidth + "x" + window.innerHeight,
          });
          if (vpResult[0]?.result) dims = vpResult[0].result;
        } catch {}
        return {
          content: [
            { type: "text", text: `Successfully captured screenshot (${dims}, jpeg) - ID: ${imageId}` },
            { type: "image", data: base64, mimeType: "image/jpeg" },
          ],
        };
      }

      case "left_click": {
        if (!coordinate)
          return { content: [{ type: "text", text: "coordinate is required for left_click" }] };
        {
          const declined = await confirmIfHighRisk(tab, "click", { x: coordinate[0], y: coordinate[1] }, `left_click at (${coordinate[0]}, ${coordinate[1]})`);
          if (declined) return declined;
        }
        await sendContentMessage(tabId, {
          type: "dispatchMouseClick",
          x: coordinate[0], y: coordinate[1],
          button: "left", clickCount: 1, modifiers,
        });
        return { content: [{ type: "text", text: `Clicked at (${coordinate[0]}, ${coordinate[1]})` }] };
      }

      case "right_click": {
        if (!coordinate)
          return { content: [{ type: "text", text: "coordinate is required for right_click" }] };
        await sendContentMessage(tabId, {
          type: "dispatchMouseClick",
          x: coordinate[0], y: coordinate[1],
          button: "right", clickCount: 1, modifiers,
        });
        return { content: [{ type: "text", text: `Right-clicked at (${coordinate[0]}, ${coordinate[1]})` }] };
      }

      case "double_click": {
        if (!coordinate)
          return { content: [{ type: "text", text: "coordinate is required for double_click" }] };
        {
          const declined = await confirmIfHighRisk(tab, "click", { x: coordinate[0], y: coordinate[1] }, `double_click at (${coordinate[0]}, ${coordinate[1]})`);
          if (declined) return declined;
        }
        await sendContentMessage(tabId, {
          type: "dispatchMouseClick",
          x: coordinate[0], y: coordinate[1],
          button: "left", clickCount: 2, modifiers,
        });
        return { content: [{ type: "text", text: `Double-clicked at (${coordinate[0]}, ${coordinate[1]})` }] };
      }

      case "triple_click": {
        if (!coordinate)
          return { content: [{ type: "text", text: "coordinate is required for triple_click" }] };
        {
          const declined = await confirmIfHighRisk(tab, "click", { x: coordinate[0], y: coordinate[1] }, `triple_click at (${coordinate[0]}, ${coordinate[1]})`);
          if (declined) return declined;
        }
        await sendContentMessage(tabId, {
          type: "dispatchMouseClick",
          x: coordinate[0], y: coordinate[1],
          button: "left", clickCount: 3, modifiers,
        });
        return { content: [{ type: "text", text: `Triple-clicked at (${coordinate[0]}, ${coordinate[1]})` }] };
      }

      case "hover": {
        if (!coordinate)
          return { content: [{ type: "text", text: "coordinate is required for hover" }] };
        await sendContentMessage(tabId, {
          type: "dispatchMouseMove",
          x: coordinate[0], y: coordinate[1], modifiers,
        });
        await sleep(200);
        return { content: [{ type: "text", text: `Hovered at (${coordinate[0]}, ${coordinate[1]})` }] };
      }

      case "type": {
        if (!args.text)
          return { content: [{ type: "text", text: "text is required for type action" }] };
        {
          const declined = await confirmIfHighRisk(tab, "input", { active: true }, `type ${args.text.length} characters`);
          if (declined) return declined;
        }
        for (const char of args.text) {
          await sendContentMessage(tabId, { type: "insertText", text: char });
          await sleep(10);
        }
        return {
          content: [
            { type: "text", text: `Typed "${args.text.substring(0, 50)}${args.text.length > 50 ? "..." : ""}"` },
          ],
        };
      }

      case "key": {
        if (!args.text)
          return { content: [{ type: "text", text: "text is required for key action" }] };
        const repeat = Math.min(args.repeat || 1, 100);
        const keys = args.text.split(" ").filter(Boolean);
        if (keys.some((k) => parseKeyCombo(k).key === "Enter")) {
          const declined = await confirmIfHighRisk(tab, "enter", { active: true }, `press keys: ${args.text}`);
          if (declined) return declined;
        }
        for (let r = 0; r < repeat; r++) {
          for (const keyStr of keys) {
            const { key, modifiers: keyMod } = parseKeyCombo(keyStr);
            const code = key.length === 1 ? `Key${key.toUpperCase()}` : key;
            await sendContentMessage(tabId, {
              type: "dispatchKeyEvent", eventType: "keyDown",
              key, code, modifiers: keyMod,
            });
            await sendContentMessage(tabId, {
              type: "dispatchKeyEvent", eventType: "keyUp",
              key, code, modifiers: keyMod,
            });
            await sleep(30);
          }
        }
        return {
          content: [
            { type: "text", text: `Pressed ${repeat} key${repeat > 1 ? "s" : ""}: ${args.text}` },
          ],
        };
      }

      case "scroll": {
        if (!coordinate)
          return { content: [{ type: "text", text: "coordinate is required for scroll" }] };
        const dir = args.scroll_direction || "down";
        const amount = Math.min(args.scroll_amount || 3, 10);
        const deltaX = dir === "left" ? -amount * 100 : dir === "right" ? amount * 100 : 0;
        const deltaY = dir === "up" ? -amount * 100 : dir === "down" ? amount * 100 : 0;
        await sendContentMessage(tabId, {
          type: "dispatchScroll",
          x: coordinate[0], y: coordinate[1],
          deltaX, deltaY, modifiers,
        });
        await sleep(300);
        const { base64 } = await takeScreenshot(tabId);
        return {
          content: [
            { type: "text", text: `Scrolled ${dir} by ${amount} ticks at (${coordinate[0]}, ${coordinate[1]})` },
            { type: "image", data: base64, mimeType: "image/jpeg" },
          ],
        };
      }

      case "scroll_to": {
        if (!coordinate && !args.ref)
          return { content: [{ type: "text", text: "coordinate or ref is required for scroll_to" }] };
        if (args.ref) {
          await sendContentMessage(tabId, { type: "scrollToRef", ref: args.ref });
        }
        if (coordinate) {
          await sendContentMessage(tabId, {
            type: "scrollToPosition",
            x: coordinate[0], y: coordinate[1],
          });
        }
        await sleep(300);
        return { content: [{ type: "text", text: `Scrolled to target` }] };
      }

      case "wait": {
        const duration = Math.min(args.duration || 1, 30);
        await sleep(duration * 1000);
        return { content: [{ type: "text", text: `Waited for ${duration} second${duration !== 1 ? "s" : ""}` }] };
      }

      case "left_click_drag": {
        if (!args.start_coordinate || !coordinate) {
          return {
            content: [{ type: "text", text: "start_coordinate and coordinate are required for left_click_drag" }],
          };
        }
        const [sx, sy] = args.start_coordinate;
        const [ex, ey] = coordinate;
        await sendContentMessage(tabId, {
          type: "dispatchDrag",
          startX: sx, startY: sy, endX: ex, endY: ey, modifiers,
        });
        return { content: [{ type: "text", text: `Dragged from (${sx}, ${sy}) to (${ex}, ${ey})` }] };
      }

      case "zoom": {
        if (!args.region || args.region.length !== 4) {
          return { content: [{ type: "text", text: "region [x0, y0, x1, y1] is required for zoom" }] };
        }
        const { base64: fullBase64 } = await takeScreenshot(tabId);
        return {
          content: [
            { type: "text", text: `Zoom region: [${args.region.join(", ")}]` },
            { type: "image", data: fullBase64, mimeType: "image/jpeg" },
          ],
        };
      }

      default:
        return { content: [{ type: "text", text: `Unknown computer action: ${action}` }] };
    }
  },

  async read_page(args) {
    const { tabId } = args;
    const guard = await guardTab(tabId, "read this site");
    if (guard.denied) return guard.denied;

    const resp = await sendContentMessage(tabId, {
      type: "generateAccessibilityTree",
      options: {
        filter: args.filter,
        depth: args.depth,
        max_chars: args.max_chars,
        ref_id: args.ref_id,
      },
    });

    let tree = resp?.result || "Error: Could not generate accessibility tree";
    try {
      const vpResult = await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: () => window.innerWidth + "x" + window.innerHeight,
      });
      if (vpResult[0]?.result) tree += `\n\nViewport: ${vpResult[0].result}`;
    } catch {}
    return { content: [{ type: "text", text: tree }] };
  },

  async get_page_text(args) {
    const { tabId } = args;
    const guard = await guardTab(tabId, "read this site");
    if (guard.denied) return guard.denied;

    const resp = await sendContentMessage(tabId, { type: "getPageText" });
    if (!resp?.result)
      return { content: [{ type: "text", text: "Error: Could not extract page text" }] };

    try {
      const data = JSON.parse(resp.result);
      return {
        content: [
          {
            type: "text",
            text: `Title: ${data.title}\nURL: ${data.url}\nSource: <${data.sourceTag}>\n\n${data.text}`,
          },
        ],
      };
    } catch {
      return { content: [{ type: "text", text: resp.result }] };
    }
  },

  async find(args) {
    const { query, tabId } = args;
    const guard = await guardTab(tabId, "read this site");
    if (guard.denied) return guard.denied;

    const resp = await sendContentMessage(tabId, { type: "findElements", query });
    const results = resp?.result || [];

    if (results.length === 0) {
      return { content: [{ type: "text", text: `No elements found matching "${query}"` }] };
    }

    let text = `Found ${results.length} element(s) matching "${query}":\n\n`;
    for (const r of results) {
      text += `[${r.ref}] ${r.role} "${r.name}" at (${r.coordinates[0]}, ${r.coordinates[1]})\n`;
    }

    return { content: [{ type: "text", text }] };
  },

  async form_input(args) {
    const { ref, value, tabId } = args;
    const guard = await guardTab(tabId, "interact with this site");
    if (guard.denied) return guard.denied;

    const declined = await confirmIfHighRisk(guard.tab, "input", { ref }, `set ${ref} via form_input`);
    if (declined) return declined;

    const resp = await sendContentMessage(tabId, { type: "setFormValue", ref, value });
    const result = resp?.result;

    if (result?.error) return { content: [{ type: "text", text: `Error: ${result.error}` }] };
    return { content: [{ type: "text", text: `Set ${ref} to "${value}". Result: ${JSON.stringify(result)}` }] };
  },

  async javascript_tool(args) {
    const { text, tabId } = args;
    const guard = await guardTab(tabId, "run JavaScript on this site");
    if (guard.denied) return guard.denied;

    const declined = await confirmJavascript(guard.tab, text);
    if (declined) return declined;

    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: (code) => {
          try {
            const val = eval(code); // eslint-disable-line no-eval
            if (val && typeof val.then === "function") {
              return val
                .then((v) => ({ value: v === undefined ? "__undefined__" : v }))
                .catch((e) => ({ error: e.message }));
            }
            return { value: val === undefined ? "__undefined__" : val };
          } catch (e) {
            return { error: e.message };
          }
        },
        args: [text],
      });

      const result = results[0]?.result;
      if (!result) return { content: [{ type: "text", text: "undefined" }] };
      if (result.error)
        return { content: [{ type: "text", text: `Error: ${result.error}` }] };
      const val = result.value;
      if (val === "__undefined__") return { content: [{ type: "text", text: "undefined" }] };
      return {
        content: [
          {
            type: "text",
            text: typeof val === "object" && val !== null ? JSON.stringify(val) : String(val),
          },
        ],
      };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }] };
    }
  },

  async read_console_messages(args) {
    const { tabId, pattern, limit = 100, onlyErrors, clear } = args;
    const guard = await guardTab(tabId, "read this site's console");
    if (guard.denied) return guard.denied;

    await ensureConsoleInterceptor(tabId);

    let msgs = [];
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: (shouldClear) => {
          const queue = window.__firefoxConsoleQueue || [];
          const copy = queue.slice();
          if (shouldClear) window.__firefoxConsoleQueue = [];
          return copy;
        },
        args: [!!clear],
      });
      msgs = results[0]?.result || [];
    } catch {}

    if (clear) consoleMessages.delete(tabId);

    if (onlyErrors) {
      msgs = msgs.filter((m) => ["error", "exception"].includes(m.level));
    }

    if (pattern) {
      try {
        const re = new RegExp(pattern, "i");
        msgs = msgs.filter((m) => re.test(m.text) || re.test(m.level));
      } catch {
        msgs = msgs.filter((m) => m.text.includes(pattern));
      }
    }

    msgs = msgs.slice(-limit);

    if (msgs.length === 0) {
      return { content: [{ type: "text", text: "No console messages matching the pattern." }] };
    }

    const text = msgs
      .map((m) => `[${m.level}] ${m.text}${m.url ? ` (${m.url})` : ""}`)
      .join("\n");

    return { content: [{ type: "text", text: `Console messages (${msgs.length}):\n${text}` }] };
  },

  async read_network_requests(args) {
    const { tabId, urlPattern, limit = 100, clear } = args;
    const guard = await guardTab(tabId, "read this site's network activity");
    if (guard.denied) return guard.denied;

    let reqs = networkRequests.get(tabId) || [];

    if (urlPattern) {
      reqs = reqs.filter((r) => r.url.includes(urlPattern));
    }

    reqs = reqs.slice(-limit);

    if (clear) {
      networkRequests.set(tabId, []);
    }

    if (reqs.length === 0) {
      return { content: [{ type: "text", text: "No network requests matching the pattern." }] };
    }

    const text = reqs
      .map(
        (r) =>
          `${r.method} ${r.url} ${r.status ? `→ ${r.status}` : "(pending)"}${r.mimeType ? ` [${r.mimeType}]` : ""}`
      )
      .join("\n");

    return { content: [{ type: "text", text: `Network requests (${reqs.length}):\n${text}` }] };
  },

  async resize_window(args) {
    const { width, height, tabId } = args;
    if (!(await isInGroup(tabId)))
      return textResult(`Tab ${tabId} is not one of Claude's tabs.`);

    const tab = await chrome.tabs.get(tabId);
    await chrome.windows.update(tab.windowId, { width, height });
    return { content: [{ type: "text", text: `Resized window to ${width}x${height}` }] };
  },

  async upload_image(args) {
    return {
      content: [
        {
          type: "text",
          text: "Image upload via file input is not supported in Firefox WebExtensions. Use drag & drop on the page instead.",
        },
      ],
    };
  },

  async gif_creator(args) {
    return { content: [{ type: "text", text: "GIF recording is not yet implemented in this extension." }] };
  },

  async shortcuts_list(args) {
    return { content: [{ type: "text", text: "No shortcuts available. Shortcuts are not supported in this extension." }] };
  },

  async shortcuts_execute(args) {
    return { content: [{ type: "text", text: "Shortcuts are not supported in this extension." }] };
  },

  async switch_browser(args) {
    return {
      content: [
        {
          type: "text",
          text: "Browser switching is not yet supported. The extension connects to whichever Firefox browser has it loaded.",
        },
      ],
    };
  },

  async update_plan(args) {
    const approach = Array.isArray(args.approach) ? args.approach.map(String) : [];
    const domains = [];
    const invalid = [];
    for (const d of Array.isArray(args.domains) ? args.domains : []) {
      const n = normalizeDomain(d);
      if (n) {
        if (!domains.includes(n)) domains.push(n);
      } else {
        invalid.push(String(d));
      }
    }

    const settings = await getSettings();
    if (!settings.requirePlanApproval) {
      return textResult(
        "Plan noted (plan approval is disabled in settings). " +
          (settings.requireSitePermission
            ? "Each site will still ask the user for permission the first time Claude uses it."
            : "Site permissions are disabled, so no further approval is needed.")
      );
    }

    const decision = await askUser({ kind: "plan", domains, invalid, approach });
    if (decision !== "approve") {
      return textResult(
        "The user did not approve this plan. Do not proceed with it; ask the user what they would like to change."
      );
    }
    for (const d of domains) await addToSessionList(S_PLAN_DOMAINS, d);
    let text = `Plan approved by the user. Approved domains (including subdomains) for this session: ${domains.join(", ") || "(none)"}.`;
    if (invalid.length) text += ` Ignored invalid domain entries: ${invalid.join(", ")}.`;
    text += " Other sites will ask for permission when first used. High-risk actions still require confirmation.";
    return textResult(text);
  },
};

// --- Tool dispatch ---
async function handleToolRequest(id, tool, args) {
  await initialized;
  const handler = Object.hasOwn(toolHandlers, tool) ? toolHandlers[tool] : null;
  if (!handler) {
    sendError(id, `Unknown tool: ${tool}`);
    return;
  }

  try {
    const result = await handler(args);
    sendResponse(id, result);
  } catch (err) {
    sendError(id, `${tool} failed: ${err.message}`);
  }
}

// --- Init ---

// Recover Claude's tabs after the background script restarts. Session storage
// is cleared when Firefox restarts, so IDs from a previous run are never reused.
async function recoverMcpState() {
  mcpWindowId = await sessionGet(S_WINDOW, null);
  if (mcpWindowId !== null) {
    try {
      await chrome.windows.get(mcpWindowId);
    } catch {
      mcpWindowId = null;
      await sessionSet(S_WINDOW, null);
    }
  }
  for (const id of await sessionGet(S_TABS, [])) mcpTabs.add(id);
  await pruneMcpTabs();
}

const initialized = recoverMcpState().catch(() => {});
connectNativeHost();
