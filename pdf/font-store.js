(function(global) {
  "use strict";
  /**
   * 导出字体按需存储：从钉死来源下载字体，校验后持久化到独立 IndexedDB，供后续导出离线复用。
   * 与 OCR 模型存储（ocr-model-store.js）刻意保持同一形态：meta 存版本戳与摘要、blobs 存字节，
   * 两者同一事务提交，避免半安装状态；但数据库独立（bt-pdf-fonts），升级模型不会牵动字体，反之亦然。
   * 本模块不做嵌入、不建 Worker；页面图像与译文内容不经过这里，只存字体字节。
   */
  const E = global.BT_PDF_ERRORS;
  const F = global.BT_PDF_EXPORT_FONTS;
  const DB_NAME = "bt-pdf-fonts", DB_VERSION = 1, META = "meta", BLOBS = "blobs";
  const DOWNLOAD_ORIGIN = "https://raw.githubusercontent.com/*";
  // 最大条目 8.3 MiB（汉字级字体）：慢网络放宽到 5 分钟，进度可见且随时可取消，不无限等待。
  const DOWNLOAD_MS = 300000;

  let dbPromise = null, snapshot = null;
  const storeError = cause => E.create("FONT_STORE_FAILED",
    "本地导出字体存储读写失败" + (cause?.message ? "：" + cause.message : ""), "font");

  function openDb() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, {keyPath: "code"});
          if (!db.objectStoreNames.contains(BLOBS)) db.createObjectStore(BLOBS, {keyPath: "code"});
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(storeError(request.error));
        request.onblocked = () => reject(storeError(null));
      }).catch(error => { dbPromise = null; throw error; });
    }
    return dbPromise;
  }

  const wrap = request => new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(storeError(request.error));
  });

  function transaction(db, stores, mode, run) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(stores, mode);
      run(tx);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(storeError(tx.error));
      tx.onabort = () => reject(storeError(tx.error));
    });
  }

  async function removeCodes(db, codes) {
    await transaction(db, [META, BLOBS], "readwrite", tx => {
      const meta = tx.objectStore(META), blobs = tx.objectStore(BLOBS);
      for (const code of codes) { meta.delete(code); blobs.delete(code); }
    });
  }

  /** 首次调用装载 meta 快照并清理旧版本戳记录（升级钉死 commit 后自动失效）；其后查询走内存。 */
  async function ready() {
    if (snapshot) return snapshot;
    const db = await openDb();
    const records = await new Promise((resolve, reject) => {
      const tx = db.transaction([META], "readonly");
      const request = tx.objectStore(META).getAll();
      request.onsuccess = () => resolve(request.result);
      tx.onerror = () => reject(storeError(tx.error));
      tx.onabort = () => reject(storeError(tx.error));
    });
    snapshot = new Map();
    const stale = [];
    for (const record of records) {
      if (record?.fontSource === F.FONT_SOURCE) snapshot.set(record.code, record);
      else if (record?.code) stale.push(record.code);
    }
    if (stale.length) await removeCodes(db, stale).catch(() => {});
    try { void navigator.storage?.persist?.(); } catch (_) {} // 尽力降低被逐出概率；失败不影响使用
    return snapshot;
  }

  /** 已安装（当前版本戳）的字体代码集合；内置字体不在其中，判定用 F.has。 */
  async function installed() {
    return new Set((await ready()).keys());
  }

  /** 读取字体字节；meta 或字节缺失（被浏览器逐出）时清理记录并按未安装返回 null，不静默失败。 */
  async function get(code) {
    const current = await ready();
    const meta = current.get(code);
    if (!meta) return null;
    const db = await openDb();
    const record = await wrap(db.transaction([BLOBS], "readonly").objectStore(BLOBS).get(code));
    const bytes = record?.bytes;
    if (!(bytes instanceof Uint8Array) || bytes.length !== meta.bytes) {
      current.delete(code);
      await removeCodes(db, [code]).catch(() => {});
      return null;
    }
    return bytes;
  }

  /** 必须在用户点击链内同步调用：先发起下载来源授权，再进行任何异步等待（与 OCR 模型存储同模式）。 */
  function authorize() {
    let permission;
    try { permission = chrome.permissions.request({origins: [DOWNLOAD_ORIGIN]}); }
    catch (_) { permission = Promise.reject(E.create("PERMISSION_DENIED", "无法申请字体下载来源权限，请重试", "permission")); }
    permission = Promise.resolve(permission);
    permission.catch(() => {});
    return {permission};
  }

  /**
   * 下载并安装一个字体：大小与 SHA-256 均按注册表钉死校验，任一不符拒绝写入。
   * 内置或已安装时幂等返回；取消与超时由 E.wait 统一处理，中断不产生半安装记录。
   * @param {string} code 注册表内可下载条目的字体代码。
   * @param {{authorization:{permission:Promise<boolean>}, signal?:AbortSignal, onProgress?:({loaded:number,total:number})=>void}} ctx
   */
  async function download(code, {authorization, signal, onProgress = () => {}}) {
    const current = await ready();
    if (F.has(code) || current.has(code)) return; // 内置或已安装：幂等成功
    const entry = F.source(code);
    if (!entry) throw E.create("FONT_MISSING", "该字体没有可下载的注册条目", "font", false);
    const granted = await E.wait(authorization.permission, {signal, stage: "permission"});
    E.check(signal);
    if (!granted) throw E.create("PERMISSION_DENIED", "未授权字体下载来源，可重新授权或改用内置字体导出西欧文字", "permission");
    const controller = new AbortController();
    const work = (async () => {
      let response;
      try {
        response = await fetch(entry.url, {signal: controller.signal, credentials: "omit",
          redirect: "error", cache: "no-store", referrerPolicy: "no-referrer"});
      } catch (error) {
        // 取消/超时触发的中断交由外层 E.wait 统一映射，这里只处理真实网络故障。
        if (controller.signal.aborted) throw error;
        throw E.create("NETWORK_ERROR", "无法连接字体下载来源；部分网络环境无法直达该来源，可配置系统代理后重试", "font");
      }
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        throw E.create("HTTP_ERROR", "字体下载失败（HTTP " + response.status + "），请稍后重试", "font");
      }
      if (!response.body) throw E.create("NETWORK_ERROR", "下载来源没有返回内容，请稍后重试", "font");
      const integrity = () => E.create("FONT_INTEGRITY", "字体文件大小与注册表不符，已拒绝安装", "font", false);
      const declared = Number(response.headers.get("content-length")) || 0;
      if (declared && declared !== entry.bytes) throw integrity();
      const reader = response.body.getReader();
      const chunks = []; let loaded = 0;
      try {
        while (true) {
          const {done, value} = await reader.read();
          if (done) break;
          loaded += value.byteLength;
          if (loaded > entry.bytes) throw integrity();
          chunks.push(value);
          onProgress({loaded, total: entry.bytes});
        }
      } finally {
        void reader.cancel().catch(() => {});
        try { reader.releaseLock(); } catch (_) {}
      }
      if (loaded !== entry.bytes) throw integrity();
      const bytes = new Uint8Array(loaded); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      chunks.length = 0;
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
      const hex = [...digest].map(b => b.toString(16).padStart(2, "0")).join("");
      if (hex !== entry.sha256)
        throw E.create("FONT_INTEGRITY", "字体摘要校验失败，已拒绝安装；请重新下载", "font", false);
      const db = await openDb();
      const meta = {code, sha256: entry.sha256, bytes: entry.bytes, fontSource: F.FONT_SOURCE, installedAt: Date.now()};
      await transaction(db, [META, BLOBS], "readwrite", tx => {
        tx.objectStore(META).put(meta);
        tx.objectStore(BLOBS).put({code, bytes});
      });
      current.set(code, meta);
    })();
    try {
      await E.wait(work, {signal, ms: DOWNLOAD_MS, stage: "font", onCancel: () => controller.abort()});
    } catch (error) {
      if (error?.name === "AbortError" || error?.code === "CANCELLED") throw E.cancelled();
      if (error?.code === "TIMEOUT") throw E.create("FONT_DOWNLOAD_TIMEOUT", "字体下载超时，请重试", "font");
      throw error;
    }
  }

  /**
   * 取得可用字体字节：已安装直接读取，未安装则下载后读取。
   * 导出编排在点击手势内先调用 authorize()，再把返回的 authorization 传进来，
   * 使「导出时发现缺字体」也能在同一次点击里补授权并下载，不需要用户先去面板点一次。
   * @returns {Promise<Uint8Array>} 字体字节；内置字体返回 null（由 Worker 用 pdf-lib 标准字体）。
   */
  async function obtain(code, {authorization, signal, onProgress} = {}) {
    if (F.has(code)) return null;
    const existing = await get(code);
    if (existing) return existing;
    await download(code, {authorization, signal, onProgress});
    const bytes = await get(code);
    if (!bytes) throw E.create("FONT_STORE_FAILED", "字体已下载但无法从本机存储读回，请重试", "font");
    return bytes;
  }

  /** 删除已安装字体（内置字体无操作）；删除后导出恢复「未安装」提示，可重新下载。 */
  async function remove(code) {
    if (F.has(code)) return;
    const current = await ready();
    if (!current.has(code)) return;
    const db = await openDb();
    await removeCodes(db, [code]);
    current.delete(code);
  }

  global.BT_PDF_FONT_STORE = {ready, installed, get, obtain, authorize, download, remove,
    DB_NAME, DOWNLOAD_ORIGIN};
})(window);
