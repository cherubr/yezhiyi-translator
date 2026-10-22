// 内容脚本回归：在模拟页面与扩展消息环境中检查采集、分块、插入、还原及取消行为。
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const root = require('node:path').resolve(__dirname, '..');
const context = { window: { addEventListener() {}, getComputedStyle:()=>({display:'block'}) }, self: {}, console, TextEncoder, setTimeout, clearTimeout,
  chrome: { runtime: { onMessage: { addListener() {} } }, storage: { onChanged: { addListener() {} } } } };
context.self = context.window;
vm.createContext(context);
vm.runInContext(fs.readFileSync(root + '/core/constants.js', 'utf8'), context);
vm.runInContext(fs.readFileSync(root + '/core/translation-units.js', 'utf8'), context);
vm.runInContext(fs.readFileSync(root + '/core/request-policy.js', 'utf8'), context);
context.window.AI_PROVIDER_NAMES = {};
let source = fs.readFileSync(root + '/content/content.js', 'utf8');
source = source.replace('  bootstrap();', '  window.test = { STATE, requestTranslate, sameTranslation, translatePage, bindHoverTranslate, handleBlock, isMostlyChinese, applyMode, translatedElements, cancelTranslation, insertTranslation, setFabBusy, setFabTranslated, createFab, collectBlocks, scheduleVisibleTranslation, observeDynamicContent, mountFab: (wrap, el) => { fabWrap = wrap; fabEl = el; } };');
vm.runInContext(source, context);
const t = context.window.test;
assert.equal(t.STATE.from, 'auto');
assert.equal(t.isMostlyChinese('This English paragraph mentions 中文 terms.'), false);
assert.equal(t.isMostlyChinese('这是一个完整中文段落。'), true);
for (const title of ['优化Chrome插件','Pro权益说明','简单翻译插件','使用API接口']) {
 assert.equal(t.isMostlyChinese(title),true,title);
}
for (const text of ['Spring makes Java development easier with 中文 examples.', '日本語の設定', '한국어 漢字']) {
 assert.equal(t.isMostlyChinese(text),false,text);
}
t.STATE.to='en';
assert.equal(t.isMostlyChinese('优化Chrome插件'),false,'中文翻译到英文仍正常处理');
t.STATE.to='zh-CN';
assert.equal(t.sameTranslation('Pro 权益说明','Pro权益说明'),true);
assert.equal(t.sameTranslation('Home','首页'),false);
for(const text of ['Use 中文','Read 中文 docs','日本語の設定','これは漢字です','한국어 漢字'])assert.equal(t.isMostlyChinese(text),false,text);
t.STATE.from='zh-CN';t.STATE.to='zh-TW';
assert.equal(t.isMostlyChinese('简体中文转换'),false,'显式简繁转换不跳过');
t.STATE.from='auto';t.STATE.to='zh-CN';
class Element {
 constructor(tag='span') { this.nodeType=1; this.tagName=tag.toUpperCase(); this.children=[]; this.style={}; this.attrs={}; this.isConnected=true; this.className=''; this.classList={contains: name=>this.className.split(' ').includes(name),toggle:(name,on)=>{const names=new Set(this.className.split(' ').filter(Boolean));on?names.add(name):names.delete(name);this.className=[...names].join(' ');},add:name=>{this.className+=' '+name;}}; }
 get parentElement(){return this.parentNode||null;}
 get childNodes(){return this.children;}
 getBoundingClientRect(){return {width:200,height:20,top:0,bottom:20,left:0,right:200};}
 closest(){return null;}
 querySelector(){return null;}
 querySelectorAll(){return [];}
 matches(){return false;}
 hasAttribute(k){return Object.hasOwn(this.attrs,k);}
 getAttribute(k){return this.attrs[k] ?? null;}
 get firstChild(){return this.children[0]||null;}
 appendChild(n){n.remove();this.children.push(n);n.parentNode=this;return n;}
 insertBefore(n,ref){n.remove();this.children.splice(this.children.indexOf(ref),0,n);n.parentNode=this;}
 remove(){if(this.parentNode){const a=this.parentNode.children;a.splice(a.indexOf(this),1);this.parentNode=null;}}
 setAttribute(k,v){this.attrs[k]=v;}
 removeAttribute(k){delete this.attrs[k];}
}
context.document={createElement:tag=>new Element(tag),querySelectorAll:()=>[]};
const parents=[];
for (const tag of ['p','li','td','h2']) {
 const parent=new Element('div'),el=new Element(tag),link=new Element('a');
 parent.appendChild(el);el.appendChild(link);parents.push({parent,el,link});
 t.insertTranslation(el,'测试译文');
 assert.equal(parent.children.length,1,'must not add a layout sibling');
 assert.equal(el.children[0].firstChild,link,'original nodes preserved');
 assert.equal(el.children[1].className,'bt-translation-text');
 for (const mode of ['translation-only','bilingual','translation-only','bilingual']) {
  t.STATE.mode=mode;t.applyMode();
  assert.equal(el.children[0].style.display,mode==='translation-only'?'none':'contents');
 }
}
t.cancelTranslation();
for(const {el,link} of parents)assert.deepEqual(el.children,[link]);
assert.equal(t.STATE.pagePaused,true);
assert.equal(t.translatedElements.size,0);
assert.match(JSON.parse(fs.readFileSync(root+'/manifest.json')).version,/^\d+\.\d+\.\d+$/);
assert.ok(!source.includes('figcaption, article > div'));
const fabWrap=new Element('div'),fab=new Element('div');
t.mountFab(fabWrap,fab);
t.STATE.translated=true;t.setFabTranslated(true);
assert.equal(fabWrap.classList.contains('bt-translated'),false,'暂停页面不能显示完成徽标');
t.STATE.pagePaused=false;t.setFabTranslated(true);
assert.equal(fabWrap.classList.contains('bt-translated'),true);
t.STATE.translating=true;t.setFabBusy(true);
assert.equal(fabWrap.classList.contains('bt-translated'),false);
assert.equal(fab.classList.contains('bt-busy'),true);
t.STATE.translating=false;t.setFabBusy(false);
assert.equal(fabWrap.classList.contains('bt-translated'),true);
assert.equal(fab.classList.contains('bt-busy'),false);
console.log('PASS: 默认语言、混合语言、段落/列表/表格/标题内部插入、模式切换、DOM还原、取消暂停');

// Dialog/form selection and visibility without requesting a real provider.
context.window.innerHeight=900;context.window.innerWidth=1200;
context.window.getComputedStyle=()=>({display:'block',visibility:'visible'});
function candidate(text,{compact=false,hidden=false,control=false}={}) {
 const el={textContent:text,tagName:compact?'LABEL':'DIV',children:[],childNodes:[],querySelectorAll:()=>[],closest(sel){
   if(sel.includes('[hidden]'))return hidden?{}:null;
   return null;
 },hasAttribute(){return false;},querySelector(sel){return control&&sel.startsWith('input,')?{}:null;},
 matches(sel){return sel.split(',').some(part=>part.trim().toLowerCase()===el.tagName.toLowerCase()||(part.trim()==='[hidden]'&&hidden));},getBoundingClientRect(){return {width:200,height:30,top:20,bottom:50,left:10,right:210};}};
 const node={nodeType:3,textContent:text,parentNode:el,parentElement:el,nextSibling:null};el.childNodes.push(node);
 if(control){const input={nodeType:1,tagName:'INPUT',childNodes:[],children:[],textContent:'',parentNode:el,parentElement:el,matches:sel=>sel.split(',').some(part=>part.trim()==='input'),querySelector:()=>null,querySelectorAll:()=>[]};node.nextSibling=input;el.childNodes.push(input);el.children.push(input);}
 return el;
}
const label=candidate('Email',{compact:true}),ok=candidate('OK',{compact:true}),
 hidden=candidate('Hidden dialog',{hidden:true}),mixed=candidate('Name',{compact:true,control:true});
context.document.querySelectorAll=sel=>sel.startsWith('dialog')?[]:[label,ok,hidden,mixed];
assert.deepEqual(Array.from(t.collectBlocks(),x=>x.text),['Email','OK','Name']);
let scheduled=0;context.setTimeout=()=>{scheduled++;return 1;};context.clearTimeout=()=>{};
t.STATE.pagePaused=false;t.STATE.autoTranslate=true;t.STATE.cancelRequested=false;
let observed;
context.MutationObserver=class{constructor(fn){observed=fn;}observe(){}};
context.document.body={};context.document.addEventListener=()=>{};
t.observeDynamicContent();
const target={nodeType:1,closest:()=>null,hasAttribute:()=>false};
observed([{target,type:'childList',addedNodes:[{nodeType:1,matches:()=>true}]}]);
assert.equal(scheduled,0,'ignore own wrappers');
observed([{target,type:'childList',addedNodes:[{nodeType:1,matches:()=>false}]}]);
assert.equal(scheduled,1,'new popup schedules translation');
t.STATE.pagePaused=true;t.scheduleVisibleTranslation();
assert.equal(scheduled,1,'cancelled page stays paused');
console.log('PASS: 短表单标签、隐藏弹框排除、控件保护、动态弹框触发、插件自身变动去重、取消后不重启');

// Sidebar fields must be collected without selecting the enclosing layout.
t.STATE.pagePaused=false;
const title=candidate('Decisions API'), description=candidate('Turn text and images into decisions'),
 date=candidate('10 days ago'), phrase=candidate('Read the API guide'), inline=candidate('API'),
 layout=candidate('Decisions API Turn text and images into decisions');
inline.parentNode=inline.parentElement=phrase;
layout.querySelector=sel=>sel.startsWith('div, dl')?title:null;
layout.children=[title,description];layout.childNodes=[title,description];
title.nodeType=description.nodeType=1;title.parentNode=title.parentElement=layout;description.parentNode=description.parentElement=layout;
context.document.querySelectorAll=sel=>sel.startsWith('dialog')?[]:[layout,title,description,date,phrase,inline];
assert.deepEqual(Array.from(t.collectBlocks(),x=>x.text),[
 'Decisions API','Turn text and images into decisions','10 days ago','Read the API guide'
]);
const beforeTextChange=scheduled;
observed([{target,type:'characterData'}]);
assert.equal(scheduled,beforeTextChange+1,'in-place text changes schedule translation');

const dynamic=new Element('div');
dynamic.textContent='Original update';
t.insertTranslation(dynamic,'原始更新');
const entry=t.translatedElements.get(dynamic);
entry.original.textContent='New update';
const beforeInvalidation=scheduled;
observed([{target:entry.original,type:'characterData'}]);
assert.equal(t.translatedElements.has(dynamic),false,'stale translation removed');
assert.equal(entry.wrapper.parentNode,null);
assert.equal(scheduled,beforeInvalidation+1,'changed source schedules a fresh translation');
console.log('PASS: 侧栏普通文本、时间、内联去重、布局容器排除、动态文本补翻、旧译文失效');

const mixedLabel=candidate('Accept terms',{control:true});
const labelText={nodeType:3,textContent:'Accept terms',parentNode:mixedLabel};
mixedLabel.childNodes=[mixedLabel.children[0],labelText];
const iconButton=candidate('Save');
iconButton.childNodes=[{nodeType:3,textContent:'Save',parentNode:iconButton}];
iconButton.querySelector=sel=>sel.startsWith('div, dl')?{}:null;
context.document.querySelectorAll=()=>[mixedLabel,iconButton];
const mixedBlocks=t.collectBlocks();
assert.equal(mixedBlocks.length,2);
assert.equal(mixedBlocks[0].node,labelText,'mixed label sends only its text');
assert.equal(mixedBlocks[1].text,'Save','bare text next to icon is included');
t.STATE.autoTranslate=false;t.STATE.translated=false;t.STATE.pageStarted=false;
const beforeManual=scheduled;t.scheduleVisibleTranslation();
assert.equal(scheduled,beforeManual,'未启动且自动开关关闭时不能补翻');
t.STATE.pageStarted=true;t.scheduleVisibleTranslation();
assert.equal(scheduled,beforeManual+1,'手动启动当前页后，即使自动开关关闭也持续补翻');
t.STATE.pagePaused=true;t.scheduleVisibleTranslation();
assert.equal(scheduled,beforeManual+1,'只有取消暂停当前页后才停止补翻');
t.STATE.pagePaused=false;

(async()=>{
 const byteRequests=[];
 context.chrome.runtime.sendMessage=(request,cb)=>{if(request.action==="CANCEL_TRANSLATION_REQUESTS"){cb?.({ok:true});return;}byteRequests.push(request.text);cb({ok:true,data:'译文'});};
 await t.requestTranslate('Unicode 🙂 内容 '.repeat(140),{engine:'mymemory',from:'en',to:'zh-CN'});
 assert.equal(byteRequests.length,1,'页面将完整文字任务交给后台，分片限制在后台验证');
 assert.equal(byteRequests[0],'Unicode 🙂 内容 '.repeat(140));
 context.chrome.runtime.sendMessage=(request,cb)=>cb({ok:true,data:'接受条款'});
 const labelEl=new Element('label'),input=new Element('input'),textNode=new Element();
 textNode.nodeType=3;textNode.textContent='Accept terms';
 labelEl.appendChild(input);labelEl.appendChild(textNode);
 t.STATE.cancelRequested=false;t.STATE.pagePaused=false;
 assert.equal(await t.handleBlock({el:labelEl,text:'Accept terms',node:textNode},{}),true);
 assert.equal(labelEl.children[0],input,'checkbox stays in its original position');
 assert.equal(input.parentNode,labelEl,'control is never wrapped');
 assert.equal(labelEl.children[1].className,'bt-text-fragment');
 assert.equal(labelEl.attrs['data-bt-processed'],undefined,'mixed parent remains available for new text');
 context.document.querySelectorAll=()=>[];
 t.cancelTranslation();
 assert.deepEqual(labelEl.children,[input,textNode],'cancel restores exact original nodes and order');
 console.log('PASS: 混合控件标签、图标按钮、手动翻译后的补翻、控件位置保护、文字片段完整还原');

 // 即使已取出的旧定时回调仍被执行，也不能解除取消状态。
 let queuedCallback,cleared=false;
 context.setTimeout=fn=>{queuedCallback=fn;return 123;};
 context.clearTimeout=id=>{if(id===123)cleared=true;};
 t.STATE.pagePaused=false;t.STATE.cancelRequested=false;
 t.scheduleVisibleTranslation();
 t.cancelTranslation();
 assert.equal(cleared,true,'cancel clears the pending visible timer');
 queuedCallback();
 await t.translatePage(false,true);
 assert.equal(t.STATE.pagePaused,true,'stale automatic work cannot resume the page');
 assert.equal(t.STATE.translating,false);

 // 取消丢弃旧结果并暂停自动悬停，但允许之后明确按 Shift 翻译单段。
 let hoverListener,reply,requests=0;
 context.document.addEventListener=(type,fn)=>{if(type==='mouseover')hoverListener=fn;};
 context.chrome.runtime.sendMessage=(request,cb)=>{if(request.action==="CANCEL_TRANSLATION_REQUESTS"){cb?.({ok:true});return;}requests++;reply=cb;};
 t.bindHoverTranslate();
 const hoverEl=new Element('p');
 hoverEl.textContent='Hover paragraph';hoverEl.hasAttribute=()=>false;
 hoverEl.appendChild(Object.assign(new Element('span'),{nodeType:3,textContent:'Hover paragraph'}));
 hoverEl.closest=selector=>selector.startsWith('p, h1, h2')?hoverEl:null;
 hoverEl.matches=selector=>selector.startsWith('p, h1, h2');
 hoverEl.querySelector=()=>null;
 hoverEl.getBoundingClientRect=()=>({width:200,height:30,top:20,bottom:50,left:10,right:210});
 const event={target:hoverEl,shiftKey:true};
 t.STATE.pagePaused=false;t.STATE.cancelRequested=false;
 const hoverTask=hoverListener(event);
 assert.equal(requests,1);
 t.cancelTranslation();reply({ok:true,data:'悬停段落'});
 await hoverTask;
 assert.equal(t.translatedElements.size,0,'late hover result is discarded');
 t.STATE.hoverRequireShift=false;
 await hoverListener({target:hoverEl,shiftKey:false});
 assert.equal(requests,1,'暂停后直接悬停不发请求');
 t.STATE.hoverRequireShift=true;
 const manualHover=hoverListener(event);
 assert.equal(requests,2,'取消后明确按 Shift 可重新请求单段');
 reply({ok:true,data:'手动悬停段落'});
 await manualHover;
 assert.equal(t.translatedElements.size,1);
 assert.equal(t.STATE.pagePaused,true,'手动悬停不解除整页暂停');
 t.cancelTranslation();
 console.log('PASS: 取消清理定时器、旧任务与迟到结果拦截、暂停自动悬停、取消后允许Shift单段翻译');
})().catch(error=>{console.error(error);process.exitCode=1;});
