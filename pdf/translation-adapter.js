(function(global) {
  "use strict";
  const E=global.BT_PDF_ERRORS;
  const interrupted=()=>E.create("CONNECTION_INTERRUPTED","翻译后台连接中断，请刷新翻译设置后继续或重新翻译","translate");
  /** Port 只承载无凭据配置和阶段通知；正文仍通过原有 TRANSLATE 消息。 */
  function create({onInvalidated,onDisconnected,onRequestState}) {
    let port=null,sequence=0,stateVersion=0,viewportEpoch=0,disposed=false;
    const pending=new Map(),requests=new Set();
    function state() {
      if(!port)return;
      try{port.postMessage({type:"STATE",visible:!document.hidden,stateVersion:++stateVersion,viewportEpoch});}catch(_){}
    }
    function connect() {
      if(disposed)throw interrupted();
      if(port)return port;
      const current=chrome.runtime.connect({name:"BT_PDF_TRANSLATION"});port=current;
      current.onMessage.addListener(message=>{
        if(port!==current)return;
        if(message.type==="REPLY"){
          const task=pending.get(message.id);if(!task)return;
          pending.delete(message.id);clearTimeout(task.timer);
          message.ok?task.resolve(message.data):task.reject(Object.assign(new Error(message.error||"读取翻译配置失败"),{code:message.code||"PDF_CONTEXT_ERROR"}));
        }else if(message.type==="CONFIG_INVALIDATED")onInvalidated();
        else if(message.type==="REQUEST_STATE")onRequestState(message);
      });
      current.onDisconnect.addListener(()=>{
        void chrome.runtime.lastError;
        if(port!==current)return;
        port=null;
        for(const task of pending.values()){clearTimeout(task.timer);task.reject(interrupted());}pending.clear();
        for(const reject of [...requests])reject(interrupted());
        if(!disposed)onDisconnected();
      });
      state();return current;
    }
    function rpc(type,data={}) {
      return new Promise((resolve,reject)=>{
        let current;try{current=connect();}catch(error){reject(error);return;}
        const id=++sequence;
        const timer=setTimeout(()=>{pending.delete(id);reject(interrupted());},10000);
        pending.set(id,{resolve,reject,timer});
        try{current.postMessage({type,id,...data});}catch(_){clearTimeout(timer);pending.delete(id);reject(interrupted());}
      });
    }
    async function context() {return rpc("CONTEXT");}
    async function bind(token,revision) {await rpc("BIND_BATCH",{runToken:token,revision});}
    function cancel(token) {
      if(!token)return;
      try{port?.postMessage({type:"END_BATCH",runToken:token});}catch(_){}
      try{chrome.runtime.sendMessage({action:"CANCEL_TRANSLATION_REQUESTS",runToken:token},()=>{void chrome.runtime.lastError;});}catch(_){}
    }
    function translate(block,config,{token,signal,manual,refreshCache}) {
      const protection=global.BT_TRANSLATION_UNITS.encode(block.segments);
      return new Promise((resolve,reject)=>{
        let settled=false;
        const finish=(error,text)=>{
          if(settled)return;settled=true;signal.removeEventListener("abort",abort);requests.delete(fail);
          error?reject(error):resolve(text);
        };
        const abort=()=>finish(E.cancelled()),fail=error=>finish(error);
        signal.addEventListener("abort",abort,{once:true});requests.add(fail);
        if(signal.aborted||!port){finish(signal.aborted?E.cancelled():interrupted());return;}
        try{
          chrome.runtime.sendMessage({action:"TRANSLATE",runToken:token,engine:config.engine,aiProvider:config.aiProvider,
            text:protection.text,from:config.from,to:config.to,priority:1,pageVisible:!document.hidden,
            viewportEpoch,stateVersion,retryManual:manual,retryToken:token,refreshCache},response=>{
            const runtimeError=chrome.runtime.lastError;
            if(settled)return;
            if(runtimeError||!response){finish(interrupted());return;}
            if(response.cancelled){finish(E.cancelled());return;}
            if(!response.ok){finish(Object.assign(new Error(response.error||"翻译失败"),
              {code:response.code,retryable:response.retryable,permanent:response.permanent,exhausted:response.exhausted}));return;}
            try{
              if(typeof response.data!=="string"||!response.data.trim())throw new Error("翻译服务返回空内容");
              finish(null,global.BT_TRANSLATION_UNITS.decode(response.data,protection));
            }catch(error){finish(error);}
          });
        }catch(_){finish(interrupted());}
      });
    }
    function setPage(page) {viewportEpoch=page;state();}
    function whenVisible(signal) {
      if(!document.hidden)return Promise.resolve();
      return new Promise((resolve,reject)=>{
        const finish=error=>{document.removeEventListener("visibilitychange",changed);signal.removeEventListener("abort",abort);error?reject(error):resolve();};
        const changed=()=>{if(!document.hidden)finish();},abort=()=>finish(E.cancelled());
        document.addEventListener("visibilitychange",changed);signal.addEventListener("abort",abort,{once:true});
        if(signal.aborted)abort();else changed();
      });
    }
    const configKeys=new Set(["engine","aiProvider","aiKeys","from","to","baiduAppId","baiduKey","baiduVerification","glossary","requestPolicies","requestPolicyVersion"]);
    // 只检查变更键，不保存值；后台断开期间的配置变化也会使本页快照失效。
    const storageChanged=changes=>{if(Object.keys(changes).some(key=>configKeys.has(key)))onInvalidated();};
    chrome.storage.onChanged.addListener(storageChanged);
    document.addEventListener("visibilitychange",state);
    function dispose(){disposed=true;chrome.storage.onChanged.removeListener(storageChanged);document.removeEventListener("visibilitychange",state);port?.disconnect();}
    return {context,bind,cancel,translate,setPage,whenVisible,dispose};
  }
  global.BT_PDF_TRANSLATION_ADAPTER={create};
})(window);
