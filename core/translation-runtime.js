// 实际网络请求统一在后台调度；页面文字工作者不再充当网络并发设置。
(function(global) {
  "use strict";
  function createTranslationRuntime(execute,options={}) {
    const policy=global.BT_REQUEST_POLICY;
    if(!policy)throw new Error("缺少请求规则模块");
    const now=options.now||Date.now, limits=policy.LIMITS;
    const cache=new Map(),inflight=new Map(),gates=new Map(),circuits=new Map(),manualTokens=new Map(),owners=new Map();
    const ttl=options.ttl||600000,cacheLimit=options.cacheLimit||256,cooldown=options.cooldown||limits.cooldownMs;
    let testSequence=0,textSequence=0,requestSequence=0,policies={};
    function abortError(){return Object.assign(new Error("翻译已取消"),{name:"AbortError"});}
    /** 诊断只发送阶段与数值；禁止传递原文、译文、凭据、缓存键和账号作用域。 */
    function diagnostic(r,phase,details={}) {
      if(typeof r.onDiagnostic!=="function")return;
      try{r.onDiagnostic({phase,taskId:r.parentTaskKey,part:r.partIndex||1,parts:r.partCount||1,
        service:policy.id(r.engine,r.aiProvider),...details});}catch(_){}
    }
    function entryDiagnostic(entry,phase,details={}) {
      for(const consumer of entry.consumers)diagnostic(consumer.request,phase,{requestId:entry.requestId,...details});
    }
    /** 同一原因只记录一次，避免 QPS 定时唤醒或页面滚动刷屏。 */
    function reportWaiting(gate,setting,reason,waitMs=0) {
      for(const job of gate.queue){
        const waitReason=Number.isFinite(jobScore(job))?reason:"hidden";
        const stamp=waitReason+":"+setting.qps+":"+setting.maxConcurrent;
        if(job.waitNotice===stamp)continue;
        job.waitNotice=stamp;
        entryDiagnostic(job.entry,"request_wait",{reason:waitReason,waitMs:Math.max(0,Math.round(waitMs)),
          active:gate.active,queued:gate.queue.length,qps:setting.qps,maxConcurrent:setting.maxConcurrent});
      }
    }
    // 语义缓存包括凭据/模型/语言；网络额度作用域独立，避免不同模型绕过同账号限额。
    function scope(r){return JSON.stringify([r.engine,r.aiProvider,r.aiConfig,r.baiduConfig]);}
    function key(r){return JSON.stringify([scope(r),r.from,r.to,r.text]);}
    function put(k,value) {
      if(cache.has(k))clearTimeout(cache.get(k).timer);
      cache.delete(k);cache.set(k,value);
      value.timer=setTimeout(()=>{if(cache.get(k)===value)cache.delete(k);},Math.max(0,value.until-now()));
      value.timer?.unref?.();
      while(cache.size>cacheLimit){const first=cache.keys().next().value;clearTimeout(cache.get(first).timer);cache.delete(first);}
    }
    function cachedError(record) {
      return Object.assign(new Error(record.error),{code:record.code,retryable:record.retryable,permanent:record.permanent,exhausted:record.exhausted,attempts:record.attempts});
    }
    function owner(r){return owners.get(r.ownerKey)||{visible:r.pageVisible!==false,viewportEpoch:r.viewportEpoch||0,version:0};}
    function subscriberScore(consumer) {
      const state=owner(consumer.request);
      if(!state.visible)return Infinity;
      if(consumer.request.priority===0)return 0;
      return (consumer.request.viewportEpoch||0)<state.viewportEpoch?2:1;
    }
    function jobScore(job) {
      let result=Infinity;
      for(const consumer of job.entry.consumers)result=Math.min(result,subscriberScore(consumer));
      return result;
    }
    function effectivePolicy(gate) {
      const values=[...gate.refs.values()].map(r=>policy.resolve(r.engine,r.aiProvider,policies));
      return {qps:Math.min(...values.map(v=>v.qps)),maxConcurrent:Math.min(...values.map(v=>v.maxConcurrent))};
    }
    function wake(gate,delay) {
      if(gate.timer)clearTimeout(gate.timer);
      gate.timer=setTimeout(()=>{gate.timer=null;pump(gate);},Math.min(2147483647,Math.max(1,Math.ceil(delay))));
    }
    /** 只在真正启动时占用在途名额；隐页请求保留排队，永不以暂停充当取消。 */
    function pump(gate) {
      if(gate.timer){clearTimeout(gate.timer);gate.timer=null;}
      const setting=effectivePolicy(gate);
      while(gate.active<setting.maxConcurrent&&gate.queue.length) {
        const candidates=gate.queue.filter(job=>!job.signal.aborted&&Number.isFinite(jobScore(job)));
        if(!candidates.length){reportWaiting(gate,setting,"hidden");return;}
        const time=now(),spacing=options.interval===undefined?Math.ceil(1000/setting.qps):options.interval;
        gate.starts=gate.starts.filter(value=>value>time-1000);
        const windowDelay=options.interval===0||gate.starts.length<setting.qps?0:gate.starts[0]+1001-time;
        const delay=Math.max(0,gate.next-time,gate.retryUntil-time,windowDelay);
        if(delay){reportWaiting(gate,setting,gate.retryUntil>time?"backoff":"qps",delay);wake(gate,delay);return;}
        candidates.sort((a,b)=>jobScore(a)-jobScore(b)||
          (gate.served.get(a.request.ownerKey)||0)-(gate.served.get(b.request.ownerKey)||0)||a.sequence-b.sequence);
        const first=candidates[0],lastTask=gate.lastTasks.get(first.request.ownerKey);
        // 同页长段分片和其他段落交替领取名额；只有一个段落时仍充分利用全部并发。
        const next=candidates.find(job=>jobScore(job)===jobScore(first)&&job.request.ownerKey===first.request.ownerKey&&
          (job.request.parentTaskKey??job.entry.key)!==lastTask)||first;
        gate.lastTasks.set(next.request.ownerKey,next.request.parentTaskKey??next.entry.key);
        gate.queue.splice(gate.queue.indexOf(next),1);
        next.signal.removeEventListener("abort",next.remove);
        if(next.signal.aborted){next.reject(abortError());continue;}
        gate.served.set(next.request.ownerKey,++gate.turn);gate.active++;
        gate.next=time+spacing;gate.starts.push(time);
        const startedAt=now(),configured=policy.resolve(next.request.engine,next.request.aiProvider,policies);
        entryDiagnostic(next.entry,"request_start",{attempt:(next.entry.attempts||0)+1,
          queueMs:Math.max(0,startedAt-next.enqueuedAt),active:gate.active,queued:gate.queue.length,
          qps:setting.qps,maxConcurrent:setting.maxConcurrent,configuredQps:configured.qps,
          configuredMaxConcurrent:configured.maxConcurrent,
          policySources:[...gate.refs.values()].map(r=>{const value=policy.resolve(r.engine,r.aiProvider,policies);
            return {service:policy.id(r.engine,r.aiProvider),qps:value.qps,maxConcurrent:value.maxConcurrent};})});
        let operation;
        try{operation=next.action();}catch(error){operation=Promise.reject(error);}
        Promise.resolve(operation).then(data=>{
          entryDiagnostic(next.entry,"request_success",{executionMs:Math.max(0,now()-startedAt)});next.resolve(data);
        },error=>{
          entryDiagnostic(next.entry,error.name==="AbortError"?"request_cancelled":"request_error",{
            executionMs:Math.max(0,now()-startedAt),code:/^[A-Z_0-9]{1,40}$/.test(error.code||"")?error.code:"ERROR"});
          next.reject(error);
        }).finally(()=>{gate.active--;pump(gate);});
      }
      if(gate.queue.length&&gate.active>=setting.maxConcurrent)reportWaiting(gate,setting,"concurrency");
    }
    let jobSequence=0;
    function enqueue(entry,request,action) {
      const id=policy.quotaScope(request);
      if(!gates.has(id))gates.set(id,{active:0,queue:[],next:0,starts:[],retryUntil:0,refs:new Map(),timer:null,served:new Map(),lastTasks:new Map(),turn:0});
      const gate=gates.get(id);
      gate.refs.set(policy.id(request.engine,request.aiProvider),{engine:request.engine,aiProvider:request.aiProvider});
      entry.gate=gate;
      if(gate.queue.length>=limits.queue)return Promise.reject(Object.assign(new Error("翻译队列已满，请稍后手动重试"),{code:"QUEUE_FULL",retryable:false}));
      return new Promise((resolve,reject)=>{
        const job={entry,request,action,resolve,reject,signal:entry.controller.signal,sequence:jobSequence++,enqueuedAt:now()};
        job.remove=()=>{
          const index=gate.queue.indexOf(job);
          if(index>=0){gate.queue.splice(index,1);reject(abortError());pump(gate);}
        };
        if(job.signal.aborted){reject(abortError());return;}
        job.signal.addEventListener("abort",job.remove,{once:true});gate.queue.push(job);
        entryDiagnostic(entry,"request_queued",{attempt:(entry.attempts||0)+1,queued:gate.queue.length,active:gate.active});
        pump(gate);
      });
    }
    function notifyRetry(entry,data) {
      entry.retryNotice=data;
      entryDiagnostic(entry,"request_retry",{attempt:data.attempt,maxAttempts:data.maxAttempts,waitMs:Math.max(0,data.until-now()),code:data.code});
      for(const consumer of entry.consumers)try{consumer.request.onRetry?.(data);}catch(_){}
    }
    function subscribe(entry,r) {
      const signal=r.signal;
      if(signal?.aborted)return Promise.reject(abortError());
      return new Promise((resolve,reject)=>{
        const consumer={request:r};entry.consumers.add(consumer);
        const detach=()=>{entry.consumers.delete(consumer);signal?.removeEventListener("abort",onAbort);};
        const onAbort=()=>{
          detach();reject(abortError());
          if(!entry.consumers.size){entry.controller.abort();if(inflight.get(entry.key)===entry)inflight.delete(entry.key);}
          if(entry.gate)pump(entry.gate);
        };
        signal?.addEventListener("abort",onAbort,{once:true});
        if(entry.retryNotice)try{r.onRetry?.(entry.retryNotice);}catch(_){}
        entry.promise.then(data=>{detach();resolve(data);},error=>{detach();reject(error);});
        if(entry.gate)pump(entry.gate);
      });
    }
    /** 单个网络分片入口：缓存和共享不重复消耗额度，重试仍进入同一调度队列。 */
    function run(r) {
      if(r.signal?.aborted)return Promise.reject(abortError());
      const k=r.bypassCache?key(r)+":test:"+ ++testSequence:key(r),id=scope(r),manual=r.retryManual===true;
      if(manual&&r.retryToken&&manualTokens.get(id)!==r.retryToken){
        circuits.delete(id);manualTokens.set(id,r.retryToken);
        while(manualTokens.size>64)manualTokens.delete(manualTokens.keys().next().value);
      }
      const cached=r.bypassCache?undefined:cache.get(k);
      if(cached&&cached.until>now()&&(!cached.error||!manual)){
        if(cached.error)return Promise.reject(cachedError(cached));
        cache.delete(k);cache.set(k,cached);diagnostic(r,"cache_hit");return Promise.resolve(cached.data);
      }
      if(cached){clearTimeout(cached.timer);cache.delete(k);}
      if(inflight.has(k)){diagnostic(r,"request_shared",{requestId:inflight.get(k).requestId});return subscribe(inflight.get(k),r);}
      let resolveEntry,rejectEntry;
      const entry={key:k,requestId:++requestSequence,controller:new AbortController(),consumers:new Set(),
        promise:new Promise((resolve,reject)=>{resolveEntry=resolve;rejectEntry=reject;})};
      inflight.set(k,entry);
      // 先登记消费者再调度，使第一次调用也遵守其页面可见性。
      const consumerPromise=subscribe(entry,r),request={...r,signal:entry.controller.signal,
        reportDiagnostic:(phase,details)=>entryDiagnostic(entry,phase,details)};
      let attempts=0;
      function attempt() {
        return enqueue(entry,request,async()=>{
          const circuit=circuits.get(id);
          if(!r.bypassCache&&circuit&&circuit.until>now()){
            if(circuit.permanent)throw Object.assign(new Error(circuit.message),{code:circuit.code,permanent:true,retryable:false});
            throw Object.assign(new Error("翻译服务连续失败，已暂停自动请求；请检查配置后手动重试"),{code:"CIRCUIT_OPEN",retryable:false});
          }
          attempts++;entry.attempts=attempts;
          try {
            const data=await execute(request);
            if(request.signal.aborted)throw abortError();
            if(typeof data!=="string"||!data.trim())throw Object.assign(new Error("翻译服务返回空内容"),{retryable:false});
            circuits.delete(id);
            return data;
          }catch(error){
            if(request.signal.aborted||error.name==="AbortError")throw abortError();
            if(error.retryable){
              const jitter=options.random?options.random()*250:Math.random()*250;
              const retryDelay=options.retryDelay===undefined?Math.min(limits.retryMaxMs,limits.retryBaseMs*2**(attempts-1)+jitter):options.retryDelay;
              entry.gate.retryUntil=Math.max(entry.gate.retryUntil,now()+Math.max(retryDelay,error.retryAfterMs||0));
              if(attempts<limits.maxAttempts)notifyRetry(entry,{until:entry.gate.retryUntil,attempt:attempts+1,maxAttempts:limits.maxAttempts,code:error.code||"TEMPORARY_FAILURE"});
            }
            throw error;
          }
        }).catch(error=>{
          if(request.signal.aborted||error.name==="AbortError")throw abortError();
          if(error.retryable&&attempts<limits.maxAttempts)return attempt();
          error.attempts=attempts;
          error.exhausted=attempts>=limits.maxAttempts;
          if(!r.bypassCache&&error.code!=="NEED_SOURCE_LANGUAGE"&&error.code!=="CIRCUIT_OPEN"){
            const failures=(circuits.get(id)?.failures||0)+1;
            circuits.set(id,{failures,until:error.permanent?Infinity:failures>=3?now()+cooldown:0,
              permanent:!!error.permanent,message:error.message,code:error.code});
          }
          throw error;
        });
      }
      attempt().then(data=>{
        if(!r.bypassCache)put(k,{data,until:now()+ttl});resolveEntry(data);
      },error=>{
        if(error.name!=="AbortError"&&!r.bypassCache)put(k,{error:error.message,code:error.code,
          retryable:error.retryable,permanent:error.permanent,exhausted:error.exhausted,attempts:error.attempts,until:now()+cooldown});
        rejectEntry(error);
      }).finally(()=>{if(inflight.get(k)===entry)inflight.delete(k);});
      return consumerPromise;
    }
    /** 长段按服务分块，小型生产池喂入统一队列；结果按序拼接，失败片段不会伪装成功。 */
    async function runText(r) {
      r={...r,parentTaskKey:++textSequence};
      const startedAt=now(),parts=policy.split(r.text,r.engine),configured=policy.resolve(r.engine,r.aiProvider,policies);
      r.partCount=parts.length;
      if(typeof r.onDiagnostic==="function")diagnostic(r,"task_start",{chars:Array.from(r.text).length,
        bytes:new TextEncoder().encode(r.text).length,configuredQps:configured.qps,configuredMaxConcurrent:configured.maxConcurrent,
        maxChars:configured.maxChars,maxBytes:configured.maxBytes});
      if(parts.length<=1){
        try{const result=await run(r);diagnostic(r,"task_complete",{totalMs:Math.max(0,now()-startedAt)});return result;}
        catch(error){diagnostic(r,error.name==="AbortError"?"task_cancelled":"task_error",{totalMs:Math.max(0,now()-startedAt)});throw error;}
      }
      const results=new Array(parts.length);
      let index=0,firstError;
      const feeders=Math.min(parts.length,limits.partFeeders,policy.resolve(r.engine,r.aiProvider,policies).maxConcurrent);
      async function feed(){
        while(index<parts.length&&!firstError){
          const current=index++;
          try{results[current]=await run({...r,text:parts[current],partIndex:current+1});}
          catch(error){firstError=firstError||error;}
        }
      }
      await Promise.all(Array.from({length:feeders},feed));
      if(firstError){diagnostic(r,firstError.name==="AbortError"?"task_cancelled":"task_error",{totalMs:Math.max(0,now()-startedAt)});throw firstError;}
      diagnostic(r,"task_complete",{totalMs:Math.max(0,now()-startedAt)});
      return results.join(" ");
    }
    /** 同步可见性有版本保护；旧请求携带的快照不能把隐藏页面重新标成前台。 */
    function setOwnerState(ownerKey,state) {
      if(!ownerKey)return;
      const previous=owners.get(ownerKey);
      if(previous&&Number(state.version||0)<previous.version)return;
      owners.set(ownerKey,{visible:state.visible!==false,viewportEpoch:Number(state.viewportEpoch)||0,version:Number(state.version)||0});
      for(const gate of gates.values())pump(gate);
    }
    function removeOwner(ownerKey){owners.delete(ownerKey);for(const gate of gates.values()){gate.served.delete(ownerKey);gate.lastTasks.delete(ownerKey);}}
    function updatePolicies(value={}){policies=value;for(const gate of gates.values())pump(gate);}
    return {run,runText,setOwnerState,updatePolicies,removeOwner};
  }
  global.BT_CREATE_TRANSLATION_RUNTIME=createTranslationRuntime;
})(typeof self!=="undefined"?self:globalThis);
