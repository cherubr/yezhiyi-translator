import {getDocument,GlobalWorkerOptions} from "./vendor/build/pdf.mjs";

const $=id=>document.getElementById(id);
const {MAX_FILE_BYTES,sourceUrl,blocks,layoutRect}=self.BT_PDF_DOCUMENT;
GlobalWorkerOptions.workerSrc=chrome.runtime.getURL("pdf/vendor/build/pdf.worker.mjs");
let config={},configVersion=0,configReady=false,pdf=null,loadingTask=null,loadAbort=null,renderTask=null;
let documentVersion=0,pageVersion=0,sourceIntent=0,pageNumber=1,currentParagraphs=[],results=[],renderedPage=null;
let runVersion=0,runToken="",pageSession=false,busy=false,stateVersion=0;
let currentBlocks=[],layouts=[],pageReady=false,fitFrame=0;
const ocr=self.BT_OCR.create();let ocrBusy=false,ocrVersion=0,ocrSource=false;
const waiting=new Set(),pendingMessages=new Set();

function message(request){return chrome.runtime.sendMessage(request);}
function status(text,error=false){$("status").textContent=text;$("status").classList.toggle("error",error);}
function abortError(){return Object.assign(new Error("翻译已取消"),{name:"AbortError"});}
function controls(){
  $("previous").disabled=!pdf||pageNumber<=1;$("next").disabled=!pdf||pageNumber>=pdf.numPages;
  $("pageNumber").disabled=!pdf;$("pageNumber").value=pageNumber;
  $("translate").disabled=!configReady||!pdf||!pageReady||!currentParagraphs.length||busy||ocrBusy;
  $("translate").textContent=results.some(Boolean)?"重试 / 继续翻译":"开始翻译";
  $("cancel").disabled=!pageSession&&!busy&&!ocrBusy;
  $("recognize").disabled=!pageReady||ocrBusy||busy;
}

/** 取消只属于本阅读页的批次；旧回调、翻页和配置切换均不能写入新页面。 */
function cancel(clear=true,keepSession=false){
  runVersion++;busy=false;ocrVersion++;ocrBusy=false;ocr.cancel();
  if(runToken)void message({action:"CANCEL_TRANSLATION_REQUESTS",runToken}).catch(()=>{});
  runToken="";
  for(const reject of pendingMessages)reject(abortError());pendingMessages.clear();
  for(const resolve of waiting)resolve();waiting.clear();
  if(!keepSession)pageSession=false;
  if(clear){results=[];drawParagraphs();drawOverlays();$("blockDialog").close();}
  controls();
}

function drawParagraphs(){
  $("translations").replaceChildren();
  if(!currentParagraphs.length){
    const p=document.createElement("p");p.className="empty";
    p.textContent=pdf?"本页未提取到可翻译文字，可能是封面、扫描图片或特殊文字编码。图片文字需要 OCR。":"点击“开始翻译”，在这里查看原文与译文。";
    $("translations").append(p);return;
  }
  currentParagraphs.forEach((text,index)=>{
    const block=document.createElement("section");block.className="pdf-paragraph";
    const source=document.createElement(ocrSource?"textarea":"p");source.className="pdf-source";
    if(ocrSource){source.value=text;source.rows=5;source.maxLength=self.BT_OCR.MAX_TEXT;source.setAttribute("aria-label","校对第 "+(index+1)+" 段识别文字");source.addEventListener("input",()=>{cancel(false);currentParagraphs[index]=source.value;results=[];for(const result of document.querySelectorAll(".pdf-result")){result.textContent="待翻译";result.classList.add("pending");}drawOverlays();status("识别文字已修改，请重新开始翻译。");});}else source.textContent=text;
    const result=document.createElement("p");result.className="pdf-result bt-translation-text";result.id="result-"+index;
    result.textContent=results[index]||"待翻译";if(!results[index])result.classList.add("pending");
    applyResultStyle(result);
    block.append(source,result);$("translations").append(block);
  });
}

function applyResultStyle(result){
  const normalized=self.BT_TRANSLATION_STYLE.apply(result,config.translationStyle||{});
  result.style.lineHeight=String(normalized.lineHeight||1.85);
}

/** 切换展示方式只改变阅读界面，不重读文件、不重新发送翻译请求。 */
function updateView(){
  const layout=$("viewMode").value==="layout";
  $("workspace").classList.toggle("layout-mode",layout);
  $("workspace").setAttribute("aria-label",layout?"PDF 原版式译文":"PDF 双语对照");
  $("layoutTools").hidden=!layout;
  $("originalHeading").textContent=layout?"原版式译文":"原 PDF";
  $("pdfOverlays").hidden=!layout||$("showOriginal").checked;
  scheduleFit();
}

function scheduleFit(){
  cancelAnimationFrame(fitFrame);
  fitFrame=requestAnimationFrame(()=>{
    if($("pdfOverlays").hidden)return;
    const width=$("pdfPage").clientWidth;
    for(const box of $("pdfOverlays").children){
      const rect=layouts[Number(box.dataset.index)],text=box.firstElementChild;
      if(!rect||!width)continue;
      // 以原字号为上限，缩小至可读下限；仍放不下时提供完整段落弹窗。
      let low=Math.min(7,rect.fontSize*width),high=Math.max(low,rect.fontSize*width);
      for(let count=0;count<9;count++){
        const size=(low+high)/2;text.style.fontSize=size+"px";
        if(text.scrollHeight<=box.clientHeight&&text.scrollWidth<=box.clientWidth)low=size;else high=size;
      }
      text.style.fontSize=low+"px";
      const overflow=text.scrollHeight>box.clientHeight||text.scrollWidth>box.clientWidth;
      box.classList.toggle("needs-detail",overflow);
      box.title=(overflow?"译文较长，点击查看完整内容\n":"点击查看原文与完整译文\n")+results[Number(box.dataset.index)];
    }
  });
}

/** 采样当前画布的主要底色，避免深色页面统一变成白块；复杂背景仅作近似。 */
function prepareLayouts(content,viewport){
  layouts=currentBlocks.map(block=>layoutRect(block,content.items,content.styles,viewport));
  const canvas=$("pdfCanvas"),pixels=canvas.getContext("2d").getImageData(0,0,canvas.width,canvas.height).data;
  for(const rect of layouts){
    if(!rect)continue;
    const colors=new Map();
    for(let row=0;row<11;row++)for(let column=0;column<11;column++){
      const x=Math.min(canvas.width-1,Math.floor((rect.left+rect.width*(column+.5)/11)*viewport.width));
      const y=Math.min(canvas.height-1,Math.floor((rect.top+rect.height*(row+.5)/11)*viewport.height));
      const offset=(y*canvas.width+x)*4,r=pixels[offset],g=pixels[offset+1],b=pixels[offset+2];
      const key=(r>>4)+","+(g>>4)+","+(b>>4),color=colors.get(key)||{count:0,r:0,g:0,b:0};
      color.count++;color.r+=r;color.g+=g;color.b+=b;colors.set(key,color);
    }
    const color=[...colors.values()].sort((a,b)=>b.count-a.count)[0];
    const rgb=[color.r,color.g,color.b].map(value=>Math.round(value/color.count));
    rect.background="rgb("+rgb.join(",")+")";
    rect.foreground=rgb[0]*.299+rgb[1]*.587+rgb[2]*.114>145?"#17202b":"#fff";
  }
}

function drawOverlays(){
  $("pdfOverlays").replaceChildren();
  let missing=0;
  if(pageReady)results.forEach((translation,index)=>{
    if(!translation)return;
    const rect=layouts[index];if(!rect){missing++;return;}
    const box=document.createElement("button"),text=document.createElement("span");
    box.type="button";box.className="pdf-overlay";box.dataset.index=String(index);
    box.style.left=rect.left*100+"%";box.style.top=rect.top*100+"%";
    box.style.width=rect.width*100+"%";box.style.height=rect.height*100+"%";
    box.style.background=rect.background;box.style.color=rect.foreground;
    text.textContent=translation;text.dir="auto";box.append(text);$("pdfOverlays").append(box);
  });
  $("layoutHint").textContent="译文按原文字区域展示，背景采用近似填色。点击文字块查看完整译文；虚线框表示文字未能完整放入。"+
    (missing?"本页有 "+missing+" 段旋转或特殊文字无法可靠定位，请切回左右对照查看。":"复杂版式可切回左右对照。");
  scheduleFit();
}

function clearLayout(){
  currentBlocks=[];layouts=[];pageReady=false;ocrSource=false;$("pdfOverlays").replaceChildren();$("blockDialog").close();
}

async function refreshConfig(){
  const version=++configVersion;configReady=false;controls();
  const loaded=await self.BT_STORAGE.get();
  if(version!==configVersion)return;
  config={...self.BT_CONST.DEFAULTS,...loaded};configReady=true;
  self.BT_SERVICES.renderSelect($("service"),config);
  self.BT_CONST.fillLanguageSelect($("from"),"from",config.from);
  self.BT_CONST.fillLanguageSelect($("to"),"to",config.to);
  controls();
}

/** 限制单个文件及解码画布大小；不把整份 PDF、URL 或元数据传给翻译服务。 */
async function readResponse(response,signal){
  if(!response.ok)throw Error("PDF 读取失败（HTTP "+response.status+"），可下载文件后选择本地 PDF");
  if(Number(response.headers.get("content-length"))>MAX_FILE_BYTES)throw Error("PDF 超过 50 MB，请使用较小的文件");
  const reader=response.body.getReader(),chunks=[];let length=0;
  try{
    while(true){
      const {done,value}=await reader.read();if(done)break;
      length+=value.length;if(length>MAX_FILE_BYTES)throw Error("PDF 超过 50 MB，请使用较小的文件");
      chunks.push(value);if(signal.aborted)throw abortError();
    }
  }catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
  const data=new Uint8Array(length);let offset=0;
  for(const chunk of chunks){data.set(chunk,offset);offset+=chunk.length;}
  return data;
}

async function openDocument(getData,name){
  const version=++documentVersion;pageVersion++;cancel();
  clearLayout();
  loadAbort?.abort();renderTask?.cancel();
  const oldTask=loadingTask;loadingTask=null;pdf=null;currentParagraphs=[];
  if(oldTask)void oldTask.destroy().catch(()=>{});
  $("pdfCanvas").hidden=true;$("emptyOriginal").hidden=false;$("emptyOriginal").textContent="正在读取 PDF…";
  $("pageCount").textContent="—";$("filename").textContent=name;drawParagraphs();controls();
  loadAbort=new AbortController();const signal=loadAbort.signal;
  status("正在读取 PDF，文件不会上传至页知译服务器。");
  try{
    const data=await getData(signal);
    if(version!==documentVersion)return;
    const signature=new TextDecoder("latin1").decode(data.subarray(0,1024));
    if(!signature.includes("%PDF-"))throw Error("读取到的不是 PDF，链接可能跳转到了登录页。请下载后选择本地 PDF");
    loadingTask=getDocument({data,isEvalSupported:false,verbosity:0,
      cMapUrl:chrome.runtime.getURL("pdf/vendor/cmaps/"),cMapPacked:true,
      standardFontDataUrl:chrome.runtime.getURL("pdf/vendor/standard_fonts/"),
      wasmUrl:chrome.runtime.getURL("pdf/vendor/wasm/"),iccUrl:chrome.runtime.getURL("pdf/vendor/iccs/")});
    const loaded=await loadingTask.promise;
    if(version!==documentVersion){await loaded.destroy();return;}
    pdf=loaded;pageNumber=1;$("pageCount").textContent=String(pdf.numPages);$("pageNumber").max=String(pdf.numPages);
    await showPage(1);
  }catch(error){
    if(version!==documentVersion||signal.aborted)return;
    const text=error.name==="PasswordException"?"此 PDF 需要密码，请先解锁文件后重新选择。":
      error.name==="TimeoutError"?"PDF 读取超时，请检查网络，或下载后选择本地 PDF":
      error instanceof TypeError?"PDF 读取失败，请检查网络与网站授权；需要登录的文件可下载后选择本地 PDF":error.message||"PDF 无法读取，请检查文件";
    status(text,true);$("emptyOriginal").textContent="PDF 未能打开";
  }finally{if(version===documentVersion)controls();}
}

async function showPage(number){
  if(!pdf)return;
  number=Math.max(1,Math.min(pdf.numPages,Math.trunc(Number(number)||1)));
  const version=++pageVersion,doc=pdf;
  clearLayout();
  cancel(true,true);currentParagraphs=[];results=[];pageNumber=number;controls();drawParagraphs();
  const previousRender=renderTask;previousRender?.cancel();status("正在解析第 "+number+" 页…");
  try{
    if(previousRender)await previousRender.promise.catch(()=>{});
    if(version!==pageVersion)return;
    renderedPage?.cleanup();renderedPage=null;
    const page=await doc.getPage(number);
    if(version!==pageVersion)return;
    const content=await page.getTextContent();
    if(version!==pageVersion)return;
    currentBlocks=blocks(content.items);currentParagraphs=currentBlocks.map(block=>block.text);drawParagraphs();
    const base=page.getViewport({scale:1});
    // 两种阅读方式共用同一张清晰画布，切换模式时只由 CSS 缩放。
    const width=Math.max(280,Math.min(1200,$("workspace").clientWidth-26));
    const scale=Math.min(width/base.width,Math.sqrt(8000000/(base.width*base.height)));
    const viewport=page.getViewport({scale:Math.min(scale*window.devicePixelRatio,Math.sqrt(8000000/(base.width*base.height)))});
    const canvas=$("pdfCanvas");canvas.width=Math.ceil(viewport.width);canvas.height=Math.ceil(viewport.height);
    $("pdfPage").style.width=Math.min(width,base.width*scale)+"px";canvas.hidden=false;$("emptyOriginal").hidden=true;
    renderedPage=page;
    renderTask=page.render({canvasContext:canvas.getContext("2d"),viewport});await renderTask.promise;
    if(version!==pageVersion)return;
    prepareLayouts(content,viewport);pageReady=true;drawOverlays();
    status(currentParagraphs.length?"第 "+number+" 页，共 "+currentParagraphs.length+" 段可翻译文字。":"本页没有可提取的文字；可点击“识别本页文字”，在本机识别扫描文字。");
    controls();
    if(pageSession&&currentParagraphs.length)void translatePage();
  }catch(error){
    if(version===pageVersion&&error.name!=="RenderingCancelledException"){controls();status("本页解析或显示失败，请尝试其他页或文件",true);}
  }
}

function notifyVisibility(){
  if(runToken)void message({action:"SET_PAGE_STATE",pageVisible:!document.hidden,visible:!document.hidden,stateVersion:++stateVersion,viewportEpoch:pageVersion}).catch(()=>{});
  if(!document.hidden){for(const resolve of waiting)resolve();waiting.clear();}
}

async function translatePage(){
  if(!configReady||!pageReady||busy||ocrBusy||!currentParagraphs.some(text=>text.trim()))return;
  pageSession=true;busy=true;const version=++runVersion,page=pageVersion;
  runToken="pdf-"+crypto.randomUUID();const token=runToken;
  const chosen=self.BT_SERVICES.parse($("service").value,config.aiProvider);
  const snapshot={...chosen,from:$("from").value,to:$("to").value,aiConfig:{...(config.aiKeys?.[chosen.aiProvider]||{})}};
  const policy=self.BT_REQUEST_POLICY.resolve(snapshot.engine,snapshot.aiProvider,config.requestPolicies);
  const retryToken=crypto.randomUUID();let next=0,done=results.filter(Boolean).length,failed=0;
  controls();notifyVisibility();
  const active=()=>version===runVersion&&page===pageVersion;
  async function worker(){
    while(active()){
      if(document.hidden)await new Promise(resolve=>waiting.add(resolve));
      if(!active())return;
      const index=next++;if(index>=currentParagraphs.length)return;
      if(!currentParagraphs[index].trim())continue;
      if(results[index])continue;
      const result=$("result-"+index);result.textContent="正在翻译…";result.classList.remove("error");result.classList.add("pending");
      try{
        const data=await new Promise((resolve,reject)=>{
          const stop=error=>reject(error);pendingMessages.add(stop);
          message({action:"TRANSLATE",runToken:token,...snapshot,text:currentParagraphs[index],
            retryManual:true,retryToken,pageVisible:!document.hidden,viewportEpoch:page,stateVersion,priority:1})
            .then(response=>{
              if(!response?.ok)throw Object.assign(new Error(response?.error||"翻译失败"),{name:response?.cancelled?"AbortError":"Error"});
              if(typeof response.data!=="string"||!response.data.trim())throw Error("服务返回了空译文");
              resolve(response.data);
            }).catch(reject).finally(()=>pendingMessages.delete(stop));
        });
        if(!active())return;
        results[index]=data;done++;result.textContent=data;result.classList.remove("pending");drawOverlays();
      }catch(error){
        if(!active()||error.name==="AbortError")return;
        failed++;result.textContent=error.message;result.classList.remove("pending");result.classList.add("error");
      }
      if(active())status("第 "+pageNumber+" 页：已翻译 "+done+" / "+currentParagraphs.length+" 段"+(failed?"，失败 "+failed+" 段，可点击重试":""),failed>0);
    }
  }
  await Promise.all(Array.from({length:Math.min(policy.maxConcurrent,currentParagraphs.length)},worker));
  if(active()){busy=false;controls();status(failed?"部分段落未完成，点击“重试 / 继续翻译”可重试失败段落。":"本页翻译完成，翻页后将继续翻译。",failed>0);}
}

$("sourceForm").addEventListener("submit",event=>{
  event.preventDefault();let url;
  try{url=sourceUrl($("sourceUrl").value);}catch(error){status(error.message,true);return;}
  // 权限请求直接来自点击；读取配置和网络之前发起，授权仅限用户填写的来源。
  const permission=chrome.permissions.request({origins:[url.origin+"/*"]});
  const intent=++sourceIntent;
  void (async()=>{
    if(!await permission){if(intent===sourceIntent)status("尚未允许读取此网站，请重新读取并授权，或选择本地 PDF",true);return;}
    if(intent!==sourceIntent)return;
    let name=url.pathname.split("/").pop()||"在线 PDF";
    try{name=decodeURIComponent(name);}catch(_){}
    await openDocument(async signal=>{
      const timedSignal=AbortSignal.any([signal,AbortSignal.timeout(60000)]);
      return readResponse(await fetch(url.href,{signal:timedSignal,credentials:"include"}),timedSignal);
    },name);
  })().catch(()=>status("未能获取网站读取权限，请重试或选择本地 PDF",true));
});
$("localFile").addEventListener("change",()=>{
  const file=$("localFile").files[0];if(!file)return;
  sourceIntent++;
  if(file.size>MAX_FILE_BYTES){status("PDF 超过 50 MB，请使用较小的文件",true);return;}
  void openDocument(async()=>new Uint8Array(await file.arrayBuffer()),file.name);
});
$("recognize").addEventListener("click",async()=>{
  cancel();ocrBusy=true;const current=ocrVersion,page=pageVersion;controls();status("正在加载本地 OCR，识别当前页…");
  try{
    const text=await ocr.recognize($("pdfCanvas"),$("ocrLanguage").value,value=>status("本机识别当前页："+Math.round((value.progress||0)*100)+"%"));
    if(current!==ocrVersion||page!==pageVersion)return;
    if(!text){status("未识别到文字，请尝试清晰的扫描件。",true);return;}
    currentParagraphs=text.split(/\n\s*\n/u).map(value=>value.trim()).filter(Boolean);results=[];currentBlocks=[];layouts=[];ocrSource=true;
    $("viewMode").value="parallel";updateView();drawParagraphs();drawOverlays();status("识别完成，请在右侧校对文字，再点击开始翻译。OCR 文字使用左右对照查看。");
  }catch(error){if(current===ocrVersion&&error.name!=="AbortError")status("识别失败，请重试或换用清晰的扫描件。",true);}
  finally{if(current===ocrVersion){ocrBusy=false;controls();}}
});
$("ocrLanguage").addEventListener("change",()=>{if(ocrBusy){cancel(false);status("识别语言已切换，请重新识别。");}});
$("previous").addEventListener("click",()=>void showPage(pageNumber-1));
$("next").addEventListener("click",()=>void showPage(pageNumber+1));
$("pageNumber").addEventListener("change",()=>void showPage($("pageNumber").value));
$("translate").addEventListener("click",()=>void translatePage());
$("cancel").addEventListener("click",()=>{cancel();status("已取消翻译；翻页不会自动发送文字，可再次点击开始翻译。");});
$("settings").addEventListener("click",()=>void message({action:"OPEN_SETTINGS"}));
$("viewMode").addEventListener("change",updateView);
$("showOriginal").addEventListener("change",updateView);
new ResizeObserver(scheduleFit).observe($("pdfPage"));
$("pdfOverlays").addEventListener("click",event=>{
  const box=event.target.closest(".pdf-overlay");if(!box)return;
  const index=Number(box.dataset.index);
  $("blockSource").textContent=currentParagraphs[index];$("blockTranslation").textContent=results[index];
  $("blockDialog").showModal();
});
$("closeBlock").addEventListener("click",()=>$("blockDialog").close());
for(const id of ["service","from","to"])$(id).addEventListener("change",()=>{
  cancel();status("已切换本阅读页的翻译配置，点击开始翻译后生效。");
});
chrome.storage.onChanged.addListener((changes,area)=>{
  if(!["sync","local"].includes(area))return;
  if(Object.keys(changes).some(key=>["engine","aiProvider","aiKeys","baiduAppId","baiduKey","baiduVerification","from","to","requestPolicies","glossary"].includes(key))){
    cancel();void refreshConfig().then(()=>status("设置已更新，旧翻译已取消，请重新开始。")).catch(()=>status("读取配置失败，请打开设置检查",true));
  }
  if(changes.translationStyle){
    config.translationStyle=changes.translationStyle.newValue;
    for(const result of document.querySelectorAll(".pdf-result"))applyResultStyle(result);
  }
});
document.addEventListener("visibilitychange",notifyVisibility);
window.addEventListener("pagehide",()=>{cancel(false);loadAbort?.abort();});
try{
  const initial=new URLSearchParams(location.hash.slice(1)).get("url");
  if(initial)$("sourceUrl").value=sourceUrl(initial).href;
}catch(_){status("PDF 地址无效，请重新填写或选择本地文件。",true);}
await refreshConfig().catch(()=>status("读取翻译配置失败，请重新打开阅读页或检查扩展设置",true));controls();
