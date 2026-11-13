(function(global) {
  "use strict";
  function create() {
    let pending;
    const open=()=>pending||(pending=new Promise((resolve,reject)=>{
      const request=indexedDB.open("yezhiyi-pdf-editor",1);
      request.onupgradeneeded=()=>request.result.createObjectStore("documents",{keyPath:"key"});
      request.onsuccess=()=>{const db=request.result;db.onversionchange=()=>{db.close();pending=null;};resolve(db);};
      request.onerror=()=>{pending=null;reject(new Error("无法打开本机编辑稿存储"));};
    }));
    async function read(key) {
      const db=await open();return new Promise((resolve,reject)=>{
        const tx=db.transaction("documents"),request=tx.objectStore("documents").get(key);
        request.onsuccess=()=>resolve(request.result||null);request.onerror=()=>reject(new Error("无法读取本机编辑稿"));
      });
    }
    async function write(key,document,revision,{intentionalEmpty=false}={}) {
      const clean=global.BT_PDF_EDITOR_MODEL.clean(document),db=await open();
      return new Promise((resolve,reject)=>{
        const tx=db.transaction("documents","readwrite"),store=tx.objectStore("documents"),request=store.getAll();let failure,record;
        request.onsuccess=()=>{
          const rows=request.result,prior=rows.find(row=>row.key===key);
          if((prior?.revision||0)!==revision){failure=new Error("另一个阅读器已修改此编辑稿，请重新打开核对；本页改动仍保留");tx.abort();return;}
          record={key,document:clean,revision:revision+1,updated:Date.now(),intentionalEmpty:!!intentionalEmpty};
          const bytes=JSON.stringify(record).length*2+rows.filter(row=>row.key!==key).reduce((sum,row)=>sum+JSON.stringify(row).length*2,0);
          if(rows.length+(prior?0:1)>128||bytes>64*1024*1024){failure=new Error("本机编辑稿存储已达上限，请先删除不需要的编辑稿");tx.abort();return;}
          store.put(record);
        };
        tx.oncomplete=()=>resolve(record);tx.onabort=()=>reject(failure||new Error("编辑稿保存失败，改动仍保留在当前页面"));tx.onerror=()=>{};
      });
    }
    async function remove(key,revision) {
      const db=await open();return new Promise((resolve,reject)=>{
        const tx=db.transaction("documents","readwrite"),store=tx.objectStore("documents"),request=store.get(key);let failure;
        request.onsuccess=()=>{
          if((request.result?.revision||0)!==revision){failure=new Error("编辑稿已被其他阅读器修改，请重新打开后再删除");tx.abort();return;}
          store.delete(key);
        };
        tx.oncomplete=resolve;tx.onabort=()=>reject(failure||new Error("删除编辑稿失败"));tx.onerror=()=>{};
      });
    }
    return {read,write,remove};
  }
  global.BT_PDF_EDITOR_STORE={create};
})(typeof window!=="undefined"?window:self);
