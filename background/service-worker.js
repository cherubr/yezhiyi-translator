/**
 * 加载扩展包内的共享脚本，向当前后台上下文注册配置、权限、语言和调度能力。
 */
importScripts(
  "../core/constants.js",
  "../core/translation-units.js",
  "../core/request-policy.js",
  "../core/providers.js",
  "../core/md5.js",
  "../core/languages.js",
  "../core/translation-runtime.js"
);

// 消息动作常量，供后台与内容脚本使用同一套指令名。
const { MSG } = self.BT_CONST;

/**
 * 安装或更新时重新注册整页翻译和选中文字翻译菜单；菜单点击另由 onClicked 处理。
 */
chrome.runtime.onInstalled.addListener(() => {

  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "translatePage",
      title: "页知译 · 翻译此页面",
      contexts: ["page"]
    });
    chrome.contextMenus.create({
      id: "translateSelection",
      title: "页知译 · 翻译选中文字",
      contexts: ["selection"]
    });
  });
});

/**
 * 工具栏图标入口：通知当前网页切换面板显隐，由内容脚本判断面板真实状态。
 * @param {Object} tab 用户点击图标时所在标签页。
 */
chrome.action.onClicked.addListener((tab) => {
  if (!tab || !tab.id) return;

  safeSendToTab(tab.id, { action: MSG.OPEN_PANEL, toggle: true });
});

/**
 * 右键菜单入口：把开始整页翻译或选中文字翻译的指令发送给当前页面。
 * @param {Object} info 包含 menuItemId 与 selectionText。
 * @param {Object} tab 触发菜单的标签页。
 */
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "translatePage") {
    safeSendToTab(tab.id, { action: MSG.START_TRANSLATION });
  } else if (info.menuItemId === "translateSelection") {
    safeSendToTab(tab.id, {
      action: MSG.TRANSLATE_SELECTION,
      text: info.selectionText
    });
  }
});

/**
 * 响应 Chrome 翻译快捷命令；尊重启用偏好，并向活动页面发送整页翻译切换指令。
 * @param {string} command Manifest 中登记的命令名；TOGGLE_PANEL 是历史翻译切换消息名。
 */
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-translation") return;

  // 用户保存的快捷键启用偏好；只有显式 false 时禁用。
  const { shortcutTranslate } = await chrome.storage.sync.get(["shortcutTranslate"]);
  if (shortcutTranslate === false) return;

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs && tabs[0] && tabs[0].id) {
      safeSendToTab(tabs[0].id, { action: MSG.TOGGLE_PANEL });
    }
  });
});

/**
 * 向指定标签页发送控制指令；页面不存在或尚未注入内容脚本时忽略发送失败。
 * @param {number} tabId 接收指令的标签页编号。
 * @param {Object} message 包含 action 及该指令需要的数据。
 * @returns {Promise<void>} 消息发送结束；失败不会继续向调用方抛出。
 */
async function safeSendToTab(tabId, message) {
  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch (e) {

  }
}

/**
 * 打开扩展内部页面；已有同地址标签页时，激活它并聚焦所属窗口。
 * @param {string} relativePath 相对于扩展根目录的页面路径。
 * @returns {void} 通过 Chrome 回调完成查询和打开。
 */
function openExtensionPage(relativePath) {
  const url = chrome.runtime.getURL(relativePath);
  chrome.tabs.query({ url }, (tabs) => {
    if (tabs && tabs.length > 0) {
      chrome.tabs.update(tabs[0].id, { active: true });
      chrome.windows.update(tabs[0].windowId, { focused: true });
    } else {
      chrome.tabs.create({ url });
    }
  });
}

// 批次表：key 对应 owner、cancelled 和消费者控制器集合；属于本轮后台内存。
const requestGroups = new Map();

// 凭据指纹与最新测试身份的映射，阻止旧测试回写结果。
const latestBaiduTests = new Map();
// 百度验证写入队列的末尾 Promise，使多次结果写入依次执行。
let baiduVerificationWrite = Promise.resolve();

// 当前框架文档映射；retiredOwners 保存最近退役的文档身份，最多 256 项。
const currentDocuments = new Map(), retiredOwners = new Set();

// 请求策略更新计数，用于阻止较早的异步存储读取覆盖新策略。
let requestPolicyRevision = 0;

/**
 * 生成文档身份，用于隔离不同页面及刷新前后的请求。
 * @param {Object} sender Chrome 提供的发送方，使用 tab.id、frameId、documentId 或 URL。
 * @returns {string} 序列化的文档身份；缺少 documentId 时使用 URL 回退。
 */
function ownerKey(sender) {
  return JSON.stringify([sender.tab?.id ?? "extension",sender.frameId || 0,sender.documentId || sender.url || "extension"]);
}

/**
 * 取消指定文档登记的全部批次，并清理运行时中的文档状态。
 * @param {string} owner ownerKey 生成的文档身份。
 * @returns {void} 同步触发取消；共享网络请求是否中止由运行时决定。
 */
function cancelOwner(owner) {
  for(const [key,group] of requestGroups)if(group.owner===owner){
    group.cancelled=true;
    for(const controller of group.controllers)controller.abort();
    requestGroups.delete(key);
  }
  translationRuntime.removeOwner(owner);
}

/**
 * 登记当前文档；同一标签页和框架出现新 documentId 时，取消并标记旧文档。
 * @param {Object} sender 浏览器提供的发送方身份；不能用请求正文伪造。
 * @returns {string} 当前文档的 owner 标识。
 * @throws {Error} 已退役文档抛出 AbortError，阻止迟到请求重新入队。
 */
function registerOwner(sender) {
  const owner=ownerKey(sender);
  if(retiredOwners.has(owner))throw cancelledError();
  if(sender.tab?.id!=null&&sender.documentId){
    // 标签页与框架的组合键，用于查找刷新前的文档。
    const frame=JSON.stringify([sender.tab.id,sender.frameId || 0]);
    // 同一框架上次登记的文档；身份变化时取消其请求。
    const previous=currentDocuments.get(frame);
    if(previous&&previous.owner!==owner){
      cancelOwner(previous.owner);retiredOwners.add(previous.owner);
      while(retiredOwners.size>256)retiredOwners.delete(retiredOwners.values().next().value);
    }
    currentDocuments.set(frame,{owner,tabId:sender.tab.id});
  }
  return owner;
}

/**
 * 把等待、退避等请求状态发回原文档，runToken 用于过滤旧批次通知。
 * @param {Object} sender 原请求的标签页、文档或框架身份。
 * @param {Object} request 原消息，使用其中的 runToken。
 * @param {Object} data 运行时给出的等待原因、次数等状态。
 * @returns {void} 无标签页或发送失败时忽略通知。
 */
function emitRequestState(sender,request,data) {
  if(sender.tab?.id==null||!chrome.tabs?.sendMessage)return;
  // 优先精确发送到 documentId；缺少文档编号时回退到 frameId。
  const target=sender.documentId?{documentId:sender.documentId}:{frameId:sender.frameId || 0};
  chrome.tabs.sendMessage(sender.tab.id,{action:MSG.TRANSLATION_REQUEST_STATE,runToken:request.runToken,...data},target).catch(()=>{});
}

/**
 * 在 debug 级别下输出后台诊断，并将同一份诊断发送给原文档。
 * @param {Object} sender 原请求的接收方定位信息。
 * @param {Object} request 使用 diagnosticId 关联页面任务、runToken 关联批次。
 * @param {Object} data 仅允许阶段、耗时和数量等诊断字段，禁止包含文字或凭据。
 * @returns {void} 日志关闭时直接结束，不影响翻译结果。
 */
function emitTranslationDiagnostic(sender,request,data) {
  if(!self.BT_LOG.isEnabled("debug"))return;
  // 页面任务编号与运行时诊断字段的组合，不能包含正文或密钥。
  const diagnostic={clientId:request.diagnosticId,...data};
  self.BT_LOG.debug("[页知译][诊断]",diagnostic);
  if(sender.tab?.id==null||!chrome.tabs?.sendMessage)return;
  // 原请求所属文档，避免刷新后的页面收到旧任务日志。
  const target=sender.documentId?{documentId:sender.documentId}:{frameId:sender.frameId || 0};
  chrome.tabs.sendMessage(sender.tab.id,{action:MSG.TRANSLATION_DIAGNOSTIC,runToken:request.runToken,diagnostic},target).catch(()=>{});
}

/**
 * 组合文档身份与批次标识，让取消仅影响本页面的这一轮翻译。
 * @param {Object} sender 原消息发送方的 tab、frame 和 document 信息。
 * @param {string} token 内容脚本生成的 runToken。
 * @returns {string} requestGroups 的批次索引。
 */
function groupKey(sender,token) {
  return JSON.stringify([sender.tab?.id,sender.frameId,sender.documentId||sender.url,token]);
}

/**
 * 创建主动取消异常；页面根据 AbortError 区分取消与服务失败。
 * @returns {Error} name 为 AbortError 的新异常对象。
 */
function cancelledError() {const error=new Error("翻译已取消");error.name="AbortError";return error;}

/**
 * 先登记消费者取消控制器，再执行翻译；结束时移除控制器，保留已取消批次的标记。
 * @param {Object} request 页面或设置页的翻译消息。
 * @param {Object} sender 用于文档和批次隔离的浏览器上下文。
 * @returns {Promise<string>} 译文；异常由消息监听器转换为响应。
 * @throws {Error} 已取消批次抛出 AbortError，配置或接口错误继续向上传播。
 */
async function trackedTranslate(request,sender) {
  const key=groupKey(sender,request.runToken);
  // 当前批次记录；cancelled 标志在任务结束后仍可拦截迟到请求。
  let group=requestGroups.get(key);
  if(!group){group={cancelled:false,controllers:new Set(),owner:registerOwner(sender)};requestGroups.set(key,group);}
  if(group.cancelled)throw cancelledError();

  // 本消息消费者的取消控制器；登记后才开始异步配置读取。
  const controller=new AbortController();group.controllers.add(controller);
  try{return await handleTranslate(request,controller.signal,sender);}
  finally {
    group.controllers.delete(controller);
    if(!group.controllers.size&&!group.cancelled)requestGroups.delete(key);
  }
}

/**
 * 取消指定批次的消费者；即使尚未登记请求，也保留五分钟标记拦截迟到消息。
 * @param {Object} request 包含待取消的 runToken。
 * @param {Object} sender 取消操作所属文档。
 * @returns {void} 不处理网页 DOM，也不修改用户的自动翻译偏好。
 */
function cancelRequestGroup(request,sender) {
  const key=groupKey(sender,request.runToken);
  // 已有批次或新建取消记录；控制器集合可以为空。
  const group=requestGroups.get(key)||{controllers:new Set()};
  group.cancelled=true;requestGroups.set(key,group);
  for(const controller of group.controllers)controller.abort();

  setTimeout(()=>{if(requestGroups.get(key)===group)requestGroups.delete(key);},300000);
}

/**
 * 后台消息入口：处理可见性、批次取消、百度测试、翻译和打开设置。
 * 成功响应为 {ok:true,data?}，失败为 {ok:false,error,code,...}，取消另带 cancelled。
 * 翻译和测试异步分支返回 true 保持响应通道；同步分支回复后返回 false。
 * 百度测试只接受设置页来源，固定测试文字；普通 TRANSLATE 强制关闭 verifyBaidu。
 * @param {Object} request 发送方消息，action 指定用途。
 * @param {Object} sender Chrome 提供的来源及文档身份。
 * @param {Function} sendResponse 回传本条消息的结果。
 * @returns {boolean|undefined} 是否保留异步响应通道；未识别消息不处理。
 */
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const { action } = request;

  if(action===MSG.SET_PAGE_STATE) {
    try {
      const owner=registerOwner(sender);

      translationRuntime.setOwnerState(owner,{visible:request.visible,viewportEpoch:request.viewportEpoch,version:request.stateVersion});
      sendResponse({ok:true});
    } catch (_) {sendResponse({ok:false,cancelled:true});}
    return false;
  }

  if (action === MSG.CANCEL_TRANSLATION_REQUESTS) {
    cancelRequestGroup(request,sender);sendResponse({ok:true});return false;
  }
  if (action === MSG.TEST_BAIDU_CONNECTION) {

    if (sender.url !== chrome.runtime.getURL("settings/settings.html")) {
      sendResponse({ ok: false, error: "请从扩展设置页测试百度连接" });
      return false;
    }

    trackedTranslate({ ...request, engine: "baidu", verifyBaidu: true,
      text: "Hello world", from: "en", to: "zh-CN" }, sender)
      .then(data => sendResponse({ ok: true, data }))
      .catch(err => sendResponse({ ok: false, error: err.message, code: err.code }));
    return true;
  }

  if (action === MSG.TRANSLATE) {
    trackedTranslate({ ...request, verifyBaidu: false },sender)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => sendResponse({ ok: false, error: err.message, code:err.code, retryable:err.retryable, permanent:err.permanent, exhausted:err.exhausted, cancelled:err.name==="AbortError" }));
    return true;
  }

  if (action === MSG.OPEN_SETTINGS) {
    openExtensionPage("settings/settings.html");
    sendResponse({ ok: true });
    return false;
  }

  if (action === "OPEN_SHORTCUTS_SETTINGS") {
    chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
    sendResponse({ ok: true });
    return false;
  }
});

// 本后台生命周期共用的调度器，负责限速、缓存、去重和有限重试。
const translationRuntime=self.BT_CREATE_TRANSLATION_RUNTIME(dispatchTranslation);
/**
 * 监听本机请求策略变化，更新运行时限制并递增版本，避免旧存储读取覆盖新值。
 * @param {Object} changes 字段到 oldValue/newValue 的映射。
 * @param {string} area 存储区域，只处理 local 中的 requestPolicies。
 */
chrome.storage.onChanged?.addListener((changes,area)=>{
  if(area==="local"&&changes.requestPolicies){

    requestPolicyRevision++;
    translationRuntime.updatePolicies(changes.requestPolicies.newValue || {});
  }
});

/**
 * 标签页关闭后取消其已登记文档，并限制退役身份集合大小；其他页面的共享请求仍由运行时管理。
 * @param {number} tabId 被关闭标签页的编号。
 */
chrome.tabs?.onRemoved?.addListener(tabId=>{
  for(const [frame,record] of currentDocuments)if(record.tabId===tabId){
    cancelOwner(record.owner);retiredOwners.add(record.owner);currentDocuments.delete(frame);
  }
  while(retiredOwners.size>256)retiredOwners.delete(retiredOwners.values().next().value);
});

/**
 * 校验消息、读取配置快照并提交运行时；百度连接测试进入独立验证流程。
 * @param {Object} request 原始翻译消息。
 * @param {string} request.engine google、baidu、mymemory 或 ai。
 * @param {string} request.text 待翻译文字，不能为空或超过最大长度。
 * @param {string} [request.from="auto"] 源语言；自动识别由具体服务适配器处理。
 * @param {string} [request.to] 目标语言；browser 在此转换为实际语种。
 * @param {string} [request.aiProvider] AI 厂商；未提供时读取保存值。
 * @param {Object} [request.aiConfig] 当前 AI 的 base/key/model 快照。
 * @param {number} [request.priority] 0 为主动任务，其他值统一视为普通任务。
 * @param {boolean} [request.verifyBaidu] 由消息入口控制的百度测试标志。
 * @param {AbortSignal} signal 本消费者的取消信号，异步读取后再次检查。
 * @param {Object} [sender={}] 页面文档身份及消息来源。
 * @returns {Promise<string>} 当前文字任务的最终译文。
 */
async function handleTranslate(request, signal, sender = {}) {
  if(signal?.aborted)throw cancelledError();
  const {engine,text,from="auto"}=request;
  // 将跟随浏览器解析为实际目标语言后的结果。
  const to=self.BT_CONST.resolveTargetLanguage(request.to);
  if(!["google","baidu","ai","mymemory"].includes(engine))throw new Error("不支持的翻译引擎");
  if(typeof text!=="string"||!text.trim()||text.length>self.BT_REQUEST_POLICY.LIMITS.maxTextLength)throw new Error("翻译文本为空或过长");
  const owner=registerOwner(sender);
  translationRuntime.setOwnerState(owner,{visible:request.pageVisible!==false,viewportEpoch:request.viewportEpoch,version:request.stateVersion});

  // 开始读取存储时的策略版本快照。
  const revision=requestPolicyRevision;
  // 共享存储读取的凭据、验证结果和请求策略。
  const stored=await self.BT_STORAGE.get(["aiProvider","aiKeys","baiduAppId","baiduKey","baiduVerification","requestPolicies"]);
  if(revision===requestPolicyRevision)translationRuntime.updatePolicies(stored.requestPolicies || {});

  // 提交运行时的请求快照，附带可见性、优先级、重试及诊断回调。
  const normalized={engine,text,from,to,retryManual:request.retryManual===true,retryToken:request.retryToken,signal,
    ownerKey:owner,pageVisible:request.pageVisible!==false,viewportEpoch:request.viewportEpoch,
    priority:request.priority===0?0:1,onRetry:data=>emitRequestState(sender,request,data),
    onDiagnostic:self.BT_LOG.isEnabled("debug")?data=>emitTranslationDiagnostic(sender,request,data):undefined};
  if(engine==="ai") {
    normalized.aiProvider=request.aiProvider||stored.aiProvider||"openai";

    normalized.aiConfig={...(request.aiConfig||(stored.aiKeys||{})[normalized.aiProvider]||{})};
    // 解析后的 AI 地址及对应权限匹配模式。
    const endpoint=self.BT_AI_ACCESS.getEndpoint(normalized.aiProvider,normalized.aiConfig);
    normalized.aiConfig.base=endpoint.base;
    if(!await chrome.permissions.contains({origins:[endpoint.origin]}))throw new Error("尚未授权访问接口域名（"+endpoint.host+"），请到设置页测试连接并允许访问");
  }
  if (engine === "baidu") {

    normalized.baiduConfig = { baiduAppId: stored.baiduAppId, baiduKey: stored.baiduKey };
    if (request.verifyBaidu) {
      // 设置页待测试凭据的指纹，必须与当前保存凭据一致。
      const expected = self.BT_CONST.getBaiduCredentialFingerprint(request.baiduTestCredentials);
      if (!expected || expected !== self.BT_CONST.getBaiduCredentialFingerprint(stored)) {
        throw new Error("百度凭据已变化，请重新测试连接");
      }

      normalized.bypassCache = true;
    } else if (!self.BT_CONST.hasVerifiedBaiduCredentials(stored)) {
      throw new Error("百度翻译尚未通过连接测试，请到设置页测试成功后再使用");
    }
  }

  if(signal?.aborted)throw cancelledError();
  if (request.verifyBaidu) return testBaiduConnection(normalized);
  return translationRuntime.runText(normalized);
}

/**
 * 真实调用百度接口，并仅为仍有效的最新测试保存验证结果；测试绕过缓存。
 * @param {Object} request 包含百度凭据快照、signal 和 bypassCache 的内部请求。
 * @returns {Promise<string>} 完成验证结果写入后返回的测试译文。
 * @throws {Error} 网络失败、取消、凭据变化或测试已被更新时拒绝成功。
 */
async function testBaiduConnection(request) {
  // 当前 AppID 与 Key 的一致性指纹，不保存原始密钥。
  const fingerprint = self.BT_CONST.getBaiduCredentialFingerprint(request.baiduConfig);

  // 本次测试的唯一对象身份，用于区分相同凭据的先后两次测试。
  const attempt = {};
  latestBaiduTests.set(fingerprint, attempt);

  /**
   * 串行写入百度验证结果；写入前核对最新测试身份和当前凭据，避免旧结果覆盖新配置。
   * @param {Object|null} record 成功时为 fingerprint/verifiedAt；null 表示作废验证。
   * @returns {Promise<boolean>} true 为已写入，false 为本次测试已过期。
   */
  function saveVerification(record) {
    // 串接在上次写入之后的操作；上次失败不会阻塞此次写入。
    const write = baiduVerificationWrite.catch(() => {}).then(async () => {
      if (latestBaiduTests.get(fingerprint) !== attempt) return false;
      if (request.signal?.aborted) throw cancelledError();
      // 实际获得写入机会后重新读取的百度凭据。
      const current = await self.BT_STORAGE.get(["baiduAppId", "baiduKey"]);
      if (request.signal?.aborted) throw cancelledError();
      if (latestBaiduTests.get(fingerprint) !== attempt ||
          fingerprint !== self.BT_CONST.getBaiduCredentialFingerprint(current)) return false;

      await chrome.storage.local.set({ baiduVerification: record });
      return true;
    });
    baiduVerificationWrite = write;
    return write;
  }

  try {

    // 绕过缓存真实请求得到的测试译文，验证记录写入成功后才返回。
    const data = await translationRuntime.run(request);
    if (request.signal?.aborted) throw cancelledError();
    if (!await saveVerification({ fingerprint, verifiedAt: Date.now() })) {
      throw new Error("凭据或测试任务已变化，请查看最新测试结果");
    }
    return data;
  } catch (error) {

    if (error.name !== "AbortError" && !request.signal?.aborted) await saveVerification(null);
    throw error;
  } finally {
    if (latestBaiduTests.get(fingerprint) === attempt) latestBaiduTests.delete(fingerprint);
  }
}

/**
 * 获得运行时发送名额后，选择当前分片对应的翻译接口，不在此重复排队或重试。
 * @param {Object} request 带引擎、文字、语言、凭据快照、取消信号及诊断回调的分片请求。
 * @returns {Promise<string>} 分片译文，交运行时合并。
 */
async function dispatchTranslation({engine,text,from,to,aiProvider,aiConfig,baiduConfig,signal,reportDiagnostic}) {
  switch(engine) {
    case "google":return translateGoogle(text,from,to,signal);
    case "baidu":return translateBaidu(text,from,to,baiduConfig,signal);
    case "ai":return translateAI(text,from,to,aiProvider,aiConfig,signal,reportDiagnostic);
    case "mymemory":return translateMyMemory(text,from,to,signal);
  }
}

/**
 * 调用 Google 翻译端点，校验嵌套数组并按响应顺序拼接译文片段。
 * @param {string} text 已按服务预算分块的文字。
 * @param {string} from 源语言，auto 交服务端识别。
 * @param {string} to 已解析的目标语言。
 * @param {AbortSignal} signal 当前共享请求的取消信号。
 * @returns {Promise<string>} 当前分片的纯文本译文。
 */
async function translateGoogle(text, from, to, signal) {
  // 包含源语种、目标语种及编码后文字的请求地址，禁止完整打印。
  const url =
    "https://translate.googleapis.com/translate_a/single?client=gtx" +
    "&sl=" + from + "&tl=" + to + "&dt=t&q=" + encodeURIComponent(text);
  // 收到响应头的 HTTP 响应；ok 只说明 HTTP 状态成功。
  const res = await fetchWithTimeout(url,{signal});
  if (!res.ok) throw self.BT_REQUEST_POLICY.httpError("Google 翻译",res);

  // 读取完整 JSON 后的数组，data[0] 各项第一列为译文。
  const data = await self.BT_REQUEST_POLICY.readJson(res,signal);
  if (!Array.isArray(data) || !Array.isArray(data[0])) {
    throw new Error("Google 翻译返回格式异常");
  }
  return data[0].map((item) => (item && item[0]) || "").join("");
}

/**
 * 构造明确语种对调用 MyMemory；同语种直接返回原文，业务失败按额度或限流分类。
 * @param {string} text 已分块文字。
 * @param {string} from 源语言；auto 先调用语言模块识别，不可靠时抛出提示。
 * @param {string} to 已解析的目标语言。
 * @param {AbortSignal} signal 当前请求的取消信号。
 * @returns {Promise<string>} 服务译文或无需翻译的原文。
 */
async function translateMyMemory(text, from, to, signal) {
  if (from === "auto") from = await self.BT_LANG.detectSourceLanguage(text);

  if (from.toLowerCase() === to.toLowerCase()) return text;
  // 携带编码后文字和明确 langpair 的请求地址。
  const url = "https://api.mymemory.translated.net/get?q=" +
    encodeURIComponent(text) + "&langpair=" + from + "|" + to;
  // HTTP 响应，同时提供状态码及 Retry-After。
  const res = await fetchWithTimeout(url,{signal});
  // 响应 JSON；错误也可能由正文 responseStatus 表达。
  let data;

  try{data=await self.BT_REQUEST_POLICY.readJson(res,signal);}
  catch(error){if(!res.ok&&error.name!=="AbortError"&&error.code!=="TIMEOUT")throw self.BT_REQUEST_POLICY.httpError("MyMemory 翻译",res);throw error;}
  if (!res.ok && (!Number.isFinite(Number(data?.responseStatus)) || Number(data?.responseStatus)<400)) throw self.BT_REQUEST_POLICY.httpError("MyMemory 翻译",res);
  if (data && data.responseStatus && Number(data.responseStatus) >= 400) {
    // 正文状态码与内部分类用错误说明 detail，不向页面透传原始说明。
    const status=Number(data.responseStatus),detail=String(data.responseDetails || "");

    // 错误说明是否指向日额度耗尽；此类错误不自动连续重试。
    const quota=/used all available|daily|quota|一天|每日/i.test(detail);
    // 仅在 429 且非日额度问题时认定为临时限流。
    const rate=status===429&&!quota;
    throw self.BT_REQUEST_POLICY.error(quota?"MyMemory 当日额度可能已用完，请稍后或更换服务":"MyMemory 翻译服务拒绝请求（"+status+"）",{
      code:quota?"QUOTA_EXCEEDED":rate?"RATE_LIMITED":"SERVICE_REJECTED",
      retryable:rate||status>=500,permanent:quota,retryAfterMs:self.BT_REQUEST_POLICY.retryAfter(res)
    });
  }
  // responseData.translatedText，必须为非空字符串。
  const translated = data && data.responseData && data.responseData.translatedText;
  if (typeof translated !== "string" || !translated.trim()) {
    throw new Error("MyMemory 翻译返回内容为空或格式异常");
  }
  return translated;
}

/**
 * 用 AppID、原始文字、salt 和 Key 计算 MD5 签名，发送表单并解析业务错误。
 * @param {string} text 同时用于签名与 q 参数的分片文字。
 * @param {string} from 通用源语言代码，发送前转换为百度代码。
 * @param {string} to 通用目标语言代码。
 * @param {Object} credentials 包含 baiduAppId、baiduKey 的配置快照。
 * @param {AbortSignal} signal 当前请求的取消信号。
 * @returns {Promise<string>} 以换行合并的 trans_result 译文；原始 Key 不发送给接口。
 */
async function translateBaidu(text, from, to, credentials, signal) {
  // 本次 AppID 与密钥快照；未传凭据时才从存储读取。
  const { baiduAppId, baiduKey } = credentials || await self.BT_STORAGE.get(["baiduAppId", "baiduKey"]);
  if (!baiduAppId || !baiduKey) throw new Error("未配置百度翻译 AppID / 密钥");

  // 本次请求的签名参与值，以当前时间字符串生成。
  const salt = Date.now().toString();
  // AppID + 原始文字 + salt + Key 的 MD5 值；Key 本身不写入请求。
  const sign = self.md5(baiduAppId + text + salt + baiduKey);

  // 百度表单字段，源/目标语种在此转换为百度代码。
  const params = new URLSearchParams({
    q: text,
    from: self.BT_LANG.mapLanguage("baidu", from),
    to: self.BT_LANG.mapLanguage("baidu", to),
    appid: baiduAppId,
    salt: salt,
    sign: sign
  });
  // 百度接口 HTTP 响应，后续仍需检查正文业务状态。
  const res = await fetchWithTimeout("https://fanyi-api.baidu.com/api/trans/vip/translate",{
    method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:params.toString(),signal
  });
  if (!res.ok) throw self.BT_REQUEST_POLICY.httpError("百度翻译",res);
  // 百度响应正文，可能包含 error_code 或 trans_result。
  const data = await self.BT_REQUEST_POLICY.readJson(res,signal);
  if (data.error_code) {

    // 百度业务码，以及限流 rate、认证 auth、额度 quota 的分类标志。
    const code=String(data.error_code),rate=code==="54003"||code==="54005",auth=code==="52003"||code==="54001",quota=code==="54004";
    // 面向用户的固定中文提示，不直接显示服务返回的任意正文。
    const message=auth?"百度翻译：账号或签名未授权，请检查 AppID、密钥及已开通服务（"+code+"）":
      quota?"百度翻译：账号额度或余额不足（"+code+"）":rate?"百度翻译：服务限制请求（"+code+"）":"百度翻译请求失败（"+code+"）";
    throw self.BT_REQUEST_POLICY.error(message,{code:auth?"AUTH_REQUIRED":quota?"QUOTA_EXCEEDED":rate?"RATE_LIMITED":"SERVICE_REJECTED",
      retryable:rate||code==="52001"||code==="52002",permanent:auth||quota,
      retryAfterMs:Math.max(code==="54005"?3000:0,self.BT_REQUEST_POLICY.retryAfter(res))});
  }
  if (!Array.isArray(data.trans_result)) throw new Error("百度翻译返回格式异常");
  return data.trans_result.map((r) => r.dst || "").join("\n");
}

/**
 * 调用 OpenAI 兼容聊天接口，等待完整 JSON 后提取最终译文，不进行流式显示。
 * @param {string} text 当前分片；页面保护的代码以内部标记代替。
 * @param {string} from 源语言或 auto，通过提示词交给模型。
 * @param {string} to 目标语言，中文代码转换成对应中文名称。
 * @param {string} requestedProvider 指定 AI 厂商，优先于已保存选择。
 * @param {Object} requestedConfig 本次 base/key/model 快照，优先于已保存配置。
 * @param {AbortSignal} signal 当前请求的取消信号。
 * @param {Function} reportDiagnostic 可选诊断回调，仅报告 HTTP 耗时和状态。
 * @returns {Promise<string>} 去除首尾空白的 message.content；不返回推理内容。
 */
async function translateAI(text, from, to, requestedProvider, requestedConfig, signal, reportDiagnostic) {

  // 当前保存的厂商及各厂商配置 aiKeys；即使有请求快照也会读取。
  const { aiProvider, aiKeys } = await self.BT_STORAGE.get(["aiProvider", "aiKeys"]);

  const provider = requestedProvider || aiProvider || "openai";
  // 本次连接配置，含 base、key、model；禁止写入日志。
  const keys = requestedConfig || (aiKeys && aiKeys[provider]) || {};
  // 本机 Ollama 标志，该模式不要求或附加 Bearer 密钥。
  const isOllama = provider === "ollama";

  if (!isOllama && !keys.key) {
    throw new Error("未配置 AI API Key，请在设置页填写");
  }

  const providerDefaults = (self.AI_PROVIDERS && self.AI_PROVIDERS[provider]) || {};
  // 未填写模型时的后备模型，自定义服务使用 gpt-4o-mini。
  const fallbackModel = provider === "custom" ? "gpt-4o-mini" : (providerDefaults.model || "gpt-4o-mini");
  // 已校验的接口地址及域名权限范围。
  const endpoint = self.BT_AI_ACCESS.getEndpoint(provider, keys);
  const base = endpoint.base;

  if (!await chrome.permissions.contains({ origins: [endpoint.origin] })) {
    throw new Error("尚未授权访问接口域名（" + endpoint.host + "），请到设置页点击测试连接或启用服务并允许访问");
  }
  const model = keys.model || fallbackModel;

  // JSON 请求头；远程服务附加 Authorization Bearer。
  const headers = { "Content-Type": "application/json" };
  if (!isOllama && keys.key) headers["Authorization"] = "Bearer " + keys.key;

  // HTTP 开始时间，不包含此前在调度器中的排队时间。
  const httpStartedAt=Date.now();
  // 非流式聊天请求的响应；未显式设置思考、Token 或温度参数。
  const res = await fetchWithTimeout(base + "/chat/completions", {
    signal,
    method: "POST",
    headers: headers,

    body: JSON.stringify({
      model: model,
      messages: [
        {
          role: "system",
          content: "你是一个专业翻译引擎。请把用户输入从 " + (from === "auto" ? "自动识别的源语言" : from) + " 翻译成 " + (to === "zh-CN" ? "简体中文" : to === "zh-TW" ? "繁體中文" : to) + "，只输出译文，不要解释、不要引号。"+
            (self.BT_TRANSLATION_UNITS.protectedRanges(text).length?"形如 ⟦YZY数字:数字⟧ 的内部标记必须逐个原样保留，不得增删、合并或解释。":"")
        },
        { role: "user", content: text }
      ]
    })
  });

  // 收到响应头的时间，用于分别统计 headersMs 和正文读取耗时。
  const headersAt=Date.now();
  reportDiagnostic?.("http_headers",{headersMs:headersAt-httpStartedAt,status:res.status});
  if (!res.ok) {

    // 错误响应 JSON；解析失败回退为 null，仅提取错误类型。
    const payload=await self.BT_REQUEST_POLICY.readJson(res,signal).catch(()=>null);
    // 服务错误 code/type，仅用于判断额度或计费问题。
    const code=String(payload?.error?.code || payload?.error?.type || "");
    // HTTP 402 或额度/余额相关错误，标记为不可自动重试。
    const quota=res.status===402||/insufficient_quota|billing_hard_limit|balance/i.test(code);
    if(quota)throw self.BT_REQUEST_POLICY.error("AI 服务额度或余额不足，请检查账号",{code:"QUOTA_EXCEEDED",permanent:true,retryable:false});
    throw self.BT_REQUEST_POLICY.httpError("AI 翻译",res);
  }
  // 完整聊天响应 JSON，读取完成后才可提取最终译文。
  const data = await self.BT_REQUEST_POLICY.readJson(res,signal);
  reportDiagnostic?.("http_complete",{httpMs:Date.now()-httpStartedAt,bodyMs:Date.now()-headersAt,status:res.status});
  // choices[0].message.content，推理字段和用量信息不用于显示。
  const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("AI 翻译返回内容为空或格式异常");
  }

  return content.trim();
}

/**
 * 为 fetch 组合超时与外部取消，分类连接错误，并把正文共用的截止时间附在 Response 上。
 * @param {string} url 接口地址，不记录完整地址或查询参数。
 * @param {Object} [options={}] fetch 参数，可携带外部 signal。
 * @param {number} [timeoutMs=30000] 响应头与正文共用的毫秒预算。
 * @returns {Promise<Response>} 响应头到达后的对象；正文仍须调用 readJson 读取。
 * @throws {Error} 主动取消为 AbortError，超时为 TIMEOUT，连接失败为 NETWORK_ERROR。
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = 30000) {

  // 内部中止控制器，供连接超时及正文读取取消使用。
  const controller = new AbortController();
  // 运行时传入的取消信号，可能因消费者取消而中止。
  const externalSignal=options.signal;
  // 是否由内部超时触发，用于区别用户取消和请求超时。
  let timedOut=false;

  // 绝对截止时间，响应正文继续使用剩余预算。
  const deadline=Date.now()+timeoutMs;
  // 将外部取消转发给内部控制器的监听函数。
  const abort=()=>controller.abort();
  if(externalSignal?.aborted)controller.abort();
  else externalSignal?.addEventListener("abort",abort,{once:true});
  // 请求阶段的超时定时器，收到响应头或失败后清理。
  const timer = setTimeout(() => {timedOut=true;controller.abort();}, timeoutMs);
  try {

    // 支持时用 AbortSignal.any 合并内外信号，否则用内部信号。
    const signal = externalSignal && typeof AbortSignal !== "undefined" && AbortSignal.any
      ? AbortSignal.any([controller.signal,externalSignal]) : controller.signal;
    // HTTP 响应，附加 __btDeadline 与 __btAbort 供 readJson 使用。
    const response=await fetch(url, { ...options, signal });

    try {Object.defineProperties(response,{__btDeadline:{value:deadline},__btAbort:{value:()=>controller.abort()}});}catch(_){}
    return response;
  } catch (error) {
    if (error && error.name === "AbortError") {
      if(!timedOut&&externalSignal?.aborted)throw cancelledError();
      throw Object.assign(new Error(`请求超时（${timeoutMs / 1000} 秒），请检查网络或服务配置`),{code:"TIMEOUT",retryable:true});
    }

    if (error && error.name === "TypeError") {
      // 只用于中文连接提示的域名，不包含请求文字或其他查询参数。
      let host = "翻译接口";
      try { host = new URL(url).hostname; } catch (_) {}
      throw Object.assign(new Error(`无法连接翻译服务（${host}）：请检查网络或代理、接口地址及扩展的网站访问权限。浏览器未提供具体原因。`),{code:"NETWORK_ERROR",retryable:true});
    }
    throw error;
  } finally {

    clearTimeout(timer);
    externalSignal?.removeEventListener("abort",abort);
  }
}
