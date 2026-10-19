const {chromium}=require('playwright');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const version=JSON.parse(fs.readFileSync(path.join(root,'manifest.json'))).version;
(async()=>{
 const calls=[];
 const server=http.createServer((req,res)=>{
   if(req.url==='/v1/chat/completions'){
     let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{
       const data=JSON.parse(body);calls.push({authorization:req.headers.authorization,data});
       res.writeHead(200,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
       res.end(JSON.stringify({choices:[{message:{content:'本地测试译文：'+data.messages[1].content}}]}));
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
     const originalFetch=fetch;
     globalThis.fetch=(url,options)=>originalFetch(String(url).startsWith('https://api.deepseek.com/v1/')?base+'/v1/chat/completions':url,options);
     if(!await chrome.permissions.contains({origins:['http://localhost:11434/*']}))throw Error('默认本机端口权限检查失败');
   },origin);
   const page=await context.newPage();page.on('console',msg=>{if(msg.type()==='error'||msg.type()==='warn')console.log('EXTENSION:',msg.text());});page.on('pageerror',error=>console.log('PAGE:',error.message));await page.goto(origin+'/fixture');
   await page.waitForSelector('.bt-fab-wrap');
   assert.equal(calls.length,0,'fresh page does not automatically transmit text');
   async function send(action){
     await worker.evaluate(async({url,action})=>{
       const tabs=await chrome.tabs.query({url});
       await chrome.tabs.sendMessage(tabs[0].id,{action}).catch(()=>{});
     },{url:origin+'/fixture',action});
   }
   await send('START_TRANSLATION');
   try {await page.waitForFunction(()=>document.querySelectorAll('.bt-translation-text').length===2);}catch(error){console.log('调试：本地接口调用次数',calls.length,'页面状态',await page.locator('body').innerText());throw error;}
   assert.equal(calls.length,1,'real background merges duplicate requests');
   assert.equal(calls[0].authorization,'Bearer local-test-key');
   assert.equal(calls[0].data.model,'local-model');
   assert.equal(await page.inputValue('#input'),'private input');
   await page.evaluate(()=>document.querySelector('#first').appendChild(document.createTextNode(' updated')));
   await page.waitForFunction(()=>document.querySelector('#first .bt-translation-text')?.textContent.includes('updated'));
   assert.equal(calls.length,2);
   await send('CANCEL_TRANSLATION');await page.waitForFunction(()=>!document.querySelector('.bt-translation-text'));
   const beforeCancel=calls.length;
   await page.evaluate(()=>document.querySelector('#first').textContent='Changed after cancel');
   await page.waitForTimeout(600);assert.equal(calls.length,beforeCancel);
   const settings=await context.newPage();
   await settings.goto('chrome-extension://'+id+'/settings/settings.html');
   await settings.waitForFunction(expected=>document.querySelector('#version')?.textContent==='v'+expected,version);
   assert.equal(await settings.locator('#aboutVersion').textContent(),version);
   assert.ok(await settings.locator('text=隐私与数据').count());
   const errors=await worker.evaluate(async()=>{
     const stored=await chrome.storage.sync.get(['aiKeys','baiduKey']);
     return Object.keys(stored);
   });
   assert.equal(errors.length,0,'keys not written back to sync');
   console.log('PASS Chromium extension: 实际加载、后台接口、合并重复请求、动态补翻、输入保护、取消暂停、设置页版本与隐私');
 }finally{
   if(context)await context.close();
   await new Promise(resolve=>server.close(resolve));
   // 仅清理本测试在系统临时目录创建的独立资料，绝不访问日常浏览器资料。
   const resolved=path.resolve(profile),tempRoot=path.resolve(os.tmpdir())+path.sep;
   if(!resolved.startsWith(tempRoot)||!path.basename(resolved).startsWith('yezhiyi-test-'))throw Error('临时目录校验失败');
   fs.rmSync(resolved,{recursive:true,force:true});
 }
})().catch(e=>{console.error(e);process.exitCode=1;});
