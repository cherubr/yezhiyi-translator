(function(global){
  "use strict";
  /** 后台用 Chrome 的 sender 登记文档；主框架独占会话控制，子框架不能取消其他框架。 */
  function create(send,requestTop){
    const tabs=new Map();
    function state(tabId){if(!tabs.has(tabId))tabs.set(tabId,{sessionId:crypto.randomUUID(),version:0,started:false,paused:false,visible:true,frames:new Map()});return tabs.get(tabId);}
    function snapshot(s){return {sessionId:s.sessionId,version:s.version,started:s.started,paused:s.paused,visible:s.visible};}
    async function ready(sender){
      if(sender.tab?.id==null)throw Error("框架缺少标签页身份");
      const tabId=sender.tab.id,frameId=sender.frameId||0;let s=state(tabId);
      if(frameId===0&&s.frames.get(0)?.documentId&&s.frames.get(0).documentId!==sender.documentId){tabs.delete(tabId);s=state(tabId);}
      if(s.frames.size>=256&&!s.frames.has(frameId)){const oldest=[...s.frames.keys()].find(id=>id!==0);s.frames.delete(oldest);}
      s.frames.set(frameId,{frameId,documentId:sender.documentId});
      if(frameId!==0)void requestTop(tabId);
      return snapshot(s);
    }
    async function publish(sender,request){
      if(sender.tab?.id==null||(sender.frameId||0)!==0)throw Error("只有主页面可以控制整页翻译");
      const s=state(sender.tab.id),top=s.frames.get(0);
      if(top?.documentId&&top.documentId!==sender.documentId)throw Error("主页面文档已变化");
      s.frames.set(0,{frameId:0,documentId:sender.documentId});
      s.version++;s.started=request.started===true;s.paused=request.paused===true;s.visible=request.visible!==false;
      const current=snapshot(s);
      // Worker 重启后登记表可能为空，广播仍须覆盖已存在的子文档；主页面忽略接收。
      try{await send(sender.tab.id,{action:"FRAME_APPLY_SESSION",...current});}catch(_){}
      return current;
    }
    return {ready,publish,remove:tabId=>tabs.delete(tabId)};
  }
  global.BT_FRAME_SESSIONS={create};
})(typeof self!=="undefined"?self:globalThis);
