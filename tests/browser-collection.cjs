/**
 * 测试模块：共享翻译单元采集。
 * 隔离方式：相同构造 DOM 分别模拟 AI/Google/百度响应。
 * 验收范围：完整句子、混合控件、禁译/代码保护、节点身份与保护标记异常阻断。
 * 执行：node tests/browser-collection.cjs
 */
const {chromium}=require('playwright'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
/**
 * 为当前真实浏览器页面安装模拟消息和共享采集模块；接口不连接厂商。
 */
async function setup(browser,engine){
 const page=await browser.newPage({viewport:{width:1280,height:1000}});
 await page.setContent(`<style>body{font:16px/24px Arial}p{margin:12px 0}nav a{display:block;white-space:nowrap}code{font:14px monospace}</style>
 <article><p id="paragraph">When a class omits a <code id="keyword">package</code> declaration, check <a id="guide" href="#guide"><strong>the migration guide</strong></a> and <code id="annotation">@ComponentScan</code>.<br>Keep the full sentence together.</p>
 <div id="inlineDiv">Read <span style="display:contents"><em>the complete <a href="#more">guide</a></em></span> for version <code>1.x</code>.</div>
 <p id="opaqueParagraph">Preserve <span class="notranslate">KEEP_THIS_LOCAL</span> while translating the explanation.</p>
 <p id="hiddenParagraph">Public before <span hidden>HIDDEN_PRIVATE_TEXT</span> public after.</p>
 <label id="mixed"><input id="check" type="checkbox" value="INPUT_PRIVATE_VALUE">Accept <a id="terms" href="#terms"><em>the terms</em></a> and <code>com.example.project</code> conditions.</label>
 <input id="typed" value="ENTERED_PRIVATE_VALUE"><textarea>EDITED_PRIVATE_VALUE</textarea>
 <pre id="pre"><code>PRE_PRIVATE_SOURCE</code></pre><div><code id="blockCode" style="display:block">BLOCK_PRIVATE_SOURCE</code></div>
 <p id="onlyCode"><code>ONLY_CODE_PRIVATE</code></p><div contenteditable="true">EDITABLE_PRIVATE_SOURCE</div>
 <div id="nested"><div id="nestedOne">First nested paragraph.</div><div id="nestedTwo">Second nested paragraph.</div></div>
 <nav><a id="nav" href="#home">View history</a></nav></article>`);
 await page.evaluate(engine=>{
  window.requests=[];window.responseDelay=5;window.dropTokens=false;window.tokenFormat="original";
  const cfg={engine,aiProvider:'custom',from:'en',to:'zh-CN',autoTranslate:false};
  const storage={async get(keys){return Object.fromEntries(keys.filter(k=>k in cfg).map(k=>[k,cfg[k]]));},async set(){},async remove(){}};
  window.chrome={runtime:{onMessage:{addListener(){}},sendMessage(request,callback){
    if(request.action!=='TRANSLATE'){callback?.({ok:true});return;}
    requests.push(request.text);
    setTimeout(()=>{
      let translated=dropTokens?request.text.replace(/⟦YZY\d+:\d+⟧/g,''):request.text;
      if(tokenFormat==='localized')translated=translated.replace(/⟦YZY(\d+):(\d+)⟧/g,(_,nonce,index)=>'【YZY'+nonce+'：'+index+'】');
      callback({ok:true,data:'译文：'+translated});
    },responseDelay);
  }},storage:{sync:storage,local:storage,onChanged:{addListener(){}}}};
 },engine);
 for(const file of ['core/constants.js','core/translation-style.js','core/translation-units.js','core/request-policy.js','core/providers.js'])await page.addScriptTag({content:fs.readFileSync(path.join(root,file),'utf8')});
 await page.addStyleTag({content:fs.readFileSync(path.join(root,'core/translation-style.css'),'utf8')+'\n'+fs.readFileSync(path.join(root,'content/content.css'),'utf8')});
 const source=fs.readFileSync(path.join(root,'content/content.js'),'utf8').replace('  bootstrap();',
  '  window.test={STATE,collectBlocks,translatePage,cancelTranslation,applyMode,createFab,observeDynamicContent,bindHoverTranslate,bindPageLifecycle};');
 await page.addScriptTag({content:source});
 await page.evaluate(engine=>{
  Object.assign(test.STATE,{engine,aiProvider:'custom',from:'en',to:'zh-CN'});
  test.createFab();test.bindPageLifecycle();test.observeDynamicContent();test.bindHoverTranslate();
  window.savedCode=document.getElementById('keyword');window.savedLink=document.getElementById('guide');window.savedInput=document.getElementById('check');
  window.originalParagraph=document.getElementById('paragraph').innerHTML;
  savedLink.addEventListener('click',e=>{e.preventDefault();window.linkClicks=(window.linkClicks||0)+1;});
  document.getElementById('terms').addEventListener('click',e=>e.preventDefault());
 },engine);
 return page;
}
(async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  let baseline;
  for(const engine of ['ai','google','baidu']){
   const page=await setup(browser,engine);
   const units=await page.evaluate(()=>test.collectBlocks().map(unit=>({id:unit.el.id,text:unit.text,kind:unit.kind,
     range:!!unit.nodes,parts:unit.protection.values.length,request:unit.protection.text})));
   if(baseline)assert.deepEqual(units,baseline,'各引擎必须使用同一采集结果');else baseline=units;
   assert.equal(units.filter(u=>u.id==='paragraph').length,1);
   assert.equal(units.find(u=>u.id==='paragraph').parts,2);
   assert.equal(units.filter(u=>u.id==='mixed').length,1,'连续说明中的链接和代码不再拆成多个任务');
   assert.equal(units.find(u=>u.id==='mixed').range,true);
   assert.ok(!units.some(u=>['pre','blockCode','onlyCode','nested'].includes(u.id)));
   await page.evaluate(()=>test.translatePage());
   assert.equal(await page.locator('#paragraph > .bt-translation-text').count(),1);
   assert.equal(await page.locator('#paragraph .bt-text-fragment').count(),0);
   assert.equal(await page.locator('#paragraph > .bt-translation-text').evaluate(el=>getComputedStyle(el).display),'block');
   assert.equal(await page.locator('#nav .bt-translation-text').evaluate(el=>getComputedStyle(el).display),'inline');
   assert.equal(await page.locator('#mixed .bt-translation-text').count(),1);
   assert.equal(await page.evaluate(()=>requests.length),units.length);
   const sent=await page.evaluate(()=>requests.join('\n'));
   for(const privateText of ['@ComponentScan','com.example.project','KEEP_THIS_LOCAL','HIDDEN_PRIVATE_TEXT','INPUT_PRIVATE_VALUE','ENTERED_PRIVATE_VALUE','EDITED_PRIVATE_VALUE','PRE_PRIVATE_SOURCE','BLOCK_PRIVATE_SOURCE','ONLY_CODE_PRIVATE','EDITABLE_PRIVATE_SOURCE'])assert.ok(!sent.includes(privateText),privateText);
   assert.match(await page.locator('#paragraph > .bt-translation-text').textContent(),/@ComponentScan/);
   assert.match(await page.locator('#opaqueParagraph .bt-translation-text').textContent(),/KEEP_THIS_LOCAL/);
   assert.ok(!(await page.locator('.bt-translation-text').allTextContents()).join('').includes('⟦YZY'));
   await page.evaluate(()=>{test.STATE.mode='translation-only';test.applyMode();});
   assert.equal(await page.locator('#check').isVisible(),true);
   assert.equal(await page.inputValue('#typed'),'ENTERED_PRIVATE_VALUE');
   await page.evaluate(()=>{test.STATE.mode='bilingual';test.applyMode();savedLink.click();});
   assert.equal(await page.evaluate(()=>linkClicks),1);
   // 代码文字发生变化时，也必须清理旧整段译文并以新保护映射补翻。
   const before=await page.evaluate(()=>requests.length);
   await page.evaluate(()=>savedCode.textContent='module');
   await page.waitForFunction(()=>document.querySelector('#paragraph > .bt-translation-text')?.textContent.includes('module'));
   assert.equal(await page.evaluate(()=>requests.length),before+1,'局部变更只补翻对应完整段落');
   await page.evaluate(()=>test.cancelTranslation());
   assert.equal(await page.evaluate(()=>savedCode===document.getElementById('keyword')&&savedLink===document.getElementById('guide')&&savedInput===document.getElementById('check')),true);
   assert.equal(await page.locator('#paragraph .bt-original-text,#paragraph .bt-translation-text').count(),0);
   // Shift 与整页采集同一段正文；鼠标停在正文链接上也不应只翻译链接。
   const beforeShift=await page.evaluate(()=>requests.length);
   await page.locator('#guide').hover();await page.keyboard.press('Shift');
   await page.waitForFunction(()=>document.querySelector('#paragraph > .bt-hover-translation'));
   assert.equal(await page.evaluate(()=>requests.length),beforeShift+1);
   await page.locator('#guide').hover();await page.keyboard.press('Shift');
   assert.equal(await page.locator('#paragraph .bt-hover-translation').count(),0);
   await page.close();
  }
  // 模拟 AI 将标记括号与冒号本地化；整页、单段均还原同一份本地映射。
  const localized=await setup(browser,'ai');
  await localized.evaluate(()=>{window.tokenFormat='localized';return test.translatePage();});
  assert.match(await localized.locator('#paragraph > .bt-translation-text').textContent(),/@ComponentScan/);
  assert.match(await localized.locator('#opaqueParagraph > .bt-translation-text').textContent(),/KEEP_THIS_LOCAL/);
  assert.equal(await localized.evaluate(()=>test.STATE.failedCount),0);
  await localized.evaluate(()=>test.cancelTranslation());
  await localized.locator('#guide').hover();await localized.keyboard.press('Shift');
  await localized.waitForFunction(()=>document.querySelector('#paragraph > .bt-hover-translation'));
  assert.match(await localized.locator('#paragraph > .bt-hover-translation').textContent(),/@ComponentScan/);
  await localized.locator('#guide').hover();await localized.keyboard.press('Shift');
  assert.equal(await localized.locator('#paragraph .bt-hover-translation').count(),0);
  assert.equal(await localized.evaluate(()=>savedCode===document.getElementById('keyword')),true);
  await localized.close();
  const broken=await setup(browser,'ai');
  await broken.evaluate(()=>{window.dropTokens=true;return test.translatePage();});
  assert.equal(await broken.locator('#paragraph .bt-translation-text').count(),0,'损坏的保护标记不能当作成功译文');
  assert.equal(await broken.evaluate(()=>savedCode===document.getElementById('keyword')&&savedCode.textContent==='package'),true);
  assert.ok(await broken.evaluate(()=>test.STATE.failedCount>0));
  assert.ok(!(await broken.locator('.bt-translation-text').allTextContents()).join('').includes('⟦YZY'));
  await broken.close();
  console.log('PASS Chromium: 三引擎共用翻译单元、完整段落与链接/代码、保护文字不发送、连续混合说明、独立代码/输入/隐藏排除、正文/导航展示、代码动态变更、Shift、原节点还原与标记异常阻断');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
