/** 真实扩展 PDF 回归：真实 PDF.js、本地生成 PDF、模拟翻译，无真实 API 调用。 */
const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {pdfFixture}=require('./pdf-fixture.cjs');
const root=process.env.YEZHIYI_EXTENSION_DIR?path.resolve(process.env.YEZHIYI_EXTENSION_DIR):path.resolve(__dirname,'..');
(async()=>{
 const profile=fs.mkdtempSync(path.join(os.tmpdir(),'yezhiyi-pdf-test-'));let context;
 try{
  context=await chromium.launchPersistentContext(profile,{channel:'chromium',headless:true,viewport:{width:1500,height:1000},args:['--disable-extensions-except='+root,'--load-extension='+root]});
  let worker=context.serviceWorkers()[0];if(!worker)worker=await context.waitForEvent('serviceworker');
  const id=new URL(worker.url()).host;
  await worker.evaluate(async()=>{
   await chrome.storage.sync.set({engine:'google',from:'en',to:'zh-CN',autoTranslate:false});
   globalThis.pdfCalls=[];globalThis.pdfDelay=0;
   const originalFetch=fetch;
   globalThis.fetch=(url,options)=>{
    if(String(url).startsWith('https://translate.googleapis.com/')){
     const text=new URL(url).searchParams.get('q');pdfCalls.push(text);
     const response=new Response(JSON.stringify([[['测试译文：'+text]]]),{headers:{'Content-Type':'application/json'}});
     return new Promise(resolve=>setTimeout(()=>resolve(response),pdfDelay));
    }
    return originalFetch(url,options);
   };
  });
  const page=await context.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto('chrome-extension://'+id+'/pdf/reader.html');
  await page.waitForFunction(()=>document.querySelector('#service').value==='google');
  await page.locator('#localFile').setInputFiles({name:'fixture.pdf',mimeType:'application/pdf',buffer:pdfFixture()});
  await page.waitForFunction(()=>document.querySelector('#pageCount').textContent==='2'&&!document.querySelector('#translate').disabled);
  assert.equal(await worker.evaluate(()=>pdfCalls.length),0,'打开 PDF 不自动发送文字');
  assert.ok(await page.locator('#pdfCanvas').evaluate(canvas=>canvas.width>0&&canvas.height>0));
  await page.locator('#translate').click();
  await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('本页翻译完成'));
  assert.match(await page.locator('#translations').innerText(),/测试译文：Hello PDF first page/);
  await page.locator('#next').click();
  await page.waitForFunction(()=>document.querySelector('#pageNumber').value==='2'&&document.querySelector('#status').textContent.includes('本页翻译完成'));
  assert.match(await page.locator('#translations').innerText(),/测试译文：Second PDF page/);
  await page.locator('#cancel').click();
  const calls=await worker.evaluate(()=>pdfCalls.length);
  await page.locator('#previous').click();
  await page.waitForFunction(()=>document.querySelector('#pageNumber').value==='1'&&!document.querySelector('#translate').disabled);
  await page.waitForTimeout(300);assert.equal(await worker.evaluate(()=>pdfCalls.length),calls,'取消后翻页不继续发送');
  // 翻译过程中改变外观，只更新现有节点，不替换在途结果的接收节点。
  await worker.evaluate(()=>{pdfDelay=300;});
  await page.locator('#to').selectOption('fr');await page.locator('#translate').click();
  await worker.evaluate(()=>chrome.storage.sync.set({translationStyle:{fontSize:130,lineHeight:2}}));
  await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('本页翻译完成'));
  assert.match(await page.locator('#translations').innerText(),/测试译文：Hello PDF first page/);
  assert.equal(await page.locator('.pdf-result').first().evaluate(el=>getComputedStyle(el).fontSize),'20.8px');
  await page.locator('#cancel').click();await page.locator('#to').selectOption('de');
  // 翻译配置变化及取消都隔离迟到结果。
  await worker.evaluate(()=>{pdfDelay=400;});
  await page.locator('#translate').click();await page.waitForTimeout(40);
  await page.locator('#to').selectOption('es');await page.waitForTimeout(550);
  assert.ok(!(await page.locator('#translations').innerText()).includes('测试译文：'));
  await page.locator('#translate').click();await page.waitForTimeout(40);await page.locator('#cancel').click();
  await page.waitForTimeout(550);assert.ok(!(await page.locator('#translations').innerText()).includes('测试译文：'));
  // 在线来源使用已有厂商域名权限，并在浏览器传输层返回本地 PDF，不访问公网。
  await context.route('https://api.deepseek.com/fixture.pdf',route=>route.fulfill({status:200,contentType:'application/pdf',body:pdfFixture()}));
  await page.locator('#sourceUrl').fill('https://api.deepseek.com/fixture.pdf');await page.locator('#openUrl').click();
  await page.waitForFunction(()=>document.querySelector('#filename').textContent==='fixture.pdf'&&document.querySelector('#pageNumber').value==='1'&&!document.querySelector('#translate').disabled);
  // 拒绝授权时不能发出文件读取请求。
  await page.evaluate(()=>{chrome.permissions.request=async()=>false;});
  await page.locator('#sourceUrl').fill('https://denied.example.test/private.pdf');await page.locator('#openUrl').click();
  await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('尚未允许'));
  await page.locator('#localFile').setInputFiles({name:'invalid.pdf',mimeType:'application/pdf',buffer:Buffer.from('<html>not a pdf</html>')});
  await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('不是 PDF'));
  if(process.env.YEZHIYI_PDF_SAMPLE){
   await page.locator('#localFile').setInputFiles(process.env.YEZHIYI_PDF_SAMPLE);
   await page.waitForFunction(()=>document.querySelector('#pageCount').textContent==='16'&&!document.querySelector('#next').disabled);
   await page.locator('#pageNumber').fill('3');await page.locator('#pageNumber').dispatchEvent('change');
   await page.waitForFunction(()=>document.querySelector('#pageNumber').value==='3'&&!document.querySelector('#translate').disabled);
   await page.screenshot({path:path.join(os.tmpdir(),'yezhiyi-pdf-reader.png'),fullPage:false});
  }
  assert.deepEqual(errors,[],'阅读页不得产生未处理异常');
  console.log('PASS Chromium: PDF 本地/在线读取、真实解析及渲染、分段翻译、翻页续翻、取消、配置切换、迟到结果及权限拒绝');
 }finally{
  if(context)await context.close();
  fs.rmSync(profile,{recursive:true,force:true});
 }
})().catch(error=>{console.error(error);process.exitCode=1;});
