// popup：双视图（主设置 / 高级设置）。读写设置，保存后通知当前标签页的 content script 即时生效。

const $ = (id) => document.getElementById(id);
const els = {
  // 视图
  viewMain: $("viewMain"),
  viewAdvanced: $("viewAdvanced"),
  btnAdvanced: $("btnAdvanced"),
  btnBack: $("btnBack"),
  // 主视图
  enabled: $("enabled"),
  baseURL: $("baseURL"),
  apiKey: $("apiKey"),
  model: $("model"),
  targetLang: $("targetLang"),
  btnModels: $("btnModels"),
  btnSave: $("btnSave"),
  statusMain: $("statusMain"),
  // 高级视图
  visionBaseURL: $("visionBaseURL"),
  visionModel: $("visionModel"),
  voteButtonsEnabled: $("voteButtonsEnabled"),
  statsEnabled: $("statsEnabled"),
  usageGroup: $("usageGroup"),
  statsWrap: $("statsWrap"),
  manageWrap: $("manageWrap"),
  statsOffHint: $("statsOffHint"),
  btnSaveAdv: $("btnSaveAdv"),
  statusAdv: $("statusAdv"),
  statTranslate: $("statTranslate"),
  statVotes: $("statVotes"),
  statTotals: $("statTotals"),
  statAuthors: $("statAuthors"),
  modelList: $("modelList"),
};

// ---------- 视图切换 ----------

els.btnAdvanced.addEventListener("click", () => switchView(true));
els.btnBack.addEventListener("click", () => switchView(false));

function switchView(toAdvanced) {
  els.viewMain.classList.toggle("hidden", toAdvanced);
  els.viewAdvanced.classList.toggle("hidden", !toAdvanced);
  if (toAdvanced) loadStats();
}

function statusEl() {
  return els.viewAdvanced.classList.contains("hidden") ? els.statusMain : els.statusAdv;
}

function showStatus(text, isError = false) {
  const el = statusEl();
  el.textContent = text;
  el.className = "status" + (isError ? " error" : "");
  if (text) setTimeout(() => (el.textContent = ""), 4000);
}

// ---------- 读写设置 ----------

async function load() {
  const { settings } = await chrome.storage.local.get("settings");
  const s = settings || {};
  els.enabled.checked = s.enabled !== false;
  els.baseURL.value = s.baseURL || "";
  els.apiKey.value = s.apiKey || "";
  els.model.value = s.model || "";
  els.visionBaseURL.value = s.visionBaseURL || "";
  els.visionModel.value = s.visionModel || "";
  els.voteButtonsEnabled.checked = s.voteButtonsEnabled !== false;
  els.statsEnabled.checked = s.statsEnabled !== false;
  els.targetLang.value = s.targetLang || "简体中文";
  toggleStatsUI();
}

async function save() {
  const settings = {
    enabled: els.enabled.checked,
    baseURL: els.baseURL.value.trim(),
    apiKey: els.apiKey.value.trim(),
    model: els.model.value.trim(),
    visionBaseURL: els.visionBaseURL.value.trim(),
    visionModel: els.visionModel.value.trim(),
    voteButtonsEnabled: els.voteButtonsEnabled.checked,
    statsEnabled: els.statsEnabled.checked,
    targetLang: els.targetLang.value,
  };
  await chrome.storage.local.set({ settings });
  notifyContentScript();
  showStatus("已保存");
}

// 通知当前标签页设置已变化（非 x.com 页面会失败，忽略即可）
function notifyContentScript() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]?.id != null) {
      chrome.tabs.sendMessage(tabs[0].id, { type: "settingsUpdated" }, () => {
        void chrome.runtime.lastError; // 目标页没有 content script 时消化报错
      });
    }
  });
}

// 用量统计关闭时只隐藏「今日/累计」组；博主归类管理始终可见（数据管理随时可用）
function toggleStatsUI() {
  const statsOn = els.statsEnabled.checked;
  els.usageGroup.classList.toggle("hidden", !statsOn);
  els.statsOffHint.classList.toggle("hidden", statsOn);
  loadStats();
}

els.statsEnabled.addEventListener("change", toggleStatsUI);
els.btnSave.addEventListener("click", save);
els.btnSaveAdv.addEventListener("click", save);

// ---------- 模型列表拉取 ----------

async function fetchModels() {
  // 保存当前输入再拉取，让 service worker 读到最新的 baseURL/apiKey
  await save();
  els.btnModels.disabled = true;
  showStatus("正在拉取模型列表…");
  chrome.runtime.sendMessage({ type: "listModels" }, (resp) => {
    els.btnModels.disabled = false;
    if (chrome.runtime.lastError || !resp || resp.error) {
      showStatus("拉取失败：" + (resp?.error || chrome.runtime.lastError?.message), true);
      return;
    }
    els.modelList.innerHTML = "";
    for (const m of resp.models) {
      const opt = document.createElement("option");
      opt.value = m;
      els.modelList.appendChild(opt);
    }
    if (resp.resolvedBase && resp.resolvedBase !== els.baseURL.value.trim()) {
      els.baseURL.value = resp.resolvedBase;
      save();
    }
    showStatus(`获取到 ${resp.models.length} 个模型，点击模型输入框选择`);
  });
}

els.btnModels.addEventListener("click", fetchModels);

// ---------- 统计展示与数据管理 ----------

// 统计行的小图标：单色 SVG（X 的图标语言），不用 emoji
const SVG_STAR =
  '<svg viewBox="0 0 24 24" width="12" height="12" fill="#f0b429" aria-hidden="true"><path d="M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/></svg>';
const SVG_THUMB =
  '<svg viewBox="0 0 24 24" width="12" height="12" fill="#536471" aria-hidden="true"><path d="M15 3H6c-.83 0-1.54.5-1.84 1.22l-3.02 7.05c-.09.23-.14.47-.14.73v2c0 1.1.9 2 2 2h6.31l-.95 4.57-.03.32c0 .41.17.79.44 1.06L9.83 23l6.59-6.59c.36-.36.58-.86.58-1.41V5c0-1.1-.9-2-2-2z"/></svg>';

function icon(svg) {
  const span = document.createElement("span");
  span.className = "ic";
  span.innerHTML = svg; // 常量字符串，无注入面
  return span;
}

function fmtK(n) {
  return n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n);
}

function loadStats() {
  chrome.runtime.sendMessage({ type: "getStats" }, (resp) => {
    if (chrome.runtime.lastError || !resp || resp.error) {
      els.statTranslate.textContent = "统计不可用";
      els.statVotes.textContent = "";
      els.statTotals.textContent = "";
      els.statAuthors.textContent = "";
      return;
    }
    const s = resp.stats;
    els.statTranslate.textContent =
      `翻译 ${s.segs} 段 · 请求 ${s.requests} 次 · 消耗 ${fmtK(s.prompt + s.completion)} tok`;

    const v = resp.votes;
    els.statVotes.textContent = "标记：";
    els.statVotes.append(icon(SVG_STAR), ` 有用 ${v.good} · `, icon(SVG_THUMB), ` 没用 ${v.bad}`);

    const t = resp.totals;
    els.statTotals.textContent =
      `累计翻译 ${t.segs} 段 · ${fmtK(t.prompt + t.completion)} tok · `;
    els.statTotals.append(
      icon(SVG_STAR),
      ` ${resp.voteTotals.good} · `,
      icon(SVG_THUMB),
      ` ${resp.voteTotals.bad}`
    );

    renderAuthors(resp.authors || []);
  });
}

// 博主归类管理列表：每行带移除按钮
function renderAuthors(authors) {
  els.statAuthors.textContent = "";
  if (authors.length === 0) {
    els.statAuthors.textContent = "还没有标记过帖子";
    return;
  }
  for (const a of authors) {
    const line = document.createElement("div");
    line.className = "author-line";
    const left = document.createElement("span");
    left.className = "author-name";
    left.textContent = a.name ? `${a.name} (@${a.handle})` : `@${a.handle}`;
    left.title = left.textContent;
    const counts = document.createElement("span");
    counts.className = "author-counts";
    counts.append(icon(SVG_STAR), ` ${a.good} `, icon(SVG_THUMB), ` ${a.bad}`);
    const del = document.createElement("button");
    del.type = "button";
    del.className = "author-del";
    del.title = "移除该博主";
    del.setAttribute("aria-label", `移除 ${left.textContent}`);
    del.textContent = "✕";
    del.addEventListener("click", () => manage("deleteAuthor", a.handle));
    line.append(left, counts, del);
    els.statAuthors.appendChild(line);
  }
}

// 危险操作：两步确认（首次点击变「确认？」红底，3 秒内再点执行）
function armDanger(btn, label, action) {
  btn.addEventListener("click", () => {
    if (btn.dataset.armed) {
      clearTimeout(+btn.dataset.timer);
      delete btn.dataset.armed;
      btn.textContent = label;
      btn.classList.remove("armed");
      manage(action);
    } else {
      btn.dataset.armed = "1";
      btn.textContent = "确认？";
      btn.classList.add("armed");
      btn.dataset.timer = setTimeout(() => {
        delete btn.dataset.armed;
        btn.textContent = label;
        btn.classList.remove("armed");
      }, 3000);
    }
  });
}

function manage(action, handle) {
  chrome.runtime.sendMessage({ type: "manageStats", action, handle }, (resp) => {
    if (chrome.runtime.lastError || !resp || resp.error) {
      showStatus("操作失败：" + (resp?.error || chrome.runtime.lastError?.message), true);
      return;
    }
    const labels = {
      resetTranslate: "翻译统计已重置",
      clearVotes: "帖子标记已清空",
      clearAuthors: "博主归类已清空",
      clearCache: `已清空 ${resp.count ?? 0} 条译文缓存`,
      deleteAuthor: "已移除该博主",
    };
    showStatus(labels[action] || "已完成");
    loadStats();
  });
}

armDanger($("btnResetTranslate"), "重置翻译统计", "resetTranslate");
armDanger($("btnClearVotes"), "清空帖子标记", "clearVotes");
armDanger($("btnClearAuthors"), "清空博主归类", "clearAuthors");
armDanger($("btnClearCache"), "清空翻译缓存", "clearCache");

load();
