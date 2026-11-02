/** 浏览器确认的恢复可以重新激活文档；普通退役请求和迟到的恢复查询不能覆盖活动文档。 */
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../background/service-worker.js'),'utf8');
let query=async()=>({documentId:'A',documentLifecycle:'active'});const cancelled=[];
const context={chrome:{webNavigation:{getFrame:details=>query(details)}},translationRuntime:{removeOwner:owner=>cancelled.push(owner)},frameSessions:{ready:async()=>({sessionId:'current'})},cancelledError:()=>Object.assign(Error('cancelled'),{name:'AbortError'})};
vm.createContext(context);vm.runInContext(source.slice(source.indexOf('const requestGroups ='),source.indexOf('function emitRequestState')),context);
const sender=documentId=>({tab:{id:1},frameId:0,documentId,documentLifecycle:'active'});
(async()=>{
 const a=sender('A'),b=sender('B'),c=sender('C');context.registerOwner(a);context.activateDocument(b);
 assert.throws(()=>context.registerOwner(a),error=>error.name==='AbortError');assert.equal(cancelled.length,1);
 await context.resumeDocument(a);assert.equal(context.registerOwner(a),context.ownerKey(a));assert.throws(()=>context.registerOwner(b));
 await assert.rejects(context.resumeDocument({...a,documentLifecycle:'cached'}));assert.throws(()=>context.registerOwner({...a,documentLifecycle:'cached'}));
 await assert.rejects(context.resumeDocument(b),'只有查询确认的活动文档可恢复');
 let resolve;query=()=>new Promise(done=>resolve=done);const pending=context.resumeDocument(a);context.activateDocument(c);resolve({documentId:'A',documentLifecycle:'active'});await assert.rejects(pending,'恢复查询期间已发生新导航，丢弃迟到查询');
 assert.equal(context.registerOwner(c),context.ownerKey(c));assert.throws(()=>context.registerOwner(a));
 query=async()=>({documentId:'B',documentLifecycle:'active'});await context.resumeDocument(b);assert.equal(context.registerOwner(b),context.ownerKey(b));
 assert.throws(()=>context.registerOwner(a),'重新激活 B 不会放行 A 的旧请求');
 console.log('PASS: 往返恢复身份、浏览器活动文档核验、缓存消息拒绝及导航竞争隔离');
})().catch(error=>{console.error(error);process.exitCode=1;});
