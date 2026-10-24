/**
 * 测试模块：动态页面与单段交互。
 * 隔离方式：独立 Chromium 和可控制延迟/错误的消息响应。
 * 验收范围：滚动补翻、取消、Shift 实际 DOM 判定、动态替换、长页面局部采集和 AI 投递背压。
 * 执行：node tests/browser-dynamic.cjs
 */
const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
/**
 * 重建页面夹具与模拟 Chrome API，控制消息响应的延迟、错误和返回文字。
 */
async function setup(browser,html,preferences={}) {
 const page=await browser.newPage({viewport:{width:1280,height:900}});
 await page.setContent(html);
 await page.evaluate(preferences=>{
   window.requests=[];window.failMode=false;window.responseDelay=8;window.languageMode=false;
   const config={autoTranslate:false,concurrency:4,from:'auto',to:'zh-CN',...preferences};
   const storage={async get(keys,cb){const r=Object.fromEntries(keys.filter(k=>k in config).map(k=>[k,config[k]]));if(cb)cb(r);return r;},async set(values){
     const changes=Object.fromEntries(Object.entries(values).map(([key,newValue])=>[key,{newValue,oldValue:config[key]}]));
     Object.assign(config,values);
     setTimeout(()=>window.storageChange?.(changes,"sync"),5);
     await new Promise(resolve=>setTimeout(resolve,20));
   },async remove(){}};
   window.chrome={runtime:{onMessage:{addListener(){}},sendMessage(request,cb){if(request.action==="CANCEL_TRANSLATION_REQUESTS"||request.action==="SET_PAGE_STATE"){cb?.({ok:true});return;}
     window.requests.push(request.text);
     setTimeout(()=>cb(window.languageMode?{ok:false,error:'需要指定源语言',code:'NEED_SOURCE_LANGUAGE'}:window.failMode?{ok:false,error:'模拟网络失败'}:{ok:true,data:window.returnSameText?request.text:'译：'+request.text}),window.responseDelay);
   }},storage:{sync:storage,local:{async get(){return {}},async set(){}},onChanged:{addListener(fn){window.storageChange=fn;}}}};
 },preferences);
 for(const file of ['core/constants.js','core/translation-style.js','core/translation-units.js','core/request-policy.js','core/providers.js'])await page.addScriptTag({content:fs.readFileSync(path.join(root,file),'utf8')});
 await page.addStyleTag({content:fs.readFileSync(path.join(root,'core/translation-style.css'),'utf8')+'\n'+fs.readFileSync(path.join(root,'content/content.css'),'utf8')});
 const source=fs.readFileSync(path.join(root,'content/content.js'),'utf8').replace('  bootstrap();',
 '  window.test={STATE,openControlPanel,changeTranslationSetting,translatePage,cancelTranslation,collectBlocks,translatedElements,insertTranslation,clearTranslations,createFab,observeDynamicContent,scheduleVisibleTranslation,bindHoverTranslate,bindPageLifecycle};');
 await page.addScriptTag({content:source});
 await page.evaluate(preferences=>{Object.assign(test.STATE,preferences);test.createFab();test.bindPageLifecycle();test.observeDynamicContent();test.bindHoverTranslate();},preferences);
 return page;
}
(async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.BROWSER_CHANNEL?{channel:process.env.BROWSER_CHANNEL}:{})});
 try {
 const page=await setup(browser,'<p id="source">Original paragraph</p><label id="label"><input id="check" type="checkbox">Accept terms</label><input id="value" value="User secret"><textarea id="edit">Entered content</textarea><button id="button"><svg width="12" height="12"><path d="M0 0L10 10"/></svg>Save changes</button><div id="unrelated">Unrelated content</div>',{autoTranslate:true});
 await page.evaluate(()=>{window.savedControl=document.querySelector('#check');window.savedButton=document.querySelector('#button');savedButton.addEventListener('click',()=>window.clicks=(window.clicks||0)+1);});
 await page.evaluate(()=>test.translatePage());
 assert.equal(await page.inputValue('#value'),'User secret');assert.equal(await page.inputValue('#edit'),'Entered content');
 await page.locator('#check').check();assert.ok(await page.locator('#check').isChecked());
 await page.locator('#button').click();assert.equal(await page.evaluate(()=>window.clicks),1);
 assert.equal(await page.evaluate(()=>savedControl===document.querySelector('#check')),true);
 assert.equal(await page.locator('#label .bt-translation-text').count(),1);
 assert.equal(await page.locator('#button svg').count(),1);
 await page.evaluate(()=>{
   test.openControlPanel();
   window.responseDelay=400;
   document.body.appendChild(Object.assign(document.createElement('p'),{id:'backgroundNew',textContent:'New background paragraph'}));
 });
 await page.waitForFunction(()=>test.STATE.translating && test.STATE.backgroundTranslating && document.querySelector('.bt-fab.bt-busy'));
 assert.equal(await page.locator('#btModalTranslate').textContent(),'重新翻译');
 assert.equal(await page.locator('#btModalTranslate').isEnabled(),true);
 assert.equal(await page.locator('.bt-fab-wrap.bt-translated').count(),0,'补翻期间隐藏完成徽标');
 assert.equal(await page.locator('.bt-fab-wrap.bt-busy').count(),1,'补翻显示忙碌状态');
 assert.equal(await page.locator('.bt-fab.bt-busy').count(),1);
 assert.equal(await page.locator('.bt-fab-wrap.bt-has-error').count(),0);
 await page.waitForFunction(()=>document.querySelector('#backgroundNew .bt-translation-text') && !test.STATE.translating);
 assert.equal(await page.locator('.bt-fab-wrap.bt-busy').count(),0);
 assert.equal(await page.locator('.bt-fab-wrap.bt-translated').count(),1);
 await page.evaluate(()=>{window.responseDelay=8;});
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
 const switched=await page.evaluate(async()=>{
   const a=test.changeTranslationSetting("engine","mymemory");
   const b=test.changeTranslationSetting("engine","google");
   await Promise.all([a,b]);
   return {engine:test.STATE.engine,paused:test.STATE.pagePaused,translated:test.STATE.translated};
 });
 assert.equal(switched.engine,'google');assert.equal(switched.paused,false);assert.equal(switched.translated,true);
 await page.close();

 // 开启会启动当前页；关闭只改变自动启动偏好，不停止当前页已开始的会话。
 const automatic=await setup(browser,'<p id="automatic">Automatic toggle paragraph</p>');
 await automatic.evaluate(()=>{test.openControlPanel();window.responseDelay=800;});
 await automatic.locator('#btModalAuto').click();
 await automatic.waitForFunction(()=>requests.length===1 && test.STATE.translating && document.querySelector('.bt-fab.bt-busy'));
 assert.equal(await automatic.locator('.bt-fab-wrap.bt-translated').count(),0);
 await automatic.locator('#btModalAuto').click();
 await automatic.waitForFunction(()=>test.STATE.autoTranslate===false);
 assert.equal(await automatic.evaluate(()=>test.STATE.translating),true,'关闭开关不取消正在翻译的请求');
 await automatic.waitForFunction(()=>!test.STATE.translating);
 assert.equal(await automatic.locator('#automatic .bt-translation-text').count(),1);
 assert.equal(await automatic.evaluate(()=>requests.length),1);
 // 开启已有译文的空扫描不重发，也不让徽标和按钮闪烁。
 const emptyScan=await automatic.evaluate(async()=>{
   const classes=[];
   const observer=new MutationObserver(records=>{
     for(const record of records)classes.push(record.oldValue||'',record.target.className);
   });
   observer.observe(document.querySelector('.bt-fab-wrap'),{attributes:true,attributeFilter:['class'],attributeOldValue:true,subtree:true});
   await document.querySelector('#btModalAuto').onclick();
   await new Promise(resolve=>requestAnimationFrame(resolve));
   observer.disconnect();
   return {classes,requests:requests.length,button:document.querySelector('#btModalTranslate').textContent};
 });
 assert.equal(emptyScan.requests,1);
 assert.ok(emptyScan.classes.every(value=>!value.split(' ').includes('bt-busy')),'空扫描不显示忙碌');
 assert.equal(emptyScan.button,'重新翻译');
 assert.equal(await automatic.locator('.bt-fab-wrap.bt-translated').count(),1);
 // 会话已启动后关闭自动启动开关，排队和后续补翻仍应继续。
 await automatic.evaluate(async()=>{
   window.responseDelay=8;
   document.body.appendChild(Object.assign(document.createElement('p'),{id:'queuedAfterOff',textContent:'Queued before disabling automatic translation'}));
   await new Promise(resolve=>setTimeout(resolve,50));
   await document.querySelector('#btModalAuto').onclick();
 });
 await automatic.waitForFunction(()=>document.querySelector('#queuedAfterOff .bt-translation-text'));
 assert.equal(await automatic.evaluate(()=>requests.length),2,'关闭自动启动开关不停止当前页补翻');
 assert.equal(await automatic.locator('#automatic .bt-translation-text').count(),1,'关闭保留已有译文');
 await automatic.close();

 // 未点击整页翻译时不因滚动开始；Shift 仅处理单段，也不能启动整页会话。
 const notStarted=await setup(browser,'<p>Never started paragraph</p><p id="onlyHover" style="margin-top:1600px">Standalone hover request</p>');
 await notStarted.locator('#onlyHover').scrollIntoViewIfNeeded();await notStarted.waitForTimeout(300);
 assert.equal(await notStarted.evaluate(()=>requests.length),0);
 await notStarted.locator('#onlyHover').hover();await notStarted.keyboard.press('Shift');
 await notStarted.waitForFunction(()=>document.querySelector('#onlyHover .bt-hover-translation'));
 await notStarted.evaluate(()=>document.body.appendChild(Object.assign(document.createElement('p'),{id:'afterOnlyHover',textContent:'No whole page session from Shift'})));
 await notStarted.locator('#afterOnlyHover').scrollIntoViewIfNeeded();await notStarted.waitForTimeout(350);
 assert.equal(await notStarted.evaluate(()=>requests.length),1,'Shift 不启动整页补翻');
 assert.equal(await notStarted.evaluate(()=>test.STATE.pageStarted),false);
 await notStarted.close();

 // 全局开关关闭时，点击翻译仍启动持续补翻；只有取消停止，重新点击翻译可恢复。
 const manualSession=await setup(browser,'<p id="manualTop">Visible paragraph at top</p><p id="manualBelow" style="margin-top:1600px">Paragraph below the viewport</p>');
 await manualSession.evaluate(()=>test.translatePage());
 assert.equal(await manualSession.locator('#manualTop .bt-translation-text').count(),1);
 assert.equal(await manualSession.locator('#manualBelow .bt-translation-text').count(),0);
 await manualSession.locator('#manualBelow').scrollIntoViewIfNeeded();
 await manualSession.waitForFunction(()=>document.querySelector('#manualBelow .bt-translation-text'));
 assert.equal(await manualSession.evaluate(()=>requests.length),2,'手动翻译后滚动自动补翻');
 await manualSession.evaluate(()=>document.body.appendChild(Object.assign(document.createElement('p'),{id:'manualNew',textContent:'New paragraph after manual translation'})));
 await manualSession.locator('#manualNew').scrollIntoViewIfNeeded();
 await manualSession.waitForFunction(()=>document.querySelector('#manualNew .bt-translation-text'));
 assert.equal(await manualSession.evaluate(()=>requests.length),3,'手动翻译后动态内容也补翻');
 await manualSession.evaluate(()=>test.cancelTranslation());
 await manualSession.evaluate(()=>document.body.appendChild(Object.assign(document.createElement('p'),{id:'afterCancelSession',textContent:'Content after cancelling the session'})));
 await manualSession.locator('#afterCancelSession').scrollIntoViewIfNeeded();await manualSession.waitForTimeout(350);
 assert.equal(await manualSession.evaluate(()=>requests.length),3,'取消才停止当前页补翻');
 await manualSession.locator('#afterCancelSession').hover();await manualSession.keyboard.press('Shift');
 await manualSession.waitForFunction(()=>document.querySelector('#afterCancelSession .bt-hover-translation'));
 assert.equal(await manualSession.evaluate(()=>test.STATE.pagePaused),true,'取消后 Shift 不恢复整页会话');
 await manualSession.evaluate(()=>document.body.appendChild(Object.assign(document.createElement('p'),{id:'afterPausedShift',textContent:'No automatic request after paused Shift'})));
 await manualSession.locator('#afterPausedShift').scrollIntoViewIfNeeded();await manualSession.waitForTimeout(350);
 assert.equal(await manualSession.evaluate(()=>requests.length),4);
 await manualSession.evaluate(()=>test.translatePage());
 await manualSession.waitForFunction(()=>document.querySelector('#afterPausedShift .bt-translation-text'));
 await manualSession.locator('#manualTop').scrollIntoViewIfNeeded();
 await manualSession.waitForFunction(()=>document.querySelector('#manualTop .bt-translation-text'));
 assert.equal(await manualSession.evaluate(()=>test.STATE.pagePaused),false,'再次点击翻译恢复整页补翻');
 await manualSession.close();

 // 已启动会话读取配置期间同步关闭偏好，也不能停止会话，更不能被旧配置改回开关。
 const externalOff=await setup(browser,'<p id="externalOriginal">Original externally controlled paragraph</p>',{autoTranslate:true});
 await externalOff.evaluate(()=>test.translatePage());
 await externalOff.evaluate(()=>{
   document.body.appendChild(Object.assign(document.createElement('p'),{id:'externalNew',textContent:'New paragraph before external disable'}));
   const original=BT_STORAGE.get.bind(BT_STORAGE);let hold=true;
   BT_STORAGE.get=async keys=>{
     const snapshot=await original(keys);
     if(hold){hold=false;await new Promise(resolve=>window.releaseOldConfig=resolve);}
     return snapshot;
   };
   window.oldAutomaticTask=test.translatePage(false,true);
 });
 await externalOff.waitForFunction(()=>typeof releaseOldConfig==='function');
 await externalOff.evaluate(async()=>{await chrome.storage.sync.set({autoTranslate:false});releaseOldConfig();await oldAutomaticTask;});
 assert.equal(await externalOff.evaluate(()=>test.STATE.autoTranslate),false,'旧读取不能改回自动启动开关');
 assert.equal(await externalOff.evaluate(()=>requests.length),2,'当前页补翻会话继续运行');
 assert.equal(await externalOff.locator('#externalNew .bt-translation-text').count(),1);
 await externalOff.close();

 // 尚未建立会话的首次自动启动，仍必须尊重保存期间关闭开关的操作。
 const startupOff=await setup(browser,'<p>Pending first automatic startup</p>',{autoTranslate:true});
 await startupOff.evaluate(()=>{
   const original=BT_STORAGE.get.bind(BT_STORAGE);let hold=true;
   BT_STORAGE.get=async keys=>{
     const snapshot=await original(keys);
     if(hold){hold=false;await new Promise(resolve=>window.releaseFirstConfig=resolve);}
     return snapshot;
   };
   window.firstAutomaticTask=test.translatePage(false,true);
 });
 await startupOff.waitForFunction(()=>typeof releaseFirstConfig==='function');
 await startupOff.evaluate(async()=>{await chrome.storage.sync.set({autoTranslate:false});releaseFirstConfig();await firstAutomaticTask;});
 await startupOff.waitForTimeout(300);
 assert.equal(await startupOff.evaluate(()=>requests.length),0);
 assert.equal(await startupOff.evaluate(()=>test.STATE.pageStarted),false,'迟到自动启动不得偷偷建立会话');
 await startupOff.close();
 console.log('PASS Chromium: 手动翻译启动持续补翻、关闭偏好不停止当前页、取消暂停与手动恢复、Shift单段独立、首次自动启动与旧配置竞争');

 // 保存未结束时取消并关闭重开面板，迟到回调不得重启页面。
 const late=await setup(browser,'<p>Pending automatic start</p>');
 await late.evaluate(()=>{
   test.openControlPanel();
   const original=chrome.storage.sync.set.bind(chrome.storage.sync);
   chrome.storage.sync.set=async values=>{
     await new Promise(resolve=>window.releaseAutoSave=resolve);
     return original(values);
   };
   window.toggleTask=document.querySelector('#btModalAuto').onclick();
   test.cancelTranslation();
   document.querySelector('.bt-modal-close').click();
   test.openControlPanel();
 });
 assert.equal(await late.locator('#btModalAuto').getAttribute('aria-disabled'),'true');
 await late.evaluate(async()=>{releaseAutoSave();await toggleTask;});
 assert.equal(await late.evaluate(()=>test.STATE.pagePaused),true);
 assert.equal(await late.evaluate(()=>requests.length),0);
 assert.equal(await late.locator('.bt-translation-text').count(),0);
 assert.equal(await late.locator('#btModalAuto').getAttribute('aria-disabled'),'false');
 await late.close();

 // 别的窗口同步偏好时不主动翻译本页。
 const synced=await setup(browser,'<p>External preference update</p>');
 await synced.evaluate(async()=>{test.openControlPanel();await chrome.storage.sync.set({autoTranslate:true});});
 assert.equal(await synced.evaluate(()=>test.STATE.autoTranslate),true);
 assert.equal(await synced.evaluate(()=>requests.length),0);
 await synced.close();

 const failed=await setup(browser,'<p id="failure">Failing paragraph</p>',{autoTranslate:true});
 assert.equal(await failed.locator('.bt-has-error').count(),0,'fresh page has no old error badge');
 await failed.evaluate(()=>{window.failMode=true;return test.translatePage();});
 assert.equal(await failed.locator('.bt-has-error').count(),1);
 assert.equal(await failed.locator('.bt-page-notice').count(),1);
 assert.match(await failed.locator('#btModalError').textContent(),/模拟网络失败/);
 await failed.evaluate(()=>test.translatePage(false,true));
 assert.equal(await failed.locator('.bt-page-notice').count(),1,'empty automatic scan preserves page warning');
 assert.equal(await failed.locator('.bt-has-error').count(),1,'empty automatic scan preserves incomplete badge');
 assert.equal(await failed.locator('.bt-check-badge').evaluate(el=>getComputedStyle(el).opacity),'0');
 await failed.locator('#btModalTranslate').hover();
 await failed.waitForTimeout(700);
 assert.equal(await failed.locator('#btModalTranslate').textContent(),'重试翻译');
 assert.equal(await failed.locator('#btModalTranslate').isEnabled(),true);
 assert.equal(await failed.locator('.bt-page-notice').count(),1);

 await failed.evaluate(()=>document.querySelector('#btModalError').textContent='翻译服务连续失败，请检查源语言或配置后再试。'.repeat(12));
 const buttonGeometry=await failed.locator('#btModalTranslate').evaluate(el=>{
   const r=el.getBoundingClientRect(),style=getComputedStyle(el);
   return {width:r.width,height:r.height,whiteSpace:style.whiteSpace};
 });
 assert.equal(buttonGeometry.whiteSpace,'nowrap');
 assert.ok(buttonGeometry.width>60&&buttonGeometry.height<45,'long error text cannot squeeze button vertically');

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
 await failed.evaluate(()=>{window.failMode=false;window.responseDelay=150;window.retryDone=test.translatePage();});
 assert.equal(await failed.locator('.bt-has-error').count(),0,'retry immediately clears previous error before response');
 assert.equal(await failed.locator('#btModalError').textContent(),'');
 assert.equal(await failed.locator('.bt-page-notice').count(),0);
 await failed.evaluate(()=>window.retryDone);
 assert.equal(await failed.evaluate(()=>window.requests.length),4);
 assert.equal(await failed.locator('#failure .bt-translation-text').count(),1);
 await failed.close();
 const language=await setup(browser,'<p>Short ambiguous title</p>');
 await language.evaluate(()=>{window.languageMode=true;return test.translatePage();});
 assert.equal(await language.evaluate(()=>test.STATE.failedCount),0);
 assert.equal(await language.locator('#btModalError').textContent(),'');
 assert.match(await language.locator('#btModalLanguageNotice').textContent(),/语言提示：1/);
 assert.equal(await language.locator('.bt-has-error').count(),1);
 assert.equal(await language.locator('.bt-page-notice').count(),1);
 await language.close();

 const navigation=await setup(browser,'<style>aside{width:160px}nav a{display:block;width:150px;line-height:22px}</style><aside><nav><a id="nav" href="#"><span>View history</span></a></nav></aside>');
 await navigation.evaluate(()=>test.translatePage());
 assert.equal(await navigation.locator('#nav .bt-translation-text').evaluate(el=>getComputedStyle(el).display),'inline');
 await navigation.close();

 // 悬停失败后允许再次触发；节点各自占用，A→B→A 不重复请求仍在进行中的 A。
 const hover=await setup(browser,'<p id="hoverA" style="margin:60px">First hover paragraph</p><p id="hoverB">Second hover paragraph</p>');
 await hover.evaluate(()=>{window.failMode=true;});
 await hover.keyboard.down('Shift');
 await hover.locator('#hoverA').hover();
 await hover.waitForFunction(()=>test.STATE.failedCount===1);
 await hover.mouse.move(5,5);
 await hover.evaluate(()=>{window.failMode=false;});
 await hover.locator('#hoverA').hover();
 await hover.waitForFunction(()=>document.querySelector('#hoverA .bt-translation-text'));
 assert.equal(await hover.evaluate(()=>requests.length),2,'失败后再次悬停会重新申请翻译');
 await hover.mouse.move(5,5);await hover.locator('#hoverA').hover();
 await hover.waitForTimeout(50);
 assert.equal(await hover.evaluate(()=>requests.length),2,'成功段落不重复申请');
 await hover.evaluate(()=>{
   test.cancelTranslation();test.STATE.pagePaused=false;
   window.requests=[];window.responseDelay=250;
   for(const id of ['hoverA','hoverB','hoverA'])document.getElementById(id).dispatchEvent(new MouseEvent('mouseover',{bubbles:true,shiftKey:true}));
 });
 assert.equal(await hover.evaluate(()=>requests.length),2,'来回悬停不重复请求正在进行的节点');
 await hover.waitForFunction(()=>document.querySelectorAll('.bt-hover-translation').length===2);
 await hover.close();

 // 请求期间原文变化时丢弃旧译文，随后悬停可翻译更新后的原文。
 const hoverChanged=await setup(browser,'<p id="hoverChanged" style="margin:60px">Old hover paragraph</p>');
 await hoverChanged.evaluate(()=>{window.responseDelay=250;});
 await hoverChanged.keyboard.down('Shift');await hoverChanged.locator('#hoverChanged').hover();
 await hoverChanged.waitForFunction(()=>requests.length===1);
 await hoverChanged.evaluate(()=>document.querySelector('#hoverChanged').textContent='New hover paragraph');
 await hoverChanged.waitForTimeout(400);
 assert.equal(await hoverChanged.locator('.bt-translation-text').count(),0,'原文变化不插入旧译文');
 assert.equal(await hoverChanged.locator('#hoverChanged').getAttribute('data-bt-processed'),null);
 await hoverChanged.mouse.move(5,5);await hoverChanged.locator('#hoverChanged').hover();
 await hoverChanged.waitForFunction(()=>document.querySelector('.bt-hover-translation'));
 assert.equal(await hoverChanged.locator('.bt-hover-translation').textContent(),'译：New hover paragraph');
 await hoverChanged.close();

 // 主动悬停可越过禁译标记，但仍保护代码、编辑区和隐藏内容。
 const hoverExcluded=await setup(browser,'<p id="no" translate="no">Protected paragraph</p><div translate="no"><p id="ancestor">Protected by ancestor</p></div><p id="notranslate" class="notranslate">Protected class paragraph</p><p id="editable" contenteditable="plaintext-only">Editable paragraph</p><p><code id="code">Protected inline code</code></p><p id="hidden" hidden>Hidden paragraph</p><p id="allowed" style="margin:60px">Allowed hover paragraph</p>');
 await hoverExcluded.evaluate(()=>{
   for(const id of ['editable','code','hidden'])document.getElementById(id).dispatchEvent(new MouseEvent('mouseover',{bubbles:true,shiftKey:true}));
 });
 await hoverExcluded.waitForTimeout(50);
 assert.equal(await hoverExcluded.evaluate(()=>requests.length),0,'代码、编辑区与隐藏内容仍跳过');
 await hoverExcluded.evaluate(()=>{
   for(const id of ['no','ancestor','notranslate'])document.getElementById(id).dispatchEvent(new MouseEvent('mouseover',{bubbles:true,shiftKey:true}));
 });
 await hoverExcluded.waitForFunction(()=>document.querySelectorAll('.bt-hover-translation').length===3);
 assert.equal(await hoverExcluded.evaluate(()=>requests.length),3,'主动悬停可翻译禁译段落及祖先区域');
 await hoverExcluded.evaluate(()=>{
   window.responseDelay=250;
   document.getElementById('allowed').dispatchEvent(new MouseEvent('mouseover',{bubbles:true,shiftKey:true}));
 });
 await hoverExcluded.waitForFunction(()=>requests.length===4);
 await hoverExcluded.evaluate(()=>document.getElementById('allowed').setAttribute('contenteditable','true'));
 await hoverExcluded.waitForTimeout(400);
 assert.equal(await hoverExcluded.locator('#allowed .bt-translation-text').count(),0,'请求期间进入编辑状态时丢弃结果');
 await hoverExcluded.evaluate(()=>{
   document.getElementById('allowed').removeAttribute('contenteditable');
   document.getElementById('allowed').dispatchEvent(new MouseEvent('mouseover',{bubbles:true,shiftKey:true}));
 });
 await hoverExcluded.waitForFunction(()=>document.querySelector('#allowed .bt-hover-translation'));
 assert.equal(await hoverExcluded.evaluate(()=>requests.length),5,'丢弃结果后仍可再次触发');
 await hoverExcluded.close();

 // 鼠标停好再按键也能翻译；再次按键还原，长按及原文/译文之间移动不反复切换。
 const hoverKeys=await setup(browser,'<p id="keyA" style="margin:60px">Stationary hover paragraph</p><p id="keyB">Other untouched paragraph</p><input id="typing" value="Keep input">');
 await hoverKeys.locator('#keyA').hover();
 assert.equal(await hoverKeys.evaluate(()=>requests.length),0,'未按键只记录鼠标位置');
 await hoverKeys.keyboard.down('Shift');
 await hoverKeys.waitForFunction(()=>document.querySelector('#keyA .bt-hover-translation'));
 await hoverKeys.keyboard.down('Shift');
 await hoverKeys.locator('#keyA .bt-translation-text').hover();
 await hoverKeys.waitForTimeout(100);
 assert.equal(await hoverKeys.locator('#keyA .bt-hover-translation').count(),1,'长按与移过译文不还原');
 assert.equal(await hoverKeys.evaluate(()=>requests.length),1);
 await hoverKeys.keyboard.up('Shift');await hoverKeys.keyboard.down('Shift');
 await hoverKeys.waitForFunction(()=>!document.querySelector('#keyA .bt-translation-text'));
 assert.equal(await hoverKeys.locator('#keyA').textContent(),'Stationary hover paragraph');
 // 译文移除后原鼠标位置可能变成空白，重新指向实际段落再按键。
 await hoverKeys.keyboard.up('Shift');await hoverKeys.locator('#keyA').hover();await hoverKeys.keyboard.down('Shift');
 await hoverKeys.waitForFunction(()=>document.querySelector('#keyA .bt-hover-translation'));
 assert.equal(await hoverKeys.evaluate(()=>requests.length),2,'还原后可再次按键翻译');
 await hoverKeys.keyboard.up('Shift');
 // 整页翻译后的单段还原不被动态补翻立即恢复，且不影响其他段落。
 await hoverKeys.evaluate(async()=>{await chrome.storage.sync.set({autoTranslate:true});await test.translatePage();});
 await hoverKeys.locator('#keyA .bt-original-text').hover();
 await hoverKeys.keyboard.down('Shift');await hoverKeys.keyboard.up('Shift');
 await hoverKeys.waitForTimeout(650);
 assert.equal(await hoverKeys.locator('#keyA .bt-translation-text').count(),0,'手动还原的段落不被动态补翻恢复');
 assert.equal(await hoverKeys.locator('#keyB .bt-translation-text').count(),1,'只还原当前段落');
 await hoverKeys.keyboard.down('Shift');await hoverKeys.keyboard.up('Shift');
 await hoverKeys.waitForFunction(()=>document.querySelector('#keyA .bt-hover-translation'));
 // 输入时即便鼠标停在段落上，也不触发；组合快捷键也不触发。
 await hoverKeys.locator('#keyB').hover();await hoverKeys.locator('#typing').focus();
 await hoverKeys.keyboard.down('Shift');await hoverKeys.keyboard.up('Shift');
 assert.equal(await hoverKeys.locator('#keyB .bt-translation-text').count(),1,'输入框里的 Shift 不还原鼠标所在段落');
 await hoverKeys.evaluate(()=>document.activeElement.blur());
 await hoverKeys.keyboard.down('Control');await hoverKeys.keyboard.down('Shift');
 await hoverKeys.keyboard.up('Shift');await hoverKeys.keyboard.up('Control');
 assert.equal(await hoverKeys.locator('#keyB .bt-translation-text').count(),1,'Ctrl+Shift 不触发悬停操作');
 await hoverKeys.close();
 console.log('PASS Chromium: Shift双顺序触发、单段翻译还原、长按去重、手动还原抑制补翻、失败重试、旧结果丢弃及主动禁译覆盖');

 // 点击取消后仍允许主动 Shift 翻译，但新内容与滚动不重启整页补翻。
 const cancelledHover=await setup(browser,'<p id="cancelA" style="margin:60px">Paragraph for manual translation after cancel</p><p id="cancelB">Other paragraph stays original</p>');
 await cancelledHover.evaluate(async()=>{await test.translatePage();test.openControlPanel();});
 await cancelledHover.locator('#btModalCancel').click();
 assert.equal(await cancelledHover.locator('.bt-translation-text').count(),0);
 assert.equal(await cancelledHover.evaluate(()=>test.STATE.pagePaused),true);
 const beforeManual=await cancelledHover.evaluate(()=>requests.length);
 await cancelledHover.locator('#cancelA').hover();
 await cancelledHover.keyboard.down('Shift');await cancelledHover.keyboard.up('Shift');
 await cancelledHover.waitForFunction(()=>document.querySelector('#cancelA .bt-hover-translation'));
 assert.equal(await cancelledHover.evaluate(()=>requests.length),beforeManual+1);
 await cancelledHover.evaluate(()=>{
   document.body.appendChild(Object.assign(document.createElement('p'),{textContent:'Dynamic paragraph after manual hover'}));
   window.dispatchEvent(new Event('scroll'));
 });
 await cancelledHover.waitForTimeout(650);
 assert.equal(await cancelledHover.evaluate(()=>test.STATE.pagePaused),true);
 assert.equal(await cancelledHover.evaluate(()=>requests.length),beforeManual+1,'单段操作不重启自动补翻');
 assert.equal(await cancelledHover.locator('#cancelB .bt-translation-text').count(),0);
 await cancelledHover.locator('#cancelA .bt-original-text').hover();
 await cancelledHover.keyboard.down('Shift');await cancelledHover.keyboard.up('Shift');
 assert.equal(await cancelledHover.locator('.bt-translation-text').count(),0,'暂停状态下也可还原当前段落');
 // 暂停后新发起的手动请求，仍可被下一次取消中止。
 await cancelledHover.evaluate(()=>{window.responseDelay=300;});
 await cancelledHover.locator('#cancelB').hover();
 await cancelledHover.keyboard.down('Shift');await cancelledHover.keyboard.up('Shift');
 await cancelledHover.waitForFunction(count=>requests.length===count,beforeManual+2);
 await cancelledHover.locator('#btModalCancel').click();
 await cancelledHover.waitForTimeout(450);
 assert.equal(await cancelledHover.locator('.bt-translation-text').count(),0,'再次取消会丢弃手动请求的迟到结果');
 await cancelledHover.close();
 console.log('PASS Chromium: 取消后允许Shift单段翻译与还原、保持自动暂停、再次取消丢弃迟到结果');

 // 通用识别回归：不依赖域名或站点 class，整页能采集的完整正文也能通过 Shift 定位。
 const generic=await setup(browser,`<style>.case{margin:12px;padding:8px;border:1px solid #eee}.wikiPicture{float:right;width:162px;margin-left:8px}#wikiCard{width:650px}#wikiBody{line-height:26px}</style>
 <div id="wikiCard" class="case"><div class="wikiPicture"><img id="wikiImage" width="162" height="122" alt="Candy store"><div id="wikiCaption">Candy store in Maryland, United States</div></div><div id="wikiBody">This week's article for improvement is <strong><a id="wikiLink" href="#candy">Confectionery store</a></strong>, also known as a sweet shop, candy store or lolly shop. These stores may sell locally distinct sweets, international sweets, or "vintage" candies like rock candy or liquorice.</div><p>You can improve this article by:</p><div><ul><li>Adding information about early confectioners</li></ul></div></div>
 <div id="nestedInline" class="case">Read <span><strong><a id="nestedLink" href="#nested">the complete guide</a></strong></span> before continuing.</div>
 <div id="standaloneRow" class="case"><span id="standalone">Standalone inline paragraph</span></div>
 <nav class="case"><a id="navHover" href="#menu"><span id="navHoverText">Open dashboard</span></a></nav>
 <h2 id="shortHeading" class="case">Hi</h2>
 <button id="iconHover" class="case"><svg width="12" height="12"><path d="M0 0L10 10"/></svg>Save changes</button>
 <label id="mixedHover" class="case"><input id="mixedCheck" type="checkbox">Accept terms</label>
 <label id="multiHover" class="case">First label text <input id="multiInput" value="private"> Second label text</label>
 <div class="case" role="dialog"><div id="dialogHover">Dialog explanation text</div></div>
 <div class="case" style="display:flex"><span id="flexText">Independent flex text</span><button>Another action</button></div>
 <div style="display:contents"><span id="contentsHover">Visible text inside display contents</span></div><div id="longHover" class="case"></div><div id="changingDiv" class="case">Old dynamic div paragraph</div>`);
 await generic.evaluate(()=>{
   window.savedWikiLink=document.getElementById('wikiLink');
   window.savedWikiImage=document.getElementById('wikiImage');
   window.savedMixedCheck=document.getElementById('mixedCheck');
   window.savedMultiInput=document.getElementById('multiInput');
   window.savedIcon=document.querySelector('#iconHover svg');
   document.getElementById('longHover').textContent='Long ordinary div paragraph. '.repeat(50);
   savedWikiLink.addEventListener('click',e=>{e.preventDefault();window.wikiClicks=(window.wikiClicks||0)+1;});
 });
 const cases=[
   {target:'#wikiLink',host:'#wikiBody'},
   {target:'#nestedLink',host:'#nestedInline'},
   {target:'#standalone',host:'#standaloneRow'},
   {target:'#navHoverText',host:'#navHover'},
   {target:'#shortHeading',host:'#shortHeading'},
   {target:'#iconHover',host:'#iconHover',text:'Save changes'},
   {target:'#mixedHover',host:'#mixedHover',text:'Accept terms'},
   {target:'#dialogHover',host:'#dialogHover'},
   {target:'#flexText',host:'#flexText'},
   {target:'#contentsHover',host:'#contentsHover'}
 ];
 // 混合控件必须命中文字；定位整个 label 的中心可能落在复选框或空白处。
 /**
  * 将鼠标移至候选文字并触发 Shift，验证整页与单段命中同一翻译单元。
  */
 async function hoverCase(item){
   if(!item.text){await generic.locator(item.target).hover();return;}
   await generic.locator(item.target).scrollIntoViewIfNeeded();
   const point=await generic.locator(item.target).evaluate((el,text)=>{
     const walker=document.createTreeWalker(el,NodeFilter.SHOW_TEXT);
     let node;while((node=walker.nextNode()))if(node.textContent.trim()===text){
       const range=document.createRange();range.selectNodeContents(node);const r=range.getClientRects()[0];
       return {x:r.x+Math.min(20,r.width/2),y:r.y+r.height/2};
     }
     throw Error('Missing original text node: '+text);
   },item.text);
   await generic.mouse.move(point.x,point.y);
 }
 for(const item of cases){
   const source=item.text||await generic.locator(item.host).textContent();
   const fullPageItems=await generic.evaluate(()=>test.collectBlocks().map(item=>item.text));
   assert.ok(fullPageItems.includes(source.trim()),'整页采集包含该区域：'+item.host);
   const count=await generic.evaluate(()=>requests.length);
   await hoverCase(item);await generic.keyboard.down('Shift');await generic.keyboard.up('Shift');
   await generic.locator(item.host+' .bt-hover-translation').waitFor({state:'attached',timeout:5000});
   assert.deepEqual(await generic.evaluate(count=>requests.slice(count),count),[source.trim()],'Shift使用相同的完整文字区域：'+item.host);
   await hoverCase(item);await generic.keyboard.down('Shift');await generic.keyboard.up('Shift');
   assert.equal(await generic.locator(item.host+' .bt-translation-text').count(),0,'同一区域可还原：'+item.host);
 }
 assert.equal(await generic.locator('#wikiCaption .bt-translation-text').count(),0,'正文操作不影响图片说明');
 assert.equal(await generic.locator('#wikiCard > .bt-translation-text').count(),0,'不合并整张卡片');
 assert.equal(await generic.evaluate(()=>savedWikiLink===document.getElementById('wikiLink')&&savedWikiImage===document.getElementById('wikiImage')),true);
 await generic.locator('#wikiLink').click();assert.equal(await generic.evaluate(()=>wikiClicks),1);
 assert.equal(await generic.evaluate(()=>savedMixedCheck===document.getElementById('mixedCheck')&&savedIcon===document.querySelector('#iconHover svg')),true,'控件与图标仍是原节点');
 await generic.locator('#mixedCheck').check();assert.equal(await generic.locator('#mixedCheck').isChecked(),true);
 // 控件操作会保留键盘焦点；此处验证正文命中，先退出控件焦点，编辑中保护由前面的专门用例覆盖。
 await generic.evaluate(()=>document.activeElement.blur());
 // 混合容器有多个文本节点时，按鼠标实际命中的那个片段操作，而不是随意取第一段。
 const multiPoint=await generic.locator('#multiHover').evaluate(el=>{
   const range=document.createRange();range.selectNodeContents(el.lastChild);const r=range.getBoundingClientRect();
   return {x:r.x+Math.min(35,r.width/2),y:r.y+r.height/2};
 });
 await generic.mouse.move(multiPoint.x,multiPoint.y);await generic.keyboard.down('Shift');await generic.keyboard.up('Shift');
 await generic.waitForFunction(()=>document.querySelector('#multiHover .bt-hover-translation'));
 assert.equal(await generic.locator('#multiHover .bt-hover-translation').textContent(),'译：Second label text');
 assert.equal(await generic.locator('#multiInput').inputValue(),'private');
 await generic.mouse.move(multiPoint.x,multiPoint.y);await generic.keyboard.down('Shift');await generic.keyboard.up('Shift');
 await generic.waitForTimeout(300);
 assert.equal(await generic.locator('#multiHover .bt-translation-text').count(),0,'控件旁片段可以还原');
 assert.equal(await generic.evaluate(()=>savedMultiInput===document.getElementById('multiInput')),true);
 // 长正文复用整页分块，不再把整段超长文本直接发送给接口。
 const longCount=await generic.evaluate(()=>requests.length);
 const longSource=await generic.locator('#longHover').textContent();
 await generic.locator('#longHover').hover();await generic.keyboard.down('Shift');await generic.keyboard.up('Shift');
 await generic.waitForFunction(()=>document.querySelector('#longHover .bt-hover-translation'));
 const longParts=await generic.evaluate(count=>requests.slice(count),longCount);
 assert.equal(longParts.length,1,'页面把完整段落交给后台统一分块');assert.equal(longParts[0],longSource.trim());
 // 普通 div 在请求期间被复用，也必须丢弃旧译文。
 await generic.evaluate(()=>{window.responseDelay=250;});
 await generic.locator('#changingDiv').hover();await generic.keyboard.down('Shift');await generic.keyboard.up('Shift');
 await generic.evaluate(()=>document.getElementById('changingDiv').textContent='New dynamic div paragraph');
 await generic.waitForTimeout(400);
 assert.equal(await generic.locator('#changingDiv .bt-translation-text').count(),0);
 await generic.mouse.move(1,1);await generic.locator('#changingDiv').hover();await generic.keyboard.down('Shift');await generic.keyboard.up('Shift');
 await generic.waitForFunction(()=>document.querySelector('#changingDiv .bt-hover-translation'));
 assert.equal(await generic.locator('#changingDiv .bt-hover-translation').textContent(),'译：New dynamic div paragraph');
 await generic.evaluate(()=>test.cancelTranslation());
 assert.equal(await generic.locator('#longHover').textContent(),longSource);
 assert.equal(await generic.locator('#multiHover .bt-text-fragment').count(),0);
 await generic.close();
 console.log('PASS Chromium: 整页与Shift共用识别、div/span、嵌套链接、导航短文本、图标按钮、表单片段命中与还原、长文本分块及动态原文');

 // 实际译文决定操作：在暂停页复现记录未及时清理，不能依赖观察器替 Shift 修复状态。
 const actual=await setup(browser,'<p id="actualParagraph" style="margin:60px;width:500px">Original paragraph with <a id="actualLink" href="#actual">an original link</a>.</p><div id="strayTranslation"></div><label id="actualLabel"><input id="actualInput" type="checkbox">Original fragment label</label>');
 await actual.evaluate(()=>{test.cancelTranslation();window.savedActualLink=document.getElementById('actualLink');window.savedActualInput=document.getElementById('actualInput');});
 const pressActual=async()=>{await actual.locator('#actualLink').hover();await actual.keyboard.press('Shift');};
 await pressActual();
 await actual.waitForFunction(()=>document.querySelector('#actualParagraph .bt-hover-translation'));
 for(const damage of ['remove','empty','hidden','moved']){
   await actual.evaluate(damage=>{
     const wrapper=document.querySelector('#actualParagraph .bt-translation-text');
     if(damage==='remove')wrapper.remove();
     if(damage==='empty')wrapper.textContent='';
     if(damage==='hidden')wrapper.style.display='none';
     if(damage==='moved')document.getElementById('strayTranslation').appendChild(wrapper);
   },damage);
   const count=await actual.evaluate(()=>requests.length);
   await pressActual();
   await actual.waitForFunction(count=>requests.length===count+1,count);
   await actual.waitForFunction(()=>document.querySelector('#actualParagraph .bt-hover-translation')?.textContent.startsWith('译：'));
   assert.equal(await actual.locator('#actualParagraph .bt-translation-text').count(),1,'失效译文不被误当成可还原译文：'+damage);
   assert.equal(await actual.locator('#strayTranslation .bt-translation-text').count(),0);
   assert.equal(await actual.evaluate(()=>savedActualLink===document.getElementById('actualLink')),true);
 }
 // 内部记录丢失但实际译文还在时，恢复记录并还原，不再发送翻译请求。
 await actual.evaluate(()=>test.translatedElements.delete(document.getElementById('actualParagraph')));
 const actualCount=await actual.evaluate(()=>requests.length);
 await pressActual();
 assert.equal(await actual.locator('#actualParagraph .bt-translation-text').count(),0);
 assert.equal(await actual.evaluate(()=>requests.length),actualCount,'实际有译文只还原');
 // 没有译文时，即使残留处理标记也应执行翻译。
 for(const marker of ['1','hover','unchanged','hover-restored']){
   await actual.evaluate(marker=>document.getElementById('actualParagraph').setAttribute('data-bt-processed',marker),marker);
   const count=await actual.evaluate(()=>requests.length);
   await pressActual();
   await actual.waitForFunction(count=>requests.length===count+1,count);
   await actual.waitForFunction(()=>document.querySelector('#actualParagraph .bt-hover-translation'));
   await pressActual();
   assert.equal(await actual.locator('#actualParagraph .bt-translation-text').count(),0,'还原只移除实际译文：'+marker);
 }
 // 还原后采用另一种操作顺序：先按 Shift 再移入，也应按没有译文来处理。
 await actual.mouse.move(1,1);await actual.keyboard.down('Shift');await actual.locator('#actualLink').hover();
 await actual.waitForFunction(()=>document.querySelector('#actualParagraph .bt-hover-translation'));
 await actual.keyboard.up('Shift');
 await pressActual();
 assert.equal(await actual.locator('#actualParagraph .bt-translation-text').count(),0);
 // 之前返回原文一致并标记 unchanged，也不能阻止下一次明确按键重新尝试。
 await actual.evaluate(()=>{window.returnSameText=true;});
 await pressActual();
 await actual.waitForFunction(()=>document.getElementById('actualParagraph').getAttribute('data-bt-processed')==='unchanged');
 assert.equal(await actual.locator('#actualParagraph .bt-translation-text').count(),0);
 await actual.evaluate(()=>{window.returnSameText=false;});
 await pressActual();await actual.waitForFunction(()=>document.querySelector('#actualParagraph .bt-hover-translation'));
 // 记录和译文同时丢失但原文容器残留时，解包当前原文再翻译，不能套上第二层旧容器。
 await actual.evaluate(()=>{const el=document.getElementById('actualParagraph');el.querySelector('.bt-translation-text').remove();test.translatedElements.delete(el);});
 await pressActual();await actual.waitForFunction(()=>document.querySelector('#actualParagraph .bt-hover-translation'));
 assert.equal(await actual.locator('#actualParagraph .bt-original-text').count(),1);
 // 节点已经被网页整体复用，不能把旧记录中的原文插回页面。
 await actual.evaluate(()=>document.getElementById('actualParagraph').textContent='Replacement original after page update');
 await actual.locator('#actualParagraph').hover();await actual.keyboard.press('Shift');
 await actual.waitForFunction(()=>document.querySelector('#actualParagraph .bt-hover-translation'));
 assert.equal(await actual.locator('#actualParagraph .bt-original-text').textContent(),'Replacement original after page update');
 assert.equal(await actual.locator('#actualParagraph .bt-hover-translation').textContent(),'译：Replacement original after page update');
 // 文字片段的译文被移除时也能重新翻译，并保持复选框节点。
 const pressFragment=async()=>{
   const point=await actual.locator('#actualLabel').evaluate(el=>{
     const walker=document.createTreeWalker(el,NodeFilter.SHOW_TEXT);let node;
     while((node=walker.nextNode()))if(node.textContent.trim()==='Original fragment label'){
       const range=document.createRange();range.selectNodeContents(node);const r=range.getClientRects()[0];return {x:r.x+20,y:r.y+r.height/2};
     }
   });
   await actual.mouse.move(point.x,point.y);await actual.keyboard.press('Shift');
 };
 await pressFragment();await actual.waitForFunction(()=>document.querySelector('#actualLabel .bt-hover-translation'));
 await actual.evaluate(()=>document.querySelector('#actualLabel .bt-translation-text').remove());
 const fragmentCount=await actual.evaluate(()=>requests.length);
 await pressFragment();await actual.waitForFunction(count=>requests.length===count+1,fragmentCount);
 await actual.waitForFunction(()=>document.querySelector('#actualLabel .bt-hover-translation'));
 assert.equal(await actual.evaluate(()=>savedActualInput===document.getElementById('actualInput')),true);
 await pressFragment();
 assert.equal(await actual.locator('#actualLabel .bt-text-fragment').count(),0);
 await actual.close();
 console.log('PASS Chromium: Shift以实际译文决定翻译或还原、删除/空/隐藏/移走译文修复、记录丢失、残留标记、两种触发顺序及控件片段修复');


 // AI 多长段投递有背压：先完成在处理的段落，而不是一次把几十段的分片堆入后台。
 const aiQueue=await setup(browser,'<main id="aiQueueFixture"></main>',{engine:'ai',aiProvider:'custom'});
 await aiQueue.addScriptTag({content:fs.readFileSync(path.join(root,'core/translation-runtime.js'),'utf8')});
 await aiQueue.evaluate(()=>{
   let seed=43;
   const text=()=>Array.from({length:BT_REQUEST_POLICY.DEFAULTS.ai.maxChars*8},()=>{
     seed=(Math.imul(seed,1664525)+1013904223)>>>0;
     return String.fromCharCode(65+seed%26);
   }).join('');
   window.fillAiQueue=(count,scrollTarget=false)=>{
     const fixture=document.getElementById('aiQueueFixture');fixture.replaceChildren();
     for(let i=0;i<count;i++){
       const p=document.createElement('p');p.id='aiQueue'+i;p.textContent=text();
       p.style.cssText='height:24px;overflow:hidden;margin:0';fixture.appendChild(p);
     }
     if(scrollTarget){
       const spacer=document.createElement('div');spacer.style.height='1600px';fixture.appendChild(spacer);
       const p=document.createElement('p');p.id='aiQueueNewViewport';p.textContent='Latest reading position after scroll';fixture.appendChild(p);
     }
   };
   window.aiSubmissions=[];window.aiWaiting=new Set();window.aiControllers=new Set();
   window.aiQueueRuntime=BT_CREATE_TRANSLATION_RUNTIME(r=>new Promise((resolve,reject)=>{
     const record={resolve:()=>{aiWaiting.delete(record);r.signal.removeEventListener('abort',abort);resolve('模拟译文分片');}};
     const abort=()=>{aiWaiting.delete(record);reject(Object.assign(Error('cancelled'),{name:'AbortError'}));};
     r.signal.addEventListener('abort',abort,{once:true});aiWaiting.add(record);
   }),{interval:0});
   const original=chrome.runtime.sendMessage.bind(chrome.runtime);
   chrome.runtime.sendMessage=(request,callback)=>{
     if(request.action==='CANCEL_TRANSLATION_REQUESTS'){
       for(const controller of aiControllers)controller.abort();
       original(request,callback);return;
     }
     if(request.action!=='TRANSLATE'){original(request,callback);return;}
     const controller=new AbortController();aiControllers.add(controller);
     requests.push(request.text);
     aiSubmissions.push({completed:document.querySelectorAll('.bt-translation-text').length,text:request.text});
     aiQueueRuntime.runText({...request,ownerKey:'ai-queue-page',signal:controller.signal})
       .then(data=>callback({ok:true,data}),error=>callback({ok:false,error:error.message,cancelled:error.name==='AbortError'}))
       .finally(()=>aiControllers.delete(controller));
   };
   window.completeAiBatch=()=>{for(const record of [...aiWaiting])record.resolve();};
   fillAiQueue(12);window.aiPagePromise=test.translatePage();
 });
 await aiQueue.waitForFunction(()=>requests.length>=4 && aiWaiting.size===4);
 assert.equal(await aiQueue.evaluate(()=>requests.length),4,'默认只投递四个未完成 AI 整段');
 for(let round=0;round<180 && await aiQueue.locator('#aiQueueFixture .bt-translation-text').count()<12;round++){
   await aiQueue.evaluate(()=>completeAiBatch());await aiQueue.waitForTimeout(10);
 }
 await aiQueue.waitForFunction(()=>!test.STATE.translating);
 assert.equal(await aiQueue.locator('#aiQueueFixture .bt-translation-text').count(),12,'所有排队段落仍能完成');
 assert.equal(await aiQueue.evaluate(()=>aiSubmissions[4].completed>=1),true,'下一批整段在已有整段显示后才投递');
 assert.equal(await aiQueue.evaluate(()=>requests.length),12,'不会因背压丢段或重复整段');
 // 改为两个请求上限时也收紧整段投递；提高上限无需等待旧段完成。
 await aiQueue.evaluate(()=>{
   test.cancelTranslation();fillAiQueue(4,true);requests.length=0;aiSubmissions.length=0;
   const previousGet=BT_STORAGE.get.bind(BT_STORAGE);
   window.aiManualPolicies={'ai:custom':{mode:'manual',qps:6,maxConcurrent:2}};
   BT_STORAGE.get=async keys=>({...await previousGet(keys),requestPolicies:aiManualPolicies});
   window.aiPagePromise=test.translatePage();
 });
 await aiQueue.waitForFunction(()=>requests.length>=2 && aiWaiting.size>0);
 assert.equal(await aiQueue.evaluate(()=>requests.length),2,'整段投递随用户设置的同时上限变化');
 await aiQueue.evaluate(()=>{
   aiManualPolicies={'ai:custom':{mode:'manual',qps:6,maxConcurrent:3}};
   storageChange({requestPolicies:{newValue:aiManualPolicies}},'local');
 });
 await aiQueue.waitForFunction(()=>requests.length===3);
 await aiQueue.locator('#aiQueueNewViewport').scrollIntoViewIfNeeded();
 await aiQueue.waitForFunction(()=>requests.includes('Latest reading position after scroll'));
 assert.equal(await aiQueue.locator('#aiQueueFixture .bt-translation-text').count(),0,'旧视口尚未完成时，新视口仍能提交');
 await aiQueue.evaluate(()=>test.cancelTranslation());
 await aiQueue.close();
 console.log('PASS Chromium: AI 长段投递背压、完整段落及时显示、手动上限即时生效、旧视口慢任务不阻塞新视口');

 const long=await setup(browser,Array.from({length:2500},(_,i)=>'<div><span id="row'+i+'">Long page row '+i+'</span></div>').join(''),{autoTranslate:true});
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