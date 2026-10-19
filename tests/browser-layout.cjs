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
for(const f of ['core/constants.js','core/providers.js'])await page.addScriptTag({content:fs.readFileSync(root+'/'+f,'utf8')});
let s=fs.readFileSync(root+'/content/content.js','utf8').replace('  bootstrap();','  window.test = { STATE, collectBlocks, insertTranslation, applyMode, clearTranslations, createFab, setFabBusy, setFabTranslated, splitText, isMostlyChinese }; bootstrap();');
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
await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});
