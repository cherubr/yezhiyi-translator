/** 真实跨源/嵌套框架的 Shift：键盘焦点与鼠标所在文档不同，无真实翻译调用。 */
const {chromium}=require('playwright'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const root=process.env.YEZHIYI_EXTENSION_DIR?path.resolve(process.env.YEZHIYI_EXTENSION_DIR):path.resolve(__dirname,'..');
(async()=>{
 const profile=fs.mkdtempSync(path.join(os.tmpdir(),'yezhiyi-frame-shift-'));let context;
 try{
  context=await chromium.launchPersistentContext(profile,{channel:'chromium',headless:true,viewport:{width:1500,height:1300},args:['--disable-extensions-except='+root,'--load-extension='+root]});
  let worker=context.serviceWorkers()[0];if(!worker)worker=await context.waitForEvent('serviceworker');
  await worker.evaluate(async()=>{
   await chrome.storage.sync.set({engine:'google',from:'en',to:'zh-CN',autoTranslate:false,hoverTranslate:true,hoverRequireShift:true});globalThis.shiftCalls=[];const original=fetch;
   globalThis.fetch=(url,options)=>{if(String(url).startsWith('https://translate.googleapis.com/')){const text=new URL(url).searchParams.get('q');shiftCalls.push(text);return Promise.resolve(new Response(JSON.stringify([[['译文：'+text]]])));}return original(url,options);};
  });
  const body=content=>'<!doctype html><html lang="en"><body style="font:18px/1.8 Arial;margin:12px">'+content+'</body></html>';
  await context.route('https://shift-main.test/**',route=>route.fulfill({contentType:'text/html',body:body('<p id="root">Parent document paragraph for Shift</p><input id="edit" value="private input"><iframe id="outer" src="https://shift-cross.test/outer" width="900" height="430"></iframe><iframe id="sibling" src="https://shift-cross.test/sibling" width="900" height="180"></iframe>')}));
  await context.route('https://shift-cross.test/**',route=>route.fulfill({contentType:'text/html',body:body(route.request().url().endsWith('/outer')?'<p id="outerText">Outer frame paragraph for Shift</p><input id="edit" value="private input"><iframe id="inner" src="https://shift-leaf.test/page" width="700" height="180"></iframe>':'<p id="siblingText">Sibling frame paragraph for Shift</p>')}));
  await context.route('https://shift-leaf.test/**',route=>route.fulfill({contentType:'text/html',body:body('<p id="leaf">Nested frame paragraph for Shift</p>')}));
  const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));await page.goto('https://shift-main.test/');await page.waitForSelector('.bt-fab');
  const outer=page.frameLocator('#outer'),leaf=outer.frameLocator('#inner'),sibling=page.frameLocator('#sibling');await leaf.locator('#leaf').waitFor();await sibling.locator('#siblingText').waitFor();await page.waitForTimeout(150);
  const tabId=await worker.evaluate(async url=>(await chrome.tabs.query({})).find(tab=>tab.url===url).id,page.url());
  const send=action=>worker.evaluate(({tabId,action})=>chrome.tabs.sendMessage(tabId,{action},{frameId:0}),{tabId,action});
  const focusRoot=()=>page.evaluate(()=>{document.body.tabIndex=-1;document.body.focus();});
  const clear=async()=>{await send('CANCEL_TRANSLATION');for(const frame of page.frames())await frame.waitForFunction(()=>!document.querySelector('.bt-translation-text'));};
  const waitLeaf=()=>leaf.locator('#leaf .bt-translation-text').waitFor();
  await focusRoot();await leaf.locator('#leaf').hover();assert.equal(await page.evaluate(()=>document.activeElement.tagName),'BODY');await page.keyboard.press('Shift');await waitLeaf();
  assert.equal(await page.locator('#root .bt-translation-text').count(),0,'嵌套子框架独占鼠标命中');assert.equal(await outer.locator('#outerText .bt-translation-text').count(),0);
  await page.keyboard.press('Shift');await leaf.locator('#leaf .bt-translation-text').waitFor({state:'detached'});
  // 长按重复事件不重译或还原；松开后的下一次手势才切换。
  await page.keyboard.down('Shift');await waitLeaf();await page.keyboard.down('Shift');await page.waitForTimeout(150);assert.equal(await leaf.locator('.bt-translation-text').count(),1);await page.keyboard.up('Shift');
  await clear();await outer.locator('#outerText').click();await sibling.locator('#siblingText').hover();await page.keyboard.press('Shift');await sibling.locator('#siblingText .bt-translation-text').waitFor();assert.equal(await outer.locator('.bt-translation-text').count(),0,'焦点在另一个 iframe 时只翻译鼠标所在文档');
  await clear();await outer.locator('#outerText').click();await page.locator('#root').hover();await page.keyboard.press('Shift');await page.waitForSelector('#root .bt-translation-text');await page.keyboard.press('Shift');await page.locator('#root .bt-translation-text').waitFor({state:'detached'});
  // 先按住再移入，移入翻译一次，期间不启动整页会话。
  await clear();await focusRoot();await page.mouse.move(1450,1200);await page.keyboard.down('Shift');await leaf.locator('#leaf').hover({modifiers:['Shift']});await waitLeaf();await page.keyboard.up('Shift');
  await page.evaluate(()=>{const p=document.createElement('p');p.id='notStarted';p.textContent='Whole page must remain paused after isolated Shift';document.body.prepend(p);});await page.waitForTimeout(350);assert.equal(await page.locator('#notStarted .bt-translation-text').count(),0);
  await clear();await focusRoot();await leaf.locator('#leaf').hover();const before=await worker.evaluate(()=>shiftCalls.length);await page.keyboard.down('Control');await page.keyboard.press('Shift');await page.keyboard.up('Control');await page.waitForTimeout(200);assert.equal(await leaf.locator('.bt-translation-text').count(),0);
  await page.locator('#edit').focus();await leaf.locator('#leaf').hover();await page.keyboard.press('Shift');await page.waitForTimeout(200);assert.equal(await leaf.locator('.bt-translation-text').count(),0,'正在编辑输入框时不转发 Shift');assert.equal(await worker.evaluate(()=>shiftCalls.length),before);
  await focusRoot();await leaf.locator('#leaf').hover();await worker.evaluate(tabId=>frameSessions.remove(tabId),tabId);for(let i=0;i<3;i++)await page.keyboard.press('Shift');await waitLeaf();await page.waitForTimeout(250);assert.equal(await leaf.locator('.bt-translation-text').count(),1,'后台丢失会话后快速连续按键仍按奇偶次数切换');assert.deepEqual(errors,[]);
  console.log('PASS Chromium: 跨源/嵌套/兄弟 iframe Shift、焦点分离、翻译还原、长按去重、先按后移入、暂停保持、输入与组合键排除');
 }finally{if(context)await context.close();fs.rmSync(profile,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
