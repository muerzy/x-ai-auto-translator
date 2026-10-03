// X AI 翻译器 - service worker
// 职责：调用 OpenAI 兼容接口（vLLM 等）、批量合并请求、会话级缓存、失败降级逐条重试

const BATCH_SIZE = 10; // 每次请求合并的推文条数
const REQUEST_TIMEOUT_MS = 60_000;

const DEFAULT_SETTINGS = {
  enabled: true,
  baseURL: "", // 例如 http://localhost:8000/v1
  apiKey: "",
  model: "",
  visionModel: "", // 可选：视觉模型名，配置后启用图片 OCR 翻译
  visionBaseURL: "", // 可选：视觉服务地址，留空则用主服务地址
  statsEnabled: true, // 用量统计：关闭后不记录翻译段数与 token
  voteButtonsEnabled: true, // 帖子标记：关闭后帖子下方不显示 ⭐/👎 按钮
  targetLang: "简体中文",
};

const SYSTEM_PROMPT =
  "你是专业的社交媒体翻译引擎，负责翻译 X(Twitter) 上的帖子和评论。" +
  "输出必须是纯净的翻译结果，不带任何解释、前缀或引号。";

// ---------- 设置 ----------

async function getSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

// ---------- 消息入口 ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "translate") {
    handleTranslate(msg.items)
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ error: errText(e) }));
    return true; // 异步响应
  }
  if (msg?.type === "ocrTranslate") {
    handleOcrTranslate(msg.src)
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ error: errText(e) }));
    return true;
  }
  if (msg?.type === "listModels") {
    listModels()
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ error: errText(e) }));
    return true;
  }
  if (msg?.type === "getStats") {
    getStats()
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ error: errText(e) }));
    return true;
  }
  if (msg?.type === "manageStats") {
    handleManage(msg.action, msg.handle)
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ error: errText(e) }));
    return true;
  }
});

function errText(e) {
  return String(e?.message || e || "未知错误");
}

// ---------- 翻译主流程 ----------

async function handleTranslate(items) {
  const settings = await getSettings();
  // 注意：enabled 表示「自动翻译」模式开关，手动模式（按钮点击）同样允许翻译
  if (!settings.baseURL || !settings.model) {
    throw new Error("请先在插件弹窗里配置服务地址和模型名");
  }

  const results = [];
  const need = [];

  // 1. 查缓存
  for (const it of items) {
    const cached = await cacheGet(it.text, settings.targetLang);
    if (cached != null) {
      results.push({ id: it.id, translated: cached });
    } else {
      need.push(it);
    }
  }

  // 2. 未命中的分批请求
  if (settings.statsEnabled !== false) addStats({ segs: need.length });
  for (let i = 0; i < need.length; i += BATCH_SIZE) {
    const chunk = need.slice(i, i + BATCH_SIZE);
    const translations = await translateTexts(
      chunk.map((x) => x.text),
      settings
    );
    chunk.forEach((it, j) => {
      const translated = translations[j];
      results.push({ id: it.id, translated });
      if (translated != null) cacheSet(it.text, settings.targetLang, translated);
    });
  }

  return { results };
}

// 翻译一组文本，返回与输入对齐的数组（null = 失败）
async function translateTexts(texts, settings) {
  const enc = texts.map(encodeText);
  try {
    const output = await chat(
      settings,
      buildUserPrompt(
        enc.map((e) => e.encoded),
        settings.targetLang
      )
    );
    const map = parseNumbered(output);
    const out = enc.map((e, i) => {
      const t = map.get(i + 1);
      return t == null ? null : decodeText(t, e.tokens);
    });
    if (out.every((x) => x != null)) return out;
    // 有缺号：对缺失的逐条重试
    for (let i = 0; i < out.length; i++) {
      if (out[i] == null) out[i] = await translateSingle(texts[i], settings);
    }
    return out;
  } catch (e) {
    // 整批失败：全部降级逐条
    console.warn("[X AI 翻译器] 批量翻译失败，降级逐条：", errText(e));
    const out = [];
    for (const t of texts) out.push(await translateSingle(t, settings));
    return out;
  }
}

async function translateSingle(text, settings) {
  const { encoded, tokens } = encodeText(text);
  try {
    const output = await chat(settings, buildUserPrompt([encoded], settings.targetLang));
    const parsed = parseNumbered(output).get(1);
    if (parsed != null) return decodeText(parsed, tokens);
    // 模型没按 <<1>> 格式输出时，把整段输出当译文（去掉首尾引号）后解码
    const fallback = String(output).trim().replace(/^["“']+|["”']+$/g, "");
    return fallback ? decodeText(fallback, tokens) : null;
  } catch (e) {
    console.warn("[X AI 翻译器] 单条翻译失败：", errText(e));
    return null;
  }
}

// ---------- 占位符保护：emoji / URL / @提及 / #话题 不进模型，代码保证原位复刻 ----------

const PROTECTED_RE = new RegExp(
  [
    "https?://[^\\s，。；、！？）)】」』\"']+", // URL
    "[@＠][A-Za-z0-9_.]+", // @提及
    "[#＃][A-Za-z0-9_\\u4e00-\\u9fff\\u3040-\\u30ff]+", // #话题
    "\\p{Extended_Pictographic}(?:\\uFE0F|\\u{1F3FB}|\\u{1F3FC}|\\u{1F3FD}|\\u{1F3FE}|\\u{1F3FF}|\\u200D\\p{Extended_Pictographic})*", // emoji 序列（含变体选择符/肤色/ZWJ 组合）
  ].join("|"),
  "gu"
);

// 把受保护内容替换为 ⟦n⟧ 占位符，返回编码后文本与 token 表
function encodeText(text) {
  const tokens = [];
  const encoded = text.replace(PROTECTED_RE, (m) => {
    tokens.push(m);
    return `⟦${tokens.length}⟧`;
  });
  return { encoded, tokens };
}

// 把译文中的占位符换回原内容；模型吞掉的占位符按原顺序追加到末尾，保证零丢失
function decodeText(translated, tokens) {
  const restored = new Array(tokens.length).fill(false);
  let out = String(translated).replace(/⟦\s*(\d+)\s*⟧/g, (m, i) => {
    const idx = Number(i) - 1;
    if (tokens[idx] == null) return m;
    restored[idx] = true;
    return tokens[idx];
  });
  const tail = tokens.filter((_, i) => !restored[i]);
  if (tail.length) out = out.trimEnd() + (out ? " " : "") + tail.join(" ");
  return out;
}

// ---------- Prompt 与解析 ----------

function buildUserPrompt(texts, targetLang) {
  const lines = texts
    .map((t, i) => `<<${i + 1}>> ${t.trim()}`) // 保留换行，让译文保持原帖的排版结构
    .join("\n");
  return `把下面编号的推文逐条翻译成${targetLang}。

规则：
- 无论源语言是什么（英语、日语、韩语、法语、德语、俄语、西班牙语、阿拉伯语等），只要内容不是${targetLang}，就完整翻译成${targetLang}
- 原文中的 ⟦数字⟧ 是占位符，代表原文里的 emoji、URL、@用户名或 #话题标签：必须原样保留在译文的对应位置，不得删除、改写、合并或新增
- 占位符紧贴它修饰的文字，不要前后加空格或换行，也不要把它挪到行首/行尾单独成行（除非它在原文中本来就独占一行）
- 保留原文的换行和分段：原文在哪里换行/空行，译文也在对应位置换行/空行
- 网络俚语、缩写、梗优先翻译成地道的对应表达，必要处用括号加简短注释
- 相邻编号的条目可能是同一条推文里被链接/表情分隔的连续文字，翻译时保持前后语义连贯
- 若某条已经是${targetLang}，原样返回该条
- 输出格式：每条译文紧跟 <<编号>> 之后，译文内部可以有换行，条与条之间用 <<编号>> 分隔，不要输出其他任何内容

${lines}`;
}

// 解析 "<<1>> xxx\n<<2>> yyy" 格式，返回 Map<编号, 译文>
function parseNumbered(output) {
  const map = new Map();
  const content = String(output || "").trim();
  const re = /<<\s*(\d+)\s*>>\s*([\s\S]*?)(?=\n?\s*<<\s*\d+\s*>>|$)/g;
  let m;
  while ((m = re.exec(content))) {
    const t = m[2].trim();
    if (t) map.set(Number(m[1]), t);
  }
  return map;
}

// ---------- HTTP ----------

function joinURL(base, path) {
  return base.replace(/\/+$/, "") + path;
}

async function chat(settings, userPrompt) {
  return chatMessages(settings, [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userPrompt },
  ]);
}

// 视觉模型 OCR：图片转成 OpenAI vision 格式的 image_url content
async function chatVision(settings, userPrompt, imageDataUrl) {
  return chatMessages(settings, [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: [
        { type: "text", text: userPrompt },
        { type: "image_url", image_url: { url: imageDataUrl } },
      ],
    },
  ]);
}

async function chatMessages(settings, messages) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const headers = { "Content-Type": "application/json" };
    if (settings.apiKey) headers["Authorization"] = `Bearer ${settings.apiKey}`;

    const res = await fetch(joinURL(settings.baseURL, "/chat/completions"), {
      method: "POST",
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model: settings.model,
        messages,
        temperature: 0.2,
        max_tokens: 4096,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`接口返回 ${res.status}：${body.slice(0, 200)}`);
    }
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content;
    if (!text) throw new Error("接口返回内容为空");
    const usage = data?.usage || {};
    if (settings.statsEnabled !== false) {
      addStats({
        requests: 1,
        prompt: usage.prompt_tokens || 0,
        completion: usage.completion_tokens || 0,
      });
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

// ---------- 图片 OCR 翻译（点击图片上的按钮触发，译文按坐标贴回图片） ----------

const OCR_PROMPT = (lang) =>
  `找出图片中所有含自然语言文字的区域（标题、句子、说明、标签），逐块翻译成${lang}。只输出一个 JSON 数组，不要输出任何其他文字或代码块标记：\n` +
  `[{"box":[x1,y1,x2,y2],"dst":"译文"}]\n` +
  `规则：\n` +
  `- box 是文字块的边界框，使用 0-1000 的归一化坐标（相对图片宽高），x1<x2、y1<y2，框要完整包住该块文字并稍微留边\n` +
  `- 把属于同一句话/同一段落的相邻文字合并成一个块，不要按行或按单词拆成碎块\n` +
  `- 数字、代码、JSON、URL 与所在文字块一起处理：在 dst 中原样保留，不要单独成块，不要翻译它们\n` +
  `- 忽略纯数字、纯符号的区域（如独立的小数、百分比、时间戳），它们不算文字块\n` +
  `- dst 是通顺的${lang}文本，不要夹带 JSON 结构、引号或原文\n` +
  `- 图片里没有文字时输出 []`;

async function handleOcrTranslate(src) {
  const settings = await getSettings();
  if (!settings.visionModel) throw new Error("未配置视觉模型：请到高级设置填写");
  if (!settings.baseURL || !settings.model) {
    throw new Error("请先在插件弹窗里配置服务地址和模型名");
  }

  const cached = await cacheGet(src, "@@ocr");
  if (cached != null) return JSON.parse(cached);

  const dataUrl = await fetchImageDataUrl(src);
  // 视觉服务可以和主服务不同端点：visionBaseURL 留空时沿用主地址，API Key 复用主配置
  const visionSettings = {
    ...settings,
    model: settings.visionModel,
    baseURL: settings.visionBaseURL || settings.baseURL,
  };
  const raw = String(await chatVision(visionSettings, OCR_PROMPT(settings.targetLang), dataUrl)).trim();
  if (settings.statsEnabled !== false) addStats({ segs: 1 });

  const payload = parseOcrPayload(raw);
  await cacheSet(src, "@@ocr", JSON.stringify(payload));
  return payload;
}

// 解析视觉模型输出：优先取坐标块；JSON 形状但无有效块时返回空（不把 JSON 当译文）；
// 完全不是 JSON 的纯文本才降级贴在图片底部
function parseOcrPayload(raw) {
  const m = raw.match(/\[[\s\S]*\]/);
  if (!m) return { regions: [], text: raw.replace(/^```[\s\S]*?```$/, "").trim() };
  try {
    const arr = JSON.parse(m[0]);
    if (Array.isArray(arr)) {
      const regions = arr
        .filter((r) => r && Array.isArray(r.box) && r.box.length === 4 && typeof r.dst === "string" && r.dst.trim())
        .map((r) => ({
          box: r.box.map((n) => Math.min(1000, Math.max(0, Number(n) || 0))),
          dst: r.dst.trim(),
        }))
        .filter((r) => {
          if (r.box[2] <= r.box[0] || r.box[3] <= r.box[1]) return false;
          if (r.dst.length > 200) return false; // 异常长的块基本是模型输出失控
          // 纯数字/符号块是模型把小数、时间戳当文字了，丢弃
          return /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7a3a-z]/i.test(r.dst);
        })
        .map((r) => padBox(r));
      if (regions.length) return { regions: regions.slice(0, 40) };
    }
  } catch {
    /* JSON 畸形，按空处理 */
  }
  return { regions: [], text: "" };
}

// 贴块四周外扩一点，盖住原文字的边缘，避免原译文错位重叠
function padBox(r) {
  const [x1, y1, x2, y2] = r.box;
  const w = x2 - x1;
  const h = y2 - y1;
  const px = w * 0.06;
  const py = h * 0.12;
  return {
    box: [
      Math.max(0, x1 - px),
      Math.max(0, y1 - py),
      Math.min(1000, x2 + px),
      Math.min(1000, y2 + py),
    ],
    dst: r.dst,
  };
}

// 后台 fetch 图片转 dataURL（不受页面 CORS 限制；SW 里没有 FileReader，手写 base64）
async function fetchImageDataUrl(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`图片下载失败 HTTP ${res.status}`);
  const blob = await res.blob();
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return `data:${blob.type || "image/jpeg"};base64,${btoa(bin)}`;
}

// ---------- 用量统计（今日：段数 / 请求数 / 真实 token，跨天自动重置） ----------

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function addStats(delta) {
  const { stats, totals } = await chrome.storage.local.get(["stats", "totals"]);
  const fresh = { segs: 0, requests: 0, prompt: 0, completion: 0 };
  const s = stats?.date === todayStr() ? stats : { date: todayStr(), ...fresh };
  const t = totals || { ...fresh };
  for (const k of Object.keys(fresh)) {
    s[k] += delta[k] || 0;
    t[k] += delta[k] || 0;
  }
  await chrome.storage.local.set({ stats: s, totals: t }).catch(() => {});
}

async function getStats() {
  const [{ stats }, { totals }, { votes }, { voteTotals }, { authors }] = await Promise.all([
    chrome.storage.local.get("stats"),
    chrome.storage.local.get("totals"),
    chrome.storage.local.get("votes"),
    chrome.storage.local.get("voteTotals"),
    chrome.storage.local.get("authors"),
  ]);
  const today = todayStr();
  const fresh = { segs: 0, requests: 0, prompt: 0, completion: 0 };
  const s = stats?.date === today ? stats : { date: today, ...fresh };
  let good = 0;
  let bad = 0;
  for (const v of Object.values(votes || {})) {
    if (v?.date === today) v.vote === "good" ? good++ : bad++;
  }
  // 博主榜单：按有用数降序取前 10
  const list = Object.entries(authors || {})
    .map(([handle, a]) => ({ handle, name: a.name || "", good: a.good || 0, bad: a.bad || 0 }))
    .sort((a, b) => b.good - a.good || a.bad - b.bad)
    .slice(0, 10);
  return {
    stats: s,
    totals: totals || fresh,
    votes: { good, bad },
    voteTotals: voteTotals || { good: 0, bad: 0 },
    authors: list,
  };
}

// ---------- 数据管理（高级设置里的重置/清空/移除） ----------

async function handleManage(action, handle) {
  if (action === "resetTranslate") {
    await chrome.storage.local.remove(["stats", "totals"]);
  } else if (action === "clearVotes") {
    await chrome.storage.local.remove(["votes", "voteTotals"]);
  } else if (action === "clearAuthors") {
    await chrome.storage.local.remove(["authors"]);
  } else if (action === "clearCache") {
    const all = await chrome.storage.local.get(null);
    const keys = Object.keys(all).filter((k) => k.startsWith("c_")); // 译文缓存键前缀，见 hashKey
    if (keys.length) await chrome.storage.local.remove(keys);
    return { ok: true, count: keys.length };
  } else if (action === "deleteAuthor" && handle) {
    const { authors } = await chrome.storage.local.get("authors");
    if (authors?.[handle]) {
      delete authors[handle];
      await chrome.storage.local.set({ authors });
    }
  } else {
    throw new Error(`未知操作：${action}`);
  }
  return { ok: true };
}

// 拉取模型列表（vLLM: GET {baseURL}/models），自动尝试补 /v1
async function listModels() {
  const settings = await getSettings();
  if (!settings.baseURL) throw new Error("请先填写服务地址");

  const bases = [settings.baseURL.replace(/\/+$/, "")];
  if (!/\/v\d+$/.test(bases[0])) bases.push(bases[0] + "/v1");

  let lastErr = null;
  for (const base of bases) {
    try {
      const headers = {};
      if (settings.apiKey) headers["Authorization"] = `Bearer ${settings.apiKey}`;
      const res = await fetch(joinURL(base, "/models"), { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const models = (data?.data || []).map((m) => m.id).filter(Boolean);
      if (models.length) return { models, resolvedBase: base };
      throw new Error("模型列表为空");
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`无法获取模型列表（${errText(lastErr)}），请检查服务地址`);
}

// ---------- 译文缓存（chrome.storage.local，24 小时过期：刷下去再刷回来不重复花钱） ----------

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function hashKey(lang, text) {
  let h = 5381;
  const s = lang + "|" + text;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return "c_" + h.toString(36) + "_" + s.length.toString(36);
}

async function cacheGet(text, lang) {
  const key = hashKey(lang, text);
  const obj = await chrome.storage.local.get(key);
  const entry = obj?.[key];
  if (!entry || typeof entry.v !== "string") return null;
  if (Date.now() - entry.t > CACHE_TTL_MS) {
    chrome.storage.local.remove(key).catch(() => {});
    return null;
  }
  return entry.v;
}

async function cacheSet(text, lang, translated) {
  const key = hashKey(lang, text);
  await chrome.storage.local.set({ [key]: { v: translated, t: Date.now() } }).catch(() => {});
}
