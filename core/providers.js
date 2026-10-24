(function (global) {
  "use strict";

  // AI 厂商预设：name 为名称、base 为基础地址、model 为默认模型、hint 为界面提示。
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

  /**
   * 校验基础地址并生成与实际请求一致的域名权限范围；远程接口只允许 HTTPS。
   * @param {string} provider 厂商标识，用于读取预设地址。
   * @param {Object} [config={}] 用户配置，base 优先于预设。
   * @returns {{base:string,origin:string,host:string}} 规范化地址、权限匹配模式和提示域名。
   */
  function getAIEndpoint(provider, config = {}) {
    const defaults = AI_PROVIDERS[provider] || {};
    const base = (config.base || defaults.base || "https://api.openai.com/v1").trim().replace(/\/+$/, "");
    let url;
    try { url = new URL(base); } catch (_) { throw new Error("接口地址无效，请填写完整的 HTTP 或 HTTPS 地址"); }
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error("接口地址仅支持 HTTP/HTTPS，且不能包含账号密码、查询参数或片段");
    }
    // 远程网页文字与密钥必须通过 HTTPS 传输；仅本机回环接口允许 HTTP。
    if (url.protocol === "http:" && !["localhost","127.0.0.1"].includes(url.hostname)) {
      throw new Error("远程接口必须使用 HTTPS；HTTP 仅支持本机 localhost 或 127.0.0.1");
    }
    return { base, origin: url.protocol + "//" + url.host + "/*", host: url.hostname };
  }

  /**
   * 在用户点击调用链中请求当前接口域名授权；不得先等待其他异步操作。
   * @param {string} provider 当前厂商。
   * @param {Object} config 当前连接配置。
   * @returns {Promise<Object>} 获得授权后的端点信息；拒绝授权时抛出错误。
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

  /**
   * 统一编码服务选项；AI 厂商不是独立的翻译引擎，保存时仍拆为 engine 与 aiProvider。
   */
  function serviceValue(engine,provider) {return engine==="ai"?"ai:"+(provider||"openai"):engine;}
  /**
   * 把 ai:厂商 选项拆回 engine 与 aiProvider；普通引擎保留现有 AI 厂商选择。
   * @param {string} value 服务下拉值。
   * @param {string} [currentProvider="openai"] 普通引擎选项下保留的厂商。
   * @returns {Object} 用于保存的引擎和厂商组合。
   */
  function parseServiceValue(value,currentProvider="openai") {
    return typeof value==="string"&&value.startsWith("ai:")
      ?{engine:"ai",aiProvider:value.slice(3)}:{engine:value,aiProvider:currentProvider};
  }
  /**
   * 仅表示连接配置是否齐全；AI 密钥是否有效仍由实际测试判定。
   */
  function isProviderReady(provider,config={}) {
    if(!Object.hasOwn(AI_PROVIDERS,provider))return false;
    if(provider==="ollama")return true;
    return !!String(config.aiKeys?.[provider]?.key||"").trim();
  }
  /**
   * 判断服务是否满足界面选择条件：免配置服务直接可选，百度要求验证，AI 检查连接配置。
   * @param {string} value 普通引擎或 ai:厂商 形式的选项值。
   * @param {Object} [config={}] 当前保存配置。
   * @returns {boolean} 是否可选择，不代表网络和账号额度实时可用。
   */
  function isServiceReady(value,config={}) {
    if(value==="google"||value==="mymemory")return true;
    if(value==="baidu")return !!global.BT_CONST?.hasVerifiedBaiduCredentials(config);
    const provider=value==="ai"?config.aiProvider||"openai":typeof value==="string"&&value.startsWith("ai:")?value.slice(3):null;
    return provider?isProviderReady(provider,config):false;
  }
  /**
   * 设置页和控制面板共用目录、就绪判断及状态文案，避免只列出当前 AI 厂商。
   */
  function serviceOptions(config={}) {
    const items=[{value:"google",label:"Google 翻译"},{value:"mymemory",label:"MyMemory"},{value:"baidu",label:"百度翻译"},
      ...Object.entries(AI_PROVIDERS).map(([provider,item])=>({value:"ai:"+provider,label:item.name+(provider==="ollama"?" · 本地":" · AI")}))];
    return items.map(item=>{
      const ready=isServiceReady(item.value,config);
      const status=ready?(item.value==="google"||item.value==="mymemory"?"无需配置":item.value==="baidu"?"测试通过":item.value==="ai:ollama"?"需运行本地服务":"已配置"):
        item.value==="baidu"&&config.baiduAppId&&config.baiduKey?"待测试":"未配置";
      return {...item,ready,status,text:ready?"✓ "+item.label+"（"+status+"）":status+" · "+item.label};
    });
  }
  /**
   * 原生下拉保留键盘操作；未就绪选项真正禁用，不能仅靠颜色表示不可用。
   */
  function renderServiceSelect(select,config={}) {
    if(!select)return;
    const doc=select.ownerDocument,items=serviceOptions(config);select.replaceChildren();
    for(const [label,ready]of [["可选择 · 无需配置或已配置",true],["暂不可选 · 请先配置或测试",false]]){
      const group=doc.createElement("optgroup");group.label=label;
      for(const item of items.filter(item=>item.ready===ready)){
        const option=doc.createElement("option");option.value=item.value;option.disabled=!ready;
        option.className=ready?"bt-configured":"bt-unconfigured";option.textContent=item.text;group.append(option);
      }
      if(group.children.length)select.append(group);
    }
    select.value=serviceValue(config.engine,config.aiProvider);
  }
  const BT_SERVICES={value:serviceValue,parse:parseServiceValue,isConfigured:isServiceReady,isProviderConfigured:isProviderReady,options:serviceOptions,renderSelect:renderServiceSelect};
  if(typeof self!=="undefined")self.BT_SERVICES=BT_SERVICES;
  if(typeof window!=="undefined")window.BT_SERVICES=BT_SERVICES;


  if (typeof self !== "undefined") {
    self.AI_PROVIDERS = AI_PROVIDERS;
  }
  if (typeof window !== "undefined") {
    window.AI_PROVIDERS = AI_PROVIDERS;
  }
})(typeof self !== "undefined" ? self : this);