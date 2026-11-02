(async function(){
  "use strict";
  const $=id=>document.getElementById(id),ocr=BT_OCR.create();let config={},configRevision=0,ready=false,canvas=null,busy=false,version=0,token="",intent=0,reading=null;
  const status=(text,error=false)=>{$("status").textContent=text;$("status").classList.toggle("error",error);};
  function controls(){$("recognize").disabled=!canvas||busy;$("translate").disabled=!ready||busy||!$("sourceText").value.trim();$("cancel").disabled=!busy;}
  function cancel(){version++;ocr.cancel();reading?.abort();reading=null;if(token)void chrome.runtime.sendMessage({action:"CANCEL_TRANSLATION_REQUESTS",runToken:token}).catch(()=>{});token="";busy=false;controls();}
  async function refresh(){const revision=++configRevision;ready=false;controls();const loaded=await BT_STORAGE.get();if(revision!==configRevision)return;config={...BT_CONST.DEFAULTS,...loaded};BT_SERVICES.renderSelect($("service"),config);for(const field of ["from","to"])BT_CONST.fillLanguageSelect($(field),field,config[field]);ready=true;controls();}
  async function open(file){
    cancel();const current=version;busy=true;controls();$("sourceText").value="";$("result").textContent="";if(canvas)canvas.width=canvas.height=0;canvas=null;$("preview").replaceChildren();
    try{const decoded=await BT_OCR.image(file);if(current!==version){decoded.width=decoded.height=0;return;}canvas=decoded;$("preview").append(canvas);status("图片已读取，点击识别图片文字。");}
    catch(_){if(current===version)status("图片无法读取，请检查格式与大小（最大 20 MB）。",true);}
    finally{if(current===version){busy=false;controls();}}
  }
  $("localFile").addEventListener("change",()=>{const file=$("localFile").files[0];if(file){intent++;void open(file);}});
  document.addEventListener("paste",event=>{const file=[...event.clipboardData.items].find(item=>item.kind==="file"&&item.type.startsWith("image/"))?.getAsFile();if(file){event.preventDefault();intent++;void open(file);}});
  /** 已授权读取与手动读取复用一个有界流；初始预览仍核验来源权限，不自动识别或翻译。 */
  async function readUrl(url,permission){
    const current=++intent;cancel();const abort=new AbortController();reading=abort;busy=true;controls();
    try{
      if(!await permission){if(current===intent)status("尚未允许读取此网站，请点击读取在线图片授权，或选择本地图片。",true);return;}
      if(current!==intent||abort.signal.aborted)return;
      status("正在读取图片…");
      const response=await fetch(url.href,{credentials:"include",signal:AbortSignal.any([abort.signal,AbortSignal.timeout(60000)])});
      if(!response.ok)throw Error("图片读取失败（HTTP "+response.status+"），可下载后选择本地图片");
      if(Number(response.headers.get("content-length"))>BT_OCR.MAX_BYTES)throw Error("图片超过 20 MB，请裁剪后重试");
      const reader=response.body.getReader(),parts=[];let size=0;
      try{while(true){const value=await reader.read();if(value.done)break;size+=value.value.length;if(size>BT_OCR.MAX_BYTES)throw Error("图片超过 20 MB，请裁剪后重试");parts.push(value.value);}}catch(error){await reader.cancel();throw error;}finally{reader.releaseLock();}
      if(current===intent&&!abort.signal.aborted)await open(new Blob(parts,{type:(response.headers.get("content-type")||"").split(";")[0].trim().toLowerCase()}));
    }catch(error){if(current===intent&&!abort.signal.aborted)status(error instanceof TypeError?"在线图片读取失败，请下载后选择本地图片。":error.message||"在线图片读取失败",true);}
    finally{if(current===intent&&reading===abort){reading=null;busy=false;controls();}}
  }
  $("sourceForm").addEventListener("submit",event=>{
    event.preventDefault();let url;try{url=BT_IMAGE_DOCUMENT.sourceUrl($("sourceUrl").value);}catch(error){status(error.message,true);return;}
    // 先在直接点击链申请权限，再开始任何异步配置或网络操作。
    void readUrl(url,chrome.permissions.request({origins:[url.origin+"/*"]}));
  });
  $("recognize").addEventListener("click",async()=>{
    cancel();const current=version;busy=true;$("sourceText").value="";$("result").textContent="";controls();status("正在加载本地识别组件…");
    try{const text=await ocr.recognize(canvas,$("ocrLanguage").value,value=>status("本机识别中："+Math.round((value.progress||0)*100)+"%"));if(current!==version)return;$("sourceText").value=text;status(text?"识别完成，请校对文字后点击翻译文字。":"未识别到文字，请尝试更清晰的图片。",!text);}
    catch(error){if(current===version&&error.name!=="AbortError")status("识别失败，请检查图片或重新加载扩展后重试。",true);}
    finally{if(current===version){busy=false;controls();}}
  });
  $("translate").addEventListener("click",async()=>{
    cancel();const current=version;busy=true;token="ocr-"+crypto.randomUUID();controls();status("正在翻译校对后的文字…");
    try{const chosen=BT_SERVICES.parse($("service").value,config.aiProvider),response=await chrome.runtime.sendMessage({action:"TRANSLATE",runToken:token,...chosen,from:$("from").value,to:$("to").value,text:$("sourceText").value.trim(),retryManual:true,retryToken:crypto.randomUUID(),priority:0,pageVisible:!document.hidden});if(current!==version)return;if(!response?.ok)throw Error(response?.error||"翻译失败");$("result").textContent=response.data;BT_TRANSLATION_STYLE.apply($("result"),config.translationStyle||{});status("翻译完成。");}
    catch(error){if(current===version)status(error.message||"翻译失败",true);}
    finally{if(current===version){busy=false;controls();}}
  });
  $("sourceText").addEventListener("input",()=>{cancel();$("result").textContent="";});
  for(const field of ["service","from","to","ocrLanguage"])$(field).addEventListener("change",()=>{cancel();$("result").textContent="";status("配置已切换，请重新识别或翻译。");});
  $("cancel").addEventListener("click",()=>{intent++;cancel();status("已取消，识别文字可继续编辑。");});
  $("settings").addEventListener("click",()=>void chrome.runtime.sendMessage({action:"OPEN_SETTINGS"}));
  chrome.storage.onChanged.addListener((changes,area)=>{if(!["local","sync"].includes(area))return;if(Object.keys(changes).some(key=>["engine","from","to","aiProvider","aiKeys","baiduAppId","baiduKey","baiduVerification","requestPolicies","glossary"].includes(key))){cancel();$("result").textContent="";void refresh().catch(()=>status("配置读取失败",true));}if(changes.translationStyle){config.translationStyle=changes.translationStyle.newValue;BT_TRANSLATION_STYLE.apply($("result"),config.translationStyle||{});}});
  document.addEventListener("visibilitychange",()=>{if(token)void chrome.runtime.sendMessage({action:"SET_PAGE_STATE",runToken:token,pageVisible:!document.hidden,visible:!document.hidden,stateVersion:Date.now()}).catch(()=>{});});
  window.addEventListener("pagehide",event=>{cancel();if(!event.persisted&&canvas)canvas.width=canvas.height=0;});
  try{
    const params=new URLSearchParams(location.hash.slice(1)),initial=params.get("url");
    if(initial){
      const url=BT_IMAGE_DOCUMENT.sourceUrl(initial);$("sourceUrl").value=url.href;
      if(params.get("load")==="1")void readUrl(url,chrome.permissions.contains({origins:[url.origin+"/*"]}));
      else status("已带入图片地址，点击读取在线图片并授权后预览。");
    }
  }catch(_){status("图片地址无效，请重新填写或选择本地图片。",true);}
  await refresh().catch(()=>status("配置读取失败，请检查扩展设置",true));
})();
