// X AI 翻译器 - content script
// 职责：发现推文（data-testid="tweetText"），滚入视口后按「文本节点」粒度翻译。
// 译文以克隆原帖 DOM 的方式插入：结构与原帖完全一致（链接/换行/样式原生复刻），
// 只把文字节点替换为译文；请求期间结构变化时退回纯文本插入兜底。
// 两种模式：自动翻译（滚入视口即翻）/ 手动模式（帖子底部显示「翻译帖子」按钮）。

const TWEET_TEXT_SEL = '[data-testid="tweetText"]';
const BIO_SEL = '[data-testid="UserDescription"]'; // 个人主页/资料卡片的简介
const TARGET_SEL = `${TWEET_TEXT_SEL}, ${BIO_SEL}`;
const SCAN_DEBOUNCE_MS = 150;
const FLUSH_INTERVAL_MS = 300;

let autoMode = true; // 设置里的 enabled：true=自动翻译，false=显示手动翻译按钮
let voteButtons = true; // 帖子标记：关闭后帖子下方不显示 ⭐/👎 按钮
let mo = null;
let io = null;
let scanTimer = null;
let flushTimer = null;
let seq = 0;
const textToId = new Map(); // 原文 -> 推文 id，同文本多处展示共用一份翻译
const pending = new Map(); // 片段 id（"推文id:序号"）-> 片段文本，等待发请求
const lastText = new WeakMap(); // 元素 -> 翻译发起时的规范化文本，用于检测文本变化
const segPending = new Map(); // 推文 id -> { total, got, segs: [译文|null] }

// ---------- 启动 / 停止 ----------

async function init() {
  try {
    const { settings } = await chrome.storage.local.get("settings");
    autoMode = (settings?.enabled ?? true) !== false;
    voteButtons = settings?.voteButtonsEnabled !== false;
    start();

    chrome.runtime.onMessage.addListener((msg) => {
      if (msg?.type === "settingsUpdated") applySettings();
    });
  } catch (e) {
    console.warn("[X AI 翻译器] 初始化失败：", e);
  }
}

async function applySettings() {
  const { settings } = await chrome.storage.local.get("settings");
  const nowAuto = (settings?.enabled ?? true) !== false;
  const nowButtons = settings?.voteButtonsEnabled !== false;
  if (nowAuto === autoMode && nowButtons === voteButtons) return;
  autoMode = nowAuto;

  // 关闭标记按钮：移除页面上已有的投票栏，新帖子不再挂
  voteButtons = nowButtons;
  if (!nowButtons) document.querySelectorAll(".xat-votes").forEach((el) => el.remove());
  else scheduleScan();

  if (nowAuto) {
    // 手动 → 自动：移除所有翻译按钮，manual 状态的推文重走自动流程
    for (const el of document.querySelectorAll(TARGET_SEL)) {
      if (el.dataset.xatState === "manual") {
        removeTranslateBtn(el);
        delete el.dataset.xatState;
      }
    }
  } else {
    // 自动 → 手动：等待中的翻译正常完成，未处理的推文由 scan 补按钮
    scheduleScan();
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
  segPending.clear();
  document.querySelectorAll(".xat-loading").forEach((e) => e.remove());
  document.querySelectorAll(".xat-btn").forEach((e) => e.remove());
}

// 手动模式的「翻译帖子」按钮

function buildTranslateBtn(el) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "xat-btn";
  btn.textContent = el.matches(BIO_SEL) ? "翻译简介" : "翻译帖子";
  btn.addEventListener("click", () => {
    removeTranslateBtn(el);
    enqueue(el); // 进入与自动模式相同的翻译流程（含 loading/译文渲染）
  });
  return btn;
}

function removeTranslateBtn(el) {
  const sib = el.nextElementSibling;
  if (sib?.classList.contains("xat-btn")) sib.remove();
}

// ---------- 发现推文 ----------

function scheduleScan() {
  clearTimeout(scanTimer);
  scanTimer = setTimeout(scan, SCAN_DEBOUNCE_MS);
}

function scan() {
  for (const el of document.querySelectorAll(TARGET_SEL)) {
    if (el.dataset.xatState === "wait") continue; // 翻译进行中，不重复触发
    const norm = normText(el);

    if (el.dataset.xatState) {
      // 已处理过：文本没变就跳过；变了（如点击「显示更多」展开全文）清掉旧结果重来
      if (lastText.get(el) === norm) continue;
      removeStaleResult(el);
      removeTranslateBtn(el);
      delete el.dataset.xatState;
    }

    // X 会给推文文本标 lang 属性，中文推文直接跳过
    const lang = (el.getAttribute("lang") || "").toLowerCase();
    if (lang.startsWith("zh") || !norm || norm.length < 2 || isChineseText(norm)) {
      el.dataset.xatState = "skip";
      lastText.set(el, norm);
      if (voteButtons) attachVoteBar(el, norm); // 中文帖同样可标记有用/没用
      continue;
    }
    if (autoMode) {
      el.dataset.xatState = "wait";
      io.observe(el);
    } else {
      // 手动模式：帖子底部显示「翻译帖子」按钮，点击才翻译
      el.dataset.xatState = "manual";
      lastText.set(el, norm);
      el.insertAdjacentElement("afterend", buildTranslateBtn(el));
    }
  }
  scanPhotos();
}

// ---------- 图片解读：任何图片（不分语言）悬停出现「解释图片」按钮 ----------

function scanPhotos() {
  for (const img of document.querySelectorAll('[data-testid="tweetPhoto"] img')) {
    if (img.dataset.xatPhoto) continue;
    const wrap = img.closest('[data-testid="tweetPhoto"]');
    if (!wrap) {
      img.dataset.xatPhoto = "skip";
      continue;
    }
    if (!img.currentSrc) continue; // 懒加载尚未完成：不标记，等下一次扫描重试
    img.dataset.xatPhoto = "idle";
    if (getComputedStyle(wrap).position === "static") wrap.classList.add("xat-photo-rel");
    wrap.appendChild(buildPhotoBtn(img, wrap));
  }
}

const photoState = new WeakMap(); // 图片容器 -> { payload, visible }，支持解读/原图切换

function buildPhotoBtn(img, wrap) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "xat-photo-btn";
  btn.textContent = "解释图片";
  btn.addEventListener("click", (e) => {
    e.stopPropagation(); // 别触发 X 的图片查看器
    e.preventDefault();
    if (btn.dataset.state === "loading") return;
    // 已解释：点击在解读面板和原图之间切换
    const st = photoState.get(wrap);
    if (btn.dataset.state === "done" && st) {
      st.visible = !st.visible;
      wrap
        .querySelectorAll(".xat-photo-desc")
        .forEach((el) => (el.style.display = st.visible ? "" : "none"));
      btn.textContent = st.visible ? "已解释" : "显示解读";
      return;
    }
    if (btn.dataset.state === "done") return;
    translateImage(img, wrap, btn);
  });
  return btn;
}

function translateImage(img, wrap, btn) {
  btn.dataset.state = "loading";
  btn.textContent = "解释中…";
  const src = img.currentSrc || img.src;
  chrome.runtime.sendMessage({ type: "ocrTranslate", src }, (resp) => {
    if (chrome.runtime.lastError || !resp || resp.error) {
      const reason = resp?.error || chrome.runtime.lastError?.message;
      photoToast(wrap, reason || "解释失败");
      btn.dataset.state = "idle";
      btn.textContent = "解释图片";
      return;
    }
    btn.dataset.state = "done";
    btn.textContent = "已解释";
    photoState.set(wrap, { payload: resp, visible: true });
    renderPhotoDescription(wrap, resp);
  });
}

// 图片内容解读：黑色半透明面板 + 白字覆在图片上，markdown 渲染，长内容可滚动
function renderPhotoDescription(wrap, { text }) {
  wrap.querySelectorAll(".xat-photo-desc").forEach((el) => el.remove());
  if (!text) return;
  const panel = document.createElement("div");
  panel.className = "xat-photo-desc";
  renderMarkdown(panel, text);
  wrap.appendChild(panel);
}

// 轻量 Markdown 渲染（安全：全程 DOM 构建，不使用 innerHTML）。
// 支持：# 标题、- / 1. 列表、``` 代码块、**粗体**、*斜体*、`行内代码`、[文本](链接)
const MD_INLINE_RE =
  /(\*\*[^*]+\*\*|\*[^*\s][^*\n]*\*|`[^`]+`|\[[^\]]+\]\(https?:\/\/[^)\s]+\))/g;

function renderMarkdown(container, md) {
  const lines = String(md || "").split(/\r?\n/);
  let para = [];
  let list = null;
  let pre = null;
  const flushPara = () => {
    if (para.length) {
      const p = document.createElement("p");
      p.className = "xat-md-p";
      renderInline(p, para.join(" "));
      container.appendChild(p);
      para = [];
    }
  };
  const flushList = () => {
    if (list) {
      container.appendChild(list);
      list = null;
    }
  };
  const flushAll = () => {
    flushPara();
    flushList();
  };
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith("```")) {
      if (pre) {
        container.appendChild(pre);
        pre = null;
      } else {
        flushAll();
        pre = document.createElement("pre");
        pre.className = "xat-md-pre";
        pre.appendChild(document.createElement("code"));
      }
      continue;
    }
    if (pre) {
      pre.firstChild.appendChild(document.createTextNode(line + "\n"));
      continue;
    }
    if (!t) {
      flushAll();
      continue;
    }
    const h = t.match(/^#{1,3}\s+(.*)/);
    if (h) {
      flushAll();
      const el = document.createElement("div");
      el.className = "xat-md-h";
      renderInline(el, h[1]);
      container.appendChild(el);
      continue;
    }
    const ul = t.match(/^[-*•]\s+(.*)/);
    if (ul) {
      flushPara();
      if (!list || list.tagName !== "UL") {
        flushList();
        list = document.createElement("ul");
        list.className = "xat-md-ul";
      }
      const li = document.createElement("li");
      renderInline(li, ul[1]);
      list.appendChild(li);
      continue;
    }
    const ol = t.match(/^\d+[.、)]\s+(.*)/);
    if (ol) {
      flushPara();
      if (!list || list.tagName !== "OL") {
        flushList();
        list = document.createElement("ol");
        list.className = "xat-md-ul";
      }
      const li = document.createElement("li");
      renderInline(li, ol[1]);
      list.appendChild(li);
      continue;
    }
    flushList();
    para.push(t);
  }
  if (pre) container.appendChild(pre);
  flushAll();
}

function renderInline(el, text) {
  let last = 0;
  for (const m of String(text).matchAll(MD_INLINE_RE)) {
    if (m.index > last) el.appendChild(document.createTextNode(text.slice(last, m.index)));
    const tok = m[0];
    if (tok.startsWith("**")) {
      const b = document.createElement("strong");
      b.textContent = tok.slice(2, -2);
      el.appendChild(b);
    } else if (tok.startsWith("`")) {
      const c = document.createElement("code");
      c.className = "xat-md-code";
      c.textContent = tok.slice(1, -1);
      el.appendChild(c);
    } else if (tok.startsWith("[")) {
      const link = tok.match(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/);
      const a = document.createElement("a");
      a.href = link[2];
      a.textContent = link[1];
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      el.appendChild(a);
    } else {
      const em = document.createElement("em");
      em.textContent = tok.slice(1, -1);
      el.appendChild(em);
    }
    last = m.index + tok.length;
  }
  if (last < text.length) el.appendChild(document.createTextNode(text.slice(last)));
}

function photoToast(wrap, message) {
  wrap.querySelectorAll(".xat-photo-toast").forEach((el) => el.remove());
  const toast = document.createElement("div");
  toast.className = "xat-photo-toast";
  toast.textContent = message;
  wrap.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

// 移除元素后面紧跟的旧译文/错误提示/加载动画/投票栏（文本变化后旧结果已失效）
function removeStaleResult(el) {
  let sib = el.nextElementSibling;
  while (
    sib &&
    (sib.classList.contains("xat-translation") ||
      sib.classList.contains("xat-error") ||
      sib.classList.contains("xat-loading") ||
      sib.classList.contains("xat-votes"))
  ) {
    const next = sib.nextElementSibling;
    sib.remove();
    sib = next;
  }
}

// ---------- 入队与发送 ----------

function enqueue(el) {
  removeTranslateBtn(el); // 手动模式点击按钮进入时移除按钮
  // 此时元素可见，innerText 能取到真实换行
  const text = (el.innerText || el.textContent || "").trim();
  const norm = normText(el);
  if (!text || text.length < 2 || isChineseText(text)) {
    el.dataset.xatState = "skip";
    lastText.set(el, norm);
    return;
  }
    lastText.set(el, norm); // 记录文本基准，用于检测「显示更多」等后续展开
    if (voteButtons) attachVoteBar(el, norm); // 标记按钮挂在帖子正文上（与译文无关）

  let id = textToId.get(text);
  if (id == null) {
    id = String(++seq);
    textToId.set(text, id);
  }
  el.dataset.xatId = id;

  // 按文本节点切片段：链接/换行等结构不进模型，渲染时原样复刻
  const segs = collectSegments(el);
  if (segs.length === 0) {
    // 纯符号/emoji 推文，没有可翻译文字
    el.dataset.xatState = "done";
    return;
  }
  if (!segPending.has(id)) {
    segPending.set(id, { total: segs.length, got: 0, segs: new Array(segs.length).fill(undefined) });
    segs.forEach((s, i) => pending.set(`${id}:${i}`, s));
  }
  el.dataset.xatState = "wait"; // 手动路径由 enqueue 设状态（自动路径 scan 已设，重复无害）
  removeLoading(el); // 防重复（重试/重翻场景）
  el.insertAdjacentElement("afterend", buildLoadingEl());
  scheduleFlush();
}

function scheduleFlush() {
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flush, FLUSH_INTERVAL_MS);
}

function flush() {
  if (pending.size === 0) return;
  if (!contextValid()) return silentStop();

  const items = [...pending].map(([id, text]) => ({ id, text }));
  pending.clear();

  try {
    chrome.runtime.sendMessage({ type: "translate", items }, (resp) => {
      if (chrome.runtime.lastError || !resp || resp.error) {
        const reason = resp?.error || chrome.runtime.lastError?.message;
        console.warn("[X AI 翻译器] 翻译请求失败：", reason);
        for (const it of items) markError(tweetIdOf(it.id), reason);
        return;
      }
      for (const r of resp.results || []) applyResult(r);
      // 兜底：请求在途期间文本可能已变化（如点了「显示更多」），主动复查一轮
      scheduleScan();
    });
  } catch (e) {
    // sendMessage 同步抛错基本是扩展上下文失效（扩展被重新加载/更新过）
    silentStop();
  }
}

// ---------- 渲染结果 ----------

function applyResult({ id, translated }) {
  const tweetId = tweetIdOf(id);
  const idx = Number(id.slice(tweetId.length + 1));
  const st = segPending.get(tweetId);
  if (!st || Number.isNaN(idx) || idx >= st.total || st.segs[idx] !== undefined) return;
  st.segs[idx] = translated;
  if (++st.got >= st.total) {
    segPending.delete(tweetId);
    renderTranslation(tweetId, st.segs);
  }
}

// 译文 DOM = 原帖 DOM 的克隆：结构、链接、换行、样式与原帖完全一致，仅文字为译文
function renderTranslation(tweetId, segs) {
  for (const el of document.querySelectorAll(`[data-xat-id="${tweetId}"]`)) {
    if (el.dataset.xatState !== "wait") continue;

    if (segs.every((s) => s == null)) {
      markError(tweetId, null, el);
      continue;
    }

    const clone = el.cloneNode(true);
    // 移除识别标记，防止被 scan 与 X 的测试选择器重复命中；去掉 lang 避免误判语言
    clone.removeAttribute("data-testid");
    clone.removeAttribute("data-xat-id");
    clone.removeAttribute("lang");
    clone.classList.add("xat-translation");
    stripTruncation(clone);

    const nodes = collectTextNodes(clone);
    if (nodes.length !== segs.length) {
      // 请求期间原帖结构已变化：退回纯文本插入，保证至少有译文
      const joined = segs.filter(Boolean).join(" ");
      if (joined) el.insertAdjacentElement("afterend", buildTranslationEl(joined, el));
      else markError(tweetId, null, el);
      removeLoading(el);
      continue;
    }
    nodes.forEach((n, i) => {
      const raw = n.nodeValue;
      const lead = raw.match(/^\s*/)[0];
      const trail = raw.match(/\s*$/)[0];
      n.nodeValue = lead + (segs[i] ?? raw.trim()) + trail; // 失败片段回填原文
    });
    el.dataset.xatState = "done";
    removeLoading(el);
    el.insertAdjacentElement("afterend", clone);
  }
}

// X 对长推文/引用推文做「显示更多」截断时，会在 tweetText 上挂内联的
// 行数钳制/高度限制样式；克隆译文若继承这些样式会被裁掉尾行，全部解除
function stripTruncation(clone) {
  clone.style.removeProperty("-webkit-line-clamp");
  clone.style.removeProperty("max-height");
  clone.style.removeProperty("height");
  if (clone.style.overflow === "hidden") clone.style.overflow = "visible";
  if (clone.style.display === "-webkit-box") clone.style.display = "block";
}

function markError(id, reason, oneEl) {
  const els = oneEl
    ? [oneEl]
    : [...document.querySelectorAll(`[data-xat-id="${id}"]`)].filter(
        (el) => el.dataset.xatState === "wait"
      );
  for (const el of els) {
    el.dataset.xatState = "error";
    removeLoading(el);
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

// 翻译进行中的加载指示

function buildLoadingEl() {
  const div = document.createElement("div");
  div.className = "xat-loading";
  const spinner = document.createElement("span");
  spinner.className = "xat-loading-spinner";
  div.appendChild(spinner);
  div.appendChild(document.createTextNode("翻译中…"));
  return div;
}

function removeLoading(el) {
  const sib = el.nextElementSibling;
  if (sib?.classList.contains("xat-loading")) sib.remove();
}

// ---------- 兜底的纯文本译文（结构变化时使用） ----------

function buildTranslationEl(translated, refEl) {
  const div = document.createElement("div");
  div.className = "xat-translation";
  renderRichText(div, translated); // 文本节点拼接，天然防注入，保留换行（CSS pre-wrap）
  // 排版跟随原推文：字号/行高/字体与原文完全一致
  if (refEl) {
    const cs = getComputedStyle(refEl);
    div.style.fontSize = cs.fontSize;
    div.style.lineHeight = cs.lineHeight;
    if (cs.fontFamily) div.style.fontFamily = cs.fontFamily;
  }
  return div;
}

// ---------- 帖子有用/没用投票（挂在帖子正文上，本地记录，弹窗里看今日统计） ----------

// 在帖子元素后放置投票栏；已存在则跳过（scan 高频触发，防重复）
function attachVoteBar(el, key) {
  if (el.nextElementSibling?.classList.contains("xat-votes")) return;
  el.insertAdjacentElement("afterend", buildVoteBar(key, authorOf(el)));
}

// 从帖子 DOM 提取作者：handle 来自时间戳链接 /{handle}/status/{id}；
// 引用推文以 quoteTweet 容器为界，避免归到外层帖子的作者头上
function authorOf(el) {
  const scope = el.closest('[data-testid="quoteTweet"]') || el.closest("article");
  if (!scope) return null;
  const href = scope.querySelector('a[href*="/status/"]')?.getAttribute("href") || "";
  const m = href.match(/^\/([^/]+)\/status\//);
  if (!m) return null;
  const nameEl = scope.querySelector('[data-testid="User-Name"]');
  const name = nameEl ? nameEl.textContent.split("·")[0].trim() : "";
  return { handle: m[1], name };
}

function buildVoteBar(key, author) {
  const bar = document.createElement("div");
  bar.className = "xat-votes";
  const good = document.createElement("button");
  good.type = "button";
  good.className = "xat-vote xat-vote-good";
  good.title = "这个帖子有用";
  good.textContent = "⭐";
  const bad = document.createElement("button");
  bad.type = "button";
  bad.className = "xat-vote xat-vote-bad";
  bad.title = "这个帖子没用";
  bad.textContent = "👎";
  good.addEventListener("click", () => castVote(key, "good", bar, author));
  bad.addEventListener("click", () => castVote(key, "bad", bar, author));
  bar.appendChild(good);
  bar.appendChild(bad);
  restoreVote(key, bar);
  return bar;
}

async function restoreVote(key, bar) {
  try {
    const { votes } = await chrome.storage.local.get("votes");
    const v = votes?.[key];
    if (!v) return;
    bar.querySelector(`.xat-vote-${v.vote}`)?.classList.add("on");
  } catch {
    /* 投票恢复失败不影响译文 */
  }
}

async function castVote(key, vote, bar, author) {
  try {
    const { votes, voteTotals, authors } = await chrome.storage.local.get([
      "votes",
      "voteTotals",
      "authors",
    ]);
    const all = votes || {};
    const totals = voteTotals || { good: 0, bad: 0 };
    const byAuthor = authors || {};
    const cur = all[key];

    // 再点同一个 = 取消；点另一个 = 改票。总量计数同步增减
    let delta;
    if (cur?.vote === vote) {
      delete all[key];
      delta = -1;
    } else {
      if (cur) totals[cur.vote] = Math.max(0, (totals[cur.vote] || 0) - 1);
      delta = cur ? 0 : 1;
      all[key] = { vote, date: todayStr(), excerpt: key.slice(0, 80) };
    }
    if (delta !== 0) totals[vote] = Math.max(0, (totals[vote] || 0) + delta);

    // 作者归类：好博主观测数据，长期保留（不随 7 天清理）
    if (author?.handle && delta !== 0) {
      const a = byAuthor[author.handle] || { name: author.name, good: 0, bad: 0, last: "" };
      if (author.name) a.name = author.name;
      a[vote] = Math.max(0, (a[vote] || 0) + delta);
      a.last = todayStr();
      byAuthor[author.handle] = a;
    }

    // 帖子标记只保留最近 7 天，控制体积
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    for (const [k, v] of Object.entries(all)) {
      if (!v.date || new Date(v.date + "T23:59:59") < cutoff) delete all[k];
    }
    await chrome.storage.local.set({ votes: all, voteTotals: totals, authors: byAuthor });
    bar.querySelectorAll(".xat-vote").forEach((b) => b.classList.remove("on"));
    const now = all[key];
    if (now) bar.querySelector(`.xat-vote-${now.vote}`)?.classList.add("on");
  } catch (e) {
    console.warn("[X AI 翻译器] 投票保存失败：", e);
  }
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ---------- 图片 OCR 翻译（需在设置里配置视觉模型） ----------

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
    // 显示文本去掉协议前缀，与 X 原帖的链接显示习惯一致（href 仍为完整地址）
    token = token.replace(/^https?:\/\//, "");
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

const tweetIdOf = (segId) => segId.split(":")[0];

// 收集「可翻译文本节点」（文档顺序）：有字母/文字的非空白文本；
// 链接 <a> 内的文本（@提及、#话题、URL 显示文本）不翻，保持原样
function collectTextNodes(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => {
      let p = n.parentElement;
      while (p && p !== root) {
        if (p.tagName === "A") return NodeFilter.FILTER_REJECT;
        p = p.parentElement;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes = [];
  let n;
  while ((n = walker.nextNode())) {
    const core = n.nodeValue.trim();
    if (core && /\p{L}/u.test(core) && !isChineseText(core)) nodes.push(n);
  }
  return nodes;
}

function collectSegments(el) {
  return collectTextNodes(el).map((n) => n.nodeValue.trim());
}

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

// 扩展上下文是否仍然有效（重新加载/更新扩展后，旧 content script 的 chrome.runtime 会失效）
function contextValid() {
  return !!chrome.runtime?.id;
}

// 上下文失效后旧脚本安静停摆，不再对页面报错
function silentStop() {
  stop();
  console.info("[X AI 翻译器] 扩展已重新加载，请刷新 x.com 页面以恢复翻译");
}

init();
