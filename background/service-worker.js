// ============================================================
// 后台服务工作线程：接收页面消息，统一调度并调用翻译接口。
//
// 普通翻译调用链：
// 页面 TRANSLATE → trackedTranslate 登记取消控制器 → handleTranslate 校验/读取配置
// → translationRuntime.runText 分块、缓存、去重、排队及重试
// → dispatchTranslation 选择引擎 → translate* 发出 HTTP 请求 → 返回纯文本译文。
//
// 职责边界：网页采集、译文插入与控制面板由 content/content.js 负责；
// 请求频率、并发、缓存及重试算法由 core/translation-runtime.js 和 request-policy.js 负责。
// 本文件连接上述模块，并处理权限、配置快照、页面生命周期和厂商响应格式。
//
// 注意：MV3 后台可能被浏览器停止并重新启动。下方 Map/调度器属于本轮后台内存，
// 不代表持久化数据；用户配置及百度验证结果通过共享存储层单独保存。
// ============================================================
// 按依赖顺序装载全局模块：常量/存储、保护标记、请求预算、厂商/权限、签名、语言、运行时。
// 这里不加载远程脚本；所有导入文件均随扩展安装包提供。
importScripts(
  "../core/constants.js",
  "../core/translation-units.js",
  "../core/request-policy.js",
  "../core/providers.js",
  "../core/md5.js",
  "../core/languages.js",
  "../core/translation-runtime.js"
);

const { MSG } = self.BT_CONST;

// ============ 右键菜单 ============
chrome.runtime.onInstalled.addListener(() => {
  // 安装或更新时先清理旧菜单，避免重复创建相同标识的菜单项。
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

// ============ 扩展图标 → 切换控制面板显隐 ============
chrome.action.onClicked.addListener((tab) => {
  if (!tab || !tab.id) return;
  // 后台不保存面板是否打开，由当前页面依据真实面板实例决定打开或关闭。
  // toggle 仅用于工具栏入口；其他 OPEN_PANEL 消息仍表示“确保打开”，避免查看详情时反而关掉。
  safeSendToTab(tab.id, { action: MSG.OPEN_PANEL, toggle: true });
});

// ============ 右键菜单 ============
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

// ============ 快捷键（chrome.commands）============
// 历史消息名 TOGGLE_PANEL 实际切换的是整页翻译状态，并非控制面板显隐。
// 不与工具栏点击复用，避免打开/关闭面板时意外开始或取消翻译。
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-translation") return;

  // 检查用户是否启用了快捷键
  const { shortcutTranslate } = await chrome.storage.sync.get(["shortcutTranslate"]);
  if (shortcutTranslate === false) return;

  // 向当前活动标签页发送切换消息
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs && tabs[0] && tabs[0].id) {
      safeSendToTab(tabs[0].id, { action: MSG.TOGGLE_PANEL });
    }
  });
});

// ============ 工具 ============
/**
 * 向指定标签页发送单向控制消息，不在后台直接操作网页 DOM。
 * chrome:// 等受限页面、尚未注入内容脚本或已关闭的标签页可能没有接收方，
 * 此类入口操作静默结束，避免一次图标点击生成未处理的 Promise 拒绝。
 *
 * @param {number} tabId 接收消息的浏览器标签页 ID。
 * @param {Object} message 含 action 的控制消息；不是翻译 HTTP 请求体。
 * @returns {Promise<void>} 发送结束，不向调用方传播接收方缺失错误。
 */
async function safeSendToTab(tabId, message) {
  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch (e) {
    // 静默失败（受限页面）
  }
}

/**
 * 复用已打开的扩展页面：按完整扩展 URL 查找，激活标签页并聚焦其窗口。
 * 只有查询不到现有标签页才新建，减少用户反复点击设置造成的重复页面。
 * 这只是入口复用，不阻止用户通过复制地址等方式主动打开多个设置页。
 *
 * @param {string} relativePath 安装包内页面路径，例如 settings/settings.html。
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

// 批次登记表：groupKey → { owner, cancelled, controllers: Set<AbortController> }。
// 每个页面请求先登记，再读取配置；取消可覆盖正在等待存储/权限检查的异步请求。
// 控制器属于消费者，不直接代表独占网络连接；共享请求如何中止由运行时判断，
// 只有不再有消费者需要某个物理请求时，运行时才会中止它。
const requestGroups = new Map();
// 百度验证以凭据指纹标识同一配置，以独立 attempt 对象区分同凭据的先后两次测试。
// latestBaiduTests 只认可最新一次测试，baiduVerificationWrite 将存储写入串行化，
// 防止旧测试迟到、跨设置页并发操作或测试期间改密钥造成验证结果覆盖。
const latestBaiduTests = new Map();
let baiduVerificationWrite = Promise.resolve();

// 页面可见性只暂停排队发送；新文档或关闭标签页则取消旧文档消费者。
const currentDocuments = new Map(), retiredOwners = new Set();
let requestPolicyRevision = 0;
/**
 * 生成文档消费者标识。标签页、框架、文档三层隔离，刷新后的新文档拥有新的身份。
 * 无 documentId 时使用发送方 URL；扩展设置页没有 tab 时使用 extension 作为回退。
 * 该标识仅用于内部归属，不写入诊断日志。
 * @param {Object} sender Chrome 消息发送方，不能替换为网页传入的任意身份。
 * @returns {string} 可作为 Map 键的序列化身份。
 */
function ownerKey(sender) {
  return JSON.stringify([sender.tab?.id ?? "extension",sender.frameId || 0,sender.documentId || sender.url || "extension"]);
}
/**
 * 清理某个旧文档的所有批次，通知运行时移除该消费者。
 * 用于文档被替换或标签页关闭；与仅暂停新发送的“页面不可见”不同。
 * @param {string} owner ownerKey 生成的消费者标识。
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
 * 登记发送方的当前文档，并取消同一标签页/框架下已被替换的旧文档。
 * retiredOwners 拒绝旧文档迟到的消息，避免刷新后旧任务重新入队；
 * 仅保留最近 256 项退役记录，限制后台长期运行时的内存占用。
 * @returns {string} 本次消息所属的 owner 标识。
 * @throws {Error} 已退役文档抛出 AbortError，按取消处理而不是接口失败。
 */
function registerOwner(sender) {
  const owner=ownerKey(sender);
  if(retiredOwners.has(owner))throw cancelledError();
  if(sender.tab?.id!=null&&sender.documentId){
    const frame=JSON.stringify([sender.tab.id,sender.frameId || 0]);
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
 * 将限流/退避等运行状态发回发起请求的文档，不广播给整个标签页的其他文档。
 * runToken 让内容脚本忽略旧翻译批次的迟到消息；页面消失导致发送失败时静默结束。
 * @param {Object} data 运行时提供的等待原因、尝试次数等状态字段。
 */
function emitRequestState(sender,request,data) {
  if(sender.tab?.id==null||!chrome.tabs?.sendMessage)return;
  const target=sender.documentId?{documentId:sender.documentId}:{frameId:sender.frameId || 0};
  chrome.tabs.sendMessage(sender.tab.id,{action:MSG.TRANSLATION_REQUEST_STATE,runToken:request.runToken,...data},target).catch(()=>{});
}

/**
 * debug 级别允许时，将阶段和耗时同时发送到后台控制台与发起页面的控制台。
 * clientId 对应页面任务，运行时还会提供 taskId/requestId 以关联分片和物理请求。
 * data 必须只含运行时约定的诊断字段，禁止传入源文本、译文、密钥或完整请求对象。
 * 诊断只是观察信息，不参与重试、限流、面板成功状态或缓存决策。
 */
function emitTranslationDiagnostic(sender,request,data) {
  if(!self.BT_LOG.isEnabled("debug"))return;
  const diagnostic={clientId:request.diagnosticId,...data};
  self.BT_LOG.debug("[页知译][诊断]",diagnostic);
  if(sender.tab?.id==null||!chrome.tabs?.sendMessage)return;
  const target=sender.documentId?{documentId:sender.documentId}:{frameId:sender.frameId || 0};
  chrome.tabs.sendMessage(sender.tab.id,{action:MSG.TRANSLATION_DIAGNOSTIC,runToken:request.runToken,diagnostic},target).catch(()=>{});
}

/**
 * 在文档身份之上加入 runToken，将一次翻译操作的请求归为同一可取消批次。
 * runToken 变化后，新任务不受旧批次的取消标记影响。
 * @param {Object} sender 浏览器提供的发送方信息。
 * @param {string} token 内容脚本生成的翻译批次标识。
 * @returns {string} requestGroups 使用的批次键。
 */
function groupKey(sender,token) {
  return JSON.stringify([sender.tab?.id,sender.frameId,sender.documentId||sender.url,token]);
}
/**
 * 构造主动取消异常，供消息响应和运行时识别取消结果。
 */
function cancelledError() {const error=new Error("翻译已取消");error.name="AbortError";return error;}
/**
 * 为每个消息请求登记独立 AbortController，然后进入配置校验和翻译流程。
 * 必须先登记、后 await；否则用户取消时可能漏掉仍在读取存储的旧请求。
 * finally 中注销本次控制器；全部正常结束才移除批次，已取消批次继续保留拦截标记。
 * @param {Object} request 页面或设置页发来的请求，包含 runToken 和翻译参数。
 * @param {Object} sender Chrome 消息发送方，用于文档/批次隔离。
 * @returns {Promise<string>} 最终译文；异常交由消息入口转换为结构化响应。
 */
async function trackedTranslate(request,sender) {
  const key=groupKey(sender,request.runToken);
  let group=requestGroups.get(key);
  if(!group){group={cancelled:false,controllers:new Set(),owner:registerOwner(sender)};requestGroups.set(key,group);}
  if(group.cancelled)throw cancelledError();
  const controller=new AbortController();group.controllers.add(controller);
  try{return await handleTranslate(request,controller.signal,sender);}
  finally {
    group.controllers.delete(controller);
    if(!group.controllers.size&&!group.cancelled)requestGroups.delete(key);
  }
}
/**
 * 取消发送方的指定批次：先设置 cancelled，再中止该批次所有消费者控制器。
 * 即使批次尚无请求，也创建取消记录，拦截已发出但尚未执行登记的旧消息。
 * 记录保留 5 分钟；定时清理只删除同一个记录，不能误删同键后续创建的其他记录。
 * 该操作不清除页面 DOM、不修改用户偏好，页面恢复原文由内容脚本完成。
 */
function cancelRequestGroup(request,sender) {
  const key=groupKey(sender,request.runToken);
  const group=requestGroups.get(key)||{controllers:new Set()};
  group.cancelled=true;requestGroups.set(key,group);
  for(const controller of group.controllers)controller.abort();
  // 保留取消标记，阻止已经发出、尚未登记的旧消息重新启动。
  setTimeout(()=>{if(requestGroups.get(key)===group)requestGroups.delete(key);},300000);
}

// ============ 消息处理 ============
// 响应约定：成功 {ok:true,data?}；失败 {ok:false,error,code,...}；取消另带 cancelled。
// 同步分支 sendResponse 后返回 false。异步翻译/测试分支必须返回 true，
// 让 Chrome 保持消息通道，等待 Promise 完成后再回传；不能仅启动异步任务就退出通道。
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const { action } = request;
  // 页面隐藏只暂停新发送，在途结果仍可完成；文档替换/关闭则由 owner 生命周期取消。
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
    // 只有扩展设置页的测试按钮可以登记验证结果，网页翻译不能自行标记通过。
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
  // 普通网页请求强制 verifyBaidu=false，不能借消息字段把普通翻译伪装成连接测试。
  // 错误分类保留给页面决定提示与后续补翻，不把 AbortError 当作服务故障。
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

  // 打开 Chrome 快捷键设置页
  if (action === "OPEN_SHORTCUTS_SETTINGS") {
    chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
    sendResponse({ ok: true });
    return false;
  }
});

// ============ 翻译调度 ============
// 后台本轮生命周期共用一个运行时，跨标签页共享账号额度、进行中请求和缓存。
// 它是异步请求队列，不是为每段文字创建操作系统线程的线程池。
const translationRuntime=self.BT_CREATE_TRANSLATION_RUNTIME(dispatchTranslation);
chrome.storage.onChanged?.addListener((changes,area)=>{
  if(area==="local"&&changes.requestPolicies){
    // 配置发生变化时提高版本号；较早启动的存储读取不能覆盖这里已收到的新策略。
    requestPolicyRevision++;
    translationRuntime.updatePolicies(changes.requestPolicies.newValue || {});
  }
});
// 标签页关闭后无需保留其消费者；其他页面仍在使用的共享网络请求由运行时保留。
chrome.tabs?.onRemoved?.addListener(tabId=>{
  for(const [frame,record] of currentDocuments)if(record.tabId===tabId){
    cancelOwner(record.owner);retiredOwners.add(record.owner);currentDocuments.delete(frame);
  }
  while(retiredOwners.size>256)retiredOwners.delete(retiredOwners.values().next().value);
});
/**
 * 将外部消息转换为运行时请求：校验引擎/文本、解析目标语言、登记页面状态、读取配置。
 * AI 和百度使用本轮配置快照，避免排队期间切换服务或修改密钥后，请求混用新旧配置。
 * 策略读取带 revision 检查，防止异步旧读覆盖 storage.onChanged 提供的新请求限制。
 * Shift 等主动单段 priority=0，普通页面任务 priority=1；具体排队顺序由运行时决定。
 * @param {Object} request 原始消息参数；目标语言跟随浏览器时在此解析为实际语种。
 * @param {AbortSignal} signal 本次消费者的取消信号，配置读取结束后还需再次检查。
 * @param {Object} sender 浏览器提供的发送方信息。
 * @returns {Promise<string>} 正常请求走 runText；百度验证走独立的真实连接测试流程。
 */
async function handleTranslate(request, signal, sender = {}) {
  if(signal?.aborted)throw cancelledError();
  const {engine,text,from="auto"}=request;
  const to=self.BT_CONST.resolveTargetLanguage(request.to);
  if(!["google","baidu","ai","mymemory"].includes(engine))throw new Error("不支持的翻译引擎");
  if(typeof text!=="string"||!text.trim()||text.length>self.BT_REQUEST_POLICY.LIMITS.maxTextLength)throw new Error("翻译文本为空或过长");
  const owner=registerOwner(sender);
  translationRuntime.setOwnerState(owner,{visible:request.pageVisible!==false,viewportEpoch:request.viewportEpoch,version:request.stateVersion});
  const revision=requestPolicyRevision;
  const stored=await self.BT_STORAGE.get(["aiProvider","aiKeys","baiduAppId","baiduKey","baiduVerification","requestPolicies"]);
  if(revision===requestPolicyRevision)translationRuntime.updatePolicies(stored.requestPolicies || {});
  const normalized={engine,text,from,to,retryManual:request.retryManual===true,retryToken:request.retryToken,signal,
    ownerKey:owner,pageVisible:request.pageVisible!==false,viewportEpoch:request.viewportEpoch,
    priority:request.priority===0?0:1,onRetry:data=>emitRequestState(sender,request,data),
    onDiagnostic:self.BT_LOG.isEnabled("debug")?data=>emitTranslationDiagnostic(sender,request,data):undefined};
  if(engine==="ai") {
    normalized.aiProvider=request.aiProvider||stored.aiProvider||"openai";
    normalized.aiConfig={...(request.aiConfig||(stored.aiKeys||{})[normalized.aiProvider]||{})};
    const endpoint=self.BT_AI_ACCESS.getEndpoint(normalized.aiProvider,normalized.aiConfig);
    normalized.aiConfig.base=endpoint.base;
    if(!await chrome.permissions.contains({origins:[endpoint.origin]}))throw new Error("尚未授权访问接口域名（"+endpoint.host+"），请到设置页测试连接并允许访问");
  }
  if (engine === "baidu") {
    normalized.baiduConfig = { baiduAppId: stored.baiduAppId, baiduKey: stored.baiduKey };
    if (request.verifyBaidu) {
      const expected = self.BT_CONST.getBaiduCredentialFingerprint(request.baiduTestCredentials);
      if (!expected || expected !== self.BT_CONST.getBaiduCredentialFingerprint(stored)) {
        throw new Error("百度凭据已变化，请重新测试连接");
      }
      // 测试必须实际访问接口，不能用之前的缓存结果宣称当前凭据可用。
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
 * 以固定测试文字调用百度，成功后仅为本轮真实凭据登记本机验证结果。
 * 同一凭据只接受最新 attempt；写入前重新读取当前凭据，防止测试结果验证了另一套配置。
 * 取消不撤销已有成功结果，真实失败可清除仍对应当前配置的验证记录。
 * @param {Object} request 已校验、带凭据快照/取消信号且绕过缓存的运行时请求。
 * @returns {Promise<string>} 接口返回的测试译文；只有成功登记后才向设置页报告成功。
 */
async function testBaiduConnection(request) {
  const fingerprint = self.BT_CONST.getBaiduCredentialFingerprint(request.baiduConfig);
  const attempt = {};
  latestBaiduTests.set(fingerprint, attempt);

  /**
   * 所有验证写入接在同一 Promise 链后执行；上一笔写入失败不阻塞下一笔。
   * 校验在排到写入机会时重新进行，而不是只在网络请求开始时检查。
   * @param {Object|null} record 成功记录，或表示作废当前验证的 null。
   * @returns {Promise<boolean>} true 表示实际完成写入；false 表示本次测试已过期。
   */
  function saveVerification(record) {
    const write = baiduVerificationWrite.catch(() => {}).then(async () => {
      if (latestBaiduTests.get(fingerprint) !== attempt) return false;
      if (request.signal?.aborted) throw cancelledError();
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
    const data = await translationRuntime.run(request);
    if (request.signal?.aborted) throw cancelledError();
    if (!await saveVerification({ fingerprint, verifiedAt: Date.now() })) {
      throw new Error("凭据或测试任务已变化，请查看最新测试结果");
    }
    return data;
  } catch (error) {
    // 取消不是验证失败，不撤销之前的成功记录；过期测试也不能覆盖更新的结果。
    if (error.name !== "AbortError" && !request.signal?.aborted) await saveVerification(null);
    throw error;
  } finally {
    if (latestBaiduTests.get(fingerprint) === attempt) latestBaiduTests.delete(fingerprint);
  }
}

/**
 * 运行时在获得频率和并发名额后调用此函数，每次代表一个分片的物理执行。
 * 此处只选择厂商适配器，不重复排队、分块或自行循环重试。
 * signal 属于共享请求的执行生命周期；单个页面取消是否需要中止它由运行时判断。
 * @returns {Promise<string>} 当前分片的纯文本译文，交运行时合并和回传。
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
 * 调用 Google 文本翻译端点，用 URL 编码保护 q 参数中的空格、符号和换行。
 * 该端点返回嵌套数组，data[0] 中每项第一列是译文片段；按响应顺序拼接为纯文本。
 * HTTP 错误交共享分类器，正文读取使用同一超时截止时间及取消信号。
 * @param {string} text 运行时已按字符/字节预算切分的文本，不是整页 HTML。
 * @param {string} from 源语言代码，auto 交服务端识别。
 * @param {string} to 已解析的目标语言代码。
 * @param {AbortSignal} signal 当前物理请求的取消信号。
 * @returns {Promise<string>} 合并后的当前分片译文。
 */
async function translateGoogle(text, from, to, signal) {
  const url =
    "https://translate.googleapis.com/translate_a/single?client=gtx" +
    "&sl=" + from + "&tl=" + to + "&dt=t&q=" + encodeURIComponent(text);
  const res = await fetchWithTimeout(url,{signal});
  if (!res.ok) throw self.BT_REQUEST_POLICY.httpError("Google 翻译",res);
  const data = await self.BT_REQUEST_POLICY.readJson(res,signal);
  if (!Array.isArray(data) || !Array.isArray(data[0])) {
    throw new Error("Google 翻译返回格式异常");
  }
  return data[0].map((item) => (item && item[0]) || "").join("");
}

/**
 * MyMemory 需要明确的 langpair；源语言为 auto 时先由语言模块尝试可靠识别。
 * 识别失败向页面返回语言提示，不盲猜语种；源/目标相同则直接返回原文以供前端跳过。
 * 除 HTTP 状态外还检查正文 responseStatus，区分日额度耗尽、临时限流和其他服务拒绝。
 * 仅把规范化后的错误交运行时处理，不将服务端任意错误正文直接显示给用户。
 * @returns {Promise<string>} responseData.translatedText 中的有效译文。
 */
async function translateMyMemory(text, from, to, signal) {
  if (from === "auto") from = await self.BT_LANG.detectSourceLanguage(text);
  // 同语种内容无需请求翻译，直接交给前端的相同译文去重逻辑跳过。
  if (from.toLowerCase() === to.toLowerCase()) return text;
  const url = "https://api.mymemory.translated.net/get?q=" +
    encodeURIComponent(text) + "&langpair=" + from + "|" + to;
  const res = await fetchWithTimeout(url,{signal});
  let data;
  try{data=await self.BT_REQUEST_POLICY.readJson(res,signal);}
  catch(error){if(!res.ok&&error.name!=="AbortError"&&error.code!=="TIMEOUT")throw self.BT_REQUEST_POLICY.httpError("MyMemory 翻译",res);throw error;}
  if (!res.ok && (!Number.isFinite(Number(data?.responseStatus)) || Number(data?.responseStatus)<400)) throw self.BT_REQUEST_POLICY.httpError("MyMemory 翻译",res);
  if (data && data.responseStatus && Number(data.responseStatus) >= 400) {
    const status=Number(data.responseStatus),detail=String(data.responseDetails || "");
    const quota=/used all available|daily|quota|一天|每日/i.test(detail);
    const rate=status===429&&!quota;
    throw self.BT_REQUEST_POLICY.error(quota?"MyMemory 当日额度可能已用完，请稍后或更换服务":"MyMemory 翻译服务拒绝请求（"+status+"）",{
      code:quota?"QUOTA_EXCEEDED":rate?"RATE_LIMITED":"SERVICE_REJECTED",
      retryable:rate||status>=500,permanent:quota,retryAfterMs:self.BT_REQUEST_POLICY.retryAfter(res)
    });
  }
  const translated = data && data.responseData && data.responseData.translatedText;
  if (typeof translated !== "string" || !translated.trim()) {
    throw new Error("MyMemory 翻译返回内容为空或格式异常");
  }
  return translated;
}

/**
 * 使用本轮 AppID/密钥快照调用百度通用翻译接口，缺少快照时才读取共享存储。
 * 签名顺序固定为 AppID + 原始文本 + salt + 密钥，再取 MD5；正文编码不能改变签名原文。
 * 通用语言代码由 BT_LANG 映射到百度代码，POST 表单避免把密钥放入请求 URL。
 * 业务错误码映射为授权、额度、限流或服务错误；只标注是否可重试，由运行时统一执行。
 * @param {Object} credentials 含 baiduAppId、baiduKey 的配置快照。
 * @returns {Promise<string>} trans_result 按接口返回顺序以换行拼接的译文。
 */
async function translateBaidu(text, from, to, credentials, signal) {
  const { baiduAppId, baiduKey } = credentials || await self.BT_STORAGE.get(["baiduAppId", "baiduKey"]);
  if (!baiduAppId || !baiduKey) throw new Error("未配置百度翻译 AppID / 密钥");

  const salt = Date.now().toString();
  const sign = self.md5(baiduAppId + text + salt + baiduKey);

  const params = new URLSearchParams({
    q: text,
    from: self.BT_LANG.mapLanguage("baidu", from),
    to: self.BT_LANG.mapLanguage("baidu", to),
    appid: baiduAppId,
    salt: salt,
    sign: sign
  });
  const res = await fetchWithTimeout("https://fanyi-api.baidu.com/api/trans/vip/translate",{
    method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:params.toString(),signal
  });
  if (!res.ok) throw self.BT_REQUEST_POLICY.httpError("百度翻译",res);
  const data = await self.BT_REQUEST_POLICY.readJson(res,signal);
  if (data.error_code) {
    const code=String(data.error_code),rate=code==="54003"||code==="54005",auth=code==="52003"||code==="54001",quota=code==="54004";
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
 * 使用 OpenAI 兼容的 /chat/completions 协议调用指定 AI 厂商。
 * 厂商/配置以传入快照优先，缺失时才回退到存储；模型以用户填写值优先，再用厂商默认值。
 * 先校验端点与域名权限；Ollama 不强制密钥，其他服务使用 Authorization Bearer 凭据。
 * 提示词要求只输出译文；存在保护标记时附加保留约束，代码实际值仍只留在页面本地。
 * 当前采用非流式整包读取：完整 JSON 返回后提取 message.content，不逐 Token 显示。
 * 这里未显式设置各厂商的思考开关，模型是否思考取决于服务端默认行为。
 * @param {string} requestedProvider 可选厂商 ID。
 * @param {Object} requestedConfig 本轮 base/key/model 快照，禁止输出到诊断日志。
 * @param {AbortSignal} signal 当前物理请求取消信号。
 * @param {Function} reportDiagnostic 可选阶段回调，仅回报耗时和 HTTP 状态。
 * @returns {Promise<string>} 非空的最终译文，不返回 reasoning_content 等其他字段。
 */
async function translateAI(text, from, to, requestedProvider, requestedConfig, signal, reportDiagnostic) {
  const { aiProvider, aiKeys } = await self.BT_STORAGE.get(["aiProvider", "aiKeys"]);

  const provider = requestedProvider || aiProvider || "openai";
  const keys = requestedConfig || (aiKeys && aiKeys[provider]) || {};
  const isOllama = provider === "ollama";

  if (!isOllama && !keys.key) {
    throw new Error("未配置 AI API Key，请在设置页填写");
  }

  const providerDefaults = (self.AI_PROVIDERS && self.AI_PROVIDERS[provider]) || {};
  const fallbackModel = provider === "custom" ? "gpt-4o-mini" : (providerDefaults.model || "gpt-4o-mini");
  const endpoint = self.BT_AI_ACCESS.getEndpoint(provider, keys);
  const base = endpoint.base;
  // 后台不能自行弹出授权；缺少权限时提示用户回设置页主动授权。
  if (!await chrome.permissions.contains({ origins: [endpoint.origin] })) {
    throw new Error("尚未授权访问接口域名（" + endpoint.host + "），请到设置页点击测试连接或启用服务并允许访问");
  }
  const model = keys.model || fallbackModel;

  const headers = { "Content-Type": "application/json" };
  if (!isOllama && keys.key) headers["Authorization"] = "Bearer " + keys.key;

  // 响应头耗时包含网络连接与服务端等待；完整 HTTP 耗时还包括响应正文传输/读取。
  // 两者都不是精确的模型首 Token 耗时，不能直接据此断言模型生成速度。
  const httpStartedAt=Date.now();
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
  const headersAt=Date.now();
  reportDiagnostic?.("http_headers",{headersMs:headersAt-httpStartedAt,status:res.status});
  if (!res.ok) {
    const payload=await self.BT_REQUEST_POLICY.readJson(res,signal).catch(()=>null);
    const code=String(payload?.error?.code || payload?.error?.type || "");
    const quota=res.status===402||/insufficient_quota|billing_hard_limit|balance/i.test(code);
    if(quota)throw self.BT_REQUEST_POLICY.error("AI 服务额度或余额不足，请检查账号",{code:"QUOTA_EXCEEDED",permanent:true,retryable:false});
    throw self.BT_REQUEST_POLICY.httpError("AI 翻译",res);
  }
  const data = await self.BT_REQUEST_POLICY.readJson(res,signal);
  reportDiagnostic?.("http_complete",{httpMs:Date.now()-httpStartedAt,bodyMs:Date.now()-headersAt,status:res.status});
  const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("AI 翻译返回内容为空或格式异常");
  }
  return content.trim();
}

// 为网络请求设置超时，避免服务无响应时持续占用翻译任务；结束后释放定时器。
/**
 * 为 fetch 创建内部超时控制器，并与调用方主动取消信号组合。
 * 主动取消抛出 AbortError；超时抛出可重试的 TIMEOUT；连接失败抛出 NETWORK_ERROR。
 * HTTP 4xx/5xx 本身不会在此抛错，需保留 Response 给各厂商读取业务错误并分类。
 * 返回响应时附带 __btDeadline 和 __btAbort，供 BT_REQUEST_POLICY.readJson 沿用同一
 * 截止时间读取正文；收到响应头不代表整个请求已完成，也不会获得第二份完整超时预算。
 *
 * @param {string} url 请求地址。
 * @param {Object} options fetch 配置，可包含外部取消信号。
 * @param {number} timeoutMs 从请求发起到正文读取共用的超时预算，默认 30000 毫秒。
 * @returns {Promise<Response>} 响应对象；正文读取由调用方执行。
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const externalSignal=options.signal;
  let timedOut=false;
  const deadline=Date.now()+timeoutMs;
  const abort=()=>controller.abort();
  if(externalSignal?.aborted)controller.abort();
  else externalSignal?.addEventListener("abort",abort,{once:true});
  const timer = setTimeout(() => {timedOut=true;controller.abort();}, timeoutMs);
  try {
    // 组合信号在收到响应头后仍可取消响应体读取，避免长流式响应继续占用连接。
    const signal = externalSignal && typeof AbortSignal !== "undefined" && AbortSignal.any
      ? AbortSignal.any([controller.signal,externalSignal]) : controller.signal;
    const response=await fetch(url, { ...options, signal });
    // 内部元数据不进入服务响应正文；若 Response 不可扩展，仍返回它供上层处理。
    try {Object.defineProperties(response,{__btDeadline:{value:deadline},__btAbort:{value:()=>controller.abort()}});}catch(_){}
    return response;
  } catch (error) {
    if (error && error.name === "AbortError") {
      if(!timedOut&&externalSignal?.aborted)throw cancelledError();
      throw Object.assign(new Error(`请求超时（${timeoutMs / 1000} 秒），请检查网络或服务配置`),{code:"TIMEOUT",retryable:true});
    }
    // 浏览器通常不向脚本暴露连接失败的具体原因；只显示域名，避免泄露请求参数或密钥。
    if (error && error.name === "TypeError") {
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
