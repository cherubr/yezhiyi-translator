(function(global) {
  "use strict";
  /** 只暴露安全提示和阶段码，不把 URL、文件正文或解析器原始异常写入界面/日志。 */
  function create(code, message, stage, retryable = true) {
    return Object.assign(new Error(message), {name: code === "CANCELLED" ? "AbortError" : "PdfError", code, stage, retryable});
  }
  const cancelled = () => create("CANCELLED", "操作已取消", "cancel", false);
  function check(signal) { if (signal?.aborted) throw signal.reason || cancelled(); }
  function normalize(error, stage) {
    if (error?.name === "PdfError" || error?.code === "CANCELLED") return error;
    if (error?.name === "AbortError" || error?.name === "RenderingCancelledException") return cancelled();
    if (error?.name === "PasswordException") return create("PASSWORD_REQUIRED", "密码无效或未提供，请重新读取文件", "parse");
    if (error?.name === "InvalidPDFException") return create("INVALID_PDF", "文件损坏或不是有效的 PDF", "parse");
    return create(stage === "render" ? "RENDER_FAILED" : "READ_FAILED",
      stage === "render" ? "本页渲染失败，可重试或查看其他页" : "PDF 读取失败，请重试或选择本地文件", stage);
  }
  /** 有界等待；取消/超时会退役对应工作，迟到 Promise 始终有异常接收者。 */
  function wait(promise, {signal, ms = 60000, stage, onCancel = () => {}}) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true; clearTimeout(timer); signal?.removeEventListener("abort", abort);
        if (error) reject(error); else resolve(value);
      };
      const stop = error => {
        if (settled) return;
        finish(error);
        try { Promise.resolve(onCancel(error)).catch(() => {}); } catch (_) {}
      };
      const abort = () => stop(signal.reason || cancelled());
      const timer = setTimeout(() => stop(create("TIMEOUT", "处理超时，请重试或选择本地文件", stage)), ms);
      signal?.addEventListener("abort", abort, {once: true});
      Promise.resolve(promise).then(value => finish(null, value), error => finish(error));
      if (signal?.aborted) abort();
    });
  }
  global.BT_PDF_ERRORS = {create, cancelled, check, normalize, wait};
})(window);
