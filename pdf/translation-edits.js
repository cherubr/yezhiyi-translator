(function(global) {
  "use strict";
  // 只保存显式人工修订；机器缓存、PDF 字节与 OCR 位图不写入此库。
  const VERSION = 1, MAX_RECORDS = 4000, MAX_BYTES = 8 * 1024 * 1024, MAX_TEXT = 32000;
  const size = row => JSON.stringify(row).length * 2;
  function database() {
    let pending;
    const open = () => pending || (pending = new Promise((resolve, reject) => {
      const request = indexedDB.open("yezhiyi-pdf-edits", VERSION);
      request.onupgradeneeded = () => request.result.createObjectStore("edits", {keyPath: "key"});
      request.onsuccess = () => { const db = request.result; db.onversionchange = () => { db.close(); pending = null; }; resolve(db); };
      request.onerror = () => { pending = null; reject(new Error("无法打开人工修订存储")); };
    }));
    return {
      async all() { const db = await open(); return new Promise((resolve, reject) => {
        const tx = db.transaction("edits"), request = tx.objectStore("edits").getAll();
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      }); },
      async write(record, key) { const db = await open(); return new Promise((resolve, reject) => {
        const tx = db.transaction("edits", "readwrite"), store = tx.objectStore("edits"), request = store.getAll();
        let fault;
        request.onsuccess = () => {
          const rows = request.result.filter(row => row.key !== key);
          if (record) rows.push(record);
          if (rows.length > MAX_RECORDS || rows.reduce((n, row) => n + size(row), 0) > MAX_BYTES) {
            fault = new Error("人工修订存储已达上限，请先恢复不再需要的修订；本次未保存"); tx.abort(); return;
          }
          if (record) store.put(record); else store.delete(key);
        };
        tx.oncomplete = resolve; tx.onabort = () => reject(fault || tx.error || new Error("保存人工修订失败"));
        tx.onerror = () => {}; // 由 abort 统一报告；不能把请求成功误报为事务已提交。
      }); }
    };
  }
  function create(storage = database()) {
    let documentId = null, rows = new Map(), generation = 0, ready = Promise.resolve(), revision = 0;
    // 原生段落用原 textItem 索引作锚点；阅读排序变化不能使已有人工修订丢失。
    const anchor=id=>String(id).replace(/^(\d+):\d+:/,"$1:native:");
    const normalizeKey=value=>{try{const parts=JSON.parse(value);if(Array.isArray(parts)&&parts.length===5){parts[4]=anchor(parts[4]);return JSON.stringify(parts);}}catch(_){}return value;};
    const key = (scope, page, block) => JSON.stringify([VERSION, documentId, scope, page, anchor(block.editAnchor||block.id)]);
    function setDocument(id) {
      documentId = id || null; rows = new Map(); const version = ++generation;
      ready = documentId ? storage.all().then(values => {
        if(version===generation){
          rows=new Map();
          for(const row of values.filter(row=>row.documentId===documentId&&row.version===VERSION)){
            const id=normalizeKey(row.key),prior=rows.get(id);
            if(!prior||(row.updated||0)>=(prior.updated||0))rows.set(id,row);
          }
        }
      }) : Promise.resolve();
      return ready;
    }
    function get(scope, page, block) {
      const record = rows.get(key(scope, page, block));
      if(record?.source===block.text)return record;
      // 仅允许附属版权/商标符号与空白重组的兼容匹配，正文有任何变化仍拒绝套用旧修订。
      const comparable=text=>String(text).replace(/[®©™†‡\s]/gu,"");
      return record&&block.editAnchor&&comparable(record.source)===comparable(block.text)?record:null;
    }
    function unmatched(scope,page,blocks) {
      const matched=new Set(blocks.map(block=>get(scope,page,block)).filter(Boolean));
      return [...new Set(rows.values())].filter(record=>record.scope===scope&&record.page===page&&!matched.has(record)).length;
    }
    async function save(scope, page, block, text, machine) {
      const version = generation, id = documentId;
      await ready;
      if (version !== generation || !id) throw new Error("文件已切换，请在当前文件中重新编辑");
      text = String(text).replace(/\r\n?/g, "\n");
      if (!text.trim()) throw new Error("译文不能为空");
      if (text.length > MAX_TEXT) throw new Error("单段修订最多 32000 个字符");
      const lookup=key(scope,page,block),prior=get(scope,page,block);
      const record = {version: VERSION, key: prior?.key||lookup, documentId: id, scope, page,
        source: block.text, text, machine: machine || null, updated: Date.now()};
      await storage.write(record, record.key);
      if (version === generation) { rows.set(lookup, record); revision++; }
    }
    async function remove(scope, page, block) {
      const version = generation; await ready; if (version !== generation) return;
      const record = get(scope, page, block); if (!record) return;
      await storage.write(null, record.key);
      if (version === generation) { rows.delete(key(scope,page,block)); revision++; }
      return record.machine;
    }
    return {setDocument, get, unmatched, save, remove, ready: () => ready, revision: () => revision};
  }
  global.BT_PDF_EDITS = {create, limits: {MAX_RECORDS, MAX_BYTES, MAX_TEXT}};
})(window);
