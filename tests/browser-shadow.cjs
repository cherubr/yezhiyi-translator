/** 开放组件的真实浏览器回归：不连接外部翻译服务。 */
const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
(async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1400,height:1400}});
  await page.setContent('<style>body{font:16px Arial}test-card,late-card{display:block;margin:15px}</style><p>Ordinary document.</p><test-card id="card"></test-card><p>Before component <late-card id="late" style="display:inline"></late-card> after component.</p><test-card id="forbidden" translate="no"></test-card><test-card id="closed"></test-card>');
  const css=fs.readFileSync(path.join(root,'core/translation-style.css'),'utf8')+'\n'+fs.readFileSync(path.join(root,'content/content.css'),'utf8');
  await page.evaluate(css=>{
   const cfg={engine:'google',from:'en',to:'zh-CN',autoTranslate:false,translationStyle:{fontSize:150}};
   window.requests=[];window.delay=10;
   const storage={async get(keys){return Object.fromEntries(keys.filter(k=>k in cfg).map(k=>[k,cfg[k]]));},async set(){},async remove(){}};
   window.chrome={runtime:{onMessage:{addListener(){}},sendMessage(req,cb){
    if(req.action==='GET_TRANSLATION_STYLES'){cb({ok:true,data:css});return;}
    if(req.action!=='TRANSLATE'){cb?.({ok:true});return;}
    requests.push(req.text);setTimeout(()=>cb({ok:true,data:'译文：'+req.text}),delay);
   }},storage:{sync:storage,local:storage,onChanged:{addListener(){}}}};
   const card=document.getElementById('card').attachShadow({mode:'open'});
   card.innerHTML='<style>:host{display:block}p{margin:12px 0}</style><p id="body">Read <a id="link" href="#">the account guide</a> with <code>LOCAL_CODE</code>.</p><input value="PRIVATE_INPUT"><textarea>PRIVATE_EDIT</textarea><pre>PRIVATE_SOURCE</pre><nested-card></nested-card>';
   const nested=card.querySelector('nested-card').attachShadow({mode:'open'});nested.innerHTML='<p id="nested">Nested open content.</p>';
   document.getElementById('forbidden').attachShadow({mode:'open'}).innerHTML='<p id="private">Manual protected component.</p>';
   document.getElementById('closed').attachShadow({mode:'closed'}).innerHTML='<p>CLOSED_ROOT_PRIVATE</p>';
   window.savedLink=card.getElementById('link');window.linkClicks=0;savedLink.addEventListener('click',e=>{e.preventDefault();linkClicks++;});
  },css);
  for(const file of ['core/constants.js','core/translation-style.js','core/translation-units.js','core/request-policy.js','core/providers.js'])await page.addScriptTag({content:fs.readFileSync(path.join(root,file),'utf8')});
  await page.addStyleTag({content:css});
  const source=fs.readFileSync(path.join(root,'content/content.js'),'utf8').replace('  bootstrap();','  window.test={STATE,translatePage,cancelTranslation,observeDynamicContent,bindHoverTranslate};');
  await page.addScriptTag({content:source});
  await page.evaluate(()=>{Object.assign(test.STATE,{engine:'google',from:'en',to:'zh-CN',translationStyle:{fontSize:150}});test.observeDynamicContent();test.bindHoverTranslate();return test.translatePage();});
  assert.equal(await page.locator('#body > .bt-translation-text').count(),1);
  assert.equal(await page.locator('#nested > .bt-translation-text').count(),1);
  assert.equal(await page.locator('#private > .bt-translation-text').count(),0);
  for(const value of ['LOCAL_CODE','PRIVATE_INPUT','PRIVATE_EDIT','PRIVATE_SOURCE','CLOSED_ROOT_PRIVATE','Manual protected component.'])assert.ok(!(await page.evaluate(()=>requests.join('\n'))).includes(value));
  await page.waitForFunction(()=>document.getElementById('card').shadowRoot.adoptedStyleSheets.length>0);
  assert.equal(await page.locator('#body > .bt-translation-text').evaluate(el=>getComputedStyle(el).fontSize),'24px');
  await page.evaluate(()=>{document.getElementById('card').shadowRoot.getElementById('body').append(' Appended update.');});
  await page.waitForFunction(()=>document.getElementById('card').shadowRoot.querySelector('#body > .bt-translation-text')?.textContent.includes('Appended update'));
  await page.evaluate(()=>document.getElementById('late').attachShadow({mode:'open'}).innerHTML='<p id="lateText">Late attached root.</p>');
  await page.waitForSelector('#lateText > .bt-translation-text');
  await page.evaluate(()=>document.getElementById('late').shadowRoot.append(Object.assign(document.createElement('p'),{id:'dynamic',textContent:'Dynamically added paragraph.'})));
  await page.waitForSelector('#dynamic > .bt-translation-text');
  await page.evaluate(()=>test.cancelTranslation());
  assert.equal(await page.locator('.bt-translation-text').count(),0);
  await page.locator('#link').hover();await page.keyboard.press('Shift');
  await page.waitForSelector('#body > .bt-hover-translation');
  await page.locator('#link').hover();await page.keyboard.press('Shift');
  assert.equal(await page.locator('#body > .bt-translation-text').count(),0);
  assert.equal(await page.evaluate(()=>savedLink===document.getElementById('card').shadowRoot.getElementById('link')),true);
  await page.evaluate(()=>savedLink.click());assert.equal(await page.evaluate(()=>linkClicks),1);
  await page.locator('#private').hover();await page.keyboard.press('Shift');
  await page.waitForSelector('#private > .bt-hover-translation');
  assert.equal(await page.evaluate(()=>test.STATE.pagePaused),true);
  await page.evaluate(()=>test.cancelTranslation());
  const count=await page.evaluate(()=>requests.length);
  await page.evaluate(()=>document.getElementById('card').shadowRoot.getElementById('body').append(' Paused update.'));
  await page.waitForTimeout(400);assert.equal(await page.evaluate(()=>requests.length),count);
  // 请求返回前移除整个宿主，不得把过期结果插入已移除或复用的组件。
  await page.evaluate(()=>{delay=200;void test.translatePage();});
  await page.waitForTimeout(40);await page.evaluate(()=>document.getElementById('card').remove());
  await page.waitForTimeout(350);assert.equal(await page.locator('#body .bt-translation-text').count(),0);
  await page.close();
  console.log('PASS Chromium: 开放/嵌套/迟到 Shadow DOM、内部变更、样式、隐私边界、Shift、节点事件、暂停及移除宿主');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
