// ============================================================
// 设置页逻辑 —— 依赖 core/constants.js 和 core/providers.js
// ============================================================

const { STORAGE_KEYS: KEYS, DEFAULTS: DEFAULT } = window.BT_CONST;
const PROVIDERS = window.AI_PROVIDERS;

let cfg = { ...DEFAULT };
let currentService = null;
let editingProvider = null;

// ---------- 工具 ----------
/**
 * 将引擎和 AI 厂商编码为下拉选项值，例如 ai:openai。
 */
function engineToSelectValue(engine, provider) {
  if (engine === "ai") return `ai:${provider || "openai"}`;
  return engine;
}
/**
 * 解析引擎下拉值，返回实际引擎与厂商；普通引擎保留当前 AI 厂商。
 */
function selectValueToEngine(v) {
  if (typeof v === "string" && v.startsWith("ai:")) {
    return { engine: "ai", aiProvider: v.slice(3) };
  }
  return { engine: v, aiProvider: cfg.aiProvider };
}
/**
 * 判断服务是否具备必填配置，控制未配置服务的选择状态。
 */
function isEngineConfigured(id) {
  if (id === "google" || id === "mymemory") return true;
  if (id === "baidu") return !!(cfg.baiduAppId && cfg.baiduKey);
  // 下拉选项使用 ai:厂商标识，分别检查每家服务是否已配置。
  if (typeof id === "string" && id.startsWith("ai:")) return isProviderConfigured(id.slice(3));
  if (id === "ai") return isProviderConfigured(cfg.aiProvider || "openai");
  return false;
}
/**
 * 检查指定 AI 厂商的密钥是否已填写；本地 Ollama 无需密钥。
 */
function isProviderConfigured(pid) {
  if (pid === "ollama") return true;
  const keys = (cfg.aiKeys && cfg.aiKeys[pid]) || {};
  return !!keys.key;
}

/**
 * 仅更新正在编辑厂商的配置字段，未传入的字段保留原值。
 */
function setCurrentProviderData(data) {
  const pid = editingProvider || cfg.aiProvider || "openai";
  if (!cfg.aiKeys) cfg.aiKeys = {};
  cfg.aiKeys[pid] = {
    key: data.key !== undefined ? data.key : (cfg.aiKeys[pid] || {}).key || "",
    base: data.base !== undefined ? data.base : (cfg.aiKeys[pid] || {}).base || "",
    model: data.model !== undefined ? data.model : (cfg.aiKeys[pid] || {}).model || ""
  };
}

/**
 * 将所选厂商的保存配置或默认值填入表单，并兼容旧版默认模型。
 */
function renderProviderInputs(providerId) {
  const existing = (cfg.aiKeys && cfg.aiKeys[providerId]) || {};
  const preset = PROVIDERS[providerId] || PROVIDERS.custom;

  const keyEl = document.getElementById("openaiKey");
  const baseEl = document.getElementById("openaiBase");
  const modelEl = document.getElementById("openaiModel");

  const key = existing.key || "";
  const base = existing.base || preset.base || "";
  // 更新旧版内置的 Kimi 默认模型，同时保留用户自定义的模型标识。
  const model = (providerId === "moonshot" && existing.model === "moonshot-v1-8k")
    ? (preset.model || "kimi-k2.5")
    : (existing.model || preset.model || "");

  if (keyEl) keyEl.value = key;
  if (baseEl) baseEl.value = base;
  if (modelEl) modelEl.value = model;

  if (!cfg.aiKeys) cfg.aiKeys = {};
  cfg.aiKeys[providerId] = { key, base, model };
}

/**
 * 读取并去除服务表单字段的首尾空白，返回密钥、基础地址和模型配置。
 */
function readProviderInputs() {
  const keyEl = document.getElementById("openaiKey");
  const baseEl = document.getElementById("openaiBase");
  const modelEl = document.getElementById("openaiModel");
  return {
    key: keyEl ? keyEl.value.trim() : "",
    base: baseEl ? baseEl.value.trim() : "",
    model: modelEl ? modelEl.value.trim() : ""
  };
}

/**
 * 根据是否启用和是否配置生成单个厂商的状态徽标内容。
 */
function renderProviderBadge(providerId) {
  const isUsing = providerId === cfg.aiProvider && cfg.engine === "ai";
  const isConfigured = isProviderConfigured(providerId);

  if (isUsing) {
    return '<span class="provider-badge provider-badge-using">使用中</span>';
  }
  if (isConfigured) {
    return '<span class="provider-badge provider-badge-ok">已配置</span>';
  }
  return "";
}

/**
 * 统一刷新各 AI 厂商的配置状态和当前使用标记。
 */
function refreshAllProviderBadges() {
  const grid = document.getElementById("providerGrid");
  if (!grid) return;
  grid.querySelectorAll(".provider-item").forEach((item) => {
    const pid = item.dataset.provider;
    const nameEl = item.querySelector(".provider-name");
    if (!nameEl) return;
    nameEl.querySelectorAll(".provider-badge").forEach((b) => b.remove());
    nameEl.insertAdjacentHTML("beforeend", renderProviderBadge(pid));
  });
}

/**
 * 更新当前启用服务的说明条，区分正在编辑与实际使用的厂商。
 */
function refreshCurrentUsingBar() {
  const bar = document.getElementById("currentUsingBar");
  const textEl = document.getElementById("currentUsingText");
  const btnEl = document.getElementById("setCurrentBtn");
  if (!bar || !textEl || !btnEl) return;

  const usingPid = cfg.aiProvider || "openai";
  const usingName = (PROVIDERS[usingPid] || {}).name || usingPid;
  const usingConfigured = isProviderConfigured(usingPid);

  textEl.innerHTML = `当前使用：<b>${usingName}</b>${usingConfigured ? "" : "（未配置）"}`;

  const editing = editingProvider || usingPid;
  if (editing !== usingPid && isProviderConfigured(editing)) {
    btnEl.style.display = "inline-flex";
    btnEl.textContent = `切换为 ${(PROVIDERS[editing] || {}).name || editing}`;
  } else {
    btnEl.style.display = "none";
  }
}

// ---------- 悬停翻译模式 ----------
/**
 * 把悬停开关及 Shift 要求组合成界面使用的单一模式值。
 */
function getHoverTranslateMode() {
  if (!cfg.hoverTranslate) return "off";
  if (cfg.hoverRequireShift) return "shift";
  return "direct";
}

/**
 * 将悬停模式还原为对应配置字段，更新提示并保存。
 */
function setHoverTranslateMode(mode) {
  if (mode === "off") {
    cfg.hoverTranslate = false;
    cfg.hoverRequireShift = true;
  } else if (mode === "shift") {
    cfg.hoverTranslate = true;
    cfg.hoverRequireShift = true;
  } else if (mode === "direct") {
    cfg.hoverTranslate = true;
    cfg.hoverRequireShift = false;
  }
  updateHoverTranslateHint(mode);
}

/**
 * 根据悬停模式更新行为说明文字。
 */
function updateHoverTranslateHint(mode) {
  const hintEl = document.getElementById("hoverTranslateHint");
  if (!hintEl) return;
  if (mode === "off") {
    hintEl.textContent = "悬停段落时不会自动翻译。";
  } else if (mode === "shift") {
    hintEl.textContent = "按住 Shift 并把鼠标移到段落上，自动翻译该段。";
  } else if (mode === "direct") {
    hintEl.textContent = "鼠标悬停在段落上即翻译，可能误触。";
  }
}

// ---------- 快捷键 ----------
/**
 * 读取浏览器扩展快捷键，失败时保留可用的默认界面。
 */
async function loadAllCommands() {
  return new Promise((resolve) => {
    if (!chrome.commands || !chrome.commands.getAll) {
      resolve([]);
      return;
    }
    chrome.commands.getAll((commands) => {
      resolve(commands || []);
    });
  });
}

/**
 * 将浏览器返回的快捷键格式转换为设置页使用的展示格式。
 */
function formatShortcut(s) {
  if (!s) return "";
  return s.split("+").map((p) => {
    if (p === "Command" || p === "Cmd" || p === "MacCtrl") return "⌘";
    if (p === "Shift") return "⇧";
    if (p === "Alt") return "Alt";
    if (p === "Ctrl" || p === "Control") return "Ctrl";
    return p;
  }).join(" + ");
}

/**
 * 刷新浏览器命令及网页快捷键的显示状态。
 */
async function refreshShortcutDisplay() {
  const commands = await loadAllCommands();
  const cmd = commands.find((c) => c.name === "toggle-translation");
  const shortcut = cmd && cmd.shortcut ? cmd.shortcut : "";
  const display = shortcut ? formatShortcut(shortcut) : "";

  const kbdEl = document.getElementById("shortcutDisplay-toggle-translation");
  const hintEl = document.getElementById("shortcutHint-toggle-translation");
  if (kbdEl) {
    if (display) {
      kbdEl.textContent = display;
      kbdEl.classList.remove("empty");
    } else {
      kbdEl.textContent = "未设置";
      kbdEl.classList.add("empty");
    }
  }
  if (hintEl) {
    hintEl.textContent = display ? "" : "点击右侧按钮设置";
    hintEl.style.display = display ? "none" : "inline";
  }

  const guideEl = document.getElementById("guideShortcutKey");
  if (guideEl) {
    guideEl.textContent = display || "未设置";
  }
}

// ---------- 迁移旧数据 ----------
/**
 * 通过共享迁移层兼容旧版服务配置，避免要求用户重复填写密钥。
 */
async function migrateOldData() {
  // 使用共享迁移逻辑，先落盘本机密钥，再清理同步区旧字段。
  await window.BT_STORAGE.migrateCredentials();
}

// ---------- 初始化 ----------
/**
 * 读取设置、处理迁移并初始化版本展示、表单和事件绑定。
 */
async function init() {
  // 版本号以扩展清单为唯一来源，避免侧栏和关于页面的版本显示不一致。
  const version = chrome.runtime.getManifest().version;
  document.getElementById('version').textContent = 'v' + version;
  document.getElementById('aboutVersion').textContent = version;
  await migrateOldData();

  const stored = await window.BT_STORAGE.get(KEYS);
  cfg = { ...DEFAULT, ...stored };
  if (!cfg.aiKeys) cfg.aiKeys = {};

  renderAll();
  bindNav();
  bindFields();
  bindBackButton();
  renderServiceList();
  bindBehaviorExtras();
  await refreshShortcutDisplay();
}

// ---------- 渲染 ----------
/**
 * 把当前配置渲染到语言、行为和翻译服务等设置控件。
 */
function renderAll() {
  renderEngineSelect();
  window.BT_CONST.fillLanguageSelect(document.getElementById("from"),"from",cfg.from);
  window.BT_CONST.fillLanguageSelect(document.getElementById("to"),"to",cfg.to);
  setValue("concurrency", cfg.concurrency);
  setSegment("mode-seg", cfg.mode);
  setSwitch("autoTranslate", cfg.autoTranslate);
  setSwitch("hoverPanel", cfg.hoverPanel);
  setSwitch("shortcutTranslate", cfg.shortcutTranslate);

  const modeEl = document.getElementById("hoverTranslateMode");
  if (modeEl) {
    const mode = getHoverTranslateMode();
    modeEl.value = mode;
    updateHoverTranslateHint(mode);
  }

  renderServiceList();
  updateBehaviorSubStates();
}

/**
 * 生成包含 AI 厂商的引擎下拉选项，并反映当前启用状态。
 */
function renderEngineSelect() {
  const sel = document.getElementById("engine");
  if (!sel) return;
  const currentVal = engineToSelectValue(cfg.engine, cfg.aiProvider);
  const engines = [
    { id: "google", label: "Google（免费）" },
    { id: "baidu", label: "百度翻译" },
    { id: `ai:${cfg.aiProvider || "openai"}`, label: `AI 大模型（${(PROVIDERS[cfg.aiProvider] || {}).name || cfg.aiProvider}）` },
    { id: "mymemory", label: "MyMemory（免费）" }
  ];
  const configured = engines.filter((e) => isEngineConfigured(e.id));
  const unconfigured = engines.filter((e) => !isEngineConfigured(e.id));
  let html = "";
  configured.forEach((e) => { html += `<option value="${e.id}">✓ ${e.label}</option>`; });
  if (unconfigured.length) {
    html += '<optgroup label="未配置（请先到翻译服务配置）">';
    unconfigured.forEach((e) => { html += `<option value="${e.id}" class="bt-unconfigured">${e.label}（未配置）</option>`; });
    html += '</optgroup>';
  }
  sel.innerHTML = html;
  if (currentVal && sel.querySelector(`option[value="${currentVal}"]`)) {
    sel.value = currentVal;
  } else if (configured.length) {
    sel.value = configured[0].id;
    const parsed = selectValueToEngine(sel.value);
    cfg.engine = parsed.engine;
    cfg.aiProvider = parsed.aiProvider;
  }
  const hintEl = document.getElementById("engineHint");
  if (hintEl) {
    hintEl.textContent = unconfigured.length
      ? `⚠ 有 ${unconfigured.length} 个引擎未配置，请到“翻译服务”填写密钥后再选用。`
      : "想换 AI 厂商？到「翻译服务 → AI 大模型」里切换。";
    hintEl.style.color = unconfigured.length ? "#d64545" : "#999";
  }
}

/**
 * 按元素 ID 设置表单值；元素不存在时不做处理。
 */
function setValue(id, val) {
  const el = document.getElementById(id);
  if (el && val !== undefined && val !== null) el.value = val;
}
/**
 * 更新开关控件的启用样式。
 */
function setSwitch(id, on) {
  const el = document.getElementById(id);
  if (el) el.classList.toggle("on", !!on);
}
/**
 * 根据配置值更新分段按钮的选中状态。
 */
function setSegment(segId, value) {
  const seg = document.getElementById(segId);
  if (!seg) return;
  seg.querySelectorAll(".seg-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.mode === value);
  });
}

const SERVICES = [
  { id: "google",   name: "Google 翻译", desc: "免费，速度快，质量好",                icon: "🌐" },
  { id: "baidu",    name: "百度翻译",     desc: "需配置 AppID + 密钥",                 icon: "🔵" },
  { id: "ai",       name: "AI 大模型",    desc: "OpenAI / DeepSeek / Kimi / 通义 等",  icon: "🤖" },
  { id: "mymemory", name: "MyMemory",    desc: "免费，有每日额度限制",                 icon: "💾" }
];

/**
 * 渲染翻译服务列表及每项服务的当前配置状态。
 */
function renderServiceList() {
  const grid = document.getElementById("serviceGrid");
  if (!grid) return;
  grid.innerHTML = "";
  SERVICES.forEach((svc) => {
    const status = getServiceStatus(svc.id);
    const card = document.createElement("div");
    card.className = "service-card";
    card.innerHTML = `
      <div class="service-icon ${svc.id}">${svc.icon}</div>
      <div class="service-info">
        <div class="service-name">${svc.name}</div>
        <div class="service-desc">${svc.desc}</div>
      </div>
      <span class="badge ${status.cls}">${status.text}</span>
      <span class="service-arrow">›</span>
    `;
    card.addEventListener("click", () => openServiceDetail(svc.id));
    grid.appendChild(card);
  });
}

/**
 * 计算指定服务在列表中展示的状态说明。
 */
function getServiceStatus(id) {
  if (id === "google" || id === "mymemory") return { text: "已启用", cls: "badge-ok" };
  if (id === "baidu") {
    if (cfg.baiduAppId && cfg.baiduKey) return { text: "已配置", cls: "badge-ok" };
    return { text: "未配置", cls: "" };
  }
  if (id === "ai") {
    const configuredCount = Object.keys(PROVIDERS).filter((pid) => isProviderConfigured(pid)).length;
    if (configuredCount > 0) return { text: `已配置 ${configuredCount} 个`, cls: "badge-ok" };
    return { text: "未配置", cls: "" };
  }
  return { text: "", cls: "" };
}

/**
 * 进入所选翻译服务详情，生成内容并绑定相应表单事件。
 */
function openServiceDetail(id) {
  currentService = id;
  editingProvider = null;

  const listView = document.getElementById("serviceListView");
  const detailView = document.getElementById("serviceDetailView");
  const content = document.getElementById("serviceDetailContent");
  listView.style.display = "none";
  detailView.style.display = "block";
  content.innerHTML = buildServiceDetailHTML(id);

  if (id === "baidu") bindBaiduDetail();
  else if (id === "ai") bindAIDetail();
  else if (id === "google" || id === "mymemory") bindFreeDetail(id);
}

/**
 * 退出服务详情并返回服务列表，刷新列表与引擎状态。
 */
function closeServiceDetail() {
  currentService = null;
  editingProvider = null;
  const listView = document.getElementById("serviceListView");
  const detailView = document.getElementById("serviceDetailView");
  if (listView) listView.style.display = "block";
  if (detailView) detailView.style.display = "none";
  renderServiceList();
}

/**
 * 根据服务类型生成详情模板，分别提供免费服务、百度及 AI 配置入口。
 */
function buildServiceDetailHTML(id) {
  if (id === "google") {
    return `
      <div class="service-detail-header">
        <div class="service-icon google">🌐</div>
        <div><h1>Google 翻译</h1><p class="desc">免费，无需配置，开箱即用</p></div>
      </div>
      <div class="card">
        <h3>说明</h3>
        <ul class="tips">
          <li>使用 Google 免费翻译接口，无需 API Key</li>
          <li>速度快，质量好，推荐作为默认引擎</li>
          <li>偶尔可能被限流，如遇失败可切换其他引擎</li>
        </ul>
      </div>
      <div class="card-actions">
        <button class="btn-test" id="testGoogle">测试连接</button>
        <span class="test-result" id="googleTestResult"></span>
      </div>
    `;
  }

  if (id === "mymemory") {
    return `
      <div class="service-detail-header">
        <div class="service-icon mymemory">💾</div>
        <div><h1>MyMemory</h1><p class="desc">免费，有每日额度限制</p></div>
      </div>
      <div class="card">
        <h3>说明</h3>
        <ul class="tips">
          <li>免费翻译接口，无需 API Key</li>
          <li>每日有匿名额度限制（约 5000 字符/天）</li>
          <li>翻译质量一般，建议作为备用引擎</li>
        </ul>
      </div>
      <div class="card-actions">
        <button class="btn-test" id="testMymemory">测试连接</button>
        <span class="test-result" id="mymemoryTestResult"></span>
      </div>
    `;
  }

  if (id === "baidu") {
    return `
      <div class="service-detail-header">
        <div class="service-icon baidu">🔵</div>
        <div><h1>百度翻译</h1><p class="desc">需配置 AppID 和密钥</p></div>
      </div>
      <div class="card">
        <div class="field">
          <label>AppID</label>
          <input id="baiduAppId" placeholder="在百度翻译开放平台申请" autocomplete="off" />
        </div>
        <div class="field">
          <label>密钥（Key）</label>
          <div class="input-wrap">
            <input id="baiduKey" type="password" placeholder="••••••••" autocomplete="off" />
            <button class="toggle-pwd" data-target="baiduKey" title="显示/隐藏">👁</button>
          </div>
        </div>
        <div class="hint">
          申请地址：<a href="https://fanyi-api.baidu.com/" target="_blank">fanyi-api.baidu.com</a>
          · 选择"通用文本翻译"· 标准版免费额度 5 万字符/月
        </div>
        <div class="card-actions">
          <button class="btn-test" id="testBaidu">测试连接</button>
          <span class="test-result" id="baiduTestResult"></span>
        </div>
      </div>
    `;
  }

  if (id === "ai") {
    const usingPid = cfg.aiProvider || "openai";
    const usingName = (PROVIDERS[usingPid] || {}).name || usingPid;

    return `
      <div class="service-detail-header">
        <div class="service-icon ai">🤖</div>
        <div><h1>AI 大模型</h1><p class="desc">OpenAI 兼容接口，支持国内外主流模型</p></div>
      </div>

      <div class="current-using-bar" id="currentUsingBar">
        <div class="current-using-info">
          <span class="current-using-icon">⚡</span>
          <span class="current-using-text" id="currentUsingText">
            当前使用：<b>${usingName}</b>
          </span>
        </div>
        <button class="current-using-btn" id="setCurrentBtn" style="display:none"></button>
      </div>

      <div class="card">
        <div class="ai-section-title">1. 选择服务商</div>
        <div class="provider-grid" id="providerGrid">
          ${Object.entries(PROVIDERS).map(([k, v]) => {
            return `
              <div class="provider-item" data-provider="${k}">
                <div class="provider-name">
                  ${v.name}
                  ${renderProviderBadge(k)}
                </div>
                <div class="provider-hint">${v.hint}</div>
              </div>
            `;
          }).join("")}
        </div>
        <select id="aiProvider" style="display:none">
          ${Object.entries(PROVIDERS).map(([k, v]) => `<option value="${k}">${v.name}</option>`).join("")}
        </select>
      </div>

      <div class="card">
        <div class="ai-section-title">2. 填写密钥</div>

        <div class="field">
          <label>API Key <span class="required">*</span></label>
          <div class="input-wrap">
            <input id="openaiKey" type="password" placeholder="sk-..." autocomplete="off" />
            <button class="toggle-pwd" data-target="openaiKey" title="显示/隐藏">👁</button>
          </div>
          <div class="hint" id="keyHint"></div>
        </div>

        <div class="field">
          <label>Base URL</label>
          <input id="openaiBase" placeholder="https://api.openai.com/v1" autocomplete="off" />
          <div class="hint">选择服务商后自动填充，可手动修改</div>
        </div>

        <div class="field">
          <label>模型名称</label>
          <input id="openaiModel" placeholder="gpt-4o-mini" autocomplete="off" />
          <div class="hint" id="modelHint"></div>
        </div>

        <div class="card-actions">
          <button class="btn-test" id="testAI">测试连接</button>
          <span class="test-result" id="aiTestResult"></span>
        </div>
      </div>
    `;
  }

  return "";
}

/**
 * 绑定免费服务详情中的测试与启用操作。
 */
function bindFreeDetail(id) {
  const btnId = id === "google" ? "testGoogle" : "testMymemory";
  const resId = id === "google" ? "googleTestResult" : "mymemoryTestResult";
  const btn = document.getElementById(btnId);
  if (!btn) return;
  btn.addEventListener("click", () => runTest(id, resId, btn));
}

/**
 * 绑定百度凭据输入、接口测试和服务启用操作。
 */
function bindBaiduDetail() {
  setValue("baiduAppId", cfg.baiduAppId);
  setValue("baiduKey", cfg.baiduKey);

  const appIdEl = document.getElementById("baiduAppId");
  const keyEl = document.getElementById("baiduKey");
  appIdEl.addEventListener("input", () => { cfg.baiduAppId = appIdEl.value.trim(); save(); });
  keyEl.addEventListener("input", () => { cfg.baiduKey = keyEl.value.trim(); save(); });

  const toggle = document.querySelector(".service-detail-view .toggle-pwd");
  if (toggle) {
    toggle.addEventListener("click", () => {
      if (keyEl.type === "password") { keyEl.type = "text"; toggle.textContent = "🙈"; }
      else { keyEl.type = "password"; toggle.textContent = "👁"; }
    });
  }

  const btn = document.getElementById("testBaidu");
  btn.addEventListener("click", () => runTest("baidu", "baiduTestResult", btn));
}

/**
 * 绑定 AI 厂商编辑、域名授权、测试及启用流程，避免未授权时发送请求。
 */
function bindAIDetail() {
  editingProvider = cfg.aiProvider || "openai";
  renderProviderInputs(editingProvider);
  updateProviderGrid(editingProvider);
  updateProviderUI(editingProvider);
  refreshCurrentUsingBar();

  const providerEl = document.getElementById("aiProvider");
  if (providerEl) {
    providerEl.value = editingProvider;
    providerEl.addEventListener("change", () => {
      const newPid = providerEl.value;
      const oldPid = editingProvider;

      if (oldPid && oldPid !== newPid) {
        const oldData = readProviderInputs();
        if (!cfg.aiKeys) cfg.aiKeys = {};
        cfg.aiKeys[oldPid] = oldData;
      }

      editingProvider = newPid;
      renderProviderInputs(newPid);
      updateProviderUI(newPid);
      updateProviderGrid(newPid);

      window.BT_STORAGE.set({ aiKeys: cfg.aiKeys });
      refreshAllProviderBadges();
      refreshCurrentUsingBar();

      // 清空上一次的测试结果
      const testResultEl = document.getElementById("aiTestResult");
      if (testResultEl) {
        testResultEl.textContent = "";
        testResultEl.className = "test-result";
      }

      // 此处仅切换编辑中的厂商，实际启用需点击相应按钮。
    });
  }

  const grid = document.getElementById("providerGrid");
  if (grid) {
    grid.querySelectorAll(".provider-item").forEach((item) => {
      item.addEventListener("click", () => {
        const pid = item.dataset.provider;
        if (providerEl) {
          providerEl.value = pid;
          providerEl.dispatchEvent(new Event("change"));
        }
      });
    });
  }

  const keyEl = document.getElementById("openaiKey");
  const baseEl = document.getElementById("openaiBase");
  const modelEl = document.getElementById("openaiModel");

  if (keyEl) keyEl.addEventListener("input", () => {
    setCurrentProviderData({ key: keyEl.value.trim() });
    save();
    refreshAllProviderBadges();
    refreshCurrentUsingBar();
  });
  if (baseEl) baseEl.addEventListener("input", () => {
    setCurrentProviderData({ base: baseEl.value.trim() });
    save();
  });
  if (modelEl) modelEl.addEventListener("input", () => {
    setCurrentProviderData({ model: modelEl.value.trim() });
    save();
  });

  const toggle = document.querySelector(".service-detail-view .toggle-pwd");
  if (toggle && keyEl) {
    toggle.addEventListener("click", () => {
      if (keyEl.type === "password") { keyEl.type = "text"; toggle.textContent = "🙈"; }
      else { keyEl.type = "password"; toggle.textContent = "👁"; }
    });
  }

  const setBtn = document.getElementById("setCurrentBtn");
  if (setBtn) {
    setBtn.addEventListener("click", async () => {
      const pid = editingProvider;
      if (!pid || !isProviderConfigured(pid)) return;

      const data = readProviderInputs();
      if (!cfg.aiKeys) cfg.aiKeys = {};
      cfg.aiKeys[pid] = data;

      try {
        // 授权完成前不切换正式使用的服务。
        setBtn.disabled = true;
        await window.BT_AI_ACCESS.request(pid, data);
      } catch (error) {
        showSaveTip("✗ " + error.message);
        return;
      } finally {
        setBtn.disabled = false;
      }

      cfg.aiProvider = pid;
      cfg.engine = "ai";

      await window.BT_STORAGE.set({
        aiProvider: pid,
        aiKeys: cfg.aiKeys,
        engine: "ai"
      });

      refreshAllProviderBadges();
      refreshCurrentUsingBar();
      renderEngineSelect();
      showSaveTip(`✓ 已切换为 ${(PROVIDERS[pid] || {}).name || pid}`);
    });
  }

  const btn = document.getElementById("testAI");
  if (btn) btn.addEventListener("click", () => runTest("ai", "aiTestResult", btn));
}

/**
 * 切换正在编辑的厂商，刷新输入框和相关状态说明。
 */
function updateProviderUI(providerId) {
  const p = PROVIDERS[providerId] || PROVIDERS.custom;
  const keyHintEl = document.getElementById("keyHint");
  const modelHintEl = document.getElementById("modelHint");
  if (keyHintEl) {
    keyHintEl.textContent = providerId === "ollama"
      ? "Ollama 本地运行，无需填写 Key"
      : "在对应平台申请 API Key";
  }
  if (modelHintEl) {
    modelHintEl.textContent = providerId === "custom"
      ? "手动填写模型名称"
      : `推荐：${p.model}`;
  }
}

/**
 * 更新厂商选择网格中的选中状态。
 */
function updateProviderGrid(providerId) {
  const grid = document.getElementById("providerGrid");
  if (!grid) return;
  grid.querySelectorAll(".provider-item").forEach((item) => {
    item.classList.toggle("active", item.dataset.provider === providerId);
  });
}

/**
 * 用固定样例测试所选服务并显示结果；按钮状态在请求结束后恢复。
 */
async function runTest(engine, resultId, btn) {
  const resultEl = document.getElementById(resultId);
  if (!resultEl) return;
  const testPid = editingProvider || cfg.aiProvider || "openai";
  let testConfig;
  btn.disabled = true;
  resultEl.textContent = "测试中…";
  resultEl.className = "test-result";
  try {
    if (engine === "ai") {
      const pid = testPid;
      const current = readProviderInputs();
      testConfig = { ...current };
      if (pid !== "ollama" && !current.key) {
        throw new Error("请先为「" + ((PROVIDERS[pid] || {}).name || pid) + "」填写 API Key");
      }
      // 先读取当前表单并请求域名授权，拒绝授权时不发送翻译请求。
      await window.BT_AI_ACCESS.request(pid, current);
      if (!cfg.aiKeys) cfg.aiKeys = {};
      cfg.aiKeys[pid] = current;
    }


    const res = await chrome.runtime.sendMessage({
      action: "TRANSLATE",
      retryManual: true,
      retryToken: String(Date.now()) + ":" + Math.random(),
      engine: engine,
      aiProvider: testPid,
      aiConfig: testConfig || { ...((cfg.aiKeys || {})[testPid] || {}) },
      text: "Hello world",
      from: "en",
      to: "zh-CN"
    });

    if (res && res.ok) {
      resultEl.textContent = `✓ 连接成功：${res.data}`;
      resultEl.className = "test-result ok";

    } else {
      resultEl.textContent = `✗ ${(res && res.error) || "连接失败"}`;
      resultEl.className = "test-result error";
    }
  } catch (e) {
    resultEl.textContent = `✗ ${e.message}`;
    resultEl.className = "test-result error";
  } finally {
    btn.disabled = false;
  }
}

// ---------- 导航 ----------
/**
 * 绑定设置页导航项，切换当前可见的设置区域。
 */
function bindNav() {
  const navItems = document.querySelectorAll(".nav-item");
  const panels = document.querySelectorAll(".tab-panel");
  navItems.forEach((item) => {
    item.addEventListener("click", () => {
      const tab = item.dataset.tab;
      navItems.forEach((n) => n.classList.toggle("active", n === item));
      panels.forEach((p) => p.classList.toggle("active", p.dataset.panel === tab));
      if (tab === "service") closeServiceDetail();
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  });
}

/**
 * 绑定服务详情的返回操作。
 */
function bindBackButton() {
  const btn = document.getElementById("backToServices");
  if (btn) btn.addEventListener("click", closeServiceDetail);
}

// ---------- 字段绑定 ----------
/**
 * 绑定语言、显示方式和行为表单，使修改写入配置并保存。
 */
function bindFields() {
  const engineEl = document.getElementById("engine");
  if (engineEl) {
    engineEl.addEventListener("change", () => {
      const v = engineEl.value;
      if (!isEngineConfigured(v)) {
        showSaveTip("该引擎未配置，请先到翻译服务填写密钥");
        renderEngineSelect();
        return;
      }
      const parsed = selectValueToEngine(v);
      cfg.engine = parsed.engine;
      if (parsed.engine === "ai") cfg.aiProvider = parsed.aiProvider;
      save();
    });
  }

  bindSelect("from", (v) => { cfg.from = v; });
  bindSelect("to", (v) => { cfg.to = v; });
  bindSelect("concurrency", (v) => { cfg.concurrency = v; });

  const modeSeg = document.getElementById("mode-seg");
  if (modeSeg) {
    modeSeg.querySelectorAll(".seg-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        cfg.mode = btn.dataset.mode;
        setSegment("mode-seg", cfg.mode);
        save();
      });
    });
  }

  bindSwitch("autoTranslate", (on) => { cfg.autoTranslate = on; });
  bindSwitch("hoverPanel", (on) => { cfg.hoverPanel = on; });
  bindSwitch("shortcutTranslate", (on) => { cfg.shortcutTranslate = on; });

  const modeEl = document.getElementById("hoverTranslateMode");
  if (modeEl) {
    modeEl.addEventListener("change", () => {
      setHoverTranslateMode(modeEl.value);
      save();
    });
  }
}

/**
 * 为指定下拉控件注册值变化处理函数。
 */
function bindSelect(id, onChange) {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener("change", () => { onChange(el.value); save(); });
}
/**
 * 为指定开关注册点击处理，更新状态后调用对应配置回调。
 */
function bindSwitch(id, onChange) {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener("click", () => {
    const on = !el.classList.contains("on");
    el.classList.toggle("on", on);
    onChange(on);
    save();
  });
}

// ---------- 行为偏好：折叠 / 恢复默认 / 快捷键设置按钮 ----------
/**
 * 绑定悬停与快捷键等附加行为设置的交互。
 */
function bindBehaviorExtras() {
  const toggle = document.getElementById("guideToggle");
  const body = document.getElementById("guideBody");
  const arrow = document.getElementById("guideArrow");
  if (toggle && body && arrow) {
    toggle.addEventListener("click", () => {
      const isOpen = body.style.display !== "none";
      body.style.display = isOpen ? "none" : "block";
      arrow.textContent = isOpen ? "▶" : "▼";
    });
  }

  const resetBtn = document.getElementById("btnResetDefault");
  if (resetBtn) {
    resetBtn.addEventListener("click", async () => {
      if (!confirm("确定恢复行为偏好为默认值吗？\n\n将重置：自动翻译、悬停翻译、悬浮球菜单、快捷键等。")) return;
      const defaults = {
        autoTranslate: DEFAULT.autoTranslate,
        hoverPanel: DEFAULT.hoverPanel,
        hoverTranslate: DEFAULT.hoverTranslate,
        hoverRequireShift: DEFAULT.hoverRequireShift,
        shortcutTranslate: DEFAULT.shortcutTranslate
      };
      Object.assign(cfg, defaults);
      await window.BT_STORAGE.set(defaults);

      setSwitch("autoTranslate", cfg.autoTranslate);
      setSwitch("hoverPanel", cfg.hoverPanel);
      setSwitch("shortcutTranslate", cfg.shortcutTranslate);
      const modeEl = document.getElementById("hoverTranslateMode");
      if (modeEl) {
        const mode = getHoverTranslateMode();
        modeEl.value = mode;
        updateHoverTranslateHint(mode);
      }
      updateBehaviorSubStates();
      showSaveTip("✓ 已恢复默认");
    });
  }

  document.querySelectorAll(".btn-set-shortcut").forEach((btn) => {
    btn.addEventListener("click", () => {
      chrome.runtime.sendMessage({ action: "OPEN_SHORTCUTS_SETTINGS" });
    });
  });
}

/**
 * 根据主开关状态更新相关子选项是否可用。
 */
function updateBehaviorSubStates() {
  const shortcutList = document.getElementById("shortcutList");
  if (shortcutList) {
    if (!cfg.shortcutTranslate) {
      shortcutList.classList.add("disabled");
    } else {
      shortcutList.classList.remove("disabled");
    }
  }
}

// ---------- 保存 ----------
let saveTimer = null;
/**
 * 延迟 200 毫秒合并连续修改，使用共享存储分流配置与密钥；失败时展示保存失败。
 */
function save() {
  // 合并连续输入产生的保存请求；共享存储层负责将密钥和普通偏好分别保存。
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      await window.BT_STORAGE.set(cfg);
    } catch (error) {
      showSaveTip("✗ 保存失败：" + error.message);
      return;
    }
    showSaveTip();
    if (currentService === null) {
      renderServiceList();
      renderEngineSelect();
    }
  }, 200);
}

/**
 * 创建或更新保存结果提示，并在短暂显示后收起。
 */
function showSaveTip(msg) {
  let tip = document.getElementById("save-tip");
  if (!tip) {
    tip = document.createElement("div");
    tip.id = "save-tip";
    document.body.appendChild(tip);
  }
  tip.textContent = msg || "✓ 已保存";
  tip.classList.add("show");
  if (tip._timer) clearTimeout(tip._timer);
  tip._timer = setTimeout(() => tip.classList.remove("show"), 1400);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync") return;
  let needRender = false;
  for (const k of Object.keys(changes)) {
    if (KEYS.includes(k)) {
      cfg[k] = changes[k].newValue;
      needRender = true;
    }
  }
  if (changes.from) window.BT_CONST.fillLanguageSelect(document.getElementById("from"),"from",cfg.from);
  if (changes.to) window.BT_CONST.fillLanguageSelect(document.getElementById("to"),"to",cfg.to);
  if (needRender && currentService === null) {
    renderEngineSelect();
    renderServiceList();
    updateBehaviorSubStates();
  }
});

window.addEventListener("focus", () => {
  refreshShortcutDisplay();
});

init();
