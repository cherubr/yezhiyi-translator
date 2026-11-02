(function(global){
  "use strict";
  const MAX_BYTES=20*1024*1024,MAX_PIXELS=8000000,MAX_TEXT=100000;
  let library;
  function load(){
    if(global.Tesseract)return Promise.resolve(global.Tesseract);
    if(!library)library=new Promise((resolve,reject)=>{
      const script=document.createElement("script");script.src=chrome.runtime.getURL("ocr/vendor/tesseract.min.js");
      script.onload=()=>resolve(global.Tesseract);script.onerror=()=>{script.remove();library=null;reject(Error("本地 OCR 组件加载失败，请重新加载扩展"));};document.head.append(script);
    });return library;
  }
  const cancelled=()=>Object.assign(Error("识别已取消"),{name:"AbortError"});
  /** 每次只识别一张图；完成、失败、取消均终止 Worker，不持久保存图片或识别文字。 */
  function create(){
    let version=0,worker=null,stop=null;
    function cancel(){version++;stop?.();stop=null;const old=worker;worker=null;if(old)void old.terminate().catch(()=>{});}
    async function recognize(image,language="eng",progress=()=>{}){
      cancel();const current=version;
      if(!["eng","chi_sim+eng"].includes(language))throw Error("不支持的识别语言");
      const operation=(async()=>{
        const api=await load();if(current!==version)throw cancelled();
        const created=await api.createWorker(language,1,{
          workerPath:chrome.runtime.getURL("ocr/vendor/worker.min.js"),
          corePath:chrome.runtime.getURL("ocr/vendor/core/"),langPath:chrome.runtime.getURL("ocr/vendor/lang/"),
          workerBlobURL:false,cacheMethod:"none",logger:value=>{if(current===version)progress(value);},errorHandler:()=>{}
        });
        if(current!==version){await created.terminate();throw cancelled();}worker=created;
        const result=await created.recognize(image,{}, {text:true});
        if(current!==version)throw cancelled();
        const text=String(result.data?.text||"").trim();if(text.length>MAX_TEXT)throw Error("识别文字过长，请裁剪图片后重试");
        return text;
      })();
      try{return await Promise.race([operation,new Promise((_,reject)=>{stop=()=>reject(cancelled());})]);}
      finally{if(current===version)cancel();}
    }
    return {recognize,cancel};
  }
  /** 文件大小与画布上限独立限制；解码后的位图必须由调用方关闭。 */
  async function image(file){
    if(!file||file.size>MAX_BYTES)throw Error("图片最大 20 MB");
    if(!/^image\/(png|jpeg|webp|bmp|gif)$/.test(file.type))throw Error("请选择 PNG、JPEG、WebP、BMP 或 GIF 图片");
    const bitmap=await createImageBitmap(file);
    if(!bitmap.width||!bitmap.height){bitmap.close();throw Error("图片无法解码");}
    const scale=Math.min(1,Math.sqrt(MAX_PIXELS/(bitmap.width*bitmap.height)));
    const canvas=document.createElement("canvas");canvas.width=Math.max(1,Math.floor(bitmap.width*scale));canvas.height=Math.max(1,Math.floor(bitmap.height*scale));
    canvas.getContext("2d").drawImage(bitmap,0,0,canvas.width,canvas.height);bitmap.close();return canvas;
  }
  global.BT_OCR={MAX_BYTES,MAX_PIXELS,MAX_TEXT,create,image};
})(typeof self!=="undefined"?self:globalThis);
