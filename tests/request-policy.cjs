// 真实调度规则回归：不访问外部接口，使用可控本地执行器观察发送顺序与额度。
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),path=require('node:path');
const context={TextEncoder,URL,setTimeout,clearTimeout,AbortController,console};vm.createContext(context);
for(const file of ['translation-units.js','request-policy.js','translation-runtime.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../core',file),'utf8'),context);
const P=context.BT_REQUEST_POLICY,create=context.BT_CREATE_TRANSLATION_RUNTIME;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const request=(text,extra={})=>({engine:'google',from:'en',to:'zh-CN',text,...extra});
const manual=(qps,maxConcurrent)=>({mode:'manual',qps,maxConcurrent});
(async()=>{
 for(const engine of Object.keys(P.DEFAULTS)){
  const original=('中文👩🏽‍💻 English sentence. '.repeat(700));
  const parts=P.split(original,engine);assert.equal(parts.join(''),original);
  for(const part of parts){assert.ok(Array.from(part).length<=P.DEFAULTS[engine].maxChars);assert.ok(new TextEncoder().encode(part).length<=P.DEFAULTS[engine].maxBytes);}
 }
 assert.match(P.validate(manual(0,4)),/1/);assert.match(P.validate(manual(4,33)),/32/);
 assert.equal(P.resolve('baidu',null,{baidu:manual(10,6)}).qps,10);
 assert.equal(P.resolve('google',null,{google:{mode:'recommended',qps:99}}).qps,6);
 assert.equal(P.retryAfter({headers:{get:()=>String(48*3600)}}),48*3600*1000,'不可截短服务要求的等待时间');

 // QPS 与在途限制分别生效：同一秒滑动窗口不突发，等待不占在途名额。
 const starts=[];let active=0,peak=0;
 const paced=create(async()=>{starts.push(Date.now());active++;peak=Math.max(peak,active);await sleep(30);active--;return 'ok';});
 paced.updatePolicies({google:manual(4,2)});
 await Promise.all(Array.from({length:6},(_,i)=>paced.run(request('paced'+i))));
 assert.ok(peak<=2);for(let i=1;i<starts.length;i++)assert.ok(starts[i]-starts[i-1]>=235);
 for(let i=4;i<starts.length;i++)assert.ok(starts[i]-starts[i-4]>=995);

 // 隐藏只停新发送，在途结果保留；旧版本状态不能误恢复；主动任务优先。
 const sent=[],done=new Map();
 const runtime=create(r=>new Promise(resolve=>{sent.push(r.text);done.set(r.text,resolve);}),{interval:0});
 runtime.updatePolicies({google:manual(100,1)});
 runtime.setOwnerState('page',{visible:true,viewportEpoch:2,version:2});
 const first=runtime.run(request('inflight',{ownerKey:'page',viewportEpoch:1}));
 const old=runtime.run(request('old',{ownerKey:'page',viewportEpoch:1}));
 const current=runtime.run(request('current',{ownerKey:'page',viewportEpoch:2}));
 const shift=runtime.run(request('shift',{ownerKey:'page',priority:0}));
 runtime.setOwnerState('page',{visible:false,version:3});
 done.get('inflight')('retained');assert.equal(await first,'retained');await sleep(10);assert.deepEqual(sent,['inflight']);
 runtime.setOwnerState('page',{visible:true,version:2});await sleep(10);assert.equal(sent.length,1);
 runtime.setOwnerState('page',{visible:true,viewportEpoch:2,version:4});assert.deepEqual(sent,['inflight','shift']);
 done.get('shift')('shift result');await shift;await sleep(0);assert.equal(sent.at(-1),'current');
 done.get('current')('current result');await current;await sleep(0);assert.equal(sent.at(-1),'old');
 done.get('old')('old result');await old;

 // 相同请求可以由另一可见页面继续，不因第一个订阅者离开而重复发送。
 let shareCount=0;
 const shared=create(async()=>{shareCount++;return 'shared';},{interval:0});
 shared.setOwnerState('hidden',{visible:false,version:1});
 const hidden=shared.run(request('same',{ownerKey:'hidden'}));assert.equal(shareCount,0);
 const visible=shared.run(request('same',{ownerKey:'visible'}));
 assert.deepEqual(await Promise.all([hidden,visible]),['shared','shared']);assert.equal(shareCount,1);

 // AI 同账号不同模型共同限额，不同地址可独立；降低配置只约束后续新发送。
 const aiSent=[],aiDone=new Map();
 const ai=create(r=>new Promise(resolve=>{aiSent.push(r.text);aiDone.set(r.text,resolve);}),{interval:0});
 ai.updatePolicies({'ai:custom':manual(100,1)});
 const ar=(text,base,model)=>request(text,{engine:'ai',aiProvider:'custom',aiConfig:{base,key:'test',model}});
 const a=ai.run(ar('a','https://example.test/v1','one')),b=ai.run(ar('b','https://example.test/v1','two')),c=ai.run(ar('c','https://other.test/v1','one'));
 assert.deepEqual(aiSent,['a','c']);aiDone.get('a')('a');await a;await sleep(0);assert.deepEqual(aiSent,['a','c','b']);
 aiDone.get('b')('b');aiDone.get('c')('c');await Promise.all([b,c]);

 // 临时失败总共三次，永久错误一次；失败缓存也保留 exhausted 防止页面补翻重开循环。
 let attempts=0;
 const retry=create(async()=>{attempts++;throw Object.assign(Error('temporary'),{retryable:true,code:'RATE_LIMITED'});},{interval:0,retryDelay:1,random:()=>0});
 await assert.rejects(retry.run(request('retry')),e=>e.exhausted&&e.attempts===3);assert.equal(attempts,3);
 await assert.rejects(retry.run(request('retry')),e=>e.exhausted&&e.attempts===3);assert.equal(attempts,3);
 let authCount=0;const auth=create(async()=>{authCount++;throw Object.assign(Error('auth'),{permanent:true,retryable:false});},{interval:0});
 await assert.rejects(auth.run(request('auth')));assert.equal(authCount,1);

 // 服务等待跨离开/返回保留；手动重试也不能绕过 Retry-After。
 const signals=[],retryTimes=[];
 const backoff=create(async r=>{retryTimes.push(Date.now());if(retryTimes.length===1)throw Object.assign(Error('limit'),{retryable:true,retryAfterMs:180});return 'recovered';},{interval:0,retryDelay:1});
 const result=backoff.run(request('wait',{ownerKey:'p',onRetry:n=>signals.push(n)}));
 await sleep(20);assert.equal(signals.length,1);backoff.setOwnerState('p',{visible:false,version:1});await sleep(200);assert.equal(retryTimes.length,1);
 backoff.setOwnerState('p',{visible:true,version:2});assert.equal(await result,'recovered');assert.ok(retryTimes[1]-retryTimes[0]>=180);

 // 长段按顺序组合；成功分片命中缓存，不能在页面和后台各拆一次。
 const text='Sentence with meaningful words. '.repeat(100),parts=P.split(text,'mymemory');let partCalls=0;
 const chunks=create(async r=>{partCalls++;await sleep(r.text.length%3);return r.text;},{interval:0});
 assert.equal(await chunks.runText(request(text,{engine:'mymemory'})),parts.join(' '));
 const count=partCalls;await chunks.runText(request(text,{engine:'mymemory'}));assert.equal(partCalls,count);

 // 三个页面轮转，不能只在前两个页面间交替而使第三页饥饿；策略变更立即作用于等待任务。
 const fairOrder=[],fairDone=new Map();
 const fair=create(r=>new Promise(resolve=>{fairOrder.push(r.text);fairDone.set(r.text,resolve);}),{interval:0});
 fair.updatePolicies({google:manual(100,1)});
 const fairJobs=['a1','a2','a3','b1','b2','c1','c2'].map(text=>fair.run(request(text,{ownerKey:text[0]})));
 for(const text of ['a1','b1','c1','a2','b2','c2','a3']){assert.equal(fairOrder.at(-1),text);fairDone.get(text)(text);await sleep(0);}
 await Promise.all(fairJobs);
 const changeDone=[];let changeStarts=0;
 const changed=create(()=>new Promise(resolve=>{changeStarts++;changeDone.push(resolve);}),{interval:0});
 changed.updatePolicies({google:manual(100,1)});
 const changeA=changed.run(request('changeA')),changeB=changed.run(request('changeB'));
 assert.equal(changeStarts,1);changed.updatePolicies({google:manual(100,2)});assert.equal(changeStarts,2);
 changeDone.forEach(resolve=>resolve('ok'));await Promise.all([changeA,changeB]);
 // 响应正文与响应头共享截止时间；非法 JSON 的原始内容不进入用户错误提示。
 let bodyAborted=false;
 await assert.rejects(P.readJson({__btDeadline:Date.now()+15,__btAbort(){bodyAborted=true;},json:()=>new Promise(()=>{})}),e=>e.code==='TIMEOUT'&&e.retryable);
 assert.equal(bodyAborted,true);
 await assert.rejects(P.readJson({json:async()=>{throw new SyntaxError('do not echo response body');}}),e=>e.code==='INVALID_RESPONSE'&&!e.message.includes('echo'));


 // 长段和短段交替取得发送名额；单段独占页面时不降低可用并发。
 const partOrder=[],partDone=new Map();
 const aiFair=create(r=>new Promise(resolve=>{partOrder.push(r.text);partDone.set(r.text,resolve);}));
 aiFair.updatePolicies({'ai:custom':manual(100,4)});
 const longText=Array.from({length:6400},(_,i)=>String.fromCharCode(65+i%26)).join('');
 const aiRequest={engine:'ai',aiProvider:'custom',aiConfig:{base:'https://fair.test/v1',key:'fake'},from:'en',to:'zh-CN',ownerKey:'page'};
 const longJob=aiFair.runText({...aiRequest,text:longText});
 const shortJob=aiFair.runText({...aiRequest,text:'Short useful heading'});
 const secondShort=aiFair.runText({...aiRequest,text:'Second short heading'});
 await sleep(60);
 assert.equal(partOrder.length,4);
 assert.equal(partOrder[1],'Short useful heading');assert.equal(partOrder[3],'Second short heading');
 for(let i=0;i<10;i++){for(const [text,resolve]of [...partDone]){partDone.delete(text);resolve(text);}await sleep(20);}
 assert.equal(await shortJob,'Short useful heading');assert.equal(await secondShort,'Second short heading');
 assert.equal(await longJob,P.split(longText,'ai').join(' '));
 let soloActive=0,soloPeak=0;
 const solo=create(async r=>{soloPeak=Math.max(soloPeak,++soloActive);await sleep(5);soloActive--;return r.text;},{interval:0});
 await solo.runText({...aiRequest,text:longText});assert.equal(soloPeak,4,'只有长段时仍使用四个请求名额');

 // 耗时诊断只报告阶段与数值；排队、接口执行及配置差异可分别定位，不含请求内容与凭据。
 let clock=100,releaseDiagnostic;
 const events=[];
 const measured=create(async r=>{
   if(r.text==='PRIVATE_SOURCE_ONE')await new Promise(resolve=>{releaseDiagnostic=resolve;});
   r.reportDiagnostic?.('http_headers',{headersMs:8,status:200});
   return 'PRIVATE_TRANSLATED_RESULT';
 },{interval:0,now:()=>clock});
 measured.updatePolicies({'ai:custom':manual(100,1)});
 const sensitive={engine:'ai',aiProvider:'custom',aiConfig:{base:'https://private-host.test/v1',key:'PRIVATE_CREDENTIAL',model:'PRIVATE_MODEL'},
   from:'en',to:'zh-CN',ownerKey:'PRIVATE_OWNER',onDiagnostic:e=>events.push(e)};
 const measuredFirst=measured.runText({...sensitive,text:'PRIVATE_SOURCE_ONE'});
 const measuredSecond=measured.runText({...sensitive,text:'PRIVATE_SOURCE_TWO'});
 clock=180;releaseDiagnostic();await Promise.all([measuredFirst,measuredSecond]);
 assert.ok(events.some(e=>e.phase==='request_wait'&&e.reason==='concurrency'));
 assert.ok(events.some(e=>e.phase==='request_start'&&e.queueMs===80));
 assert.ok(events.some(e=>e.phase==='request_success'&&e.executionMs===80));
 assert.ok(events.some(e=>e.phase==='http_headers'&&e.headersMs===8));
 assert.equal(events.filter(e=>e.phase==='task_complete').length,2);
 await measured.runText({...sensitive,text:'PRIVATE_SOURCE_TWO'});
 assert.ok(events.some(e=>e.phase==='cache_hit'));
 const serialized=JSON.stringify(events);
 for(const secret of ['PRIVATE_SOURCE','PRIVATE_TRANSLATED','PRIVATE_CREDENTIAL','PRIVATE_MODEL','PRIVATE_OWNER','private-host'])assert.ok(!serialized.includes(secret));
 // 回调只是观察者：日志消费者失败不会改变翻译结果。
 assert.equal(await measured.runText({...sensitive,text:'another task',onDiagnostic(){throw Error('logger failed');}}),'PRIVATE_TRANSLATED_RESULT');
 // 诊断显示真实账号限制，而不是只重复当前入口的推荐设置；此测试不修改旧入口取最小值的既有规则。
 const restrictions=[];
 const restricted=create(async()=> 'ok',{interval:0});
 restricted.updatePolicies({'ai:custom':manual(100,1)});
 await restricted.runText({...sensitive,text:'register former entry',onDiagnostic:undefined});
 restricted.removeOwner('PRIVATE_OWNER');
 await restricted.runText({...sensitive,aiProvider:'deepseek',text:'current entry',onDiagnostic:e=>restrictions.push(e)});
 const actualPolicy=restrictions.find(e=>e.phase==='request_start');
 assert.equal(actualPolicy.configuredMaxConcurrent,4);assert.equal(actualPolicy.maxConcurrent,1);
 assert.ok(actualPolicy.policySources.some(p=>p.service==='ai:custom'&&p.maxConcurrent===1));

 // 标记可重排但不能丢失/重复；碰撞时换命名空间，译文仅作为文本还原。
 const U=context.BT_TRANSLATION_UNITS;
 const protectedText=U.encode([{text:'Use '},{text:'@ComponentScan',protected:true},{text:' and '},{text:'com.example.project',protected:true}]);
 assert.equal(U.decode(protectedText.text,protectedText),'Use @ComponentScan and com.example.project');
 assert.equal(U.decode('⟦YZY0:1⟧ before ⟦YZY0:0⟧',protectedText),'com.example.project before @ComponentScan');
 for(const broken of ['missing tokens','⟦YZY0:0⟧ twice ⟦YZY0:0⟧','⟦YZY0:0⟧ and ⟦YZY0:99⟧'])assert.throws(()=>U.decode(broken,protectedText),e=>e.code==='PROTECTED_CONTENT_CHANGED'&&e.retryable===false);
 // 只容忍格式变化：括号、全角字符、空白、大小写及零宽分隔符；正文绝不做全局 NFKC。
 for(const [first,second]of [
  ['[YZY0:0]','[YZY0:1]'],['[[YZY0:0]]','[[YZY0:1]]'],
  ['【YZY0：0】','【YZY0：1】'],['［ＹＺＹ０：０］','［ＹＺＹ０：１］'],
  ['⟦ yzy 0 : 0 ⟧','⟦YZY0:1⟧'],['⟦Y\u200bZY0:0⟧','⟦YZY0:1⟧']]){
   assert.equal(U.decode('译文：'+second+'，再用'+first,protectedText),'译文：com.example.project，再用@ComponentScan');
 }
 assert.equal(U.decode('ＡＢＣ ① '+protectedText.text,protectedText),'ＡＢＣ ① Use @ComponentScan and com.example.project');
 assert.equal(U.decode('[explanation '+protectedText.text+']',protectedText),'[explanation Use @ComponentScan and com.example.project]');
 assert.equal(U.decode('【说明 '+protectedText.text+'】',protectedText),'【说明 Use @ComponentScan and com.example.project】');
 for(const response of ['[YZY0:0]','[YZY0:0] and 【YZY0:0】','[YZY0:0] and [YZY0:99]',
   protectedText.text+' [YZY9:0]',protectedText.text+' [YZY0:bad]', '[YZY0:0】 and [YZY0:1]']){
   assert.throws(()=>U.decode(response,protectedText),e=>e.code==='PROTECTED_CONTENT_CHANGED'&&e.retryable===false);
 }
 try{U.decode('[YZY0:0] twice 【YZY0:0】',protectedText);assert.fail('must reject');}catch(e){
   assert.equal(e.markerDiagnostics.expected,2);assert.equal(e.markerDiagnostics.missing,1);assert.equal(e.markerDiagnostics.duplicates,1);
   assert.ok(!JSON.stringify(e.markerDiagnostics).includes('@ComponentScan'));
 }
 const variantCollision=U.encode([{text:'Literal ［ＹＺＹ０：０］ plus '},{text:'safe',protected:true}]);
 assert.equal(variantCollision.nonce,1);
 assert.equal(U.decode(variantCollision.text,variantCollision),'Literal ［ＹＺＹ０：０］ plus safe');
 const collision=U.encode([{text:'Literal ⟦YZY0:0⟧ plus '},{text:'safe',protected:true}]);
 assert.equal(collision.nonce,1);assert.equal(U.decode(collision.text,collision),'Literal ⟦YZY0:0⟧ plus safe');
 for(const engine of Object.keys(P.DEFAULTS)){
  const limit=P.DEFAULTS[engine].maxChars;
  const content='A'.repeat(Math.min(limit,P.DEFAULTS[engine].maxBytes)-4)+protectedText.text+' 中文👩🏽‍💻';
  const parts=P.split(content,engine);assert.equal(parts.join(''),content);
  for(const token of content.match(/⟦YZY\d+:\d+⟧/g)||[])assert.ok(parts.some(part=>part.includes(token)),'保护标记不能跨分片：'+engine);
  for(const part of parts){assert.ok(Array.from(part).length<=P.DEFAULTS[engine].maxChars);assert.ok(new TextEncoder().encode(part).length<=P.DEFAULTS[engine].maxBytes);}
 }
 console.log('PASS: 行内保护编解码、标记重排/缺失/重复校验、命名空间碰撞与各服务分块原子性');

 console.log('PASS: 诊断排队/执行耗时、缓存命中、真实账号限额、日志回调隔离及敏感信息排除');

 console.log('PASS: Unicode/字节、配置校验、真实QPS/并发、隐藏在途保留、旧状态隔离、主动/视口优先、跨页共享、AI账号隔离、有限重试、等待保留、统一分块缓存');
})().catch(error=>{console.error(error);process.exitCode=1;});
