(function(global) {
  "use strict";
  const E = global.BT_PDF_ERRORS, PIXEL_LIMIT = 8000000;
  /** 页面只保留当前可见画布和一个在途画布；任何迟到结果先核对来源与视图代次。 */
  function create({onState, onCanvas, onClear, onPassword, onDocument = () => {}, onPage = () => {}, onViewReady = () => {}}) {
    let sourceGeneration = 0, viewGeneration = 0, reader = null, sourceController = null, viewController = null;
    let handle = null, viewTail = Promise.resolve(), visibleCanvas = null, disposed = false;
    const state = {source: "idle", view: "idle", page: 1, numPages: 0, scale: 1, rotation: 0, name: "", message: "选择本地 PDF，或输入在线 PDF 地址", error: null, reduced: false};
    const publish = () => { if (!disposed) onState({...state}); };
    function clearCanvas() {
      if (visibleCanvas) { visibleCanvas.width = visibleCanvas.height = 0; visibleCanvas = null; }
      onClear();
    }
    async function retire() {
      sourceGeneration++; viewGeneration++;
      onDocument(null);
      sourceController?.abort(); viewController?.abort(); handle?.cancel();
      sourceController = viewController = null;
      const previous = reader; reader = null;
      clearCanvas();
      if (previous) await previous.close();
    }
    async function load(source) {
      if (disposed || ["loading", "parsing"].includes(state.source)) return;
      const retired = retire(); // 同步退役，来源按钮立即进入 busy；权限申请已由点击链发起。
      const generation = sourceGeneration;
      const controller = new AbortController(); sourceController = controller;
      Object.assign(state, {source: "loading", view: "idle", numPages: 0, page: 1, scale: 1, rotation: 0, error: null, reduced: false, name: "", message: source.file ? "正在读取本地文件…" : "正在授权并读取在线 PDF…"});
      publish();
      let result;
      try {
        await retired; E.check(controller.signal);
        result = await global.BT_PDF_SOURCE.load(source, {signal: controller.signal, onProgress: value => {
          if (generation !== sourceGeneration) return;
          state.message = "正在读取文件：" + (value.loaded / 1048576).toFixed(1) + " MiB" + (value.total ? " / " + (value.total / 1048576).toFixed(1) + " MiB" : "");
          publish();
        }});
        E.check(controller.signal);
        if (generation !== sourceGeneration || disposed) return;
        state.source = "parsing"; state.name = result.sourceName; state.message = "正在解析 PDF…"; publish();
        const currentReader = global.BT_PDF_READER.create(); reader = currentReader;
        const info = await currentReader.open(result.bytes, {signal: controller.signal, onPassword});
        E.check(controller.signal);
        if (generation !== sourceGeneration || disposed) return;
        state.source = "ready"; state.numPages = info.numPages; state.message = "PDF 已读取，正在渲染第一页…";
        sourceController = null; publish();
        onDocument({id:crypto.randomUUID(),numPages:info.numPages,extractPage:currentReader.extractPage});
        onPage(state.page); render();
      } catch (error) {
        if (generation !== sourceGeneration || disposed) return;
        const failure = E.normalize(error, "source");
        const previous = reader; reader = null;
        if (previous) await previous.close();
        if (generation !== sourceGeneration || disposed) return;
        sourceController = null;
        Object.assign(state, {source: failure.code === "CANCELLED" ? "idle" : "failed", view: "idle", numPages: 0, error: failure.code === "CANCELLED" ? null : failure, message: failure.message});
        clearCanvas(); publish();
      } finally { result?.dispose(); }
    }
    function render() {
      if (disposed || state.source !== "ready" || !reader) return;
      viewController?.abort(); handle?.cancel();
      const controller = new AbortController(); viewController = controller;
      const generation = ++viewGeneration, documentGeneration = sourceGeneration, currentReader = reader;
      const request = {pageNumber: state.page, scale: state.scale, viewRotation: state.rotation};
      state.view = "rendering"; state.error = null; state.message = "正在渲染第 " + state.page + " 页…"; publish();
      // 快速操作合并为最新一项，任何时刻最多一个 renderTask 在执行。
      viewTail = viewTail.catch(() => {}).then(async () => {
        if (generation !== viewGeneration || disposed) return;
        let canvas = document.createElement("canvas"), currentHandle;
        try {
          const occupied = visibleCanvas ? visibleCanvas.width * visibleCanvas.height : 0;
          // 旧页已耗尽预算时先释放；优先保证新页至少一半像素预算。
          if (occupied > PIXEL_LIMIT / 2) clearCanvas();
          const available = PIXEL_LIMIT - (visibleCanvas ? visibleCanvas.width * visibleCanvas.height : 0);
          currentHandle = currentReader.renderPage({...request, canvas, pixelBudget: available}, {signal: controller.signal});
          handle = currentHandle;
          const info = await currentHandle.promise;
          if (disposed || documentGeneration !== sourceGeneration || generation !== viewGeneration) return;
          clearCanvas(); visibleCanvas = canvas; onCanvas(canvas); canvas = null;
          Object.assign(state, {view: "ready", reduced: info.reduced, error: null,
            message: "第 " + state.page + " / " + state.numPages + " 页 · " + Math.round(state.scale * 100) + "% · 旋转 " + state.rotation + "°" + (info.reduced ? "；为控制内存已降低渲染分辨率" : "")});
          publish(); onViewReady();
        } catch (error) {
          if (disposed || documentGeneration !== sourceGeneration || generation !== viewGeneration) return;
          const failure = E.normalize(error, "render");
          if (["TIMEOUT", "WORKER_FAILED"].includes(failure.code)) {
            reader = null; await currentReader.close();
            if (generation !== viewGeneration || disposed) return;
            state.source = "failed"; state.numPages = 0; onDocument(null);
          }
          // 不把上一页画面留作失败页；页码、图像与错误状态必须一致。
          clearCanvas(); state.view = "failed"; state.error = failure; state.message = failure.message; publish();
        } finally {
          if (canvas) canvas.width = canvas.height = 0;
          currentHandle?.dispose();
          if (handle === currentHandle) handle = null;
          if (generation === viewGeneration) viewController = null;
        }
      });
    }
    function navigate(value) {
      if (state.source !== "ready" || !Number.isInteger(value) || value < 1 || value > state.numPages || value === state.page) return;
      state.page = value; onPage(value); render();
    }
    function zoom(value) {
      if (state.source !== "ready" || !Number.isFinite(value)) return;
      const scale = Math.min(4, Math.max(0.25, value));
      if (Math.abs(state.scale - scale) < 0.001) return;
      state.scale = scale; render();
    }
    function rotate() {
      if (state.source !== "ready") return;
      state.rotation = (state.rotation + 90) % 360; render();
    }
    async function cancel() {
      if (["loading", "parsing"].includes(state.source)) {
        const cleanup = retire();
        Object.assign(state, {source: "idle", view: "idle", numPages: 0, name: "", error: null, message: "读取已取消，可重新选择文件"}); publish();
        await cleanup;
      } else if (state.view === "rendering") {
        viewGeneration++; viewController?.abort(); handle?.cancel(); viewController = null;
        clearCanvas(); state.view = "idle"; state.message = "本页渲染已取消，点击重试渲染可继续"; state.error = null; publish();
      }
    }
    async function close() {
      const cleanup = retire();
      Object.assign(state, {source: "idle", view: "idle", page: 1, numPages: 0, name: "", error: null, message: "文件已关闭，可重新选择 PDF"}); publish();
      await cleanup;
    }
    function dispose() { disposed = true; void retire(); }
    publish();
    return {load, navigate, zoom, rotate, cancel, close, retry: render, dispose};
  }
  global.BT_PDF_SESSION = {create};
})(window);
