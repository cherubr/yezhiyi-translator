/** 真实扩展 iframe/术语/OCR 集成：本地页面、真实 Tesseract 与 PDF.js；仅翻译 API 模拟。 */
const {chromium}=require('playwright'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const root=process.env.YEZHIYI_EXTENSION_DIR?path.resolve(process.env.YEZHIYI_EXTENSION_DIR):path.resolve(__dirname,'..');
function scannedPdf(jpeg){
 const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 800 240] /Resources << /XObject << /Image 4 0 R >> >> /Contents 5 0 R >>',Buffer.concat([Buffer.from('<< /Type /XObject /Subtype /Image /Width 1600 /Height 480 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length '+jpeg.length+' >>\nstream\n'),jpeg,Buffer.from('\nendstream')]),'<< /Length 33 >>\nstream\nq 800 0 0 240 0 0 cm /Image Do Q\nendstream'];
 const chunks=[Buffer.from('%PDF-1.4\n')],offsets=[0];let length=chunks[0].length;
 objects.forEach((obj,index)=>{offsets.push(length);const part=Buffer.concat([Buffer.from((index+1)+' 0 obj\n'),Buffer.isBuffer(obj)?obj:Buffer.from(obj),Buffer.from('\nendobj\n')]);chunks.push(part);length+=part.length;});
 chunks.push(Buffer.from('xref\n0 6\n0000000000 65535 f \n'+offsets.slice(1).map(value=>String(value).padStart(10,'0')+' 00000 n \n').join('')+'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n'+length+'\n%%EOF'));return Buffer.concat(chunks);
}
(async()=>{
 const profile=fs.mkdtempSync(path.join(os.tmpdir(),'yezhiyi-features-'));let context;
 try{
  context=await chromium.launchPersistentContext(profile,{channel:'chromium',headless:true,viewport:{width:1500,height:1000},args:['--disable-extensions-except='+root,'--load-extension='+root]});
  let worker=context.serviceWorkers()[0];if(!worker)worker=await context.waitForEvent('serviceworker');const id=new URL(worker.url()).host;
  await worker.evaluate(async()=>{
   await chrome.storage.sync.set({engine:'google',from:'en',to:'zh-CN',autoTranslate:false});globalThis.calls=[];globalThis.delay=0;const original=fetch;
   globalThis.fetch=(url,options)=>{if(String(url).startsWith('https://translate.googleapis.com/')){const text=new URL(url).searchParams.get('q');calls.push(text);return new Promise(resolve=>setTimeout(()=>resolve(new Response(JSON.stringify([[['译文：'+text]]]),{headers:{'Content-Type':'application/json'}})),delay));}return original(url,options);};
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
  const image=await settings.evaluate(()=>{const canvas=document.createElement('canvas');canvas.width=1600;canvas.height=480;const c=canvas.getContext('2d');c.fillStyle='white';c.fillRect(0,0,1600,480);c.fillStyle='black';c.font='64px Arial';c.fillText('Linux kernel OpenShift',60,140);c.fillText('Hello OCR translation',60,260);c.font='72px "PingFang SC",sans-serif';c.fillText('简体中文文字识别',60,390);return {png:canvas.toDataURL('image/png').split(',')[1],jpeg:canvas.toDataURL('image/jpeg').split(',')[1]};});
  const ocr=await context.newPage();ocr.on('pageerror',error=>errors.push(error.message));const requests=[];ocr.on('request',request=>requests.push(request.url()));await ocr.goto('chrome-extension://'+id+'/ocr/reader.html');await ocr.waitForFunction(()=>document.querySelector('#service').value==='google');
  await ocr.locator('#localFile').setInputFiles({name:'source.png',mimeType:'image/png',buffer:Buffer.from(image.png,'base64')});await ocr.waitForFunction(()=>!document.querySelector('#recognize').disabled);const before=await worker.evaluate(()=>calls.length);
  await ocr.locator('#recognize').click();await ocr.waitForFunction(()=>document.querySelector('#sourceText').value.includes('Linux'),{},{timeout:120000});assert.equal(await worker.evaluate(()=>calls.length),before,'识别不发送翻译请求');assert.match(await ocr.locator('#sourceText').inputValue(),/Hello OCR/);
  await ocr.locator('#sourceText').fill('Linux kernel OpenShift');await ocr.locator('#translate').click();await ocr.waitForFunction(()=>document.querySelector('#result').textContent.includes('核心'));assert.match(await ocr.locator('#result').innerText(),/Linux 核心 OpenShift/);
  await ocr.locator('#ocrLanguage').selectOption('chi_sim+eng');await ocr.locator('#recognize').click();await ocr.waitForFunction(()=>document.querySelector('#sourceText').value.includes('Linux'),{},{timeout:120000});assert.match((await ocr.locator('#sourceText').inputValue()).replace(/\s/g,''),/中文文字识别/,'真实识别简体中文');
  await ocr.locator('#recognize').click();await ocr.locator('#cancel').click();await ocr.waitForTimeout(300);assert.match(await ocr.locator('#status').innerText(),/已取消/);assert.equal(await ocr.locator('#sourceText').inputValue(),'');
  assert.ok(!requests.some(url=>/^https?:/.test(url)),'OCR 全过程仅使用随包附带的资源');
  await ocr.evaluate(()=>{chrome.permissions.request=async()=>false;});await ocr.locator('#sourceUrl').fill('https://denied.test/image.png');await ocr.locator('#sourceForm button').click();await ocr.waitForFunction(()=>document.querySelector('#status').textContent.includes('尚未允许'));assert.ok(!requests.some(url=>url.includes('denied.test')),'授权拒绝不读取图片');
  const pdf=await context.newPage();pdf.on('pageerror',error=>errors.push(error.message));await pdf.goto('chrome-extension://'+id+'/pdf/reader.html');await pdf.locator('#localFile').setInputFiles({name:'scan.pdf',mimeType:'application/pdf',buffer:scannedPdf(Buffer.from(image.jpeg,'base64'))});await pdf.waitForFunction(()=>!document.querySelector('#recognize').disabled);assert.equal(await pdf.locator('#translate').isDisabled(),true,'纯扫描页无文字层');
  await pdf.locator('#recognize').click();await pdf.waitForSelector('textarea.pdf-source',{timeout:120000});assert.match(await pdf.locator('textarea.pdf-source').first().inputValue(),/Linux/);await pdf.locator('textarea.pdf-source').first().fill('Linux kernel OpenShift');await pdf.locator('#translate').click();await pdf.waitForFunction(()=>document.querySelector('.pdf-result')?.textContent.includes('核心'));assert.match(await pdf.locator('.pdf-result').first().innerText(),/Linux 核心 OpenShift/);
  await pdf.locator('#cancel').click();assert.equal(await pdf.locator('.pdf-overlay').count(),0);assert.deepEqual(errors,[]);
  console.log('PASS Chromium: 术语编辑保存、真实中英文 OCR、本地资源、图片校对翻译、识别取消、纯扫描 PDF 识别与翻译');
 }finally{if(context)await context.close();fs.rmSync(profile,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
