(function(global) {
  "use strict";
  const E = global.BT_PDF_ERRORS;
  const VENDOR_BASE = "pdf/vendor/";
  const WORKER_FILE = "pdf/vendor/build/pdf.worker.mjs";
  const MODULE_FILE = "pdf/vendor/build/pdf.mjs";
  const VERSION = "6.5.438";
  /** 每次文件实例持有独立 Worker；显式提供 port，禁止库自动切换主线程假 Worker。 */
  function createReader() {
    let documentProxy = null, loadingTask = null, nativeWorker = null, pdfWorker = null, pdfjsModule = null;
    let closed = false, closing = null, active = null, workerFailure = null, workerFailurePromise = null;
    const resource = path => chrome.runtime.getURL(VENDOR_BASE + path);
    async function open(bytes, {signal, onPassword}) {
      const setup = async () => {
        const pdfjs = await import(chrome.runtime.getURL(MODULE_FILE));
        E.check(signal);
        if (closed) throw E.cancelled();
        if (pdfjs.version !== VERSION) throw E.create("DEPENDENCY_ERROR", "PDF 引擎资源版本不一致", "parse", false);
        pdfjsModule = pdfjs;
        pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL(WORKER_FILE);
        nativeWorker = new Worker(chrome.runtime.getURL(WORKER_FILE), {type: "module", name: "yezhiyi-pdf"});
        workerFailurePromise = new Promise((_, reject) => {
          workerFailure = () => reject(E.create("WORKER_FAILED", "PDF Worker 无法加载，请重新加载扩展后重试", "parse"));
          nativeWorker.addEventListener("error", workerFailure, {once: true});
        });
        pdfWorker = new pdfjs.PDFWorker({port: nativeWorker, verbosity: pdfjs.VerbosityLevel.ERRORS});
        loadingTask = pdfjs.getDocument({data: bytes, worker: pdfWorker,
          cMapUrl: resource("cmaps/"), cMapPacked: true,
          standardFontDataUrl: resource("standard_fonts/"), iccUrl: resource("iccs/"), wasmUrl: resource("wasm/"),
          useWorkerFetch: false, isEvalSupported: false, enableXfa: false,
          stopAtErrors: true, canvasMaxAreaInBytes: 32000000,
          verbosity: pdfjs.VerbosityLevel.ERRORS});
        let rejectPassword;
        const passwordFailure = new Promise((_, reject) => { rejectPassword = reject; });
        loadingTask.onPassword = (updatePassword, reason) => {
          Promise.resolve().then(() => onPassword(reason, signal)).then(password => {
            if (closed || signal?.aborted) return;
            if (password === null) { rejectPassword(E.cancelled()); return; }
            updatePassword(password);
          }).catch(rejectPassword);
        };
        const doc = await Promise.race([loadingTask.promise, workerFailurePromise, passwordFailure]);
        E.check(signal);
        if (closed) throw E.cancelled();
        documentProxy = doc;
        return {numPages: doc.numPages};
      };
      try { return await E.wait(setup(), {signal, stage: "parse", onCancel: close}); }
      catch (error) { await close(); throw E.normalize(error, "parse"); }
    }
    /** 调用者串行等待旧句柄结束；取消时 getPage 的迟到结果不得启动 render。 */
    function renderPage({pageNumber, scale, viewRotation, canvas, pixelBudget}, {signal, thumbnail = false}) {
      let cancelled = false, renderTask = null, page = null, settled = false;
      const cancel = () => { cancelled = true; renderTask?.cancel(); };
      const dispose = () => {
        if (!settled) return;
        page?.cleanup(); page = null;
      };
      const work = async () => {
        if (closed || !documentProxy) throw E.cancelled();
        page = await Promise.race([documentProxy.getPage(pageNumber), workerFailurePromise]);
        E.check(signal);
        if (cancelled || closed) throw E.cancelled();
        const rotation = (page.rotate + viewRotation) % 360;
        if (thumbnail) {
          const size = page.getViewport({scale:1, rotation});
          scale = Math.min(128 / size.width, 172 / size.height);
        }
        const viewport = page.getViewport({scale, rotation});
        if (!Number.isFinite(viewport.width * viewport.height) || viewport.width <= 0 || viewport.height <= 0)
          throw E.create("RENDER_FAILED", "本页尺寸无效", "render");
        // 预算包括仍可见的旧页；设备像素比只影响分辨率，不修改逻辑页大小。
        const outputScale = Math.min(global.devicePixelRatio || 1, Math.sqrt(pixelBudget / (viewport.width * viewport.height)), 16384 / viewport.width, 16384 / viewport.height);
        canvas.width = Math.max(1, Math.floor(viewport.width * outputScale));
        canvas.height = Math.max(1, Math.floor(viewport.height * outputScale));
        canvas.style.width = viewport.width + "px"; canvas.style.height = viewport.height + "px";
        // willReadFrequently：P3-C 像素证据采样会对本页画布逐块 getImageData，软件回读更快且避免 GPU 停顿。
        const context = canvas.getContext("2d", {alpha: false, willReadFrequently: true});
        if (!context) throw E.create("RENDER_FAILED", "浏览器无法创建页面画布", "render");
        renderTask = page.render({canvasContext: context, viewport,
          transform: [outputScale, 0, 0, outputScale, 0, 0], background: "rgb(255,255,255)"});
        await Promise.race([renderTask.promise, workerFailurePromise]);
        E.check(signal);
        if (cancelled || closed) throw E.cancelled();
        return {width: viewport.width, height: viewport.height, viewportTransform: [...viewport.transform],
          intrinsicRotation: page.rotate, reduced: outputScale + 0.01 < (global.devicePixelRatio || 1)};
      };
      // 先登记句柄，再由 microtask 启动，便于换文件立即取消。
      const handle = {cancel, dispose, promise: null};
      handle.promise = E.wait(Promise.resolve().then(work).finally(() => { settled = true; dispose(); }),
        {signal, stage: "render", onCancel: error => { cancel(); if (!thumbnail && error.code === "TIMEOUT") void close(); }})
        .finally(() => { if (active === handle) active = null; });
      if (!thumbnail) active = handle;
      return handle;
    }
    function renderThumbnail({pageNumber, viewRotation, canvas}, {signal}) {
      return renderPage({pageNumber, viewRotation, canvas, scale:1, pixelBudget:100000}, {signal, thumbnail:true});
    }
    /** 公开文字 API；独立于缩放/视图旋转，返回固有页面坐标与 PDF 逻辑字符串。 */
    async function extractPage(pageNumber, {signal}) {
      let streamReader=null,retired=false;
      const cancel=()=>{retired=true;if(streamReader)void streamReader.cancel().catch(()=>{});};
      const work = async () => {
        E.check(signal);
        if (closed || !documentProxy) throw E.cancelled();
        const page = await Promise.race([documentProxy.getPage(pageNumber), workerFailurePromise]);
        E.check(signal);
        if(retired)throw E.cancelled();
        streamReader=page.streamTextContent({includeMarkedContent:true}).getReader();
        const content={items:[],styles:Object.create(null)},marked=[];let characters=0,markers=0;
        try{
          while(true){
            const {value,done}=await Promise.race([streamReader.read(),workerFailurePromise]);
            E.check(signal);if(retired||closed)throw E.cancelled();if(done)break;
            for(const item of value.items){
              // 标记事件不占 textItem 索引，既有人工修订的来源锚点保持稳定。
              if(item.type){
                if(++markers>24000||marked.length>128)throw E.create("TEXT_BUDGET","本页结构标记过多","extract",false);
                if(item.type==="beginMarkedContentProps"||item.type==="beginMarkedContent")marked.push(item.id||null);
                else if(item.type==="endMarkedContent")marked.pop();
                continue;
              }
              characters+=typeof item.str==="string"?item.str.length:0;
              if(content.items.length>=12000||characters>200000)throw E.create("TEXT_BUDGET","本页文字量过大，暂不自动翻译","extract",false);
              content.items.push({...item,markedIds:marked.filter(Boolean)});
            }
            Object.assign(content.styles,value.styles);
          }
          // 标签是可选证据，不替代原生字框；损坏或缺失的标签退回几何结构路径。
          let structure=null;
          if(typeof page.getStructTree==="function"){
            try{
              const tree=await Promise.race([page.getStructTree(),workerFailurePromise]);
              E.check(signal);if(retired||closed)throw E.cancelled();
              const tags=[];let visited=0,complete=true;
              const walk=(node,owner=null,path="0",depth=0)=>{
                if(!node)return;
                if(++visited>24000||depth>64){complete=false;return;}
                const role=typeof node.role==="string"?node.role:"";
                const semantic=/^(?:H[1-6]?|P|L|LI|Table|TR|TH|TD|Figure|Formula|Code|Note|Caption)$/u.test(role)?{role,group:path}:owner;
                if(node.type==="content"&&typeof node.id==="string"&&semantic)tags.push({id:node.id,...semantic});
                for(let i=0;i<(node.children?.length||0)&&visited<=24000;i++)walk(node.children[i],semantic,path+"."+i,depth+1);
              };
              walk(tree);structure={version:1,tags:complete?tags:[],complete};
            }catch(failure){E.check(signal);if(retired||closed)throw E.cancelled();structure={version:1,tags:[],complete:false};}
          }
          const viewport=page.getViewport({scale:1,rotation:page.rotate});
          return {pageNumber,width:viewport.width,height:viewport.height,transform:[...viewport.transform],items:content.items,styles:content.styles,structure};
        }finally{
          void streamReader.cancel().catch(()=>{});
          try{streamReader.releaseLock();}catch(_){}
        }
      };
      return E.wait(work(), {signal,stage:"extract",onCancel:cancel});
    }
    /**
     * 轻量内容探针：统计算子类别数量供页面分类；同时按 save/restore/transform 追踪 CTM，
     * 把图片与矢量包围盒映射到与 extractPage 相同的固定坐标系（VT_1）供区域规划使用。
     * 掩膜与图片组算子只计数不采集矩形；计数语义与 P4-B 完全一致。
     */
    async function probePageContent(pageNumber, {signal}) {
      let retired=false;
      const work=async()=>{
        E.check(signal);
        if(closed||!documentProxy||!pdfjsModule)throw E.cancelled();
        const page=await Promise.race([documentProxy.getPage(pageNumber),workerFailurePromise]);
        E.check(signal);
        if(retired)throw E.cancelled();
        const list=await Promise.race([page.getOperatorList(),workerFailurePromise]);
        E.check(signal);
        if(retired||closed)throw E.cancelled();
        const OPS=pdfjsModule.OPS;
        const imageOps=new Set([OPS.paintImageXObject,OPS.paintInlineImageXObject,OPS.paintJpegXObject,
          OPS.paintImageMaskXObject,OPS.paintImageMaskXObjectGroup,OPS.paintImageMaskXObjectRepeat,OPS.paintInlineImageXObjectGroup].filter(fn=>fn!==undefined));
        const textOps=new Set([OPS.showText,OPS.showSpacedText,OPS.nextLineShowText,OPS.nextLineSetSpacingShowText].filter(fn=>fn!==undefined));
        const vt=page.getViewport({scale:1,rotation:page.rotate}).transform;
        const compose=(a,b)=>[a[0]*b[0]+a[2]*b[1],a[1]*b[0]+a[3]*b[1],a[0]*b[2]+a[2]*b[3],a[1]*b[2]+a[3]*b[3],a[0]*b[4]+a[2]*b[5]+a[4],a[1]*b[4]+a[3]*b[5]+a[5]];
        const apply=(m,x,y)=>[m[0]*x+m[2]*y+m[4],m[1]*x+m[3]*y+m[5]];
        const bbox=(m,points)=>{
          let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;
          for(const [x,y] of points){
            const p=apply(m,x,y);
            if(!Number.isFinite(p[0])||!Number.isFinite(p[1]))return null;
            x0=Math.min(x0,p[0]);y0=Math.min(y0,p[1]);x1=Math.max(x1,p[0]);y1=Math.max(y1,p[1]);
          }
          return x1>x0&&y1>y0?{x:x0,y:y0,right:x1,bottom:y1}:null;
        };
        const unitCorners=[[0,0],[1,0],[0,1],[1,1]];
        let imageCount=0,showText=0;
        const images=[],vectorRects=[],rules=[];
        let ctm=[1,0,0,1,0,0];const stack=[];
        let pathBudget=120000;
        // 本地 PDF.js 的 constructPath 使用 DrawOPS 压缩路径；一个路径也可能包含整张表格。
        // 仅解析受支持的命令并收集直线，曲线不作为网格；格式未知时保留包围盒回退。
        const straightRules=(matrix,data)=>{
          if(!(Array.isArray(data)||ArrayBuffer.isView(data))||data.length>pathBudget)return;
          pathBudget-=data.length;
          const arity={0:2,1:2,2:6,3:4,4:0},segments=[];let point=null,start=null;
          for(let i=0;i<data.length;){
            const command=data[i++],count=arity[command];
            if(count===undefined||i+count>data.length)return;
            const coords=Array.from(data.slice(i,i+count));i+=count;if(!coords.every(Number.isFinite))return;
            if(command===0){point=coords;start=coords;}
            else if(command===1){if(point)segments.push([point,coords]);point=coords;}
            else if(command===4){if(point&&start)segments.push([point,start]);point=start;}
            else point=coords.slice(-2);
          }
          for(const [a,b] of segments){
            if(rules.length>=2000)break;
            const p=apply(matrix,...a),q=apply(matrix,...b);if(![...p,...q].every(Number.isFinite))continue;
            rules.push({x:Math.min(p[0],q[0]),y:Math.min(p[1],q[1]),right:Math.max(p[0],q[0]),bottom:Math.max(p[1],q[1])});
          }
        };
        for(let i=0;i<list.fnArray.length;i++){
          const fn=list.fnArray[i],args=list.argsArray[i];
          if(imageOps.has(fn))imageCount++;
          else if(textOps.has(fn))showText++;
          if(fn===OPS.save)stack.push(ctm.slice());
          else if(fn===OPS.restore){if(stack.length)ctm=stack.pop();}
          // Form XObject 的内联算子与外层共用同一 operatorList，其 /Matrix 只随 paintFormXObjectBegin 下发
          // （Float32Array，非 Array），渲染端用成对 save/restore 包裹内部算子：此处同样入栈并叠加该矩阵，
          // 否则表单内图像/矢量矩形整体错位，区域 OCR 会裁到空白。
          else if(fn===OPS.paintFormXObjectBegin){
            stack.push(ctm.slice());
            const matrix=args&&args[0];
            if(matrix&&matrix.length===6&&[0,1,2,3,4,5].every(index=>Number.isFinite(matrix[index])))ctm=compose(ctm,matrix);
          }
          else if(fn===OPS.paintFormXObjectEnd){if(stack.length)ctm=stack.pop();}
          else if(fn===OPS.transform&&Array.isArray(args)&&args.length===6&&args.every(Number.isFinite))ctm=compose(ctm,args);
          else if(fn===OPS.paintImageXObject||fn===OPS.paintJpegXObject){
            if(images.length<64){
              const rect=bbox(compose(vt,ctm),unitCorners);
              const w=args?.[1],h=args?.[2];
              if(rect)images.push({rect,pixels:{width:Number.isFinite(w)?w:null,height:Number.isFinite(h)?h:null}});
            }
          }else if(fn===OPS.paintInlineImageXObject){
            if(images.length<64){
              const data=args?.[0],rect=bbox(compose(vt,ctm),unitCorners);
              if(rect)images.push({rect,pixels:{width:Number.isFinite(data?.width)?data.width:null,height:Number.isFinite(data?.height)?data.height:null}});
            }
          }else if(fn===OPS.constructPath&&vectorRects.length<2000){
            // args[2] 为求值器跟踪的路径包围盒（用户空间原始坐标），经当前 CTM 映射到固定坐标系。
            // pdf.js 实际返回 Float32Array（非 Array），按数组类判定，否则转曲候选恒为空。
            const minMax=args?.[2];
            if(minMax&&minMax.length===4&&Number.isFinite(minMax[0])&&Number.isFinite(minMax[1])&&
              Number.isFinite(minMax[2])&&Number.isFinite(minMax[3])){
              const matrix=compose(vt,ctm),rect=bbox(matrix,[[minMax[0],minMax[1]],[minMax[2],minMax[3]]]);
              if(rect)vectorRects.push(rect);
              if([OPS.stroke,OPS.closeStroke,OPS.fillStroke,OPS.eoFillStroke,OPS.closeFillStroke,OPS.closeEOFillStroke].includes(args?.[0]))straightRules(matrix,args?.[1]?.[0]);
              // 直线包围盒允许零宽/零高；原矢量区域接口仍只收有面积的矩形。
              // 仅收已经描边或填充的路径，不把裁剪区域当作表格边界。
              if(rules.length<2000&&[OPS.stroke,OPS.closeStroke,OPS.fill,OPS.eoFill,OPS.fillStroke,OPS.eoFillStroke,OPS.closeFillStroke,OPS.closeEOFillStroke].includes(args?.[0])){
                const points=[[minMax[0],minMax[1]],[minMax[0],minMax[3]],[minMax[2],minMax[1]],[minMax[2],minMax[3]]].map(([x,y])=>apply(matrix,x,y));
                if(points.every(point=>point.every(Number.isFinite)))rules.push({x:Math.min(...points.map(p=>p[0])),y:Math.min(...points.map(p=>p[1])),right:Math.max(...points.map(p=>p[0])),bottom:Math.max(...points.map(p=>p[1]))});
              }
            }
          }
        }
        return {pageNumber,imageOps:imageCount,showTextOps:showText,totalOps:list.fnArray.length,images,vectorRects,rules};
      };
      return E.wait(work(),{signal,stage:"extract",onCancel:()=>{retired=true;}});
    }
    async function pageSize({pageNumber,viewRotation=0},{signal}) {
      return E.wait((async()=>{
        if(closed||!documentProxy)throw E.cancelled();
        const page=await Promise.race([documentProxy.getPage(pageNumber),workerFailurePromise]);
        E.check(signal);if(closed)throw E.cancelled();
        const viewport=page.getViewport({scale:1,rotation:(page.rotate+viewRotation)%360});
        return {width:viewport.width,height:viewport.height};
      })(),{signal,stage:"render"});
    }
    function close() {
      if (closing) return closing;
      closed = true; active?.cancel();
      const task = loadingTask, worker = nativeWorker, proxy = pdfWorker;
      const destroy = async () => {
        // 正常释放 transport；异常 Worker 无响应时最多等待两秒后强制终止。
        try {
          if (task) await E.wait(task.destroy(), {ms: 2000, stage: "cleanup"});
        } catch (_) {} finally {
          if (workerFailure) worker?.removeEventListener("error", workerFailure);
          try { proxy?.destroy(); } catch (_) {}
          worker?.terminate();
          documentProxy = loadingTask = nativeWorker = pdfWorker = pdfjsModule = null;
        }
      };
      closing = destroy();
      return closing;
    }
    return {open, renderPage, renderThumbnail, pageSize, extractPage, probePageContent, close};
  }
  global.BT_PDF_READER = {create: createReader};
})(window);
