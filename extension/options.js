// Settings page: safety toggles and saved site permissions.

const DEFAULT_SETTINGS = { requireSitePermission: true, requirePlanApproval: true, confirmHighRisk: true };
const SESSION_KEYS = ["sessionSiteHosts", "sessionPlanDomains", "sessionJsHosts"];

const zh = /^zh/i.test(navigator.language);
const T = zh
  ? {
      title: "Claude MCP 設定",
      intro: "控制 Claude 在 Firefox 中可以做什麼。預設全部開啟，比照官方 Claude in Chrome 的安全做法。",
      safety: "安全防護",
      requireSitePermission: ["網站授權", "Claude 第一次讀取或操作某個網站前，先詢問你。"],
      requirePlanApproval: ["計畫審核", "Claude 提出計畫時跳出核准視窗；核准的網域在本次工作階段不必再逐一授權。"],
      confirmHighRisk: ["高風險動作確認", "購買、送出表單、刪除、在密碼或付款欄位輸入、執行 JavaScript 前，先詢問你。"],
      offWarning: "有防護已關閉。網頁中的惡意指令（prompt injection）可能讓 Claude 在你不知情時讀取或送出資料。",
      always: "一律允許的網站",
      noAlways: "目前沒有。",
      remove: "移除",
      session: "本次工作階段的授權",
      sessionText: "包含「本次工作階段允許」的網站、已核准計畫的網域，以及允許執行 JavaScript 的網站。重新啟動 Firefox 時會自動清除。",
      clear: "立即清除",
      cleared: "已清除",
    }
  : {
      title: "Claude MCP Settings",
      intro: "Control what Claude can do in Firefox. Everything is on by default, following the official Claude in Chrome safety model.",
      safety: "Safety",
      requireSitePermission: ["Site permissions", "Ask before Claude reads or acts on a site for the first time."],
      requirePlanApproval: ["Plan approval", "Show an approval dialog when Claude presents a plan; approved domains skip per-site prompts for the session."],
      confirmHighRisk: ["Confirm high-risk actions", "Ask before purchases, form submissions, deletions, typing into password or payment fields, and running JavaScript."],
      offWarning: "Some protections are off. Malicious instructions in web pages (prompt injection) could make Claude read or send data without you noticing.",
      always: "Always-allowed sites",
      noAlways: "None yet.",
      remove: "Remove",
      session: "Session approvals",
      sessionText: "Sites allowed for this session, domains from approved plans, and sites allowed to run JavaScript. Cleared automatically when Firefox restarts.",
      clear: "Clear now",
      cleared: "Cleared",
    };

const $ = (id) => document.getElementById(id);

async function getSettings() {
  const { settings } = await browser.storage.local.get("settings");
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

async function renderToggles() {
  const settings = await getSettings();
  const container = $("toggles");
  container.replaceChildren();
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    const [label, desc] = T[key];
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = settings[key];
    input.addEventListener("change", async () => {
      const current = await getSettings();
      current[key] = input.checked;
      await browser.storage.local.set({ settings: current });
      updateWarning(current);
    });
    const text = document.createElement("div");
    const strong = document.createElement("strong");
    strong.textContent = label;
    const p = document.createElement("div");
    p.className = "muted";
    p.textContent = desc;
    text.append(strong, p);
    const row = document.createElement("label");
    row.className = "toggle";
    row.append(input, text);
    container.appendChild(row);
  }
  updateWarning(settings);
}

function updateWarning(settings) {
  $("offWarning").hidden = Object.keys(DEFAULT_SETTINGS).every((k) => settings[k]);
}

async function renderAlways() {
  const { alwaysAllowedHosts = [] } = await browser.storage.local.get("alwaysAllowedHosts");
  const container = $("alwaysList");
  container.replaceChildren();
  if (!alwaysAllowedHosts.length) {
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = T.noAlways;
    container.appendChild(p);
    return;
  }
  for (const host of alwaysAllowedHosts) {
    const row = document.createElement("div");
    row.className = "row";
    const name = document.createElement("span");
    name.textContent = host;
    const btn = document.createElement("button");
    btn.textContent = T.remove;
    btn.addEventListener("click", async () => {
      const { alwaysAllowedHosts: list = [] } = await browser.storage.local.get("alwaysAllowedHosts");
      await browser.storage.local.set({ alwaysAllowedHosts: list.filter((h) => h !== host) });
      renderAlways();
    });
    row.append(name, btn);
    container.appendChild(row);
  }
}

function init() {
  document.title = T.title;
  $("title").textContent = T.title;
  $("intro").textContent = T.intro;
  $("safetyHeading").textContent = T.safety;
  $("offWarning").textContent = T.offWarning;
  $("alwaysHeading").textContent = T.always;
  $("sessionHeading").textContent = T.session;
  $("sessionText").textContent = T.sessionText;
  const clear = $("clearSession");
  clear.textContent = T.clear;
  clear.addEventListener("click", async () => {
    await browser.storage.session.remove(SESSION_KEYS);
    clear.textContent = T.cleared;
    setTimeout(() => (clear.textContent = T.clear), 1500);
  });
  renderToggles();
  renderAlways();
}

init();
