(function() {
  "use strict";
  const $ = id => document.getElementById(id), E = window.BT_PDF_ERRORS;
  let state, passwordRequest = null, translationState = null, debugOverlay = false;
  let lastRows = [], lastGeometry = null, planSummary = null, viewMode = "translated";
  // 对照开关独立于阅读模式；切换模式、翻页和任务进度不重置用户选择。
  let comparisonOpen = false, comparisonScroll = 0, structuredScroll = 0, viewInfo = null, highlightedBlock = null;
  // P5-B 导出：页侧只持有当前文档句柄与导出状态，导出编排全部在 BT_PDF_EXPORTER 内。
  let currentDocument = null, exportState = null;
  let reflowPreview=null,exporter=null;
  const translationCards = new Map();
  let statusChannel = "source";
  const modelDownloads = new Map(), fontDownloads = new Map();
  let appliedConfig = null, configDraft = false, startTask = null, lastFileAttempt = null;
  let fontBarReady = false;
  const DEFAULT_FIT_MODE = null;
  let fitMode = DEFAULT_FIT_MODE, fitTimer = null, readingAnchor = null, zoomEditDocument = null, zoomEdited = false;
  let bilingualCanvas = null, bilingualSource = null, bilingualViewKey = "", bilingualTimer = null;
  let bilingualRows = null, bilingualGeometry = null, bilingualScroll = {x:0,y:0}, bilingualAnchor = null;
  let exportPageChoice = "current", customExportRange = "";
  const scrollBehavior = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
  // 阅读位置按文件、语言与页码隔离；同页任务面板开关继续沿用原有滚动恢复。
  const panelPositions=new Map();let panelKey=null,pendingPanelPosition=null;
  const panelIdentity=page=>JSON.stringify([currentDocument?.contentId,appliedConfig?.from,appliedConfig?.to,page]);
  function rememberPanelPosition(){
    if(!panelKey||pendingPanelPosition)return;
    const check=$("translationCard"),structured=$("structuredCard");
    if(!check.hidden)comparisonScroll=$("translationRows").scrollTop;
    if(!structured.hidden&&!$("reflowPanel").hidden)structuredScroll=$("structuredRows").scrollTop;
    if(!structured.hidden&&!$("bilingualViewport").hidden)bilingualScroll={x:$("bilingualViewport").scrollLeft,y:$("bilingualViewport").scrollTop};
    panelPositions.delete(panelKey);panelPositions.set(panelKey,{comparison:comparisonScroll,structured:structuredScroll,pageScroll:{...bilingualScroll},selected:highlightedBlock});
    if(panelPositions.size>128)panelPositions.delete(panelPositions.keys().next().value);
  }
  function beginPanelPage(page){
    const key=panelIdentity(page);if(key===panelKey)return;
    rememberPanelPosition();panelKey=key;
    pendingPanelPosition=panelPositions.get(key)||{comparison:0,structured:0,selected:null};
    comparisonScroll=pendingPanelPosition.comparison;structuredScroll=pendingPanelPosition.structured;
    bilingualScroll=pendingPanelPosition.pageScroll||{x:0,y:0};
  }
  function restorePanelPosition(){
    if(!pendingPanelPosition)return;
    const saved=pendingPanelPosition;pendingPanelPosition=null;
    $("translationRows").scrollTop=saved.comparison;$("structuredRows").scrollTop=saved.structured;
    $("bilingualViewport").scrollLeft=bilingualScroll.x;$("bilingualViewport").scrollTop=bilingualScroll.y;
    const selected=translationCards.get(saved.selected);if(selected)highlightRow(selected);
  }
  for(const id of ["translationRows","structuredRows","bilingualViewport"])$(id).addEventListener("scroll",rememberPanelPosition,{passive:true});
  /** 只消费现有状态，不维护第二套任务状态或改写会话。 */
  function refreshStatusUI() {
    const sourceBusy = ["loading", "parsing"].includes(state?.source) || state?.view === "rendering";
    const channels = [
      {key: "source", node: $("status"), busy: sourceBusy},
      {key: "translation", node: $("translationStatus"), busy: !!translationState?.busy},
      {key: "export", node: $("exportStatus"), busy: !!exportState?.busy},
      {key: "models", node: $("ocrModelStatus"), busy: modelDownloads.size > 0},
      {key: "fonts", node: $("exportFontStatus"), busy: fontDownloads.size > 0}
    ];
    const active = channels.find(item => item.busy && item.key === statusChannel) || channels.find(item => item.busy);
    const error = channels.find(item => item.node.dataset.error === "true" && (!active || item.key === active.key));
    const selected = error || active || channels.find(item => item.key === statusChannel) || channels[0];
    let message = selected.node.textContent || "正在处理本机资源…";
    if (!error && selected.key === "translation" && ["completed", "partial"].includes(translationState?.phase)) {
      message = translationState.phase === "completed" ? "本页翻译完成" : "本页部分完成，可展开翻译检查查看保留或失败内容";
    }
    if (!active && !error && selected.key === "source" && state?.view === "ready" && translationState?.hasRun) {
      message = translationState.busy ? $("translationStatus").textContent : "当前页已就绪";
    }
    if ($("readerStatusSummary").textContent !== message) $("readerStatusSummary").textContent = message;
    $("readerStatusSummary").dataset.level = error ? "error" :
      (selected.key === "translation" && translationState?.phase === "partial") ||
      (selected.key === "export" && exportState?.phase === "incomplete") ? "warning" : "normal";
    $("activityIndicator").hidden = !active;
    for (const [target, source] of [["translationPanelStatus", "translationStatus"], ["exportPanelStatus", "exportStatus"]]) {
      $(target).textContent = $(source).textContent;
      $(target).dataset.error = $(source).dataset.error || "false";
    }
    $("filePanelStatus").textContent = $("status").textContent;
    $("filePanelStatus").dataset.error = $("status").dataset.error || "false";
    const finished = lastRows.filter(row => ["translated", "unchanged"].includes(row.result?.status)).length;
    const failed = lastRows.filter(row => row.result?.status === "failed").length;
    const fallback = planSummary?.stats?.fallback;
    const phase = translationState?.phase;
    if (!active && !error && ["completed", "partial", "cancelled"].includes(phase) && selected.key === "translation") {
      const label = phase === "cancelled" ? "已取消，成功结果已保留" : failed && !finished ? "翻译失败，可重试" :
        phase === "partial" ? "部分完成" : "本页翻译完成";
      $("readerStatusSummary").textContent = label;
    }
    $("translationCounts").hidden = !lastRows.length;
    const unfinished = lastRows.filter(row=>!row.result||row.result.status==="failed").length;
    const retained=lastRows.filter(row=>row.result?.status==="skipped").length;
    $("translationRetained").hidden=!retained;$("translationRetained").textContent="保留原文 "+retained;
    for (const [id, text, count] of [
      ["translationProgress", "已翻译 " + finished + "/" + lastRows.length, finished],
      ["translationUnfinished", "未完成 " + unfinished, unfinished],
      ["translationFallback", "回退 " + (Number.isFinite(fallback) ? fallback : "…"), fallback],
      ["translationFailed", "失败 " + failed, failed]
    ]) {
      $(id).textContent = text;
      $(id).disabled = !Number.isFinite(count) || count === 0;
    }
    $("showFailedTranslation").hidden = !failed;
  }
  // 原有异常提示也会直接写状态节点；观察这些节点，避免漏报，又不拦截业务回调。
  const statusObserver = new MutationObserver(refreshStatusUI);
  for (const id of ["status", "translationStatus", "exportStatus", "ocrModelStatus", "exportFontStatus"]) {
    statusObserver.observe($(id), {childList: true, subtree: true, attributes: true, attributeFilter: ["data-error"]});
  }
  $("toggleStatusDetails").onclick = () => {
    $("statusDetails").hidden = !$("statusDetails").hidden;
    $("toggleStatusDetails").setAttribute("aria-expanded", String(!$("statusDetails").hidden));
  };
  // 文件/设置/导出替换共用侧栏内容，不调整阅读模式、不重建业务会话。
  const panelButtons = {file: "openFilePanel", settings: "openSettingsPanel", export: "openExportPanel"};
  const panelTitles = {file: "打开文件", settings: "设置", export: "导出 PDF"};
  let openPanel = null;
  function showReaderPanel(name, focus = true) {
    const panel = $("readerPanel"), previous = openPanel;
    const returnFocus = !name && panel.contains(document.activeElement);
    openPanel = name;
    panel.hidden = !name;
    document.body.dataset.taskPanel = name || "none";
    // 对照的用户开关独立保存；任务面板关闭后恢复同一组节点与滚动状态。
    $("translationCard").inert = !!name;
    updateTextComparison();
    for (const [key, buttonId] of Object.entries(panelButtons)) {
      $(key + "Panel").hidden = key !== name;
      $(buttonId).setAttribute("aria-expanded", String(key === name));
    }
    $("translationConfigSummary").setAttribute("aria-expanded", String(name === "settings"));
    if (name) {
      $("readerPanelTitle").textContent = panelTitles[name];
      if (focus) panel.focus({preventScroll: true});
    } else if (returnFocus && previous) {
      $(panelButtons[previous]).focus({preventScroll: true});
    }
  }
  for (const [name, buttonId] of Object.entries(panelButtons)) {
    $(buttonId).onclick = () => showReaderPanel(openPanel === name ? null : name);
  }
  $("closeReaderPanel").onclick = () => showReaderPanel(null);
  $("translationConfigSummary").onclick = () => showReaderPanel(openPanel === "settings" ? null : "settings");
  document.addEventListener("keydown", event => {
    if (event.key !== "Escape" || event.defaultPrevented || event.isComposing || $("passwordDialog").open) return;
    if (openPanel) { event.preventDefault(); showReaderPanel(null); }
    else if (comparisonOpen) {
      event.preventDefault(); comparisonOpen = false; updateTextComparison();
    }
  });
  function updateConfigSummary() {
    if (!appliedConfig) return;
    const service = appliedConfig.engine === "ai" ? window.AI_PROVIDERS[appliedConfig.aiProvider]?.name || "AI 翻译" :
      ({google: "Google 翻译", bing: "Bing 翻译", baidu: "百度翻译"})[appliedConfig.engine] || "翻译服务";
    const language = (value, direction) => value === "auto" ? "自动" :
      window.BT_CONST.LANGUAGES[direction].find(item => item.value === (value === "browser" ? window.BT_CONST.resolveTargetLanguage(value) : value))?.label || value;
    const summary = service + " · " + language(appliedConfig.from, "from") + " → " + language(appliedConfig.to, "to");
    $("translationConfigSummary").textContent = summary;
    $("translationConfigSummary").title = summary + "；点击打开翻译设置";
  }
  function updateConfigDraft() {
    configDraft = !!appliedConfig && ($("translationService").value !== window.BT_SERVICES.value(appliedConfig.engine, appliedConfig.aiProvider) ||
      $("translationFrom").value !== appliedConfig.from || $("translationTo").value !== appliedConfig.to);
    $("applyTranslationConfig").hidden = !configDraft;
    $("translationConfigHint").textContent = configDraft ?
      (translationState?.hasRun ? "配置尚未应用。应用后会清除旧译文并取消旧任务，需要重新翻译；不会自动发送请求。" : "配置尚未应用，点击应用配置后再开始翻译。") :
      "选项仅用于本 PDF。应用配置与开始翻译是两个独立操作；外部配置变化会自动同步。";
    updateTranslationControls();
  }
  function revealComparisonRow(card, filter = "all") {
    if (!card) return;
    $("comparisonFilter").value = filter; applyComparisonFilter();
    comparisonOpen = true; updateTextComparison();
    if (openPanel) showReaderPanel(null, false);
    card.element.scrollIntoView({block: "nearest", behavior: scrollBehavior()});
    card.element.focus({preventScroll: true}); highlightRow(card);
    renderer.flashHighlight(card.element.dataset.blockId);
  }
  function openComparisonFilter(filter) {
    if(viewMode === "original"){viewMode="translated";applyViewMode();}
    $("comparisonFilter").value = filter; applyComparisonFilter();
    comparisonOpen = true;
    if (openPanel) showReaderPanel(null, false); else updateTextComparison();
    const card = [...translationCards.values()].find(item => !item.element.hidden);
    if (card) revealComparisonRow(card, filter); else $("translationRows").focus({preventScroll: true});
  }
  $("translationProgress").onclick = () => openComparisonFilter("completed");
  $("translationUnfinished").onclick = () => openComparisonFilter("unfinished");
  $("translationFallback").onclick = () => openComparisonFilter("fallback");
  $("translationFailed").onclick = $("showFailedTranslation").onclick = () => openComparisonFilter("failed");
  // P3-B 译文显示层：被动消费块坐标与渲染矩阵，只绘制调试描边，不参与翻译状态。
  const renderer = window.BT_PDF_TRANSLATION_RENDERER.create({isDebug: () => debugOverlay,
    // 译文编号展开对应的翻译检查，不触发翻译或重排生成。
    onMarkerClick(blockId) {
      if (viewMode !== "translated") return;
      const card = translationCards.get(blockId);
      if (card) revealComparisonRow(card);
    },
    onPlanSummary(summary) { planSummary = summary; updateTranslationStats(); queueMicrotask(syncMarkerHighlight); }});
  // 双语右侧只消费当前页位图与有效译文；复用安全显示层，不另开 PDF、OCR 或翻译会话。
  const bilingualRenderer = window.BT_PDF_TRANSLATION_RENDERER.create({isDebug:()=>false,
    onMarkerClick:blockId=>revealTranslatedBlock(blockId),
    onPlanSummary(summary){
      const {overlay,fallback,pending}=summary.stats;
      $("bilingualPageStatus").textContent=bilingualRows?.some(row=>row.result?.status==="translated")?
        "原位显示 "+overlay+" 段"+(pending?" · 正在排版 "+pending+" 段":"")+
        (fallback?" · "+fallback+" 段未能覆盖，可切换重排译文查看":""):
        "尚无可覆盖的译文；未处理或受保护内容保留原样。";
      queueMicrotask(syncMarkerHighlight);
    }});
  bilingualRenderer.setVisible(false);
  function clearBilingualPage(){
    clearTimeout(bilingualTimer);bilingualTimer=null;bilingualRenderer.clear();
    if(bilingualCanvas)bilingualCanvas.width=bilingualCanvas.height=0;
    bilingualCanvas=bilingualSource=null;bilingualViewKey="";bilingualRows=bilingualGeometry=null;
    $("bilingualCanvasHost").replaceChildren();$("bilingualEmpty").hidden=false;$("bilingualPageStatus").textContent="";
  }
  function syncBilingualPage(){
    if($("structuredCard").hidden||$("bilingualLayout").value!=="page"){
      clearBilingualPage();return;
    }
    const source=$("canvasHost").querySelector("canvas"),viewport=$("bilingualViewport");
    if(!source?.width||!viewInfo||state?.view!=="ready"||viewInfo.pageNumber!==state.page){clearBilingualPage();return;}
    if(!(viewport.clientWidth>0&&viewport.clientHeight>0))return;
    const style=getComputedStyle(viewport),width=Math.max(1,viewport.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight)),
      height=Math.max(1,viewport.clientHeight-parseFloat(style.paddingTop)-parseFloat(style.paddingBottom));
    // 固定百分比沿用工具栏缩放；适配模式只调整右侧显示矩阵，不触发原页重渲染。
    const factor=fitMode?Math.max(.25/viewInfo.scale,Math.min(4/viewInfo.scale,width/viewInfo.width,
      fitMode==="fit-page"?height/viewInfo.height:Infinity)):1;
    const info={...viewInfo,width:viewInfo.width*factor,height:viewInfo.height*factor,
      viewportTransform:viewInfo.viewportTransform.map(value=>value*factor)};
    const changed=source!==bilingualSource;
    if(changed){
      clearBilingualPage();
      const canvas=document.createElement("canvas"),ratio=Math.min(1,Math.sqrt(4000000/(source.width*source.height)));
      canvas.width=Math.max(1,Math.floor(source.width*ratio));canvas.height=Math.max(1,Math.floor(source.height*ratio));
      const context=canvas.getContext("2d");
      if(!context){canvas.width=canvas.height=0;$("bilingualPageStatus").textContent="译文页面暂时无法显示，可切换重排译文。";return;}
      context.drawImage(source,0,0,canvas.width,canvas.height);
      canvas.setAttribute("role","img");canvas.setAttribute("aria-label","第 "+info.pageNumber+" 页译文，未能安全覆盖的内容保留原文");
      bilingualCanvas=canvas;bilingualSource=source;
      $("bilingualCanvasHost").replaceChildren(bilingualRenderer.mount(canvas));$("bilingualEmpty").hidden=true;
    }
    const key=JSON.stringify([info.pageNumber,info.width,info.height,info.viewportTransform]);
    if(key!==bilingualViewKey){
      bilingualCanvas.style.width=info.width+"px";bilingualCanvas.style.height=info.height+"px";
      bilingualRenderer.setView(info);bilingualViewKey=key;
    }
    if(lastGeometry?.pageNumber===info.pageNumber&&(bilingualRows!==lastRows||bilingualGeometry!==lastGeometry)){
      bilingualRenderer.setModel(lastRows,lastGeometry);bilingualRows=lastRows;bilingualGeometry=lastGeometry;
    }else if(lastGeometry?.pageNumber!==info.pageNumber&&bilingualRows){
      // 配置切换清空模型时，同页位图仍可复用，但绝不保留旧语言的覆盖层。
      bilingualRenderer.setView(info);bilingualRenderer.setModel(null,null);bilingualRows=bilingualGeometry=null;
    }
    bilingualRenderer.setVisible(true);
    if(!bilingualRows?.length)$("bilingualPageStatus").textContent="尚未生成译文；开始翻译后在此显示对应页面。";
    if(changed){
      viewport.scrollLeft=bilingualAnchor?.page===info.pageNumber?bilingualAnchor.x*viewport.scrollWidth-viewport.clientWidth/2:bilingualScroll.x;
      viewport.scrollTop=bilingualAnchor?.page===info.pageNumber?bilingualAnchor.y*viewport.scrollHeight-viewport.clientHeight/2:bilingualScroll.y;
      bilingualAnchor=null;
    }
  }
  function scheduleBilingualPage(){
    clearTimeout(bilingualTimer);bilingualTimer=setTimeout(()=>{bilingualTimer=null;syncBilingualPage();},180);
  }
  function revealTranslatedBlock(blockId){
    const card=translationCards.get(blockId);if(!card)return;
    viewMode="translated";applyViewMode();revealComparisonRow(card);
  }
  function updateBilingualLayout(){
    rememberPanelPosition();
    const page=$("bilingualLayout").value==="page";
    $("bilingualViewport").hidden=!page;$("bilingualPageStatus").hidden=!page;$("reflowPanel").hidden=page;
    $("structuredRows").hidden=false;
    $("editNotice").hidden=page;
    if(!page)$("structuredRows").scrollTop=structuredScroll;
    syncBilingualPage();reflowPreview?.setVisible(!page&&!$("structuredCard").hidden);
  }
  $("bilingualLayout").onchange=updateBilingualLayout;
  const bilingualObserver=new ResizeObserver(scheduleBilingualPage);
  bilingualObserver.observe($("bilingualViewport"));
  $("bilingualCanvasHost").onclick=event=>{
    if(event.target.closest("button, .pdf-marker")||!bilingualCanvas)return;
    const box=bilingualCanvas.getBoundingClientRect(),x=event.clientX-box.left,y=event.clientY-box.top;
    const row=lastRows.find(({block})=>{const r=bilingualRenderer.getDisplayRect(block.id);return r&&x>=r.x&&x<=r.right&&y>=r.y&&y<=r.bottom;});
    if(row){focusPdfBlock(row.block.id);bilingualRenderer.flashHighlight(row.block.id);}
  };
  /** DOM 只使用 textContent；文件名、地址和异常不作为 HTML 插入。 */
  function showState(next) {
    const previousSource = state?.source;
    // 在会话释放旧 Canvas 前保存阅读中心；onClear 时旧位图尺寸已经归零。
    if (next.view === "rendering" && state?.view !== "rendering" && viewInfo?.pageNumber === next.page) {
      rememberPanelPosition();
      const right=$("bilingualViewport");
      if(!$("structuredCard").hidden&&!right.hidden)bilingualAnchor={page:next.page,
        x:(right.scrollLeft+right.clientWidth/2)/right.scrollWidth,y:(right.scrollTop+right.clientHeight/2)/right.scrollHeight};
      const viewport = $("viewport");
      readingAnchor = {page: next.page, x: (viewport.scrollLeft + viewport.clientWidth / 2) / viewport.scrollWidth,
        y: (viewport.scrollTop + viewport.clientHeight / 2) / viewport.scrollHeight};
    }
    state = next;
    const loading = ["loading", "parsing"].includes(state.source), ready = state.source === "ready";
    if (loading || state.view === "rendering") statusChannel = "source";
    $("pdfUrl").disabled = $("loadUrl").disabled = $("selectFile").disabled = $("fileInput").disabled = loading;
    $("loadUrl").textContent = loading ? "正在读取…" : "读取在线 PDF";
    $("selectFile").textContent = loading ? "正在处理…" : "选择本地 PDF";
    $("previous").disabled = !ready || state.page <= 1;
    $("next").disabled = !ready || state.page >= state.numPages;
    $("pageNumber").disabled = $("zoom").disabled = $("rotate").disabled = !ready;
    $("zoomOut").disabled = !ready || state.scale <= 0.25;
    $("zoomIn").disabled = !ready || state.scale >= 4;
    $("retry").disabled = !ready || state.view === "rendering";
    $("retry").hidden = !ready || !["idle", "failed"].includes(state.view);
    $("cancel").disabled = !loading && state.view !== "rendering";
    $("cancel").hidden = $("cancel").disabled;
    $("close").disabled = !loading && !ready && state.source !== "failed";
    $("close").hidden = $("close").disabled;
    $("retrySource").hidden = state.source !== "failed";
    $("loadUrl").textContent = loading ? "正在读取…" : state.source === "failed" ? "重新读取在线 PDF" : "读取在线 PDF";
    $("pageNumber").value = state.page;
    $("pageNumber").max = Math.max(1, state.numPages);
    $("pageCount").textContent = "/ " + (state.numPages || "—") + " 页";
    syncZoomPicker();
    $("rotate").title = "顺时针旋转 90°（当前 " + state.rotation + "°）";
    $("rotate").setAttribute("aria-label", $("rotate").title);
    $("fileName").textContent = state.name || "PDF 阅读器";
    $("fileName").title = state.name || "PDF 阅读器";
    $("status").textContent = state.message;
    $("status").dataset.error = String(!!state.error);
    $("viewport").setAttribute("aria-busy", String(loading || state.view === "rendering"));
    if (!loading && passwordRequest) finishPassword(null);
    // 读取完成只收起来源表单；其他面板不受翻页、缩放或后台状态更新影响。
    if (ready && previousSource !== "ready" && openPanel === "file") showReaderPanel(null, false);
    updateTranslationControls();
    updateExportControls();
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
    const busy = translationState.busy || !!startTask;
    const failed = lastRows.some(row => row.result?.status === "failed");
    $("startTranslation").disabled=!ready||!translationState.configured||busy||configDraft;
    $("startTranslation").textContent=busy?(translationState.phase === "recognizing" ? "正在识别…" : "正在翻译…"):
      translationState.canContinue?(failed ? "重试未完成" : "继续翻译"):translationState.hasRun?"重新翻译":"开始翻译";
    $("startTranslation").classList.toggle("primary", busy || !translationState.hasRun || translationState.canContinue);
    $("startTranslation").title = configDraft ? "请先在设置面板应用配置" : "";
    $("cancelTranslation").disabled=state?.source!=="ready"||!busy;
    $("cancelTranslation").hidden = !busy;
    for(const id of ["translationService","translationFrom","translationTo"])$(id).disabled=!translationState.configReady;
    $("translationStatus").textContent=translationState.message;
    $("translationStatus").dataset.error = String(["config-error", "interrupted"].includes(translationState.phase));
    if (translationState.busy) statusChannel = "translation";
    if (translationState.configReady) updateConfigSummary();
    else {
      const summary = translationState.phase === "config-error" ? "翻译设置不可用，请打开设置" : "正在读取翻译设置…";
      $("translationConfigSummary").textContent = summary;
      $("translationConfigSummary").title = summary;
    }
    updateExportControls();
  }
  /** P5-B/P5b 导出控件：原文只需文档就绪，本页译文需已翻译；所选页先体检，缺译页只放行「补译」「保留原文」两个显式选择。 */
  function updateExportControls() {
    syncExportOptions();
    const busy = !!exportState?.busy, ready = state?.source === "ready" && !!currentDocument;
    const mode = $("exportMode").value, range = mode === "range";
    // 清单只在「范围模式 + 上次体检确实缺页 + 范围文本没改过」时出现；改文本或换口径都得重新体检。
    const checked = range && !busy && exportState?.phase === "incomplete" &&
      exportState?.checkedText === $("exportRange").value && exportState?.checkedStamp === translation.exportStamp();
    const choose = checked && !!exportState?.missing?.length;
    $("exportMode").disabled = busy || !ready;
    $("exportContent").disabled = busy || !ready;
    $("exportPages").disabled = busy || !ready || mode === "original";
    $("exportLayoutField").hidden=mode==="original";$("exportLayout").disabled=busy||!ready;
    $("exportRangeField").hidden = !range || $("exportPages").value !== "custom";
    $("exportRange").disabled = busy || !ready;
    // P5-D 双语对照是导出侧的成对页口径，与阅读模式无关；原文导出没有对照页可言，故只隐藏不重置勾选。
    $("exportPairField").hidden = true;
    $("exportPair").disabled = busy || !ready;
    const parsed = range ? window.BT_PDF_EXPORTER.parseRange($("exportRange").value, state?.numPages || 0, state?.page || 1) : null;
    $("exportNow").disabled = !ready || busy || !!parsed?.error || (mode === "translated" && !translationState?.hasRun);
    $("exportSelectionInfo").textContent = !ready ? "请先打开 PDF。" : parsed?.error ||
      "所选原始页面：" + (mode === "original" ? state.numPages : range ? parsed.pages.length : 1) + " 页 · " +
      (mode === "original" ? "完整源文件" : $("exportLayout").value === "structured" ? "独立重排 PDF，与右侧使用相同版面生成器" : "译文页面；回退译文放入附录");
    $("exportSelectionInfo").dataset.error = String(!!parsed?.error);
    $("exportNow").textContent = busy ? (exportState?.task === "prepare" ? "正在补译…" : "正在导出…") : "导出";
    $("exportPrepare").hidden = !choose;
    $("exportKeepMissing").hidden = !choose;
    $("exportPreflight").hidden = !checked;
    $("exportPreflightSummary").textContent = checked ? exportState.message : "";
    $("exportModeHint").textContent = mode === "original" ? "导出完整源文件，内容保持不变。" :
      $("exportLayout").value === "structured" ? "沿用源页尺寸与已识别分栏，内容增高时续页；与右侧重排译文共用生成器。含已保存编辑，无法可靠重建的内容附对应源页。" :
      range ? "缺少译文时，先选择补译或保留原文；一次最多 50 页。" :
      "导出当前页译文；无法原位显示的内容放入附录。";
    $("exportCancel").disabled = !busy;
    $("exportCancel").hidden = !busy;
    $("exportCancel").textContent = exportState?.task === "prepare" ? "取消补译" : "取消导出";
    $("exportStatus").textContent = exportState ? exportState.message : "导出前请先读取 PDF";
    $("exportStatus").dataset.error = String(exportState?.phase === "failed");
    if (busy) statusChannel = "export";
    // 状态行的字体结论跟着同一批状态走；键值没变就不会重复读存储。
    void refreshFontBar(false);
  }
  /** 导出与补译都是异步任务：意外异常统一落到状态行，绝不让点击事件抛出。 */
  function runExportTask(task) {
    void Promise.resolve(task).catch(error => {
      $("exportStatus").textContent = E.normalize(error, "export").message;
      $("exportStatus").dataset.error = "true";
    });
  }
  function renderRows(rows) {
    const host=$("translationRows"),keep=new Set();
    if(!rows.length){
      clearBlockHighlight();host.replaceChildren();translationCards.clear();
      const empty=document.createElement("p");empty.className="translation-empty";
      empty.textContent="开始翻译后将在此显示本页翻译检查。";host.append(empty);return;
    }
    host.querySelector(".translation-empty")?.remove();
    rows.forEach(({block,result},index)=>{
      keep.add(block.id);
      let card=translationCards.get(block.id);
      if(!card){
        const element=document.createElement("article"),badge=document.createElement("span"),source=document.createElement("p"),target=document.createElement("p"),note=document.createElement("p");
        element.className="translation-row";badge.className="translation-badge";badge.hidden=true;source.className="translation-source";target.className="translation-result";note.className="translation-note";
        source.dir=target.dir="auto";element.append(badge,source,target,note);
        element.dataset.blockId=block.id;element.tabIndex=0;element.setAttribute("role","button");element.setAttribute("aria-label","定位到 PDF 原文");
        card={element,badge,source,target,note};translationCards.set(block.id,card);
      }
      // OCR 块始终展示识别文字（置信度状态见 note，供校对）；仅原生不可靠文字层用占位提示。
      const original=block.reliable||block.source==="ocr"?block.text:"本区域文字层不能可靠提取，请查看左侧 PDF 原文。";
      const translated=result?.status==="translated"||result?.status==="unchanged"?result.text:"";
      const note=result?.status==="failed"?"翻译失败："+result.reason:result?.status==="skipped"?"保留原文："+result.reason:result?.status==="unchanged"?(["number","symbol"].includes(block.role)?"数字、编号或符号保持原样，无需翻译":"原文与目标一致或服务返回未变化文字"):!result?"未翻译或已暂停":"";
      if(card.source.textContent!==original)card.source.textContent=original;
      if(card.target.textContent!==translated)card.target.textContent=translated;
      card.baseNote = result?.userEdited ? "已修改" + (note ? "；" + note : "") : note;
      if(card.note.textContent!==note)card.note.textContent=note;
      card.note.dataset.error=String(result?.status==="failed");
      if(host.children[index]!==card.element)host.insertBefore(card.element,host.children[index]||null);
    });
    for(const [id,card] of translationCards)if(!keep.has(id)){card.element.remove();translationCards.delete(id);}
    if (highlightedBlock && !keep.has(highlightedBlock)) clearBlockHighlight();
    applyComparisonFilter();
  }
  function syncMarkerHighlight() {
    for (const marker of document.querySelectorAll("#canvasHost .pdf-marker, #bilingualCanvasHost .pdf-marker")) {
      const selected = marker.dataset.blockId === highlightedBlock;
      marker.classList.toggle("pdf-marker-active", selected);
      marker.setAttribute("aria-pressed", String(selected));
    }
    for (const [id, card] of translationCards) {
      const selected = id === highlightedBlock;
      card.element.classList.toggle("translation-row-active", selected);
      if (selected) card.element.setAttribute("aria-current", "true"); else card.element.removeAttribute("aria-current");
    }
  }
  function clearBlockHighlight() {
    highlightedBlock = null;
    for (const card of translationCards.values()) {
      card.element.classList.remove("translation-row-active"); card.element.removeAttribute("aria-current");
    }
    syncMarkerHighlight();structuredReader.highlight(null);reflowPreview?.highlight(null);
  }
  function highlightRow(card) {
    clearBlockHighlight(); highlightedBlock = card.element.dataset.blockId;
    card.element.classList.add("translation-row-active");
    card.element.setAttribute("aria-current", "true"); syncMarkerHighlight();structuredReader.highlight(highlightedBlock);reflowPreview?.highlight(highlightedBlock);

  }
  /** 面板 → PDF：按 blockId 取显示矩形居中滚动并闪高亮；getDisplayRect 为 null（页不匹配/块不存在）时 no-op。 */
  function focusPdfBlock(blockId) {
    const rect = renderer.getDisplayRect(blockId);
    if (!rect) return;
    const viewport = $("viewport"), canvas = $("canvasHost").querySelector("canvas");
    if (!canvas) return;
    const base = canvas.getBoundingClientRect(), box = viewport.getBoundingClientRect();
    const ox = base.left - box.left + viewport.scrollLeft, oy = base.top - box.top + viewport.scrollTop;
    viewport.scrollTo({left: Math.max(0, ox + (rect.x + rect.right) / 2 - viewport.clientWidth / 2),
      top: Math.max(0, oy + (rect.y + rect.bottom) / 2 - viewport.clientHeight / 2), behavior: scrollBehavior()});
    renderer.flashHighlight(blockId);
    bilingualRenderer.flashHighlight(blockId);
    const card = translationCards.get(blockId); if (card) highlightRow(card);
  }
  /** P3-D 三分类统计与行徽标：原位=overlay+unchanged；回退有译文=plan.fallbacks；未完成=null/failed；识别保护与其他 skipped 单独计数。 */
  function updateTranslationStats() {
    const rows = lastRows;
    const unchanged = rows.filter(row => row.result?.status === "unchanged").length;
    const unfinished = rows.filter(row => !row.result || row.result.status === "failed").length;
    const retained=rows.filter(row=>row.result?.status==="skipped").length;
    const stats = planSummary ? planSummary.stats : null;
    $("translationStats").textContent = !rows.length ? "开始翻译后显示原位/回退统计"
      : !stats ? "原位译文规划中…"
      : "原位 " + (stats.overlay + unchanged) + " · 回退有译文 " + stats.fallback + " · 未完成 " + unfinished + (retained?" · 保留原文 "+retained:"") +
        (stats.pending ? " · 采样中 " + stats.pending : "");
    const numbers = planSummary ? planSummary.numbers : null;
    const reasons = new Map((planSummary ? planSummary.fallbacks : []).map(item => [item.blockId, item.reason]));
    const rowById = new Map(rows.map(row => [row.block.id, row]));
    for (const [id, card] of translationCards) {
      const show = !!(numbers && numbers.has(id) && reasons.has(id));
      card.badge.hidden = !show;
      if (show) { card.badge.textContent = String(numbers.get(id)); card.badge.title = "回退：" + reasons.get(id); }
      const row = rowById.get(id), block = row?.block;
      const protectedText = block && ((!["text","number","symbol"].includes(block.role)) || block.segments?.every(part => part.protected));
      const category = row?.result?.status === "failed" ? "翻译失败" : show ? "原位排版回退" :
        block?.source === "ocr" && !block.reliable ? "OCR 识别保护" : protectedText ? "受保护文字" : "";
      card.note.textContent = show ? "原位排版回退：" + reasons.get(id) + (row?.result?.userEdited ? "；已修改" : "") :
        (category && row?.result?.status !== "failed" ? category + "：" : "") + (card.baseNote || "");
    }
    applyComparisonFilter();
    refreshStatusUI();
  }
  // 筛选只使用会话结果和当前渲染计划；回退已有译文，不等同于翻译失败。
  function applyComparisonFilter() {
    const filter = $("comparisonFilter").value;
    const fallbacks = new Set((planSummary?.fallbacks || []).map(item => item.blockId));
    let visible = 0;
    for (const {block, result} of lastRows) {
      const card = translationCards.get(block.id); if (!card) continue;
      const show = filter === "all" || (filter === "fallback" && fallbacks.has(block.id)) ||
        (filter === "completed" && ["translated", "unchanged"].includes(result?.status)) ||
        (filter === "failed" && result?.status === "failed") ||
        (filter === "unfinished" && (!result||result.status==="failed")) ||
        (filter === "pending" && !result) || (filter === "ocr" && block.source === "ocr" && !block.reliable) ||
        (filter === "protected" && result?.status === "skipped" && (block.role !== "text" || block.segments?.every(part=>part.protected))) ||
        (filter === "attention" && (fallbacks.has(block.id) || !["translated","unchanged"].includes(result?.status)));
      card.element.hidden = !show; if (show) visible++;
    }
    $("comparisonFilterEmpty").hidden = !lastRows.length || visible > 0;
    for (const [id, value] of [["translationProgress", "completed"], ["translationUnfinished", "unfinished"],
      ["translationFallback", "fallback"], ["translationFailed", "failed"]]) {
      $(id).setAttribute("aria-pressed", String(comparisonOpen && !openPanel && filter === value));
    }
  }
  $("comparisonFilter").onchange = applyComparisonFilter;
  const structuredScope=()=>JSON.stringify([currentDocument?.contentId,appliedConfig?.from,appliedConfig?.to]);
  const visualSources=new WeakMap();
  function paintVisual(target,visual) {
    const source=$("canvasHost").querySelector("canvas"),BM=window.BT_PDF_BLOCKS.matrix;
    if(!source||!viewInfo||!lastGeometry||viewInfo.pageNumber!==visual.pageNumber||lastGeometry.pageNumber!==visual.pageNumber){target.hidden=true;return false;}
    const saved=visualSources.get(target);if(saved?.source===source&&saved.id===visual.id){target.hidden=false;return true;}
    const matrix=BM.compose(viewInfo.viewportTransform,BM.invert(lastGeometry.transform)),r=visual.sourceRect;
    const points=[[r.x,r.y],[r.right,r.y],[r.right,r.bottom],[r.x,r.bottom]].map(([x,y])=>BM.apply(matrix,x,y));
    if(points.some(point=>point.some(value=>!Number.isFinite(value)))){target.hidden=true;return false;}
    const kx=source.width/viewInfo.width,ky=source.height/viewInfo.height;
    const x=Math.max(0,Math.floor(Math.min(...points.map(p=>p[0]))*kx)),y=Math.max(0,Math.floor(Math.min(...points.map(p=>p[1]))*ky));
    const right=Math.min(source.width,Math.ceil(Math.max(...points.map(p=>p[0]))*kx)),bottom=Math.min(source.height,Math.ceil(Math.max(...points.map(p=>p[1]))*ky));
    const width=right-x,height=bottom-y,budget=2000000/Math.max(1,lastGeometry.visuals?.length||1);
    if(!(width>0&&height>0)){target.hidden=true;return false;}
    const scale=Math.min(1,900/width,Math.sqrt(budget/(width*height)));
    target.width=Math.max(1,Math.floor(width*scale));target.height=Math.max(1,Math.floor(height*scale));
    const context=target.getContext("2d");if(!context){target.hidden=true;return false;}
    context.drawImage(source,x,y,width,height,0,0,target.width,target.height);target.hidden=false;
    visualSources.set(target,{source,id:visual.id});return true;
  }
  const structuredReader=window.BT_PDF_STRUCTURED.create({host:$("structuredRows"),
    onSave:(id,text)=>translation.saveEdit(id,text),onRestore:id=>translation.saveEdit(id,"",true),onLocate:focusPdfBlock,onVisual:paintVisual});
  function discardDrafts() {
    if(!structuredReader.hasDrafts())return true;
    if(!window.confirm("有尚未保存的译文编辑。是否放弃这些编辑并继续？"))return false;
    structuredReader.discardDrafts();return true;
  }
  window.addEventListener("beforeunload",event=>{if(structuredReader.hasDrafts()){event.preventDefault();event.returnValue="";}});
  $("canvasHost").addEventListener("click",event=>{
    if(viewMode!=="bilingual"||event.target.closest("button, .pdf-marker"))return;
    const canvas=$("canvasHost").querySelector("canvas");if(!canvas)return;
    const box=canvas.getBoundingClientRect(),x=event.clientX-box.left,y=event.clientY-box.top;
    const row=lastRows.find(({block})=>{const rect=renderer.getDisplayRect(block.id);return rect&&x>=rect.x&&x<=rect.right&&y>=rect.y&&y<=rect.bottom;});
    if(row){
      if($("bilingualLayout").value==="flow")reflowPreview?.reveal(row.block.id);
      else {
        const rect=bilingualRenderer.getDisplayRect(row.block.id);
        if(rect&&bilingualCanvas){
          const viewport=$("bilingualViewport"),base=bilingualCanvas.getBoundingClientRect(),bounds=viewport.getBoundingClientRect();
          viewport.scrollTo({left:Math.max(0,base.left-bounds.left+viewport.scrollLeft+(rect.x+rect.right)/2-viewport.clientWidth/2),
            top:Math.max(0,base.top-bounds.top+viewport.scrollTop+(rect.y+rect.bottom)/2-viewport.clientHeight/2),behavior:scrollBehavior()});
          bilingualRenderer.flashHighlight(row.block.id);
        }
      }
      const card=translationCards.get(row.block.id);if(card)highlightRow(card);
    }
  });
  const translation=window.BT_PDF_TRANSLATION_SESSION.create({
    onState(value){const wasBusy=translationState?.busy;translationState=value;updateTranslationControls();if(wasBusy!==value.busy)reflowPreview?.update();},
    onConfig(config){
      const draft = configDraft ? {service: $("translationService").value, from: $("translationFrom").value, to: $("translationTo").value} : null;
      appliedConfig = {engine: config.engine, aiProvider: config.aiProvider, from: config.from, to: config.to};
      const select=$("translationService");select.replaceChildren();
      for(const service of config.services){const option=new Option(service.text,service.value);option.disabled=!service.ready;select.append(option);}
      select.value=window.BT_SERVICES.value(config.engine,config.aiProvider);
      window.BT_CONST.fillLanguageSelect($("translationFrom"),"from",config.from);
      window.BT_CONST.fillLanguageSelect($("translationTo"),"to",config.to);
      if (draft) {
        if ([...select.options].some(option => option.value === draft.service && !option.disabled)) select.value = draft.service;
        $("translationFrom").value = draft.from; $("translationTo").value = draft.to;
      }
      updateConfigDraft();
    },onRows(rows,geometry,meta){if(geometry)beginPanelPage(geometry.pageNumber);lastRows=rows;lastGeometry=geometry;renderRows(rows);
      renderer.setModel(rows,geometry);updateTranslationStats();
      structuredReader.render(rows,structuredScope(),geometry?.visuals||[]);syncBilingualPage();reflowPreview?.update();if(geometry)restorePanelPosition();
      const uncertain=rows.filter(row=>!row.block.reliable&&!row.block.eligible&&!['translated','unchanged'].includes(row.result?.status)).length;
      $("editNotice").textContent=meta?.editingError||(uncertain?"有 "+uncertain+" 处文字无法可靠处理，未混入正文；原文保留，可在翻译检查中查看。":"");void refreshFontBar(true);
      // #debug=1 时输出页面分类与 OCR 区域（类型/原因/坐标与统计，不含文字内容）。
      if(debugOverlay&&meta)console.info("[pdf-ocr]",meta.classification?.type||"none",meta.ocr?.regions||[],meta.ocr?.stats||null);}
  });
  const session = window.BT_PDF_SESSION.create({onState: showState, onPassword: askPassword,
    getFitScale:size=>fitMode?calculateFit(size.width,size.height):null,
    // 导出需要文档句柄渲染独立证据位图；页侧自己留存一份，翻译会话行为不变。
    onDocument(value){
      // 每个新文件从 100% 开始；同文件翻页、旋转和面板开关保留用户缩放。
      clearTimeout(fitTimer);fitTimer=null;fitMode=DEFAULT_FIT_MODE;viewInfo=null;
      currentDocument=value;lastGeometry=null;readingAnchor=null;panelPositions.clear();panelKey=null;pendingPanelPosition=null;
      comparisonScroll=structuredScroll=0;bilingualScroll={x:0,y:0};bilingualAnchor=null;clearBilingualPage();reflowPreview?.clear();exporter?.clearReflow();structuredReader.clear();translation.setDocument(value);syncZoomPicker();updateExportControls();
    },
    onPage(value){beginPanelPage(value);translation.setPage(value);},
    onViewReady(info){
      viewInfo={...info,scale:state.scale};syncZoomPicker();translation.viewReady();renderer.setView(info);
      // 缩放/旋转会重建 Canvas 并清空 Renderer；重新挂接本页已确认模型，不另行提取或启动文字任务。
      if (lastGeometry?.pageNumber === info.pageNumber) renderer.setModel(lastRows,lastGeometry);
      const viewport = $("viewport");
      if (readingAnchor?.page === info.pageNumber) {
        viewport.scrollLeft = readingAnchor.x * viewport.scrollWidth - viewport.clientWidth / 2;
        viewport.scrollTop = readingAnchor.y * viewport.scrollHeight - viewport.clientHeight / 2;
      }
      readingAnchor = null;structuredReader.refreshVisuals();syncBilingualPage();reflowPreview?.refresh(); syncMarkerHighlight(); scheduleFit();
    },
    onClear() {
      viewInfo=null;clearBilingualPage();$("canvasHost").replaceChildren(); $("empty").hidden = false; renderer.clear(); },
    onCanvas(canvas) {
      canvas.setAttribute("role", "img"); canvas.setAttribute("aria-label", "PDF 第 " + state.page + " 页原文图像");
      $("canvasHost").replaceChildren(renderer.mount(canvas)); $("empty").hidden = true;
      $("viewport").scrollTop = $("viewport").scrollLeft = 0;
    }});
  // P5-B 导出编排：快照与回退编号在导出瞬间读取，导出过程不触发翻译与 OCR。
  // P5b 多页导出：范围体检/批量快照/补译都只经 translation 读取，页侧不保存第二份译文状态。
  exporter = window.BT_PDF_EXPORTER.create({session,
    getDocument: () => currentDocument,
    getSnapshot: () => translation.exportSnapshot(),
    getSnapshots: pages => translation.exportSnapshots(pages),
    getPageStatus: pages => translation.pageStatus(pages),
    getStamp: () => translation.exportStamp(),
    preparePages: (pages, options) => translation.preparePages(pages, options),
    getPage: () => state?.page || 1,
    getLayout: () => $("exportLayout").value,
    getMarkers: () => planSummary,
    getName: () => state?.name || "",
    onState(value) { exportState = value; updateExportControls(); }});
  reflowPreview=window.BT_PDF_REFLOW_PREVIEW.create({panel:$("reflowPanel"),viewport:$("reflowViewport"),status:$("reflowStatus"),
    previous:$("reflowPrevious"),next:$("reflowNext"),retry:$("reflowRetry"),cancel:$("reflowCancel"),font:$("reflowFont"),
    getInput:()=>({scope:JSON.stringify([currentDocument?.id,appliedConfig,state?.page]),available:!!currentDocument&&lastGeometry?.pageNumber===state?.page&&lastRows.length>0,
      busy:!!translationState?.busy,rotation:state?.rotation||0,scale:state?.scale||1,fitMode}),
    generate:options=>exporter.reflowPDF(options),onLocate:focusPdfBlock,
    onEdit(id){$("reflowEditor").open=true;structuredReader.reveal(id);}});
  $("reflowExport").onclick=()=>{
    $("exportContent").value="translated";$("exportLayout").value="structured";$("exportPages").value="current";
    exportPageChoice="current";updateExportControls();showReaderPanel("export");
  };
  // UI 组合映射到既有三种导出调用；原文保持完整源字节导出，不能静默改为裁剪。
  function syncExportOptions() {
    const original = $("exportContent").value === "original", scope = $("exportPages");
    if (original) scope.value = "all";
    $("exportMode").value = original ? "original" : scope.value === "current" ? "translated" : "range";
    $("exportPair").checked = false;
    if (!original && scope.value === "all") $("exportRange").value = "1-" + (state?.numPages || 1);
  }
  $("exportContent").onchange = () => {
    $("exportPages").value = $("exportContent").value === "original" ? "all" : exportPageChoice;
    if (exportPageChoice === "custom") $("exportRange").value = customExportRange;
    updateExportControls();
  };
  $("exportLayout").onchange = updateExportControls;
  $("exportPages").onchange = () => {
    exportPageChoice = $("exportPages").value;
    if (exportPageChoice === "custom") $("exportRange").value = customExportRange;
    updateExportControls();
  };
  // 范围文本一改，上一次体检的清单与选择按钮立即失效（导出侧也会拒绝过期清单，双重防线）。
  $("exportRange").oninput = () => { customExportRange = $("exportRange").value; updateExportControls(); };
  $("exportNow").onclick = () => {
    const mode = $("exportMode").value, pair = $("exportPair").checked;
    runExportTask(mode === "original" ? exporter.exportOriginal()
      : mode === "range" ? exporter.exportRange($("exportRange").value, false, pair) : exporter.exportTranslated(pair));
  };
  // 体检后的两个显式选择：补译只发缺失页的翻译请求；保留原文则把这些页原样照录，两者都不自动继续对方。
  $("exportPrepare").onclick = () => runExportTask(exporter.prepareMissing($("exportRange").value));
  $("exportKeepMissing").onclick = () => runExportTask(
    exporter.exportRange($("exportRange").value, true, $("exportPair").checked));
  $("exportCancel").onclick = () => exporter.cancel();
  $("urlForm").addEventListener("submit", event => {
    event.preventDefault();
    if (["loading", "parsing"].includes(state?.source)) return;
    if(!discardDrafts())return;
    try {
      lastFileAttempt = null;
      const authorization = window.BT_PDF_SOURCE.authorize($("pdfUrl").value.trim());
      void session.load({authorization});
    } catch (error) {
      $("status").textContent = E.normalize(error, "source").message;
      $("status").dataset.error = "true";
    }
  });
  $("selectFile").onclick = () => $("fileInput").click();
  $("fileInput").onchange = () => {
    const file = $("fileInput").files[0];
    if(file&&!discardDrafts()){$("fileInput").value="";return;} $("fileInput").value = "";
    if (file && !["loading", "parsing"].includes(state?.source)) { lastFileAttempt = file; void session.load({file}); }
  };
  $("retrySource").onclick = () => {
    if (state?.source !== "failed") return;
    if (lastFileAttempt) void session.load({file: lastFileAttempt});
    else $("urlForm").requestSubmit();
  };
  $("previous").onclick = () => session.navigate(state.page - 1);
  $("next").onclick = () => session.navigate(state.page + 1);
  $("pageNumber").onchange = () => {
    const value = Number($("pageNumber").value);
    if (Number.isInteger(value) && value >= 1 && value <= state.numPages) session.navigate(value);
    else { $("pageNumber").value = state.page; $("status").textContent = "请输入 1 至 " + state.numPages + " 之间的页码"; }
  };
  $("pageNumber").onkeydown = event => { if (event.key === "Enter") { event.preventDefault(); $("pageNumber").blur(); } };
  /** 适配模式只调用现有缩放接口；固定百分比与自适应状态互不覆盖。 */
  function syncZoomPicker() {
    if (!state) return;
    const picker = $("zoom"), percent = Math.round(state.scale * 1000) / 10, fit = $("zoomFit");
    if (document.activeElement !== picker) { picker.value = percent + "%"; picker.removeAttribute("aria-invalid"); picker.setCustomValidity(""); }
    picker.dataset.scale = String(state.scale);
    picker.setAttribute("aria-valuenow", String(percent));
    picker.setAttribute("aria-valuetext", percent + "%" + (fitMode === "fit-page" ? "，适合页面" : fitMode === "fit-width" ? "，适合宽度" : ""));
    fit.dataset.mode = fitMode || "";
    fit.disabled = state.view !== "ready" || !viewInfo || viewInfo.pageNumber !== state.page;
    fit.setAttribute("aria-pressed", String(!!fitMode));
    fit.textContent = fitMode === "fit-page" ? "适合宽度" : "适合页面";
    fit.title = (fitMode === "fit-page" ? "当前适合页面；点击适合宽度" : fitMode === "fit-width" ? "当前适合宽度；点击适合页面" : "适合页面；再次点击切换为适合宽度") + "。输入百分比或点击加减可退出自动适配。";
    fit.setAttribute("aria-label", fit.title);
  }
  function fitCurrentPage(mode) {
    if (!viewInfo || state?.view !== "ready" || viewInfo.pageNumber !== state.page) { syncZoomPicker(); return; }
    const scale=calculateFit(viewInfo.width/viewInfo.scale,viewInfo.height/viewInfo.scale,mode);
    if (Number.isFinite(scale) && Math.abs(scale - state.scale) >= .001) session.zoom(scale);
    syncZoomPicker();
  }
  function calculateFit(pageWidth,pageHeight,mode=fitMode) {
    const viewport = $("viewport"), style = getComputedStyle(viewport);
    const width = viewport.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - 2;
    const height = viewport.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom) - 2;
    const factor = mode === "fit-width" ? width / pageWidth : Math.min(width / pageWidth, height / pageHeight);
    return Math.max(.25, Math.min(4, Math.floor(factor * 1000) / 1000));
  }
  function scheduleFit() {
    clearTimeout(fitTimer);
    if (!fitMode || splitterPointer !== null) return;
    fitTimer = setTimeout(() => { if (fitMode && splitterPointer === null) fitCurrentPage(fitMode); }, 180);
  }
  function manualZoom(percent) {
    if (state?.source !== "ready") return;
    fitMode = null; clearTimeout(fitTimer); fitTimer = null;
    const value = Math.max(25, Math.min(400, percent));
    $("zoom").value = value + "%"; $("zoom").removeAttribute("aria-invalid"); $("zoom").setCustomValidity("");
    session.zoom(value / 100); syncZoomPicker();
    // 百分比不变时 session 不重渲染，但退出适配仍需同步右侧的显示模式。
    syncBilingualPage(); reflowPreview?.refresh();
  }
  function commitZoom() {
    const input = $("zoom"), raw = input.value.trim(), value = Number(raw.replace(/%$/, "").trim());
    if (zoomEditDocument !== currentDocument || !zoomEdited && raw === input.dataset.editValue) return true;
    if (!/^\d+(?:\.\d{1,2})?\s*%?$/.test(raw) || !Number.isFinite(value) || value < 25 || value > 400) {
      input.setAttribute("aria-invalid", "true"); input.setCustomValidity("请输入 25% 至 400% 之间的缩放比例。"); return false;
    }
    manualZoom(value); input.dataset.editValue = input.value; zoomEdited = false; return true;
  }
  $("zoom").onfocus = () => { zoomEditDocument = currentDocument; zoomEdited = false; $("zoom").dataset.editValue = $("zoom").value; $("zoom").select(); };
  $("zoom").oninput = () => { zoomEdited = true; $("zoom").removeAttribute("aria-invalid"); $("zoom").setCustomValidity(""); };
  $("zoom").onblur = () => { if (!$("zoom").disabled) commitZoom(); syncZoomPicker(); };
  $("zoom").onkeydown = event => {
    if (event.isComposing) return;
    if (event.key === "Enter") { event.preventDefault(); if (commitZoom()) $("zoom").blur(); else $("zoom").reportValidity(); }
    else if (event.key === "Escape") { event.preventDefault(); zoomEdited = false; $("zoom").value = $("zoom").dataset.editValue; $("zoom").blur(); }
    else if (["ArrowUp", "ArrowDown"].includes(event.key)) { event.preventDefault(); manualZoom(Math.round(state.scale * 1000) / 10 + (event.key === "ArrowUp" ? 10 : -10)); }
  };
  $("zoomIn").onclick = () => manualZoom(Math.round(state.scale * 1000) / 10 + 10);
  $("zoomOut").onclick = () => manualZoom(Math.round(state.scale * 1000) / 10 - 10);
  $("zoomFit").onclick = () => {
    fitMode = fitMode === "fit-page" ? "fit-width" : "fit-page"; clearTimeout(fitTimer); fitTimer = null;
    fitCurrentPage(fitMode); syncBilingualPage(); reflowPreview?.refresh();
  };
  $("rotate").onclick = session.rotate;
  $("retry").onclick = session.retry;
  $("cancel").onclick = () => { finishPassword(null); void session.cancel(); };
  $("close").onclick = () => { if(!discardDrafts())return;lastFileAttempt = null; finishPassword(null); void session.close(); };
  $("passwordForm").onsubmit = event => { event.preventDefault(); finishPassword($("password").value); };
  $("passwordCancel").onclick = () => finishPassword(null);
  $("passwordDialog").addEventListener("cancel", event => { event.preventDefault(); finishPassword(null); });
  $("startTranslation").onclick = () => {
    if (startTask || configDraft || $("startTranslation").disabled) return;
    statusChannel = "translation";
    const task = Promise.resolve(translation.start()); startTask = task; updateTranslationControls();
    void task.catch(error => {
      $("translationStatus").textContent = E.normalize(error, "translate").message;
      $("translationStatus").dataset.error = "true";
    }).finally(() => { if (startTask === task) { startTask = null; updateTranslationControls(); } });
  };
  $("cancelTranslation").onclick=translation.cancel;
  /** 对照开关只更新外层网格和可访问状态，不调用 Renderer，避免开关侧栏时重算原位译文。 */
  const wideReader = window.matchMedia("(min-width:951px)");
  let readerShare = 60, splitterPointer = null;
  try { const saved = Number(localStorage.getItem("bt-pdf-reader-share")); if (saved >= 35 && saved <= 75) readerShare = saved; } catch (_) {}
  function setReaderShare(value) {
    readerShare = Math.max(35, Math.min(75, Math.round(value)));
    const columns = $("comparisonSplitter").parentElement;
    columns.style.setProperty("--pdf-column", readerShare + "fr");
    columns.style.setProperty("--text-column", (100 - readerShare) + "fr");
    $("comparisonSplitter").setAttribute("aria-valuenow", String(readerShare));
    $("comparisonSplitter").setAttribute("aria-valuetext", "PDF 区域 " + readerShare + "%");
    if (splitterPointer === null) { persistReaderShare(); scheduleFit(); }
  }
  function persistReaderShare() {
    try { localStorage.setItem("bt-pdf-reader-share", String(readerShare)); } catch (_) {}
  }
  function endSplitterDrag() {
    const splitter = $("comparisonSplitter"), pointer = splitterPointer; splitterPointer = null;
    if (pointer !== null && splitter.hasPointerCapture(pointer)) splitter.releasePointerCapture(pointer);
    splitter.closest(".reader-workspace").dataset.resizing = "false";
    if (pointer !== null) { persistReaderShare(); scheduleFit(); }
  }
  $("comparisonSplitter").onpointerdown = event => {
    if (event.button !== 0 || !wideReader.matches) return;
    event.preventDefault(); splitterPointer = event.pointerId;
    $("comparisonSplitter").setPointerCapture(event.pointerId);
    $("comparisonSplitter").closest(".reader-workspace").dataset.resizing = "true";
  };
  $("comparisonSplitter").onpointermove = event => {
    if (event.pointerId !== splitterPointer) return;
    const columns = $("comparisonSplitter").parentElement, rect = columns.getBoundingClientRect(), style = getComputedStyle(columns);
    const padding = parseFloat(style.paddingLeft), gap = parseFloat(style.columnGap);
    const available = columns.clientWidth - padding - parseFloat(style.paddingRight) - 2 * gap - 8;
    if (available > 0) setReaderShare((event.clientX - rect.left - padding - gap - 4) / available * 100);
  };
  for (const name of ["pointerup", "pointercancel", "lostpointercapture"]) $("comparisonSplitter").addEventListener(name, endSplitterDrag);
  $("comparisonSplitter").ondblclick = () => setReaderShare(60);
  $("comparisonSplitter").onkeydown = event => {
    const value = {ArrowLeft: readerShare - 5, ArrowRight: readerShare + 5, Home: 35, End: 75}[event.key];
    if (value === undefined) return;
    event.preventDefault(); setReaderShare(value);
  };
  wideReader.addEventListener("change", () => { endSplitterDrag(); updateTextComparison(); });
  const viewportObserver = new ResizeObserver(scheduleFit);
  viewportObserver.observe($("viewport"));
  setReaderShare(readerShare);
  function updateTextComparison() {
    const card = $("translationCard"), toggle = $("toggleTextComparison");
    if (viewMode === "original") comparisonOpen = false;
    const visible = comparisonOpen && !openPanel;
    const structuredVisible = viewMode === "bilingual" && !comparisonOpen && !openPanel;
    const sidebarVisible = structuredVisible || comparisonOpen || !!openPanel;
    if(!structuredVisible&&!$("structuredCard").hidden)rememberPanelPosition();
    const structuredOpening=structuredVisible&&$("structuredCard").hidden;
    $("structuredCard").hidden = !structuredVisible;
    if(structuredOpening)$("structuredRows").scrollTop=structuredScroll;
    const returnFocus = (!visible && card.contains(document.activeElement)) ||
      ((!visible || !wideReader.matches) && document.activeElement === $("comparisonSplitter"));
    const opening = visible && card.hidden;
    if (!visible && !card.hidden) comparisonScroll = $("translationRows").scrollTop;
    card.hidden = !visible;
    if (opening) $("translationRows").scrollTop = comparisonScroll;
    card.setAttribute("aria-hidden", String(!visible || !!openPanel));
    document.body.dataset.comparisonOpen = String(visible);
    document.body.dataset.sidebarOpen = String(sidebarVisible);
    toggle.setAttribute("aria-expanded", String(visible));
    toggle.disabled = viewMode === "original";
    toggle.title = viewMode === "original" ? "请切换到译文或双语对照使用翻译检查" : openPanel ? "切换到翻译检查" : visible ? "收起翻译检查" : "展开翻译检查";
    $("comparisonSplitter").hidden = !sidebarVisible || !wideReader.matches;
    if (!sidebarVisible || !wideReader.matches) endSplitterDrag();
    applyComparisonFilter();
    syncBilingualPage();reflowPreview?.setVisible(structuredVisible&&$("bilingualLayout").value==="flow");
    if (returnFocus) toggle.focus({preventScroll: true});
    scheduleFit();
  }
  $("toggleTextComparison").onclick = () => {
    if (openPanel) { comparisonOpen = true; showReaderPanel(null, false); }
    else { comparisonOpen = !comparisonOpen; updateTextComparison(); }
  };
  $("closeTextComparison").onclick = () => {
    comparisonOpen = false;
    updateTextComparison();
  };
  // 三种阅读模式仅控制展示；翻译检查为独立辅助面板，不修改翻译会话。
  // 模式切换不触碰翻译会话与缓存，不发请求、不清结果、不中断任务。
  function applyViewMode() {
    document.body.dataset.viewMode = viewMode;
    $("viewMode").value = viewMode;
    $("showOriginal").setAttribute("aria-pressed", String(viewMode === "original"));
    $("showTranslated").setAttribute("aria-pressed", String(viewMode === "translated"));
    $("showBilingual").setAttribute("aria-pressed", String(viewMode === "bilingual"));
    $("pageViewTitle").textContent = viewMode === "translated" ? "原位译文" : "原 PDF";
    updateTextComparison();
    renderer.setVisible(viewMode === "translated");
  }
  for (const [id, mode] of [["showOriginal", "original"], ["showTranslated", "translated"], ["showBilingual", "bilingual"]]) {
    $(id).onclick = () => { if (viewMode !== mode) { viewMode = mode; comparisonOpen = false; applyViewMode(); } };
  }
  $("viewMode").onchange = () => {
    const selected = $("viewMode").value;
    // 旧双语值只在进入时映射一次，日常原文/译文切换不改对照状态。
    viewMode = selected;
    comparisonOpen = false;
    applyViewMode();
  };
  // P3-D 面板 → PDF 联动：委托点击与键盘（Enter/Space），定位失败 no-op，不跳错误块。
  $("translationRows").addEventListener("click", event => {
    const row = event.target.closest(".translation-row");
    if (row) focusPdfBlock(row.dataset.blockId);
  });
  $("translationRows").addEventListener("keydown", event => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const row = event.target.closest(".translation-row");
    if (row) { event.preventDefault(); focusPdfBlock(row.dataset.blockId); }
  });
  for (const id of ["translationService", "translationFrom", "translationTo"]) $(id).onchange = updateConfigDraft;
  $("applyTranslationConfig").onclick = () => {
    if (!configDraft || !translationState?.configReady || !discardDrafts()) return;
    appliedConfig = {...window.BT_SERVICES.parse($("translationService").value), from: $("translationFrom").value, to: $("translationTo").value};
    configDraft = false;
    translation.select(appliedConfig);
    updateConfigDraft(); updateConfigSummary();
  };
  $("refreshTranslationConfig").onclick=()=>{void translation.loadConfig();};
  $("openTranslationSettings").onclick=()=>{
    try{chrome.runtime.sendMessage({action:"OPEN_SETTINGS"},()=>{void chrome.runtime.lastError;});}catch(_){}
  };
  $("manageExportFonts").onclick = () => {
    showReaderPanel("settings");
    $("advancedResources").open = true;
    $("exportFonts").open = true;
    $("exportFonts").scrollIntoView({block: "nearest", behavior: scrollBehavior()});
    $("exportFonts").querySelector("summary").focus({preventScroll: true});
  };
  // P4-D OCR 语言模型管理：状态=注册表+本地存储快照；下载必须在点击手势链内同步申请来源授权。
  const modelStore=window.BT_PDF_OCR_MODEL_STORE;
  const modelSize=bytes=>" "+(bytes/1048576).toFixed(1)+" MB";
  let modelRenderVersion = 0, fontRenderVersion = 0;
  function resourceMessage(id, text, error = false) {
    $(id).textContent = text; $(id).dataset.error = String(error);
  }
  /**
   * 启动一个本机资源任务（下载 / 删除 / 重新下载），返回在途任务；同一项已在途时返回 null，不启动第二个。
   * 来源授权必须在本点击手势链内同步发起，所以启动段不能有 await；进度写状态行，结束统一重绘。
   */
  function startResourceTask({store, entry, tasks, statusId, render, button = null, mode = "download"}) {
    if (!entry || tasks.has(entry.code)) return null;
    const labels = mode === "remove" ? ["正在删除…", "已从本机删除"]
      : mode === "repair" ? ["重新下载中…", "已重新下载安装，可离线使用"]
        : ["下载中…", "已安装，可离线使用"];
    const task = {button, text: labels[0], controller: new AbortController(), remove: mode === "remove"};
    let work;
    try {
      // 不能把 authorize 移到 Promise 回调或 await 后，否则会丢失用户授权手势。
      const authorization = mode === "remove" ? null : store.authorize();
      tasks.set(entry.code, task);
      if (button) { button.disabled = true; button.textContent = task.text; appendResourceCancel(button.closest("li"), task); }
      statusChannel = statusId === "ocrModelStatus" ? "models" : "fonts";
      resourceMessage(statusId, task.text + entry.label);
      if (statusId === "exportFontStatus") void refreshFontBar(true);
      const context = {authorization, signal: task.controller.signal, onProgress({loaded, total}) {
        task.text = total > 0 ? "下载中 " + Math.min(100, Math.round(loaded / total * 100)) + "%" : "下载中…";
        if (task.button) task.button.textContent = task.text;
        resourceMessage(statusId, entry.label + "：" + task.text);
        if (statusId === "exportFontStatus") void refreshFontBar(true);
      }};
      // repair 先删后下：坏字节记录必须真正被替换，否则下载会对「已安装」幂等返回，重演同一失败。
      work = mode === "download" ? store.download(entry.code, context)
        : mode === "remove" ? store.remove(entry.code)
          : (async () => { await store.remove(entry.code); return store.download(entry.code, context); })();
    } catch (error) { work = Promise.reject(error); }
    void Promise.resolve(work)
      .then(() => resourceMessage(statusId, entry.label + labels[1]))
      .catch(error => resourceMessage(statusId, task.controller.signal.aborted ? "已取消下载：" + entry.label :
        E.normalize(error, mode === "remove" ? "storage" : "download").message, !task.controller.signal.aborted))
      .finally(() => {
        tasks.delete(entry.code); void render(); refreshStatusUI();
        if (statusId === "exportFontStatus") void refreshFontBar(true);
      });
    return task;
  }
  /** 保留正在操作的按钮状态；列表折叠再展开不能启动第二次下载。授权仍在点击链同步发起。 */
  function bindResourceButton(button, {store, entry, tasks, statusId, render, remove = false}) {
    const existing = tasks.get(entry.code);
    if (existing) { existing.button = button; button.disabled = true; button.textContent = existing.text; }
    button.onclick = () => startResourceTask({store, entry, tasks, statusId, render, button,
      mode: remove ? "remove" : "download"});
  }
  function appendResourceCancel(item, task) {
    if (!item || !task || task.remove) return;
    const cancel = document.createElement("button"); cancel.type = "button"; cancel.className = "resource-cancel"; cancel.textContent = "取消下载";
    cancel.onclick = () => { cancel.disabled = true; task.controller.abort(); };
    item.append(cancel);
  }
  async function renderOcrModels() {
    const host=$("ocrModelList");
    const version = ++modelRenderVersion;
    let installed;
    try{installed=await modelStore.installed();}catch(_){installed=new Set();}
    if (version !== modelRenderVersion) return;
    host.replaceChildren();
    for(const model of window.BT_PDF_OCR_MODELS.list()){
      const item=document.createElement("li"),name=document.createElement("span"),tag=document.createElement("span");
      name.textContent=model.label+"（"+model.code+"）";tag.className="model-status";
      if(model.bundled){
        tag.textContent="已随包";item.append(name,tag);
      }else if(installed.has(model.code)){
        tag.textContent="已安装"+modelSize(model.bytes);
        const remove=document.createElement("button");remove.type="button";remove.textContent="删除";
        bindResourceButton(remove, {store: modelStore, entry: model, tasks: modelDownloads,
          statusId: "ocrModelStatus", render: renderOcrModels, remove: true});
        item.append(name,tag,remove);
      }else{
        tag.textContent="未安装"+modelSize(model.bytes);
        const download=document.createElement("button");download.type="button";download.textContent="下载";
        bindResourceButton(download, {store: modelStore, entry: model, tasks: modelDownloads,
          statusId: "ocrModelStatus", render: renderOcrModels});
        item.append(name,tag,download);
      }
      appendResourceCancel(item, modelDownloads.get(model.code));
      host.append(item);
    }
  }
  $("ocrModels").addEventListener("toggle",()=>{if($("ocrModels").open)void renderOcrModels();});
  void renderOcrModels();
  // P5-C 导出字体管理：注册表 + 本机存储快照；下载与 OCR 模型同一模式，在点击手势链内同步申请来源授权。
  const fontStore=window.BT_PDF_FONT_STORE,fontRegistry=window.BT_PDF_EXPORT_FONTS;
  let fontInstalled=new Set();
  async function renderExportFonts(){
    const host=$("exportFontList");
    const version = ++fontRenderVersion;
    let installed, used;
    try{installed=await fontStore.installed();}catch(_){installed=new Set();}
    try{used=await fontStore.usage();}catch(_){used={count:0,bytes:0};}
    if (version !== fontRenderVersion) return;
    fontInstalled=installed;
    host.replaceChildren();
    for(const entry of fontRegistry.list()){
      const item=document.createElement("li"),name=document.createElement("span"),tag=document.createElement("span");
      name.textContent=entry.label;tag.className="model-status";
      const note=document.createElement("details"),summary=document.createElement("summary"),coverage=document.createElement("span");
      note.className="font-note";summary.textContent="覆盖详情";
      coverage.textContent="覆盖："+entry.coverage+"　不含："+entry.gaps;note.append(summary,coverage);
      if(entry.bundled){
        tag.textContent="已随包";
        item.append(name,tag,note);
      }else if(installed.has(entry.code)){
        tag.textContent="已安装"+modelSize(entry.bytes);
        const remove=document.createElement("button");remove.type="button";remove.textContent="删除";
        bindResourceButton(remove, {store: fontStore, entry, tasks: fontDownloads,
          statusId: "exportFontStatus", render: renderExportFonts, remove: true});
        item.append(name,tag,remove,note);
      }else{
        tag.textContent="未安装"+modelSize(entry.bytes);
        const download=document.createElement("button");download.type="button";download.textContent="下载";
        bindResourceButton(download, {store: fontStore, entry, tasks: fontDownloads,
          statusId: "exportFontStatus", render: renderExportFonts});
        item.append(name,tag,download,note);
      }
      appendResourceCancel(item, fontDownloads.get(entry.code));
      host.append(item);
    }
    // 占用按真正存入本机的字节统计（注册表声明值只用于「未安装」提示）；坏字体的重下载入口就在同一行。
    $("exportFontStorage").textContent=used.count?"本机已存 "+used.count+" 项，占用"+modelSize(used.bytes)
      :"本机没有已下载的导出字体";
    const repair=$("exportFontRepair");
    repair.hidden=!used.count;
    repair.disabled=fontDownloads.size>0;
  }
  $("exportFontRepair").onclick=()=>{
    // 修复损坏字体＝删除本机记录后按钉死摘要重新下载安装；按字体代码去重，不并行启动同一项两次。
    for(const entry of fontRegistry.list())
      if(!entry.bundled&&fontInstalled.has(entry.code))
        startResourceTask({store:fontStore,entry,tasks:fontDownloads,statusId:"exportFontStatus",
          render:renderExportFonts,mode:"repair"});
  };
  $("exportFonts").addEventListener("toggle",()=>{if($("exportFonts").open)void renderExportFonts();});
  void renderExportFonts();
  /**
   * P7-D 默认层级：这一行只报「自动匹配 + 一个状态」（已就绪 / 需要下载 / 下载中 / 字体异常 / 文字不支持）。
   * 状态按真正要写入 PDF 的译文文本判定（exporter.previewFonts），不按目标语言猜，
   * 因此面板显示的分级与导出实际嵌入的分级同源；明细、列表、删除与存储占用都在「管理字体」里。
   */
  let fontBarKey="",fontBarToken=0,fontBarAction=null;
  const fontBarKeySource=()=>[$("exportMode").value,$("exportRange").value,state?.page,
    translationState?.phase,exportState?.phase,exportState?.fontFault,(exportState?.pages||[]).join(","),
    exportState?.checkedText||"",fontDownloads.size,
    String(exportState?.message||"").match(/正在下载导出字体：([\d.]+)/)?.[1]||""].join("|");
  /** 预览口径与导出选级一致：所选页只在「最近一次体检仍对应当前范围文本」时采用，否则按当前页。 */
  function fontBarPages(){
    return $("exportMode").value==="range"&&exportState?.pages?.length&&
      exportState.checkedText===$("exportRange").value?exportState.pages:null;
  }
  async function refreshFontBar(force){
    if (!fontBarReady) return;
    const key=fontBarKeySource();
    if(!force&&key===fontBarKey)return;
    fontBarKey=key;
    const version=++fontBarToken;
    const chip=$("exportFontState"),note=$("exportFontDetail"),fix=$("exportFontFix");
    const show=(text,detail,level,action)=>{
      chip.textContent=text;chip.dataset.level=level;note.textContent=detail;
      fontBarAction=action||null;fix.hidden=!action;if(action)fix.textContent=action.text;
    };
    const running=[...fontDownloads.entries()].find(([,item])=>!item.remove);
    if(running){
      show("下载中","正在下载 "+fontRegistry.label(running[0])+"："+running[1].text,"normal");return;
    }
    if(exportState?.busy&&/正在下载导出字体/.test(String(exportState.message||""))){
      show("下载中",exportState.message,"normal");return;
    }
    let preview=null;
    try{preview=await exporter.previewFonts(fontBarPages());}
    catch(error){
      if(version!==fontBarToken)return;
      show("字体异常",E.normalize(error,"font").message,"error");return;
    }
    if(version!==fontBarToken)return;
    if(exportState?.fontFault){
      // 失败记录已被导出侧自动作废：预览显示分级齐备即说明已重新装好，只差再点一次导出。
      if(preview.state==="ready")show("字体异常",preview.labels+" 已重新就绪，请再次点击「导出」","warning");
      else show("字体异常","本机导出字体不可用，记录已自动作废；点「重新下载」后再点击「导出」","error",
        {text:"重新下载",codes:preview.missing});
      return;
    }
    if(preview.state==="none"){show("未使用","本页还没有可导出的译文，翻译后自动匹配所需字体。","normal");return;}
    if(preview.state==="blocked"){
      show("文字不支持","这些文字没有可原位导出的字体："+fontRegistry.describeBlocked(preview.blocked)+
        "；可改用原文导出，或把目标语言改为字体覆盖的语言。","error");
      return;
    }
    if(preview.state==="need"){
      show("需要下载","本次译文将使用 "+preview.labels+"，本机还没有（约"+modelSize(preview.bytes)+
        "，经大小与 SHA-256 校验后仅存本机）。点「下载」预取，或直接导出时自动下载。","warning",
        {text:"下载",codes:preview.missing});
      return;
    }
    show("已就绪","自动匹配："+preview.labels+"（本机已有，不重复下载）","normal");
  }
  fontBarReady = true;
  $("exportFontFix").onclick=()=>{
    // 授权在本点击手势链内同步发起（与列表里的下载同一模式）；下载完成后状态行自动改为「已就绪」。
    for(const code of fontBarAction?.codes||[])
      startResourceTask({store:fontStore,entry:fontRegistry.entry(code),tasks:fontDownloads,
        statusId:"exportFontStatus",render:renderExportFonts,mode:"download"});
    void refreshFontBar(true);
  };
  // 悬浮球、面板与工具栏以 #url=<编码地址> 携带来源；来源域名已授权时复用在线加载流程自动加载（不启动翻译），
  // 未授权时仅预填，由用户点击加载补足授权手势。附加 #debug=1 开启 P3 调试描边（默认关闭，可与 url 参数组合）。
  function applyHashState() {
    const params = new URLSearchParams(location.hash.slice(1));
    debugOverlay = params.get("debug") === "1";
    renderer.refresh();
    const bridgeUrl = params.get("url");
    if (!bridgeUrl || !/^https?:\/\//i.test(bridgeUrl)) return;
    $("pdfUrl").value = bridgeUrl;
    const authorization = window.BT_PDF_SOURCE.peek(bridgeUrl);
    if (!authorization) return;
    chrome.permissions.contains({origins: [authorization.url.origin + "/*"]}, granted => {
      if (granted && $("pdfUrl").value === bridgeUrl && discardDrafts()) void session.load({authorization});
    });
  }
  showReaderPanel("file", false);
  applyViewMode();
  applyHashState();
  refreshStatusUI();
  // 复用已有阅读页标签属于同文档 hash 导航；地址变化必须重读来源，避免跨入口复用旧来源。
  window.addEventListener("hashchange", applyHashState);
  window.addEventListener("pagehide", () => { statusObserver.disconnect(); viewportObserver.disconnect();bilingualObserver.disconnect();clearBilingualPage(); clearTimeout(fitTimer);
    clearBlockHighlight();
    for (const task of [...modelDownloads.values(), ...fontDownloads.values()]) task.controller.abort();
    finishPassword(null);reflowPreview?.dispose(); exporter.dispose(); translation.dispose(); session.dispose(); });
  // 退回 BFCache 的页面已释放所有文档；重新载入干净阅读页，绝不恢复失效 Worker。
  window.addEventListener("pageshow", event => { if (event.persisted) location.reload(); });
})();
