(function() {
  "use strict";
  const $ = id => document.getElementById(id), E = window.BT_PDF_ERRORS;
  let state, passwordRequest = null, translationState = null;
  const translationCards = new Map();
  /** DOM 只使用 textContent；文件名、地址和异常不作为 HTML 插入。 */
  function showState(next) {
    state = next;
    const loading = ["loading", "parsing"].includes(state.source), ready = state.source === "ready";
    $("pdfUrl").disabled = $("loadUrl").disabled = $("selectFile").disabled = $("fileInput").disabled = loading;
    $("loadUrl").textContent = loading ? "正在读取…" : "读取在线 PDF";
    $("selectFile").textContent = loading ? "正在处理…" : "选择本地 PDF";
    $("previous").disabled = !ready || state.page <= 1;
    $("next").disabled = !ready || state.page >= state.numPages;
    $("pageNumber").disabled = $("zoom").disabled = $("rotate").disabled = !ready;
    $("zoomOut").disabled = !ready || state.scale <= 0.25;
    $("zoomIn").disabled = !ready || state.scale >= 4;
    $("retry").disabled = !ready || state.view === "rendering";
    $("cancel").disabled = !loading && state.view !== "rendering";
    $("close").disabled = !loading && !ready && state.source !== "failed";
    $("pageNumber").value = state.page;
    $("pageNumber").max = Math.max(1, state.numPages);
    $("pageCount").textContent = "/ " + (state.numPages || "—") + " 页";
    $("zoom").value = String(state.scale);
    $("rotate").textContent = "旋转 90°（" + state.rotation + "°）";
    $("fileName").textContent = state.name;
    $("status").textContent = state.message;
    $("status").dataset.error = String(!!state.error);
    $("viewport").setAttribute("aria-busy", String(loading || state.view === "rendering"));
    if (!loading && passwordRequest) finishPassword(null);
    updateTranslationControls();
  }
  function finishPassword(value) {
    if (!passwordRequest) return;
    const request = passwordRequest; passwordRequest = null;
    request.signal?.removeEventListener("abort", request.abort);
    $("password").value = "";
    if ($("passwordDialog").open) $("passwordDialog").close();
    request.resolve(value);
  }
  function askPassword(reason, signal) {
    if (signal?.aborted) return Promise.reject(E.cancelled());
    finishPassword(null);
    return new Promise(resolve => {
      const abort = () => finishPassword(null);
      passwordRequest = {resolve, abort, signal};
      signal?.addEventListener("abort", abort, {once: true});
      $("passwordHint").textContent = reason === 2 ? "密码不正确，请重新输入；也可以取消读取。" : "输入密码以打开文件，密码仅用于本次读取。";
      $("passwordDialog").showModal(); $("password").focus();
    });
  }
  function updateTranslationControls() {
    if (!translationState) return;
    const ready=state?.source==="ready"&&state?.view==="ready";
    $("startTranslation").disabled=!ready||!translationState.configured||translationState.busy;
    $("startTranslation").textContent=translationState.busy?"正在翻译…":translationState.canContinue?"继续翻译":translationState.hasRun?"重新翻译":"开始翻译";
    $("cancelTranslation").disabled=state?.source!=="ready"||(!translationState.busy&&!translationState.hasRun);
    for(const id of ["translationService","translationFrom","translationTo"])$(id).disabled=!translationState.configReady;
    $("translationStatus").textContent=translationState.message;
  }
  function renderRows(rows) {
    const host=$("translationRows"),keep=new Set();
    if(!rows.length){
      host.replaceChildren();translationCards.clear();
      const empty=document.createElement("p");empty.className="translation-empty";
      empty.textContent="开始翻译后将在此显示本页文字对照。";host.append(empty);return;
    }
    host.querySelector(".translation-empty")?.remove();
    rows.forEach(({block,result},index)=>{
      keep.add(block.id);
      let card=translationCards.get(block.id);
      if(!card){
        const element=document.createElement("article"),source=document.createElement("p"),target=document.createElement("p"),note=document.createElement("p");
        element.className="translation-row";source.className="translation-source";target.className="translation-result";note.className="translation-note";
        source.dir=target.dir="auto";element.append(source,target,note);card={element,source,target,note};translationCards.set(block.id,card);
      }
      const original=block.reliable?block.text:"本区域文字层不能可靠提取，请查看左侧 PDF 原文。";
      const translated=result?.status==="translated"||result?.status==="unchanged"?result.text:"";
      const note=result?.status==="failed"?"翻译失败："+result.reason:result?.status==="skipped"?"保留原文："+result.reason:result?.status==="unchanged"?"原文与目标一致或服务返回未变化文字":!result?"未翻译或已暂停":"";
      if(card.source.textContent!==original)card.source.textContent=original;
      if(card.target.textContent!==translated)card.target.textContent=translated;
      if(card.note.textContent!==note)card.note.textContent=note;
      card.note.dataset.error=String(result?.status==="failed");
      if(host.children[index]!==card.element)host.insertBefore(card.element,host.children[index]||null);
    });
    for(const [id,card] of translationCards)if(!keep.has(id)){card.element.remove();translationCards.delete(id);}
  }
  const translation=window.BT_PDF_TRANSLATION_SESSION.create({
    onState(value){translationState=value;updateTranslationControls();},
    onConfig(config){
      const select=$("translationService");select.replaceChildren();
      for(const service of config.services){const option=new Option(service.text,service.value);option.disabled=!service.ready;select.append(option);}
      select.value=window.BT_SERVICES.value(config.engine,config.aiProvider);
      window.BT_CONST.fillLanguageSelect($("translationFrom"),"from",config.from);
      window.BT_CONST.fillLanguageSelect($("translationTo"),"to",config.to);
    },onRows:renderRows
  });
  const session = window.BT_PDF_SESSION.create({onState: showState, onPassword: askPassword,
    onDocument:translation.setDocument,onPage:translation.setPage,onViewReady:translation.viewReady,
    onClear() { $("canvasHost").replaceChildren(); $("empty").hidden = false; },
    onCanvas(canvas) {
      canvas.setAttribute("role", "img"); canvas.setAttribute("aria-label", "PDF 第 " + state.page + " 页原文图像");
      $("canvasHost").replaceChildren(canvas); $("empty").hidden = true;
      $("viewport").scrollTop = $("viewport").scrollLeft = 0;
    }});
  $("urlForm").addEventListener("submit", event => {
    event.preventDefault();
    try {
      const authorization = window.BT_PDF_SOURCE.authorize($("pdfUrl").value.trim());
      void session.load({authorization});
    } catch (error) {
      $("status").textContent = E.normalize(error, "source").message;
      $("status").dataset.error = "true";
    }
  });
  $("selectFile").onclick = () => $("fileInput").click();
  $("fileInput").onchange = () => {
    const file = $("fileInput").files[0]; $("fileInput").value = "";
    if (file) void session.load({file});
  };
  $("previous").onclick = () => session.navigate(state.page - 1);
  $("next").onclick = () => session.navigate(state.page + 1);
  $("pageNumber").onchange = () => {
    const value = Number($("pageNumber").value);
    if (Number.isInteger(value) && value >= 1 && value <= state.numPages) session.navigate(value);
    else { $("pageNumber").value = state.page; $("status").textContent = "请输入 1 至 " + state.numPages + " 之间的页码"; }
  };
  $("pageNumber").onkeydown = event => { if (event.key === "Enter") { event.preventDefault(); $("pageNumber").blur(); } };
  $("zoom").onchange = () => session.zoom(Number($("zoom").value));
  const scales = [...$("zoom").options].map(option => Number(option.value));
  $("zoomIn").onclick = () => session.zoom(scales.find(value => value > state.scale) || 4);
  $("zoomOut").onclick = () => session.zoom([...scales].reverse().find(value => value < state.scale) || 0.25);
  $("rotate").onclick = session.rotate;
  $("retry").onclick = session.retry;
  $("cancel").onclick = () => { finishPassword(null); void session.cancel(); };
  $("close").onclick = () => { finishPassword(null); void session.close(); };
  $("passwordForm").onsubmit = event => { event.preventDefault(); finishPassword($("password").value); };
  $("passwordCancel").onclick = () => finishPassword(null);
  $("passwordDialog").addEventListener("cancel", event => { event.preventDefault(); finishPassword(null); });
  $("startTranslation").onclick=()=>{void translation.start();};
  $("cancelTranslation").onclick=translation.cancel;
  $("translationService").onchange=()=>translation.select(window.BT_SERVICES.parse($("translationService").value));
  $("translationFrom").onchange=()=>translation.select({from:$("translationFrom").value});
  $("translationTo").onchange=()=>translation.select({to:$("translationTo").value});
  $("refreshTranslationConfig").onclick=()=>{void translation.loadConfig();};
  $("openTranslationSettings").onclick=()=>{
    try{chrome.runtime.sendMessage({action:"OPEN_SETTINGS"},()=>{void chrome.runtime.lastError;});}catch(_){}
  };
  // 悬浮球、面板与工具栏以 #url=<编码地址> 携带来源；来源域名已授权时复用在线加载流程自动加载（不启动翻译），
  // 未授权时仅预填，由用户点击加载补足授权手势。
  function applyBridgeUrl() {
    const hash = location.hash.slice(1);
    if (!hash.startsWith("url=")) return;
    let bridgeUrl = hash.slice(4);
    try { bridgeUrl = decodeURIComponent(bridgeUrl); } catch (_) {}
    if (!/^https?:\/\//i.test(bridgeUrl)) return;
    $("pdfUrl").value = bridgeUrl;
    const authorization = window.BT_PDF_SOURCE.peek(bridgeUrl);
    if (!authorization) return;
    chrome.permissions.contains({origins: [authorization.url.origin + "/*"]}, granted => {
      if (granted && $("pdfUrl").value === bridgeUrl) void session.load({authorization});
    });
  }
  applyBridgeUrl();
  // 复用已有阅读页标签属于同文档 hash 导航；地址变化必须重读来源，避免跨入口复用旧来源。
  window.addEventListener("hashchange", applyBridgeUrl);
  window.addEventListener("pagehide", () => { finishPassword(null); translation.dispose(); session.dispose(); });
  // 退回 BFCache 的页面已释放所有文档；重新载入干净阅读页，绝不恢复失效 Worker。
  window.addEventListener("pageshow", event => { if (event.persisted) location.reload(); });
})();
