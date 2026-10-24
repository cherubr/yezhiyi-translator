
if (window.__BT_INJECTED) {
  // 同一文档只初始化一次，避免重复绑定键盘/滚动监听、重复创建观察器和悬浮球。
} else {
  window.__BT_INJECTED = true;
  init();
}

/**
 * 建立当前文档的翻译状态、DOM 记录和交互入口，由 bootstrap 完成初始化。
 * 页面刷新会重建这些本地状态，不会清空后台缓存或用户配置。
 */
function init() {
  const { MSG } = window.BT_CONST;
  /**
   * 仅在日志级别允许 debug 时输出本地诊断，不参与翻译决策或错误计数。
   * 传入参数不得包含网页原文、完整译文、密钥或含凭据的配置对象。
   */
  function debugLog(...args) {
    window.BT_LOG.debug(...args);
  }
  let diagnosticSequence=0;
  const diagnosticLabels={task_start:"任务分块",request_queued:"进入队列",request_wait:"等待发送",
    request_start:"开始请求",http_headers:"收到接口响应头",http_complete:"接口响应读取完成",
    request_success:"请求完成",request_error:"请求失败",request_cancelled:"请求取消",
    request_retry:"安排重试",request_shared:"复用进行中请求",cache_hit:"命中缓存",
    task_complete:"后台任务完成",task_error:"后台任务失败",task_cancelled:"后台任务取消"};
  /**
   * 把后台阶段码转换为可读日志，并关联页面 clientId 与后台任务/请求编号。
   * 仅展示耗时、等待原因和生效限制；配置并发与实际账号并发可能不同。
   * @param {Object} data 后台提供的无正文诊断字段，调用前已按 runToken 过滤旧批次。
   */
  function logTranslationDiagnostic(data) {
    if(!window.BT_LOG.isEnabled("debug")||!data)return;
    const reasons={qps:"等待请求频率额度",concurrency:"等待在途请求完成",backoff:"等待服务退避",hidden:"页面不可见"};
    let summary="";
    if(data.phase==="request_start")summary=" · 排队 "+data.queueMs+"ms · 生效并发 "+data.maxConcurrent+
      "（本入口设置 "+data.configuredMaxConcurrent+"）· QPS "+data.qps;
    else if(data.phase==="http_complete")summary=" · HTTP 总耗时 "+data.httpMs+"ms";
    else if(data.phase==="request_wait")summary=" · "+(reasons[data.reason]||data.reason);
    debugLog("[页知译][诊断] "+(diagnosticLabels[data.phase]||"请求状态")+" · 页面任务 #"+data.clientId+summary,
      {...data,...(data.reason?{reasonText:reasons[data.reason]||data.reason}:{})});
  }

  // 页面级运行状态：取消只暂停当前页面，不修改用户的全局自动翻译偏好。
  const STATE = {
    translating: false, // 当前整页调度轮次尚未结束；可能正在读配置，不一定已有网络请求。
    backgroundTranslating: false, // 已有译文时的自动补翻标识；用于保持面板按钮稳定，悬浮球仍可显示忙碌。
    translated: false, // 是否已有整页流程确认的有效译文；不表示页面全部内容都成功完成。
    cancelRequested: false, // 取消保护检查位；当前 cancelTranslation 同步清理后会复位，持续暂停由 pagePaused 表示。
    pagePaused: false, // 用户明确取消或配置切换清理期间暂停当前页；自动事件不能擅自解除。
    pageStarted: false, // 本页是否建立过整页翻译会话；已启动会话允许后续滚动/动态补翻。
    cancelVersion: 0, // 每次取消递增的本地代次，旧异步回调必须先检查它再修改页面。
    lastError: "", // 最近一次真正失败的可读说明；与源语言无法识别的提示分开保存。
    failedCount: 0, // 本地累计失败单元计数，供本轮是否新增问题的判断使用。
    languageNoticeCount: 0, // 无法可靠识别源语言而跳过的单元计数，不直接当作服务故障。
    engine: "google", // 翻译引擎 ID；AI 厂商另由 aiProvider 指定。
    aiProvider: "openai", // 当前选用的 AI 厂商 ID，编辑其他厂商配置不等于切换当前服务。
    from: window.BT_CONST.DEFAULTS.from, // 源语言偏好，auto 的具体识别方式由后台各引擎适配器处理。
    to: window.BT_CONST.DEFAULTS.to, // 目标语言偏好；跟随浏览器的值在发请求时解析为实际语言。
    visibilityPaused: false, // 页面不可见的临时状态，返回后仍要检查 pagePaused 才能续翻。
    pageStateVersion: 0, // 递增的页面状态序号，后台用它忽略乱序到达的可见性更新。
    viewportEpoch: 0, // 滚动后的阅读位置代次，用于后台优先级与 AI 当前视口投递名额。
    requestNotice: "", // 后台限流/退避等待说明，等待中不等同于已失败。
    processedAttr: "data-bt-processed", // 写在网页节点上的插件处理标识，避免整段和内部链接被重复采集。
    // 双语对照或仅译文；切换只改变节点显示。
    mode: "bilingual",
    translationStyle: {}, // 译文外观配置；修改时更新现有节点，不重新请求翻译。
    autoTranslate: false, // 全局自动启动偏好，不等于当前页会话是否正在持续补翻。
    hoverPanel: true, // 是否允许悬停悬浮球后显示打开面板的快捷卡片。
    viewportFirst: true, // 开启时只采集视口内的可见单元，屏幕外内容留待滚动补翻。
    hoverTranslate: true, // 是否启用鼠标所在段落的翻译入口。
    hoverRequireShift: true, // 是否要求主动按住 Shift；与无需按键的普通悬停模式区分。
    baiduAppId: "", // 百度凭据快照来自本机存储，不写入诊断日志。
    baiduKey: "", // 百度密钥快照，前端就绪判断不替代后台权限/验证检查。
    baiduVerification: null, // 与当前百度凭据绑定的连接测试记录。
    aiKeys: {}, // 按厂商保存的接口地址、密钥和模型配置，仅用于本轮快照及就绪判断。
    requestPolicies: {} // 本机请求参数；前端投递参考它，实际 QPS/并发仍由后台统一执行。
  };

  // 批次标识传给后台；取消/切换配置后换新值，旧响应与旧诊断不再属于当前批次。
  let requestToken = "page-" + Date.now() + "-" + Math.random();
  // 消息等待表保存本地 Promise 的终止入口；取消时先结束页面等待，再通知后台。
  const pendingMessages = new Set();
  // 本页正在保存的偏好优先于异步存储读取/通知，避免连续切换被旧值回写。
  // entry 对象身份还用于防止较早的一次保存清理掉较新保存的登记。
  const pendingPreferenceWrites = new Map();
  let resumeAfterSettingsChange = false;
  let autoTranslateSaving = false;
  // 旧配置读取不能覆盖用户刚刚修改的自动翻译开关。
  let autoPreferenceVersion = 0;
  // 当前页面调度器只在一轮 translatePage 存活：enqueue 合并新增任务，pump 投递，cancel 清队列。
  let activePageRun = null;
  let pageLifecycleBound = false;
  /**
   * 按错误类型更新当前页：源语言识别限制累加语言提示，其他错误记录说明及失败次数。
   * 同步已有面板和悬浮球；此函数本身不创建页面提示，也不自动打开控制面板。
   * @param {Error} error 可带 code 的规范化错误；主动取消由上游排除。
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
   * 切换服务、凭据或语言前取消旧批次，保存切换前是否正在运行/是否由用户暂停。
   * resumeAfterSettingsChange 将快速连续切换串起来，只有最后一次保存完成才恢复。
   * @returns {Object} resume 恢复意图、wasPaused 原暂停状态、version 取消后的代次。
   */
  function interruptForConfigChange() {
    const wasPaused=STATE.pagePaused;
    const resume = resumeAfterSettingsChange || (!STATE.pagePaused && (STATE.translating || STATE.translated || STATE.pageStarted || STATE.autoTranslate));
    cancelTranslation();
    resumeAfterSettingsChange=resume;
    return {resume,wasPaused,version:STATE.cancelVersion};
  }
  /**
   * 将引擎与 AI 厂商等关联字段作为一组保存，避免中间状态发起错误厂商请求。
   * 先取消旧批次、乐观更新 STATE，再保存；失败只允许仍属于当前代次的操作回滚。
   * 通过 entry 身份和代次检查，旧保存回调不能覆盖新选择或重新启动已取消的页面。
   * @param {Object} values 本次修改的偏好键值，不应包含整份未修改的过期配置。
   * @returns {Promise<void>} 保存并按原会话意图恢复后的结果。
   */
  async function changeTranslationSettings(values) {
    if(Object.entries(values).every(([key,value])=>STATE[key]===value))return;
    const previous=Object.fromEntries(Object.keys(values).map(key=>[key,STATE[key]]));
    const interrupted=interruptForConfigChange(),entries=new Map();
    for(const [key,value]of Object.entries(values)){
      const entry={value};entries.set(key,entry);pendingPreferenceWrites.set(key,entry);STATE[key]=value;
    }
    try {await chrome.storage.sync.set(values);}
    catch(error){
      if(interrupted.version===STATE.cancelVersion){Object.assign(STATE,previous);STATE.lastError="保存设置失败："+error.message;refreshPanelModal();}
      return;
    }finally{
      for(const [key,entry]of entries)if(pendingPreferenceWrites.get(key)===entry)pendingPreferenceWrites.delete(key);
    }
    if(interrupted.version!==STATE.cancelVersion)return;
    resumeAfterSettingsChange=false;
    if(interrupted.resume)await translatePage();
    else if(!interrupted.wasPaused)STATE.pagePaused=false;
    if(panelModalEl)refreshPanelModal();
  }
  /**
   * 单项设置的便捷入口，复用关联设置的取消、保存与恢复流程。
   * @param {string} key 偏好字段，例如 from、to。
   * @param {*} value 需要保存的新值。
   */
  function changeTranslationSetting(key,value) {return changeTranslationSettings({[key]:value});}

  // START/CANCEL 控制整页会话；OPEN_PANEL 只控制面板；TOGGLE_PANEL 是旧名，实际切换翻译。
  // 后台状态/诊断必须匹配当前 requestToken，避免取消后仍收到旧批次的等待或失败外观。
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    switch (request.action) {
      case MSG.START_TRANSLATION: translatePage(); break;
      case MSG.CANCEL_TRANSLATION: cancelTranslation(); break;
      case MSG.TOGGLE_PANEL: toggleTranslation(); break;
      case MSG.OPEN_PANEL:
        // 工具栏点击切换显隐；查看详情等普通打开消息仍保持幂等，不影响当前翻译任务。
        if(request.toggle===true&&panelModalEl)closeControlPanel();
        else openControlPanel();
        break;
      case MSG.TRANSLATE_SELECTION: translateSelection(request.text); break;
      case MSG.TRANSLATION_DIAGNOSTIC:
        if(request.runToken===requestToken)logTranslationDiagnostic(request.diagnostic);
        break;
      case MSG.TRANSLATION_REQUEST_STATE:
        if(request.runToken===requestToken) {
          STATE.requestNotice=(request.code==="RATE_LIMITED"?"服务限制请求，正在等待重试":"请求暂未完成，正在等待重试")+
            "（"+request.attempt+"/"+request.maxAttempts+"）";
          if(panelModalEl)refreshPanelModal();
        }
        break;
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
    // relevant 决定是否重读配置；affecting 仅列出会改变译文含义/服务的字段。
    // 显示模式和请求参数变化不必把已有译文全部撤回，策略变化可直接唤醒当前队列。
    const relevant = ["engine", "aiProvider", "aiKeys", "requestPolicies", "from", "to", "mode", "translationStyle", "autoTranslate", "hoverPanel", "baiduAppId", "baiduKey", "baiduVerification", "hoverTranslate", "hoverRequireShift"];
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
      if (changes.requestPolicies) activePageRun?.pump();
      if (panelModalEl) refreshPanelModal();
    }).catch(() => window.BT_LOG.warn("[页知译] 配置同步失败，请检查设置"));
  });

  /**
   * 通过共享存储层合并同步偏好与本机凭据，并以本页正在保存的偏好为准。
   * autoPreferenceVersion 防止旧读取覆盖刚点击的自动启动开关；切换模式时只更新显示。
   * 此函数只刷新配置快照，是否取消/恢复翻译由消息或存储变更调用方决定。
   * @returns {Promise<void>} STATE 更新完成；读取失败交调用方处理。
   */
  async function reloadConfig() {
    const autoVersion = autoPreferenceVersion;
    const cfg = await window.BT_STORAGE.get([
      "engine", "aiProvider", "aiKeys", "requestPolicies", "from", "to", "mode", "translationStyle",
      "autoTranslate", "hoverPanel",
      "baiduAppId", "baiduKey", "baiduVerification",
      "hoverTranslate", "hoverRequireShift"
    ]);
    for(const [key,entry] of pendingPreferenceWrites)cfg[key]=entry.value;
    if (cfg.engine) STATE.engine = cfg.engine;
    if (cfg.aiProvider) STATE.aiProvider = cfg.aiProvider;
    if (cfg.aiKeys) STATE.aiKeys = cfg.aiKeys;
    STATE.requestPolicies=cfg.requestPolicies||{};
    if (cfg.from) STATE.from = cfg.from;
    if (cfg.to) STATE.to = cfg.to;
    const modeChanged = cfg.mode && cfg.mode !== STATE.mode;
    if (cfg.mode) STATE.mode = cfg.mode;
    if (typeof cfg.autoTranslate === "boolean" && autoVersion === autoPreferenceVersion) {
      STATE.autoTranslate = cfg.autoTranslate;
      if (!STATE.autoTranslate) stopAutomaticStart();
    }
    if (typeof cfg.hoverPanel === "boolean") STATE.hoverPanel = cfg.hoverPanel;
    STATE.baiduAppId = cfg.baiduAppId || "";
    STATE.baiduKey = cfg.baiduKey || "";
    STATE.baiduVerification = cfg.baiduVerification || null;
    if (typeof cfg.hoverTranslate === "boolean") STATE.hoverTranslate = cfg.hoverTranslate;
    if (typeof cfg.hoverRequireShift === "boolean") STATE.hoverRequireShift = cfg.hoverRequireShift;
    if (modeChanged) applyMode();
    // 样式是独立偏好。读取完成后应用于现有译文；在途结果插入时读取最新 STATE 样式。
    const nextStyle=window.BT_TRANSLATION_STYLE.normalize(cfg.translationStyle);
    const styleChanged=JSON.stringify(nextStyle)!==JSON.stringify(STATE.translationStyle);
    STATE.translationStyle=nextStyle;
    // 普通补翻也会读取配置，只有样式真的改变时才遍历已有译文，避免长页面重复刷写样式。
    if(styleChanged)for(const entry of translatedElements.values())window.BT_TRANSLATION_STYLE.apply(entry.wrapper,nextStyle);
  }


  /**
   * 委托共享服务目录判断选项是否具备所需配置；百度还要求凭据绑定的验证记录。
   * 这是界面就绪判断，不实时探测网络、余额或服务可用性，后台仍会独立校验。
   * @param {string} id 服务选择值，可表示普通引擎或具体 AI 厂商。
   * @returns {boolean} 当前配置下是否允许选择。
   */
  function isEngineConfigured(id) {return window.BT_SERVICES.isConfigured(id,STATE);}

  /**
   * 向后台提交一个完整文字任务，携带配置快照、页面身份状态与翻译批次。
   * 前端不再拆 MyMemory/AI 长文本，字符和字节分块由后台统一执行。
   * 本地代次与批次双重校验保证取消后的迟到响应不能插入页面；finish 只结算一次。
   * @param {string} text 请求文字；存在行内保护内容时使用编码后的标记文本。
   * @param {Object} config 本轮引擎、语言、AI 配置快照与取消代次。
   * @returns {Promise<string>} 完整任务译文；连接中断、服务失败或取消时拒绝。
   */
  function requestTranslate(text, config = STATE) {
    const generation=config.cancelVersion ?? STATE.cancelVersion;
    const token=config.runToken || requestToken;
    const diagnosticId=window.BT_LOG.isEnabled("debug")?(config.diagnosticId||++diagnosticSequence):undefined;
    const submittedAt=Date.now();
    if(generation!==STATE.cancelVersion || token!==requestToken)return Promise.reject(cancelledError());
    debugLog("[页知译][诊断] 提交页面任务 #"+diagnosticId,{engine:config.engine,chars:Array.from(text).length});
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
          {action:"TRANSLATE",runToken:token,diagnosticId,engine:config.engine,aiProvider:config.aiProvider,aiConfig:config.aiConfig,
            retryManual:config.retryManual===true,retryToken:config.retryToken,text,from:config.from,to:window.BT_CONST.resolveTargetLanguage(config.to),
            priority:config.priority===0||config.hover?0:1,pageVisible:isPageVisible(),
            viewportEpoch:config.viewportEpoch ?? STATE.viewportEpoch,stateVersion:STATE.pageStateVersion},
          res=>{
            const runtimeError=chrome.runtime.lastError;
            if(settled)return;
            if(generation!==STATE.cancelVersion || token!==requestToken || res?.cancelled)return finish(cancelledError());
            if(runtimeError) {
              const error=new Error("翻译连接中断，请刷新页面或重试");error.code="CONNECTION_INTERRUPTED";return finish(error);
            }
            if(!res||!res.ok){const error=new Error(res?.error||"翻译失败");
              Object.assign(error,{code:res?.code,retryable:res?.retryable,permanent:res?.permanent,exhausted:res?.exhausted});
              return finish(error);}
            debugLog("[页知译][诊断] 页面收到译文 · 页面任务 #"+diagnosticId,{totalMs:Date.now()-submittedAt});
            finish(null,res.data);
          });
      }catch(_){const error=new Error("扩展连接已失效，请刷新页面后重试");error.code="CONNECTION_INTERRUPTED";finish(error);}
    });
  }

  /**
   * 仅在目标为中文时，启发式跳过已主要为中文的短文字，减少重复翻译。
   * 显式简繁转换、含日文假名/韩文及有独立英文单词的混合句仍保留翻译机会。
   * 这不是完整的源语言识别，也不是专有名词词典；实际语种识别仍取决于翻译服务。
   * @returns {boolean} true 表示当前中文目标下可跳过，不代表文本的精确语言标签。
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
   * 仅为“原文和译文是否实质相同”的比较做 NFKC 与空白规范化。
   * 不会修改网页原文或真正展示的译文，避免原译文相同仍叠加一份文字。
   * @returns {boolean} 忽略兼容字形和空白后是否相等。
   */
  function sameTranslation(source, translation) {
    const normalize = value => value.normalize("NFKC").replace(/\s+/gu, "").trim();
    return normalize(source) === normalize(translation);
  }
  // Map 必须可遍历，用于模式切换和整页还原；失效节点通过观察器删除记录。
  // entry 保存 wrapper、original、sourceText，连续片段可另保存 logicalText。
  const translatedElements = new Map();
  // 弱引用记录随网页节点释放；取消后整体更换集合，旧任务仍持有的集合不影响新轮次。
  let failureRecords = new WeakMap();
  let pendingRecords = new WeakSet();
  let wholePageScan = true;
  // null/wholePageScan 表示重新检查文档候选，dirtyRoots 表示仅需扫描的局部区域。
  // “全页扫描”仍受 isVisibleBlock 过滤，不表示立即发送屏幕外所有文字。
  const dirtyRoots = new Set();
  /**
   * 生成失败/未变化记录的配置作用域，切换引擎、AI 配置或语言后可重新处理。
   * 该内部比较值可能包含 AI 凭据，不能作为日志字段或可见错误消息输出。
   * @param {Object} config 比较所用的请求配置，默认当前 STATE。
   * @returns {string} 仅在页面内存使用的序列化比较值。
   */
  function requestScope(config = STATE) {
    return JSON.stringify([config.engine,config.engine === "ai" ? config.aiProvider : null,config.engine === "ai" ? (config.aiConfig || (config.aiKeys || {})[config.aiProvider] || {}) : null,config.from,config.to]);
  }
  /**
   * 排除正在处理的同一目标；原文或配置已变化时，不沿用旧失败记录。
   * 自动补翻需满足失败次数与冷却时间；手动重试可越过本地冷却，但不能绕过后台服务限制。
   * @param {Object} item 采集单元，混合区间以首节点为目标，整段以 el 为目标。
   * @param {boolean} automatic 是否为滚动/动态补翻。
   * @returns {boolean} 是否可加入本轮页面任务队列。
   */
  function eligibleForRequest(item, automatic) {
    const target = item.node || item.el, record = failureRecords.get(target);
    if (pendingRecords.has(target)) return false;
    if (!record || record.text !== item.text || record.scope !== requestScope()) return true;
    return !automatic || (record.attempts < 3 && Date.now() >= record.next);
  }

  // 选择器定义候选和排除范围；真正的正文/内联/控件边界由共享采集器分析。
  // 独立代码块排除，但正文中的可见行内代码可由采集器保护后与句子一起翻译。
  const BLOCK_SELECTOR = "p, h1, h2, h3, h4, h5, h6, li, blockquote, td, th, figcaption";
  const FORM_SELECTOR = "label, legend, button, [role='button'], [role='alert'], form small, form .help-text, form .form-text";
  const DIALOG_SELECTOR = "dialog, [role='dialog'], [role='alertdialog'], [aria-modal='true']";
  const TEXT_SELECTOR = "div, span, a, small, strong, em, b, time, dt, dd, summary, dialog, section, form, fieldset, [role='option'], [role='menuitem'], [role='tab'], [role='status'], [role='tooltip']";
  const EXCLUDED_SELECTOR = ".bt-translation-text, .bt-original-text, .bt-text-fragment, .bt-modal, .bt-popup, .bt-fab-wrap, .bt-thumb, .bt-page-notice, pre, code, script, style, noscript, svg, math, canvas, textarea, input, select, [translate='no'], .notranslate, [contenteditable]:not([contenteditable='false'])";

  /**
   * 排除 hidden/aria-hidden、CSS 隐藏和无尺寸元素；开启视口优先时还需与屏幕相交。
   * 检查的是布局与矩形交集，不是像素级遮挡检测，也不判断是否被其他浮层盖住。
   * @param {Element} el 候选文字容器。
   * @returns {boolean} 是否满足当前可见性采集条件。
   */
  function isVisibleBlock(el) {
    if (el.closest("[hidden], [aria-hidden='true']")) return false;
    const style = window.getComputedStyle(el);
    if (style.visibility === "hidden" || style.visibility === "collapse" || style.display === "none") return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && (!STATE.viewportFirst ||
      (rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth));
  }

  const translationUnits=window.BT_TRANSLATION_UNITS;
  // 状态判断与 DOM 结构划分分别管理；三个翻译入口共用同一个采集器。
  const unitCollector=translationUnits.createCollector({
    getDocument:()=>document,
    selector:BLOCK_SELECTOR+", "+FORM_SELECTOR+", "+TEXT_SELECTOR,
    getStyle:el=>window.getComputedStyle(el),
    excluded:scan=>scan.hover?HOVER_SCAN_EXCLUDED_SELECTOR:EXCLUDED_SELECTOR,
    canTranslate:text=>text.length>=2&&/\p{L}/u.test(text)&&!isMostlyChinese(text),
    /**
     * 已由祖先单元占有的子元素不重复提交，避免整段与句中链接同时请求。
     */
    ownedByAncestor(el) {
      // 整段已在请求、已完成或被手动还原时，不能再向其链接/span 发起重复请求。
      for(let parent=el.parentElement;parent;parent=parent.parentElement)
        if(parent.hasAttribute(STATE.processedAttr))return true;
      return false;
    },
    /**
     * 状态过滤：允许原文/配置变化后重采集，主动 Shift 可清理已失效的处理标记。
     */
    acceptElement(el,{hover=false,retryProcessed=false}) {
      if(el.hasAttribute(STATE.processedAttr)){
        const retryHover=hover&&retryProcessed&&!translatedElements.has(el)&&
          !pendingRecords.has(el)&&!hoverPendingRecords.has(el);
        if(!retryHover){
          const previous=unchangedElements.get(el);
          if(previous&&(previous.text!==(el.textContent||"").trim()||previous.scope!==requestScope())){
            unchangedElements.delete(el);el.removeAttribute(STATE.processedAttr);
          }else if(!(hover&&el.getAttribute(STATE.processedAttr)==="hover-restored"))return false;
        }
      }
      return isVisibleBlock(el);
    },
    /**
     * 连续片段以首节点记住未变化结果；主动 Shift 可解除用户还原留下的跳过记录。
     */
    skipUnit(unit,{hover=false,retryProcessed=false}) {
      if(!unit.node)return false;
      const skipped=unchangedTextNodes.get(unit.node);
      return !!(skipped&&skipped.text===unit.text&&skipped.scope===requestScope()&&
        !(hover&&(retryProcessed||skipped.hoverRestored)));
    }
  });
  /**
   * 复用 translation-units 的结构采集；整页、局部补翻和 Shift 共用正文/控件边界。
   * 此处返回翻译单元，不移动 DOM；每个单元可能仍需后台切成多个物理请求。
   * @param {Element[]} roots 可选局部扫描根节点；省略时扫描文档候选区域。
   * @param {Object} options hover/retryProcessed 控制主动单段的过滤例外。
   * @returns {Object[]} 含 el、text、kind、源快照、保护映射及可选节点区间的单元。
   */
  function collectBlocks(roots,options={}) {return unitCollector.collect(roots,options);}

  /**
   * 按文字容器位置排序：当前视口优先，再处理下方和已滚过的上方内容。
   * 它只重排页面候选，不分配真实网络名额；不开启视口优先时直接返回原数组。
   * @param {Object[]} blocks 待排序的翻译单元。
   * @returns {Object[]} 带内部评分的排序结果，或未启用排序时的原数组。
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

  /**
   * 整页调度主入口：检查会话 → 加载配置 → 固定本轮快照 → 采集/入队 → 等待排空。
   * 自动事件不能解除用户暂停；空扫描不进入忙碌外观，避免完成徽标和按钮来回闪烁。
   * 页面队列负责单元投递与滚动优先级，后台另行负责分块、QPS、并发、缓存和重试。
   * 每个异步阶段都检查 cancelVersion，旧轮次结束时不能覆盖新轮次界面。
   * @param {boolean} force 是否先清除已有译文再重新采集，面板“重新翻译”使用 true。
   * @param {boolean} automatic 是否由动态/滚动/自动启动入口触发，影响暂停和冷却判断。
   * @returns {Promise<void>} 本轮队列及在途文字单元排空后结束，不代表全页均翻译成功。
   */
  async function translatePage(force = false, automatic = false) {
    // 自动任务不能解除用户暂停；只有手动翻译入口可以恢复当前页面。
    if (automatic && ((!STATE.pageStarted && !STATE.autoTranslate) || STATE.pagePaused || STATE.cancelRequested)) return;
    if (!isPageVisible()) {
      if(!automatic){STATE.pageStarted=true;STATE.pagePaused=false;}
      STATE.visibilityPaused=true;notifyPageState();return;
    }
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
    // 自动扫描确认有新内容后才更新忙碌界面，避免空扫描造成按钮闪烁。
    if (!automatic) { setFabBusy(true); setFabTranslated(STATE.translated); hidePageNotice(); }
    STATE.requestNotice="";
    const issuesBefore = STATE.failedCount + STATE.languageNoticeCount;
    const pageStartedAt=Date.now();

    try { await reloadConfig(); } catch (error) {
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
    if(!isPageVisible()){STATE.translating=false;STATE.visibilityPaused=true;setFabBusy(false);return;}
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
    let total=0,done=0,succeeded=0,failed=0,skipped=0;
    const queue=[],queued=new WeakSet(),pendingByViewport=new Map();
    let pending=0,resolveDrain;
    // 所有任务完成后解除等待，最后统一更新面板/徽标，单个失败不会抛弃其余段落。
    const drained=new Promise(resolve=>{resolveDrain=resolve;});
    const run={
      generation,
      // 合并首次候选或当前脏区域；queued 只阻止队列内重复，进行中由 pendingRecords 负责。
      enqueue(initial) {
        if(generation!==STATE.cancelVersion||STATE.pagePaused)return;
        const candidates=initial||collectBlocks(wholePageScan||!dirtyRoots.size?undefined:[...dirtyRoots]);
        wholePageScan=false;dirtyRoots.clear();
        for(const item of candidates){
          const target=item.node||item.el;
          if(queued.has(target)||!eligibleForRequest(item,automatic))continue;
          queued.add(target);queue.push(item);total++;
        }
        const ordered=sortByViewport(queue);queue.splice(0,queue.length,...ordered);
        run.pump();
      },
      // 清理尚未开始的页面单元；在途请求由 cancelTranslation 的批次取消统一处理。
      cancel(){queue.length=0;run.pump();},
      // 按阅读位置投递完整单元；pending 表示等待完整译文的父任务数，不是 HTTP 分片数。
      // drained 仅在队列与在途都为空时结束；不可见时保留队列，返回页面后继续 pump。
      pump() {
        if(generation!==STATE.cancelVersion||STATE.pagePaused){queue.length=0;if(!pending)resolveDrain();return;}
        if(!isPageVisible())return;
        while(queue.length&&pending<window.BT_REQUEST_POLICY.LIMITS.pageTasks){
          const epoch=STATE.viewportEpoch;
          // AI 一段可能拆成很多分片；同时投递太多整段会让未完成段落的尾片排在大量新段之后。
          // 当前视口按服务的在途上限控制整段投递，完成一段再补一段；网络额度仍只由后台执行。
          // 滚动进入新视口时独立计算名额，避免旧视口的慢段阻塞新阅读位置；全页仍最多 64 段。
          if(runConfig.engine==="ai"){
            const policy=window.BT_REQUEST_POLICY.resolve("ai",runConfig.aiProvider,STATE.requestPolicies);
            if((pendingByViewport.get(epoch)||0)>=policy.maxConcurrent)break;
          }
          const item=queue.shift(),target=item.node||item.el;queued.delete(target);
          if(!item.el.isConnected)continue;
          if(!translationUnits.isCurrent(item)){wholePageScan=true;pendingViewport=true;continue;}
          pending++;
          pendingByViewport.set(epoch,(pendingByViewport.get(epoch)||0)+1);
          const snapshot={...runConfig,viewportEpoch:epoch};
          handleBlock(item,snapshot).then(result=>{
            if(result===true)succeeded++;
            else if(result==="skipped")skipped++;
            else failed++;
            done++;
            if(done%5===0||done===total)debugLog("[双语翻译] 进度 "+done+"/"+total);
          }).catch(error=>{
            if(error.name!=="AbortError")failed++;
          }).finally(()=>{
            pending--;
            const remaining=(pendingByViewport.get(epoch)||1)-1;
            if(remaining)pendingByViewport.set(epoch,remaining);else pendingByViewport.delete(epoch);
            run.pump();
          });
        }
        if(!pending&&!queue.length)resolveDrain();
      }
    };
    activePageRun=run;
    window.BT_LOG.info("[页知译] 开始页面翻译",{engine:runConfig.engine,tasks:rawBlocks.length,automatic});
    run.enqueue(rawBlocks);
    debugLog("[双语翻译] 已提交文字任务，网络并发由所选服务统一管理");
    await drained;
    if(activePageRun===run)activePageRun=null;
    if(generation!==STATE.cancelVersion)return;

    STATE.translating = false;
    STATE.requestNotice="";
    STATE.translated = translatedElements.size > 0 && !STATE.cancelRequested;
    setFabBusy(false);
    setFabTranslated(STATE.translated);

    if (STATE.cancelRequested) {
      debugLog(`[双语翻译] 已取消`);
    } else {
      window.BT_LOG.info(`[页知译] 完成：成功 ${succeeded} 段，跳过 ${skipped} 段，失败 ${failed} 段`,{totalMs:Date.now()-pageStartedAt});
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

  /**
   * 单元执行器：防重复登记 → 请求编码文字 → 校验批次/原文快照 → 还原保护标记 → 插入。
   * 原译文相同只记录跳过；混合区间仅包装连续源节点，不移动旁边的输入控件。
   * 原文在请求期间改变则丢弃旧结果并安排重新采集；取消不计失败，失败按类型记录冷却。
   * @param {Object} item 共享采集器返回的翻译单元，保护映射仅留在页面。
   * @param {Object} config 本轮配置快照，含 cancelVersion 和可选 hover 标记。
   * @returns {Promise<boolean|string>} true 为已插入，"skipped" 为跳过/取消，false 为未完成。
   */
  async function handleBlock(item, config) {
    const {el,text,node}=item;
    const generation=config.cancelVersion ?? STATE.cancelVersion;
    if (STATE.cancelRequested || generation!==STATE.cancelVersion) return "skipped";

    const target = node || el;
    // 保存当前集合引用；取消会换新 WeakSet，旧 finally 只能清理所属轮次的集合。
    const pendingSet=pendingRecords;
    if (pendingSet.has(target)) return "skipped";
    pendingSet.add(target);
    if (!node) el.setAttribute(STATE.processedAttr, "1");
    try {
      // 一次文字任务交给后台规划分片；所有分片共同遵守服务频率、在途和页面暂停。
      const diagnosticId=window.BT_LOG.isEnabled("debug")?++diagnosticSequence:undefined;
      const startedAt=Date.now();
      const response=await requestTranslate(item.protection?.text||text,{...config,diagnosticId});
      const receivedAt=Date.now();
      if(generation!==STATE.cancelVersion)return "skipped";
      if (STATE.cancelRequested) { el.removeAttribute(STATE.processedAttr); return false; }

      if (config.hover && (el.closest(HOVER_EXCLUDED_SELECTOR) || !isVisibleBlock(el))) {
        el.removeAttribute(STATE.processedAttr);
        return "skipped";
      }
      if (!response.trim()) {
        el.removeAttribute(STATE.processedAttr);
        return false;
      }
      // 单页应用可能在请求返回前复用节点；原文已变化时丢弃旧结果并安排补翻。
      if (!translationUnits.isCurrent(item)) {
        el.removeAttribute(STATE.processedAttr);
        pendingViewport = true;
        return false;
      }
      const translation=translationUnits.decode(response,item.protection);
      // 返回内容与原文相同时，不再叠加一份文字。
      if (sameTranslation(text, translation)) {
        if (node) unchangedTextNodes.set(node, { text, scope: requestScope(config) });
        else {
          el.setAttribute(STATE.processedAttr, "unchanged");
          unchangedElements.set(el,{text:item.sourceText??text,scope:requestScope(config)});
        }
        return "skipped";
      }
      failureRecords.delete(target);
      if (node) {
        const fragment = document.createElement("span");
        fragment.className = "bt-text-fragment";
        el.insertBefore(fragment, node);
        for(const sourceNode of translationUnits.nodesOf(item))fragment.appendChild(sourceNode);
        insertTranslation(fragment, translation, config.hover === true,item.kind);
        const entry=translatedElements.get(fragment);if(entry)entry.logicalText=text;
        if (config.hover) fragment.setAttribute(STATE.processedAttr, "hover");
      } else {
        insertTranslation(el, translation, config.hover === true,item.kind);
        const entry=translatedElements.get(el);if(entry)entry.logicalText=text;
        if (config.hover) el.setAttribute(STATE.processedAttr, "hover");
      }
      debugLog("[页知译][诊断] 译文已显示 · 页面任务 #"+diagnosticId,{totalMs:Date.now()-startedAt,insertMs:Date.now()-receivedAt});
      return true;
    } catch (e) {
      if(e.name==="AbortError" || generation!==STATE.cancelVersion)return "skipped";
      if (!STATE.cancelRequested) {
        // 只记录缺失/重复/异常数量，不打印源代码、禁译文字或接口响应正文。
        if(e.code==="PROTECTED_CONTENT_CHANGED")window.BT_LOG.warn("[页知译] 行内保护校验失败",e.markerDiagnostics);
        const old = failureRecords.get(target);
        const same = old && old.text === text && old.scope === requestScope(config);
        const attempts = same ? old.attempts + 1 : 1;
        failureRecords.set(target,{text,scope:requestScope(config),
          attempts:e.exhausted?3:attempts,
          next:e.code==="NEED_SOURCE_LANGUAGE"||e.permanent||e.exhausted||e.retryable===false?Infinity:Date.now()+30000*Math.pow(2,attempts-1)});
        recordTranslationIssue(e);
      }
      el.removeAttribute(STATE.processedAttr);
      return e.code === "NEED_SOURCE_LANGUAGE" ? "skipped" : false;
    } finally {
      pendingSet.delete(target);
    }
  }

  /**
   * 读取当前元素及最多三层祖先，识别 nowrap、短裁切容器和单行横向布局。
   * 识别后采用紧凑行内译文；不修改网站原有高度、宽度或 overflow，也不写网站专用选择器。
   * 这是布局启发式判断，不能证明所有网站都可同时容纳原文和长译文。
   * @returns {boolean} 是否需要单行紧凑显示。
   */
  function needsSingleLineTranslation(el) {
    for(let node=el,depth=0;node&&depth<4;node=node.parentElement,depth++){
      const style=window.getComputedStyle(node);
      if(style.whiteSpace==="nowrap"||style.whiteSpace==="pre")return true;
      const rect=node.getBoundingClientRect();
      const line=parseFloat(style.lineHeight)||parseFloat(style.fontSize)*1.4;
      const padding=(parseFloat(style.paddingTop)||0)+(parseFloat(style.paddingBottom)||0);
      const short=Number.isFinite(line)&&rect.height>0&&rect.height<=line*2+padding+2;
      const clipped=[style.overflow,style.overflowY].some(value=>value==="hidden"||value==="clip");
      const control=node.matches?.("button, [role='button'], [role='tab'], [role='menuitem'], [role='option']");
      const row=/flex/.test(style.display)&&!String(style.flexDirection).startsWith("column");
      if(short&&(clipped||(control&&row)))return true;
    }
    return false;
  }

  /**
   * 在文字容器内部包装原节点并追加译文，保存原文节点与译文节点的对应记录。
   * 移动原节点保留事件和控件状态；译文使用 textContent，不执行接口返回的 HTML。
   * kind 与实际布局共同决定正文/控件/单行样式，字体颜色由 CSS 和所在区域继承。
   * @param {Element} el 完整段落或 handleBlock 创建的连续片段容器。
   * @param {string} translation 已校验并还原保护项的纯文本译文。
   * @param {boolean} isHover 是否为单段翻译，决定专用样式及模式处理。
   * @param {string} kind 采集器给出的 paragraph/control/inline 分类。
   */
  function insertTranslation(el, translation, isHover = false, kind) {
    if (STATE.cancelRequested && !isHover) return;
    if (!el.isConnected) return;
    // 将译文放在原文字块内部，避免新增同级节点破坏网格、弹性布局、表格或列表。
    if (translatedElements.has(el)) return;
    const singleLine=needsSingleLineTranslation(el);
    const original = document.createElement("span");
    original.className = "bt-original-text";
    original.style.display = "contents";
    while (el.firstChild) original.appendChild(el.firstChild);
    const wrapper = document.createElement("span");
    wrapper.className = "bt-translation-text" + (isHover ? " bt-hover-translation" : "");
    wrapper.textContent = translation;
    if(singleLine){wrapper.classList.add("bt-translation-tight");wrapper.title=translation;}
    wrapper.setAttribute("translate", "no");
    const display=window.getComputedStyle(el).display;
    const paragraph=kind==="paragraph"&&!singleLine;
    if(paragraph)wrapper.classList.add("bt-translation-paragraph");
    else if(display==="inline"||el.classList.contains("bt-text-fragment")||
      el.closest("nav, [role='navigation'], aside, [role='menu']"))wrapper.classList.add("bt-translation-inline");
    if(kind==="control")wrapper.classList.add("bt-translation-control");
    const compact = el.matches && (el.matches(FORM_SELECTOR + ", td, th") || !!el.closest("form, " + DIALOG_SELECTOR));
    if (compact) wrapper.classList.add("bt-translation-compact");
    // 继承所在区域的文字颜色，兼容同一页面上的浅色和深色卡片。
    // 预览与真实译文共用同一映射，避免内联颜色覆盖用户保存的配置。
    window.BT_TRANSLATION_STYLE.apply(wrapper,STATE.translationStyle);
    // 按钮等紧凑控件采用行内译文，尽量减少额外高度并保留原始文字。
    if (el.matches && (el.matches("button, [role='button'], summary, [role='tab'], [role='menuitem'], [role='option']") ||
        el.closest("button, [role='button'], summary, [role='tab'], [role='menuitem'], [role='option']"))) wrapper.classList.add("bt-translation-control");
    el.appendChild(original);
    el.appendChild(wrapper);
    translatedElements.set(el, { wrapper, original, sourceText: (original.textContent || "").trim() });
    applyEntryMode(translatedElements.get(el));
  }

  /**
   * 仅通过原文容器显示状态和译文类名切换双语/仅译文，不重新请求接口。
   * 悬停单段译文保留原文对照，不随全局仅译文模式隐藏原文。
   * @param {Object} entry translatedElements 中的原文与译文对应记录。
   */
  function applyEntryMode(entry) {
    const hide = STATE.mode === "translation-only" && !entry.wrapper.classList.contains("bt-hover-translation");
    entry.original.style.display = hide ? "none" : "contents";
    // 隐藏原文时去掉双语段落间距，切回双语时恢复上下留白。
    entry.wrapper.classList.toggle("bt-translation-only", hide);
  }

  /**
   * 遍历已有译文并应用 STATE.mode；已脱离页面的译文忽略。
   * 本操作只改展示，不更换源快照、重新采集或触发网络翻译。
   */
  function applyMode() {
    for (const entry of translatedElements.values()) {
      if (!entry.wrapper.isConnected) continue;
      applyEntryMode(entry);
    }
  }

  /**
   * 对右键菜单传入的选中文字发起主动高优先级翻译，并在原选区旁展示弹层。
   * 请求前保存锚点，避免配置/网络等待后选区已消失；取消代次保护拦截旧结果。
   * 此入口不建立整页会话，失败时记录问题并打开面板供查看。
   * @param {string} text 用户选中的文字，空白内容直接忽略。
   */
  async function translateSelection(text) {
    if (!text || !text.trim()) return;
    const generation=STATE.cancelVersion;
    // 网络请求期间选区可能消失，提前保存位置以便在原选区旁展示结果。
    const anchorRect = getSelectionAnchorRect();
    await reloadConfig();
    if(generation!==STATE.cancelVersion)return;
    try {
      const res = await requestTranslate(text.trim(),{...STATE,priority:0,runToken:requestToken,retryManual:true,retryToken:String(Date.now())});
      showPopup(text.trim(), res, anchorRect);
    } catch (e) {
      if(e.name!=="AbortError"){recordTranslationIssue(e);openControlPanel();}
    }
  }

  /**
   * 取得当前选区最后一段可见矩形，跨行选区优先靠近末行定位结果弹层。
   * 无法取得有效选区或浏览器 API 抛错时返回 null，由弹层使用视口中心回退定位。
   * @returns {Object|null} 包含 left/right/top/bottom 的独立矩形快照。
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
   * 清除全部已有译文，解包保存的原节点，并移除混合片段容器与处理标记。
   * 同时清空本页未变化/失败记录，保留原节点身份；不操作后台缓存或用户配置。
   * 这是 DOM 还原工具，本身不取消网络请求；取消入口须先隔离旧批次再调用。
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
   * 根据当前页实际运行/译文状态，在开始整页翻译与取消还原之间切换。
   * 悬浮球点击及历史名 TOGGLE_PANEL 消息使用此函数；它不负责控制面板显隐。
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
   * 明确暂停当前页会话，先递增代次并更换批次，再结束本地等待、通知后台取消旧批次。
   * 同步清理定时器、队列记录、提示和译文，不等待网络返回；迟到回调被新代次拦截。
   * 保留全局 autoTranslate 偏好；滚动/DOM 变化不能解除 pagePaused，主动 Shift 仍可单段处理。
   */
  function cancelTranslation() {
    const oldToken=requestToken;
    // 先宣布暂停并提升代次，防止下面 DOM 还原或旧 Promise 结算触发自动重启。
    STATE.pagePaused=true;STATE.cancelVersion++;
    activePageRun?.cancel();STATE.requestNotice="";
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
    STATE.cancelRequested=false;STATE.translating=false;STATE.backgroundTranslating=false;
    hidePageNotice();
    STATE.lastError="";STATE.failedCount=0;STATE.languageNoticeCount=0;
    clearTranslations();setFabBusy(false);setFabTranslated(false);
    if(panelModalEl)refreshPanelModal();
  }

  // 悬停段落翻译
  // 每个节点只记录正在进行的悬停请求；结束后释放，避免失败把该段永久锁住。
  let hoverPendingRecords = new WeakSet();
  // 只用于同一次按键的去重，翻译/还原的决定仍依据页面上的实际译文。
  let hoverGestureRecords = new WeakMap();
  let hoverGesture = 0;

  // 主动悬停可以越过网页的禁译标记，但不能处理代码、编辑区或插件界面。
  const HOVER_EXCLUDED_SELECTOR = ".bt-modal, .bt-popup, .bt-fab-wrap, .bt-thumb, .bt-page-notice, pre, code, script, style, noscript, svg, math, canvas, textarea, input, select, [contenteditable]:not([contenteditable='false'])";

  const HOVER_SCAN_EXCLUDED_SELECTOR = ".bt-translation-text, .bt-original-text, .bt-text-fragment, " + HOVER_EXCLUDED_SELECTOR;

  /**
   * 通过鼠标坐标调用浏览器光标命中 API，查找目标元素内部的直接文本节点。
   * 坐标不可用、API 不支持或命中不是文本时返回 null，不猜测控件中其他说明的位置。
   * 唯一单元的回退选择由 getHoverItem 完成，不能把整个表单当成一段正文。
   * @returns {Text|null} 属于 target 子树的命中文本节点。
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

  /**
   * 按真实 DOM 验证该段是否已有有效译文，不依赖上一次按键留下的布尔值。
   * 要求源容器和译文仍为 el 的子节点、源文字未改变、译文非空且未被 CSS 隐藏。
   * @returns {boolean} true 时主动按键可还原；false 时应清理失效记录并重新定位。
   */
  function hasHoverTranslation(el, entry) {
    if (!el.isConnected || !entry?.wrapper?.isConnected || entry.wrapper.parentNode !== el ||
        entry.original?.parentNode !== el || entry.sourceText !== (entry.original.textContent || "").trim() ||
        !entry.wrapper.textContent?.trim() || entry.wrapper.hasAttribute("hidden")) return false;
    const style = window.getComputedStyle(entry.wrapper);
    return style.display !== "none" && style.visibility !== "hidden" && style.visibility !== "collapse";
  }

  /**
   * 先沿鼠标目标祖先查找有效译文，确保命中原文、链接或译文都指向同一还原区域。
   * 失效记录先解包当前 DOM，再通过共享采集器查找完整正文或连续混合文字区间。
   * 多个候选但无法确定命中单元时返回 null，不将相邻说明文字或整个布局误合并。
   * @param {Element} target 当前指针位置的元素，不使用滚动前已经移走的旧目标。
   * @param {Object} point 指针坐标，用于命中文字节点。
   * @param {boolean} retryProcessed 主动 Shift 是否允许重新处理已有跳过标记的单元。
   * @returns {Object|null} 已译段定位或可执行的新采集单元。
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
      ? translationUnits.nodesOf(item).some(source=>source===node||source===target||
          (source.nodeType===1&&source.contains(target)))||(!node&&item.el===target)
      : item.el === target || item.el.contains(target));
    // 一个混合容器有多段直接文字、又未命中文字时，不把所有文字误合并为整段。
    return matches.length === 1 ? matches[0] : null;
  }

  /**
   * 只还原鼠标所在的一条译文，并记录“用户已还原”以防动态补翻立即把它加回来。
   * 连续片段以原始首节点登记；整段以元素和 hover-restored 属性登记，下一次主动 Shift 可解除。
   * 不改变其他段落，也不暂停整页会话；必要时更新悬浮球和已有面板。
   * @param {Element} el 本段翻译容器。
   * @param {Object} entry 有效的原文/译文对应记录。
   */
  function restoreHoverItem(el, entry) {
    const sourceNode = el.classList.contains("bt-text-fragment") ? entry.original.firstChild : null;
    restoreEntry(el, entry);
    if (sourceNode?.parentNode) {
      unchangedTextNodes.set(sourceNode, { text: entry.logicalText||entry.sourceText, scope: requestScope(), hoverRestored: true });
    } else {
      unchangedElements.set(el, { text: (el.textContent || "").trim(), scope: requestScope() });
      el.setAttribute(STATE.processedAttr, "hover-restored");
    }
    if (!translatedElements.size) STATE.translated = false;
    setFabTranslated(STATE.translated);
    if (panelModalEl) refreshPanelModal();
  }

  /**
   * 单段执行入口：已有有效译文时仅主动按键允许还原，没有译文时进入共享 handleBlock。
   * 普通鼠标移入只翻译不还原，避免译文改变布局后反复触发移入/移出形成切换循环。
   * 手势编号只用于一次长按去重，不作为翻译/还原状态；进行中集合阻止重复请求并在 finally 释放。
   * @param {Element} target 当前鼠标目标。
   * @param {boolean} allowRestore 明确按下 Shift 时为 true；普通移入为 false。
   * @param {Object} point 坐标和可选 gesture 编号。
   */
  async function translateHoverBlock(target, allowRestore = false, point) {
    const manual = STATE.hoverRequireShift;
    if (!STATE.hoverTranslate || STATE.cancelRequested || (STATE.pagePaused && !manual)) return;
    const item = getHoverItem(target, point, manual);
    if (!item) return;
    const { el, node, text } = item;
    const key = node || el;
    // 手势只去重本次按键；是否还原仍由下面的 hasHoverTranslation 根据真实 DOM 判断。
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
   * 同时支持“按住 Shift 再移入”和“鼠标停好再按 Shift”，长按重复 keydown 不重复执行。
   * 主动 keydown 以 elementFromPoint 重新命中滚动后的元素；编辑区、输入法及组合键不执行。
   * 不 preventDefault 网页按键，keyup/失焦负责释放本次长按状态。
   */
  function bindHoverTranslate() {
    let pointer = null;
    let shiftPressed = false;
    // mousemove 只记坐标；触发翻译发生在移入或 Shift 按下，不每移动一个像素就发请求。
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
   * 只创建一个悬浮球与完成徽标，挂载节点尚不存在时延迟重试。
   * 仅恢复 layoutVersion=2 且坐标有效的位置，限制在视口内，其他情况使用 CSS 默认位置。
   * 最后绑定鼠标/触摸交互；成功与忙碌状态由独立刷新函数更新。
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
      // 只恢复 layoutVersion=2 的坐标，其他旧位置使用 CSS 默认值。
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
   * 选择插件界面的挂载节点：优先 body，其次 documentElement，均未创建时返回 null。
   * 本函数当前没有针对 fullscreenElement 的专门挂载分支，不能据此保证全屏覆盖层可见。
   * @returns {Element|null} 可以追加插件浮层的文档容器。
   */
  function getMountNode() {
    if (document.body) return document.body;
    if (document.documentElement) return document.documentElement;
    return null;
  }

  /**
   * 将鼠标/触摸统一映射到拖动流程：移动超过 3 像素记为拖动，否则松开时切换整页翻译。
   * 拖动约束坐标，结束后保存 layoutVersion=2 的位置；悬停 220ms 后可显示快捷面板卡片。
   * 拖动状态与翻译状态独立，位置保存不代表开始或取消翻译。
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
   * 创建悬浮球旁“打开控制面板”的快捷卡片，已有实例时不重复创建。
   * 点击卡片先收起自身再确保面板打开；指针进入卡片取消隐藏计时，移出后延迟收起。
   * 该卡片不是译文预览，也不发起翻译请求。
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
   * 按悬浮球的实际矩形定位快捷卡片：优先下方，超出底部则放上方。
   * 水平坐标钳制在视口内；拖动悬浮球时复用此函数跟随定位。
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
   * 重新安排 260ms 后关闭快捷卡片，留出指针从悬浮球移入卡片的时间。
   * 重复触发先取消旧计时，避免旧回调提前关闭正在交互的卡片。
   */
  function scheduleHideThumb() {
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => hideThumbNow(), 260);
  }

  /**
   * 立即移除快捷卡片并清空隐藏计时器，不关闭控制面板或取消翻译。
   * 清理引用使下一次悬停可以重新创建卡片。
   */
  function hideThumbNow() {
    if (thumbEl) { thumbEl.remove(); thumbEl = null; }
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
  }

  // 控制面板
  /**
   * 确保当前页面存在一个控制面板；重复普通打开请求直接返回，不会反向关闭。
   * 创建静态模板后挂载、绑定拖动和表单事件，再按 STATE 填充选项与显示状态。
   * 工具栏的再次点击关闭由 OPEN_PANEL 的 toggle 分支处理，此函数仍保持幂等打开。
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
              <div class="bt-modal-hint" id="btModalRequestNotice" role="status"></div>
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
              <div class="bt-modal-hint" id="btModalModel"></div>
              <div class="bt-modal-hint" id="btModalRequestPolicy"></div>
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
          <a class="bt-modal-settings" id="btModalFeedback" href="https://github.com/cherubr/yezhiyi-translator/issues/new" target="_blank" rel="noopener noreferrer" title="前往 GitHub 提交问题">问题反馈 ↗</a>
        </div>
      </div>
    `;
    mount.appendChild(panelModalEl);

    bindPanelModal();
    makeModalDraggable();
    refreshPanelModal();
  }

  /**
   * 通过共享服务目录填充面板下拉，保持与设置页相同的厂商、分组和可用性判断。
   * 当前选项由 STATE 表示；未配置或百度未验证的选项不能在这里被自动启用。
   */
  function renderEngineOptions() {
    window.BT_SERVICES.renderSelect(panelModalEl.querySelector("#btModalEngine"),STATE);
  }

  /**
   * 绑定面板按钮和偏好控件：重译传 force=true，取消立即还原，模式切换仅更新展示。
   * 服务/语言修改走统一批次切换；自动启动开关使用保存锁、版本和回滚保护连续操作。
   * 明确开启自动启动且保存成功时尝试启动当前页；关闭不撤销已经开始的当前页会话。
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
      const parsed=window.BT_SERVICES.parse(v,STATE.aiProvider);
      changeTranslationSettings(parsed.engine==="ai"?parsed:{engine:parsed.engine});
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

    // 保存成功才触发明确开启动作；代次变化意味着期间已取消/切换，旧回调不得恢复翻译。
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
   * 在已有面板内部展示一条操作反馈，先移除旧提示，约 2.6 秒后移除本条。
   * 只用于保存/选项操作反馈，与持久的页面翻译失败提示分开。
   * @param {string} msg 以 textContent 展示的说明。
   * @param {string} type 受调用方控制的样式类型，默认 info。
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
  /**
   * 移除页面级未完成提示并清理计时器引用，用于关闭、查看详情、手动重译和取消。
   * 清除提示不等于清除 STATE.lastError，面板仍可保留本轮失败详情。
   */
  function hidePageNotice() {
    clearTimeout(pageNoticeTimer);
    pageNoticeTimer = null;
    if (pageNoticeEl) pageNoticeEl.remove();
    pageNoticeEl = null;
  }
  /**
   * 本轮出现新增失败/语言提示后，显示独立的页面级说明，不直接创建控制面板。
   * 点击详情才打开面板并收起本提示；点击关闭只收起提示，不重新请求接口。
   * 提示保持到用户明确操作，不按短超时自动消失，避免动态补翻造成一闪而过。
   */
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
   * 仅使用面板标题栏启动拖动，排除关闭按钮；移动时将面板约束在视口边界内。
   * document 级 move/up 监听通过 __btCleanup 登记，关闭面板时移除，防止重复打开累积监听。
   * 当前面板位置不保存到用户配置，与悬浮球的持久位置不同。
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
   * 按取消、不可见暂停、主动翻译、已有译文、未翻译的顺序更新面板按钮与状态文案。
   * 补翻时可保留“重新翻译”按钮文案；忙碌动画由悬浮球独立反映，减少按钮跳变。
   * 同时刷新模型、保存的请求参数、等待/失败/语言提示及服务和语言选项。
   * 这里展示的是当前入口配置，不是后台跨页面合并后的实时账号限额。
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
    } else if (STATE.visibilityPaused && STATE.pageStarted && !STATE.pagePaused) {
      statusEl.textContent="已暂停（页面不可见）";
      btnT.textContent=STATE.translated?"重新翻译":"翻译此页面";
      btnT.disabled=false;btnC.disabled=false;
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

    // 显示实际正在使用的模型与已保存参数，避免把编辑中的厂商或推荐值当成当前配置。
    const modelEl=$("#btModalModel");
    if(modelEl){
      const model=(STATE.aiKeys[STATE.aiProvider]||{}).model||(window.AI_PROVIDERS[STATE.aiProvider]||{}).model||"";
      modelEl.textContent=STATE.engine==="ai"?"当前模型："+(model||"接口默认模型"):"";
    }
    const policyEl=$("#btModalRequestPolicy");
    if(policyEl){
      const policy=window.BT_REQUEST_POLICY.resolve(STATE.engine,STATE.aiProvider,STATE.requestPolicies);
      policyEl.textContent=(policy.mode==="manual"?"手动配置":"推荐配置")+"：每秒最多 "+policy.qps+" 次，同时最多 "+policy.maxConcurrent+" 个请求";
    }
    const requestEl=$("#btModalRequestNotice");
    if(requestEl)requestEl.textContent=STATE.requestNotice;
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
   * 只切换已有面板中双语/仅译文按钮的选中类，不保存配置或重新翻译。
   * @param {string} mode 当前显示模式值。
   */
  function updateModalModeButtons(mode) {
    if (!panelModalEl) return;
    panelModalEl.querySelectorAll(".bt-modal-seg-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.mode === mode);
    });
  }

  /**
   * 清理面板拖动监听并移除面板实例，使后续打开可以重新创建。
   * 仅关闭界面，不清理译文、不取消请求、不修改当前页会话或全局偏好。
   */
  function closeControlPanel() {
    if (panelModalEl) {
      if (panelModalEl.__btCleanup) panelModalEl.__btCleanup();
      panelModalEl.remove();
      panelModalEl = null;
    }
  }

  /**
   * 保存单项普通偏好到 storage.sync，返回 Promise 由交互调用方处理保存结果。
   * 密钥等敏感配置不通过本工具写入，相关配置由设置页的共享存储层管理。
   * @param {string} key 偏好字段名称。
   * @param {*} value 保存值。
   * @returns {Promise<void>} Chrome 存储写入结果。
   */
  function saveField(key, value) {
    return chrome.storage.sync.set({ [key]: value });
  }

  /**
   * 同步悬浮球及外层容器的 bt-busy 类；页面不可见时不显示忙碌动画。
   * 随后重新计算完成/未完成徽标，并刷新已有面板；不启动、暂停或终止真实任务。
   * @param {boolean} busy 调用方希望展示的忙碌状态。
   */
  function setFabBusy(busy) {
    if (!fabEl) return;
    // 悬浮球反映实际工作；面板按钮是否变化仍由 backgroundTranslating 单独控制。
    busy=busy&&!STATE.visibilityPaused;
    fabEl.classList.toggle("bt-busy", busy);
    if (fabWrap) {
      fabWrap.classList.toggle("bt-busy", busy);
      setFabTranslated(STATE.translated);
    }
    if (panelModalEl) refreshPanelModal();
  }

  /**
   * 根据真实忙碌外观、错误/语言提示、页面可见性及用户暂停共同计算徽标。
   * 优先展示忙碌，空闲且未完成时展示感叹号；满足成功条件才展示完成勾。
   * translated 只表示已有译文，不能单独据此断言当前页全部翻译完成。
   * @param {boolean} translated 当前是否有可作为已译状态的译文。
   */
  function setFabTranslated(translated) {
    // 配置读取和空扫描也会临时设置 translating，因此以实际忙碌样式判断是否显示徽标。
    const busy = !!fabEl && fabEl.classList.contains("bt-busy");
    // 语言识别跳过也算“部分未完成”；用户取消后不继续显示旧失败徽标。
    const incomplete = !busy && !STATE.pagePaused && (!!STATE.lastError || STATE.languageNoticeCount > 0);
    if (fabWrap) {fabWrap.classList.toggle("bt-has-error", incomplete);fabWrap.classList.toggle("bt-page-paused",STATE.visibilityPaused&&!STATE.pagePaused&&STATE.pageStarted);}

    if (!fabWrap) return;
    fabWrap.classList.toggle("bt-translated", translated && !busy && !incomplete && !STATE.visibilityPaused && !STATE.pagePaused && !STATE.cancelRequested);
    if (fabEl) fabEl.title = translated ? "点击取消翻译" : "点击翻译";
  }

  // 划词弹窗
  let popupEl = null;
  /**
   * 创建选中文字的原译文弹层，锚点优先选区矩形，无锚点时在视口中部定位。
   * 模板中的原译文经过 HTML 转义；界面限制在视口内，点击外部关闭并注销点击监听。
   * 展示弹层不改变整页翻译状态。
   * @param {string} original 用户选中的原文。
   * @param {string} translation 已收到的纯文本译文。
   * @param {Object|null} anchorRect 请求前保存的选区位置快照。
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
   * 转义用于 HTML 模板的文本中的 &、尖括号和引号，避免作为标签或属性解析。
   * 只用于展示文本，不是任意 HTML 清洗器，也不能用于构造 URL 或执行代码。
   * @returns {string} 可以插入文本位置的转义结果。
   */
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );
  }

  // 启动
  let visibleTranslateTimer = null;
  let initialTranslateTimer = null;
  let pendingViewport = false;

  /**
   * 读取文档级可见性，不等于某一段文字是否进入视口。
   * 无 document 的测试环境视作可见；真实网页使用 document.hidden。
   * @returns {boolean} 当前标签页文档是否可见。
   */
  function isPageVisible(){return typeof document==="undefined"||!document.hidden;}
  /**
   * 向后台报告可见性、阅读位置和递增状态版本，供排队优先级和临时暂停使用。
   * 回调读取 runtime.lastError 以吞掉页面离开时接收方消失的错误；不包含网页文本。
   */
  function notifyPageState(){
    STATE.pageStateVersion++;
    try{
      chrome.runtime.sendMessage({action:MSG.SET_PAGE_STATE,visible:isPageVisible(),
        stateVersion:STATE.pageStateVersion,viewportEpoch:STATE.viewportEpoch},()=>{void chrome.runtime.lastError;});
    }catch(_){}
  }
  /**
   * 只绑定一次 visibilitychange/pageshow/pagehide，区分临时不可见与真正离开文档。
   * 隐藏时撤销补翻计时并报告暂停；返回时唤醒在途页面队列，但用户已取消则不能恢复会话。
   * pagehide.persisted 表示进入浏览器往返缓存，只暂停新发送；其他离开情况取消当前页批次。
   */
  function bindPageLifecycle(){
    if(pageLifecycleBound)return;
    pageLifecycleBound=true;
    const update=()=>{
      STATE.visibilityPaused=!isPageVisible();notifyPageState();
      if(STATE.visibilityPaused){
        clearTimeout(visibleTranslateTimer);visibleTranslateTimer=null;setFabBusy(false);
      }else{
        if(activePageRun)activePageRun.pump();
        setFabBusy(STATE.translating);
        if(!STATE.pagePaused&&(STATE.pageStarted||STATE.autoTranslate)){
          wholePageScan=true;scheduleVisibleTranslation();
        }
      }
      if(panelModalEl)refreshPanelModal();
    };
    document.addEventListener("visibilitychange",update);
    window.addEventListener("pagehide",event=>{
      if(event.persisted){
        STATE.visibilityPaused=true;
        STATE.pageStateVersion++;
        try{chrome.runtime.sendMessage({action:MSG.SET_PAGE_STATE,visible:false,stateVersion:STATE.pageStateVersion,viewportEpoch:STATE.viewportEpoch},()=>{void chrome.runtime.lastError;});}catch(_){}
      }else cancelTranslation();
    });
    window.addEventListener("pageshow",update);
    STATE.visibilityPaused=!isPageVisible();notifyPageState();
  }

  /**
   * 撤销尚未执行的首次自动启动；本页还没有启动会话时，也撤销补翻计时和待扫描标志。
   * 不清除已有译文或停止已启动会话，关闭自动启动偏好后当前页仍可持续补翻直到明确取消。
   */
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
   * 将滚动、尺寸与网页变化合并为 220ms 后的一次补翻调度，执行时再次检查暂停和可见性。
   * 空闲时开启自动轮次，已有页面调度器时向同轮队列追加，否则记下待处理视口标志。
   * 这里只决定何时采集/入队，不绕过后台请求频率和并发限制。
   */
  function scheduleVisibleTranslation() {
    debugLog("[页知译] 合并补翻触发", {dirtyRegions:dirtyRoots.size,wholePageScan});
    // 已取消的页面不自动重启；将连续触发的事件合并为一次可见区域扫描。
    if ((!STATE.pageStarted && !STATE.autoTranslate) || STATE.cancelRequested || STATE.pagePaused || !isPageVisible()) return;
    if (visibleTranslateTimer) clearTimeout(visibleTranslateTimer);
    visibleTranslateTimer = setTimeout(() => {
      visibleTranslateTimer = null;
      // 定时等待期间用户可能已取消，执行时必须再次检查。
      if ((!STATE.pageStarted && !STATE.autoTranslate) || STATE.pagePaused || STATE.cancelRequested || !isPageVisible()) return;
      if (!STATE.translating) translatePage(false, true);
      else if(activePageRun)activePageRun.enqueue();
      else pendingViewport = true;
    }, 220);
  }
  window.addEventListener("scroll", () => { STATE.viewportEpoch++;notifyPageState();wholePageScan = true; scheduleVisibleTranslation(); }, { passive: true, capture: true });
  window.addEventListener("resize", () => { wholePageScan = true; scheduleVisibleTranslation(); }, { passive: true });

  /**
   * 解包一条原文容器、移除译文及记录，并把恢复后的父区域标记为需重新采集。
   * 混合区间还移除临时片段容器，移动原节点以保留现有交互状态。
   * 它是失效清理与主动还原共用的 DOM 工具；是否禁止立即补翻由调用方另行登记。
   * @param {Element} el 翻译记录对应的完整段落或片段容器。
   * @param {Object} entry 原文/译文节点和源文字快照。
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
   * 观察新增/移除节点、文字和部分可见性属性，按受影响区域合并补翻。
   * 先记录涉及的已译祖先及被移除子树，再排除插件界面和纯插件节点变动，避免自触发循环。
   * 原文快照或节点归属失效时先恢复旧包装；dirtyRoots 去掉被祖先覆盖的重复扫描根。
   * 仅监听指定属性及展开/动画结束事件，不逐次 DOM 变化立即全页翻译。
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
    // attributeFilter 不包含插件自用 data-bt-processed，减少状态标记造成的观察噪声。
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
   * 先加载配置；失败时关闭本次自动启动并记录说明，仍允许用户打开界面检查设置。
   * 等待可挂载时机后创建悬浮球、生命周期、Shift 和动态观察器，再按偏好延迟 500ms 自动启动。
   * 启动定时器执行时再次检查偏好与暂停；另有 1.5 秒悬浮球兜底，createFab 自身保证幂等。
   */
  async function bootstrap() {
    try { await reloadConfig(); } catch (error) {
      STATE.autoTranslate = false;
      STATE.lastError = "读取配置失败，请打开设置检查：" + error.message;
    }
    // 页面已有可挂载节点后再初始化悬浮球、观察器及自动翻译。
    const start = () => {
      createFab();
      bindPageLifecycle();
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
