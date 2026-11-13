(function(global) {
  "use strict";
  // 只读兼容旧版段落修订。旧写入/恢复 API 已删除，新编辑稿由 editor-store 独立保存。
  const VERSION = 1;
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
      }); }
    };
  }
  function create(storage = database()) {
    let documentId = null, rows = new Map(), generation = 0, ready = Promise.resolve();
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
    return {setDocument,get,unmatched,ready:()=>ready};
  }
  global.BT_PDF_EDITS = {create};
})(window);
