(function(global) {
  "use strict";
  const E = global.BT_PDF_ERRORS;
  const VENDOR_BASE = "pdf/vendor/";
  const WORKER_FILE = "pdf/vendor/build/pdf.worker.mjs";
  const MODULE_FILE = "pdf/vendor/build/pdf.mjs";
  const VERSION = "6.5.438";
  /** 每次文件实例持有独立 Worker；显式提供 port，禁止库自动切换主线程假 Worker。 */
  function createReader() {
    let documentProxy = null, loadingTask = null, nativeWorker = null, pdfWorker = null;
    let closed = false, closing = null, active = null, workerFailure = null, workerFailurePromise = null;
    const resource = path => chrome.runtime.getURL(VENDOR_BASE + path);
    async function open(bytes, {signal, onPassword}) {
      const setup = async () => {
        const pdfjs = await import(chrome.runtime.getURL(MODULE_FILE));
        E.check(signal);
        if (closed) throw E.cancelled();
        if (pdfjs.version !== VERSION) throw E.create("DEPENDENCY_ERROR", "PDF 引擎资源版本不一致", "parse", false);
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
    function renderPage({pageNumber, scale, viewRotation, canvas, pixelBudget}, {signal}) {
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
        const viewport = page.getViewport({scale, rotation});
        if (!Number.isFinite(viewport.width * viewport.height) || viewport.width <= 0 || viewport.height <= 0)
          throw E.create("RENDER_FAILED", "本页尺寸无效", "render");
        // 预算包括仍可见的旧页；设备像素比只影响分辨率，不修改逻辑页大小。
        const outputScale = Math.min(global.devicePixelRatio || 1, Math.sqrt(pixelBudget / (viewport.width * viewport.height)), 16384 / viewport.width, 16384 / viewport.height);
        canvas.width = Math.max(1, Math.floor(viewport.width * outputScale));
        canvas.height = Math.max(1, Math.floor(viewport.height * outputScale));
        canvas.style.width = viewport.width + "px"; canvas.style.height = viewport.height + "px";
        const context = canvas.getContext("2d", {alpha: false});
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
        {signal, stage: "render", onCancel: error => { cancel(); if (error.code === "TIMEOUT") void close(); }})
        .finally(() => { if (active === handle) active = null; });
      active = handle;
      return handle;
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
        streamReader=page.streamTextContent({includeMarkedContent:false}).getReader();
        const content={items:[],styles:Object.create(null)};let characters=0;
        try{
          while(true){
            const {value,done}=await Promise.race([streamReader.read(),workerFailurePromise]);
            E.check(signal);if(retired||closed)throw E.cancelled();if(done)break;
            for(const item of value.items){
              characters+=typeof item.str==="string"?item.str.length:0;
              if(content.items.length>=12000||characters>200000)throw E.create("TEXT_BUDGET","本页文字量过大，暂不自动翻译","extract",false);
              content.items.push(item);
            }
            Object.assign(content.styles,value.styles);
          }
          const viewport=page.getViewport({scale:1,rotation:page.rotate});
          return {pageNumber,width:viewport.width,height:viewport.height,transform:[...viewport.transform],items:content.items,styles:content.styles};
        }finally{
          void streamReader.cancel().catch(()=>{});
          try{streamReader.releaseLock();}catch(_){}
        }
      };
      return E.wait(work(), {signal,stage:"extract",onCancel:cancel});
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
          documentProxy = loadingTask = nativeWorker = pdfWorker = null;
        }
      };
      closing = destroy();
      return closing;
    }
    return {open, renderPage, extractPage, close};
  }
  global.BT_PDF_READER = {create: createReader};
})(window);
