const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const c={crypto:require('node:crypto').webcrypto};c.self=c;vm.runInNewContext(fs.readFileSync(require('node:path').join(__dirname,'../core/frame-sessions.js'),'utf8'),c);
(async()=>{
 const sent=[],requests=[],api=c.BT_FRAME_SESSIONS.create(async(...args)=>sent.push(args),id=>requests.push(id)),sender=(frameId,documentId='doc'+frameId)=>({tab:{id:1},frameId,documentId});
 const top=await api.ready(sender(0)),child=await api.ready(sender(1));assert.equal(top.sessionId,child.sessionId);assert.equal(requests.length,1);
 await assert.rejects(api.publish(sender(1),{started:true}),/主页面/);
 const active=await api.publish(sender(0),{started:true});assert.equal(sent.length,1);assert.equal(sent[0][2],undefined,'广播覆盖 Worker 重启前的子文档');assert.equal(active.started,true);
 const late=await api.ready(sender(2));assert.equal(late.started,true);assert.equal(late.version,active.version);
 await api.publish(sender(0),{started:true,paused:true});assert.equal(sent.at(-1)[1].paused,true);
 const reload=await api.ready(sender(0,'new'));assert.notEqual(reload.sessionId,active.sessionId);assert.equal(reload.started,false);
 await assert.rejects(api.publish(sender(0),{started:true}),/变化/);
 api.remove(1);await api.publish(sender(0),{started:true,paused:true});assert.equal(sent.at(-1)[1].paused,true,'后台登记丢失后仍广播取消');api.remove(1);assert.notEqual((await api.ready(sender(0))).sessionId,reload.sessionId);
 console.log('PASS: iframe 主文档权限、动态文档继承、定向广播、取消和导航会话隔离');
})().catch(error=>{console.error(error);process.exitCode=1;});
