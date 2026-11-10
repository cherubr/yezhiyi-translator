(function(global) {
  "use strict";
  const E=global.BT_PDF_ERRORS;
  // P6-B 横躺朝向页方向重试：OCR 引擎不做方向检测，版心横躺的扫描页按原位渲染会得到大量短乱码行。
  // 只在「整页识别 + 基线置信低于送翻阈值」时追加顺时针/逆时针 90° 各一次重识，且必须同时满足
  // 「均值达到送翻阈值」与「比基线高出 OCR_RETRY_MARGIN」才采用；区域识别（混排页）、180°
  // 与所有 default-deny 阈值口径完全不变，最坏情况多两次 120 秒有界识别。
  const OCR_RETRY_MARGIN=20,OCR_RETRY_MIN_LINES=3,OCR_RETRY_MIN_CHARS=20;
  /** 行结果质量：字符加权置信均值。行数与算术平均会被横躺乱码（多而短的 45 分行）骗过，必须按字符加权。 */
  function ocrScore(lines) {
    let chars=0,weighted=0;
    for(const line of lines||[]){
      const length=line.text.trim().length;
      if(!length)continue;
      chars+=length; weighted+=length*Math.max(0,Math.min(100,Number(line.confidence)||0));
    }
    return {lines:(lines||[]).length,chars,mean:chars?Math.round(weighted/chars):0};
  }
  /** 位图旋转副本：90 为顺时针、270 为逆时针，输出宽高互换；返回的画布由调用方释放。 */
  function rotateCanvas(source,rotation) {
    const target=document.createElement("canvas");
    target.width=source.height;target.height=source.width;
    const ctx=target.getContext("2d");
    if(rotation===90){ctx.translate(target.width,0);ctx.rotate(Math.PI/2);}
    else{ctx.translate(0,target.height);ctx.rotate(-Math.PI/2);}
    ctx.drawImage(source,0,0);
    return target;
  }
  /**
   * 旋转图像素框 → 原位图像素框，与 rotateCanvas 的前向映射（90: xr=H−y, yr=x；270: xr=y, yr=W−x）严格互逆。
   * 行框换算回原位图后，processOcr 及其下游坐标链路完全不知道发生过旋转。
   */
  function unrotateBox(box,rotation,width,height) {
    return rotation===90
      ? {x0:box.y0, y0:height-box.x1, x1:box.y1, y1:height-box.x0}
      : {x0:width-box.y1, y0:box.x0, x1:width-box.y0, y1:box.x1};
  }

  /** 只管理 PDF 文字任务和三页有界快照，不拥有文件/画布，也不另建网络调度器。 */
  function create({onState,onConfig,onRows}) {
    let documentRef=null,page=1,pageReady=false,context=null,selection=null,revision=0,generation=0;
    let active=null,currentEntry=null,started=false,paused=false,disposed=false,configTask=null;
    // OCR 引擎与结果缓存独立于翻译缓存：身份含文档、页、引擎、模型版本与语言；缩放/旋转/模式切换不重识别。
    let ocr=null;
    const ocrCache=new Map();
    const OCR_SCALE=3,OCR_PIXEL_BUDGET=8000000;
    const ocrProvider=()=>ocr||(ocr=global.BT_PDF_OCR.create());
    // P4-D 稳定性：同文档连续识别失败熔断，避免每页重走「建 Worker→失败」；
    // 完成/中断后闲置 3 分钟释放 Worker 内存，下次识别自动重建。换文档与 dispose 复位。
    let ocrFailures=0,ocrSuspended=false,ocrIdleTimer=null;
    const OCR_IDLE_MS=180000;
    const cancelOcrIdle=()=>{if(ocrIdleTimer){clearTimeout(ocrIdleTimer);ocrIdleTimer=null;}};
    const scheduleOcrIdle=()=>{cancelOcrIdle();ocrIdleTimer=setTimeout(()=>{ocrIdleTimer=null;if(ocr){void ocr.terminate();ocr=null;}},OCR_IDLE_MS);};
    const cache=new Map();
    // P5b 多页准备存储：与三页 LRU 缓存共享条目对象但独立持有引用（LRU 淘汰不影响已准备的页），
    // 总权重上限防止无限攒页；换文档、配置变化与 dispose 一并作废，语义与 cache 同口径。
    const multiStore=new Map();
    const PAGES_BUDGET=32*1024*1024,MAX_PREPARE_PAGES=50;
    let prepareActive=null;
    const cancelPrepare=()=>{if(!prepareActive)return;const a=prepareActive;prepareActive=null;
      try{a.controller.abort(E.cancelled());}catch(_){}adapter.cancel(a.token);};
    // 准备中断只停当前页循环，已入存页保留；基础设施级错误（后台断开、OCR 熔断/缺模型）中止整个准备。
    const PREPARE_FATAL=new Set(["CONNECTION_INTERRUPTED","OCR_SUSPENDED","OCR_MODEL_MISSING"]);
    const state={phase:"idle",message:"读取 PDF 后点击开始翻译",busy:false,configured:false,configReady:false,hasRun:false,canContinue:false};
    const publish=()=>{if(!disposed)onState({...state});};
    const stamp=()=>context&&selection?JSON.stringify([revision,{...selection,to:global.BT_CONST.resolveTargetLanguage(selection.to)}]):"";
    const ocrStamp=()=>{
      const M=global.BT_PDF_OCR_MODELS,resolved=M.resolveLanguages(selection?.from);
      return [M.ENGINE,M.ENGINE_VERSION,M.MODEL_SOURCE,resolved.languages.join("+")||"missing:"+resolved.missing.join("+")].join(":");
    };
    const keyFor=pageNumber=>documentRef?documentRef.id+":"+pageNumber+":"+stamp()+":"+ocrStamp():"";
    const entryKey=()=>keyFor(page);
    // 第三参数为分类与 OCR 元信息（区域坐标与统计，不含文字内容），仅供调试展示。
    const show=(entry,reveal=true)=>{if(!disposed)onRows(entry?entry.blocks.map(block=>({block,result:reveal?entry.results.get(block.id):null})):[],entry&&entry.geometry?entry.geometry:null,entry?{classification:entry.classification||null,ocr:entry.ocr||null}:null);};
    const blocksWeight=entry=>entry.blocks.reduce((n,b)=>n+b.text.length*2+800,0);
    const weight=entry=>blocksWeight(entry)+[...entry.results.values()].reduce((n,r)=>n+(r.text?.length||0)*2+200,0);
    const multiWeight=()=>[...multiStore.values()].reduce((n,entry)=>n+weight(entry),0);
    const usableResults=entry=>[...entry.results.values()].filter(r=>r.status==="translated"||r.status==="unchanged").length;
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
      halt();cancelPrepare();multiStore.clear();cache.clear();currentEntry=null;started=false;paused=false;
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
      halt();cancelPrepare();multiStore.clear();
      documentRef=value;page=1;pageReady=false;cache.clear();ocrCache.clear();currentEntry=null;started=false;paused=false;
      // 换文件/关文件即释放 OCR Worker 并复位熔断与闲置计时；同一文档内跨页复用，翻页不重建。
      ocrFailures=0;ocrSuspended=false;cancelOcrIdle();
      if(ocr){void ocr.terminate();ocr=null;}
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
      show(currentEntry,false);publish();scheduleOcrIdle();
    }
    function finish(entry) {
      const results=[...entry.results.values()],failed=results.filter(r=>r.status==="failed").length;
      const translated=results.filter(r=>r.status==="translated").length,skipped=results.filter(r=>r.status==="skipped").length;
      const missing=entry.blocks.filter(b=>b.eligible&&!entry.results.has(b.id)).length;
      const unchanged=results.filter(r=>r.status==="unchanged").length;
      Object.assign(state,{phase:failed||skipped||missing?"partial":"completed",busy:false,hasRun:true,canContinue:false,
        message:"本页"+(failed||skipped||missing?"部分完成":"翻译完成")+"：已译 "+translated+" 段，未变化 "+unchanged+" 段，保留 "+skipped+" 段，失败 "+failed+" 段，待处理 "+missing+" 段。"+(entry.ocr?.stats?"图片/异常区域识别 "+entry.ocr.regions.length+" 处，替换乱码 "+entry.ocr.stats.replaced+" 段，去重 "+entry.ocr.stats.deduped+" 段。":"")+(entry.ocr?.warnings?.length?"注意："+entry.ocr.warnings.join("；")+"。":"")+"翻页后继续处理当前页。"});
      show(entry);publish();trimCache();scheduleOcrIdle();
    }
    const recognizing=message=>{Object.assign(state,{phase:"recognizing",message});publish();};
    /**
     * 横躺页方向重试（仅整页识别调用）：基线结果呈「行数不少、字符不少但置信明显不足」时才动手，
     * 依次试顺时针 90°、逆时针 90°，第一次达到采用标准即停止，避免同一页三次全跑。
     * 返回 null（未触发）或 {result,rotation,warnings}：result 恒为可继续使用的行结果（采用即校正后、
     * 否则原样为基线），rotation 仅在采用时非 null；采用标准不放宽任何阈值。
     * 重试自身失败只记入警告：基线结果照旧可用，且不计入 OCR 熔断（熔断只统计基线引擎级失败）。
     */
    async function retrySideways(canvas,result,languages,signal,valid,report) {
      const low=global.BT_PDF_BLOCKS.thresholds.ocrLow;
      const base=ocrScore(result?.lines);
      if(base.lines<OCR_RETRY_MIN_LINES||base.chars<OCR_RETRY_MIN_CHARS||base.mean>=low)return null;
      const width=canvas.width,height=canvas.height,tried=[];
      for(const item of [{rotation:90,label:"顺时针 90°"},{rotation:270,label:"逆时针 90°"}]){
        E.check(signal);
        report("本页显示朝向疑似横躺，正在按"+item.label+"校正后重新识别（页面图像不上传）…");
        let target=null;
        try{
          target=rotateCanvas(canvas,item.rotation);
          const candidate=await ocrProvider().recognize({image:target,languages},{signal});
          if(!valid())throw E.cancelled();
          const score=ocrScore(candidate.lines);
          if(score.mean>=low&&score.mean-base.mean>=OCR_RETRY_MARGIN)
            return {rotation:item.rotation,result:{...candidate,lines:candidate.lines.map(line=>
              ({...line,bbox:unrotateBox(line.bbox,item.rotation,width,height)}))},
              warnings:["本页显示朝向横躺，已按"+item.label+"校正后识别（置信 "+base.mean+" → "+score.mean+"）"]};
          tried.push(item.label+"后置信 "+score.mean);
        }catch(error){
          // 取消原样上抛，其余引擎失败放弃本次校正，保留基线结果继续后面的流程。
          if(error?.name==="AbortError"||error?.code==="CANCELLED")throw error;
          tried.push(item.label+"识别失败");
        }finally{
          if(target)target.width=target.height=0;
        }
      }
      return {rotation:null,result,warnings:["本页显示朝向疑似横躺，"+tried.join("、")+"，未达采用标准，保留原识别结果"]};
    }

    /**
     * 页面识别：独立位图（不占用可见画布预算）→ 本机 OCR → 统一文字块；结果按 ocrStamp 缓存复用。
     * plan 为 null 时整页识别（扫描页）；plan.regions 为固定坐标候选区域（混合页），仅识别必要区域。
     * stage 为进度回调：显示页用 recognizing 直写面板，多页准备转发给调用方而不改动显示状态。
     * 返回 {model, regions, warnings, orientation}；regions 携带固定坐标 rect 与位图像素 pixels 供追溯。
     * orientation 为整页识别实际采用的校正角度（null 表示未旋转），并随警告一同写入缓存条目。
     */
    async function recognizePage(currentDocument,currentPage,extracted,signal,valid,plan,stage) {
      const report=stage||recognizing;
      const key=currentDocument.id+":"+currentPage+":"+ocrStamp();
      const cached=ocrCache.get(key);
      if(cached){ocrCache.delete(key);ocrCache.set(key,cached);return cached;}
      if(ocrSuspended)
        throw E.create("OCR_SUSPENDED","OCR 连续失败，已暂停自动识别；请重新打开文档后重试","ocr",false);
      const resolved=global.BT_PDF_OCR_MODELS.resolveLanguages(selection.from);
      if(resolved.missing.length)
        throw E.create("OCR_MODEL_MISSING","所选原文语言暂不支持 OCR 识别（"+
          resolved.missing.map(code=>global.BT_PDF_OCR_MODELS.label(code)).join("、")+
          "）；请改用自动检测或受支持的语言","ocr",false);
      // 未安装模型在渲染位图前早失败，避免整页白渲染；provider 识别时还会做同一校验。
      const unavailable=await global.BT_PDF_OCR_MODEL_STORE.missing(resolved.languages);
      if(!valid())throw E.cancelled();
      if(unavailable.length)
        throw E.create("OCR_MODEL_MISSING","语言模型未安装："+unavailable.map(code=>global.BT_PDF_OCR_MODELS.label(code)).join("、")+
          "；请在「OCR 语言模型」中下载，或改用自动检测","ocr",false);
      cancelOcrIdle();
      report("正在渲染识别位图…");
      const canvas=document.createElement("canvas");
      let handle=null;
      try{
        handle=currentDocument.renderPage({pageNumber:currentPage,scale:OCR_SCALE,viewRotation:0,canvas,pixelBudget:OCR_PIXEL_BUDGET},{signal});
        const info=await handle.promise;
        if(!valid())throw E.cancelled();
        const BM=global.BT_PDF_BLOCKS.matrix,k=canvas.width/info.width;
        // 固定坐标 → 位图像素：VT_1⁻¹ 回到用户空间，再经 scale 渲染视口与画布像素比放大。
        const toPixel=BM.compose([k,0,0,k,0,0],BM.compose(info.viewportTransform,BM.invert(extracted.transform)));
        const regional=!!(plan&&plan.regions&&plan.regions.length);
        const sources=regional?plan.regions:
          [{type:"page",reason:"整页扫描识别",rect:{x:0,y:0,right:extracted.width,bottom:extracted.height}}];
        const pixelRegions=[];
        for(const source of sources){
          const a=BM.apply(toPixel,source.rect.x,source.rect.y),b=BM.apply(toPixel,source.rect.right,source.rect.bottom);
          if(!Number.isFinite(a[0]+a[1]+b[0]+b[1]))continue;
          const left=Math.max(0,Math.floor(Math.min(a[0],b[0]))),top=Math.max(0,Math.floor(Math.min(a[1],b[1])));
          const right=Math.min(canvas.width,Math.ceil(Math.max(a[0],b[0]))),bottom=Math.min(canvas.height,Math.ceil(Math.max(a[1],b[1])));
          if(right-left<8||bottom-top<8)continue;
          pixelRegions.push({type:source.type,reason:source.reason,rect:source.rect,pixels:{left,top,width:right-left,height:bottom-top}});
        }
        let result;
        // 熔断计数只统计引擎级失败（不可用/超时）；取消、缺模型与完整性错误不计入。
        try{
          if(regional){
            report("正在进行本机 OCR 区域识别（页面图像不上传）…");
            // 候选区域在位图上全部过小时跳过识别，返回空结果，不误入整页识别。
            result=pixelRegions.length
              ?await ocrProvider().recognize({image:canvas,languages:resolved.languages,
                regions:pixelRegions.map(region=>region.pixels),
                onProgress:({done,total})=>{report("正在进行本机 OCR 区域识别："+done+" / "+total+"（页面图像不上传）…");}},{signal})
              :{lines:[]};
          }else{
            report("正在进行本机 OCR 识别（页面图像不上传）…");
            result=await ocrProvider().recognize({image:canvas,languages:resolved.languages},{signal});
          }
          ocrFailures=0;
        }catch(error){
          if(error?.code==="OCR_UNAVAILABLE"||error?.code==="OCR_TIMEOUT"){ocrFailures++;if(ocrFailures>=2)ocrSuspended=true;}
          throw error;
        }
        if(!valid())throw E.cancelled();
        // P6-B 整页识别的横躺校正：区域识别（混排页）与达标页面在此完全不动。
        const sideways=regional?null:await retrySideways(canvas,result,resolved.languages,signal,valid,report);
        const model=global.BT_PDF_BLOCKS.processOcr({pageNumber:currentPage,width:extracted.width,height:extracted.height,
          result:sideways?sideways.result:result,
          bitmap:{viewportTransform:info.viewportTransform,pageTransform:extracted.transform,pixelScale:k}});
        const value={model,regions:pixelRegions,warnings:[...(plan?.warnings||[]),...(sideways?sideways.warnings:[])],
          orientation:sideways?.rotation??null};
        ocrCache.set(key,value);
        while(ocrCache.size>5)ocrCache.delete(ocrCache.keys().next().value);
        return value;
      }finally{
        handle?.dispose();
        canvas.width=canvas.height=0;
      }
    }
    /**
     * 逐页流水线：提取 → 重组 → 分类 →（必要时）本机 OCR → 缓存条目。
     * 显示页与多页准备共用本函数，保证两条路径的分类、OCR 与 default-deny 口径完全一致。
     * 每个 await 之后校验 valid()，过期即抛出取消（调用方按 valid 静默返回），绝不写入过期缓存。
     * key 由调用方在进入时捕获并传入：Prepare 期间翻页不改 key 口径，显示页翻页则整轮作废。
     */
    async function buildEntry(pageNumber,currentDocument,{signal,valid,stage,key}) {
      const cached=cache.get(key);
      if(cached){cache.delete(key);cache.set(key,cached);return {entry:cached,cached:true};}
      const extracted=await currentDocument.extractPage(pageNumber,{signal});
      if(!valid())throw E.cancelled();
      const model=global.BT_PDF_BLOCKS.process(extracted);
      if(model.blocks.length>2000)throw E.create("TEXT_BUDGET","本页文本块过多，暂不自动翻译","extract",false);
      const probe=await currentDocument.probePageContent(pageNumber,{signal});
      if(!valid())throw E.cancelled();
      const classification=global.BT_PDF_BLOCKS.classifyPage(model,probe);
      let blocks=model.blocks,ocrInfo=null;
      if(classification.type==="scanned"){
        const recognized=await recognizePage(currentDocument,pageNumber,extracted,signal,valid,null,stage);
        if(!valid())throw E.cancelled();
        blocks=recognized.model.blocks;
        ocrInfo={engine:recognized.model.engine,engineVersion:recognized.model.engineVersion,modelVersion:recognized.model.modelVersion,
          regions:recognized.regions.map(({type,reason,rect})=>({type,reason,rect})),stats:null,orientation:recognized.orientation,
          warnings:recognized.warnings};
      }else if(classification.type==="mixed"){
        // P4-C 混合页：仅当规划出候选区域时执行区域 OCR；无候选（隐藏文字层齐全等）保持原生路径。
        const plan=global.BT_PDF_BLOCKS.planOCR(model,probe);
        if(plan.regions.length){
          const recognized=await recognizePage(currentDocument,pageNumber,extracted,signal,valid,plan,stage);
          if(!valid())throw E.cancelled();
          const merged=global.BT_PDF_BLOCKS.merge(model,recognized.model);
          blocks=merged.blocks;
          ocrInfo={engine:merged.engine,engineVersion:merged.engineVersion,modelVersion:merged.modelVersion,
            regions:recognized.regions.map(({type,reason,rect})=>({type,reason,rect})),stats:merged.stats,warnings:recognized.warnings};
        }
      }
      // geometry 为固定坐标基准（scale=1、固有旋转），供显示层与导出换算矩阵；不参与缓存权重与 key。
      const entry={blocks,results:new Map(),empty:!blocks.length,classification,ocr:ocrInfo,
        geometry:{pageNumber:extracted.pageNumber,width:extracted.width,height:extracted.height,transform:extracted.transform}};
      cache.set(key,entry);
      return {entry,cached:false};
    }
    /** 结果初始化：不可译块保留原因、同语言整段记为未变化、纯保护或无字母段不送翻（对已有译文幂等）。 */
    function initResults(entry) {
      for(const block of entry.blocks){
        if(!block.eligible)entry.results.set(block.id,{status:"skipped",reason:block.reason});
        else if(selection.from!=="auto"&&selection.from===global.BT_CONST.resolveTargetLanguage(selection.to))entry.results.set(block.id,{status:"unchanged",text:block.text});
        else if(block.segments.every(part=>part.protected||!/[\p{L}]/u.test(part.text)))entry.results.set(block.id,{status:"skipped",reason:"保留代码或标识符"});
      }
    }
    /**
     * 逐块翻译：批次绑定 + 等待页面可见 + 错误分级，显示路径与多页准备同一口径。
     * 返回 {done:false} 表示本轮已过期（调用方静默返回）；内容级失败记入结果后继续，服务级失败抛出。
     */
    async function translateBlocks(entry,{token,config,mode,signal,valid,onBlock,onProgress}) {
      const todo=entry.blocks.filter(b=>b.eligible&&(!entry.results.has(b.id)||(mode!=="auto"&&entry.results.get(b.id).status==="failed")));
      if(!todo.length)return {done:true,empty:true};
      await adapter.bind(token,context.revision);
      if(!valid())return {done:false};
      for(const block of todo){
        await adapter.whenVisible(signal);
        if(!valid())return {done:false};
        onProgress();
        try{
          const text=await adapter.translate(block,config,{token,signal,manual:mode!=="auto"&&mode!=="start",refreshCache:mode==="retranslate"});
          if(!valid())return {done:false};
          if(text.length>200000||weight(entry)+text.length*2>4*1024*1024)throw E.create("RESULT_BUDGET","译文超过本页结果预算","translate",false);
          entry.results.set(block.id,{status:text.trim()===block.text.trim()?"unchanged":"translated",text});
        }catch(error){
          if(!valid())return {done:false};
          if(error.code==="CONNECTION_INTERRUPTED"||error.name==="AbortError"||error.code==="CANCELLED")throw error;
          entry.results.set(block.id,{status:"failed",reason:String(error.message||"翻译失败").slice(0,500),code:error.code});
          onBlock();
          // 内容级失败（保护标记校验、标记超预算、结果超预算）是确定性的块级问题，服务本身健康：
          // 不中断整页，继续翻译其余块；失败块仅保留原因，不插入译文。
          if(error.code==="PROTECTED_CONTENT_CHANGED"||error.code==="PROTECTED_TOKEN_TOO_LONG"||error.code==="RESULT_BUDGET")continue;
          // 其余失败后台已执行有界重试；停止继续消费本页额度，用户可明确继续。
          throw error;
        }
        onBlock();
      }
      return {done:true,empty:false};
    }
    async function run(mode="start") {
      if(disposed||!documentRef||!pageReady||active)return;
      const currentDocument=documentRef,currentPage=page,requestedGeneration=generation;
      // 手动操作刷新后台配置/连接，自动翻页使用已确认的同一配置快照。
      if(mode!=="auto"||!context)await loadConfig();
      if(disposed||requestedGeneration!==generation||documentRef!==currentDocument||page!==currentPage||!pageReady||active||!context||!state.configured)return;
      // 显示页优先于多页准备：用户开始/继续本页翻译即中断准备循环，已备好的页保留在存储中。
      if(prepareActive)cancelPrepare();
      halt();started=true;paused=false;
      const controller=new AbortController(),token="pdf:"+crypto.randomUUID(),version=generation,key=entryKey(),configStamp=stamp();
      active={controller,token};
      const valid=()=>!disposed&&!controller.signal.aborted&&generation===version&&documentRef===currentDocument&&page===currentPage&&stamp()===configStamp;
      Object.assign(state,{busy:true,hasRun:true,canContinue:false,phase:"extracting",message:"正在提取并重组本页文字…"});publish();
      let entry=null;
      try{
        const built=await buildEntry(currentPage,currentDocument,{signal:controller.signal,valid,key});
        entry=built.entry;
        if(!valid())return;
        currentEntry=entry;
        if(mode==="retranslate")entry.results.clear();
        initResults(entry);
        show(entry);trimCache();
        if(entry.empty||!entry.blocks.some(b=>b.eligible)){
          const type=entry.classification?.type;
          Object.assign(state,{phase:"no-text",busy:false,message:entry.empty
            ?(type==="blank"?"本页没有可识别内容（空白页），未发送翻译请求"
              :type==="scanned"?"OCR 未识别到本页文字，可能为纯图片装饰页；未发送翻译请求"
              :"本页没有可靠文字层，未发送翻译请求")
            :(type==="scanned"?"本页 OCR 识别文字置信度过低或为代码、公式，未自动送翻"
              :type==="mixed"?"本页没有可自动翻译的可靠正文；代码、公式或异常文字已保留，图片区域未识别到可翻译文字"
              :"本页没有可自动翻译的可靠正文；代码、公式或异常文字已保留。")});publish();scheduleOcrIdle();return;
        }
        const config={...selection,to:global.BT_CONST.resolveTargetLanguage(selection.to)};
        const result=await translateBlocks(entry,{token,config,mode,signal:controller.signal,valid,
          onBlock(){show(entry);trimCache();},
          onProgress(){Object.assign(state,{phase:"translating",message:"正在翻译：已处理 "+entry.results.size+" / "+entry.blocks.length+" 段；等待服务响应…"});publish();}});
        if(!result.done)return;
        finish(entry);
      }catch(error){
        if(!valid())return;
        paused=true;
        Object.assign(state,{phase:"interrupted",busy:false,canContinue:true,
          message:(error.code==="CONNECTION_INTERRUPTED"?error.message:error.name==="AbortError"?"翻译任务已取消或后台配置变化，请确认后继续":error.message||"本页处理失败")+"；已保留成功结果"});
        show(entry);publish();scheduleOcrIdle();
      }finally{
        adapter.cancel(token);
        if(active?.token===token){active=null;state.busy=false;publish();}
      }
    }
    /** 冻结条目为导出快照：structuredClone 之后与翻译状态、缓存淘汰完全解耦。 */
    function snapshotOf(entry,pageNumber) {
      return structuredClone({
        identity:{documentId:documentRef.id,numPages:documentRef.numPages,page:pageNumber,
          to:global.BT_CONST.resolveTargetLanguage(selection.to)},
        blocks:entry.blocks,results:[...entry.results],geometry:entry.geometry,
        classification:entry.classification||null,ocr:entry.ocr||null});
    }
    /**
     * P5-B 导出快照：冻结当前显示页的缓存条目；无条目（未翻译/已失效）返回 null。
     * results 以 [blockId, result] 条目数组发出，供结构化克隆 postMessage 到导出 Worker。
     */
    function exportSnapshot() {
      if(!documentRef||!currentEntry)return null;
      return snapshotOf(currentEntry,page);
    }
    /** P5b：按页码批量取快照，查找口径与 pageStatus 完全一致（多页存储优先，其次当前配置下的显示缓存）。
     *  未准备的页返回 null 项，由导出侧再校验并拒绝，不做静默补译。 */
    function exportSnapshots(pages) {
      if(!documentRef||!selection)return pages.map(()=>null);
      return pages.map(pageNumber=>{
        const entry=multiStore.get(pageNumber)||cache.get(keyFor(pageNumber));
        return entry?snapshotOf(entry,pageNumber):null;
      });
    }
    /**
     * P5b 导出身份指纹：与快照查找键同源（文档、页数、配置代次、OCR 口径），不含当前页码——
     * 翻页只改屏幕，不该作废一次已经冻结的多页导出；其余任何变化都会让缓存条目查不到，必须重来。
     */
    function exportStamp() {
      if(!documentRef||!selection||!stamp())return null;
      return documentRef.id+":"+documentRef.numPages+":"+stamp()+":"+ocrStamp();
    }
    /**
     * 页面可用度：pending = 可靠段中仍无结果或仍失败的段落，partial 表示已有可用译文但未全量完成。
     * no-text 不算缺失（无可靠正文可译，导出按原文照录）；missing 表示没有可用结果，需重新准备。
     */
    function describePage(pageNumber,entry) {
      if(!entry)return {page:pageNumber,state:"missing",usable:0,eligible:0,failed:0,pending:0,classification:null};
      const classification=entry.classification?.type||null,usable=usableResults(entry);
      const eligible=entry.blocks.filter(b=>b.eligible);
      if(entry.empty||!eligible.length)return {page:pageNumber,state:"no-text",usable:0,eligible:0,failed:0,pending:0,classification};
      let failed=0,pending=0;
      for(const block of eligible){
        const result=entry.results.get(block.id);
        if(!result)pending++;
        else if(result.status==="failed"){failed++;pending++;}
      }
      return {page:pageNumber,state:usable?(pending?"partial":"ready"):"missing",usable,eligible:eligible.length,failed,pending,classification};
    }
    /** 逐页状态：优先取多页存储，其次取当前配置下的显示缓存（同一 key 口径，绝不跨配置复用）。 */
    function pageStatus(pages) {
      return pages.map(pageNumber=>describePage(pageNumber,multiStore.get(pageNumber)||cache.get(keyFor(pageNumber))||null));
    }
    /**
     * P5b 多页准备：按页码顺序无头执行「提取→分类→OCR→翻译」，完成的页写入 multiStore 供批量导出。
     * 不改动显示状态（不写 state、不调 adapter.setPage、不重绘阅读页），翻页与阅读照常进行。
     * 取消语义：调用方 signal 取消只停循环，已入存页与已花额度结果保留；后台断开、OCR 熔断/缺模型终止整轮；
     * 单页业务失败记录后继续下一页。预算：入存前按块数估算预检（不消耗额度），超预算则停止并回报剩余页。
     */
    async function preparePages(pages,{signal,onProgress}={}) {
      if(disposed||!documentRef)throw E.create("READ_FAILED","当前没有可准备的文档，请先读取 PDF","prepare",false);
      if(active)throw E.create("PDF_BUSY","本页正在翻译，请先取消或等待完成后再准备","prepare",false);
      if(prepareActive)throw E.create("PDF_BUSY","已有页面准备任务在进行，请等待完成或先取消","prepare",false);
      const list=[...new Set(Array.isArray(pages)?pages:[])].filter(n=>Number.isInteger(n)&&n>=1&&n<=documentRef.numPages).sort((a,b)=>a-b);
      if(!list.length)throw E.create("PDF_BUSY","没有有效的页码可准备","prepare",false);
      if(list.length>MAX_PREPARE_PAGES)throw E.create("TEXT_BUDGET","一次最多准备 "+MAX_PREPARE_PAGES+" 页，请缩小页码范围","prepare",false);
      // 沿用当前配置快照；未确认（或后台刚断开）时先读取，与显示页走同一条配置路径。
      if(!context||!state.configured)await loadConfig();
      if(disposed||!context||!state.configured)throw E.create("PDF_CONTEXT_ERROR","无法读取翻译配置，请确认翻译设置后重试","prepare",false);
      const currentDocument=documentRef,configStamp=stamp(),ocrVersion=ocrStamp(),revisionAt=revision;
      // 批次令牌必须落在后台 BIND_BATCH 的 /^pdf:/ 白名单内，否则整轮准备被拒。
      const controller=new AbortController(),token="pdf:"+crypto.randomUUID();
      const aborted=()=>controller.signal.aborted||!!signal?.aborted;
      // 有意不含 generation：翻页不影响准备；换文档、改配置/目标语言/OCR 语言与 dispose 才使本轮过期。
      const valid=()=>!disposed&&!aborted()&&revision===revisionAt&&documentRef===currentDocument&&
        stamp()===configStamp&&ocrStamp()===ocrVersion;
      const abortFromCaller=()=>{try{controller.abort(signal?.reason||E.cancelled());}catch(_){}};
      signal?.addEventListener("abort",abortFromCaller,{once:true});
      prepareActive={controller,token};
      const summary={done:[],failed:[],stopped:null,remaining:[],prepared:0};
      const config={...selection,to:global.BT_CONST.resolveTargetLanguage(selection.to)};
      // 中断/终止时仍保留本轮已花额度得到的译文，避免重复消耗额度（导出侧按可用结果统计）。
      const keep=(pageNumber,entry)=>{if(entry&&usableResults(entry))multiStore.set(pageNumber,entry);};
      try{
        for(const pageNumber of list){
          if(!valid()){summary.stopped={reason:aborted()?"cancelled":"interrupted",page:pageNumber};break;}
          let entry=null;
          try{
            onProgress?.({page:pageNumber,stage:"extracting"});
            const built=await buildEntry(pageNumber,currentDocument,{signal:controller.signal,valid,key:keyFor(pageNumber),
              stage:message=>onProgress?.({page:pageNumber,stage:"recognizing",message})});
            entry=built.entry;
            if(!valid())throw E.cancelled();
            initResults(entry);
            const eligible=entry.blocks.filter(b=>b.eligible).length;
            if(eligible&&multiWeight()+2*blocksWeight(entry)>PAGES_BUDGET){
              summary.stopped={reason:"budget",page:pageNumber};break;
            }
            if(eligible&&!entry.empty){
              const result=await translateBlocks(entry,{token,config,mode:"start",signal:controller.signal,valid,
                onBlock(){},
                onProgress(){onProgress?.({page:pageNumber,stage:"translating",done:entry.results.size,total:entry.blocks.length});}});
              if(!result.done)throw E.cancelled();
            }
            multiStore.set(pageNumber,entry);
            summary.done.push(describePage(pageNumber,entry));
            // 事后校验：本页额度已花，入存后超预算只停后续页，不丢弃已完成结果。
            if(multiWeight()>PAGES_BUDGET){summary.stopped={reason:"budget",page:pageNumber};break;}
          }catch(error){
            const code=error?.code||(error?.name==="AbortError"?"CANCELLED":null);
            if(code==="CANCELLED"||!valid()){
              keep(pageNumber,entry);
              summary.stopped={reason:aborted()?"cancelled":"interrupted",page:pageNumber};break;
            }
            if(PREPARE_FATAL.has(code)){
              keep(pageNumber,entry);
              summary.stopped={reason:"fatal",page:pageNumber,code,message:String(error.message||"准备已中断").slice(0,300)};break;
            }
            // 单页失败（服务确定性问题、本页超块数/结果预算）不阻断其余页；本轮已花额度得到的结果仍入存，
            // 该页记入 failed 供界面提示，再次准备只补缺失段（todo 口径与显示页续译完全一致）。
            keep(pageNumber,entry);
            const described=describePage(pageNumber,multiStore.get(pageNumber)||entry);
            summary.failed.push({page:pageNumber,code:code||"PREPARE_FAILED",state:described.state,
              usable:described.usable,pending:described.pending,message:String(error?.message||"本页准备失败").slice(0,300)});
          }
        }
        const visited=new Set([...summary.done,...summary.failed].map(item=>item.page));
        // 中断前已入存的部分页不计入 remaining：导出侧按 pageStatus 如实统计可用译文。
        summary.remaining=list.filter(n=>!visited.has(n)&&!multiStore.has(n));
        summary.prepared=multiStore.size;
        summary.weight=multiWeight();
        return summary;
      }finally{
        signal?.removeEventListener("abort",abortFromCaller);
        adapter.cancel(token);
        if(prepareActive&&prepareActive.controller===controller)prepareActive=null;
        trimCache();scheduleOcrIdle();
      }
    }
    function dispose(){
      disposed=true;halt();cancelPrepare();multiStore.clear();
      cancelOcrIdle();cache.clear();ocrCache.clear();currentEntry=null;documentRef=null;adapter.dispose();if(ocr){void ocr.terminate();ocr=null;}
    }
    publish();void loadConfig();
    return {setDocument,setPage,viewReady,select,start:()=>run(state.canContinue?"continue":state.hasRun?"retranslate":"start"),cancel,loadConfig,
      exportSnapshot,exportSnapshots,exportStamp,pageStatus,preparePages,cancelPrepare,
      limits:{maxPages:MAX_PREPARE_PAGES,pageBudget:PAGES_BUDGET},dispose};
  }
  global.BT_PDF_TRANSLATION_SESSION={create};
})(window);
