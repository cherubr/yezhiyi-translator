(function(global) {
  "use strict";
  /**
   * OCR Provider（Tesseract.js）：独立可替换的文字识别能力。
   * 只接收页面位图、返回结构化行结果；不与 PDF 阅读器、翻译服务、布局规划器耦合。
   * 引擎在主线程按需注入脚本，Worker/WASM/语言模型全部来自扩展包内，页面图像不出本机。
   */
  const E = global.BT_PDF_ERRORS;
  const M = global.BT_PDF_OCR_MODELS;
  const VENDOR = "pdf/vendor/tesseract/";
  const RECOGNIZE_MS = 120000; // 需求 §5：单次 OCR 120 秒上限
  const resource = path => chrome.runtime.getURL(VENDOR + path);

  let library = null;
  function loadLibrary() {
    if (!library) {
      library = new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = resource("tesseract.min.js");
        script.onload = () => global.Tesseract ? resolve(global.Tesseract) : reject(new Error("missing global"));
        script.onerror = () => reject(new Error("load failed"));
        document.head.append(script);
      }).catch(error => {
        library = null;
        throw E.create("OCR_UNAVAILABLE", "OCR 引擎加载失败，请重新加载扩展后重试", "ocr", false);
      });
    }
    return library;
  }

  function normalize(data, languages) {
    // GetJSONText 结构树：blocks → paragraphs → lines → words；坐标为输入位图像素、左上原点。
    const lines = [];
    for (const [blockIndex,block] of (data?.blocks || []).entries()) {
      for (const [paragraphIndex,paragraph] of (block.paragraphs || []).entries()) {
        for (const line of paragraph.lines || []) {
          const text = typeof line.text === "string" ? line.text.replace(/\s+$/, "") : "";
          if (!text.trim()) continue;
          const box = line.bbox || {};
          lines.push({
            text,
            confidence: Number(line.confidence) || 0,
            layoutGroup:blockIndex+":"+paragraphIndex,
            bbox: {x0: box.x0 || 0, y0: box.y0 || 0, x1: box.x1 || 0, y1: box.y1 || 0}
          });
        }
      }
    }
    return {engine: M.ENGINE, engineVersion: M.ENGINE_VERSION, modelVersion: M.MODEL_SOURCE,
      languages: [...languages], lines, warnings: []};
  }

  function createProvider() {
    let worker = null, workerLanguages = "";

    async function disposeWorker() {
      const current = worker;
      worker = null; workerLanguages = "";
      if (!current) return;
      // terminate 挂起时有界等待；异常 Worker 直接丢弃句柄，由下次识别重建。
      try { await E.wait(current.terminate(), {ms: 2000, stage: "cleanup"}); } catch (_) {}
      // 库层 terminate 走任务协议，对卡死/初始化失败的 Worker 无响应；兜底强杀底层 Worker 防泄漏（幂等）。
      try { current.worker?.terminate(); } catch (_) {}
    }

    async function ensureWorker(entries, signal) {
      // 键只含语言码：同码组合的模型字节由注册表哈希与版本戳钉死，重建无歧义。
      const key = entries.map(entry => typeof entry === "string" ? entry : entry.code).join("+");
      if (worker && workerLanguages === key) return worker;
      if (worker) await disposeWorker();
      const Tesseract = await loadLibrary();
      E.check(signal);
      // workerBlobURL:false 走 new Worker(同源URL)，避免 MV3 CSP 拦截 blob Worker；
      // oem=1(LSTM_ONLY) 为库默认，对应 -lstm 单文件 core；gzip:false + cacheMethod:'none'
      // 使随包语言直接 fetch 扩展包内 .traineddata，不写 IndexedDB。
      // 已安装语言以 {code,data} 条目直传字节（worker 端 e.data 分支），不发起任何网络请求。
      worker = await Tesseract.createWorker(entries, 1, {
        workerPath: resource("worker.min.js"),
        corePath: chrome.runtime.getURL(VENDOR),
        langPath: chrome.runtime.getURL(VENDOR + "tessdata"),
        workerBlobURL: false,
        gzip: false,
        cacheMethod: "none",
        logger: () => {}
      });
      E.check(signal);
      workerLanguages = key;
      return worker;
    }

    function capabilities() {
      return {engine: M.ENGINE, engineVersion: M.ENGINE_VERSION, modelVersion: M.MODEL_SOURCE, languages: M.list()};
    }

    /**
     * 语言码 → Worker 加载条目：随包模型用字符串码（包内 langPath 直读），
     * 已安装模型从本地存储取字节以 {code,data} 直传；缺失时报错并指引下载入口。
     */
    async function prepareLanguages(codes, signal) {
      const entries = [], missing = [];
      for (const code of codes) {
        if (M.has(code)) { entries.push(code); continue; }
        const data = await global.BT_PDF_OCR_MODEL_STORE.get(code);
        E.check(signal);
        if (data) entries.push({code, data});
        else missing.push(code);
      }
      if (missing.length)
        throw E.create("OCR_MODEL_MISSING", "语言模型未安装：" + missing.map(code => M.label(code)).join("、") +
          "；请在阅读面板「OCR 语言模型」中下载，或改用自动检测", "ocr", false);
      return entries;
    }

    /**
     * @param {{image:HTMLCanvasElement, languages:string[], regions?:{left:number,top:number,width:number,height:number}[]}} task
     *   位图与识别语言（调用方已过注册表校验）；regions 为整图坐标系下的像素矩形，缺省识别整页。
     *   逐区域调用 SetRectangle，行坐标仍为整图像素空间，可直接映射回固定坐标系。
     * @param {{signal?:AbortSignal, onProgress?:({done:number,total:number})=>void}} ctx
     *   取消即终止 Worker；tesseract.js 无单任务取消，迟到结果随之丢弃。
     * @returns {Promise<{engine,engineVersion,modelVersion,languages,lines,warnings}>}
     */
    async function recognize(task, ctx = {}) {
      const {image, languages, regions} = task;
      const signal = ctx.signal;
      E.check(signal);
      if (!Array.isArray(languages) || !languages.length)
        throw E.create("OCR_MODEL_MISSING", "未指定识别语言", "ocr", false);
      const partial = Array.isArray(regions) && regions.length > 0;
      const work = (async () => {
        const entries = await prepareLanguages(languages, signal);
        const instance = await ensureWorker(entries, signal);
        E.check(signal);
        if (!partial) {
          const result = await instance.recognize(image, {}, {text: false, blocks: true});
          E.check(signal);
          return normalize(result?.data, languages);
        }
        const merged = normalize(null, languages);
        for (let index = 0; index < regions.length; index++) {
          const {left, top, width, height} = regions[index];
          const result = await instance.recognize(image, {rectangle: {left, top, width, height}}, {text: false, blocks: true});
          E.check(signal);
          for (const line of normalize(result?.data, languages).lines)
            merged.lines.push({...line, regionIndex: index});
          ctx.onProgress?.({done: index + 1, total: regions.length});
        }
        return merged;
      })();
      // 多区域识别按区域数放宽总时限，但整页封顶 240 秒，避免大页面无限占用。
      const ms = partial ? Math.min(240000, regions.length * RECOGNIZE_MS) : RECOGNIZE_MS;
      try {
        return await E.wait(work, {signal, ms, stage: "ocr", onCancel: () => disposeWorker()});
      } catch (error) {
        if (error?.name === "AbortError" || error?.code === "CANCELLED") throw E.cancelled();
        if (error?.code === "TIMEOUT") throw E.create("OCR_TIMEOUT", "OCR 识别超时，请重试", "ocr");
        if (error?.name === "PdfError") throw error;
        // 任务中途失败可能意味着 Worker 已损坏；释放后由下次识别重建，避免持续复用坏实例。
        void disposeWorker();
        throw E.create("OCR_UNAVAILABLE", "OCR 识别失败，请重试", "ocr");
      }
    }

    return {engine: M.ENGINE, capabilities, recognize, terminate: disposeWorker};
  }

  global.BT_PDF_OCR = {create: createProvider};
})(window);
