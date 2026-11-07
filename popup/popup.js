/**
 * 工具栏 Popup 控制面板：与网页内面板共用 core/panel-ui.js 的模板和展示逻辑。
 * Popup 是遥控器：自身只读取本机配置用于渲染，所有翻译与偏好操作
 * 都通过消息转发给当前标签页的内容脚本（业务实现仅存在于 content.js），
 * PDF 与打开阅读器的请求转发给后台。内容脚本不可达时按“不支持”呈现。
 */
(async function () {
  const { MSG, DEFAULTS } = window.BT_CONST;
  const root = document.getElementById("btPanelRoot");
  root.innerHTML = window.BT_PANEL_UI.templateHtml();
  const $ = (sel) => root.querySelector(sel);
  const toast = (msg, type = "info") => window.BT_PANEL_UI.showToast(root, msg, type);

  // 与 content.js reloadConfig 相同键集；凭据只在本页内存中用于可用性判断，不随消息传递。
  const CFG_KEYS = [
    "engine", "aiProvider", "aiKeys", "requestPolicies", "from", "to", "mode",
    "autoTranslate", "hoverPanel", "baiduAppId", "baiduKey", "baiduVerification"
  ];
  let cfg = {};
  async function loadConfig() {
    try { cfg = await window.BT_STORAGE.get(CFG_KEYS) || {}; }
    catch (_) { cfg = {}; }
  }
  await loadConfig();

  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs && tabs[0];
  const tabId = tab && typeof tab.id === "number" ? tab.id : -1;
  const tabUrl = (tab && tab.url) || "";

  /**
   * 顶层地址是否为在线 PDF：仅 http(s) 且路径部分以 .pdf 结尾，查询参数不影响判定。
   * @param {string} url 标签页地址。
   * @returns {boolean} 命中时 Popup 直接进入 PDF 模式，不依赖内容脚本。
   */
  function urlIsPdf(url) {
    try {
      const u = new URL(url);
      return ["http:", "https:"].includes(u.protocol) && /\.pdf$/i.test(u.pathname);
    } catch (_) { return false; }
  }

  /**
   * PDF 展示名兜底：内容脚本未回报名称时从地址解析，与 content.js 规则一致。
   * @param {string} url PDF 地址。
   * @returns {string} 文件名或截断的 host+路径。
   */
  function pdfNameFromUrl(url) {
    try {
      const u = new URL(url);
      const name = decodeURIComponent(u.pathname.split("/").filter(Boolean).pop() || "");
      if (/\.pdf$/i.test(name)) return name;
      const short = u.host + u.pathname;
      return short.length > 40 ? short.slice(0, 37) + "…" : short;
    } catch (_) { return ""; }
  }

  // 先向内容脚本查询状态快照；顶层 PDF 查看器页没有内容脚本，按地址后缀识别。
  let status = null;
  if (tabId >= 0) {
    try { status = await chrome.tabs.sendMessage(tabId, { action: MSG.GET_STATUS }, { frameId: 0 }); }
    catch (_) { status = null; }
  }
  let mode;
  if ((status && status.pdfPage === true) || urlIsPdf(tabUrl)) mode = "pdf";
  else if (status) mode = "web";
  else mode = "unsupported";
  // PDF 模式的设置区隐藏由共享 applyState 处理；灰色禁用态仅用于不支持页面。
  root.classList.toggle("bt-modal-off", mode === "unsupported");

  // 本地乐观覆盖：开关/模式点击后先更新展示，内容脚本确认后由刷新覆盖。
  const local = {};
  let pollTimer = null;

  function pdfSourceUrl() {
    return (status && status.pdfUrl) || tabUrl || "";
  }

  function buildSnapshot() {
    const snapshot = {
      unsupported: mode === "unsupported",
      pdfPage: mode === "pdf",
      pdfName: mode === "pdf" ? ((status && status.pdfName) || pdfNameFromUrl(pdfSourceUrl())) : "",
      autoTranslateSaving: false,
      translating: false, translated: false, cancelRequested: false,
      visibilityPaused: false, pageStarted: false, pagePaused: false,
      backgroundTranslating: false, lastError: "", languageNoticeCount: 0, requestNotice: "",
      engine: cfg.engine || DEFAULTS.engine,
      aiProvider: cfg.aiProvider || DEFAULTS.aiProvider,
      aiKeys: cfg.aiKeys || {}, requestPolicies: cfg.requestPolicies || {},
      baiduAppId: cfg.baiduAppId || "", baiduKey: cfg.baiduKey || "",
      baiduVerification: cfg.baiduVerification ?? null,
      from: cfg.from || DEFAULTS.from, to: cfg.to || DEFAULTS.to,
      mode: cfg.mode || DEFAULTS.mode,
      autoTranslate: cfg.autoTranslate === true, hoverPanel: cfg.hoverPanel !== false
    };
    if (status) {
      for (const key of ["translating", "translated", "cancelRequested", "visibilityPaused",
        "pageStarted", "pagePaused", "backgroundTranslating", "lastError",
        "languageNoticeCount", "requestNotice", "engine", "aiProvider", "from", "to",
        "mode", "autoTranslate", "hoverPanel"])
        if (status[key] !== undefined) snapshot[key] = status[key];
    }
    return Object.assign(snapshot, local);
  }

  function render() {
    window.BT_PANEL_UI.applyState(root, buildSnapshot());
  }

  /**
   * 向当前标签页内容脚本发送指令并等待回执。
   * @param {Object} message 含 action 的指令。
   * @returns {Promise<boolean>} 是否收到 ok 回执；不可达时提示由调用方决定。
   */
  async function sendTab(message) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, message, { frameId: 0 });
      return !!(response && response.ok);
    } catch (_) { return false; }
  }

  /** 网页模式动作统一入口：失败提示页面未响应，成功后延时刷新任务状态。 */
  function act(message) {
    if (mode !== "web") return;
    sendTab(message).then((ok) => {
      if (!ok) { toast("页面未响应，请刷新页面后重试", "warn"); return; }
      setTimeout(refreshStatus, 250);
    });
  }

  async function refreshStatus() {
    if (mode !== "web") return;
    try {
      const next = await chrome.tabs.sendMessage(tabId, { action: MSG.GET_STATUS }, { frameId: 0 });
      // 内容脚本回报是权威状态；清掉乐观覆盖，保存失败时回滚才能如实显示。
      if (next) { status = next; for (const key of Object.keys(local)) delete local[key]; }
    } catch (_) { /* 页面可能已导航；保留上次快照展示 */ }
    render();
    schedulePoll();
  }

  // 仅在任务进行中轮询；空闲时只由用户操作触发刷新，Popup 关闭即停止。
  function schedulePoll() {
    clearTimeout(pollTimer);
    if (mode === "web" && status && (status.translating || status.cancelRequested))
      pollTimer = setTimeout(refreshStatus, 1000);
  }

  /** 打开 PDF 阅读器：带地址时为当前 PDF 入口，空地址打开空白阅读页。 */
  function openReader(url) {
    try {
      chrome.runtime.sendMessage({ action: MSG.OPEN_PDF_READER, url }, () => {
        void chrome.runtime.lastError;
        window.close();
      });
    } catch (_) { window.close(); }
  }

  $(".bt-modal-close").onclick = () => window.close();
  $("#btModalTranslate").onclick = () => act({ action: MSG.START_TRANSLATION, force: true });
  $("#btModalCancel").onclick = () => act({ action: MSG.CANCEL_TRANSLATION });
  $("#btModalOpenPdf").onclick = () => openReader(pdfSourceUrl());
  $("#btModalOpenPdfAny").onclick = () => openReader("");
  $("#btModalOpenPdfAny").onkeydown = (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openReader(""); }
  };

  $("#btModalEngine").onchange = (e) => {
    const v = e.target.value;
    const serviceConfig = {
      aiProvider: cfg.aiProvider || DEFAULTS.aiProvider, aiKeys: cfg.aiKeys || {},
      baiduAppId: cfg.baiduAppId || "", baiduKey: cfg.baiduKey || "",
      baiduVerification: cfg.baiduVerification ?? null
    };
    if (!window.BT_SERVICES.isConfigured(v, serviceConfig)) {
      toast(v === "baidu" ? "请先到设置页测试百度连接，成功后再选择" : "该引擎未配置，请先到设置页填写密钥", "warn");
      render();
      return;
    }
    const parsed = window.BT_SERVICES.parse(v, serviceConfig.aiProvider);
    const changes = parsed.engine === "ai" ? parsed : { engine: parsed.engine };
    local.engine = changes.engine;
    if (changes.aiProvider) local.aiProvider = changes.aiProvider;
    render();
    act({ action: MSG.PANEL_SETTING_CHANGE, changes });
  };
  $("#btModalFrom").onchange = (e) => {
    local.from = e.target.value; render();
    act({ action: MSG.PANEL_SETTING_CHANGE, changes: { from: e.target.value } });
  };
  $("#btModalTo").onchange = (e) => {
    local.to = e.target.value; render();
    act({ action: MSG.PANEL_SETTING_CHANGE, changes: { to: e.target.value } });
  };

  $("#btModalModeSeg").querySelectorAll(".bt-modal-seg-btn").forEach((btn) => {
    btn.onclick = () => {
      if (mode !== "web") return;
      local.mode = btn.dataset.mode;
      render();
      act({ action: MSG.PANEL_MODE_CHANGE, mode: btn.dataset.mode });
    };
  });

  $("#btModalAuto").onclick = () => {
    if (mode !== "web") return;
    const enabled = !buildSnapshot().autoTranslate;
    local.autoTranslate = enabled;
    render();
    sendTab({ action: MSG.PANEL_TOGGLE_PREF, key: "autoTranslate", value: enabled }).then((ok) => {
      if (!ok) {
        delete local.autoTranslate;
        toast("页面未响应，请刷新页面后重试", "warn");
        render();
        return;
      }
      setTimeout(refreshStatus, 300);
    });
  };
  $("#btModalHover").onclick = () => {
    if (mode !== "web") return;
    const enabled = !buildSnapshot().hoverPanel;
    local.hoverPanel = enabled;
    render();
    sendTab({ action: MSG.PANEL_TOGGLE_PREF, key: "hoverPanel", value: enabled }).then((ok) => {
      if (!ok) {
        delete local.hoverPanel;
        toast("页面未响应，请刷新页面后重试", "warn");
        render();
        return;
      }
      setTimeout(refreshStatus, 300);
    });
  };

  $("#btModalSettings").onclick = () => {
    chrome.runtime.sendMessage({ action: MSG.OPEN_SETTINGS }, () => {
      void chrome.runtime.lastError;
      window.close();
    });
  };

  // Popup 打开期间同步其他页面（设置页/网页内面板）落盘的配置变化，保持两个面板展示一致。
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync" && area !== "local") return;
    if (!CFG_KEYS.some((key) => Object.prototype.hasOwnProperty.call(changes, key))) return;
    loadConfig().then(render);
  });

  render();
  schedulePoll();
})();
