/**
 * 测试模块：百度凭据验证状态。
 * 隔离方式：加载真实后台模块，以模拟接口和共享存储控制异步顺序。
 * 验收范围：测试来源、缓存绕过、凭据绑定、旧测试隔离、取消和验证记录写入。
 * 执行：node tests/baidu-verification.cjs
 */
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
/**
 * 通过短轮询等待受控异步状态达到条件，超时直接断言失败，不让测试无限等待。
 */
async function until(predicate){for(let i=0;i<40;i++){if(predicate())return;await tick();}assert.fail('模拟网络未开始');}
/**
 * 构造可重复读取的成功百度响应；正文深拷贝，避免测试共享对象产生污染。
 */
function response(data={trans_result:[{dst:'你好，世界'}]}){return {ok:true,status:200,async json(){return structuredClone(data);}};}
/**
 * 在独立 VM 加载真实后台与调度器，返回消息、存储和可控 fetch 入口。
 */
function setup(){
 const sync={},local={baiduAppId:'test-app',baiduKey:'test-key'},writes=[],calls=[];
 let listener,sequence=0,fetchImpl=async()=>response();
 const area=(data,name)=>({
   async get(keys){return Object.fromEntries(keys.filter(k=>Object.hasOwn(data,k)).map(k=>[k,structuredClone(data[k])]));},
   async set(value){value=structuredClone(value);writes.push({name,value});Object.assign(data,value);},
   async remove(keys){keys.forEach(k=>delete data[k]);}
 });
 const getURL=name=>'chrome-extension://unit-test/'+name;
 const context={console,URL,URLSearchParams,AbortController,AbortSignal,TextEncoder,
   setTimeout(fn,ms){const timer=setTimeout(fn,ms);timer.unref();return timer;},clearTimeout,
   chrome:{storage:{sync:area(sync,'sync'),local:area(local,'local')},
     runtime:{getURL,onInstalled:{addListener(){}},onMessage:{addListener(fn){listener=fn;}}},
     contextMenus:{onClicked:{addListener(){}}},action:{onClicked:{addListener(){}}},
     commands:{onCommand:{addListener(){}}},permissions:{async contains(){return true;}},
     i18n:{getUILanguage(){return 'zh-CN';}}
   }};
 context.self=context;vm.createContext(context);
 context.fetch=(url,options={})=>{
   calls.push({url:String(url),options});
   return new Promise((resolve,reject)=>{
     const signal=options.signal,abort=()=>reject(Object.assign(Error('cancelled'),{name:'AbortError'}));
     if(signal?.aborted){abort();return;}
     signal?.addEventListener('abort',abort,{once:true});
     Promise.resolve().then(()=>fetchImpl(url,options)).then(
       result=>{signal?.removeEventListener('abort',abort);resolve(result);},
       error=>{signal?.removeEventListener('abort',abort);reject(error);}
     );
   });
 };
 context.importScripts=(...names)=>{for(const name of names){
   const file=path.resolve(root,'background',name);
   vm.runInContext(fs.readFileSync(file,'utf8'),context,{filename:file});
   if(file===path.join(root,'core','translation-runtime.js')){
     const create=context.BT_CREATE_TRANSLATION_RUNTIME;
     context.BT_CREATE_TRANSLATION_RUNTIME=(execute,options={})=>create(execute,{...options,interval:0});
   }
 }};
 vm.runInContext(fs.readFileSync(path.join(root,'background/service-worker.js'),'utf8'),context);
 const settingsSender={url:getURL('settings/settings.html'),tab:{id:1},frameId:0,documentId:'settings'};
 const pageSender={url:'https://page.example/',tab:{id:2},frameId:0,documentId:'page'};
 const send=(message,sender=pageSender)=>new Promise(resolve=>listener(message,sender,resolve));
 return {local,writes,calls,send,settingsSender,storage:context.BT_STORAGE,constants:context.BT_CONST,
   setFetch(fn){fetchImpl=fn;},
   translate(text='Hello world',extra={}){return send({action:'TRANSLATE',engine:'baidu',text,from:'en',to:'zh-CN',runToken:'page-'+ ++sequence,...extra});},
   test(extra={},sender=settingsSender){return send({action:'TEST_BAIDU_CONNECTION',baiduTestCredentials:{baiduAppId:local.baiduAppId,baiduKey:local.baiduKey},runToken:'test-'+ ++sequence,...extra},sender);}
 };
}
(async()=>{
 const t=setup();
 assert.equal((await t.translate('Hello world',{verifyBaidu:true,bypassCache:true})).ok,false);
 assert.equal(t.calls.length,0,'普通消息不能绕过验证');
 assert.equal((await t.test({}, {url:'https://page.example/'})).ok,false);
 await t.storage.set({baiduVerification:{fingerprint:t.constants.getBaiduCredentialFingerprint(t.local)}});
 assert.equal(t.local.baiduVerification,undefined,'普通保存不能伪造验证');
 assert.equal((await t.test()).ok,true);
 assert.equal(t.calls.length,1);
 assert.equal(t.constants.hasVerifiedBaiduCredentials(t.local),true);
 assert.ok(t.local.baiduVerification.verifiedAt>0);
 assert.ok(t.writes.filter(w=>w.name==='sync').every(w=>!Object.hasOwn(w.value,'baiduVerification')));
 assert.equal((await t.translate()).ok,true);assert.equal(t.calls.length,2);
 assert.equal((await t.translate()).ok,true);assert.equal(t.calls.length,2,'普通翻译保留缓存');
 assert.equal((await t.test()).ok,true);assert.equal(t.calls.length,3,'重测必须真实请求');
 const verified=structuredClone(t.local.baiduVerification);
 await t.storage.set({baiduAppId:t.local.baiduAppId,baiduKey:t.local.baiduKey,baiduVerification:null});
 assert.deepEqual(t.local.baiduVerification,verified,'普通保存不能覆盖验证');
 await t.storage.set({baiduKey:'changed-key'});
 assert.equal(t.local.baiduVerification,null);
 assert.equal(t.writes.filter(w=>w.name==='local'&&w.value.baiduKey==='changed-key').at(-1).value.baiduVerification,null);
 const before=t.calls.length;
 assert.equal((await t.translate()).ok,false);assert.equal(t.calls.length,before);
 assert.equal((await t.test()).ok,true);
 t.setFetch(async()=>response({error_code:'52003',error_msg:'UNAUTHORIZED USER'}));
 assert.equal((await t.test()).ok,false);assert.equal(t.local.baiduVerification,null);
 assert.equal((await t.translate()).ok,false,'旧普通缓存不能绕过已作废验证');

 const changed=setup(),held=deferred();
 changed.setFetch(()=>held.promise);
 const old=changed.test();await until(()=>changed.calls.length===1);
 await changed.storage.set({baiduKey:'new-key'});held.resolve(response());
 assert.equal((await old).ok,false);
 assert.equal(changed.constants.hasVerifiedBaiduCredentials(changed.local),false);

 const circuit=setup();assert.equal((await circuit.test()).ok,true);
 circuit.setFetch(async()=>{throw Error('simulated network failure');});
 for(const text of ['failed-a','failed-b','failed-c'])assert.equal((await circuit.translate(text)).ok,false);
 const attempts=circuit.calls.length;
 assert.match((await circuit.translate('blocked-d')).error,/连续失败/);
 assert.equal(circuit.calls.length,attempts);
 circuit.setFetch(async()=>response());
 assert.equal((await circuit.test({retryManual:false})).ok,true);
 assert.equal(circuit.calls.length,attempts+1,'测试不被旧翻译熔断阻止');

 for(const olderSuccess of [true,false]){
   const overlap=setup(),first=deferred();
   const failure=response({error_code:'52003',error_msg:'UNAUTHORIZED USER'});
   overlap.setFetch(()=>overlap.calls.length===1?first.promise:Promise.resolve(olderSuccess?failure:response()));
   const older=overlap.test();await until(()=>overlap.calls.length===1);
   const newer=overlap.test();await tick();
   first.resolve(olderSuccess?response():failure);
   assert.equal((await older).ok,false);
   assert.equal((await newer).ok,!olderSuccess);
   assert.equal(overlap.constants.hasVerifiedBaiduCredentials(overlap.local),!olderSuccess,'旧结果不能覆盖新测试');
 }

 const cancelled=setup();assert.equal((await cancelled.test()).ok,true);
 const previous=structuredClone(cancelled.local.baiduVerification),pendingResponse=deferred();
 cancelled.setFetch(()=>pendingResponse.promise);
 const pending=cancelled.test({runToken:'cancel-test'});await until(()=>cancelled.calls.length===2);
 await cancelled.send({action:'CANCEL_TRANSLATION_REQUESTS',runToken:'cancel-test'},cancelled.settingsSender);
 assert.equal((await pending).ok,false);
 assert.deepEqual(cancelled.local.baiduVerification,previous,'取消不作废此前有效验证');
 console.log('PASS: 百度来源限制、真实测试与缓存绕过、凭据绑定及失效、保存保护、旧结果隔离、取消');
})().catch(error=>{console.error(error);process.exitCode=1;});
