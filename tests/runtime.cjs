/**
 * 测试模块：共享翻译运行时。
 * 隔离方式：可控执行器、取消信号和模拟时间。
 * 验收范围：缓存、并发合并、消费者隔离、冷却和熔断；不测实际厂商吞吐。
 * 执行：node tests/runtime.cjs
 */
const vm=require('node:vm'),fs=require('node:fs'),assert=require('node:assert/strict'),path=require('node:path');
const context={setTimeout,clearTimeout,AbortController,TextEncoder,URL,console};vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(__dirname,'../core/request-policy.js'),'utf8'),context);
vm.runInContext(fs.readFileSync(path.join(__dirname,'../core/translation-runtime.js'),'utf8'),context);
const create=context.BT_CREATE_TRANSLATION_RUNTIME;
const request=(text,extra={})=>({engine:'google',text,from:'en',to:'zh-CN',...extra});
(async()=>{
 let calls=0,release;
 const r=create(async()=>{calls++;await new Promise(resolve=>release=resolve);return '译文';},{interval:0});
 const first=r.run(request('same')),second=r.run(request('same'));release();
 assert.deepEqual(await Promise.all([first,second]),['译文','译文']);assert.equal(calls,1);
 assert.equal(await r.run(request('same')),'译文');assert.equal(calls,1);
 let time=100,count=0;
 const cache=create(async()=>String(++count),{interval:0,now:()=>time,ttl:10,cacheLimit:2});
 await cache.run(request('a'));await cache.run(request('b'));await cache.run(request('c'));await cache.run(request('a'));assert.equal(count,4);
 time+=20;await cache.run(request('a'));assert.equal(count,5);
 await cache.run(request('a',{to:'ja'}));assert.equal(count,6,'language separates cache');
 let failures=0;
 const bad=create(async()=>{failures++;throw Error('network');},{interval:0,now:()=>time});
 await assert.rejects(bad.run(request('a')),/network/);
 await assert.rejects(bad.run(request('a')),/network/);assert.equal(failures,1,'failed requests cool down');
 await assert.rejects(bad.run(request('b')),/network/);await assert.rejects(bad.run(request('c')),/network/);
 await assert.rejects(bad.run(request('d')),/连续失败/);assert.equal(failures,3);
 await assert.rejects(bad.run(request('d',{retryManual:true,retryToken:'new-click'})),/network/);assert.equal(failures,4);
 const queued=Array.from({length:12},(_,i)=>bad.run(request('bulk'+i,{retryManual:true,retryToken:'single-batch'})));
 await Promise.allSettled(queued);assert.ok(failures<=10,'manual batch cannot bypass circuit repeatedly');
 let active=0,peak=0;
 const limited=create(async()=>{active++;peak=Math.max(peak,active);await new Promise(resolve=>setTimeout(resolve,2));active--;return 'ok';},{interval:0});
 await Promise.all(Array.from({length:20},(_,i)=>limited.run(request('p'+i))));
 assert.equal(peak,4);
 active=0;peak=0;
 await Promise.all(Array.from({length:4},(_,i)=>limited.run(request('b'+i,{engine:'baidu'}))));
 assert.equal(peak,4);

 // 两个页面共享同一请求，其中一个取消时保留另一个消费者。
 const ca=new AbortController(),cb=new AbortController();
 let sharedDone,sharedAborted=false;
 const shared=create(async request=>new Promise((resolve,reject)=>{
   sharedDone=resolve;
   request.signal.addEventListener('abort',()=>{sharedAborted=true;reject(Object.assign(new Error('cancel'),{name:'AbortError'}));},{once:true});
 }),{interval:0});
 const pa=shared.run(request('shared',{signal:ca.signal}));
 const pb=shared.run(request('shared',{signal:cb.signal}));
 ca.abort();await assert.rejects(pa,e=>e.name==='AbortError');
 assert.equal(sharedAborted,false);
 sharedDone('kept');assert.equal(await pb,'kept');

 // 最后一个消费者取消时，中止底层任务；取消不进入失败缓存或服务熔断。
 const only=new AbortController();let actualAbort=false,started=0;
 const abortable=create(async r=>{
   started++;
   if(started>1)return 'recovered';
   return new Promise((resolve,reject)=>r.signal.addEventListener('abort',()=>{
     actualAbort=true;reject(Object.assign(new Error('cancel'),{name:'AbortError'}));
   },{once:true}));
 },{interval:0});
 const abandoned=abortable.run(request('abort',{signal:only.signal}));
 only.abort();await assert.rejects(abandoned,e=>e.name==='AbortError');
 assert.equal(actualAbort,true);
 assert.equal(await abortable.run(request('abort')),'recovered');

 // 排队任务取消后不执行；队列仍能继续工作。
 let firstDone;const executed=[];
 const queue=create(async r=>{
   executed.push(r.text);
   if(r.text==='first')await new Promise(resolve=>firstDone=resolve);
   return 'done';
 },{interval:0});
 queue.updatePolicies({baidu:{mode:'manual',qps:100,maxConcurrent:1}});
 const firstJob=queue.run(request('first',{engine:'baidu'}));
 const queuedController=new AbortController();
 const cancelledJob=queue.run(request('cancelled',{engine:'baidu',signal:queuedController.signal}));
 queuedController.abort();await assert.rejects(cancelledJob,e=>e.name==='AbortError');
 firstDone();await firstJob;
 await queue.run(request('third',{engine:'baidu'}));
 assert.deepEqual(executed,['first','third']);

 // 自动识别的单段限制不会让整个服务停止工作。
 const expected=create(async r=>{
   if(r.text==='ok')return 'ok';
   throw Object.assign(new Error('language'),{code:'NEED_SOURCE_LANGUAGE'});
 },{interval:0});
 for(const text of ['label1','label2','label3','label4'])await assert.rejects(expected.run(request(text)),e=>e.code==='NEED_SOURCE_LANGUAGE');
 assert.equal(await expected.run(request('ok')),'ok');
 console.log('PASS: 消费者隔离、底层取消、队列取消、取消后恢复、识别限制不熔断');
 console.log('PASS: 请求合并、缓存隔离/过期/淘汰、失败冷却、服务熔断、手动批次保护、并发限制');
})().catch(e=>{console.error(e);process.exitCode=1;});
