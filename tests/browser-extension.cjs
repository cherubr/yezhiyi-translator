// 完整扩展回归：用独立测试配置加载扩展，并用本地模拟接口验证后台与页面协作。
const {chromium}=require('playwright');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
// 可指定已解压的白名单包，验证真正交付的运行文件。
const root=process.env.YEZHIYI_EXTENSION_DIR?path.resolve(process.env.YEZHIYI_EXTENSION_DIR):path.resolve(__dirname,'..');
const version=JSON.parse(fs.readFileSync(path.join(root,'manifest.json'))).version;
(async()=>{
 const calls=[];
 const server=http.createServer((req,res)=>{
   if(req.url==='/v1/chat/completions'){
     let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{
       const data=JSON.parse(body);
       const record={authorization:req.headers.authorization,data,aborted:false};calls.push(record);
       const respond=()=>{if(res.destroyed)return;res.writeHead(200,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});res.end(JSON.stringify({choices:[{message:{content:'本地测试译文：'+data.messages[1].content}}]}));};
       if(data.messages[1].content.startsWith('Slow')) {
         res.writeHead(200,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
         res.write('{"choices":[');
         const timer=setTimeout(()=>{if(!res.destroyed)res.end('{"message":{"content":"旧引擎迟到结果"}}]}');},3000);
         res.on('close',()=>{if(!res.writableEnded){record.aborted=true;clearTimeout(timer);}});
       }else respond();
     });
   }else if(req.url==='/fixture'){
     res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
     res.end('<!doctype html><html lang="en"><body><p id="first">Hello release</p><p id="second">Hello release</p><input id="input" value="private input"></body></html>');
   }else if(req.url==='/favicon.ico'){res.writeHead(204);res.end();}else{res.writeHead(404);res.end();}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const origin='http://127.0.0.1:'+server.address().port;
 const profile=fs.mkdtempSync(path.join(os.tmpdir(),'yezhiyi-test-'));
 let context;
 try{
   context=await chromium.launchPersistentContext(profile,{channel:'chromium',headless:true,args:['--disable-extensions-except='+root,'--load-extension='+root]});
   let worker=context.serviceWorkers()[0];
   if(!worker)worker=await context.waitForEvent('serviceworker');
   const id=new URL(worker.url()).host;
   await worker.evaluate(async base=>{
     await chrome.storage.sync.set({engine:'ai',aiProvider:'custom',autoTranslate:false,from:'en',to:'zh-CN',concurrency:4});
     await chrome.storage.local.set({aiKeys:{custom:{key:'local-test-key',base:'https://api.deepseek.com/v1',model:'local-model'}}});
     // 仅在测试资料中拦截传输层：已授权域名的请求转至本地模拟接口，不发送到外部。
     // 在独立测试后台记录插件主动日志，发布模式应始终为零。
     globalThis.extensionLogCount=0;
     for(const level of ['debug','info','warn','error']){
       const originalLog=console[level];
       console[level]=(...args)=>{
         if(String(args[0]).startsWith('[页知译]')||String(args[0]).startsWith('[双语翻译]'))globalThis.extensionLogCount++;
         originalLog.apply(console,args);
       };
     }
     const originalFetch=fetch;
     globalThis.baiduCalls=[];
     globalThis.googleCalls=[];
     globalThis.fetch=(url,options)=>{
       if(String(url).startsWith('https://translate.googleapis.com/')){
         const text=new URL(url).searchParams.get('q');
         globalThis.googleCalls.push(text);
         const result=new Response(JSON.stringify([[['新引擎：'+text]]]),{headers:{'Content-Type':'application/json'}});
         return text.startsWith('Scroll') ? new Promise(resolve=>setTimeout(()=>resolve(result),700)) : Promise.resolve(result);
       }
       if(String(url).startsWith('https://fanyi-api.baidu.com/api/trans/vip/translate')){
         const params=options?.body ? new URLSearchParams(options.body) : new URL(url).searchParams;
         globalThis.baiduCalls.push({appId:params.get('appid'),text:params.get('q')});
         const data=params.get('appid')==='invalid-app'
           ? {error_code:'52003',error_msg:'UNAUTHORIZED USER'}
           : {trans_result:[{dst:'百度测试译文：'+params.get('q')}]};
         return Promise.resolve(new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json'}}));
       }
       return originalFetch(String(url).startsWith('https://api.deepseek.com/v1/')?base+'/v1/chat/completions':url,options);
     };
     if(!await chrome.permissions.contains({origins:['http://localhost:11434/*']}))throw Error('默认本机端口权限检查失败');
   },origin);
   const diagnosticLogs=[],pluginLogs=[];
   const page=await context.newPage();page.on('console',msg=>{if(msg.text().startsWith('[页知译]')||msg.text().startsWith('[双语翻译]'))pluginLogs.push(msg.text());if(['info','debug'].includes(msg.type())&&msg.text().startsWith('[页知译][诊断]'))diagnosticLogs.push(msg.text());if(msg.type()==='error'||msg.type()==='warn')console.log('EXTENSION:',msg.text());});page.on('pageerror',error=>console.log('PAGE:',error.message));await page.goto(origin+'/fixture');
   await page.waitForSelector('.bt-fab-wrap');
   assert.equal(calls.length,0,'fresh page does not automatically transmit text');
   async function send(action,extra={}){
     await worker.evaluate(async({url,action,extra})=>{
       const tabs=await chrome.tabs.query({url});
       await chrome.tabs.sendMessage(tabs[0].id,{action,...extra}).catch(()=>{});
     },{url:origin+'/fixture',action,extra});
   }
   await send('START_TRANSLATION');
   try {await page.waitForFunction(()=>document.querySelectorAll('.bt-translation-text').length===2);}catch(error){console.log('调试：本地接口调用次数',calls.length,'页面状态',await page.locator('body').innerText());throw error;}
   assert.equal(calls.length,1,'real background merges duplicate requests');
   // 工具栏消息按页面实际状态切换面板；普通详情入口反复打开仍只保留一个实例。
   await send('OPEN_PANEL',{toggle:true});assert.equal(await page.locator('.bt-modal').count(),1);
   await send('OPEN_PANEL',{toggle:true});assert.equal(await page.locator('.bt-modal').count(),0);
   assert.equal(await page.locator('.bt-translation-text').count(),2,'关闭面板不能取消已有译文');
   await send('OPEN_PANEL',{toggle:true});assert.equal(await page.locator('.bt-modal').count(),1);
   await send('OPEN_PANEL');await send('OPEN_PANEL');assert.equal(await page.locator('.bt-modal').count(),1);
   await page.locator('.bt-modal-close').click();
   assert.equal(calls.length,1,'切换面板不发起新的翻译请求');

   assert.equal(calls[0].authorization,'Bearer local-test-key');
   assert.equal(calls[0].data.model,'local-model');
   assert.ok(!calls[0].data.messages[0].content.includes('内部标记'),'普通正文不附加保护指令');
   const debugEnabled=await worker.evaluate(()=>self.BT_LOG.isEnabled('debug'));
   if(debugEnabled)for(let i=0;i<100&&!diagnosticLogs.some(line=>line.includes('接口响应读取完成'));i++)await page.waitForTimeout(10);
   if(debugEnabled){
   assert.ok(diagnosticLogs.some(line=>line.includes('开始请求')&&line.includes('生效并发 4')),'后台诊断回传至网页控制台');
   assert.ok(diagnosticLogs.some(line=>line.includes('接口响应读取完成')),'真实传输层记录 HTTP 耗时');
   assert.ok(diagnosticLogs.some(line=>line.includes('译文已显示')),'记录页面插入阶段');
   for(const privateValue of ['local-test-key','Hello release','local-model'])assert.ok(!diagnosticLogs.join('\n').includes(privateValue));
   console.log('PASS Chromium extension: 网页控制台收到真实调度/HTTP/显示诊断，日志不含原文、模型配置或密钥');
   }else{
     assert.equal(diagnosticLogs.length,0,'发布配置不输出后台或页面诊断');
   }
   assert.equal(await page.inputValue('#input'),'private input');
   await page.evaluate(()=>document.querySelector('#first').appendChild(document.createTextNode(' updated')));
   await page.waitForFunction(()=>document.querySelector('#first .bt-translation-text')?.textContent.includes('updated'));
   assert.equal(calls.length,2,'手动启动当前页后，即使自动启动开关关闭也持续补翻');
   await send('CANCEL_TRANSLATION');await page.waitForFunction(()=>!document.querySelector('.bt-translation-text'));
   const beforeCancel=calls.length;
   await page.evaluate(()=>document.querySelector('#first').textContent='Changed after cancel');
   await page.waitForTimeout(600);assert.equal(calls.length,beforeCancel);
   await page.evaluate(()=>{
     document.querySelector('#first').textContent='Slow previous engine';
     document.querySelector('#second').textContent='Slow previous engine';
   });
   await send('START_TRANSLATION');
   await page.waitForFunction(()=>document.querySelector('.bt-fab').classList.contains('bt-busy'));
   for(let i=0;i<100&&!calls.some(x=>x.data.messages[1].content==='Slow previous engine');i++)await page.waitForTimeout(20);
   assert.ok(calls.some(x=>x.data.messages[1].content==='Slow previous engine'));
   await send('OPEN_PANEL');
   await page.locator('#btModalEngine').selectOption('google');
   await page.waitForFunction(()=>document.querySelector('#first .bt-translation-text')?.textContent.startsWith('新引擎：'));
   for(let i=0;i<50&&!calls.some(x=>x.data.messages[1].content==='Slow previous engine'&&x.aborted);i++)await page.waitForTimeout(20);
   assert.ok(calls.some(x=>x.data.messages[1].content==='Slow previous engine'&&x.aborted),'switch aborts old network request');
   assert.equal(await page.locator('#first .bt-translation-text').textContent(),'新引擎：Slow previous engine');
   const settings=await context.newPage();
   await settings.goto('chrome-extension://'+id+'/settings/settings.html');
   await settings.waitForFunction(expected=>document.querySelector('#version')?.textContent==='v'+expected,version);
   assert.equal(await settings.locator('#aboutVersion').textContent(),version);
   assert.equal(await settings.locator('#from option').count(),49);
   assert.equal(await settings.locator('#to option').count(),49);
   assert.equal(await settings.locator('#to option[value="ms"]').textContent(),'马来语');
   assert.equal(await settings.locator('#from option[value="my"]').textContent(),'缅甸语');
   await settings.locator('#to').selectOption('fr');
   await settings.waitForTimeout(300);
   assert.equal(await worker.evaluate(async()=>(await chrome.storage.sync.get('to')).to),'fr');
   await send('OPEN_PANEL');
   assert.equal(await page.locator('#btModalFrom option').count(),49);
   assert.equal(await page.locator('#btModalTo option').count(),49);
   await page.waitForFunction(()=>document.querySelector('#btModalTo')?.value==='fr');
   await page.locator('#btModalTo').selectOption('uk');
   await settings.bringToFront();
   await settings.waitForFunction(()=>document.querySelector('#to')?.value==='uk');

   // 保持设置标签页打开，验证详情页配置、真实百度测试和跨页引擎同步。
   await send('CANCEL_TRANSLATION');
   await worker.evaluate(()=>chrome.storage.sync.set({engine:'google',from:'en',to:'zh-CN',autoTranslate:false}));
   await settings.waitForFunction(()=>document.querySelector('#engine').value==='google');
   await page.waitForFunction(()=>document.querySelector('#btModalTo').value==='zh-CN');
   const openBaidu=async()=>{
     await settings.locator('.nav-item[data-tab="service"]').click();
     await settings.locator('.service-card').filter({hasText:'百度翻译'}).click();
   };
   await openBaidu();
   await settings.locator('#baiduAppId').fill('test-app');
   await settings.locator('#baiduKey').fill('test-key');
   await settings.locator('.nav-item[data-tab="general"]').click();
   await settings.waitForFunction(()=>document.querySelector('#engine option[value="baidu"]').disabled);
   assert.match(await settings.locator('#engine option[value="baidu"]').textContent(),/待测试/);
   assert.equal(await settings.locator('#engine').inputValue(),'google');
   await openBaidu();
   await settings.locator('#testBaidu').click();
   await settings.waitForFunction(()=>document.querySelector('#baiduTestResult').classList.contains('ok'));
   await settings.locator('.nav-item[data-tab="general"]').click();
   await settings.waitForFunction(()=>!document.querySelector('#engine option[value="baidu"]').disabled);
   assert.equal(await settings.locator('#engine').inputValue(),'google','测试通过不自动切换默认引擎');
   assert.equal(await worker.evaluate(()=>baiduCalls.length),1);

   // 相同凭据重测也要发真实请求，验证记录可在重新打开设置页后恢复。
   await openBaidu();
   await settings.locator('#testBaidu').click();
   await settings.waitForFunction(()=>document.querySelector('#baiduTestResult').classList.contains('ok'));
   assert.equal(await worker.evaluate(()=>baiduCalls.length),2,'重测绕过翻译缓存');
   const reopened=await context.newPage();
   await reopened.goto('chrome-extension://'+id+'/settings/settings.html');
   await reopened.waitForFunction(()=>document.querySelector('#engine option[value="baidu"]')?.disabled===false);
   await reopened.close();

   // 直接返回基本设置保留详情编辑上下文，面板切换仍必须即时更新下拉。
   await settings.locator('.nav-item[data-tab="general"]').click();
   await settings.locator('#engine').selectOption('baidu');
   await page.waitForFunction(()=>document.querySelector('#btModalEngine').value==='baidu');
   await page.locator('#btModalEngine').selectOption('google');
   await settings.waitForFunction(()=>document.querySelector('#engine').value==='google');

   // 修改与失败的凭据保持禁用，不能靠旧成功记录继续使用。
   await openBaidu();
   await settings.locator('#baiduAppId').fill('invalid-app');
   await settings.waitForFunction(()=>document.querySelector('#engine option[value="baidu"]').disabled);
   await settings.locator('#testBaidu').click();
   await settings.waitForFunction(()=>document.querySelector('#baiduTestResult').classList.contains('error'));
   assert.equal(await worker.evaluate(async()=>Boolean((await chrome.storage.local.get('baiduVerification')).baiduVerification)),false);
   assert.equal(await settings.locator('#engine option[value="baidu"]').evaluate(el=>el.disabled),true);

   // 真实扩展中的自动开关和滚动补翻状态，在用户正在浏览的前台标签中验证动画。
   await page.bringToFront();
   await send('OPEN_PANEL');
   await page.evaluate(()=>{document.querySelector('#first').textContent='Automatic current page';document.querySelector('#second').textContent='Automatic current page';});
   await page.locator('#btModalAuto').click();
   await page.waitForFunction(()=>document.querySelectorAll('.bt-translation-text').length===2);
   await settings.waitForFunction(()=>document.querySelector('#autoTranslate').classList.contains('on'));
   await page.evaluate(()=>{const p=document.createElement('p');p.id='scroll-status';p.textContent='Scroll new content';p.style.marginTop='1400px';document.body.appendChild(p);});
   await page.waitForTimeout(300);
   assert.equal(await page.locator('#scroll-status .bt-translation-text').count(),0,'离屏内容等待滚动');
   await page.locator('#scroll-status').scrollIntoViewIfNeeded();
   await page.waitForFunction(()=>document.querySelector('.bt-fab.bt-busy'),null,{polling:50,timeout:10000});
   assert.equal(await page.locator('.bt-fab-wrap.bt-translated').count(),0);
   assert.equal(await page.locator('.bt-fab-wrap.bt-has-error').count(),0);
   await page.waitForFunction(()=>document.querySelector('#scroll-status .bt-translation-text') && !document.querySelector('.bt-fab.bt-busy'));
   assert.equal(await page.locator('.bt-fab-wrap.bt-translated').count(),1);
   assert.equal(await page.locator('#btModalTranslate').textContent(),'重新翻译');


   // 新请求设置真正落到本机存储；开发规则不再出现在设置页面。
   await settings.bringToFront();
   await settings.locator('.nav-item[data-tab="general"]').click();
   await settings.locator('#configureCurrentService').click();
   await settings.locator('#requestMode').selectOption('manual');
   await settings.locator('#requestQps').fill('2');
   await settings.locator('#requestMaxConcurrent').fill('2');
   await settings.locator('#requestPolicySave').click();
   await settings.waitForFunction(()=>document.getElementById('requestPolicyResult').textContent.includes('已保存'));
   const policyStorage=await worker.evaluate(async()=>({local:await chrome.storage.local.get('requestPolicies'),sync:await chrome.storage.sync.get('requestPolicies')}));
   assert.deepEqual(policyStorage.local.requestPolicies.google,{mode:'manual',qps:2,maxConcurrent:2});
   assert.equal(policyStorage.sync.requestPolicies,undefined);
   assert.equal(await settings.locator('#requestRuleButton, #requestRulesDialog').count(),0);
   assert.equal(await settings.locator('#concurrency').count(),0);

   // 无界面 Chromium 不提供真实切页的 hidden 变化；模拟平台可见性事件，其余消息/接口/译文均走实际扩展。
   await page.bringToFront();await send('CANCEL_TRANSLATION');
   await page.evaluate(()=>{
     document.querySelector('#first').textContent='Scroll pause visible first';
     document.querySelector('#second').textContent='Scroll pause visible second';
     document.querySelector('#scroll-status').remove();
     for(let i=0;i<6;i++){const p=document.createElement('p');p.className='pause-fixture';p.textContent='Scroll pause remaining '+i;document.body.append(p);}
     window.scrollTo(0,0);
   });
   const lifecycleSession=await context.newCDPSession(page),worlds=[];
   lifecycleSession.on('Runtime.executionContextCreated',event=>worlds.push(event.context));
   await lifecycleSession.send('Runtime.enable');
   const contentWorld=worlds.find(world=>world.name.includes(id)||world.origin==='chrome-extension://'+id);
   assert.ok(contentWorld,'应找到扩展隔离世界：'+JSON.stringify(worlds.map(w=>({name:w.name,origin:w.origin}))));
   const setVisibility=async hidden=>lifecycleSession.send('Runtime.evaluate',{contextId:contentWorld.id,expression:"Object.defineProperty(document,'hidden',{configurable:true,value:"+hidden+"});document.dispatchEvent(new Event('visibilitychange'));"});
   const basePause=await worker.evaluate(()=>googleCalls.length);
   await send('START_TRANSLATION');
   await page.waitForFunction(()=>document.querySelector('.bt-fab.bt-busy'));
   for(let i=0;i<100&&(await worker.evaluate(()=>googleCalls.length))===basePause;i++)await page.waitForTimeout(10);
   assert.ok((await worker.evaluate(()=>googleCalls.length))>basePause);
   await settings.bringToFront();await setVisibility(true);
   await page.waitForTimeout(120);
   const sentAway=await worker.evaluate(()=>googleCalls.length);
   await page.waitForTimeout(1300);
   assert.equal(await worker.evaluate(()=>googleCalls.length),sentAway,'隐页不得继续发送新调用');
   assert.ok(await page.locator('.bt-translation-text').count()>0,'在途结果在隐页保留');
   const kept=await page.locator('.bt-translation-text').count();
   await page.bringToFront();
   await setVisibility(false);
   await page.waitForFunction(()=>document.querySelectorAll('.bt-translation-text').length===8);
   assert.ok(kept<8);
   await send('CANCEL_TRANSLATION');
   const countAfterCancel=await worker.evaluate(()=>googleCalls.length);
   await settings.bringToFront();await page.bringToFront();
   await page.evaluate(()=>document.querySelector('#first').textContent='Changed while cancelled and returned');
   await page.waitForTimeout(800);
   assert.equal(await worker.evaluate(()=>googleCalls.length),countAfterCancel,'取消后返回及动态变更不重启');
   console.log('PASS Chromium extension: 本机请求参数、移除开发规则入口、方案A隐页停止新发送、在途保留、返回续翻、取消后返回不恢复');


   // 已配置的全部 AI 厂商在两个入口一致可选；未配置厂商禁用，卡片仍可进入配置。
   await send('CANCEL_TRANSLATION');
   await worker.evaluate(async()=>{
     const stored=await chrome.storage.local.get('aiKeys');
     await chrome.storage.local.set({aiKeys:{...stored.aiKeys,
       deepseek:{key:'fake-deepseek',base:'https://api.deepseek.com/v1',model:'deepseek-test-model'},
       dashscope:{key:'fake-qwen',base:'https://api.deepseek.com/v1',model:'qwen-test-model'}}});
   });
   await page.bringToFront();await send('OPEN_PANEL');
   await page.waitForFunction(()=>document.querySelector('#btModalEngine option[value="ai:dashscope"]')?.disabled===false);
   await settings.waitForFunction(()=>document.querySelector('#engine option[value="ai:dashscope"]')?.disabled===false);
   const listOf=async(p,id)=>p.locator(id+' option').evaluateAll(options=>options.map(o=>({value:o.value,text:o.textContent,disabled:o.disabled})));
   assert.deepEqual(await listOf(page,'#btModalEngine'),await listOf(settings,'#engine'));
   assert.equal(await page.locator('#btModalEngine option[value="ai:openai"]').isDisabled(),true);
   await page.locator('#btModalEngine').selectOption('ai:custom');
   await settings.waitForFunction(()=>document.getElementById('engine').value==='ai:custom');
   await page.evaluate(()=>{document.getElementById('first').textContent='Slow AI provider switch';document.getElementById('second').textContent='Slow AI provider switch';});
   await send('START_TRANSLATION');
   for(let i=0;i<100&&!calls.some(x=>x.data.messages[1].content==='Slow AI provider switch'&&x.data.model==='local-model');i++)await page.waitForTimeout(20);
   assert.ok(calls.some(x=>x.data.messages[1].content==='Slow AI provider switch'&&x.data.model==='local-model'));
   await page.locator('#btModalEngine').selectOption('ai:dashscope');
   await settings.waitForFunction(()=>document.getElementById('engine').value==='ai:dashscope');
   for(let i=0;i<100&&!calls.some(x=>x.data.model==='qwen-test-model');i++)await page.waitForTimeout(20);
   assert.ok(calls.some(x=>x.data.model==='qwen-test-model'),'发送请求使用选中的具体厂商和模型');
   assert.ok(calls.some(x=>x.data.messages[1].content==='Slow AI provider switch'&&x.data.model==='local-model'&&x.aborted),'切换厂商中断旧模型请求');
   assert.match(await page.locator('#btModalModel').textContent(),/qwen-test-model/);
   assert.match(await page.locator('#btModalRequestPolicy').textContent(),/每秒最多 6 次，同时最多 4/);
   await send('CANCEL_TRANSLATION');
   await worker.evaluate(()=>chrome.storage.local.set({requestPolicies:{'ai:dashscope':{mode:'manual',qps:3,maxConcurrent:2}}}));
   await page.waitForFunction(()=>document.getElementById('btModalRequestPolicy').textContent.includes('手动配置：每秒最多 3 次，同时最多 2'));
   await page.evaluate(()=>{const select=document.getElementById('btModalEngine');for(const value of ['ai:deepseek','ai:custom']){select.value=value;select.dispatchEvent(new Event('change'));}});
   await settings.waitForFunction(()=>document.getElementById('engine').value==='ai:custom');
   await page.waitForFunction(()=>document.getElementById('btModalEngine').value==='ai:custom');
   const lastAI=await worker.evaluate(()=>chrome.storage.sync.get(['engine','aiProvider']));
   assert.deepEqual(lastAI,{engine:'ai',aiProvider:'custom'});
   assert.equal(await page.locator('.bt-translation-text').count(),0,'取消页快速切换厂商不重启翻译');
   console.log('PASS Chromium extension: 全部AI目录一致、未配置禁用、厂商模型切换与旧请求中止、实际参数即时显示、快速切换保留最后选择');


   // 真实后台收到完整段落及保护标记：短正文只发一个物理 AI 请求，返回后由页面恢复代码。
   await page.bringToFront();await send('CANCEL_TRANSLATION');
   await page.evaluate(()=>{
     for(const child of [...document.body.children])if(!child.matches('.bt-fab-wrap,.bt-modal,.bt-thumb,.bt-page-notice'))child.remove();
     const p=document.createElement('p');p.id='protectedFixture';
     p.innerHTML='Read the <a id="protectedLink" href="#guide">migration guide</a> for <code id="protectedCode">1.x</code> and <code>@ComponentScan</code> before upgrading.';
     document.body.prepend(p);window.scrollTo(0,0);
     window.savedProtectedCode=document.getElementById('protectedCode');window.savedProtectedLink=document.getElementById('protectedLink');
   });
   const beforeProtected=calls.length;
   await send('START_TRANSLATION');
   await page.waitForFunction(()=>document.querySelector('#protectedFixture > .bt-translation-text')?.textContent.includes('@ComponentScan'));
   const protectedCalls=calls.slice(beforeProtected).filter(call=>call.data.messages[1].content.includes('before upgrading.'));
   assert.equal(protectedCalls.length,1,'完整短段只发送一个实际 AI 请求');
   assert.match(protectedCalls[0].data.messages[1].content,/⟦YZY\d+:0⟧/);
   assert.match(protectedCalls[0].data.messages[0].content,/内部标记必须/);
   assert.ok(!protectedCalls[0].data.messages[1].content.includes('@ComponentScan'));
   assert.equal(await page.locator('#protectedFixture .bt-text-fragment').count(),0);
   assert.equal(await page.locator('#protectedFixture > .bt-translation-text').evaluate(el=>getComputedStyle(el).display),'block');
   await send('CANCEL_TRANSLATION');
   assert.equal(await page.evaluate(()=>savedProtectedCode===document.getElementById('protectedCode')&&savedProtectedLink===document.getElementById('protectedLink')),true);
   assert.equal(await page.locator('#protectedCode').textContent(),'1.x');
   console.log('PASS Chromium extension: 完整技术正文一个物理AI请求、后台保护标记传输、页面还原代码、正文分段展示与原节点保留');

   assert.ok(await settings.locator('text=隐私与数据').count());
   const errors=await worker.evaluate(async()=>{
     const stored=await chrome.storage.sync.get(['aiKeys','baiduKey']);
     return Object.keys(stored);
   });
   assert.equal(errors.length,0,'keys not written back to sync');
   const production=await worker.evaluate(()=>self.BT_CONST.LOG_CONFIG.environment==='production');
   if(production){
     assert.equal(pluginLogs.length,0,'发布包的页面不输出任何插件主动日志');
     assert.equal(await worker.evaluate(()=>globalThis.extensionLogCount),0,'发布包后台不输出任何插件主动日志');
     console.log('PASS Chromium extension: 实际发布包页面与后台零插件主动日志，翻译与错误界面仍可使用');
   }
   console.log('PASS Chromium extension: 实际加载、取消切换、百度真实验证与持久化、设置页即时同步、自动翻译和滚动状态');
 }finally{
   if(context)await context.close();
   await new Promise(resolve=>server.close(resolve));
   // 仅清理本测试在系统临时目录创建的独立资料，绝不访问日常浏览器资料。
   const resolved=path.resolve(profile),tempRoot=path.resolve(os.tmpdir())+path.sep;
   if(!resolved.startsWith(tempRoot)||!path.basename(resolved).startsWith('yezhiyi-test-'))throw Error('临时目录校验失败');
   fs.rmSync(resolved,{recursive:true,force:true});
 }
})().catch(e=>{console.error(e);process.exitCode=1;});
