(function(global) {
  "use strict";
  function create() {
    let pending, identity = null, generation = 0, rows = new Map();
    const open = () => pending || (pending = new Promise((resolve,reject) => {
      const request = indexedDB.open("yezhiyi-pdf-inplace",1);
      request.onupgradeneeded = () => { const store=request.result.createObjectStore("corrections",{keyPath:"key"});store.createIndex("documentId","documentId"); };
      request.onsuccess = () => { const db=request.result;db.onversionchange=()=>{db.close();pending=null;};resolve(db); };
      request.onerror = () => {pending=null;reject(new Error("无法打开原位修订存储"));};
    }));
    const key = (scope,page,block) => JSON.stringify([identity,scope,page,block.editAnchor||block.id]);
    async function setDocument(id) {
      identity=id||null;rows=new Map();const version=++generation,documentId=identity;if(!documentId)return;
      const db=await open();if(version!==generation)return;
      const values=await new Promise((resolve,reject)=>{const request=db.transaction("corrections").objectStore("corrections").index("documentId").getAll(documentId);
        request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(new Error("无法读取原位修订"));});
      if(version===generation)rows=new Map(values.map(row=>[row.key,row]));
    }
    function get(scope,page,block) {const row=rows.get(key(scope,page,block));return row?.source===block.text?row:null;}
    function regions(scope,page) {return [...rows.values()].filter(row=>row.scope===scope&&row.page===page&&row.region&&row.mode==="custom").map(row=>row.region);}
    function savedBlocks(scope,page) {return [...rows.values()].filter(row=>row.scope===scope&&row.page===page&&(row.mode==="custom"||row.machine?.text)&&!row.region&&row.anchorBlock).map(row=>row.anchorBlock);}
    const hasPage=(scope,page)=>[...rows.values()].some(row=>row.scope===scope&&row.page===page&&(row.mode==="custom"||row.machine?.text));
    const isResetPage=(scope,page)=>[...rows.values()].some(row=>row.scope===scope&&row.page===page&&row.pageReset===true);
    /** 清除本页修订，并记住旧版段落修订不可在重新打开时恢复。 */
    async function resetPage(scope,page) {
      if(!identity||!scope||!Number.isInteger(page))throw new Error("页面或语言尚未就绪");
      const version=generation,documentId=identity,db=await open();
      if(version!==generation)throw new Error("文档已变化，请重新操作");
      const marker={key:JSON.stringify([documentId,scope,page,":page-reset"]),documentId,scope,page,pageReset:true,mode:"original",updated:Date.now()};
      await new Promise((resolve,reject)=>{
        const tx=db.transaction("corrections","readwrite"),store=tx.objectStore("corrections"),request=store.index("documentId").getAll(documentId);
        request.onsuccess=()=>{
          for(const row of request.result)if(row.scope===scope&&row.page===page){
            marker.updated=Math.max(marker.updated,(Number.isFinite(row.updated)?row.updated:0)+1);store.delete(row.key);
          }
          store.put(marker);
        };
        tx.oncomplete=resolve;tx.onabort=()=>reject(new Error("清除修订失败，请重试"));tx.onerror=()=>{};
      });
      if(version===generation){for(const [id,row] of rows)if(row.scope===scope&&row.page===page)rows.delete(id);rows.set(marker.key,marker);}
    }
    function unmatched(scope,page,blocks){
      const matched=new Set(blocks.map(block=>get(scope,page,block)).filter(Boolean));
      return [...rows.values()].filter(row=>row.scope===scope&&row.page===page&&row.mode==="custom"&&!row.region&&!matched.has(row)).length;
    }
    async function save(scope,page,block,text,placement,{restore=false,region=false,machine=null,fontFamily="sans-serif",textStyle=null}={}) {
      if(!identity||!scope||!Number.isInteger(page)||typeof text!=="string"||text.length>20000||!restore&&!text.trim())throw new Error("请输入有效译文（最多两万字）");
      const resetVersion=[...rows.values()].find(row=>row.scope===scope&&row.page===page&&row.pageReset)?.updated||0;
      const version=generation,documentId=identity,id=key(scope,page,block),revision=rows.get(id)?.revision||0,db=await open();
      if(version!==generation)throw new Error("文档已变化，请重新选择段落");
      const record={key:id,documentId,scope,page,source:block.text,text:restore?"":text,mode:restore?"machine":"custom",
        placement:restore?null:placement,fontFamily:["sans-serif","serif","monospace"].includes(fontFamily)?fontFamily:"sans-serif",textStyle:restore?null:textStyle,
        machine:region?null:machine,revision:revision+1,updated:Date.now(),...(region?{region:block}:{anchorBlock:block})};
      await new Promise((resolve,reject)=>{
        const tx=db.transaction("corrections","readwrite"),store=tx.objectStore("corrections"),request=store.getAll();let failure;
        request.onsuccess=()=>{
          const prior=request.result.find(row=>row.key===id);
          const reset=request.result.find(row=>row.documentId===documentId&&row.scope===scope&&row.page===page&&row.pageReset);
          if((reset?.updated||0)!==resetVersion){failure=new Error("本页译文已清除或重新翻译，请重新画框修订");tx.abort();return;}
          if((prior?.revision||0)!==revision){failure=new Error("另一个阅读器已修改此修订，请刷新后核对");tx.abort();return;}
          // 在写事务中分配递增顺序，同毫秒保存及更新旧框也必须升到最上层。
          record.updated=request.result.filter(row=>row.documentId===documentId&&row.scope===scope&&row.page===page)
            .reduce((latest,row)=>Math.max(latest,(Number.isFinite(row.updated)?row.updated:0)+1),Date.now());
          const values=request.result.filter(row=>row.key!==id);
          if(values.length>=2000||JSON.stringify([...values,record]).length*2>32*1024*1024){failure=new Error("原位修订存储已达上限");tx.abort();return;}
          store.put(record);
        };
        tx.oncomplete=resolve;tx.onabort=()=>reject(failure||new Error("修订未保存，请重试"));tx.onerror=()=>{};
      });
      if(version===generation)rows.set(id,record);
    }
    return {setDocument,get,regions,savedBlocks,hasPage,isResetPage,resetPage,unmatched,save};
  }
  global.BT_PDF_INPLACE_STORE={create};
})(typeof window!=="undefined"?window:self);
