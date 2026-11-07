(function(global) {
  "use strict";
  const E = global.BT_PDF_ERRORS, MAX_BYTES = 50 * 1024 * 1024;
  function parseUrl(value) {
    let url;
    try { url = new URL(value); } catch (_) { throw E.create("INVALID_URL", "请输入完整的 HTTP(S) PDF 地址", "source", false); }
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password)
      throw E.create("INVALID_URL", "仅支持不含账号密码的 HTTP(S) 地址", "source", false);
    url.hash = "";
    return url;
  }
  /** 必须在用户点击链直接调用，先发起精确来源授权，再进行任何异步等待。 */
  function authorize(value) {
    const url = parseUrl(value);
    let permission;
    try { permission = chrome.permissions.request({origins: [url.origin + "/*"]}); }
    catch (_) { permission = Promise.reject(E.create("PERMISSION_DENIED", "无法申请来源权限，请重试", "permission")); }
    permission = Promise.resolve(permission);
    permission.catch(() => {});
    return {url, permission};
  }
  /** 只解析地址、不发起权限申请；供阅读页确认已授权后的自动加载复用同一加载流程。 */
  function peek(value) {
    try { return {url: parseUrl(value), permission: Promise.resolve(true)}; } catch (_) { return null; }
  }
  function size(value) {
    if (value > MAX_BYTES) throw E.create("FILE_TOO_LARGE", "PDF 最大支持 50 MiB，请选择较小文件", "source", false);
  }
  function validate(bytes) {
    if (!bytes.length || !new TextDecoder("latin1").decode(bytes.subarray(0, 1024)).includes("%PDF-"))
      throw E.create("INVALID_PDF", "读取内容不是 PDF，可能是登录页或错误网页", "source");
    return bytes;
  }
  async function load({file, authorization}, {signal, onProgress = () => {}}) {
    E.check(signal);
    let bytes, sourceName;
    if (file) {
      size(file.size); sourceName = file.name;
      const reader = new FileReader();
      const pending = new Promise((resolve, reject) => {
        reader.onload = () => resolve(new Uint8Array(reader.result));
        reader.onerror = () => reject(E.create("READ_FAILED", "本地文件读取失败，请重新选择", "source"));
        reader.onabort = () => reject(E.cancelled());
        reader.onprogress = event => onProgress({loaded: event.loaded, total: file.size});
        reader.readAsArrayBuffer(file);
      });
      try { bytes = await E.wait(pending, {signal, stage: "source", onCancel: () => reader.abort()}); }
      finally { reader.onload = reader.onerror = reader.onabort = reader.onprogress = null; }
    } else {
      if (!authorization) throw E.create("INVALID_URL", "请先输入 PDF 地址", "source", false);
      const granted = await E.wait(authorization.permission, {signal, stage: "permission"});
      E.check(signal);
      if (!granted) throw E.create("PERMISSION_DENIED", "未授权访问来源，可重新授权或选择本地文件", "permission");
      const controller = new AbortController();
      let stream;
      const download = async () => {
        let response;
        try {
          response = await fetch(authorization.url.href, {signal: controller.signal, credentials: "omit", redirect: "error", cache: "no-store", referrerPolicy: "no-referrer"});
        } catch (_) {
          if (controller.signal.aborted) throw E.cancelled();
          throw E.create("NETWORK_ERROR", "无法连接来源，或地址发生重定向；请使用最终 PDF 直链或选择本地文件", "source");
        }
        if (!response.ok) {
          void response.body?.cancel().catch(() => {});
          throw E.create("HTTP_ERROR", "来源读取失败（HTTP " + response.status + "），可下载后选择本地文件", "source");
        }
        const total = Number(response.headers.get("content-length")) || 0;
        size(total);
        if (!response.body) throw E.create("READ_FAILED", "来源没有返回文件内容", "source");
        stream = response.body.getReader();
        const chunks = []; let loaded = 0;
        try {
          while (true) {
            const {done, value} = await stream.read();
            if (done) break;
            loaded += value.byteLength; size(loaded); chunks.push(value);
            onProgress({loaded, total});
          }
          const result = new Uint8Array(loaded); let offset = 0;
          for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
          return result;
        } finally { chunks.length = 0; }
      };
      try {
        bytes = await E.wait(download(), {signal, stage: "source", onCancel: () => controller.abort()});
        sourceName = authorization.url.pathname.split("/").pop() || "在线 PDF";
        try { sourceName = decodeURIComponent(sourceName); } catch (_) {}
      } finally {
        controller.abort();
        if (stream) { void stream.cancel().catch(() => {}); try { stream.releaseLock(); } catch (_) {} }
      }
    }
    E.check(signal); validate(bytes);
    return {bytes, sourceName, dispose() { bytes = null; }};
  }
  global.BT_PDF_SOURCE = {authorize, peek, load, MAX_BYTES};
})(window);
