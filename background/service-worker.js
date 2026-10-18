// ============================================================
// 后台服务工作线程：接收翻译请求，统一访问翻译接口
// ============================================================
importScripts(
  "../core/constants.js",
  "../core/providers.js",
  "../core/md5.js"
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
async function safeSendToTab(tabId, message) {
  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch (e) {
    // 静默失败（受限页面）
  }
}

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

// ============ 消息处理 ============
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const { action } = request;

  if (action === MSG.TRANSLATE) {
    handleTranslate(request)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
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
async function handleTranslate({ engine, text, from = "auto", to = "zh-CN", aiProvider, aiConfig }) {
  // 根据请求指定的引擎分发，接口调用集中在后台，结果通过消息返回网页。
  switch (engine) {
    case "google":   return translateGoogle(text, from, to);
    case "baidu":    return translateBaidu(text, from, to);
    case "ai":       return translateAI(text, from, to, aiProvider, aiConfig);
    case "mymemory":
    default:         return translateMyMemory(text, from, to);
  }
}

async function translateGoogle(text, from, to) {
  const url =
    "https://translate.googleapis.com/translate_a/single?client=gtx" +
    "&sl=" + from + "&tl=" + to + "&dt=t&q=" + encodeURIComponent(text);
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error("Google 翻译请求失败：" + res.status);
  const data = await res.json();
  if (!Array.isArray(data) || !Array.isArray(data[0])) {
    throw new Error("Google 翻译返回格式异常");
  }
  return data[0].map((item) => (item && item[0]) || "").join("");
}

async function translateMyMemory(text, from, to) {
  const url = "https://api.mymemory.translated.net/get?q=" +
    encodeURIComponent(text) + "&langpair=" + from + "|" + to;
  const res = await fetchWithTimeout(url);
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

async function translateBaidu(text, from, to) {
  const { baiduAppId, baiduKey } = await self.BT_STORAGE.get(["baiduAppId", "baiduKey"]);
  if (!baiduAppId || !baiduKey) throw new Error("未配置百度翻译 AppID / 密钥");

  const salt = Date.now().toString();
  const sign = self.md5(baiduAppId + text + salt + baiduKey);

  const params = new URLSearchParams({
    q: text,
    from: from,
    to: to === "zh-CN" ? "zh" : to,
    appid: baiduAppId,
    salt: salt,
    sign: sign
  });
  const res = await fetchWithTimeout("https://fanyi-api.baidu.com/api/trans/vip/translate?" + params);
  if (!res.ok) throw new Error("百度翻译请求失败：" + res.status);
  const data = await res.json();
  if (data.error_code) throw new Error("百度翻译：" + data.error_msg);
  if (!Array.isArray(data.trans_result)) throw new Error("百度翻译返回格式异常");
  return data.trans_result.map((r) => r.dst || "").join("\n");
}

async function translateAI(text, from, to, requestedProvider, requestedConfig) {
  const { aiProvider, aiKeys } = await self.BT_STORAGE.get(["aiProvider", "aiKeys"]);

  const provider = requestedProvider || aiProvider || "openai";
  const keys = requestedConfig || (aiKeys && aiKeys[provider]) || {};
  const isOllama = provider === "ollama";

  if (!isOllama && !keys.key) {
    throw new Error("未配置 AI API Key，请在设置页填写");
  }

  const providerDefaults = (self.AI_PROVIDERS && self.AI_PROVIDERS[provider]) || {};
  const fallbackBase = provider === "custom" ? "https://api.openai.com/v1" : (providerDefaults.base || "https://api.openai.com/v1");
  const fallbackModel = provider === "custom" ? "gpt-4o-mini" : (providerDefaults.model || "gpt-4o-mini");
  const base = (keys.base || fallbackBase).replace(/\/+$/, "");
  const model = keys.model || fallbackModel;

  const headers = { "Content-Type": "application/json" };
  if (!isOllama && keys.key) headers["Authorization"] = "Bearer " + keys.key;

  const res = await fetchWithTimeout(base + "/chat/completions", {
    method: "POST",
    headers: headers,
    body: JSON.stringify({
      model: model,
      messages: [
        {
          role: "system",
          content: "你是一个专业翻译引擎。请把用户输入从 " + from + " 翻译成 " + to + "，只输出译文，不要解释、不要引号。"
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
async function fetchWithTimeout(url, options = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error && error.name === "AbortError") {
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
  }
}
