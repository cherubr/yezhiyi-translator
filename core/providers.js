// ============================================================
// AI 厂商列表 —— 全局唯一来源
// ============================================================
(function (global) {
  "use strict";

  const AI_PROVIDERS = {
    openai:      { name: "OpenAI",         base: "https://api.openai.com/v1",                             model: "gpt-4o-mini",              hint: "官方 API，需科学上网" },
    deepseek:    { name: "DeepSeek",       base: "https://api.deepseek.com/v1",                           model: "deepseek-chat",            hint: "性价比高，国内直连" },
    dashscope:   { name: "通义千问",         base: "https://dashscope.aliyuncs.com/compatible-mode/v1",     model: "qwen-turbo",               hint: "阿里百炼，送额度" },
    zhipu:       { name: "智谱 GLM",        base: "https://open.bigmodel.cn/api/paas/v4",                 model: "glm-4-flash",              hint: "有免费模型" },
    moonshot:    { name: "Kimi",           base: "https://api.moonshot.cn/v1",                            model: "kimi-k2.5",                hint: "Kimi 新一代模型；如账号仅开放旧模型可手动修改" },
    volcengine:  { name: "火山方舟",         base: "https://ark.cn-beijing.volces.com/api/v3",             model: "doubao-seed-1-8",          hint: "字节豆包" },
    minimax:     { name: "MiniMax",        base: "https://api.minimax.chat/v1",                           model: "MiniMax-Text-01",          hint: "百万上下文" },
    stepfun:     { name: "阶跃星辰",         base: "https://api.stepfun.com/v1",                            model: "step-1-8k",                hint: "国产多模态" },
    siliconflow: { name: "硅基流动",         base: "https://api.siliconflow.cn/v1",                         model: "Qwen/Qwen2.5-7B-Instruct", hint: "200+ 模型" },
    qianfan:     { name: "百度千帆",         base: "https://qianfan.baidubce.com/v2",                       model: "ernie-4.0-turbo-8k",       hint: "文心一言" },
    modelscope:  { name: "魔搭 ModelScope", base: "https://api-inference.modelscope.cn/v1",               model: "Qwen/Qwen2.5-7B-Instruct", hint: "阿里达摩院" },
    longcat:     { name: "LongCat",        base: "https://api.longcat.chat/openai/v1",                    model: "LongCat-Flash-Chat",       hint: "长文本模型" },
    ollama:      { name: "Ollama",         base: "http://localhost:11434/v1",                           model: "qwen2.5:7b",               hint: "本地无需 Key" },
    custom:      { name: "自定义",           base: "",                                                       model: "",                         hint: "手动填写" }
  };

  // 统一解析请求地址和授权域名，保证设置页申请的权限与后台实际访问地址一致。
  /**
   * 校验并规范化接口基础地址，返回实际 base、权限匹配 origin 及提示用 host。
   */
  function getAIEndpoint(provider, config = {}) {
    const defaults = AI_PROVIDERS[provider] || {};
    const base = (config.base || defaults.base || "https://api.openai.com/v1").trim().replace(/\/+$/, "");
    let url;
    try { url = new URL(base); } catch (_) { throw new Error("接口地址无效，请填写完整的 HTTP 或 HTTPS 地址"); }
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error("接口地址仅支持 HTTP/HTTPS，且不能包含账号密码、查询参数或片段");
    }
    return { base, origin: url.protocol + "//" + url.host + "/*", host: url.hostname };
  }

  /**
   * 从用户点击调用链申请当前接口域名权限，返回解析后的地址；拒绝授权时抛出中文错误。
   */
  function requestAIAccess(provider, config) {
    const endpoint = getAIEndpoint(provider, config);
    // 必须在按钮点击调用链中直接发起，不能先等待存储或网络操作，以免丢失用户手势。
    // 已授予的域名由浏览器直接确认；每次只申请当前接口的域名。
    return chrome.permissions.request({ origins: [endpoint.origin] }).then(granted => {
      if (!granted) throw new Error("未获得接口域名访问权限（" + endpoint.host + "），请重新点击测试或启用并允许访问");
      return endpoint;
    });
  }
  const BT_AI_ACCESS = { getEndpoint: getAIEndpoint, request: requestAIAccess };
  if (typeof self !== "undefined") self.BT_AI_ACCESS = BT_AI_ACCESS;
  if (typeof window !== "undefined") window.BT_AI_ACCESS = BT_AI_ACCESS;

  const AI_PROVIDER_NAMES = Object.fromEntries(
    Object.entries(AI_PROVIDERS).map(([k, v]) => [k, v.name])
  );

  if (typeof self !== "undefined") {
    self.AI_PROVIDERS = AI_PROVIDERS;
    self.AI_PROVIDER_NAMES = AI_PROVIDER_NAMES;
  }
  if (typeof window !== "undefined") {
    window.AI_PROVIDERS = AI_PROVIDERS;
    window.AI_PROVIDER_NAMES = AI_PROVIDER_NAMES;
  }
})(typeof self !== "undefined" ? self : this);