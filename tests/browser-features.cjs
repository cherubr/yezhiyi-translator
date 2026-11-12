/** 真实扩展 iframe/术语集成：本地页面与真实会话控制，仅翻译 API 模拟。 */
const {chromium}=require('playwright'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const root=process.env.YEZHIYI_EXTENSION_DIR?path.resolve(process.env.YEZHIYI_EXTENSION_DIR):path.resolve(__dirname,'..');
(async()=>{
 const profile=fs.mkdtempSync(path.join(os.tmpdir(),'yezhiyi-features-'));let context;
 try{
  context=await chromium.launchPersistentContext(profile,{channel:'chromium',headless:true,viewport:{width:1500,height:1000},args:['--disable-extensions-except='+root,'--load-extension='+root]});
  let worker=context.serviceWorkers()[0];if(!worker)worker=await context.waitForEvent('serviceworker');const id=new URL(worker.url()).host;
  await worker.evaluate(async()=>{
   await chrome.storage.sync.set({engine:'google',from:'en',to:'zh-CN',autoTranslate:false});globalThis.calls=[];const original=fetch;
   globalThis.fetch=(url,options)=>{if(String(url).startsWith('https://translate.googleapis.com/')){const text=new URL(url).searchParams.get('q');calls.push(text);return Promise.resolve(new Response(JSON.stringify([[['译文：'+text]]]),{headers:{'Content-Type':'application/json'}}));}return original(url,options);};
  });
  await context.route('https://frame.test/**',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="en"><body><p id="source">Cross frame Linux kernel content</p></body></html>'}));
  await context.route('https://main.test/**',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="en"><body><p>Main Linux kernel content</p><iframe src="https://frame.test/child" width="700" height="250"></iframe><iframe srcdoc="<p>Inline frame kernel content</p>" width="700" height="250"></iframe></body></html>'}));
  const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));await page.goto('https://main.test/');await page.waitForSelector('.bt-fab');
  const frames=page.frames().filter(frame=>frame!==page.mainFrame());for(const frame of frames)assert.equal(await frame.locator('.bt-fab').count(),0,'子框架不显示悬浮球');
  async function send(action){await worker.evaluate(async({url,action})=>{const tab=(await chrome.tabs.query({})).find(tab=>tab.url===url);await chrome.tabs.sendMessage(tab.id,{action},{frameId:0});},{url:page.url(),action});}
  await send('START_TRANSLATION');for(const frame of frames)await frame.waitForSelector('.bt-translation-text',{timeout:15000});
  assert.equal(await page.locator('.bt-fab').count(),1);await send('CANCEL_TRANSLATION');for(const frame of frames)await frame.waitForFunction(()=>!document.querySelector('.bt-translation-text'));
  await worker.evaluate(()=>chrome.storage.local.set({glossary:{entries:[{source:'kernel',target:'内核',language:'zh-CN'}]}}));await page.waitForTimeout(100);await send('START_TRANSLATION');
  await page.waitForFunction(()=>document.querySelector('.bt-translation-text')?.textContent.includes('内核'));
  assert.match(await frames[0].locator('.bt-translation-text').innerText(),/内核/);
  assert.ok(await worker.evaluate(()=>calls.some(text=>text.includes('YZY')&&!text.includes('kernel'))),'术语原词由后台保护');
  await page.evaluate(()=>{const frame=document.createElement('iframe');frame.src='https://frame.test/dynamic';frame.width='600';frame.height='180';document.body.append(frame);});
  await page.waitForFunction(()=>document.querySelectorAll('iframe').length===3);let dynamic;for(let attempt=0;attempt<50;attempt++){dynamic=page.frames().find(frame=>frame.url().endsWith('/dynamic'));if(dynamic)break;await page.waitForTimeout(50);}await dynamic.waitForSelector('.bt-translation-text');
  await page.evaluate(()=>{const frame=document.createElement('iframe');frame.id='offscreen';frame.src='https://frame.test/offscreen';frame.style.cssText='display:block;margin-top:2000px;width:700px;height:200px';document.body.append(frame);});
  let offscreen;for(let attempt=0;attempt<50;attempt++){offscreen=page.frames().find(frame=>frame.url().endsWith('/offscreen'));if(offscreen)break;await page.waitForTimeout(50);}
  await page.waitForTimeout(400);assert.equal(await offscreen.locator('.bt-translation-text').count(),0,'屏幕外 iframe 不提前翻译');
  await page.locator('#offscreen').scrollIntoViewIfNeeded();await offscreen.waitForSelector('.bt-translation-text');await page.evaluate(()=>window.scrollTo(0,0));
  await frames[0].goto('https://frame.test/navigated');await frames[0].waitForSelector('.bt-translation-text');
  await worker.evaluate(()=>chrome.storage.local.set({glossary:{entries:[{source:'kernel',target:'内核新词',language:'zh-CN'}]}}));
  await page.waitForFunction(()=>document.querySelector('.bt-translation-text')?.textContent.includes('内核新词'));
  await frames[0].waitForFunction(()=>document.querySelector('.bt-translation-text')?.textContent.includes('内核新词'));
  await send('CANCEL_TRANSLATION');for(const frame of page.frames())await frame.waitForFunction(()=>!document.querySelector('.bt-translation-text'));
  console.log('PASS Chromium: 跨源/srcdoc/动态 iframe、单一面板、主页面取消及共享术语');
  const settings=await context.newPage();await settings.goto('chrome-extension://'+id+'/settings/settings.html');await settings.locator('[data-tab="glossary"]').click();await settings.waitForSelector('.glossary-row');
  await settings.locator('.glossary-row input[aria-label="术语译法"]').fill('核心');await settings.locator('#saveGlossary').click();await settings.waitForFunction(()=>document.querySelector('#glossaryStatus').textContent.includes('已保存'));
  assert.equal(await worker.evaluate(async()=>(await chrome.storage.local.get('glossary')).glossary.entries[0].target),'核心');
  assert.deepEqual(errors,[]);
  console.log('PASS Chromium: 术语设置保存与网页/iframe 统一规则');
 }finally{if(context)await context.close();fs.rmSync(profile,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
