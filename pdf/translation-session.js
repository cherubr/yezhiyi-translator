(function(global) {
  "use strict";
  const E=global.BT_PDF_ERRORS;
  /** 只管理 PDF 文字任务和三页有界快照，不拥有文件/画布，也不另建网络调度器。 */
  function create({onState,onConfig,onRows}) {
    let documentRef=null,page=1,pageReady=false,context=null,selection=null,revision=0,generation=0;
    let active=null,currentEntry=null,started=false,paused=false,disposed=false,configTask=null;
    const cache=new Map();
    const state={phase:"idle",message:"读取 PDF 后点击开始翻译",busy:false,configured:false,configReady:false,hasRun:false,canContinue:false};
    const publish=()=>{if(!disposed)onState({...state});};
    const stamp=()=>context&&selection?JSON.stringify([revision,{...selection,to:global.BT_CONST.resolveTargetLanguage(selection.to)}]):"";
    const entryKey=()=>documentRef?documentRef.id+":"+page+":"+stamp():"";
    const show=(entry,reveal=true)=>{if(!disposed)onRows(entry?entry.blocks.map(block=>({block,result:reveal?entry.results.get(block.id):null})):[]);};
    const weight=entry=>entry.blocks.reduce((n,b)=>n+b.text.length*2+800,0)+[...entry.results.values()].reduce((n,r)=>n+(r.text?.length||0)*2+200,0);
    function trimCache() {
      let total=[...cache.values()].reduce((n,entry)=>n+weight(entry),0);
      for(const [key,entry] of cache){
        if(cache.size<=3&&total<=4*1024*1024)break;
        if(entry===currentEntry)continue;
        cache.delete(key);total-=weight(entry);
      }
    }
    function halt() {
      generation++;
      if(active){active.controller.abort();adapter.cancel(active.token);active=null;}
      state.busy=false;
    }
    function invalidate(message) {
      halt();cache.clear();currentEntry=null;started=false;paused=false;
      Object.assign(state,{phase:"idle",message,hasRun:false,canContinue:false});show(null);publish();
    }
    const adapter=global.BT_PDF_TRANSLATION_ADAPTER.create({
      onInvalidated(){
        revision++;context=null;selection=null;state.configReady=false;
        invalidate("翻译配置已变化，旧结果已清除，请确认设置后重新开始");
        void loadConfig();
      },
      onDisconnected(){
        if(disposed)return;
        const running=!!active;halt();paused=true;
        if(running){Object.assign(state,{phase:"interrupted",message:"翻译后台连接中断，已保留成功结果；可继续或重新翻译",canContinue:true});show(currentEntry);}
        else state.message="翻译后台连接已断开，下一次操作将重新连接";
        publish();
      },
      onRequestState(message){
        if(!active||active.token!==message.runToken)return;
        state.message="服务正在重试（"+(message.attempt||1)+" / "+(message.maxAttempts||3)+"），请稍候";publish();
      }
    });
    async function loadConfig() {
      if(configTask)return configTask;
      const version=revision;
      state.configured=false;state.configReady=false;state.message="正在读取翻译设置…";publish();
      const work=(async()=>{
        try{
          const next=await adapter.context();
          if(disposed||version!==revision)return;
          context=next;
          if(!selection)selection={engine:next.engine,aiProvider:next.aiProvider,from:next.from,to:next.to};
          state.configured=next.services.some(item=>item.value===global.BT_SERVICES.value(selection.engine,selection.aiProvider)&&item.ready);
          state.configReady=true;state.message=documentRef?"翻译设置已读取，请开始或继续本页翻译":"读取 PDF 后点击开始翻译";onConfig({services:next.services,...selection});publish();
        }catch(error){
          if(disposed||version!==revision)return;
          state.message=error.message||"无法读取翻译配置";state.phase="config-error";publish();
        }
      })();
      configTask=work;
      await work;
      if(configTask===work)configTask=null;
      if(!disposed&&version!==revision&&!context)return loadConfig();
    }
    function select(value) {
      if(!context)return;
      revision++;selection={...selection,...value};
      invalidate("翻译选项已变化，点击开始翻译处理当前页");
      state.configured=context.services.some(item=>item.value===global.BT_SERVICES.value(selection.engine,selection.aiProvider)&&item.ready);publish();
    }
    function setDocument(value) {
      halt();documentRef=value;page=1;pageReady=false;cache.clear();currentEntry=null;started=false;paused=false;
      Object.assign(state,{phase:"idle",hasRun:false,canContinue:false,message:value?"点击开始翻译，仅发送本页可靠文字":"读取 PDF 后点击开始翻译"});show(null);publish();
    }
    function setPage(value) {
      halt();page=value;pageReady=false;adapter.setPage(value);
      currentEntry=cache.get(entryKey())||null;
      Object.assign(state,{phase:started&&!paused?"waiting-page":"idle",hasRun:!!currentEntry,canContinue:paused&&!!currentEntry,
        message:started&&!paused?"等待当前页渲染，再处理本页文字":paused?"翻译已暂停，点击继续翻译处理本页":"点击开始翻译处理当前页"});
      show(currentEntry,!paused);publish();
    }
    function viewReady() {
      pageReady=true;
      if(started&&!paused&&!active&&state.phase==="waiting-page")void run("auto");
    }
    function cancel() {
      if(!documentRef)return;
      halt();paused=true;
      Object.assign(state,{phase:"cancelled",hasRun:true,canContinue:true,message:"已取消翻译，保留本页成功结果；点击继续翻译可恢复"});
      show(currentEntry,false);publish();
    }
    function finish(entry) {
      const results=[...entry.results.values()],failed=results.filter(r=>r.status==="failed").length;
      const translated=results.filter(r=>r.status==="translated").length,skipped=results.filter(r=>r.status==="skipped").length;
      const missing=entry.blocks.filter(b=>b.eligible&&!entry.results.has(b.id)).length;
      const unchanged=results.filter(r=>r.status==="unchanged").length;
      Object.assign(state,{phase:failed||skipped||missing?"partial":"completed",busy:false,hasRun:true,canContinue:false,
        message:"本页"+(failed||skipped||missing?"部分完成":"翻译完成")+"：已译 "+translated+" 段，未变化 "+unchanged+" 段，保留 "+skipped+" 段，失败 "+failed+" 段，待处理 "+missing+" 段。翻页后继续处理当前页。"});
      show(entry);publish();trimCache();
    }
    async function run(mode="start") {
      if(disposed||!documentRef||!pageReady||active)return;
      const currentDocument=documentRef,currentPage=page,requestedGeneration=generation;
      // 手动操作刷新后台配置/连接，自动翻页使用已确认的同一配置快照。
      if(mode!=="auto"||!context)await loadConfig();
      if(disposed||requestedGeneration!==generation||documentRef!==currentDocument||page!==currentPage||!pageReady||active||!context||!state.configured)return;
      halt();started=true;paused=false;
      const controller=new AbortController(),token="pdf:"+crypto.randomUUID(),version=generation,key=entryKey(),configStamp=stamp();
      active={controller,token};
      const valid=()=>!disposed&&!controller.signal.aborted&&generation===version&&documentRef===currentDocument&&page===currentPage&&stamp()===configStamp;
      Object.assign(state,{busy:true,hasRun:true,canContinue:false,phase:"extracting",message:"正在提取并重组本页文字…"});publish();
      let entry=cache.get(key);
      try{
        if(!entry){
          const extracted=await currentDocument.extractPage(currentPage,{signal:controller.signal});
          if(!valid())return;
          const model=global.BT_PDF_BLOCKS.process(extracted);
          if(model.blocks.length>2000)throw E.create("TEXT_BUDGET","本页文本块过多，暂不自动翻译","extract",false);
          entry={blocks:model.blocks,results:new Map(),empty:model.empty};cache.set(key,entry);
        }else{cache.delete(key);cache.set(key,entry);}
        if(!valid())return;
        currentEntry=entry;
        if(mode==="retranslate")entry.results.clear();
        for(const block of entry.blocks){
          if(!block.eligible)entry.results.set(block.id,{status:"skipped",reason:block.reason});
          else if(selection.from!=="auto"&&selection.from===global.BT_CONST.resolveTargetLanguage(selection.to))entry.results.set(block.id,{status:"unchanged",text:block.text});
          else if(block.segments.every(part=>part.protected||!/[\p{L}]/u.test(part.text)))entry.results.set(block.id,{status:"skipped",reason:"保留代码或标识符"});
        }
        show(entry);trimCache();
        if(entry.empty||!entry.blocks.some(b=>b.eligible)){
          Object.assign(state,{phase:"no-text",busy:false,message:entry.empty?"本页没有可靠文字层，可能为扫描页或空白页；OCR 尚未接入，未发送翻译请求":"本页没有可自动翻译的可靠正文；代码、公式或异常文字已保留。OCR 尚未接入。"});publish();return;
        }
        const todo=entry.blocks.filter(b=>b.eligible&&(!entry.results.has(b.id)||(mode!=="auto"&&entry.results.get(b.id).status==="failed")));
        if(!todo.length){finish(entry);return;}
        await adapter.bind(token,context.revision);
        if(!valid())return;
        const config={...selection,to:global.BT_CONST.resolveTargetLanguage(selection.to)};
        for(const block of todo){
          await adapter.whenVisible(controller.signal);
          if(!valid())return;
          Object.assign(state,{phase:"translating",message:"正在翻译：已处理 "+entry.results.size+" / "+entry.blocks.length+" 段；等待服务响应…"});publish();
          try{
            const text=await adapter.translate(block,config,{token,signal:controller.signal,manual:mode!=="auto"&&mode!=="start",refreshCache:mode==="retranslate"});
            if(!valid())return;
            if(text.length>200000||weight(entry)+text.length*2>4*1024*1024)throw E.create("RESULT_BUDGET","译文超过本页结果预算","translate",false);
            entry.results.set(block.id,{status:text.trim()===block.text.trim()?"unchanged":"translated",text});
          }catch(error){
            if(!valid())return;
            if(error.code==="CONNECTION_INTERRUPTED"||error.name==="AbortError"||error.code==="CANCELLED")throw error;
            entry.results.set(block.id,{status:"failed",reason:String(error.message||"翻译失败").slice(0,500),code:error.code});
            // 后台已经执行有界重试；失败后停止继续消费本页额度，用户可明确继续。
            show(entry);throw error;
          }
          show(entry);trimCache();
        }
        if(valid())finish(entry);
      }catch(error){
        if(!valid())return;
        paused=true;
        Object.assign(state,{phase:"interrupted",busy:false,canContinue:true,
          message:(error.code==="CONNECTION_INTERRUPTED"?error.message:error.name==="AbortError"?"翻译任务已取消或后台配置变化，请确认后继续":error.message||"本页处理失败")+"；已保留成功结果"});
        show(entry);publish();
      }finally{
        adapter.cancel(token);
        if(active?.token===token){active=null;state.busy=false;publish();}
      }
    }
    function dispose(){disposed=true;halt();cache.clear();currentEntry=null;documentRef=null;adapter.dispose();}
    publish();void loadConfig();
    return {setDocument,setPage,viewReady,select,start:()=>run(state.canContinue?"continue":state.hasRun?"retranslate":"start"),cancel,loadConfig,dispose};
  }
  global.BT_PDF_TRANSLATION_SESSION={create};
})(window);
