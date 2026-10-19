const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
async function setup(browser,html) {
 const page=await browser.newPage({viewport:{width:1280,height:900}});
 await page.setContent(html);
 await page.evaluate(()=>{
   window.requests=[];window.failMode=false;
   const config={autoTranslate:false,concurrency:4,from:'auto',to:'zh-CN'};
   const storage={async get(keys,cb){const r=Object.fromEntries(keys.filter(k=>k in config).map(k=>[k,config[k]]));if(cb)cb(r);return r;},async set(){},async remove(){}};
   window.chrome={runtime:{onMessage:{addListener(){}},sendMessage(request,cb){
     window.requests.push(request.text);
     setTimeout(()=>cb(window.failMode?{ok:false,error:'模拟网络失败'}:{ok:true,data:'译：'+request.text}),8);
   }},storage:{sync:storage,local:{async get(){return {}},async set(){}},onChanged:{addListener(){}}}};
 });
 for(const file of ['core/constants.js','core/providers.js'])await page.addScriptTag({content:fs.readFileSync(path.join(root,file),'utf8')});
 await page.addStyleTag({content:fs.readFileSync(path.join(root,'content/content.css'),'utf8')});
 const source=fs.readFileSync(path.join(root,'content/content.js'),'utf8').replace('  bootstrap();',
 '  window.test={STATE,translatePage,cancelTranslation,collectBlocks,translatedElements,insertTranslation,clearTranslations,createFab,observeDynamicContent,scheduleVisibleTranslation,bindHoverTranslate};');
 await page.addScriptTag({content:source});
 await page.evaluate(()=>{test.createFab();test.observeDynamicContent();test.bindHoverTranslate();});
 return page;
}
(async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.BROWSER_CHANNEL?{channel:process.env.BROWSER_CHANNEL}:{})});
 try {
 const page=await setup(browser,'<p id="source">Original paragraph</p><label id="label"><input id="check" type="checkbox">Accept terms</label><input id="value" value="User secret"><textarea id="edit">Entered content</textarea><button id="button"><svg width="12" height="12"><path d="M0 0L10 10"/></svg>Save changes</button><div id="unrelated">Unrelated content</div>');
 await page.evaluate(()=>{window.savedControl=document.querySelector('#check');window.savedButton=document.querySelector('#button');savedButton.addEventListener('click',()=>window.clicks=(window.clicks||0)+1);});
 await page.evaluate(()=>test.translatePage());
 assert.equal(await page.inputValue('#value'),'User secret');assert.equal(await page.inputValue('#edit'),'Entered content');
 await page.locator('#check').check();assert.ok(await page.locator('#check').isChecked());
 await page.locator('#button').click();assert.equal(await page.evaluate(()=>window.clicks),1);
 assert.equal(await page.evaluate(()=>savedControl===document.querySelector('#check')),true);
 assert.equal(await page.locator('#label .bt-translation-text').count(),1);
 assert.equal(await page.locator('#button svg').count(),1);
 await page.evaluate(()=>{
   window.fullScans=0;const original=document.querySelectorAll.bind(document);
   document.querySelectorAll=(...args)=>{window.fullScans++;return original(...args);};
   document.querySelector('#source').appendChild(document.createTextNode(' with added source'));
 });
 await page.waitForFunction(()=>document.querySelector('#source .bt-translation-text')?.textContent.includes('with added source'));
 assert.equal(await page.evaluate(()=>window.fullScans),0,'dynamic update stays local');
 await page.evaluate(()=>document.querySelector('#source').textContent='Entirely replaced paragraph');
 await page.waitForFunction(()=>document.querySelector('#source .bt-translation-text')?.textContent.includes('Entirely replaced'));
 await page.evaluate(()=>{
   const dialog=document.createElement('dialog');dialog.id='dialog';
   dialog.innerHTML='<label id="dialogLabel"><input id="dialogInput" value="private">Account name</label><button id="dialogButton">Confirm</button>';
   document.body.appendChild(dialog);
 });
 assert.equal(await page.locator('#dialog .bt-translation-text').count(),0);
 await page.evaluate(()=>document.querySelector('#dialog').showModal());
 await page.waitForFunction(()=>document.querySelector('#dialogLabel .bt-translation-text'));
 assert.equal(await page.inputValue('#dialogInput'),'private');
 await page.evaluate(()=>document.querySelector('#dialog').close());
 await page.evaluate(()=>test.cancelTranslation());
 const cancelled=await page.evaluate(()=>window.requests.length);
 await page.evaluate(()=>{
   document.querySelector('#source').textContent='Changed after cancellation';
   document.body.appendChild(Object.assign(document.createElement('p'),{textContent:'More dynamic content'}));
   window.dispatchEvent(new Event('scroll'));
 });
 await page.waitForTimeout(600);
 assert.equal(await page.evaluate(()=>window.requests.length),cancelled);
 assert.equal(await page.locator('.bt-translation-text').count(),0);
 assert.equal(await page.evaluate(()=>savedControl===document.querySelector('#check')),true);
 await page.evaluate(()=>test.translatePage());assert.ok(await page.locator('.bt-translation-text').count()>0);
 await page.close();

 const failed=await setup(browser,'<p id="failure">Failing paragraph</p>');
 await failed.evaluate(()=>{window.failMode=true;return test.translatePage();});
 assert.match(await failed.locator('#btModalError').textContent(),/模拟网络失败/);
 assert.equal(await failed.evaluate(()=>window.requests.length),1);
 for(let i=0;i<4;i++)await failed.evaluate(()=>test.translatePage(false,true));
 assert.equal(await failed.evaluate(()=>window.requests.length),1,'failure cooldown suppresses event retries');
 await failed.evaluate(()=>{const clock=Date.now;Date.now=()=>clock()+31000;});
 await failed.evaluate(()=>test.translatePage(false,true));
 await failed.evaluate(()=>{const clock=Date.now;Date.now=()=>clock()+61000;});
 await failed.evaluate(()=>test.translatePage(false,true));
 await failed.evaluate(()=>{const clock=Date.now;Date.now=()=>clock()+200000;});
 await failed.evaluate(()=>test.translatePage(false,true));
 assert.equal(await failed.evaluate(()=>window.requests.length),3,'three failures stop automatic retries');
 await failed.evaluate(()=>{window.failMode=false;return test.translatePage();});
 assert.equal(await failed.evaluate(()=>window.requests.length),4);
 assert.equal(await failed.locator('#failure .bt-translation-text').count(),1);
 await failed.close();

 const long=await setup(browser,Array.from({length:2500},(_,i)=>'<div><span id="row'+i+'">Long page row '+i+'</span></div>').join(''));
 const metrics=await long.evaluate(()=>{
   const start=performance.now();const blocks=test.collectBlocks();const scanMs=performance.now()-start;
   for(let i=0;i<500;i++){const el=document.querySelector('#row'+i);el.setAttribute(test.STATE.processedAttr,'1');test.insertTranslation(el,'长页面译文 '+i);}
   test.STATE.pageStarted=true;
   return {scanMs,visibleBlocks:blocks.length,translated:test.translatedElements.size};
 });
 await long.waitForTimeout(400);
 await long.evaluate(()=>{
   window.fullScans=0;const original=document.querySelectorAll.bind(document);
   document.querySelectorAll=(...args)=>{window.fullScans++;return original(...args);};
   document.querySelector('#row0 .bt-original-text').firstChild.textContent='Updated long page row';
 });
 await long.waitForFunction(()=>document.querySelector('#row0 .bt-translation-text')?.textContent.includes('Updated long page row'));
 assert.equal(await long.evaluate(()=>window.fullScans),0);
 assert.equal(metrics.translated,500);assert.ok(metrics.visibleBlocks>0);
 console.log('PASS Chromium: 动态追加/替换、弹框、混合表单、取消恢复、错误展示、重试上限、2500行局部扫描',metrics);
 await long.close();
 } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});