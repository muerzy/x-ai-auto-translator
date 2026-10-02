// X AI 翻译器 - content script
// 职责：发现页面上的推文文本（data-testid="tweetText"），
// 进入视口后加入翻译队列，批量发给 service worker，把译文插在原文下方。
// X 是 React SPA 且虚拟滚动：用 MutationObserver 发现新节点 +
// IntersectionObserver 只翻译进入视口的 + 按原文内容去重与缓存命中。

const TWEET_TEXT_SEL = '[data-testid="tweetText"]';
const SCAN_DEBOUNCE_MS = 150;
const FLUSH_INTERVAL_MS = 300;

let enabled = false;
let mo = null;
let io = null;
let scanTimer = null;
let flushTimer = null;
let seq = 0;
const textToId = new Map(); // 原文 -> id，同文本多处展示共用一个翻译结果
const pending = new Map(); // id -> 原文，等待发请求
const lastText = new WeakMap(); // 元素 -> 翻译发起时的规范化文本，用于检测文本变化

// ---------- 启动 / 停止 ----------

async function init() {
  try {
    const { settings } = await chrome.storage.local.get("settings");
    enabled = (settings?.enabled ?? true) !== false;
    if (enabled) start();

    chrome.runtime.onMessage.addListener((msg) => {
      if (msg?.type === "settingsUpdated") applySettings();
    });
  } catch (e) {
    console.warn("[X AI 翻译器] 初始化失败：", e);
  }
}

async function applySettings() {
  const { settings } = await chrome.storage.local.get("settings");
  const nowEnabled = (settings?.enabled ?? true) !== false;
  if (nowEnabled && !enabled) {
    enabled = true;
    start();
  } else if (!nowEnabled && enabled) {
    enabled = false;
    stop();
  }
}

function start() {
  if (mo) return;
  io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          io.unobserve(e.target);
          enqueue(e.target);
        }
      }
    },
    { rootMargin: "200px" } // 提前一点开始翻译，滚动时观感更顺
  );

  mo = new MutationObserver(scheduleScan);
  mo.observe(document.body, { childList: true, subtree: true });
  scheduleScan();
}

function stop() {
  mo?.disconnect();
  io?.disconnect();
  mo = io = null;
  clearTimeout(scanTimer);
  clearTimeout(flushTimer);
  pending.clear();
}

// ---------- 发现推文 ----------

function scheduleScan() {
  clearTimeout(scanTimer);
  scanTimer = setTimeout(scan, SCAN_DEBOUNCE_MS);
}

function scan() {
  if (!enabled) return;
  for (const el of document.querySelectorAll(TWEET_TEXT_SEL)) {
    if (el.dataset.xatState === "wait") continue; // 翻译进行中，不重复触发
    const norm = normText(el);

    if (el.dataset.xatState) {
      // 已处理过：文本没变就跳过；变了（如点击「显示更多」展开全文）清掉旧译文重翻
      if (lastText.get(el) === norm) continue;
      removeStaleResult(el);
      delete el.dataset.xatState;
    }

    // X 会给推文文本标 lang 属性，中文推文直接跳过
    const lang = (el.getAttribute("lang") || "").toLowerCase();
    if (lang.startsWith("zh") || !norm || norm.length < 2 || isChineseText(norm)) {
      el.dataset.xatState = "skip";
      lastText.set(el, norm);
      continue;
    }
    el.dataset.xatState = "wait";
    io.observe(el);
  }
}

// 移除元素后面紧跟的旧译文/错误提示（文本变化后旧结果已失效）
function removeStaleResult(el) {
  let sib = el.nextElementSibling;
  while (
    sib &&
    (sib.classList.contains("xat-translation") || sib.classList.contains("xat-error"))
  ) {
    const next = sib.nextElementSibling;
    sib.remove();
    sib = next;
  }
}

// ---------- 入队与发送 ----------

function enqueue(el) {
  // 此时元素可见，innerText 能取到真实换行
  const text = (el.innerText || el.textContent || "").trim();
  const norm = normText(el);
  if (!text || text.length < 2 || isChineseText(text)) {
    el.dataset.xatState = "skip";
    lastText.set(el, norm);
    return;
  }
  lastText.set(el, norm); // 记录文本基准，用于检测「显示更多」等后续展开

  let id = textToId.get(text);
  if (id == null) {
    id = String(++seq);
    textToId.set(text, id);
  }
  el.dataset.xatId = id;
  pending.set(id, text);
  scheduleFlush();
}

function scheduleFlush() {
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flush, FLUSH_INTERVAL_MS);
}

function flush() {
  if (!enabled || pending.size === 0) return;
  if (!contextValid()) return silentStop();

  const items = [...pending].map(([id, text]) => ({ id, text }));
  pending.clear();

  try {
    chrome.runtime.sendMessage({ type: "translate", items }, (resp) => {
      if (chrome.runtime.lastError || !resp || resp.error) {
        const reason = resp?.error || chrome.runtime.lastError?.message;
        console.warn("[X AI 翻译器] 翻译请求失败：", reason);
        for (const it of items) markError(it.id, reason);
        return;
      }
      const textById = new Map(items.map((it) => [it.id, it.text]));
      for (const r of resp.results || []) applyResult(r, textById.get(r.id));
      // 兜底：请求在途期间文本可能已变化（如点了「显示更多」），主动复查一轮
      scheduleScan();
    });
  } catch (e) {
    // sendMessage 同步抛错基本是扩展上下文失效（扩展被重新加载/更新过）
    silentStop();
  }
}

// 扩展上下文是否仍然有效（重新加载/更新扩展后，旧 content script 的 chrome.runtime 会失效）
function contextValid() {
  return !!chrome.runtime?.id;
}

// 上下文失效后旧脚本安静停摆，不再对页面报错
function silentStop() {
  stop();
  console.info("[X AI 翻译器] 扩展已重新加载，请刷新 x.com 页面以恢复翻译");
}

// ---------- 渲染结果 ----------

function applyResult({ id, translated }, srcText) {
  const els = document.querySelectorAll(`[data-xat-id="${id}"]`);
  // 模型原样返回（纯符号/表情等无可翻内容，或模型复读）时不插入译文块
  const echoed =
    translated != null &&
    srcText != null &&
    translated.replace(/\s+/g, " ").trim() === srcText.replace(/\s+/g, " ").trim();
  if (echoed) console.warn("[X AI 翻译器] 模型未翻译此条，原样返回：", srcText.slice(0, 50));
  for (const el of els) {
    if (el.dataset.xatState !== "wait") continue;
    if (translated == null) {
      markError(id, null, el);
      continue;
    }
    el.dataset.xatState = "done";
    if (!echoed) el.insertAdjacentElement("afterend", buildTranslationEl(translated, el));
  }
}

function markError(id, reason, oneEl) {
  const els = oneEl
    ? [oneEl]
    : [...document.querySelectorAll(`[data-xat-id="${id}"]`)].filter(
        (el) => el.dataset.xatState === "wait"
      );
  for (const el of els) {
    el.dataset.xatState = "error";
    const errEl = buildErrorEl(reason);
    errEl.addEventListener("click", () => {
      // 点击重试：清掉错误标记，重新走观察流程
      errEl.remove();
      el.dataset.xatState = "wait";
      io?.observe(el);
    });
    el.insertAdjacentElement("afterend", errEl);
  }
}

function buildTranslationEl(translated, refEl) {
  const div = document.createElement("div");
  div.className = "xat-translation";
  renderRichText(div, translated); // 文本节点拼接，天然防注入，保留换行（CSS pre-wrap）
  // 排版跟随原推文：字号/行高/字体与原文完全一致（时间线、引用推文等不同上下文都能适配）
  if (refEl) {
    const cs = getComputedStyle(refEl);
    div.style.fontSize = cs.fontSize;
    div.style.lineHeight = cs.lineHeight;
    if (cs.fontFamily) div.style.fontFamily = cs.fontFamily;
  }
  return div;
}

// 还原原帖里的富文本观感：URL / @提及 / #话题 渲染成蓝色可点击链接，其余为纯文本
const RICH_TOKEN_RE =
  /https?:\/\/[^\s，。；、！？）)】」』"']+|[@＠][A-Za-z0-9_.]+|[#＃][A-Za-z0-9_\u4e00-\u9fff\u3040-\u30ff]+/g;

function renderRichText(container, text) {
  let last = 0;
  for (const m of text.matchAll(RICH_TOKEN_RE)) {
    if (m.index > last) {
      container.appendChild(document.createTextNode(text.slice(last, m.index)));
    }
    container.appendChild(buildLink(m[0]));
    last = m.index + m[0].length;
  }
  if (last < text.length) {
    container.appendChild(document.createTextNode(text.slice(last)));
  }
}

function buildLink(token) {
  const a = document.createElement("a");
  if (token.startsWith("@") || token.startsWith("＠")) {
    a.href = "https://x.com/" + encodeURIComponent(token.replace(/^[@＠]/, ""));
  } else if (token.startsWith("#") || token.startsWith("＃")) {
    a.href = "https://x.com/search?q=" + encodeURIComponent(token);
  } else {
    a.href = token; // 正则限定 http(s):// 开头，无脚本协议风险
  }
  a.textContent = token;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  return a;
}

function buildErrorEl(reason) {
  const div = document.createElement("div");
  div.className = "xat-error";
  div.textContent = `翻译失败${reason ? "" : "，点击重试"}`;
  if (reason) div.title = String(reason);
  return div;
}

// ---------- 工具 ----------

// 规范化文本作为「变化检测」基准：textContent 不受可见性影响、不触发重排，
// 压平空白后比较，与翻译用的 innerText 分开，避免虚拟滚动隐藏时误判变化
function normText(el) {
  return (el.textContent || "").replace(/\s+/g, " ").trim();
}

// 判断文本是否为中文（跳过翻译的条件）：
// 汉字占比过半，且不含日文假名、韩文谚文等——含假名/谚文的是日文/韩文，必须翻译
function isChineseText(text) {
  const chars = text.replace(/\s/g, "");
  if (!chars) return true;
  let han = 0;
  for (const ch of chars) {
    const c = ch.codePointAt(0);
    if (
      (c >= 0x3040 && c <= 0x30ff) || // 平假名/片假名
      (c >= 0x31f0 && c <= 0x31ff) || // 片假名扩展
      (c >= 0xff66 && c <= 0xff9d) || // 半角片假名
      (c >= 0xac00 && c <= 0xd7a3) || // 韩文谚文
      (c >= 0x3100 && c <= 0x312f) // 注音符号
    ) {
      return false;
    }
    if (
      (c >= 0x4e00 && c <= 0x9fff) ||
      (c >= 0x3400 && c <= 0x4dbf) ||
      (c >= 0xf900 && c <= 0xfaff)
    ) {
      han++;
    }
  }
  return han / chars.length > 0.5;
}

init();
