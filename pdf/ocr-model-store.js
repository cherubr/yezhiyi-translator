(function(global) {
  "use strict";
  /**
   * OCR 按需模型存储：从钉死来源下载语言模型，校验后持久化到 IndexedDB，供离线复用。
   * meta 存版本戳与摘要，blobs 存字节，两者同一事务提交，避免半安装状态。
   * 本模块不做识别、不建 Worker；页面图像与翻译内容不经过这里。
   */
  const E = global.BT_PDF_ERRORS;
  const M = global.BT_PDF_OCR_MODELS;
  const DB_NAME = "bt-pdf-ocr-models", DB_VERSION = 1, META = "meta", BLOBS = "blobs";
  const DOWNLOAD_ORIGIN = "https://raw.githubusercontent.com/*";
  const DOWNLOAD_MS = 120000; // 单个模型最大约 4 MiB：慢网络放宽到 2 分钟，但不无限等待

  let dbPromise = null, snapshot = null;
  const storeError = cause => E.create("MODEL_STORE_FAILED",
    "本地 OCR 模型存储读写失败" + (cause?.message ? "：" + cause.message : ""), "model");

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
      if (record?.modelSource === M.MODEL_SOURCE) snapshot.set(record.code, record);
      else if (record?.code) stale.push(record.code);
    }
    if (stale.length) await removeCodes(db, stale).catch(() => {});
    try { void navigator.storage?.persist?.(); } catch (_) {} // 尽力降低被逐出概率；失败不影响使用
    return snapshot;
  }

  /** 已安装（当前版本戳）的模型代码集合；随包模型不在其中，判定用 M.has。 */
  async function installed() {
    return new Set((await ready()).keys());
  }

  /** 给定语言码中既未随包也未安装的清单；供识别前早失败与管理界面状态显示。 */
  async function missing(codes) {
    const current = await ready();
    return [...codes].filter(code => !M.has(code) && !current.has(code));
  }

  /** 读取模型字节；meta 或字节缺失（被浏览器逐出）时清理记录并按未安装返回 null，不静默失败。 */
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

  /** 必须在用户点击链内同步调用：先发起下载来源授权，再进行任何异步等待（与 source-loader 同模式）。 */
  function authorize() {
    let permission;
    try { permission = chrome.permissions.request({origins: [DOWNLOAD_ORIGIN]}); }
    catch (_) { permission = Promise.reject(E.create("PERMISSION_DENIED", "无法申请模型下载来源权限，请重试", "permission")); }
    permission = Promise.resolve(permission);
    permission.catch(() => {});
    return {permission};
  }

  /**
   * 下载并安装一个模型：大小与 SHA-256 均按注册表钉死校验，任一不符拒绝写入。
   * 已随包或已安装时幂等返回；取消与超时由 E.wait 统一处理，中断不产生半安装记录。
   * @param {string} code 注册表内可下载条目的模型代码。
   * @param {{authorization:{permission:Promise<boolean>}, signal?:AbortSignal, onProgress?:({loaded:number,total:number})=>void}} ctx
   */
  async function download(code, {authorization, signal, onProgress = () => {}}) {
    const current = await ready();
    if (M.has(code) || current.has(code)) return; // 已随包或已安装：幂等成功
    const entry = M.source(code);
    if (!entry) throw E.create("OCR_MODEL_MISSING", "该语言没有可下载的模型条目", "model", false);
    const granted = await E.wait(authorization.permission, {signal, stage: "permission"});
    E.check(signal);
    if (!granted) throw E.create("PERMISSION_DENIED", "未授权模型下载来源，可重新授权或改用已随包语言", "permission");
    const controller = new AbortController();
    const work = (async () => {
      let response;
      try {
        response = await fetch(entry.url, {signal: controller.signal, credentials: "omit",
          redirect: "error", cache: "no-store", referrerPolicy: "no-referrer"});
      } catch (error) {
        // 取消/超时触发的中断交由外层 E.wait 统一映射，这里只处理真实网络故障。
        if (controller.signal.aborted) throw error;
        throw E.create("NETWORK_ERROR", "无法连接模型下载来源；部分网络环境无法直达该来源，可配置系统代理后重试", "model");
      }
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        throw E.create("HTTP_ERROR", "模型下载失败（HTTP " + response.status + "），请稍后重试", "model");
      }
      if (!response.body) throw E.create("NETWORK_ERROR", "下载来源没有返回内容，请稍后重试", "model");
      const integrity = () => E.create("MODEL_INTEGRITY", "模型文件大小与注册表不符，已拒绝安装", "model", false);
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
        throw E.create("MODEL_INTEGRITY", "模型摘要校验失败，已拒绝安装；请重新下载", "model", false);
      const db = await openDb();
      const meta = {code, sha256: entry.sha256, bytes: entry.bytes, modelSource: M.MODEL_SOURCE, installedAt: Date.now()};
      await transaction(db, [META, BLOBS], "readwrite", tx => {
        tx.objectStore(META).put(meta);
        tx.objectStore(BLOBS).put({code, bytes});
      });
      current.set(code, meta);
    })();
    try {
      await E.wait(work, {signal, ms: DOWNLOAD_MS, stage: "model", onCancel: () => controller.abort()});
    } catch (error) {
      if (error?.name === "AbortError" || error?.code === "CANCELLED") throw E.cancelled();
      if (error?.code === "TIMEOUT") throw E.create("MODEL_DOWNLOAD_TIMEOUT", "模型下载超时，请重试", "model");
      throw error;
    }
  }

  /** 删除已安装模型（随包模型无操作）；删除后识别恢复「未安装」提示，可重新下载。 */
  async function remove(code) {
    if (M.has(code)) return;
    const current = await ready();
    if (!current.has(code)) return;
    const db = await openDb();
    await removeCodes(db, [code]);
    current.delete(code);
  }

  global.BT_PDF_OCR_MODEL_STORE = {ready, installed, missing, get, authorize, download, remove};
})(window);
