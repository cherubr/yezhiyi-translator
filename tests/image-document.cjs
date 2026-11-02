const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),path=require('node:path');const c={URL,URLSearchParams};c.self=c;
vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../core/image-document.js'),'utf8'),c);const api=c.BT_IMAGE_DOCUMENT;
assert.equal(api.isImageUrl('https://example.org/IMAGE.PNG?download=1#part'),true);
assert.equal(api.isImageUrl('https://example.org/page?file=photo.png'),false);assert.equal(api.isImageUrl('https://example.org/photo.svg'),false);
for(const url of ['file:///private/image.png','javascript:alert(1)','data:image/png;base64,abc','https://user:secret@example.org/a.png'])assert.throws(()=>api.sourceUrl(url));
assert.equal(api.sourceUrl('https://example.org/image?id=1#part').href,'https://example.org/image?id=1');
assert.equal(api.isImageDocument({contentType:'image/png'}),true);assert.equal(api.isImageDocument({contentType:'image/jpeg'}),true);
assert.equal(api.isImageDocument({contentType:'text/html',body:{innerText:''},querySelector:()=>({src:'a.png'})}),false,'网页中有图片不等于独立图片文档');
console.log('PASS: 图片 URL、无后缀 MIME、凭据/协议拒绝及普通网页边界');

// 真实工具栏分流与后台入口：权限申请发生在首次 await 之前，拒绝后不自动读取。
const worker=fs.readFileSync(path.join(__dirname,'../background/service-worker.js'),'utf8'),opened=[],sent=[];let allowed=true,throws=false,requested=0,click;
c.openExtensionPage=value=>opened.push(value);c.chrome={permissions:{request(){requested++;return throws?Promise.reject(Error('gesture')):Promise.resolve(allowed);},contains:async()=>allowed},action:{onClicked:{addListener:fn=>click=fn}}};
c.BT_PDF_DOCUMENT={isPdfUrl:value=>/\.pdf$/.test(value)};c.openPdfReader=value=>opened.push('pdf:'+value);c.safeSendToTab=(...args)=>sent.push(args);c.MSG={OPEN_PANEL:'OPEN_PANEL'};
vm.runInNewContext(worker.slice(worker.indexOf('function openImageReader('),worker.indexOf('// 批次表')),c);
const start=worker.indexOf('chrome.action.onClicked.addListener(');vm.runInNewContext(worker.slice(start,worker.indexOf('\n});',start)+4),c);
(async()=>{
 const task=c.openImageReader('https://example.org/a.png');assert.equal(requested,1);await task;assert.match(opened.at(-1),/load=1/);
 allowed=false;await c.openImageReader('https://example.org/a.png');assert.ok(!opened.at(-1).includes('load=1'));
 allowed=true;throws=true;await c.openImageReader('https://example.org/a.png');assert.match(opened.at(-1),/load=1/,'没有手势也只能复用已授予权限');throws=false;
 click({id:3,url:'https://example.org/a.png'});await new Promise(resolve=>setImmediate(resolve));assert.match(opened.at(-1),/ocr\/reader/);
 click({id:3,url:'https://example.org/a.pdf'});assert.match(opened.at(-1),/^pdf:/);click({id:3,url:'https://example.org/article'});assert.equal(sent.at(-1)[1].action,'OPEN_PANEL');
 console.log('PASS: 图片工具栏分流、直接点击申请权限、拒绝后保留手动读取与已有权限核验');
})().catch(error=>{console.error(error);process.exitCode=1;});
