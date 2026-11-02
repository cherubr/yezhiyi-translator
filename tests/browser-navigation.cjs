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
  let worker=context.serviceWorkers()[0];if(!worker)worker=await context.waitForEvent('serviceworker');const id=new URL(worker.url()).host;
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
  const png=Buffer.from(await page.evaluate(()=>{const c=document.createElement('canvas');c.width=1200;c.height=300;const g=c.getContext('2d');g.fillStyle='white';g.fillRect(0,0,1200,300);g.fillStyle='black';g.font='64px Arial';g.fillText('Hello image translation',40,150);return c.toDataURL().split(',')[1];}),'base64');
  await context.route('https://api.deepseek.com/navigation-test/**',route=>route.fulfill({contentType:'image/png',body:png}));
  const imageUrl='https://api.deepseek.com/navigation-test/image';await page.goto(imageUrl);await page.waitForSelector('.bt-fab');assert.equal(await page.evaluate(()=>document.contentType),'image/png');
  const opened=context.waitForEvent('page');await page.locator('.bt-fab').click();const reader=await opened;reader.on('pageerror',error=>errors.push(error.message));await reader.waitForURL('chrome-extension://'+id+'/ocr/reader.html*');await reader.waitForFunction(()=>!!document.querySelector('#preview canvas')&&!document.querySelector('#recognize').disabled);
  assert.equal(await reader.locator('#sourceUrl').inputValue(),imageUrl,'无后缀图片由 MIME 识别并带入地址');const beforeOCR=await worker.evaluate(()=>navCalls.length);await reader.locator('#recognize').click();await reader.waitForFunction(()=>document.querySelector('#sourceText').value.includes('Hello'),null,{timeout:120000});assert.equal(await worker.evaluate(()=>navCalls.length),beforeOCR,'图片预览和识别不会发送翻译');await reader.locator('#translate').click();await reader.waitForFunction(()=>document.querySelector('#result').textContent.includes('导航译文'));
  // 工具栏 URL 路由、右键共用的后台打开入口，已授权来源自动预览。
  const next=context.waitForEvent('page');await worker.evaluate(()=>openImageReader('https://api.deepseek.com/navigation-test/source.PNG?download=1'));const second=await next;await second.waitForFunction(()=>!!document.querySelector('#preview canvas'));
  const denied=await context.newPage(),requests=[];denied.on('request',request=>requests.push(request.url()));await denied.goto('chrome-extension://'+id+'/ocr/reader.html#url='+encodeURIComponent('https://not-granted.example/image.png')+'&load=1');await denied.waitForFunction(()=>document.querySelector('#status').textContent.includes('尚未允许'));assert.ok(!requests.some(url=>url.includes('not-granted.example')),'手工伪造 load 参数不能绕过权限');
  await denied.evaluate(()=>{chrome.permissions.request=async()=>false;});await denied.locator('#sourceForm button').click();await denied.waitForFunction(()=>document.querySelector('#status').textContent.includes('尚未允许'));assert.ok(!requests.some(url=>url.includes('not-granted.example')));
  assert.deepEqual(errors,[]);console.log('PASS Chromium: 独立无后缀图片点击入口、已授权在线预览、真实 OCR/翻译与权限拒绝');
 }finally{if(context)await context.close();await new Promise(resolve=>server.close(resolve));fs.rmSync(profile,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
