/** 启用真实 BFCache 的往返测试；不以普通重新加载冒充缓存恢复。翻译使用本地模拟。 */
const {chromium}=require('playwright'),http=require('node:http'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const root=process.env.YEZHIYI_EXTENSION_DIR?path.resolve(process.env.YEZHIYI_EXTENSION_DIR):path.resolve(__dirname,'..');
(async()=>{
 const server=http.createServer((req,res)=>{
  const child=req.url.startsWith('/child'),b=req.url.startsWith('/b');
  res.writeHead(200,{'Content-Type':'text/html','Cache-Control':'max-age=600'});
  res.end(`<!doctype html><html lang="en"><head><title>${b?'B':'A'}</title></head><body><p id="source">${child?'Embedded frame readable English content':b?'Destination page readable English content':'Original page readable English content'}</p>${child?'':'<a id="navigate" href="/b">Open destination page</a><iframe src="/child" width="700" height="200"></iframe>'}<script>window.stamp=Math.random();window.restoreCount=0;addEventListener('pageshow',event=>{if(event.persisted)restoreCount++;document.body.dataset.restored=String(event.persisted);});</script></body></html>`);
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
 const profile=fs.mkdtempSync(path.join(os.tmpdir(),'yezhiyi-navigation-'));let context;
 try{
  context=await chromium.launchPersistentContext(profile,{channel:'chromium',headless:true,ignoreDefaultArgs:['--disable-back-forward-cache'],viewport:{width:1400,height:1000},args:['--disable-extensions-except='+root,'--load-extension='+root]});
  let worker=context.serviceWorkers()[0];if(!worker)worker=await context.waitForEvent('serviceworker');
  await worker.evaluate(async()=>{await chrome.storage.sync.set({engine:'google',from:'en',to:'zh-CN',autoTranslate:false});globalThis.navCalls=[];globalThis.navDelay=0;const original=fetch;globalThis.fetch=(url,options)=>{if(String(url).startsWith('https://translate.googleapis.com/')){const text=new URL(url).searchParams.get('q');navCalls.push(text);return new Promise(resolve=>setTimeout(()=>resolve(new Response(JSON.stringify([[['导航译文：'+text]]]))),navDelay));}return original(url,options);};});
  const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));await page.goto(base+'/a');await page.waitForSelector('.bt-fab');
  const tabId=await worker.evaluate(async url=>(await chrome.tabs.query({})).find(tab=>tab.url===url).id,page.url());
  const send=action=>worker.evaluate(({tabId,action})=>chrome.tabs.sendMessage(tabId,{action},{frameId:0}),{tabId,action});
  const translate=async()=>{await send('START_TRANSLATION');await page.waitForSelector('#source .bt-translation-text');await page.waitForFunction(()=>document.querySelector('iframe')?.contentDocument?.querySelector('.bt-translation-text'));};
  const history=async(direction,url)=>{
   await (direction==='back'?page.goBack({waitUntil:'commit',timeout:5000}):page.goForward({waitUntil:'commit',timeout:5000})).catch(error=>{if(page.url()!==url)throw error;});
   await page.waitForFunction(()=>document.body.dataset.restored==='true');await page.waitForTimeout(200);
  };
  await translate();const stamp=await page.evaluate(()=>window.stamp);await page.locator('#navigate').click();await page.waitForURL(base+'/b');await page.waitForSelector('.bt-fab');await translate();
  await history('back',base+'/a');assert.equal(await page.evaluate(()=>window.stamp),stamp,'后退恢复同一文档');
  await page.evaluate(()=>{const p=document.createElement('p');p.id='restoredNew';p.textContent='Fresh paragraph added after going back';document.body.append(p);});await page.waitForSelector('#restoredNew .bt-translation-text');
  await send('CANCEL_TRANSLATION');await send('START_TRANSLATION');await page.waitForSelector('#source .bt-translation-text');await page.waitForFunction(()=>document.querySelector('iframe')?.contentDocument?.querySelector('.bt-translation-text'));
  await history('forward',base+'/b');await send('CANCEL_TRANSLATION');await translate();
  await history('back',base+'/a');await send('CANCEL_TRANSLATION');
  const beforePause=await worker.evaluate(()=>navCalls.length);await page.locator('#navigate').click();await page.waitForURL(base+'/b');await page.waitForSelector('.bt-fab');await history('back',base+'/a');
  await page.evaluate(()=>{const p=document.createElement('p');p.textContent='User paused content after going back';document.body.append(p);});await page.waitForTimeout(500);
  assert.equal(await page.locator('.bt-translation-text').count(),0,'用户暂停不能被缓存恢复解除');assert.equal(await worker.evaluate(()=>navCalls.length),beforePause,'已暂停页无自动新请求');
  await translate();assert.ok(await page.evaluate(()=>restoreCount)>=3,'覆盖多次真实缓存往返');
  // 在途翻译离开后不能锁死本页；返回以新批次重试，其他标签页不受影响。
  await send('CANCEL_TRANSLATION');await worker.evaluate(()=>{navDelay=500;});await page.evaluate(()=>{document.querySelector('#source').firstChild.textContent='Slow request before navigation';});await send('START_TRANSLATION');await page.waitForFunction(()=>document.querySelector('#source').getAttribute('data-bt-processed')==='1'&&!document.querySelector('#source .bt-translation-text'));
  await page.locator('#navigate').click();await page.waitForURL(base+'/b');await page.waitForSelector('.bt-fab');await history('back',base+'/a');await page.waitForSelector('#source .bt-translation-text');assert.match(await page.locator('#source .bt-translation-text').innerText(),/Slow request/);await worker.evaluate(()=>{navDelay=0;});
  await page.locator('#navigate').click();await page.waitForURL(base+'/b');await page.waitForSelector('.bt-fab');
  await worker.evaluate(()=>chrome.storage.local.set({glossary:{entries:[{source:'request',target:'恢复术语',language:'zh-CN'}]}}));
  await history('back',base+'/a');await page.waitForFunction(()=>document.querySelector('#source .bt-translation-text')?.textContent.includes('恢复术语'));
  console.log('PASS Chromium: 真实 BFCache、多次前进/后退、自动补翻、手动重试、iframe 恢复、用户暂停与在途取消');
  assert.deepEqual(errors,[]);
 }finally{if(context)await context.close();await new Promise(resolve=>server.close(resolve));fs.rmSync(profile,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
