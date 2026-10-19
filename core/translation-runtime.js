// 后台请求按消费者取消：一个标签页取消，不中断其他标签页共享的相同请求。
(function(global) {
  "use strict";
  /**
   * 创建内存级请求调度器；execute 执行实际请求，options 可注入时钟、等待及缓存参数供测试使用。
   *
   * @param {Function} execute 接收请求快照并返回译文 Promise 的执行函数。
   * @param {Object} options 时钟、等待函数、缓存容量及过期时间等可选配置。
   * @returns {{run: Function}} 提供统一请求入口的调度器。
   */
  function createTranslationRuntime(execute, options = {}) {
    const now = options.now || Date.now;
    const cache = new Map(), inflight = new Map(), gates = new Map(), circuits = new Map(), manualTokens = new Map();
    const limit = options.cacheLimit || 256, ttl = options.ttl || 600000, cooldown = options.cooldown || 30000;
    /**
     * 生成统一的主动取消异常；取消不写入失败缓存，也不累计服务失败次数。
     */
    function abortError() { const e = new Error("翻译已取消");e.name = "AbortError";return e; }
    /**
     * 按引擎和凭据快照划分服务作用域，隔离不同账号或接口的结果及熔断状态。
     */
    function scope(r) { return JSON.stringify([r.engine,r.aiProvider,r.aiConfig,r.baiduConfig]); }
    /**
     * 在服务作用域上加入源语言、目标语言和原文，生成缓存及并发请求合并键。
     */
    function key(r) { return JSON.stringify([scope(r),r.from,r.to,r.text]); }
    /**
     * 执行可取消的限流等待；测试可通过 options.sleep 替换真实计时。
     */
    function wait(ms,signal) {
      if(signal.aborted)return Promise.reject(abortError());
      if(options.sleep)return options.sleep(ms);
      return new Promise((resolve,reject)=>{
        const onAbort=()=>{clearTimeout(timer);reject(abortError());};
        const timer=setTimeout(()=>{signal.removeEventListener("abort",onAbort);resolve();},ms);
        signal.addEventListener("abort",onAbort,{once:true});
      });
    }
    /**
     * 保存带过期时间的缓存记录，替换旧定时器并淘汰超出容量的最早条目。
     */
    function put(k,value) {
      if(cache.has(k))clearTimeout(cache.get(k).timer);
      cache.delete(k);cache.set(k,value);
      value.timer=setTimeout(()=>{if(cache.get(k)===value)cache.delete(k);},Math.max(0,value.until-now()));
      if(value.timer&&value.timer.unref)value.timer.unref();
      while(cache.size>limit) {
        const first=cache.keys().next().value;clearTimeout(cache.get(first).timer);cache.delete(first);
      }
    }
    /**
     * 将请求放入引擎队列，控制并发数与启动间隔；尚未运行的请求可直接移出队列。
     */
    function enqueue(r,action) {
      const id=r.engine,signal=r.signal;
      if(!gates.has(id))gates.set(id,{active:0,queue:[],next:0});
      const gate=gates.get(id);
      if(gate.queue.length>=128)return Promise.reject(new Error("翻译队列已满，请稍后手动重试"));
      const concurrency=id==="baidu"?1:4;
      const interval=options.interval===undefined?(id==="baidu"?1100:150):options.interval;
      /**
       * 在有空闲并发槽位时领取队列任务，完成或失败后释放槽位并继续调度。
       */
      function pump() {
        while(gate.active<concurrency&&gate.queue.length) {
          const job=gate.queue.shift();job.signal.removeEventListener("abort",job.remove);
          if(job.signal.aborted){job.reject(abortError());continue;}
          const delay=Math.max(0,gate.next-now());
          gate.next=Math.max(gate.next,now())+interval;gate.active++;
          (async()=>{
            if(delay)await wait(delay,job.signal);
            if(job.signal.aborted)throw abortError();
            return job.action();
          })().then(job.resolve,job.reject).finally(()=>{gate.active--;pump();});
        }
      }
      return new Promise((resolve,reject)=>{
        const job={action,resolve,reject,signal};
        job.remove=()=>{const i=gate.queue.indexOf(job);if(i>=0){gate.queue.splice(i,1);reject(abortError());}};
        if(signal.aborted){reject(abortError());return;}
        signal.addEventListener("abort",job.remove,{once:true});
        gate.queue.push(job);pump();
      });
    }
    /**
     * 为共享请求登记独立消费者；只有最后一个消费者取消时才中止底层请求。
     *
     * @param {Object} entry 已登记的共享请求及其消费者集合。
     * @param {AbortSignal} [signal] 当前消费者自己的取消信号。
     * @returns {Promise<string>} 当前消费者独立等待的翻译结果。
     */
    function subscribe(entry,signal) {
      if(signal&&signal.aborted)return Promise.reject(abortError());
      return new Promise((resolve,reject)=>{
        const consumer={};
        entry.consumers.add(consumer);
        const detach=()=>{
          entry.consumers.delete(consumer);
          if(signal)signal.removeEventListener("abort",onAbort);
        };
        const onAbort=()=>{
          detach();reject(abortError());
          if(!entry.consumers.size) {
            entry.controller.abort();
            if(inflight.get(entry.key)===entry)inflight.delete(entry.key);
          }
        };
        if(signal)signal.addEventListener("abort",onAbort,{once:true});
        entry.promise.then(data=>{detach();resolve(data);},error=>{detach();reject(error);});
      });
    }
    /**
     * 翻译请求入口：先检查缓存与重复请求，再排队执行；维护失败冷却、熔断及手动重试状态。
     */
    function run(r) {
      if(r.signal&&r.signal.aborted)return Promise.reject(abortError());
      const k=key(r),id=scope(r),manual=r.retryManual===true,cached=cache.get(k);
      if(manual&&r.retryToken&&manualTokens.get(id)!==r.retryToken) {
        circuits.delete(id);manualTokens.set(id,r.retryToken);
        while(manualTokens.size>64)manualTokens.delete(manualTokens.keys().next().value);
      }
      if(cached&&cached.until>now()&&(!cached.error||!manual)) {
        if(cached.error){const error=new Error(cached.error);error.code=cached.code;return Promise.reject(error);}
        cache.delete(k);cache.set(k,cached);return Promise.resolve(cached.data);
      }
      if(cached){clearTimeout(cached.timer);cache.delete(k);}
      if(inflight.has(k))return subscribe(inflight.get(k),r.signal);
      const entry={key:k,controller:new AbortController(),consumers:new Set()};
      const request={...r,signal:entry.controller.signal};
      entry.promise=enqueue(request,async()=>{
        const circuit=circuits.get(id);
        if(circuit&&circuit.until>now())throw new Error("翻译服务连续失败，已暂停自动请求；请检查配置后手动重试");
        try {
          const data=await execute(request);
          if(request.signal.aborted)throw abortError();
          if(typeof data!=="string"||!data.trim())throw new Error("翻译服务返回空内容");
          circuits.delete(id);put(k,{data,until:now()+ttl});return data;
        } catch(error) {
          if(request.signal.aborted||error.name==="AbortError")throw abortError();
          // 短文字无法识别是单段限制，不应导致整个服务熔断。
          if(error.code!=="NEED_SOURCE_LANGUAGE") {
            const failures=(circuits.get(id)?.failures||0)+1;
            circuits.set(id,{failures,until:failures>=3?now()+cooldown:0});
          }
          put(k,{error:error.message||"翻译失败",code:error.code,until:now()+cooldown});throw error;
        }
      }).finally(()=>{if(inflight.get(k)===entry)inflight.delete(k);});
      inflight.set(k,entry);
      return subscribe(entry,r.signal);
    }
    return {run};
  }
  global.BT_CREATE_TRANSLATION_RUNTIME=createTranslationRuntime;
})(typeof self!=="undefined"?self:globalThis);
