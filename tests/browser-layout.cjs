// 浏览器布局回归：验证真实渲染下的排版、显示模式、节点还原及链接事件保留。
const {chromium}=require('playwright');
const fs=require('fs');const assert=require('assert/strict');
(async()=>{
const browser=await chromium.launch({headless:true,...(process.env.BROWSER_CHANNEL?{channel:process.env.BROWSER_CHANNEL}:{}),args:['--no-sandbox']});
const page=await browser.newPage({viewport:{width:1280,height:900}});
await page.setContent(`<style>main{display:grid;grid-template-columns:minmax(0,1fr) 240px;gap:20px} article{min-width:0} table{width:100%}</style><main><article><p id="p">Original paragraph with <a href="#">a link</a>.</p><ul><li id="li">List text</li></ul><table><tbody><tr><td id="td">Cell text</td></tr></tbody></table></article><aside>Table of contents</aside></main>`);
await page.evaluate(()=>{window.self=window;window.chrome={runtime:{onMessage:{addListener(){}},sendMessage(){}},storage:{onChanged:{addListener(){}},local:{async get(){return {}},async set(){}},sync:{async get(keys,cb){const cfg={autoTranslate:false};if(cb)cb(cfg);return cfg},async set(){},async remove(){}}}}});
const root=require('node:path').resolve(__dirname, '..');
await page.addStyleTag({content:fs.readFileSync(root+'/content/content.css','utf8')});
for(const f of ['core/constants.js','core/translation-units.js','core/request-policy.js','core/providers.js'])await page.addScriptTag({content:fs.readFileSync(root+'/'+f,'utf8')});
let s=fs.readFileSync(root+'/content/content.js','utf8').replace('  bootstrap();','  window.test = { STATE, collectBlocks, insertTranslation, applyMode, clearTranslations, createFab, setFabBusy, setFabTranslated, isMostlyChinese }; bootstrap();');
await page.addScriptTag({content:s});
const result=await page.evaluate(()=>{
 const t=window.test;const link=document.querySelector('a');let clicked=0;link.onclick=()=>clicked++;
 const sidebar=document.querySelector('aside');
 sidebar.innerHTML='<div style="display:flex;gap:12px"><span aria-hidden="true">◆</span><div><time id="date">10 days ago</time><div id="update-title">Decisions API</div><div id="update-desc">Turn text and <a href="#">images</a> into decisions.</div></div></div>';
 const collected=t.collectBlocks().map(x=>x.el.id);
 for(const id of ['date','update-title','update-desc'])assertCollected(id);
 function assertCollected(id){if(!collected.includes(id))throw new Error('Missing sidebar text: '+id);}
 const before=document.querySelector('article').getBoundingClientRect().width;
 const sidebarBefore=sidebar.getBoundingClientRect().width;
 for(const id of ['date','update-title','update-desc'])t.insertTranslation(document.getElementById(id),'右侧更新内容的译文。'.repeat(4));
 const sidebarAfter=sidebar.getBoundingClientRect().width;
 for(const id of ['p','li','td'])t.insertTranslation(document.getElementById(id),'这是用于验证页面布局的译文。'.repeat(12));
 const after=document.querySelector('article').getBoundingClientRect().width;
 const widths=[...document.querySelectorAll('.bt-translation-text')].map(n=>n.getBoundingClientRect().width);
 const valid=!document.querySelector('main > .bt-translation-text, ul > .bt-translation-text, tr > .bt-translation-text');
 t.STATE.mode='translation-only';t.applyMode();const hidden=document.querySelector('.bt-original-text').style.display==='none';
 t.STATE.mode='bilingual';t.applyMode();link.click();
 t.STATE.translated=true;t.setFabTranslated(true);const done=document.querySelector('.bt-check-badge');
 const idleOpacity=getComputedStyle(done).opacity;
 t.STATE.translating=true;t.setFabBusy(true);
 const busyClass=document.querySelector('.bt-fab-wrap').classList.contains('bt-translated');
 t.STATE.translating=false;t.setFabBusy(false);
 const restored=document.querySelector('.bt-fab-wrap').classList.contains('bt-translated');
 t.clearTranslations();
 return {before,after,sidebarBefore,sidebarAfter,widths,valid,hidden,clicked,busyClass,restored,clean:!document.querySelector('.bt-original-text,.bt-translation-text'),sameLink:link===document.querySelector('a')};
});
assert.equal(result.before,result.after);assert.ok(result.widths.every(w=>w>100));
assert.equal(result.sidebarBefore,result.sidebarAfter);
for(const k of ['valid','hidden','restored','clean','sameLink'])assert.equal(result[k],true,k);
assert.equal(result.busyClass,false);assert.equal(result.clicked,1);
console.log('PASS Chromium: grid/list/table layout, mode switch, DOM restoration, link event preservation, busy/completed badge',result);

// 普通 div/span 的固定菜单与横向标签不能依赖 nav/aside 语义标签识别。
await page.setContent(`<style>
.menu{width:232px;font:14px/20px Arial}.row{height:36px;display:flex;align-items:center;gap:10px;overflow:hidden;padding:0 10px;box-sizing:border-box}
.icon{width:16px;flex:none}.label{display:flex;min-width:0;flex:1;align-items:center;overflow:hidden;white-space:nowrap}
.truncate{min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.tabs{width:300px;display:flex;height:32px;font:14px/20px Arial}.tab{display:flex;min-width:0;flex:1;height:32px;overflow:hidden;align-items:center;border:0;padding:0 8px}
</style><div class="menu"><a href="#keys" class="row" id="compactMenu"><span class="icon">◆</span><span class="label"><span id="compactText" class="truncate">API Keys</span></span></a><div class="row"><span class="icon">◆</span><span class="label"><span id="compactAgent" class="truncate">Agent development</span></span></div></div><div class="tabs"><button class="tab" id="compactTab">Agent credits</button><button class="tab">Coupon</button></div>`);
await page.addStyleTag({content:fs.readFileSync(root+'/content/content.css','utf8')});
const compact=await page.evaluate(()=>{
 const t=test,link=document.getElementById('compactMenu'),icon=link.querySelector('.icon');
 const iconBefore=icon.getBoundingClientRect().y,styleBefore=link.getAttribute('style');let clicks=0;link.onclick=()=>clicks++;
 const text=document.getElementById('compactText'),agent=document.getElementById('compactAgent'),tab=document.getElementById('compactTab');
 t.insertTranslation(text,'API 密钥');t.insertTranslation(agent,'代理开发资源');t.insertTranslation(tab,'代理开发资源');
 const sizes=[text,agent,tab].map(el=>({height:el.getBoundingClientRect().height,translationHeight:el.querySelector('.bt-translation-text').getBoundingClientRect().height,tight:el.querySelector('.bt-translation-text').classList.contains('bt-translation-tight'),nowrap:getComputedStyle(el.querySelector('.bt-translation-text')).whiteSpace}));
 const iconAfter=icon.getBoundingClientRect().y,menuHeight=link.getBoundingClientRect().height;
 t.STATE.mode='translation-only';t.applyMode();const onlyHidden=text.querySelector('.bt-original-text').style.display==='none';
 t.STATE.mode='bilingual';t.applyMode();link.click();t.clearTranslations();
 return {sizes,iconBefore,iconAfter,menuHeight,onlyHidden,clicks,styleRestored:link.getAttribute('style')===styleBefore,original:text.textContent,restoredHeight:text.getBoundingClientRect().height};
});
assert.equal(compact.menuHeight,36);assert.equal(compact.iconBefore,compact.iconAfter);
for(const item of compact.sizes){assert.equal(item.tight,true);assert.equal(item.nowrap,'nowrap');assert.ok(item.translationHeight<=22,'译文不得换成多行或竖排');}
assert.ok(compact.sizes[0].height<=22);assert.ok(compact.sizes[1].height<=22);
assert.equal(compact.onlyHidden,true);assert.equal(compact.clicks,1);assert.equal(compact.styleRestored,true);assert.equal(compact.original,'API Keys');assert.equal(compact.restoredHeight,20);
console.log('PASS Chromium: div/span固定菜单、横向按钮、单行裁切保护、图标位置、显示模式与完整还原',compact);


// 新闻导航常用外层 div 包裹 display:block 的链接；不能将整条链接包成原文后把译文放在外面。
await page.setContent(`<style>
.news-shell{height:42px;overflow:hidden;font:14px/18px Arial;white-space:normal}
.news-nav{display:inline-block;height:42px;overflow-x:hidden;overflow-y:auto;white-space:nowrap;line-height:0}
.news-nav ul{display:flex;margin:0;padding:0;list-style:none;line-height:0;white-space:nowrap}
.news-nav a{display:block;padding:12px 8px;line-height:18px;white-space:nowrap;box-sizing:border-box}
.news-nav .transparent{display:contents}
</style><section class="news-shell"><nav class="news-nav"><ul><li><div id="newsOuter"><a id="newsLink" href="#news">News</a></div></li><li><div id="sportOuter"><span id="sportBlock" style="display:block;line-height:18px;padding:12px 8px">Sport</span></div></li></ul></nav></section><p id="newsBody">Read the <a id="inlineBodyLink" href="#report">full report</a> for more details.</p>`);
await page.addStyleTag({content:fs.readFileSync(root+'/content/content.css','utf8')});
const news=await page.evaluate(()=>{
 const t=test,link=document.getElementById('newsLink'),nav=document.querySelector('.news-nav');
 const collected=t.collectBlocks(),ids=collected.map(item=>item.el.id);
 const before={height:nav.clientHeight,scroll:nav.scrollHeight,link:link.getBoundingClientRect().height};
 let clicks=0;link.addEventListener('click',()=>clicks++);
 t.insertTranslation(link,'新闻');t.insertTranslation(document.getElementById('sportBlock'),'体育');
 const wrapper=link.querySelector('.bt-translation-text');
 wrapper.click();
 const after={height:nav.clientHeight,scroll:nav.scrollHeight,link:link.getBoundingClientRect().height};
 const titleRect=link.querySelector('.bt-original-text').getBoundingClientRect(),translationRect=wrapper.getBoundingClientRect();
 const translatedInsideLink=wrapper.closest('a')===link;
 t.STATE.mode='translation-only';t.applyMode();const onlyClickable=wrapper.closest('a')===link&&getComputedStyle(link).display!=='none';
 t.STATE.mode='bilingual';t.applyMode();t.clearTranslations();
 return {ids,before,after,translatedInsideLink,onlyClickable,clicks,restored:link.textContent==='News'&&document.getElementById('newsLink')===link,wrapperOutside:document.querySelector('#newsOuter>.bt-translation-text')!==null};
});
assert.ok(news.ids.includes('newsLink'));assert.ok(news.ids.includes('sportBlock'));
assert.ok(!news.ids.includes('newsOuter'));assert.ok(!news.ids.includes('sportOuter'));
assert.ok(news.ids.includes('newsBody'));assert.ok(!news.ids.includes('inlineBodyLink'),'普通正文仍按完整句子采集');
assert.deepEqual(news.before,news.after,'译文不得撑高导航或引入纵向滚动');
assert.equal(news.translatedInsideLink,true);assert.equal(news.onlyClickable,true);assert.equal(news.clicks,1);assert.equal(news.restored,true);assert.equal(news.wrapperOutside,false);
console.log('PASS Chromium: 块级链接/span布局容器排除、正文行内链接完整、导航无纵向溢出、译文可点击、模式切换及原节点还原',news);

await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});
