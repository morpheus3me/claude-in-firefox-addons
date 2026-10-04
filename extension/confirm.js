// Approval dialog for site permissions, plans, and high-risk actions.
// Everything shown here comes from Claude or from web pages, so it is only
// ever inserted with textContent.

const zh = /^zh/i.test(navigator.language);
const T = zh
  ? {
      siteTitle: "允許 Claude 使用此網站？",
      siteSub: "Claude 要求",
      purpose: "用途",
      siteWarn: "允許後，Claude 可以讀取此網站的內容，並以你的登入身分在 Claude 的分頁中操作。網頁內容可能含有試圖誤導 Claude 的指令。",
      deny: "拒絕",
      session: "本次工作階段允許",
      always: "一律允許此網站",
      planTitle: "核准 Claude 的計畫？",
      planSub: "核准後，以下網域（含子網域）在本次工作階段不必再逐一授權。高風險動作仍會詢問。",
      domains: "網域",
      approach: "做法",
      invalid: "已忽略的無效網域",
      none: "（無）",
      approve: "核准計畫",
      actionTitle: "確認高風險動作",
      actionSub: "Claude 即將在以下網站執行可能無法復原的動作：",
      action: "動作",
      details: "細節",
      once: "允許這次",
      jsTitle: "允許 Claude 執行 JavaScript？",
      jsSub: "JavaScript 可以做到頁面能做的任何事，包括讀取資料和代你送出請求。",
      code: "程式碼",
      jsSession: "本次工作階段允許此網站",
      timeout: "此視窗會在 2 分鐘後自動拒絕。",
      expired: "這個請求已失效，可以關閉此視窗。",
    }
  : {
      siteTitle: "Allow Claude to use this site?",
      siteSub: "Claude is asking to",
      purpose: "Purpose",
      siteWarn: "If allowed, Claude can read this site and act in Claude's tabs while signed in as you. Web pages may contain instructions that try to mislead Claude.",
      deny: "Deny",
      session: "Allow for this session",
      always: "Always allow this site",
      planTitle: "Approve Claude's plan?",
      planSub: "If approved, these domains (including subdomains) won't need separate permission this session. High-risk actions will still ask.",
      domains: "Domains",
      approach: "Approach",
      invalid: "Ignored invalid domains",
      none: "(none)",
      approve: "Approve plan",
      actionTitle: "Confirm high-risk action",
      actionSub: "Claude is about to do something that may not be reversible on:",
      action: "Action",
      details: "Details",
      once: "Allow once",
      jsTitle: "Allow Claude to run JavaScript?",
      jsSub: "JavaScript can do anything the page can, including reading data and sending requests as you.",
      code: "Code",
      jsSession: "Allow on this site for this session",
      timeout: "This request is denied automatically after 2 minutes.",
      expired: "This request has expired. You can close this window.",
    };

const promptId = location.hash.slice(1);
const $ = (id) => document.getElementById(id);

function el(tag, opts = {}, children = []) {
  const node = document.createElement(tag);
  if (opts.className) node.className = opts.className;
  if (opts.text !== undefined) node.textContent = opts.text;
  for (const c of children) node.appendChild(c);
  return node;
}

function field(label, value, pre = false) {
  return el("p", {}, [el("strong", { text: `${label}: ` }), pre ? el("pre", { text: value }) : el("span", { text: value })]);
}

function list(items) {
  return el("ul", {}, (items.length ? items : [T.none]).map((i) => el("li", { text: i })));
}

function render(data) {
  const body = $("body");
  let buttons = [];

  if (data.kind === "site") {
    $("heading").textContent = T.siteTitle;
    $("subheading").textContent = `${T.siteSub}: ${data.purpose}`;
    body.append(
      el("div", { className: "card" }, [el("div", { className: "host", text: data.host }), el("div", { className: "muted", text: data.url })]),
      el("div", { className: "warn", text: T.siteWarn })
    );
    buttons = [["deny", T.deny], ["session", T.session], ["always", T.always, true]];
  } else if (data.kind === "plan") {
    $("heading").textContent = T.planTitle;
    $("subheading").textContent = T.planSub;
    const card = el("div", { className: "card" }, [el("strong", { text: T.domains }), list(data.domains)]);
    if (data.invalid?.length) card.append(el("strong", { text: T.invalid }), list(data.invalid));
    body.append(card, el("div", { className: "card" }, [el("strong", { text: T.approach }), list(data.approach)]));
    buttons = [["deny", T.deny], ["approve", T.approve, true]];
  } else if (data.kind === "action" || data.kind === "javascript") {
    const js = data.kind === "javascript";
    $("heading").textContent = js ? T.jsTitle : T.actionTitle;
    $("subheading").textContent = js ? T.jsSub : T.actionSub;
    body.append(
      el("div", { className: "card" }, [
        el("div", { className: "host", text: data.host }),
        el("div", { className: "muted", text: data.title ? `${data.title} — ${data.url}` : data.url }),
      ]),
      el("div", { className: "card" }, [
        field(T.action, data.description),
        data.detail ? field(js ? T.code : T.details, data.detail, js) : el("span"),
      ])
    );
    buttons = js
      ? [["deny", T.deny, true], ["session", T.jsSession], ["once", T.once]]
      : [["deny", T.deny, true], ["once", T.once]];
  }

  body.append(el("p", { className: "muted", text: T.timeout }));

  for (const [decision, label, primary] of buttons) {
    const b = el("button", { text: label, className: primary ? "primary" : "" });
    b.addEventListener("click", async () => {
      document.querySelectorAll("button").forEach((x) => (x.disabled = true));
      try {
        await browser.runtime.sendMessage({ type: "prompt_decision", id: promptId, decision });
      } catch {}
      window.close();
    });
    $("buttons").appendChild(b);
  }
  // Focus the safe choice so a stray Enter key never approves anything.
  $("buttons").querySelector("button")?.focus();
}

(async () => {
  let resp = null;
  try {
    resp = await browser.runtime.sendMessage({ type: "prompt_get", id: promptId });
  } catch {}
  if (!resp?.data) {
    $("heading").textContent = T.expired;
    return;
  }
  document.title = `Claude MCP – ${resp.data.host || T.planTitle}`;
  render(resp.data);
})();
