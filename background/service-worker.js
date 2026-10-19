// ============================================================
// 后台服务工作线程：接收翻译请求，统一访问翻译接口
// ============================================================
importScripts(
  "../core/constants.js",
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
      title: "翻译选中文字",
      contexts: ["selection"]
    });
  });
});

// ============ 扩展图标 → 打开控制面板 ============
chrome.action.onClicked.addListener((tab) => {
  if (!tab || !tab.id) return;
  safeSendToTab(tab.id, { action: MSG.OPEN_PANEL });
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
 * 向指定标签页发送消息；内容脚本不可用时静默结束。
 */
async function safeSendToTab(tabId, message) {
  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch (e) {
    // 静默失败（受限页面）
  }
}

/**
 * 优先激活已打开的扩展页面，没有现有标签页时再创建。
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

// 任务按发起页面和批次隔离；取消不会影响其他标签页。
const requestGroups = new Map();
/**
 * 按标签页、框架、文档和批次生成隔离键，防止取消操作跨页面生效。
 */
function groupKey(sender,token) {
  return JSON.stringify([sender.tab?.id,sender.frameId,sender.documentId||sender.url,token]);
}
/**
 * 构造主动取消异常，供消息响应和运行时识别取消结果。
 */
function cancelledError() {const error=new Error("翻译已取消");error.name="AbortError";return error;}
/**
 * 在异步处理前登记批次控制器，确保取消能覆盖仍在读取配置的请求。
 */
async function trackedTranslate(request,sender) {
  const key=groupKey(sender,request.runToken);
  let group=requestGroups.get(key);
  if(!group){group={cancelled:false,controllers:new Set()};requestGroups.set(key,group);}
  if(group.cancelled)throw cancelledError();
  const controller=new AbortController();group.controllers.add(controller);
  try{return await handleTranslate(request,controller.signal);}
  finally {
    group.controllers.delete(controller);
    if(!group.controllers.size&&!group.cancelled)requestGroups.delete(key);
  }
}
/**
 * 取消当前页面指定批次并短暂保留取消标记，拦截尚未登记的旧消息。
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
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const { action } = request;

  if (action === MSG.CANCEL_TRANSLATION_REQUESTS) {
    cancelRequestGroup(request,sender);sendResponse({ok:true});return false;
  }
  if (action === MSG.TRANSLATE) {
    trackedTranslate(request,sender)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => sendResponse({ ok: false, error: err.message, code:err.code, cancelled:err.name==="AbortError" }));
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
const translationRuntime=self.BT_CREATE_TRANSLATION_RUNTIME(dispatchTranslation);
/**
 * 校验请求、解析实际目标语言并取得配置快照，检查接口权限后交给共享运行时。
 */
async function handleTranslate(request, signal) {
  if(signal?.aborted)throw cancelledError();
  const {engine,text,from="auto"}=request;
  const to=self.BT_CONST.resolveTargetLanguage(request.to);
  if(!["google","baidu","ai","mymemory"].includes(engine))throw new Error("不支持的翻译引擎");
  if(typeof text!=="string"||!text.trim()||text.length>10000)throw new Error("翻译文本为空或过长");
  const normalized={engine,text,from,to,retryManual:request.retryManual===true,retryToken:request.retryToken,signal};
  if(engine==="ai") {
    const stored=await self.BT_STORAGE.get(["aiProvider","aiKeys"]);
    normalized.aiProvider=request.aiProvider||stored.aiProvider||"openai";
    normalized.aiConfig={...(request.aiConfig||(stored.aiKeys||{})[normalized.aiProvider]||{})};
    const endpoint=self.BT_AI_ACCESS.getEndpoint(normalized.aiProvider,normalized.aiConfig);
    if(!await chrome.permissions.contains({origins:[endpoint.origin]}))throw new Error("尚未授权访问接口域名（"+endpoint.host+"），请到设置页测试连接并允许访问");
  }
  if(engine==="baidu")normalized.baiduConfig=await self.BT_STORAGE.get(["baiduAppId","baiduKey"]);
  if(signal?.aborted)throw cancelledError();
  return translationRuntime.run(normalized);
}
/**
 * 按引擎分发请求，并把同一个取消信号传递到实际网络调用。
 */
async function dispatchTranslation({engine,text,from,to,aiProvider,aiConfig,baiduConfig,signal}) {
  switch(engine) {
    case "google":return translateGoogle(text,from,to,signal);
    case "baidu":return translateBaidu(text,from,to,baiduConfig,signal);
    case "ai":return translateAI(text,from,to,aiProvider,aiConfig,signal);
    case "mymemory":return translateMyMemory(text,from,to,signal);
  }
}

/**
 * 调用 Google 翻译端点并校验响应结构，返回合并后的译文字符串。
 */
async function translateGoogle(text, from, to, signal) {
  const url =
    "https://translate.googleapis.com/translate_a/single?client=gtx" +
    "&sl=" + from + "&tl=" + to + "&dt=t&q=" + encodeURIComponent(text);
  const res = await fetchWithTimeout(url,{signal});
  if (!res.ok) throw new Error("Google 翻译请求失败：" + res.status);
  const data = await res.json();
  if (!Array.isArray(data) || !Array.isArray(data[0])) {
    throw new Error("Google 翻译返回格式异常");
  }
  return data[0].map((item) => (item && item[0]) || "").join("");
}

/**
 * 必要时先检测源语言，再调用 MyMemory；无法可靠识别时要求手动指定。
 */
async function translateMyMemory(text, from, to, signal) {
  if (from === "auto") from = await self.BT_LANG.detectSourceLanguage(text);
  // 同语种内容无需请求翻译，直接交给前端的相同译文去重逻辑跳过。
  if (from.toLowerCase() === to.toLowerCase()) return text;
  const url = "https://api.mymemory.translated.net/get?q=" +
    encodeURIComponent(text) + "&langpair=" + from + "|" + to;
  const res = await fetchWithTimeout(url,{signal});
  if (!res.ok) throw new Error("MyMemory 翻译请求失败：" + res.status);
  const data = await res.json();
  if (data && data.responseStatus && Number(data.responseStatus) >= 400) {
    throw new Error("MyMemory 翻译服务返回错误：" + (data.responseDetails || data.responseStatus));
  }
  const translated = data && data.responseData && data.responseData.translatedText;
  if (typeof translated !== "string" || !translated.trim()) {
    throw new Error("MyMemory 翻译返回内容为空或格式异常");
  }
  return translated;
}

/**
 * 转换百度语言代码并生成接口签名，使用本轮凭据快照发送请求。
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
  const res = await fetchWithTimeout("https://fanyi-api.baidu.com/api/trans/vip/translate?" + params,{signal});
  if (!res.ok) throw new Error("百度翻译请求失败：" + res.status);
  const data = await res.json();
  if (data.error_code) throw new Error("百度翻译：" + data.error_msg);
  if (!Array.isArray(data.trans_result)) throw new Error("百度翻译返回格式异常");
  return data.trans_result.map((r) => r.dst || "").join("\n");
}

/**
 * 使用指定厂商配置调用兼容接口，构造翻译指令并校验返回的译文。
 */
async function translateAI(text, from, to, requestedProvider, requestedConfig, signal) {
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

  const res = await fetchWithTimeout(base + "/chat/completions", {
    signal,
    method: "POST",
    headers: headers,
    body: JSON.stringify({
      model: model,
      messages: [
        {
          role: "system",
          content: "你是一个专业翻译引擎。请把用户输入从 " + (from === "auto" ? "自动识别的源语言" : from) + " 翻译成 " + (to === "zh-CN" ? "简体中文" : to === "zh-TW" ? "繁體中文" : to) + "，只输出译文，不要解释、不要引号。"
        },
        { role: "user", content: text }
      ]
    })
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error("AI 翻译请求失败：" + res.status + (errText ? " " + errText.slice(0, 200) : ""));
  }
  const data = await res.json();
  const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("AI 翻译返回内容为空或格式异常");
  }
  return content.trim();
}

// 为网络请求设置超时，避免服务无响应时持续占用翻译任务；结束后释放定时器。
/**
 * 封装网络请求的超时、主动取消与中文错误；错误信息不包含请求中的敏感查询参数。
 *
 * @param {string} url 请求地址。
 * @param {Object} options fetch 配置，可包含外部取消信号。
 * @param {number} timeoutMs 等待 fetch 返回响应的超时时间，默认 30000 毫秒。
 * @returns {Promise<Response>} 响应对象；正文读取由调用方执行。
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const externalSignal=options.signal;
  let timedOut=false;
  const abort=()=>controller.abort();
  if(externalSignal?.aborted)controller.abort();
  else externalSignal?.addEventListener("abort",abort,{once:true});
  const timer = setTimeout(() => {timedOut=true;controller.abort();}, timeoutMs);
  try {
    // 组合信号在收到响应头后仍可取消响应体读取，避免长流式响应继续占用连接。
    const signal = externalSignal && typeof AbortSignal !== "undefined" && AbortSignal.any
      ? AbortSignal.any([controller.signal,externalSignal]) : controller.signal;
    return await fetch(url, { ...options, signal });
  } catch (error) {
    if (error && error.name === "AbortError") {
      if(!timedOut&&externalSignal?.aborted)throw cancelledError();
      throw new Error(`请求超时（${timeoutMs / 1000} 秒），请检查网络或服务配置`);
    }
    // 浏览器通常不向脚本暴露连接失败的具体原因；只显示域名，避免泄露请求参数或密钥。
    if (error && error.name === "TypeError") {
      let host = "翻译接口";
      try { host = new URL(url).hostname; } catch (_) {}
      throw new Error(`无法连接翻译服务（${host}）：请检查网络或代理、接口地址及扩展的网站访问权限。浏览器未提供具体原因。`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort",abort);
  }
}
