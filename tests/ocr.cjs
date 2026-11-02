const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
let terminate=0,recognize,initialize;const c={chrome:{runtime:{getURL:p=>p}},Tesseract:{async createWorker(){if(initialize)await initialize;return {recognize:()=>recognize(),terminate:async()=>{terminate++;}};}}};c.self=c;
vm.runInNewContext(fs.readFileSync(require('node:path').join(__dirname,'../core/ocr-runtime.js'),'utf8'),c);
(async()=>{
 const api=c.BT_OCR.create();recognize=async()=>({data:{text:'  Linux text  '}});assert.equal(await api.recognize({},'eng'),'Linux text');assert.equal(terminate,1);
 await assert.rejects(api.recognize({},'bad'),/语言/);
 let release;initialize=new Promise(resolve=>release=resolve);const pending=api.recognize({},'eng');await new Promise(resolve=>setImmediate(resolve));api.cancel();await assert.rejects(pending,error=>error.name==='AbortError');release();await new Promise(resolve=>setImmediate(resolve));assert.equal(terminate,2,'初始化完成后的迟到 Worker 也要释放');initialize=null;
 recognize=async()=>({data:{text:'x'.repeat(100001)}});await assert.rejects(api.recognize({}),/过长/);assert.equal(terminate,3);
 console.log('PASS: OCR 成功与超限释放、语言校验、初始化取消与迟到 Worker 清理');
})().catch(error=>{console.error(error);process.exitCode=1;});
