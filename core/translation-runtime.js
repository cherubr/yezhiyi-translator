// 缓存只驻留服务线程内存，不写入浏览器存储，线程重启后清空。
(function (global) {
  "use strict";
  function createTranslationRuntime(execute, options = {}) {
    const now = options.now || Date.now;
    const sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
    const cache = new Map(), inflight = new Map(), gates = new Map(), circuits = new Map(), manualTokens = new Map();
    const limit = options.cacheLimit || 256, ttl = options.ttl || 600000;
    const cooldown = options.cooldown || 30000;
    function scope(r) { return JSON.stringify([r.engine,r.aiProvider,r.aiConfig,r.baiduConfig]); }
    function key(r) { return JSON.stringify([scope(r),r.from,r.to,r.text]); }
    function put(k,value) {
      if(cache.has(k))clearTimeout(cache.get(k).timer);
      cache.delete(k);cache.set(k,value);
      value.timer=setTimeout(()=>{if(cache.get(k)===value)cache.delete(k);},Math.max(0,value.until-now()));
      if(value.timer && value.timer.unref)value.timer.unref();
      while(cache.size>limit) {
        const first=cache.keys().next().value;
        clearTimeout(cache.get(first).timer);cache.delete(first);
      }
    }
    function enqueue(r,action) {
      const id=r.engine;
      if(!gates.has(id)) gates.set(id,{active:0,queue:[],next:0});
      const gate=gates.get(id);
      if(gate.queue.length>=128) return Promise.reject(new Error("翻译队列已满，请稍后手动重试"));
      const concurrency=id==="baidu"?1:4;
      const interval=options.interval===undefined?(id==="baidu"?1100:150):options.interval;
      function pump() {
        while(gate.active<concurrency&&gate.queue.length) {
          const job=gate.queue.shift(),delay=Math.max(0,gate.next-now());
          gate.next=Math.max(gate.next,now())+interval;gate.active++;
          (async()=>{if(delay)await sleep(delay);return job.action();})()
            .then(job.resolve,job.reject).finally(()=>{gate.active--;pump();});
        }
      }
      return new Promise((resolve,reject)=>{gate.queue.push({action,resolve,reject});pump();});
    }
    function run(r) {
      const k=key(r),id=scope(r),manual=r.retryManual===true,cached=cache.get(k);
      // 一次手动操作只重置一次服务熔断，不能让同一批次的每个段落绕过保护。
      if(manual&&r.retryToken&&manualTokens.get(id)!==r.retryToken) {
        circuits.delete(id);manualTokens.set(id,r.retryToken);
        while(manualTokens.size>64)manualTokens.delete(manualTokens.keys().next().value);
      }
      if(cached&&cached.until>now()&&(!cached.error||!manual)) {
        if(cached.error)return Promise.reject(new Error(cached.error));
        cache.delete(k);cache.set(k,cached);return Promise.resolve(cached.data);
      }
      if(cached){clearTimeout(cached.timer);cache.delete(k);}
      if(inflight.has(k))return inflight.get(k);
      const job=enqueue(r,async()=>{
        const circuit=circuits.get(id);
        if(circuit&&circuit.until>now())throw new Error("翻译服务连续失败，已暂停自动请求；请检查配置后手动重试");
        try {
          const data=await execute(r);
          if(typeof data!=="string"||!data.trim())throw new Error("翻译服务返回空内容");
          circuits.delete(id);put(k,{data,until:now()+ttl});return data;
        } catch(error) {
          const previous=circuits.get(id),failures=(previous&&previous.failures||0)+1;
          circuits.set(id,{failures,until:failures>=3?now()+cooldown:0});
          put(k,{error:error.message||"翻译失败",until:now()+cooldown});throw error;
        }
      });
      const pending=job.finally(()=>inflight.delete(k));inflight.set(k,pending);return pending;
    }
    return {run};
  }
  global.BT_CREATE_TRANSLATION_RUNTIME=createTranslationRuntime;
})(typeof self!=="undefined"?self:globalThis);
