// X AI 翻译器 - service worker
// 职责：调用 OpenAI 兼容接口（vLLM 等）、批量合并请求、会话级缓存、失败降级逐条重试

const BATCH_SIZE = 10; // 每次请求合并的推文条数
const REQUEST_TIMEOUT_MS = 60_000;

const DEFAULT_SETTINGS = {
  enabled: true,
  baseURL: "", // 例如 http://localhost:8000/v1
  apiKey: "",
  model: "",
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
  if (msg?.type === "listModels") {
    listModels()
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
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
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
    return text;
  } finally {
    clearTimeout(timer);
  }
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

// ---------- 会话级缓存（chrome.storage.session，浏览器关闭即清空） ----------

function hashKey(lang, text) {
  let h = 5381;
  const s = lang + "|" + text;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return "c_" + h.toString(36) + "_" + s.length.toString(36);
}

async function cacheGet(text, lang) {
  const key = hashKey(lang, text);
  const obj = await chrome.storage.session.get(key);
  const v = obj?.[key];
  return typeof v === "string" ? v : null;
}

async function cacheSet(text, lang, translated) {
  const key = hashKey(lang, text);
  await chrome.storage.session.set({ [key]: translated }).catch(() => {});
}
