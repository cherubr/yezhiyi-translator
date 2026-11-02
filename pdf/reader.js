import {getDocument,GlobalWorkerOptions,OPS} from "./vendor/build/pdf.mjs";
import {createTextRecorder,matchTextOperations,createTextFilter} from "./layout-renderer.mjs";

const $=id=>document.getElementById(id);
const {MAX_FILE_BYTES,sourceUrl,blocks,layoutRect}=self.BT_PDF_DOCUMENT;
GlobalWorkerOptions.workerSrc=chrome.runtime.getURL("pdf/vendor/build/pdf.worker.mjs");
let config={},configVersion=0,configReady=false,pdf=null,loadingTask=null,loadAbort=null,renderTask=null;
let documentVersion=0,pageVersion=0,sourceIntent=0,pageNumber=1,currentParagraphs=[],results=[],renderedPage=null;
let runVersion=0,runToken="",pageSession=false,busy=false,stateVersion=0;
let pageFinished=false,resumeProgress=null,batchRefreshCache=false,layoutProblem="";
let currentBlocks=[],layouts=[],pageReady=false,fitFrame=0,layoutViewport=null;
let layoutMatches={byBlock:new Map(),styles:new Map()},layoutTask=null,layoutJob=null,layoutRevision=0,displayedResults=[];
let paintedOperations=null;
const overlayNodes=new Map();
const waiting=new Set(),pendingMessages=new Set();

function message(request){return chrome.runtime.sendMessage(request);}
function status(text,error=false){$("status").textContent=text;$("status").classList.toggle("error",error);}
function abortError(){return Object.assign(new Error("翻译已取消"),{name:"AbortError"});}
function controls(){
  $("previous").disabled=!pdf||pageNumber<=1;$("next").disabled=!pdf||pageNumber>=pdf.numPages;
  $("pageNumber").disabled=!pdf;$("pageNumber").value=pageNumber;
  $("translate").disabled=!configReady||!pdf||!pageReady||!currentBlocks.some(block=>block.translate!==false&&block.text.trim())||busy;
  $("translate").textContent=busy?"正在翻译…":resumeProgress?"继续翻译":pageFinished?"重新翻译":"开始翻译";
  $("translate").classList.toggle("is-translating",busy);
  $("translate").setAttribute("aria-busy",String(busy));
  $("cancel").disabled=!pageSession&&!busy;
}

/** 取消只属于本阅读页的批次；旧回调、翻页和配置切换均不能写入新页面。 */
function cancel(clear=true,keepSession=false,rememberProgress=false){
  if(rememberProgress&&pageReady)resumeProgress={documentVersion,pageVersion,results:results.slice(),refreshCache:batchRefreshCache};
  else if(clear){resumeProgress=null;pageFinished=false;}
  runVersion++;busy=false;
  if(runToken)void message({action:"CANCEL_TRANSLATION_REQUESTS",runToken}).catch(()=>{});
  runToken="";
  for(const reject of pendingMessages)reject(abortError());pendingMessages.clear();
  for(const resolve of waiting)resolve();waiting.clear();
  if(!keepSession)pageSession=false;
  if(clear){results=[];layoutTask?.cancel();drawParagraphs();if(pageReady){copyOriginal();paintOverlays([]);}void drawOverlays();$("blockDialog").close();}
  controls();
}

function drawParagraphs(){
  $("translations").replaceChildren();
  if(!currentParagraphs.length){
    const p=document.createElement("p");p.className="empty";
    p.textContent=pdf?"本页没有可提取的文字，可能是扫描图片、封面或特殊文字编码；当前仅支持可提取文字的 PDF 页面。":"点击“开始翻译”，在这里查看原文与译文。";
    $("translations").append(p);return;
  }
  const tables=new Map();
  currentParagraphs.forEach((text,index)=>{
    const unit=currentBlocks[index],kind=unit?.kind||"paragraph";
    const block=document.createElement("section");block.className="pdf-paragraph pdf-"+kind;
    if(kind==="heading"){block.dataset.level=unit.level;if(unit.centered)block.classList.add("centered");}
    if(unit?.translate===false){
      const original=document.createElement(kind==="code"?"pre":"p");original.className=kind==="code"?"pdf-code-text":"pdf-metadata-text";original.textContent=text;
      if(unit.centered)block.classList.add("centered");block.append(original);$("translations").append(block);return;
    }
    const source=document.createElement("p");source.className="pdf-source";source.textContent=text;
    const result=document.createElement(kind==="heading"?"h2":"p");result.className="pdf-result bt-translation-text";result.id="result-"+index;
    result.textContent=results[index]||"待翻译";if(!results[index])result.classList.add("pending");
    applyResultStyle(result);
    block.append(source,result);
    if(unit?.table){
      let cells=tables.get(unit.table.id);
      if(!cells){cells=drawTable(unit.table);tables.set(unit.table.id,cells);}
      cells.get(unit.table.row+":"+unit.table.column).append(block);
    }else $("translations").append(block);
  });
}

/** 表格单元格仍绑定原来的结果索引，切换视图和异步返回不会错位。 */
function drawTable(table){
  const wrapper=document.createElement("div");wrapper.className="pdf-table-wrap";
  const element=document.createElement("table"),cols=document.createElement("colgroup"),body=document.createElement("tbody"),cells=new Map(),covered=new Set();
  const units=currentBlocks.filter(block=>block.table?.id===table.id);
  for(let column=0;column<table.columns;column++){
    const col=document.createElement("col");col.style.width=(table.widths[column]*100)+"%";cols.append(col);
  }
  for(let row=0;row<table.rows;row++){
    const tr=document.createElement("tr");
    for(let column=0;column<table.columns;column++){
      const key=row+":"+column;if(covered.has(key))continue;
      const unit=units.find(block=>block.table.row===row&&block.table.column===column);
      const cell=document.createElement(unit?.table.header?"th":"td");
      if(unit?.table.header)cell.scope="col";
      cell.rowSpan=unit?.table.rowSpan||1;
      for(let offset=1;offset<cell.rowSpan;offset++)covered.add((row+offset)+":"+column);
      cells.set(key,cell);tr.append(cell);
    }
    body.append(tr);
  }
  element.append(cols,body);wrapper.append(element);$("translations").append(wrapper);return cells;
}

function applyResultStyle(result){
  const normalized=self.BT_TRANSLATION_STYLE.apply(result,config.translationStyle||{});
  result.style.lineHeight=String(normalized.lineHeight||1.75);
}

/** 切换展示方式只改变阅读界面，不重读文件、不重新发送翻译请求。 */
function updateView(){
  const layout=$("viewMode").value==="layout";
  $("workspace").classList.toggle("layout-mode",layout);
  $("workspace").setAttribute("aria-label",layout?"PDF 原版式译文":"PDF 双语对照");
  if(!layout)$("showOriginal").checked=false;
  $("pdfOverlays").hidden=$("showOriginal").checked;
  renderLayoutTools();
  if(pageReady)void drawOverlays();
  scheduleFit();
}

/** 左右对照已有左侧原页，只显示需要用户处理的特殊情况。 */
function renderLayoutTools(){
  const single=$("viewMode").value==="layout";
  $("originalToggle").hidden=!single;
  $("layoutTools").hidden=!single&&!layoutProblem;
  $("layoutHint").textContent=(single?"保留原 PDF 图形和排版，点击译文查看完整内容；虚线框表示译文未能完整放入。":"")+layoutProblem;
}

function scheduleFit(){
  cancelAnimationFrame(fitFrame);
  fitFrame=requestAnimationFrame(()=>{
    if($("pdfOverlays").hidden)return;
    const width=$("translatedPage").clientWidth;
    for(const [index,box]of overlayNodes)fitOverlay(box,layouts[index],width,displayedResults[index]);
  });
}

/** 在发布节点前同步适配字号；窗口缩放才重新测量已有节点，避免默认字号闪现。 */
function fitOverlay(box,rect,width,translation){
  if(!rect||!width)return;
  const text=box.firstElementChild,base=rect.fontSize*width;
  if(!(base>0))return;
  if(box.dataset.fitWidth===String(width))return;
  // 正文最多缩小约四分之一；本身很小的图注不强行放大，放不下可查看全文。
  let low=Math.min(base,Math.max(7,base*.75)),high=base;
  text.style.fontSize=high+"px";
  if(text.scrollHeight>box.clientHeight||text.scrollWidth>box.clientWidth){
    for(let count=0;count<9;count++){
      const size=(low+high)/2;text.style.fontSize=size+"px";
      if(text.scrollHeight<=box.clientHeight&&text.scrollWidth<=box.clientWidth)low=size;else high=size;
    }
    text.style.fontSize=low+"px";
  }
  const overflow=text.scrollHeight>box.clientHeight||text.scrollWidth>box.clientWidth;
  box.classList.toggle("needs-detail",overflow);
  box.title=(overflow?"译文较长，点击查看完整内容\n":"点击查看原文与完整译文\n")+translation;
  box.dataset.fitWidth=String(width);box.style.visibility="";
}

/** 透明文字层不涂底色，框线、图片、箭头和复杂背景都由原 PDF 绘制。 */
function paintOverlays(snapshot){
  const wanted=new Set(),width=$("translatedPage").clientWidth;
  let missing=0;
  if(pageReady)snapshot.forEach((translation,index)=>{
    if(!translation)return;
    const rect=layouts[index];if(!rect||!layoutMatches.byBlock.has(index)){missing++;return;}
    wanted.add(index);
    const previous=overlayNodes.get(index);
    if(previous?.firstElementChild.textContent===translation){fitOverlay(previous,rect,width,translation);return;}
    const box=document.createElement("button"),text=document.createElement("span");
    box.type="button";box.className="pdf-overlay";box.dataset.index=String(index);
    box.style.visibility="hidden";
    box.style.left=rect.left*100+"%";box.style.top=rect.top*100+"%";
    box.style.width=rect.width*100+"%";box.style.height=rect.height*100+"%";
    const style=layoutMatches.styles.get(index);
    box.style.color=style?.color||"#17202b";
    if(style?.bold||currentBlocks[index].kind==="heading")box.style.fontWeight="600";
    if(currentBlocks[index].centered||currentBlocks[index].kind==="label")box.style.textAlign="center";
    text.textContent=translation;text.dir="auto";box.append(text);$("pdfOverlays").append(box);
    fitOverlay(box,rect,width,translation);
    if(previous){if(document.activeElement===previous)box.focus({preventScroll:true});previous.remove();}
    overlayNodes.set(index,box);
  });
  for(const [index,box]of overlayNodes)if(!wanted.has(index)){box.remove();overlayNodes.delete(index);}
  displayedResults=snapshot;
  layoutProblem=missing?"本页有 "+missing+" 段不能安全替换，已保留原文，请展开“文字译文与失败详情”查看。":"";
  renderLayoutTools();
}

function copyOriginal(){
  const canvas=$("translatedCanvas"),source=$("pdfCanvas");
  if(canvas.width!==source.width||canvas.height!==source.height){canvas.width=source.width;canvas.height=source.height;}
  const context=canvas.getContext("2d");context.clearRect(0,0,canvas.width,canvas.height);context.drawImage(source,0,0);
  paintedOperations="";
}

/** 合并连续完成的结果，串行绘制临时画布；只发布当前页、当前批次的完整画面。 */
function drawOverlays(){
  layoutRevision++;
  if(!pageReady){overlayNodes.clear();$("pdfOverlays").replaceChildren();return Promise.resolve();}
  if(layoutJob)return layoutJob;
  const job=(async()=>{
    while(pageReady){
      const revision=layoutRevision,page=pageVersion,run=runVersion,source=renderedPage;
      const snapshot=results.slice(),original=$("showOriginal").checked;
      const suppressed=new Set();
      if(!original)snapshot.forEach((value,index)=>{if(value)for(const op of layoutMatches.byBlock.get(index)||[])suppressed.add(op);});
      const operationsKey=Array.from(suppressed).join(",");
      $("translatedPage").dataset.paintState="rendering";
      if(operationsKey===paintedOperations)paintOverlays(original?[]:snapshot);
      else if(!suppressed.size){copyOriginal();paintOverlays(original?[]:snapshot);}
      else{
        const scratch=document.createElement("canvas"),filter=createTextFilter(OPS,suppressed);
        scratch.width=$("pdfCanvas").width;scratch.height=$("pdfCanvas").height;
        try{
          layoutTask=source.render({canvasContext:scratch.getContext("2d"),viewport:layoutViewport,operationsFilter:filter.filter});
          await layoutTask.promise;
          if(pageReady&&page===pageVersion&&run===runVersion&&revision===layoutRevision){
            $("translatedCanvas").getContext("2d").drawImage(scratch,0,0);paintedOperations=operationsKey;paintOverlays(snapshot);
          }
        }catch(error){
          if(pageReady&&page===pageVersion&&run===runVersion&&revision===layoutRevision&&error.name!=="RenderingCancelledException"){
            copyOriginal();paintOverlays([]);layoutProblem="本页译文绘制失败，原 PDF 已保留；请展开文字译文查看结果，或重新翻译。";renderLayoutTools();
          }
        }finally{filter.restore();layoutTask=null;scratch.width=0;scratch.height=0;}
      }
      if(revision===layoutRevision){$("translatedPage").dataset.paintState="ready";break;}
      await new Promise(resolve=>setTimeout(resolve,40));
    }
  })();
  layoutJob=job;
  void job.finally(()=>{if(layoutJob===job)layoutJob=null;});
  return job;
}

function clearLayout(){
  currentBlocks=[];layouts=[];pageReady=false;layoutRevision++;layoutTask?.cancel();displayedResults=[];
  overlayNodes.clear();paintedOperations=null;cancelAnimationFrame(fitFrame);
  layoutMatches={byBlock:new Map(),styles:new Map()};$("pdfOverlays").replaceChildren();$("blockDialog").close();
  $("translatedCanvas").hidden=true;$("emptyTranslation").hidden=false;$("textDetails").open=false;
  layoutProblem="";renderLayoutTools();
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
  $("pageCount").textContent="—";$("filename").textContent=name;$("filename").title=name;drawParagraphs();controls();
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
    if(layoutJob)await layoutJob.catch(()=>{});
    if(version!==pageVersion)return;
    renderedPage?.cleanup();renderedPage=null;
    const page=await doc.getPage(number);
    if(version!==pageVersion)return;
    const content=await page.getTextContent();
    if(version!==pageVersion)return;
    currentBlocks=blocks(content.items,content.styles);currentParagraphs=currentBlocks.map(block=>block.text);drawParagraphs();
    const base=page.getViewport({scale:1});
    // 原文、译文和临时绘制画布合计控制在约八百万像素，仅保留当前页。
    const width=Math.max(280,Math.min(1200,$("workspace").clientWidth-26));
    const scale=Math.min(width/base.width,Math.sqrt(8000000/3/(base.width*base.height)));
    const viewport=page.getViewport({scale:Math.min(scale*window.devicePixelRatio,Math.sqrt(8000000/3/(base.width*base.height)))});
    const canvas=$("pdfCanvas");canvas.width=Math.ceil(viewport.width);canvas.height=Math.ceil(viewport.height);
    const pageWidth=Math.min(width,base.width*scale)+"px";
    $("pdfPage").style.width=pageWidth;$("translatedPage").style.width=pageWidth;canvas.hidden=false;$("emptyOriginal").hidden=true;
    renderedPage=page;
    const recorder=createTextRecorder(OPS);
    renderTask=page.render({canvasContext:canvas.getContext("2d"),viewport,recordOperations:true,operationsFilter:recorder.filter});await renderTask.promise;
    if(version!==pageVersion)return;
    layouts=currentBlocks.map(block=>layoutRect(block,content.items,content.styles,viewport));layoutViewport=viewport;
    layoutMatches=matchTextOperations({items:content.items,blocks:currentBlocks,layouts,operations:recorder.operations,bboxes:page.recordedBBoxes,
      fontFor:name=>{try{return page.commonObjs.get(name);}catch(_){return null;}}});
    copyOriginal();$("translatedCanvas").hidden=false;$("emptyTranslation").hidden=true;
    $("canvasContainer").scrollTop=0;$("translatedContainer").scrollTop=0;pageReady=true;await drawOverlays();
    const translatable=currentBlocks.filter(block=>block.translate!==false).length;
    status(currentParagraphs.length?"第 "+number+" 页，共 "+translatable+" 段可翻译文字。"+(translatable<currentBlocks.length?"作者信息、联系方式和代码保留原文。":""):"本页没有可提取的文字，当前不支持扫描图片页面的文字识别。");
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

async function translatePage(refresh=false,resume=false){
  if(!configReady||!pageReady||busy||!currentBlocks.some(block=>block.translate!==false&&block.text.trim()))return;
  // 取消后的续翻只恢复当前页成功结果；完成后的重译仍刷新全部段落。
  if(resume){
    const saved=resumeProgress;
    if(!saved||saved.documentVersion!==documentVersion||saved.pageVersion!==pageVersion){resumeProgress=null;controls();return;}
    results=saved.results;refresh=saved.refreshCache;resumeProgress=null;drawParagraphs();
  }else if(refresh)cancel(true,true);
  batchRefreshCache=refresh;pageFinished=false;
  pageSession=true;busy=true;const version=++runVersion,page=pageVersion;
  runToken="pdf-"+crypto.randomUUID();const token=runToken;
  const chosen=self.BT_SERVICES.parse($("service").value,config.aiProvider);
  const snapshot={...chosen,from:$("from").value,to:$("to").value,aiConfig:{...(config.aiKeys?.[chosen.aiProvider]||{})}};
  const policy=self.BT_REQUEST_POLICY.resolve(snapshot.engine,snapshot.aiProvider,config.requestPolicies);
  const retryToken=crypto.randomUUID(),total=currentBlocks.filter(block=>block.translate!==false&&block.text.trim()).length;let next=0,done=results.filter(Boolean).length,failed=0;
  controls();notifyVisibility();status("正在翻译第 "+pageNumber+" 页…");
  if(resume)void drawOverlays();
  const active=()=>version===runVersion&&page===pageVersion;
  async function worker(){
    while(active()){
      if(document.hidden)await new Promise(resolve=>waiting.add(resolve));
      if(!active())return;
      const index=next++;if(index>=currentParagraphs.length)return;
      if(currentBlocks[index]?.translate===false)continue;
      if(!currentParagraphs[index].trim())continue;
      if(results[index])continue;
      const result=$("result-"+index);result.textContent="正在翻译…";result.classList.remove("error");result.classList.add("pending");
      try{
        const data=await new Promise((resolve,reject)=>{
          const stop=error=>reject(error);pendingMessages.add(stop);
          message({action:"TRANSLATE",runToken:token,...snapshot,text:currentParagraphs[index],
            retryManual:true,retryToken,refreshCache:refresh,pageVisible:!document.hidden,viewportEpoch:page,stateVersion,priority:1})
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
      if(active())status("第 "+pageNumber+" 页：已翻译 "+done+" / "+total+" 段"+(failed?"，失败 "+failed+" 段":""),failed>0);
    }
  }
  await Promise.all(Array.from({length:Math.min(policy.maxConcurrent,total)},worker));
  if(active())await drawOverlays();
  if(active()){busy=false;pageFinished=true;controls();status(failed?"本页有 "+failed+" 段翻译失败，可点击“重新翻译”重译本页。":"本页翻译完成，翻页后将继续翻译。",failed>0);}
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
$("previous").addEventListener("click",()=>void showPage(pageNumber-1));
$("next").addEventListener("click",()=>void showPage(pageNumber+1));
$("pageNumber").addEventListener("change",()=>void showPage($("pageNumber").value));
$("translate").addEventListener("click",()=>void translatePage(!resumeProgress,!!resumeProgress));
$("cancel").addEventListener("click",()=>{cancel(true,false,true);status(resumeProgress?"已取消翻译并恢复原文；点击“继续翻译”可恢复本页进度，翻页不会自动发送文字。":"已取消翻译；翻页不会自动发送文字，可再次点击开始翻译。");});
$("settings").addEventListener("click",()=>void message({action:"OPEN_SETTINGS"}));
$("viewMode").addEventListener("change",updateView);
$("showOriginal").addEventListener("change",updateView);
new ResizeObserver(scheduleFit).observe($("translatedPage"));
$("pdfOverlays").addEventListener("click",event=>{
  const box=event.target.closest(".pdf-overlay");if(!box)return;
  const index=Number(box.dataset.index);
  $("blockSource").textContent=currentParagraphs[index];$("blockTranslation").textContent=displayedResults[index];
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
// 两页采用相同尺寸与纵横滚动位置，便于直接比较同一处图文。
let syncingScroll=false;
for(const [source,target]of [["canvasContainer","translatedContainer"],["translatedContainer","canvasContainer"]])$(source).addEventListener("scroll",()=>{
  if(syncingScroll||$("viewMode").value!=="parallel")return;
  syncingScroll=true;$(target).scrollTop=$(source).scrollTop;$(target).scrollLeft=$(source).scrollLeft;
  requestAnimationFrame(()=>{syncingScroll=false;});
});
window.addEventListener("pagehide",()=>{cancel(false);layoutRevision++;layoutTask?.cancel();loadAbort?.abort();});
try{
  const initial=new URLSearchParams(location.hash.slice(1)).get("url");
  if(initial)$("sourceUrl").value=sourceUrl(initial).href;
}catch(_){status("PDF 地址无效，请重新填写或选择本地文件。",true);}
await refreshConfig().catch(()=>status("读取翻译配置失败，请重新打开阅读页或检查扩展设置",true));controls();renderLayoutTools();
