// 请求规则的唯一默认值来源；参数是扩展策略，不是厂商账号额度。
(function(global) {
  "use strict";
  const VERSION = 1;
  const DEFAULTS = Object.freeze({
    google: Object.freeze({qps:6,maxConcurrent:4,maxChars:1200,maxBytes:1800}),
    baidu: Object.freeze({qps:6,maxConcurrent:4,maxChars:900,maxBytes:2700}),
    mymemory: Object.freeze({qps:2,maxConcurrent:2,maxChars:480,maxBytes:480}),
    // 未知兼容模型没有统一 Token 查询协议，采用保守文本预算，不冒充精确分词。
    ai: Object.freeze({qps:6,maxConcurrent:4,maxChars:1200,maxBytes:1800})
  });
  const LIMITS = Object.freeze({maxQps:100,maxConcurrent:32,pageTasks:64,partFeeders:4,
    queue:512,maxTextLength:100000,maxAttempts:3,retryBaseMs:1000,retryMaxMs:30000,cooldownMs:30000});
  const RULES = Object.freeze([
    ["TR-01","请求额度","每秒启动次数与同时在途数量共同限制；排队等待不占在途名额。"],
    ["TR-02","服务隔离","同一接口账号共同调度；不同接口账号分开，AI 按厂商分别配置。"],
    ["TR-03","服务分块","按字符与 UTF-8 字节双重预算分块，保持原文完整；未知 AI 模型不宣称精确 Token 计数。"],
    ["TR-04","有限重试","只有临时网络、超时、限流及服务端错误可重试；每个分片最多三次尝试，含首次。"],
    ["TR-05","限流等待","遵守 Retry-After；没有提示时指数退避加随机抖动，同账号其他请求共同等待。"],
    ["TR-06","优先级","Shift 与选中文字优先，其次最新视口；同优先级在页面间轮转，不突破服务限额。"],
    ["TR-07","离开暂停","停止不可见页面的新网络请求；已发送请求完成并保留结果，返回继续。"],
    ["TR-08","取消隔离","手动取消还原原文并停止本页会话；返回不恢复，Shift 不解除整页取消。"],
    ["TR-09","结果校验","切换配置、原文变化或旧任务返回时校验代次，禁止插入过期译文。"],
    ["TR-10","缓存与配置","复用近期的相同翻译以减少重复调用；请求参数保存在本机，恢复推荐不清除连接信息。"]
  ]);
  function id(engine,provider) { return engine==="ai"?"ai:"+(provider||"openai"):engine; }
  function integer(value,min,max,fallback) {
    const n=Number(value);return Number.isInteger(n)&&n>=min&&n<=max?n:fallback;
  }
  /** 归一化单服务配置；异常存储值回到保守默认值，表单则应明确提示错误。 */
  function resolve(engine,provider,policies={}) {
    const defaults=DEFAULTS[engine]||DEFAULTS.google, saved=policies[id(engine,provider)]||{};
    const manual=saved.mode==="manual";
    return {...defaults,mode:manual?"manual":"recommended",
      qps:manual?integer(saved.qps,1,LIMITS.maxQps,defaults.qps):defaults.qps,
      maxConcurrent:manual?integer(saved.maxConcurrent,1,LIMITS.maxConcurrent,defaults.maxConcurrent):defaults.maxConcurrent};
  }
  function validate(value) {
    if(value.mode!=="manual")return "";
    if(!Number.isInteger(Number(value.qps))||Number(value.qps)<1||Number(value.qps)>LIMITS.maxQps)return "每秒请求数请输入 1～100 的整数";
    if(!Number.isInteger(Number(value.maxConcurrent))||Number(value.maxConcurrent)<1||Number(value.maxConcurrent)>LIMITS.maxConcurrent)return "同时请求上限请输入 1～32 的整数";
    return "";
  }
  /** 在词句边界附近分块；按 Unicode 码点计字符，并用 UTF-8 字节预算保护接口。 */
  function split(text,engine) {
    const limits=DEFAULTS[engine]||DEFAULTS.google, points=Array.from(text), chunks=[];
    const encoder=new TextEncoder(),offsets=[0];
    for(const point of points)offsets.push(offsets[offsets.length-1]+point.length);
    const ranges=global.BT_TRANSLATION_UNITS?.protectedRanges(text)||[];
    let start=0;
    while(start<points.length) {
      let end=start,bytes=0;
      while(end<points.length&&end-start<limits.maxChars) {
        const size=encoder.encode(points[end]).length;
        if(bytes+size>limits.maxBytes)break;
        bytes+=size;end++;
      }
      if(end===start)end++;
      if(end<points.length) {
        const minimum=start+Math.floor((end-start)*0.6);
        for(let cut=end;cut>minimum;cut--)if(/[\s.!?。！？；;]/u.test(points[cut-1])){end=cut;break;}
      }
      const protectedRange=ranges.find(range=>offsets[end]>range.start&&offsets[end]<range.end);
      if(protectedRange){
        const before=offsets.indexOf(protectedRange.start);
        if(before>start)end=before;
        else throw error("单个保护标记超过服务分块预算",{code:"PROTECTED_TOKEN_TOO_LONG",retryable:false});
      }
      chunks.push(points.slice(start,end).join(""));start=end;
    }
    return chunks;
  }
  /** 调度按账号而不是模型分组；凭据只用于内存索引，不得记录此返回值。 */
  function quotaScope(r) {
    if(r.engine==="baidu")return JSON.stringify(["baidu",r.baiduConfig?.baiduAppId||""]);
    if(r.engine==="ai") {
      let base=r.aiConfig?.base||r.aiProvider||"";
      try {const url=new URL(base);base=url.origin+url.pathname.replace(/\/+$/,"");}catch(_){}
      return JSON.stringify(["ai",base,r.aiConfig?.key||""]);
    }
    return r.engine;
  }
  /** 临时故障采用结构化错误，避免靠错误文案猜测是否重试。 */
  function error(message,details={}) {
    const result=new Error(message);Object.assign(result,details);return result;
  }
  function retryAfter(response) {
    const raw=response?.headers?.get?.("Retry-After");
    if(!raw)return 0;
    const seconds=Number(raw);
    if(Number.isFinite(seconds)&&seconds>=0)return Math.min(seconds*1000,Number.MAX_SAFE_INTEGER);
    const until=Date.parse(raw);return Number.isFinite(until)?Math.max(0,until-Date.now()):0;
  }
  function httpError(service,response) {
    const status=response.status;
    const code=status===429?"RATE_LIMITED":status===401||status===403?"AUTH_REQUIRED":status>=500?"SERVICE_UNAVAILABLE":"SERVICE_REJECTED";
    return error(service+" 请求失败："+status,{
      code,status,retryable:status===429||status===408||status>=500,
      retryAfterMs:retryAfter(response),permanent:status===401||status===403
    });
  }
  /** 响应头与正文共用截止时间；取消可中止正文，不输出响应原文。 */
  async function readJson(response,signal) {
    if(signal?.aborted)throw Object.assign(new Error("翻译已取消"),{name:"AbortError"});
    let timer,onAbort;
    const deadline=response.__btDeadline||Date.now()+30000;
    const interruption=new Promise((resolve,reject)=>{
      timer=setTimeout(()=>{
        response.__btAbort?.();
        reject(error("翻译响应超时，请稍后重试",{code:"TIMEOUT",retryable:true}));
      },Math.max(1,deadline-Date.now()));
      onAbort=()=>{response.__btAbort?.();reject(Object.assign(new Error("翻译已取消"),{name:"AbortError"}));};
      signal?.addEventListener("abort",onAbort,{once:true});
    });
    try{return await Promise.race([response.json(),interruption]);}
    catch(cause){
      if(cause?.name==="SyntaxError")throw error("翻译服务返回格式异常，请检查接口地址或更换服务",{code:"INVALID_RESPONSE",retryable:false});
      throw cause;
    }
    finally{clearTimeout(timer);signal?.removeEventListener("abort",onAbort);}
  }
  global.BT_REQUEST_POLICY={VERSION,DEFAULTS,LIMITS,RULES,id,resolve,validate,split,quotaScope,error,retryAfter,httpError,readJson};
})(typeof self!=="undefined"?self:globalThis);
