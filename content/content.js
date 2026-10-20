// ============================================================
// 页知译 · 网页双语翻译：网页内容脚本
// ============================================================

if (window.__BT_INJECTED) {
  // 已注入，跳过
} else {
  window.__BT_INJECTED = true;
  init();
}

/**
 * 初始化当前页面的翻译状态、消息监听、悬浮球和动态内容观察器。
 */
function init() {
  const { MSG } = window.BT_CONST;
  // 调试日志不参与翻译状态处理；失败原因始终由页面面板展示。
  /**
   * 仅在共享 DEBUG 开关开启时输出调试信息；不改变翻译状态。
   */
  function debugLog(...args) {
    if (window.BT_CONST.DEBUG) console.debug(...args);
  }
  const AI_PROVIDER_NAMES = window.AI_PROVIDER_NAMES;

  // 页面级运行状态：取消只暂停当前页面，不修改用户的全局自动翻译偏好。
  const STATE = {
    translating: false,
    backgroundTranslating: false,
    translated: false,
    cancelRequested: false,
    pagePaused: false,
    pageStarted: false,
    cancelVersion: 0,
    activeWorkers: 0,
    lastError: "",
    failedCount: 0,
    languageNoticeCount: 0,
    engine: "google",
    aiProvider: "openai",
    from: window.BT_CONST.DEFAULTS.from,
    to: window.BT_CONST.DEFAULTS.to,
    concurrency: 4,
    processedAttr: "data-bt-processed",
    mode: "bilingual",
    autoTranslate: false,
    hoverPanel: true,
    viewportFirst: true,
    hoverTranslate: true,
    hoverRequireShift: true,
    shortcutTranslate: true,
    shortcutKey: "Alt+A",
    baiduAppId: "",
    baiduKey: "",
    baiduVerification: null,
    aiKeys: {}
  };

  let requestToken = "page-" + Date.now() + "-" + Math.random();
  const pendingMessages = new Set();
  const pendingPreferenceWrites = new Map();
  let resumeAfterSettingsChange = false;
  let autoTranslateSaving = false;
  // 旧配置读取不能覆盖用户刚刚修改的自动翻译开关。
  let autoPreferenceVersion = 0;
  /**
   * 将语言识别限制与真正的请求失败分开记录；提示仅由控制面板呈现。
   */
  function recordTranslationIssue(error) {
    if (error.code === "NEED_SOURCE_LANGUAGE") STATE.languageNoticeCount++;
    else { STATE.lastError = error.message; STATE.failedCount++; }
    if (!STATE.backgroundTranslating || !STATE.translating) setFabTranslated(STATE.translated);
    if (panelModalEl) refreshPanelModal();
  }

  /**
   * 创建 AbortError，供请求链区分主动取消与真正的接口失败。
   */
  function cancelledError() {const error=new Error("翻译已取消");error.name="AbortError";return error;}
  /**
   * 在配置变化前取消旧批次，记录是否需要恢复翻译及当前任务版本。
   */
  function interruptForConfigChange() {
    const wasPaused=STATE.pagePaused;
    const resume = resumeAfterSettingsChange || (!STATE.pagePaused && (STATE.translating || STATE.translated || STATE.pageStarted || STATE.autoTranslate));
    cancelTranslation();
    resumeAfterSettingsChange=resume;
    return {resume,wasPaused,version:STATE.cancelVersion};
  }
  /**
   * 保存单个引擎或语言选项；通过版本号避免连续切换时旧任务覆盖新选择。
   */
  async function changeTranslationSetting(key,value) {
    if(STATE[key]===value)return;
    const previous=STATE[key],interrupted=interruptForConfigChange(),entry={value};
    pendingPreferenceWrites.set(key,entry);STATE[key]=value;
    try {await saveField(key,value);}
    catch(error) {
      if(interrupted.version===STATE.cancelVersion){STATE[key]=previous;STATE.lastError="保存设置失败："+error.message;refreshPanelModal();}
      return;
    } finally {if(pendingPreferenceWrites.get(key)===entry)pendingPreferenceWrites.delete(key);}
    if(interrupted.version!==STATE.cancelVersion)return;
    resumeAfterSettingsChange=false;
    if(interrupted.resume)await translatePage();
    else if(!interrupted.wasPaused)STATE.pagePaused=false;
    if(panelModalEl)refreshPanelModal();
  }

  // ---------- 接收消息 ----------
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    switch (request.action) {
      case MSG.START_TRANSLATION: translatePage(); break;
      case MSG.CANCEL_TRANSLATION: cancelTranslation(); break;
      case MSG.TOGGLE_PANEL: toggleTranslation(); break;
      case MSG.OPEN_PANEL: openControlPanel(); break;
      case MSG.TRANSLATE_SELECTION: translateSelection(request.text); break;
      case MSG.GET_STATUS:
        sendResponse({ translated: STATE.translated, translating: STATE.translating });
        return true;
      case MSG.RELOAD_CONFIG: reloadConfig(); break;
    }
  });

  // 同时监听同步偏好和本机密钥变化，使网页、设置页与控制面板保持一致。
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync" && area !== "local") return;
    // 本页连续选择设置时，忽略尚在落盘的旧值事件，防止把最新选择当成外部改动取消。
    changes=Object.fromEntries(Object.entries(changes).filter(([key])=>!pendingPreferenceWrites.has(key)));
    if(!Object.keys(changes).length)return;
    const relevant = ["engine", "aiProvider", "aiKeys", "from", "to", "mode", "autoTranslate", "hoverPanel", "concurrency", "baiduAppId", "baiduKey", "baiduVerification", "hoverTranslate", "hoverRequireShift", "shortcutTranslate", "shortcutKey"];
    if (!relevant.some((key) => Object.prototype.hasOwnProperty.call(changes, key))) return;
    const affecting = ["engine","aiProvider","aiKeys","from","to","baiduAppId","baiduKey"];
    const changed = affecting.some(key => Object.prototype.hasOwnProperty.call(changes,key) &&
      JSON.stringify(changes[key].newValue) !== JSON.stringify(STATE[key]));
    if (area === "sync" && changes.autoTranslate) {
      autoPreferenceVersion++;
      STATE.autoTranslate = changes.autoTranslate.newValue === true;
      if (!STATE.autoTranslate) stopAutomaticStart();
    }
    const interrupted = changed ? interruptForConfigChange() : null;
    reloadConfig().then(async () => {
      if(interrupted && interrupted.version===STATE.cancelVersion) {
        resumeAfterSettingsChange=false;
        if(interrupted.resume)await translatePage();
        else if(!interrupted.wasPaused)STATE.pagePaused=false;
      }
      if (panelModalEl) refreshPanelModal();
    }).catch((err) => console.warn("[双语翻译] 配置同步失败：", err));
  });

  /**
   * 合并同步区与本机配置，并以尚未完成的本页写入为准更新 STATE。
   */
  async function reloadConfig() {
    const autoVersion = autoPreferenceVersion;
    const cfg = await window.BT_STORAGE.get([
      "engine", "aiProvider", "aiKeys", "from", "to", "mode",
      "autoTranslate", "hoverPanel", "concurrency",
      "baiduAppId", "baiduKey", "baiduVerification",
      "hoverTranslate", "hoverRequireShift", "shortcutTranslate", "shortcutKey"
    ]);
    for(const [key,entry] of pendingPreferenceWrites)cfg[key]=entry.value;
    if (cfg.engine) STATE.engine = cfg.engine;
    if (cfg.aiProvider) STATE.aiProvider = cfg.aiProvider;
    if (cfg.aiKeys) STATE.aiKeys = cfg.aiKeys;
    if (cfg.from) STATE.from = cfg.from;
    if (cfg.to) STATE.to = cfg.to;
    const modeChanged = cfg.mode && cfg.mode !== STATE.mode;
    if (cfg.mode) STATE.mode = cfg.mode;
    if (typeof cfg.autoTranslate === "boolean" && autoVersion === autoPreferenceVersion) {
      STATE.autoTranslate = cfg.autoTranslate;
      if (!STATE.autoTranslate) stopAutomaticStart();
    }
    if (typeof cfg.hoverPanel === "boolean") STATE.hoverPanel = cfg.hoverPanel;
    if (cfg.concurrency != null) {
      // 限制并发范围，避免异常配置创建过多翻译任务。
      STATE.concurrency = Math.min(10, Math.max(1, Number(cfg.concurrency) || 4));
    }
    STATE.baiduAppId = cfg.baiduAppId || "";
    STATE.baiduKey = cfg.baiduKey || "";
    STATE.baiduVerification = cfg.baiduVerification || null;
    if (typeof cfg.hoverTranslate === "boolean") STATE.hoverTranslate = cfg.hoverTranslate;
    if (typeof cfg.hoverRequireShift === "boolean") STATE.hoverRequireShift = cfg.hoverRequireShift;
    if (typeof cfg.shortcutTranslate === "boolean") STATE.shortcutTranslate = cfg.shortcutTranslate;
    if (cfg.shortcutKey) STATE.shortcutKey = cfg.shortcutKey;
    if (modeChanged) applyMode();
  }

  /**
   * 等待配置刷新完成，确保发起翻译时使用最新的语言和服务配置。
   */
  async function loadConfig() { await reloadConfig(); }

  // ---------- 引擎配置状态 ----------
  /**
   * 检查当前引擎所需凭据是否齐全；此检查不代表网络或密钥一定有效。
   */
  function isEngineConfigured(id) {
    if (id === "google" || id === "mymemory") return true;
    if (id === "baidu") return window.BT_CONST.hasVerifiedBaiduCredentials(STATE);
    if (id === "ai") {
      if (STATE.aiProvider === "ollama") return true;
      const keys = (STATE.aiKeys && STATE.aiKeys[STATE.aiProvider]) || {};
      return !!keys.key;
    }
    return false;
  }

  /**
   * 将内部引擎标识转换为面板使用的服务名称。
   */
  function getEngineLabel(id) {
    if (id === "google") return "Google（免费）";
    if (id === "mymemory") return "MyMemory（免费）";
    if (id === "baidu") return "百度翻译";
    if (id === "ai") {
      const name = AI_PROVIDER_NAMES[STATE.aiProvider] || STATE.aiProvider;
      return `AI 大模型（${name}）`;
    }
    return id;
  }

  // ---------- 请求翻译 ----------
  /**
   * 向后台申请翻译，携带批次标识；MyMemory 长文本按 UTF-8 字节拆分，取消后忽略迟到响应。
   *
   * @param {string} text 待翻译的原文。
   * @param {Object} config 本轮配置快照，包含引擎、语言和任务版本。
   * @returns {Promise<string>} 译文；取消或失败时拒绝。
   */
  function requestTranslate(text, config = STATE) {
    const generation=config.cancelVersion ?? STATE.cancelVersion;
    const token=config.runToken || requestToken;
    if(generation!==STATE.cancelVersion || token!==requestToken)return Promise.reject(cancelledError());
    if (config.engine === "mymemory" && new TextEncoder().encode(text).length > 480) {
      const snapshot = {...config,cancelVersion:generation,runToken:token};
      return splitText(text,480,480).reduce(
        (pending,part) => pending.then(async parts => [...parts,await requestTranslate(part,snapshot)]),
        Promise.resolve([])
      ).then(parts => parts.join(" "));
    }
    return new Promise((resolve,reject)=>{
      let settled=false;
      const task={reject:error=>finish(error)};
      /**
       * 结束当前消息请求并移除待处理记录，避免同一个 Promise 被重复结算。
       */
      function finish(error,data) {
        if(settled)return;settled=true;pendingMessages.delete(task);
        error?reject(error):resolve(data);
      }
      pendingMessages.add(task);
      try {
        chrome.runtime.sendMessage(
          {action:"TRANSLATE",runToken:token,engine:config.engine,aiProvider:config.aiProvider,aiConfig:config.aiConfig,
            retryManual:config.retryManual===true,retryToken:config.retryToken,text,from:config.from,to:window.BT_CONST.resolveTargetLanguage(config.to)},
          res=>{
            const runtimeError=chrome.runtime.lastError;
            if(settled)return;
            if(generation!==STATE.cancelVersion || token!==requestToken || res?.cancelled)return finish(cancelledError());
            if(runtimeError) {
              const error=new Error("翻译连接中断，请刷新页面或重试");error.code="CONNECTION_INTERRUPTED";return finish(error);
            }
            if(!res||!res.ok){const error=new Error(res?.error||"翻译失败");error.code=res?.code;return finish(error);}
            finish(null,res.data);
          });
      }catch(_){const error=new Error("扩展连接已失效，请刷新页面后重试");error.code="CONNECTION_INTERRUPTED";finish(error);}
    });
  }

  /**
   * 针对中文目标筛掉已是中文的内容，同时保留中日混合及简繁转换的处理机会。
   */
  function isMostlyChinese(text) {
    const target = window.BT_CONST.resolveTargetLanguage(STATE.to);
    if (!target.startsWith("zh")) return false;
    // 显式选择不同中文源语种时，保留简繁转换机会。
    if (STATE.from.startsWith("zh") && STATE.from !== target) return false;
    if (/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(text)) return false;
    const letters = text.match(/\p{L}/gu) || [], han = text.match(/\p{Script=Han}/gu) || [];
    if (!letters.length || !han.length) return false;
    const words = text.match(/[A-Za-z]+/g) || [];
    if (!words.length) return han.length / letters.length > 0.8;
    // 仅放过紧贴汉字的单个英文标识；“Use 中文”等混合句子继续翻译。
    return text.length <= 40 && words.length === 1 && han.length >= 2 &&
      !/\s/u.test(text.trim()) && /^[\p{Script=Han}A-Za-z0-9·._-]+$/u.test(text);
  }

  // 保存原文节点与译文的对应关系，用于切换显示模式、失效检查和取消还原。
  // 记住原文未变化的文字节点，避免动态补翻反复请求相同内容。
  let unchangedTextNodes = new WeakMap();
  let unchangedElements = new WeakMap();
  /**
   * 规范化字符与空白后比较原译文，避免插入没有实际变化的译文。
   */
  function sameTranslation(source, translation) {
    const normalize = value => value.normalize("NFKC").replace(/\s+/gu, "").trim();
    return normalize(source) === normalize(translation);
  }
  const translatedElements = new Map();
  let failureRecords = new WeakMap();
  let pendingRecords = new WeakSet();
  let wholePageScan = true;
  const dirtyRoots = new Set();
  /**
   * 生成包含服务配置和语言的比较标识，使失败记录只作用于同一套翻译配置。
   */
  function requestScope(config = STATE) {
    return JSON.stringify([config.engine,config.engine === "ai" ? config.aiProvider : null,config.engine === "ai" ? (config.aiConfig || (config.aiKeys || {})[config.aiProvider] || {}) : null,config.from,config.to]);
  }
  /**
   * 检查节点是否正在请求或处于失败冷却期；手动翻译允许绕过自动重试限制。
   */
  function eligibleForRequest(item, automatic) {
    const target = item.node || item.el, record = failureRecords.get(target);
    if (pendingRecords.has(target)) return false;
    if (!record || record.text !== item.text || record.scope !== requestScope()) return true;
    return !automatic || (record.attempts < 3 && Date.now() >= record.next);
  }

  const BLOCK_SELECTOR = "p, h1, h2, h3, h4, h5, h6, li, blockquote, td, th, figcaption";
  const FORM_SELECTOR = "label, legend, button, [role='button'], [role='alert'], form small, form .help-text, form .form-text";
  const DIALOG_SELECTOR = "dialog, [role='dialog'], [role='alertdialog'], [aria-modal='true']";
  const TEXT_SELECTOR = "div, span, a, small, strong, em, b, time, dt, dd, summary, dialog, section, form, fieldset, [role='option'], [role='menuitem'], [role='tab'], [role='status'], [role='tooltip']";
  const EXCLUDED_SELECTOR = ".bt-translation-text, .bt-original-text, .bt-text-fragment, .bt-modal, .bt-popup, .bt-fab-wrap, .bt-thumb, .bt-page-notice, pre, code, script, style, noscript, svg, math, canvas, textarea, input, select, [translate='no'], .notranslate, [contenteditable]:not([contenteditable='false'])";

  // 只采集已显示的内容；视口优先开启时，屏幕外内容等待滚动后补翻。
  /**
   * 排除隐藏和无尺寸元素；视口优先模式下只接受当前屏幕内的内容。
   */
  function isVisibleBlock(el) {
    if (el.closest("[hidden], [aria-hidden='true']")) return false;
    const style = window.getComputedStyle(el);
    if (style.visibility === "hidden" || style.visibility === "collapse" || style.display === "none") return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && (!STATE.viewportFirst ||
      (rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth));
  }

  // 优先采集完整文字区域；混合容器则单独采集直接文字节点。
  /**
   * 从指定变动区域或整页收集待翻译文字；混合控件容器只提取直接文本以保护控件。
   *
   * @param {Iterable<Element>} [roots] 仅扫描这些变动区域；省略时扫描整页候选。
   * @returns {Array<Object>} 候选记录，包含元素、原文及可选的直接文字节点。
   */
  function collectBlocks(roots, { hover = false, retryProcessed = false } = {}) {
    // 两个入口共用采集规则；主动悬停仅放宽网页禁译标记，不放宽控件和插件节点保护。
    const excluded = hover ? HOVER_SCAN_EXCLUDED_SELECTOR : EXCLUDED_SELECTOR;
    const selector = BLOCK_SELECTOR + ", " + FORM_SELECTOR + ", " + TEXT_SELECTOR;
    const candidates = new Set();
    if (!roots) document.querySelectorAll(selector).forEach(el => candidates.add(el));
    else for (const root of roots) {
      if (!root || !root.isConnected || root.closest(excluded)) continue;
      if (root.matches(selector)) candidates.add(root);
      root.querySelectorAll(selector).forEach(el => candidates.add(el));
    }
    const result = [];
    const fragments = [];
    for (const el of candidates) {
      if (el.closest(excluded)) continue;
      if (el.hasAttribute(STATE.processedAttr)) {
        // 主动 Shift 可以重新采集没有实际译文的区域；正在请求的节点仍然跳过。
        const retryHover = hover && retryProcessed && !translatedElements.has(el) &&
          !pendingRecords.has(el) && !hoverPendingRecords.has(el);
        if (!retryHover) {
          const previous = unchangedElements.get(el);
          if (previous && (previous.text !== (el.textContent || "").trim() || previous.scope !== requestScope())) {
            unchangedElements.delete(el);el.removeAttribute(STATE.processedAttr);
          } else if (!(hover && el.getAttribute(STATE.processedAttr) === "hover-restored")) continue;
        }
      }
      if (!isVisibleBlock(el)) continue;
      // 混合标签和图标按钮的文字可能直接紧邻控件，只采集文字，不移动控件或图标。
      for (const node of el.childNodes || []) {
        if (node.nodeType !== 3) continue;
        const text = node.textContent.trim();
        const skipped = unchangedTextNodes.get(node);
        if (skipped && skipped.text === text && skipped.scope === requestScope() && !(hover && (retryProcessed || skipped.hoverRestored))) continue;
        if (text.length >= 2 && /\p{L}/u.test(text) && !isMostlyChinese(text)) fragments.push({ el, text, node });
      }
      // 含控件或下级文字块的容器不整体翻译，保护输入值并避免重复处理。
      if (el.querySelector("input, textarea, select, [contenteditable]:not([contenteditable='false'])")) continue;
      if (el.querySelector(BLOCK_SELECTOR + ", " + FORM_SELECTOR)) continue;
      // 排除包含下级布局块的容器，避免把整列或整张卡片当成一个段落。
      if (el.querySelector("div, dl, dt, dd, section, article, aside, ul, ol, table, svg, img, pre, code")) continue;
      const style = window.getComputedStyle(el);
      if (/flex|grid/.test(style.display) && el.children.length) continue;
      if (el.querySelector(hover ? "[hidden], [aria-hidden='true'], .bt-text-fragment" :
          "[hidden], [aria-hidden='true'], [translate='no'], .notranslate, .bt-text-fragment")) continue;
      const text = (el.textContent || "").trim();
      if (text.length < 2 || !/\p{L}/u.test(text) || isMostlyChinese(text)) continue;
      result.push({ el, text });
    }
    // 已选中完整文字区域时，跳过其内部节点，避免同一句话被重复翻译。
    const selected = new Set(result.map(item => item.el));
    const hasSelectedAncestor = el => {
      for (let parent = el.parentElement; parent; parent = parent.parentElement) {
        if (selected.has(parent)) return true;
      }
      return false;
    };
    return [...result.filter(({ el }) => !hasSelectedAncestor(el)),
      ...fragments.filter(({ el }) => !selected.has(el) && !hasSelectedAncestor(el))];
  }

  /**
   * 按元素与视口的关系排列候选内容，优先处理用户当前能看到的区域。
   */
  function sortByViewport(blocks) {
    if (!STATE.viewportFirst) return blocks;
    const vh = window.innerHeight;
    const scored = blocks.map((b) => {
      const rect = b.el.getBoundingClientRect();
      let score;
      if (rect.bottom >= 0 && rect.top <= vh) score = Math.abs(rect.top);
      else if (rect.top > vh) score = 1e6 + rect.top;
      else score = 1e7 + Math.abs(rect.top);
      return { ...b, _score: score };
    });
    scored.sort((a, b) => a._score - b._score);
    return scored;
  }

  // ---------- 主流程 ----------
  /**
   * 启动一轮翻译：读取配置、收集候选、并发处理并汇总状态；每个异步阶段均校验任务版本。
   *
   * @param {boolean} force 是否强制重新翻译。
   * @param {boolean} automatic 是否由动态补翻触发，用于应用自动重试限制。
   * @returns {Promise<void>} 本轮调度完成后结束。
   */
  async function translatePage(force = false, automatic = false) {
    // 自动任务不能解除用户暂停；只有手动翻译入口可以恢复当前页面。
    if (automatic && ((!STATE.pageStarted && !STATE.autoTranslate) || STATE.pagePaused || STATE.cancelRequested)) return;
    if (STATE.translating) {
      if (automatic || !STATE.backgroundTranslating) return;
      // 用户手动重译优先于局部补翻；取消旧批次后按新批次重新开始。
      cancelTranslation();
    }
    STATE.backgroundTranslating = automatic && STATE.translated;
    STATE.pagePaused = false;
    // 手动点击立即建立当前页会话；首次自动启动须等最新配置确认，避免关闭开关后迟到启动。
    if (!automatic) STATE.pageStarted = true;
    if (force && STATE.translated) {
      clearTranslations();
      setFabTranslated(false);
    }
    if (!automatic) {
      failureRecords = new WeakMap();
      STATE.lastError = ""; STATE.failedCount = 0; STATE.languageNoticeCount = 0;
      // 重试开始即同步清除旧错误外观，不能等到新请求完成才刷新。
      setFabTranslated(STATE.translated);
      wholePageScan = true;
    }
    const generation = STATE.cancelVersion;
    STATE.translating = true;
    STATE.cancelRequested = false;
    STATE.activeWorkers = 0;
    // 自动扫描确认有新内容后才更新忙碌界面，避免空扫描造成按钮闪烁。
    if (!automatic) { setFabBusy(true); setFabTranslated(STATE.translated); hidePageNotice(); }
    const issuesBefore = STATE.failedCount + STATE.languageNoticeCount;

    try { await loadConfig(); } catch (error) {
      if(generation!==STATE.cancelVersion)return;
      STATE.translating = false;
      STATE.lastError = "读取配置失败：" + error.message;
      setFabBusy(false);
      if (!panelModalEl) openControlPanel();
      refreshPanelModal();
      return;
    }
    if(generation!==STATE.cancelVersion)return;
    // 读取配置期间也可能点击取消，此时不再采集文字或发起请求。
    if (STATE.cancelRequested || STATE.pagePaused || (automatic && !STATE.pageStarted && !STATE.autoTranslate)) {
      STATE.translating = false;
      setFabBusy(false);
      return;
    }
    STATE.pageStarted = true;
    // 固定本轮配置，防止请求过程中更改设置导致同一批次混用服务或语言。
    const runConfig = { engine: STATE.engine, from: STATE.from, to: STATE.to,
      cancelVersion:generation,runToken:requestToken,
      retryManual: !automatic,
      retryToken: automatic ? undefined : String(Date.now()) + ":" + Math.random(),
      aiProvider: STATE.aiProvider,
      aiConfig: { ...((STATE.aiKeys || {})[STATE.aiProvider] || {}) } };

    const roots = wholePageScan || !dirtyRoots.size ? null : [...dirtyRoots];
    wholePageScan = false; dirtyRoots.clear();
    const rawBlocks = collectBlocks(roots).filter(item => eligibleForRequest(item, automatic));
    if (rawBlocks.length === 0) {
      debugLog("[双语翻译] 未找到可翻译内容");
      STATE.translating = false;
      if (!automatic) setFabBusy(false);
      setFabTranslated(STATE.translated);
      return;
    }

    // 确认有待翻译内容后才显示忙碌，后台补翻同样需要旋转；空扫描保持原状态。
    if (automatic) setFabBusy(true);
    const blocks = sortByViewport(rawBlocks);
    const total = blocks.length;
    const workerCount = Math.min(10, Math.max(1, Number(STATE.concurrency) || 4));

    debugLog(`[双语翻译] 开始：共 ${total} 段，并发 ${workerCount}`);

    let done = 0, succeeded = 0, failed = 0, skipped = 0;
    const queue = [...blocks];
    const workers = Array.from({ length: workerCount }, () => worker());

    /**
     * 消费本轮共享待翻译列表；取消或任务版本变化时停止领取后续内容。
     */
    async function worker() {
      STATE.activeWorkers++;
      while (queue.length) {
        if (STATE.cancelRequested || generation!==STATE.cancelVersion) break;
        const item = queue.shift();
        if (!item) break;
        const result = await handleBlock(item, runConfig);
        if (result === true) succeeded++;
        else if (result === "skipped") skipped++;
        else if (!STATE.cancelRequested) failed++;
        done++;
        if (done % 5 === 0 || done === total) {
          debugLog(`[双语翻译] 进度 ${done}/${total}`);
        }
      }
      if(generation===STATE.cancelVersion)STATE.activeWorkers--;
    }

    await Promise.all(workers);
    if(generation!==STATE.cancelVersion)return;

    STATE.translating = false;
    STATE.translated = translatedElements.size > 0 && !STATE.cancelRequested;
    setFabBusy(false);
    setFabTranslated(STATE.translated);

    if (STATE.cancelRequested) {
      debugLog(`[双语翻译] 已取消`);
    } else {
      debugLog(`[双语翻译] 完成：成功 ${succeeded} 段，跳过 ${skipped} 段，失败 ${failed} 段`);
    }
    if (!STATE.pagePaused && STATE.failedCount + STATE.languageNoticeCount > issuesBefore) showPageNotice();
    if (failed && !automatic && !STATE.pagePaused) {
      if (!panelModalEl) openControlPanel();

    }
    if (!automatic && STATE.languageNoticeCount && !panelModalEl) openControlPanel();
    if (panelModalEl) refreshPanelModal();
    if (pendingViewport) {
      pendingViewport = false;
      scheduleVisibleTranslation();
    }
  }

  // ---------- 单段处理 ----------
  /**
   * 处理单个文字块，分段请求并插入结果；记录失败冷却且不将主动取消计为失败。
   */
  async function handleBlock({ el, text, node }, config) {
    const generation=config.cancelVersion ?? STATE.cancelVersion;
    if (STATE.cancelRequested || generation!==STATE.cancelVersion) return "skipped";

    const target = node || el;
    const pendingSet=pendingRecords;
    if (pendingSet.has(target)) return "skipped";
    pendingSet.add(target);
    if (!node) el.setAttribute(STATE.processedAttr, "1");
    const chunks = splitText(text, 480, config.engine === "mymemory" ? 480 : Infinity);
    try {
      const parts = [];
      for (const c of chunks) {
        if (STATE.cancelRequested || generation!==STATE.cancelVersion) return "skipped";
        parts.push(await requestTranslate(c, config));
      }
      if(generation!==STATE.cancelVersion)return "skipped";
      if (STATE.cancelRequested) { el.removeAttribute(STATE.processedAttr); return false; }

      if (config.hover && (el.closest(HOVER_EXCLUDED_SELECTOR) || !isVisibleBlock(el))) {
        el.removeAttribute(STATE.processedAttr);
        return "skipped";
      }
      const translation = parts.join(" ");
      if (!translation.trim()) {
        el.removeAttribute(STATE.processedAttr);
        return false;
      }
      // 单页应用可能在请求返回前复用节点；原文已变化时丢弃旧结果并安排补翻。
      if (!el.isConnected || (node ? node.parentNode !== el || node.textContent.trim() !== text : (el.textContent || "").trim() !== text)) {
        el.removeAttribute(STATE.processedAttr);
        pendingViewport = true;
        return false;
      }
      // 返回内容与原文相同时，不再叠加一份文字。
      if (sameTranslation(text, translation)) {
        if (node) unchangedTextNodes.set(node, { text, scope: requestScope(config) });
        else {
          el.setAttribute(STATE.processedAttr, "unchanged");
          unchangedElements.set(el,{text,scope:requestScope(config)});
        }
        return "skipped";
      }
      failureRecords.delete(target);
      if (node) {
        const fragment = document.createElement("span");
        fragment.className = "bt-text-fragment";
        el.insertBefore(fragment, node);
        fragment.appendChild(node);
        insertTranslation(fragment, translation, config.hover === true);
        if (config.hover) fragment.setAttribute(STATE.processedAttr, "hover");
      } else {
        insertTranslation(el, translation, config.hover === true);
        if (config.hover) el.setAttribute(STATE.processedAttr, "hover");
      }
      return true;
    } catch (e) {
      if(e.name==="AbortError" || generation!==STATE.cancelVersion)return "skipped";
      if (!STATE.cancelRequested) {
        const old = failureRecords.get(target);
        const same = old && old.text === text && old.scope === requestScope(config);
        const attempts = same ? old.attempts + 1 : 1;
        failureRecords.set(target,{text,scope:requestScope(config),attempts,next:e.code==="NEED_SOURCE_LANGUAGE"?Infinity:Date.now()+30000*Math.pow(2,attempts-1)});
        recordTranslationIssue(e);
      }
      el.removeAttribute(STATE.processedAttr);
      return e.code === "NEED_SOURCE_LANGUAGE" ? "skipped" : false;
    } finally {
      pendingSet.delete(target);
    }
  }

  /**
   * 在原文附近挂载译文并保存还原记录；导航等紧凑区域使用行内样式。
   */
  function insertTranslation(el, translation, isHover = false) {
    if (STATE.cancelRequested && !isHover) return;
    if (!el.isConnected) return;
    // 将译文放在原文字块内部，避免新增同级节点破坏网格、弹性布局、表格或列表。
    if (translatedElements.has(el)) return;
    const original = document.createElement("span");
    original.className = "bt-original-text";
    original.style.display = "contents";
    while (el.firstChild) original.appendChild(el.firstChild);
    const wrapper = document.createElement("span");
    wrapper.className = "bt-translation-text" + (isHover ? " bt-hover-translation" : "");
    wrapper.textContent = translation;
    wrapper.setAttribute("translate", "no");
    const display=window.getComputedStyle(el).display;
    if(display==="inline" || el.classList.contains("bt-text-fragment") ||
       el.closest("nav, [role='navigation'], aside, [role='menu']"))wrapper.classList.add("bt-translation-inline");
    const compact = el.matches && (el.matches(FORM_SELECTOR + ", td, th") || !!el.closest("form, " + DIALOG_SELECTOR));
    if (compact) wrapper.classList.add("bt-translation-compact");
    // 继承所在区域的文字颜色，兼容同一页面上的浅色和深色卡片。
    wrapper.style.color = "inherit";
    wrapper.style.background = "transparent";
    // 按钮等紧凑控件采用行内译文，尽量减少额外高度并保留原始文字。
    if (el.matches && (el.matches("button, [role='button'], summary, [role='tab'], [role='menuitem'], [role='option']") ||
        el.closest("button, [role='button'], summary, [role='tab'], [role='menuitem'], [role='option']"))) wrapper.classList.add("bt-translation-control");
    el.appendChild(original);
    el.appendChild(wrapper);
    translatedElements.set(el, { wrapper, original, sourceText: (original.textContent || "").trim() });
    applyEntryMode(translatedElements.get(el));
  }

  /**
   * 根据双语或仅译文模式切换单条记录的原文显示状态。
   */
  function applyEntryMode(entry) {
    const hide = STATE.mode === "translation-only" && !entry.wrapper.classList.contains("bt-hover-translation");
    entry.original.style.display = hide ? "none" : "contents";
    // 隐藏原文时去掉双语段落间距，切回双语时恢复上下留白。
    entry.wrapper.classList.toggle("bt-translation-only", hide);
  }

  /**
   * 将当前显示模式应用到所有已经插入的翻译记录。
   */
  function applyMode() {
    for (const [el, entry] of translatedElements) {
      if (!entry.wrapper.isConnected) continue;
      applyEntryMode(entry);
    }
  }

  // 按接口长度限制分块，优先在词句边界截断，并避免拆开表情等字符的代理对。
  /**
   * 按字符数及可选 UTF-8 字节上限拆分文本，避免切断 Unicode 字符。
   *
   * @param {string} text 待拆分文本。
   * @param {number} maxLen 单段字符长度上限。
   * @param {number} maxBytes 单段 UTF-8 字节上限，默认不限制。
   * @returns {string[]} 按原顺序排列的文本分段。
   */
  function splitText(text, maxLen, maxBytes = Infinity) {
    const chunks = [];
    let rest = text;
    const encoder = Number.isFinite(maxBytes) ? new TextEncoder() : null;
    while (rest.length > maxLen || (encoder && encoder.encode(rest).length > maxBytes)) {
      let cut = maxLen;
      if (encoder) {
        let bytes = 0, length = 0;
        for (const point of rest) {
          const next = encoder.encode(point).length;
          if (bytes + next > maxBytes || length + point.length > maxLen) break;
          bytes += next;length += point.length;
        }
        cut = length;
      }
      const head = rest.slice(0, cut);
      const boundary = Math.max(head.lastIndexOf(" "), head.lastIndexOf("。") + 1,
        head.lastIndexOf("！") + 1, head.lastIndexOf("？") + 1);
      if (boundary > maxLen / 2) cut = boundary;
      if (/[\uD800-\uDBFF]/.test(rest[cut - 1])) cut--;
      chunks.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    if (rest) chunks.push(rest);
    return chunks;
  }

  /**
   * 翻译用户选中的文字，在选区附近展示结果；取消后不显示迟到的弹层。
   */
  async function translateSelection(text) {
    if (!text || !text.trim()) return;
    const generation=STATE.cancelVersion;
    // 网络请求期间选区可能消失，提前保存位置以便在原选区旁展示结果。
    const anchorRect = getSelectionAnchorRect();
    await loadConfig();
    if(generation!==STATE.cancelVersion)return;
    try {
      const res = await requestTranslate(text.trim());
      showPopup(text.trim(), res, anchorRect);
    } catch (e) {
      if(e.name!=="AbortError"){recordTranslationIssue(e);openControlPanel();}
    }
  }

  /**
   * 获取当前选区的位置矩形，用于定位选中翻译结果。
   */
  function getSelectionAnchorRect() {
    try {
      const selection = window.getSelection();
      if (!selection || !selection.rangeCount) return null;
      const range = selection.getRangeAt(0).cloneRange();
      const rects = range.getClientRects();
      const rect = rects.length ? rects[rects.length - 1] : range.getBoundingClientRect();
      if (rect && (rect.width || rect.height)) {
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
      }
    } catch (_) {}
    return null;
  }

  // 解包保存的原始节点，保留链接事件和控件状态；文字片段的临时容器也一并移除。
  /**
   * 移除所有译文并还原原始节点，清理处理标记和相关翻译记录。
   */
  function clearTranslations() {
    for (const [el, entry] of translatedElements) {
      const original = entry.original;
      if (original.parentNode) {
        while (original.firstChild) original.parentNode.insertBefore(original.firstChild, original);
        original.remove();
      }
      entry.wrapper.remove();
      if (el.classList.contains("bt-text-fragment") && el.parentNode) {
        while (el.firstChild) el.parentNode.insertBefore(el.firstChild, el);
        el.remove();
      }
    }
    translatedElements.clear();
    unchangedTextNodes = new WeakMap();
    unchangedElements = new WeakMap();
    failureRecords = new WeakMap();
    document.querySelectorAll(".bt-translation-text").forEach((n) => n.remove());
    document.querySelectorAll(`[${STATE.processedAttr}]`).forEach((n) => n.removeAttribute(STATE.processedAttr));
    document.querySelectorAll("[data-bt-hidden]").forEach((n) => {
      n.removeAttribute("data-bt-hidden");
    });
    STATE.translated = false;
  }

  /**
   * 按当前翻译状态在开始翻译与取消还原之间切换。
   */
  function toggleTranslation() {
    if (STATE.translating) {
      if (!STATE.cancelRequested) cancelTranslation();
      return;
    }
    if (STATE.translated) cancelTranslation();
    else translatePage();
  }

  /**
   * 暂停本页、递增任务版本并取消后台旧批次；立即还原页面，不等待网络返回。
   */
  function cancelTranslation() {
    const oldToken=requestToken;
    STATE.pagePaused=true;STATE.cancelVersion++;
    resumeAfterSettingsChange=false;
    requestToken="page-"+Date.now()+"-"+Math.random();
    // 本地先立即结束等待，再通知后台移除队列、中止只属于本页的请求。
    for(const task of [...pendingMessages])task.reject(cancelledError());
    if(typeof chrome.runtime.sendMessage==="function") {
      try {chrome.runtime.sendMessage({action:MSG.CANCEL_TRANSLATION_REQUESTS,runToken:oldToken},()=>{void chrome.runtime.lastError;});}catch(_){}
    }
    clearTimeout(visibleTranslateTimer);clearTimeout(initialTranslateTimer);
    visibleTranslateTimer=null;initialTranslateTimer=null;
    pendingViewport=false;dirtyRoots.clear();wholePageScan=true;
    pendingRecords=new WeakSet();hoverPendingRecords=new WeakSet();hoverGestureRecords=new WeakMap();
    STATE.cancelRequested=false;STATE.translating=false;STATE.backgroundTranslating=false;STATE.activeWorkers=0;
    hidePageNotice();
    STATE.lastError="";STATE.failedCount=0;STATE.languageNoticeCount=0;
    clearTranslations();setFabBusy(false);setFabTranslated(false);
    if(panelModalEl)refreshPanelModal();
  }

  // ============================================================
  // 悬停段落翻译
  // ============================================================
  // 每个节点只记录正在进行的悬停请求；结束后释放，避免失败把该段永久锁住。
  let hoverPendingRecords = new WeakSet();
  // 只用于同一次按键的去重，翻译/还原的决定仍依据页面上的实际译文。
  let hoverGestureRecords = new WeakMap();
  let hoverGesture = 0;

  // 主动悬停可以越过网页的禁译标记，但不能处理代码、编辑区或插件界面。
  const HOVER_EXCLUDED_SELECTOR = ".bt-modal, .bt-popup, .bt-fab-wrap, .bt-thumb, .bt-page-notice, pre, code, script, style, noscript, svg, math, canvas, textarea, input, select, [contenteditable]:not([contenteditable='false'])";

  const HOVER_SCAN_EXCLUDED_SELECTOR = ".bt-translation-text, .bt-original-text, .bt-text-fragment, " + HOVER_EXCLUDED_SELECTOR;

  /**
   * 定位鼠标命中的直接文字节点。混合控件只有文字片段可翻译，不能把整个控件容器包起来。
   * 优先使用浏览器光标命中接口；坐标不可用时仅接受唯一文字片段，避免猜中其他说明文字。
   */
  function getHoverTextNode(target, point) {
    if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) return null;
    let node;
    if (typeof document.caretPositionFromPoint === "function") {
      node = document.caretPositionFromPoint(point.x, point.y)?.offsetNode;
    } else if (typeof document.caretRangeFromPoint === "function") {
      node = document.caretRangeFromPoint(point.x, point.y)?.startContainer;
    }
    return node?.nodeType === 3 && (node.parentElement === target || target.contains(node)) ? node : null;
  }

  /** 验证译文和原文容器仍属于当前段落；空、隐藏、被移走或被删除的译文均不算有效译文。 */
  function hasHoverTranslation(el, entry) {
    if (!el.isConnected || !entry?.wrapper?.isConnected || entry.wrapper.parentNode !== el ||
        entry.original?.parentNode !== el || entry.sourceText !== (entry.original.textContent || "").trim() ||
        !entry.wrapper.textContent?.trim() || entry.wrapper.hasAttribute("hidden")) return false;
    const style = window.getComputedStyle(entry.wrapper);
    return style.display !== "none" && style.visibility !== "hidden" && style.visibility !== "collapse";
  }

  /**
   * 复用整页文字采集，只扫描鼠标所在的小区域，再选中包含命中位置的完整正文或直接文字片段。
   * 已有译文先沿祖先记录查找，使原文、译文和控件旁片段都能定位回同一个可还原区域。
   */
  function getHoverItem(target, point, retryProcessed = false) {
    if (!target?.closest || target.closest(HOVER_EXCLUDED_SELECTOR)) return null;
    for (let el = target; el;) {
      const parent = el.parentElement;
      let entry = translatedElements.get(el);
      if (!entry) {
        // 记录丢失时仍以实际 DOM 为准，仅识别当前节点的直接子容器，不能误用其他段落的译文。
        const children = [...(el.children || [])];
        const original = children.find(child => child.classList.contains("bt-original-text"));
        const wrapper = children.find(child => child.classList.contains("bt-translation-text"));
        if (original || wrapper) entry = { original, wrapper, sourceText: (original?.textContent || "").trim() };
      }
      if (entry) {
        if (hasHoverTranslation(el, entry)) {
          translatedElements.set(el, entry);
          return { el, text: entry.sourceText };
        }
        // 网页可能只删除译文、清空译文或复用外层节点；清理记录并解包当前原文，不能恢复旧原文。
        const fallback = el.classList.contains("bt-text-fragment") ? parent : el;
        restoreEntry(el, entry);
        unchangedElements.delete(el);
        if (!target.isConnected) target = fallback;
        if (!target?.isConnected) return null;
        el = target;
        continue;
      }
      el = parent;
    }
    let root = target.closest(BLOCK_SELECTOR + ", " + FORM_SELECTOR +
      ", div, section, dialog, form, fieldset, dt, dd, summary, [role='option'], [role='menuitem'], [role='tab'], [role='status'], [role='tooltip']");
    if (!root) {
      root = target.closest(TEXT_SELECTOR);
      // 没有块级容器的导航链接等结构，也要包含外层行内文字，而不是只翻译最里层 span。
      while (root?.parentElement?.matches(TEXT_SELECTOR)) root = root.parentElement;
    }
    // display:contents 的父容器自身没有尺寸，但其文字子元素仍可能可见，由共用采集器逐项判断。
    if (!root) return null;
    const items = collectBlocks([root], { hover: true, retryProcessed });
    const node = getHoverTextNode(target, point);
    const matches = items.filter(item => item.node
      ? item.node === node || (!node && item.el === target)
      : item.el === target || item.el.contains(target));
    // 一个混合容器有多段直接文字、又未命中文字时，不把所有文字误合并为整段。
    return matches.length === 1 ? matches[0] : null;
  }

  /**
   * 还原鼠标所在的一条译文；记录原始节点以阻止动态补翻立即恢复，下一次按键可解除。
   */
  function restoreHoverItem(el, entry) {
    const sourceNode = el.classList.contains("bt-text-fragment") ? entry.original.firstChild : null;
    restoreEntry(el, entry);
    if (sourceNode?.parentNode) {
      unchangedTextNodes.set(sourceNode, { text: sourceNode.textContent.trim(), scope: requestScope(), hoverRestored: true });
    } else {
      unchangedElements.set(el, { text: (el.textContent || "").trim(), scope: requestScope() });
      el.setAttribute(STATE.processedAttr, "hover-restored");
    }
    if (!translatedElements.size) STATE.translated = false;
    setFabTranslated(STATE.translated);
    if (panelModalEl) refreshPanelModal();
  }

  /**
   * 主动 Shift 允许在整页暂停时翻译单段；移入只翻译，明确按键才还原，避免布局变化反复切换。
   * 与整页共用执行器和进行中记录，避免重复请求，并统一长度限制、失败处理与过期结果检查。
   */
  async function translateHoverBlock(target, allowRestore = false, point) {
    const manual = STATE.hoverRequireShift;
    if (!STATE.hoverTranslate || STATE.cancelRequested || (STATE.pagePaused && !manual)) return;
    const item = getHoverItem(target, point, manual);
    if (!item) return;
    const { el, node, text } = item;
    const key = node || el;
    const gesture = manual ? point?.gesture : undefined;
    if (gesture !== undefined && hoverGestureRecords.get(key) === gesture) return;
    if (hoverPendingRecords.has(key) || pendingRecords.has(key)) return;
    const entry = translatedElements.get(el);
    if (hasHoverTranslation(el, entry)) {
      if (allowRestore) {
        const sourceNode = el.classList.contains("bt-text-fragment") ? entry.original.firstChild : null;
        restoreHoverItem(el, entry);
        if (gesture !== undefined) hoverGestureRecords.set(sourceNode || el, gesture);
      }
      return;
    }
    if (node) {
      const skipped = unchangedTextNodes.get(node);
      if (skipped?.hoverRestored && skipped.text === text && skipped.scope === requestScope() && !manual && !allowRestore) return;
      if (manual) unchangedTextNodes.delete(node);
    } else if (el.hasAttribute(STATE.processedAttr)) {
      if (!manual && !allowRestore && el.getAttribute(STATE.processedAttr) === "hover-restored") return;
      el.removeAttribute(STATE.processedAttr);
      unchangedElements.delete(el);
    }
    const pendingSet = hoverPendingRecords;
    pendingSet.add(key);
    const config = { ...STATE, runToken: requestToken, hover: true,
      aiConfig: { ...((STATE.aiKeys || {})[STATE.aiProvider] || {}) },
      retryManual: manual,
      retryToken: manual ? String(Date.now()) + ":" + Math.random() : undefined };
    const gestureRecords = hoverGestureRecords;
    if (gesture !== undefined) gestureRecords.set(key, gesture);
    try {
      const result = await handleBlock(item, config);
      const unchanged = node ? unchangedTextNodes.get(node) : unchangedElements.get(el);
      // 失败和过期结果仍允许移开再移入重试；同一手势的成功或原译文一致结果不反复请求。
      if (result !== true && !(result === "skipped" && unchanged?.text === text && unchanged.scope === requestScope(config))) {
        gestureRecords.delete(key);
      }
    } finally {
      pendingSet.delete(key);
    }
  }

  /**
   * 绑定两种顺序：按住 Shift 移入，或鼠标停好再按 Shift；同一次长按只响应一次按下。
   * 不拦截网页快捷键；编辑输入、输入法组合和 Ctrl/Alt/Meta 组合键均不触发段落操作。
   */
  function bindHoverTranslate() {
    let pointer = null;
    let shiftPressed = false;
    const rememberPointer = e => { pointer = { target: e.target, x: e.clientX, y: e.clientY }; };
    document.addEventListener("mousemove", rememberPointer, { passive: true });
    document.addEventListener("mouseover", e => {
      rememberPointer(e);
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      if (STATE.hoverRequireShift && !e.shiftKey) return;
      if (STATE.hoverRequireShift && !shiftPressed) {
        shiftPressed = true;
        hoverGesture++;
      }
      return translateHoverBlock(e.target, false, { x: e.clientX, y: e.clientY, gesture: STATE.hoverRequireShift ? hoverGesture : undefined });
    });
    document.addEventListener("mouseout", e => { if (!e.relatedTarget) pointer = null; });
    document.addEventListener("keydown", e => {
      if (e.key !== "Shift") return;
      if (e.repeat || shiftPressed) return;
      shiftPressed = true;
      hoverGesture++;
      if (!STATE.hoverRequireShift || e.ctrlKey || e.altKey || e.metaKey || e.isComposing || e.defaultPrevented) return;
      if (e.target?.closest?.("input, textarea, select, [contenteditable]:not([contenteditable='false'])")) return;
      if (!pointer) return;
      // 页面滚动后鼠标可能没动，使用当前位置命中元素，避免操作已经移走的旧段落。
      const target = Number.isFinite(pointer.x) && Number.isFinite(pointer.y)
        ? document.elementFromPoint(pointer.x, pointer.y) : pointer.target;
      return translateHoverBlock(target, true, { ...pointer, gesture: hoverGesture });
    });
    document.addEventListener("keyup", e => { if (e.key === "Shift") shiftPressed = false; });
    window.addEventListener("blur", () => { pointer = null; shiftPressed = false; });
  }

  // ============================================================
  // 悬浮球 + 小图标 + 控制面板
  // ============================================================
  let fabWrap = null;
  let fabEl = null;
  let checkBadgeEl = null;
  let thumbEl = null;
  let panelModalEl = null;
  let hoverTimer = null;
  let hideTimer = null;

  const ICON_GLOBE = `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2z" stroke="currentColor" stroke-width="1.8" opacity="0.35"/><path d="M4 12h16M12 4c2.5 2.5 2.5 13.5 0 16M12 4c-2.5 2.5-2.5 13.5 0 16" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M7 9h5M9.5 7v2c0 2.5-1 4-2.5 5M9 12c1 1.5 2.5 2.5 4 3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`;

  const ICON_CHECK_BADGE = `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M5 12.5l4.5 4.5L19 7.5" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

  /**
   * 创建翻译悬浮球，恢复符合当前布局版本的保存位置并限制在视口内。
   */
  function createFab() {
    if (fabWrap) return;
    const mount = getMountNode();
    if (!mount) { setTimeout(createFab, 300); return; }

    fabWrap = document.createElement("div");
    fabWrap.className = "bt-fab-wrap";

    fabEl = document.createElement("div");
    fabEl.className = "bt-fab";
    fabEl.title = "点击翻译 / 取消翻译";
    fabEl.innerHTML = ICON_GLOBE;

    checkBadgeEl = document.createElement("div");
    checkBadgeEl.className = "bt-check-badge";
    checkBadgeEl.innerHTML = ICON_CHECK_BADGE;

    fabWrap.appendChild(fabEl);
    fabWrap.appendChild(checkBadgeEl);
    mount.appendChild(fabWrap);

    chrome.storage.sync.get(["fabPos"], (cfg) => {
      const pos = cfg.fabPos;
      // 旧版位置不再恢复，使本次更新采用上方默认位置；之后继续记住用户拖动位置。
      if (pos && pos.layoutVersion === 2 && Number.isFinite(pos.left) && Number.isFinite(pos.top)) {
        fabWrap.style.left = Math.max(8, Math.min(pos.left, window.innerWidth - 40)) + "px";
        fabWrap.style.top = Math.max(48, Math.min(pos.top, window.innerHeight - 40)) + "px";
        fabWrap.style.right = "auto";
        fabWrap.style.bottom = "auto";
      }
    });

    bindFabEvents();
  }

  /**
   * 返回插件界面的挂载节点，兼容页面处于全屏的情况。
   */
  function getMountNode() {
    if (document.body) return document.body;
    if (document.documentElement) return document.documentElement;
    return null;
  }

  /**
   * 绑定悬浮球的点击、拖动和悬停行为，并保存拖动后的有效位置。
   */
  function bindFabEvents() {
    let dragging = false, moved = false;
    let sx = 0, sy = 0, ox = 0, oy = 0;

    // 记录按下位置和拖动起点，为当前组件启动拖动交互。

    const onDown = (e) => {
      if (e.button !== 0) return;
      dragging = true; moved = false;
      sx = e.clientX; sy = e.clientY;
      const rect = fabWrap.getBoundingClientRect();
      ox = rect.left; oy = rect.top;
      fabEl.classList.add("bt-dragging");
      fabWrap.style.right = "auto"; fabWrap.style.bottom = "auto";
      fabWrap.style.left = ox + "px"; fabWrap.style.top = oy + "px";
      e.preventDefault();
    };

    // 在拖动过程中更新组件坐标，并按当前视口约束位置。

    const onMove = (e) => {
      if (!dragging) return;
      const dx = e.clientX - sx;
      const dy = e.clientY - sy;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;
      fabWrap.style.left = Math.max(8, Math.min(ox + dx, window.innerWidth - 40)) + "px";
      fabWrap.style.top = Math.max(48, Math.min(oy + dy, window.innerHeight - 40)) + "px";
      if (thumbEl) positionThumbNearFab();
    };

    // 结束当前组件的拖动；是否持久化位置由所在组件的实现决定。

    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      fabEl.classList.remove("bt-dragging");
      if (moved) {
        const rect = fabWrap.getBoundingClientRect();
        chrome.storage.sync.set({ fabPos: { left: rect.left, top: rect.top, layoutVersion: 2 } });
      } else {
        toggleTranslation();
      }
    };

    fabEl.addEventListener("mousedown", onDown);
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);

    fabWrap.addEventListener("mouseenter", () => {
      if (!STATE.hoverPanel) return;
      if (hoverTimer) clearTimeout(hoverTimer);
      hoverTimer = setTimeout(() => showThumbnail(), 220);
    });
    fabWrap.addEventListener("mouseleave", () => {
      if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
      scheduleHideThumb();
    });

    fabEl.addEventListener("touchstart", (e) => {
      const t = e.touches[0];
      onDown({ button: 0, clientX: t.clientX, clientY: t.clientY, preventDefault: () => e.preventDefault() });
    }, { passive: false });
    document.addEventListener("touchmove", (e) => {
      if (!dragging) return;
      const t = e.touches[0];
      onMove({ clientX: t.clientX, clientY: t.clientY });
    }, { passive: true });
    document.addEventListener("touchend", () => { if (!dragging) return; onUp(); });
  }

  /**
   * 展示悬浮球附近的快捷操作卡片并刷新其显示状态。
   */
  function showThumbnail() {
    if (thumbEl) return;
    const mount = getMountNode();
    if (!mount) return;

    thumbEl = document.createElement("div");
    thumbEl.className = "bt-thumb";
    thumbEl.title = "打开控制面板";
    thumbEl.innerHTML = `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="4" width="18" height="16" rx="2" stroke="currentColor" stroke-width="1.8"/><path d="M7 9h10M7 13h6M7 17h8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="17" cy="13" r="1.5" fill="currentColor"/></svg>`;
    mount.appendChild(thumbEl);
    positionThumbNearFab();

    thumbEl.addEventListener("click", (e) => {
      e.stopPropagation();
      hideThumbNow();
      openControlPanel();
    });
    thumbEl.addEventListener("mouseenter", () => {
      if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    });
    thumbEl.addEventListener("mouseleave", () => scheduleHideThumb());
  }

  /**
   * 根据悬浮球位置和视口边界定位快捷卡片，减少超出屏幕的情况。
   */
  function positionThumbNearFab() {
    if (!thumbEl || !fabWrap) return;
    const fr = fabWrap.getBoundingClientRect();
    const tr = thumbEl.getBoundingClientRect();
    const margin = 8;
    const vw = window.innerWidth, vh = window.innerHeight;

    let left = fr.left + (fr.width - tr.width) / 2;
    let top = fr.bottom + margin;

    if (top + tr.height > vh - margin) top = fr.top - tr.height - margin;
    if (left < margin) left = margin;
    if (left + tr.width > vw - margin) left = vw - tr.width - margin;

    thumbEl.style.left = left + "px";
    thumbEl.style.top = top + "px";
    thumbEl.style.right = "auto";
    thumbEl.style.bottom = "auto";
  }

  /**
   * 延迟隐藏快捷卡片，让指针能从悬浮球移到卡片上。
   */
  function scheduleHideThumb() {
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => hideThumbNow(), 260);
  }

  /**
   * 取消隐藏计时并立即收起快捷卡片。
   */
  function hideThumbNow() {
    if (thumbEl) { thumbEl.remove(); thumbEl = null; }
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
  }

  // ============================================================
  // 控制面板
  // ============================================================
  /**
   * 创建或显示页面控制面板，随后绑定交互并刷新当前配置。
   */
  function openControlPanel() {
    if (panelModalEl) return;
    const mount = getMountNode();
    if (!mount) return;

    panelModalEl = document.createElement("div");
    panelModalEl.className = "bt-modal";
    panelModalEl.innerHTML = `
      <div class="bt-modal-panel">
        <div class="bt-modal-header" id="btModalDrag">
          <div class="bt-modal-brand">
            <div class="bt-modal-logo">译</div>
            <div>
              <div class="bt-modal-title">页知译 · 网页双语翻译</div>
              <div class="bt-modal-sub">控制面板</div>
            </div>
          </div>
          <button class="bt-modal-close" title="关闭">✕</button>
        </div>

        <div class="bt-modal-body">
          <div class="bt-modal-hero">
            <div>
              <div class="bt-modal-hero-label">当前页面</div>
              <div class="bt-modal-hero-status" id="btModalStatus">未翻译</div>
              <div class="bt-modal-hint" id="btModalError" role="status"></div>
              <div class="bt-modal-hint" id="btModalLanguageNotice" role="status"></div>
            </div>
            <div class="bt-modal-hero-actions">
              <button class="bt-modal-btn bt-modal-btn-primary" id="btModalTranslate">翻译此页面</button>
              <button class="bt-modal-btn bt-modal-btn-ghost" id="btModalCancel">取消翻译</button>
            </div>
          </div>

          <div class="bt-modal-section">
            <div class="bt-modal-section-title">翻译设置</div>
            <div class="bt-modal-field">
              <label>翻译服务</label>
              <select id="btModalEngine"></select>
            </div>
            <div class="bt-modal-field-row">
              <div class="bt-modal-field">
                <label>源语言</label>
                <select id="btModalFrom"></select>
              </div>
              <div class="bt-modal-field">
                <label>目标语言</label>
                <select id="btModalTo"></select>
              </div>
            </div>
          </div>

          <div class="bt-modal-section">
            <div class="bt-modal-section-title">显示模式</div>
            <div class="bt-modal-seg" id="btModalModeSeg">
              <button data-mode="bilingual" class="bt-modal-seg-btn">双语对照</button>
              <button data-mode="translation-only" class="bt-modal-seg-btn">仅显示译文</button>
            </div>
          </div>

          <div class="bt-modal-section">
            <div class="bt-modal-section-title">行为偏好</div>
            <div class="bt-modal-switch-row">
              <div>
                <div class="bt-modal-switch-title">打开网页时自动翻译</div>
                <div class="bt-modal-hint">开启后自动启动当前及新网页；当前页启动后持续补翻，点击取消才停止。</div>
              </div>
              <div class="bt-modal-switch" id="btModalAuto"></div>
            </div>
            <div class="bt-modal-switch-row">
              <div>
                <div class="bt-modal-switch-title">悬停悬浮球显示快捷面板</div>
                <div class="bt-modal-hint">关闭后悬浮球只用于点击翻译。</div>
              </div>
              <div class="bt-modal-switch" id="btModalHover"></div>
            </div>
          </div>
        </div>

        <div class="bt-modal-footer">
          <button class="bt-modal-settings" id="btModalSettings">
            <span>⚙</span> 更多设置
          </button>
        </div>
      </div>
    `;
    mount.appendChild(panelModalEl);

    bindPanelModal();
    makeModalDraggable();
    refreshPanelModal();
  }

  /**
   * 根据服务配置生成引擎选项，标明尚未配置的服务。
   */
  function renderEngineOptions() {
    const sel = panelModalEl.querySelector("#btModalEngine");
    if (!sel) return;

    const engines = ["google", "baidu", "ai", "mymemory"];
    const configured = engines.filter((id) => isEngineConfigured(id));
    const unconfigured = engines.filter((id) => !isEngineConfigured(id));

    let html = "";
    configured.forEach((id) => {
      html += `<option value="${id}">✓ ${getEngineLabel(id)}</option>`;
    });
    if (unconfigured.length > 0) {
      html += `<optgroup label="未就绪（请先配置或测试连接）">`;
      unconfigured.forEach((id) => {
        const pendingTest = id === "baidu" && STATE.baiduAppId && STATE.baiduKey;
        html += `<option value="${id}" class="bt-unconfigured"${id === "baidu" ? " disabled" : ""}>${getEngineLabel(id)}（${pendingTest ? "待测试" : "未配置"}）</option>`;
      });
      html += `</optgroup>`;
    }

    sel.innerHTML = html;
    sel.value = STATE.engine;
    if (!sel.value && configured.length > 0) sel.value = configured[0];
  }

  /**
   * 绑定面板的引擎、语言、模式及行为设置，并处理重新翻译和取消操作。
   */
  function bindPanelModal() {
    const $ = (sel) => panelModalEl.querySelector(sel);

    $(".bt-modal-close").onclick = closeControlPanel;

    $("#btModalTranslate").onclick = () => {
      translatePage(true);
      setTimeout(refreshPanelModal, 200);
    };
    $("#btModalCancel").onclick = () => {
      cancelTranslation();
      refreshPanelModal();
    };

    $("#btModalEngine").onchange = (e) => {
      const v = e.target.value;
      if (!isEngineConfigured(v)) {
        showPanelToast(v === "baidu" ? "请先到设置页测试百度连接，成功后再选择" : "该引擎未配置，请先到设置页填写密钥", "warn");
        renderEngineOptions();
        return;
      }
      changeTranslationSetting("engine",v);
    };

    $("#btModalFrom").onchange = (e) => { changeTranslationSetting("from",e.target.value); };
    $("#btModalTo").onchange = (e) => { changeTranslationSetting("to",e.target.value); };

    $("#btModalModeSeg").querySelectorAll(".bt-modal-seg-btn").forEach((btn) => {
      btn.onclick = () => {
        STATE.mode = btn.dataset.mode;
        updateModalModeButtons(STATE.mode);
        applyMode();
        saveField("mode", STATE.mode);
      };
    });

    $("#btModalAuto").onclick = async () => {
      if (autoTranslateSaving) return;
      const previous = STATE.autoTranslate;
      const enabled = !previous;
      const generation = STATE.cancelVersion;
      const entry = { value: enabled };
      autoTranslateSaving = true;
      pendingPreferenceWrites.set("autoTranslate", entry);
      autoPreferenceVersion++;
      STATE.autoTranslate = enabled;
      if (!enabled) stopAutomaticStart();
      refreshPanelModal();
      let saved = false;
      try {
        await saveField("autoTranslate", enabled);
        saved = true;
      } catch (error) {
        autoPreferenceVersion++;
        STATE.autoTranslate = previous;
        if (previous && generation === STATE.cancelVersion) scheduleVisibleTranslation();
        showPanelToast("保存自动翻译设置失败：" + error.message, "warn");
      } finally {
        autoTranslateSaving = false;
        if (pendingPreferenceWrites.get("autoTranslate") === entry) pendingPreferenceWrites.delete("autoTranslate");
        if (panelModalEl) refreshPanelModal();
      }
      if (!saved) return;
      // 防止初始化定时器稍后重复启动；关闭开关不会撤回已有译文或中断当前任务。
      clearTimeout(initialTranslateTimer);
      initialTranslateTimer = null;
      // 只响应本页的明确开启操作；保存期间若已取消或切换配置，旧回调不得重新启动。
      if (enabled && STATE.autoTranslate && generation === STATE.cancelVersion &&
          !STATE.translating) {
        // 已有译文时只扫描遗漏内容，空扫描不闪烁；未翻译时立即启动当前页。
        await translatePage(false, STATE.translated);
      }
    };
    $("#btModalHover").onclick = () => {
      STATE.hoverPanel = !STATE.hoverPanel;
      $("#btModalHover").classList.toggle("on", STATE.hoverPanel);
      saveField("hoverPanel", STATE.hoverPanel);
    };

    $("#btModalSettings").onclick = () => {
      chrome.runtime.sendMessage({ action: "OPEN_SETTINGS" });
    };
  }

  /**
   * 在控制面板内短暂展示操作结果或错误提示。
   */
  function showPanelToast(msg, type = "info") {
    if (!panelModalEl) return;
    let toast = panelModalEl.querySelector(".bt-panel-toast");
    if (toast) toast.remove();
    toast = document.createElement("div");
    toast.className = `bt-panel-toast bt-panel-toast-${type}`;
    toast.textContent = msg;
    panelModalEl.querySelector(".bt-modal-panel").appendChild(toast);
    setTimeout(() => toast.remove(), 2600);
  }

  let pageNoticeEl = null;
  let pageNoticeTimer = null;
  /** 清除页面级提示和关闭计时器，供重新翻译及取消时调用。 */
  function hidePageNotice() {
    clearTimeout(pageNoticeTimer);
    pageNoticeTimer = null;
    if (pageNoticeEl) pageNoticeEl.remove();
    pageNoticeEl = null;
  }
  /** 本轮翻译结束后显示一条红色页面提示，点击可打开控制面板查看完整原因。 */
  function showPageNotice() {
    hidePageNotice();
    pageNoticeEl = document.createElement("div");
    pageNoticeEl.className = "bt-page-notice";
    pageNoticeEl.setAttribute("role","status");
    const detail = document.createElement("button");
    detail.type = "button";
    detail.textContent = STATE.lastError
      ? "部分内容翻译失败：" + STATE.lastError + "（点击查看详情）"
      : "部分内容未翻译：无法识别源语言，请指定源语言或切换引擎（点击查看详情）";
    detail.onclick = () => { openControlPanel(); hidePageNotice(); };
    const close = document.createElement("button");
    close.type = "button"; close.textContent = "×"; close.setAttribute("aria-label","关闭提示");
    close.onclick = hidePageNotice;
    pageNoticeEl.append(detail,close);
    getMountNode().appendChild(pageNoticeEl);
    // 保留提示直到用户关闭、查看详情、手动重译或取消，避免动态补翻将其闪退。
  }

  /**
   * 为控制面板标题栏绑定拖动事件，避免干扰面板内的表单交互。
   */
  function makeModalDraggable() {
    if (!panelModalEl) return;
    const header = panelModalEl.querySelector("#btModalDrag");
    const panel = panelModalEl.querySelector(".bt-modal-panel");
    if (!header || !panel) return;

    let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;

    // 记录按下位置和拖动起点，为当前组件启动拖动交互。

    const onDown = (e) => {
      if (e.target.closest(".bt-modal-close")) return;
      dragging = true;
      sx = e.clientX; sy = e.clientY;
      const rect = panel.getBoundingClientRect();
      ox = rect.left; oy = rect.top;
      panelModalEl.style.left = ox + "px";
      panelModalEl.style.top = oy + "px";
      panelModalEl.style.right = "auto";
      panelModalEl.style.bottom = "auto";
      e.preventDefault();
    };

    // 在拖动过程中更新组件坐标，并按当前视口约束位置。

    const onMove = (e) => {
      if (!dragging) return;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      const rect = panel.getBoundingClientRect();
      let nl = ox + dx, nt = oy + dy;
      nl = Math.max(8, Math.min(window.innerWidth - rect.width - 8, nl));
      nt = Math.max(8, Math.min(window.innerHeight - rect.height - 8, nt));
      panelModalEl.style.left = nl + "px";
      panelModalEl.style.top = nt + "px";
    };

    // 结束当前组件的拖动；是否持久化位置由所在组件的实现决定。

    const onUp = () => { dragging = false; };

    header.addEventListener("mousedown", onDown);
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);

    panelModalEl.__btCleanup = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
  }

  /**
   * 将当前翻译状态、失败提示和用户配置同步到面板控件。
   */
  function refreshPanelModal() {
    if (!panelModalEl) return;
    const $ = (sel) => panelModalEl.querySelector(sel);

    const statusEl = $("#btModalStatus");
    const btnT = $("#btModalTranslate");
    const btnC = $("#btModalCancel");

    if (STATE.cancelRequested) {
      statusEl.textContent = "取消中…";
      btnT.textContent = "取消中…";
      btnT.disabled = true;
      btnC.disabled = true;
    } else if (STATE.translating && !STATE.backgroundTranslating) {
      statusEl.textContent = "翻译中…";
      btnT.textContent = "翻译中…";
      btnT.disabled = true;
      btnC.disabled = false;
    } else if (STATE.translated) {
      statusEl.textContent = "已翻译";
      btnT.textContent = "重新翻译";
      btnT.disabled = false;
      btnC.disabled = false;
    } else {
      statusEl.textContent = "未翻译";
      btnT.textContent = "翻译此页面";
      btnT.disabled = false;
      btnC.disabled = !STATE.pageStarted;
      if (STATE.lastError) { statusEl.textContent = "翻译失败，请检查配置"; btnT.textContent = "重试翻译"; }
    }

    const errorEl = $("#btModalError");
    if (errorEl) {errorEl.textContent = STATE.lastError ? "部分内容未完成：" + STATE.lastError : "";errorEl.title=errorEl.textContent;}
    const noticeEl = $("#btModalLanguageNotice");
    if (noticeEl) noticeEl.textContent = STATE.languageNoticeCount
      ? "语言提示：" + STATE.languageNoticeCount + " 处内容无法自动识别源语言，已跳过。请为 MyMemory 指定源语言或切换引擎。" : "";
    renderEngineOptions();
    window.BT_CONST.fillLanguageSelect($("#btModalFrom"),"from",STATE.from);
    window.BT_CONST.fillLanguageSelect($("#btModalTo"),"to",STATE.to);
    updateModalModeButtons(STATE.mode);
    $("#btModalAuto").classList.toggle("on", STATE.autoTranslate);
    $("#btModalAuto").setAttribute("aria-disabled", String(autoTranslateSaving));
    $("#btModalHover").classList.toggle("on", STATE.hoverPanel);
  }

  /**
   * 更新双语与仅译文按钮的选中样式。
   */
  function updateModalModeButtons(mode) {
    if (!panelModalEl) return;
    panelModalEl.querySelectorAll(".bt-modal-seg-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.mode === mode);
    });
  }

  /**
   * 关闭控制面板；关闭面板本身不等同于取消翻译。
   */
  function closeControlPanel() {
    if (panelModalEl) {
      if (panelModalEl.__btCleanup) panelModalEl.__btCleanup();
      panelModalEl.remove();
      panelModalEl = null;
    }
  }

  /**
   * 通过共享存储层保存单项配置，返回写入 Promise 供调用方处理失败。
   */
  function saveField(key, value) {
    return chrome.storage.sync.set({ [key]: value });
  }

  /**
   * 切换悬浮球的翻译中视觉状态。
   */
  function setFabBusy(busy) {
    if (!fabEl) return;
    // 悬浮球反映实际工作；面板按钮是否变化仍由 backgroundTranslating 单独控制。
    fabEl.classList.toggle("bt-busy", busy);
    if (fabWrap) {
      fabWrap.classList.toggle("bt-busy", busy);
      setFabTranslated(STATE.translated);
    }
    if (panelModalEl) refreshPanelModal();
  }

  /**
   * 更新悬浮球完成标记及失败提醒，使状态与当前页面一致。
   */
  function setFabTranslated(translated) {
    // 配置读取和空扫描也会临时设置 translating，因此以实际忙碌样式判断是否显示徽标。
    const busy = !!fabEl && fabEl.classList.contains("bt-busy");
    const incomplete = !busy && !STATE.pagePaused && (!!STATE.lastError || STATE.languageNoticeCount > 0);
    if (fabWrap) fabWrap.classList.toggle("bt-has-error", incomplete);

    if (!fabWrap) return;
    fabWrap.classList.toggle("bt-translated", translated && !busy && !incomplete && !STATE.pagePaused && !STATE.cancelRequested);
    if (fabEl) fabEl.title = translated ? "点击取消翻译" : "点击翻译";
  }

  // ============================================================
  // 划词弹窗
  // ============================================================
  let popupEl = null;
  /**
   * 创建选中或悬停翻译结果弹层，按锚点定位并绑定关闭事件。
   */
  function showPopup(original, translation, anchorRect = null) {
    if (popupEl) { popupEl.remove(); popupEl = null; }
    const mount = getMountNode();
    if (!mount) return;
    popupEl = document.createElement("div");
    popupEl.className = "bt-popup";
    popupEl.innerHTML = `
      <div class="bt-popup-orig">${escapeHtml(original)}</div>
      <div class="bt-popup-trans">${escapeHtml(translation)}</div>
    `;
    mount.appendChild(popupEl);
    // 将弹窗放在选中文字附近，并限制在当前视口范围内。
    const margin = 12;
    const gap = 8;
    const rect = popupEl.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    const anchor = anchorRect || { left: vw / 2, right: vw / 2, top: vh / 2, bottom: vh / 2 };
    let left = Math.max(margin, Math.min(anchor.left, vw - rect.width - margin));
    let top = anchor.bottom + gap;
    if (top + rect.height > vh - margin) top = anchor.top - rect.height - gap;
    top = Math.max(margin, Math.min(top, vh - rect.height - margin));
    popupEl.style.left = `${left}px`;
    popupEl.style.top = `${top}px`;
    popupEl.style.right = "auto";
    popupEl.style.bottom = "auto";

    // 点击结果弹层以外的区域时关闭，并移除对应的事件监听。
    const close = (e) => {
      if (!popupEl || !popupEl.contains(e.target)) {
        if (popupEl) popupEl.remove();
        popupEl = null;
        document.removeEventListener("click", close);
      }
    };
    setTimeout(() => document.addEventListener("click", close), 0);
  }

  /**
   * 转义插入 HTML 模板的文字，避免网页文本被当作标签解析。
   */
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );
  }

  // ============================================================
  // 启动
  // ============================================================
  let visibleTranslateTimer = null;
  let initialTranslateTimer = null;
  let pendingViewport = false;
  /** 关闭开关只撤销尚未开始的自动启动；已启动的当前页会话持续补翻，直到用户取消。 */
  function stopAutomaticStart() {
    clearTimeout(initialTranslateTimer);
    initialTranslateTimer = null;
    if (!STATE.pageStarted) {
      clearTimeout(visibleTranslateTimer);
      visibleTranslateTimer = null;
      pendingViewport = false;
    }
  }

  /**
   * 当前页启动翻译后持续处理滚动和动态内容；只有取消暂停会话，与全局自动启动偏好分开。
   */
  function scheduleVisibleTranslation() {
    debugLog("[页知译] 合并补翻触发", {dirtyRegions:dirtyRoots.size,wholePageScan});
    // 已取消的页面不自动重启；将连续触发的事件合并为一次可见区域扫描。
    if ((!STATE.pageStarted && !STATE.autoTranslate) || STATE.cancelRequested || STATE.pagePaused) return;
    if (visibleTranslateTimer) clearTimeout(visibleTranslateTimer);
    visibleTranslateTimer = setTimeout(() => {
      visibleTranslateTimer = null;
      // 定时等待期间用户可能已取消，执行时必须再次检查。
      if ((!STATE.pageStarted && !STATE.autoTranslate) || STATE.pagePaused || STATE.cancelRequested) return;
      if (!STATE.translating) translatePage(false, true);
      else pendingViewport = true;
    }, 220);
  }
  window.addEventListener("scroll", () => { wholePageScan = true; scheduleVisibleTranslation(); }, { passive: true, capture: true });
  window.addEventListener("resize", () => { wholePageScan = true; scheduleVisibleTranslation(); }, { passive: true });

  /**
   * 还原一条译文对应的原始内容，并移除该条翻译的处理记录。
   */
  function restoreEntry(el, entry) {
    if (entry.original?.parentNode === el) {
      while (entry.original.firstChild) el.insertBefore(entry.original.firstChild,entry.original);
      entry.original.remove();
    }
    entry.wrapper?.remove();
    if (el.classList.contains("bt-text-fragment") && el.parentNode) {
      const parent = el.parentNode;
      while (el.firstChild) parent.insertBefore(el.firstChild,el);
      el.remove(); dirtyRoots.add(parent);
    } else if (el.isConnected) dirtyRoots.add(el);
    el.removeAttribute(STATE.processedAttr);
    translatedElements.delete(el);
  }
  /**
   * 观察新增、替换和文字变化；忽略插件自身节点，只对受影响区域安排补翻。
   */
  function observeDynamicContent() {
    const uiSelector = ".bt-translation-text, .bt-modal, .bt-popup, .bt-fab-wrap, .bt-thumb, .bt-page-notice";
    const observer = new MutationObserver(records => {
      if (STATE.pagePaused || STATE.cancelRequested) return;
      const touched = new Set();
      let relevant = false;
      for (const record of records) {
        const target = record.target.nodeType === 1 ? record.target : record.target.parentElement;
        if (!target || target.closest(uiSelector)) continue;
        for (let parent = target; parent; parent = parent.parentElement) {
          if (translatedElements.has(parent)) touched.add(parent);
        }
        // 移除整片内容时，仅检查被移除子树，不扫描整页的全部译文记录。
        for (const removed of record.removedNodes || []) {
          if (removed.nodeType !== 1) continue;
          if (translatedElements.has(removed)) touched.add(removed);
          if (removed.querySelectorAll) removed.querySelectorAll("[" + STATE.processedAttr + "]").forEach(el => {
            if (translatedElements.has(el)) touched.add(el);
          });
        }
        if (target.closest(EXCLUDED_SELECTOR)) continue;
        const changedNodes = [...(record.addedNodes || []), ...(record.removedNodes || [])];
        const pluginOnly = record.type === "childList" && changedNodes.length &&
          changedNodes.every(node => node.nodeType === 1 && node.matches(".bt-translation-text, .bt-original-text, .bt-text-fragment, .bt-fab-wrap, .bt-modal, .bt-popup, .bt-thumb, .bt-page-notice"));
        if (pluginOnly) continue;
        if (record.type === "attributes" && target.hasAttribute(STATE.processedAttr)) continue;
        const root = target.closest(BLOCK_SELECTOR + ", " + FORM_SELECTOR) || target;
        dirtyRoots.add(root);
        relevant = true;
      }
      for (const el of touched) {
        const entry = translatedElements.get(el);
        const current = [...el.childNodes].filter(node => node !== entry.wrapper).map(node => node.textContent || "").join("").trim();
        if (!el.isConnected || entry.original.parentNode !== el || entry.wrapper.parentNode !== el || current !== entry.sourceText) {
          restoreEntry(el,entry); relevant = true;
        }
      }
      if (relevant) {
        for (const root of [...dirtyRoots]) {
          for (let parent = root.parentElement; parent; parent = parent.parentElement) {
            if (dirtyRoots.has(parent)) {dirtyRoots.delete(root);break;}
          }
        }
        scheduleVisibleTranslation();
      }
    });
    observer.observe(document.body || document.documentElement, {
      subtree:true,childList:true,characterData:true,attributes:true,
      attributeFilter:["open","hidden","aria-hidden","aria-expanded","data-state","class","style"]
    });
    for (const event of ["toggle","transitionend","animationend"]) document.addEventListener(event,(e)=>{
      // 插件按钮悬停动画、悬浮球动画均不属于网页内容变化。
      if (e.target instanceof Element && e.target.closest(uiSelector)) return;
      scheduleVisibleTranslation();
    },true);
  }

  /**
   * 加载初始配置并安装界面和事件监听，按自动翻译偏好决定是否开始翻译。
   */
  async function bootstrap() {
    try { await loadConfig(); } catch (error) {
      STATE.autoTranslate = false;
      STATE.lastError = "读取配置失败，请打开设置检查：" + error.message;
    }
    // 页面已有可挂载节点后再初始化悬浮球、观察器及自动翻译。
    const start = () => {
      createFab();
      bindHoverTranslate();
      observeDynamicContent();
      if (STATE.autoTranslate) initialTranslateTimer = setTimeout(() => {
        initialTranslateTimer = null;
        if (STATE.autoTranslate && !STATE.pagePaused && !STATE.cancelRequested) translatePage(false, true);
      }, 500);
    };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", start, { once: true });
    } else {
      start();
    }
    setTimeout(() => { if (!fabWrap) createFab(); }, 1500);
  }
  bootstrap();
}
