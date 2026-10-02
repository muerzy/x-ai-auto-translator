// popup：读写设置，保存后通知当前标签页的 content script 即时生效

const $ = (id) => document.getElementById(id);
const els = {
  enabled: $("enabled"),
  baseURL: $("baseURL"),
  apiKey: $("apiKey"),
  model: $("model"),
  targetLang: $("targetLang"),
  btnModels: $("btnModels"),
  btnSave: $("btnSave"),
  status: $("status"),
  modelList: $("modelList"),
};

function showStatus(text, isError = false) {
  els.status.textContent = text;
  els.status.className = "status" + (isError ? " error" : "");
  if (text) setTimeout(() => (els.status.textContent = ""), 4000);
}

async function load() {
  const { settings } = await chrome.storage.local.get("settings");
  const s = settings || {};
  els.enabled.checked = s.enabled !== false;
  els.baseURL.value = s.baseURL || "";
  els.apiKey.value = s.apiKey || "";
  els.model.value = s.model || "";
  els.targetLang.value = s.targetLang || "简体中文";
}

async function save() {
  const settings = {
    enabled: els.enabled.checked,
    baseURL: els.baseURL.value.trim(),
    apiKey: els.apiKey.value.trim(),
    model: els.model.value.trim(),
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

async function fetchModels() {
  // 保存当前输入再拉取，让 service worker 读到最新的 baseURL/apiKey
  await save();
  showStatus("正在拉取模型列表…");
  chrome.runtime.sendMessage({ type: "listModels" }, (resp) => {
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

els.btnSave.addEventListener("click", save);
els.btnModels.addEventListener("click", fetchModels);
load();
