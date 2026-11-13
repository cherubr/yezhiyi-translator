/** 旧段落修订只读兼容：写入与恢复入口已移除，用户现有保存内容不能丢失。 */
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const scope={window:{}};vm.runInNewContext(fs.readFileSync('pdf/translation-edits.js','utf8'),scope);
(async()=>{
 const row={version:1,key:JSON.stringify([1,'doc-A','zh',1,'1:0']),documentId:'doc-A',scope:'zh',page:1,source:'Original',text:'Legacy revision',updated:1};
 const edits=scope.window.BT_PDF_EDITS.create({all:async()=>[row]}),block={id:'1:0',text:'Original'};
 await edits.setDocument('doc-A');assert.equal(edits.get('zh',1,block).text,'Legacy revision');
 assert.equal(edits.get('en',1,block),null);assert.equal(edits.get('zh',2,block),null);
 assert.equal(edits.get('zh',1,{...block,text:'Changed source'}),null);assert.equal(edits.unmatched('zh',1,[]),1);
 assert.equal(edits.save,undefined);assert.equal(edits.remove,undefined,'legacy mutation API is deleted');
 await edits.setDocument('doc-B');assert.equal(edits.get('zh',1,block),null);
 let finish;const delayed=scope.window.BT_PDF_EDITS.create({all:()=>new Promise(resolve=>{finish=resolve;})});
 const pending=delayed.setDocument('doc-A');await delayed.setDocument(null);finish([row]);await pending;
 assert.equal(delayed.get('zh',1,block),null,'late load cannot restore another document');
 console.log('PASS legacy PDF edits: read-only compatibility, identity and source isolation');
})().catch(error=>{console.error(error);process.exitCode=1;});
