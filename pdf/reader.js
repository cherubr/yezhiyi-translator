(function() {
  "use strict";
  const $ = id => document.getElementById(id), E = window.BT_PDF_ERRORS;
  let state, passwordRequest = null, translationState = null, debugOverlay = false;
  let lastRows = [], planSummary = null, viewMode = "translated";
  // 译文模式的对照开关只属于界面；翻页和任务进度更新不会重置用户的展开状态。
  let translatedComparisonOpen = false;
  // P5-B 导出：页侧只持有当前文档句柄与导出状态，导出编排全部在 BT_PDF_EXPORTER 内。
  let currentDocument = null, exportState = null;
  const translationCards = new Map();
  let statusChannel = "source";
  const modelDownloads = new Map(), fontDownloads = new Map();
  let appliedConfig = null, configDraft = false, startTask = null, lastFileAttempt = null;
  const scrollBehavior = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
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
      message = translationState.phase === "completed" ? "本页翻译完成" : "本页部分完成，可展开文字对照查看保留或失败内容";
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
    $("translationProgress").textContent = lastRows.length ? "完成 " + finished + "/" + lastRows.length + " · 失败 " + failed +
      (Number.isFinite(fallback) ? " · 回退 " + fallback : "") : "";
    $("translationProgress").hidden = !lastRows.length;
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
  // UI-1 只管理外层面板显隐；不隐藏阅读树、不调整阅读模式，也不调用任何业务任务。
  const panelButtons = {file: "openFilePanel", settings: "openSettingsPanel", export: "openExportPanel"};
  const panelTitles = {file: "打开文件", settings: "设置", export: "导出 PDF"};
  let openPanel = null;
  function showReaderPanel(name, focus = true) {
    const panel = $("readerPanel"), previous = openPanel;
    const returnFocus = !name && panel.contains(document.activeElement);
    openPanel = name;
    panel.hidden = !name;
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
    if (event.key !== "Escape" || event.defaultPrevented || $("passwordDialog").open) return;
    if (openPanel) { event.preventDefault(); showReaderPanel(null); }
    else if (viewMode === "translated" && translatedComparisonOpen) {
      event.preventDefault(); translatedComparisonOpen = false; updateTextComparison();
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
  function revealComparisonRow(card) {
    if (!card) return;
    if (viewMode === "original") { viewMode = "translated"; applyViewMode(); }
    translatedComparisonOpen = true; updateTextComparison();
    if (openPanel) showReaderPanel(null, false);
    card.element.scrollIntoView({block: "nearest", behavior: scrollBehavior()});
    card.element.focus({preventScroll: true}); highlightRow(card);
  }
  function showTranslationIssue() {
    const row = lastRows.find(item => item.result?.status === "failed") ||
      lastRows.find(item => planSummary?.numbers?.has(item.block.id)) || lastRows[0];
    if (row) revealComparisonRow(translationCards.get(row.block.id));
  }
  $("translationProgress").onclick = $("showFailedTranslation").onclick = showTranslationIssue;
  // P3-B 译文显示层：被动消费块坐标与渲染矩阵，只绘制调试描边，不参与翻译状态。
  const renderer = window.BT_PDF_TRANSLATION_RENDERER.create({isDebug: () => debugOverlay,
    // PDF 标记 → 文字对照：先展开并露出目标，再定位和高亮，不发翻译请求。
    onMarkerClick(blockId) {
      const card = translationCards.get(blockId);
      if (!card || viewMode !== "translated") return;
      revealComparisonRow(card);
    },
    onPlanSummary(summary) { planSummary = summary; updateTranslationStats(); }});
  /** DOM 只使用 textContent；文件名、地址和异常不作为 HTML 插入。 */
  function showState(next) {
    const previousSource = state?.source;
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
    $("zoom").value = String(state.scale);
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
    const busy = !!exportState?.busy, ready = state?.source === "ready" && !!currentDocument;
    const mode = $("exportMode").value, range = mode === "range";
    // 清单只在「范围模式 + 上次体检确实缺页 + 范围文本没改过」时出现；改文本或换口径都得重新体检。
    const checked = range && !busy && exportState?.phase === "incomplete" &&
      exportState?.checkedText === $("exportRange").value && exportState?.checkedStamp === translation.exportStamp();
    const choose = checked && !!exportState?.missing?.length;
    $("exportMode").disabled = busy || !ready;
    $("exportRangeField").hidden = !range;
    $("exportRange").disabled = busy || !ready;
    // P5-D 双语对照是导出侧的成对页口径，与阅读模式无关；原文导出没有对照页可言，故只隐藏不重置勾选。
    $("exportPairField").hidden = mode === "original";
    $("exportPair").disabled = busy || !ready;
    $("exportNow").disabled = !ready || busy || (mode === "translated" && !translationState?.hasRun);
    $("exportNow").textContent = busy ? (exportState?.task === "prepare" ? "正在补译…" : "正在导出…") : "导出";
    $("exportPrepare").hidden = !choose;
    $("exportKeepMissing").hidden = !choose;
    $("exportPreflight").hidden = !checked;
    $("exportPreflightSummary").textContent = checked ? exportState.message : "";
    $("exportModeHint").textContent = mode === "original" ? "导出完整源文件，内容保持不变。" :
      range ? "按指定页码导出；缺少译文时，先选择补译或保留原文。留空为当前页，最多 50 页。" :
      "导出当前页译文；无法原位显示的内容放入附录。";
    $("exportCancel").disabled = !busy;
    $("exportCancel").textContent = exportState?.task === "prepare" ? "取消补译" : "取消导出";
    $("exportStatus").textContent = exportState ? exportState.message : "导出前请先读取 PDF";
    $("exportStatus").dataset.error = String(exportState?.phase === "failed");
    if (busy) statusChannel = "export";
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
      host.replaceChildren();translationCards.clear();
      const empty=document.createElement("p");empty.className="translation-empty";
      empty.textContent="开始翻译后将在此显示本页文字对照。";host.append(empty);return;
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
        card={element,badge,source,target,note,timer:null};translationCards.set(block.id,card);
      }
      // OCR 块始终展示识别文字（置信度状态见 note，供校对）；仅原生不可靠文字层用占位提示。
      const original=block.reliable||block.source==="ocr"?block.text:"本区域文字层不能可靠提取，请查看左侧 PDF 原文。";
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
  function highlightRow(card) {
    if (card.timer) clearTimeout(card.timer);
    card.element.classList.add("translation-row-active");
    card.timer = setTimeout(() => { card.element.classList.remove("translation-row-active"); card.timer = null; }, 1600);
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
  }
  /** P3-D 三分类统计与行徽标：原位=overlay+unchanged；回退有译文=plan.fallbacks；未完成=null/failed/skipped。 */
  function updateTranslationStats() {
    const rows = lastRows;
    const unchanged = rows.filter(row => row.result?.status === "unchanged").length;
    const unfinished = rows.filter(row => !row.result || row.result.status === "failed" || row.result.status === "skipped").length;
    const stats = planSummary ? planSummary.stats : null;
    $("translationStats").textContent = !rows.length ? "开始翻译后显示原位/回退统计"
      : !stats ? "原位译文规划中…"
      : "原位 " + (stats.overlay + unchanged) + " · 回退有译文 " + stats.fallback + " · 未完成 " + unfinished +
        (stats.pending ? " · 采样中 " + stats.pending : "");
    const numbers = planSummary ? planSummary.numbers : null;
    const reasons = new Map((planSummary ? planSummary.fallbacks : []).map(item => [item.blockId, item.reason]));
    for (const [id, card] of translationCards) {
      const show = !!(numbers && numbers.has(id) && reasons.has(id));
      card.badge.hidden = !show;
      if (show) { card.badge.textContent = String(numbers.get(id)); card.badge.title = "回退：" + reasons.get(id); }
    }
    refreshStatusUI();
  }
  const translation=window.BT_PDF_TRANSLATION_SESSION.create({
    onState(value){translationState=value;updateTranslationControls();},
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
    },onRows(rows,geometry,meta){lastRows=rows;renderRows(rows);renderer.setModel(rows,geometry);updateTranslationStats();
      // #debug=1 时输出页面分类与 OCR 区域（类型/原因/坐标与统计，不含文字内容）。
      if(debugOverlay&&meta)console.info("[pdf-ocr]",meta.classification?.type||"none",meta.ocr?.regions||[],meta.ocr?.stats||null);}
  });
  const session = window.BT_PDF_SESSION.create({onState: showState, onPassword: askPassword,
    // 导出需要文档句柄渲染独立证据位图；页侧自己留存一份，翻译会话行为不变。
    onDocument(value){currentDocument=value;translation.setDocument(value);updateExportControls();},
    onPage:translation.setPage,
    onViewReady(info){translation.viewReady();renderer.setView(info);},
    onClear() { $("canvasHost").replaceChildren(); $("empty").hidden = false; renderer.clear(); },
    onCanvas(canvas) {
      canvas.setAttribute("role", "img"); canvas.setAttribute("aria-label", "PDF 第 " + state.page + " 页原文图像");
      $("canvasHost").replaceChildren(renderer.mount(canvas)); $("empty").hidden = true;
      $("viewport").scrollTop = $("viewport").scrollLeft = 0;
    }});
  // P5-B 导出编排：快照与回退编号在导出瞬间读取，导出过程不触发翻译与 OCR。
  // P5b 多页导出：范围体检/批量快照/补译都只经 translation 读取，页侧不保存第二份译文状态。
  const exporter = window.BT_PDF_EXPORTER.create({session,
    getDocument: () => currentDocument,
    getSnapshot: () => translation.exportSnapshot(),
    getSnapshots: pages => translation.exportSnapshots(pages),
    getPageStatus: pages => translation.pageStatus(pages),
    getStamp: () => translation.exportStamp(),
    preparePages: (pages, options) => translation.preparePages(pages, options),
    getPage: () => state?.page || 1,
    getMarkers: () => planSummary,
    getName: () => state?.name || "",
    onState(value) { exportState = value; updateExportControls(); }});
  $("exportMode").onchange = () => updateExportControls();
  // 范围文本一改，上一次体检的清单与选择按钮立即失效（导出侧也会拒绝过期清单，双重防线）。
  $("exportRange").oninput = () => updateExportControls();
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
    const file = $("fileInput").files[0]; $("fileInput").value = "";
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
  $("zoom").onchange = () => session.zoom(Number($("zoom").value));
  const scales = [...$("zoom").options].map(option => Number(option.value));
  $("zoomIn").onclick = () => session.zoom(scales.find(value => value > state.scale) || 4);
  $("zoomOut").onclick = () => session.zoom([...scales].reverse().find(value => value < state.scale) || 0.25);
  $("rotate").onclick = session.rotate;
  $("retry").onclick = session.retry;
  $("cancel").onclick = () => { finishPassword(null); void session.cancel(); };
  $("close").onclick = () => { lastFileAttempt = null; finishPassword(null); void session.close(); };
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
  function setReaderShare(value) {
    readerShare = Math.max(35, Math.min(75, Math.round(value)));
    const columns = $("comparisonSplitter").parentElement;
    columns.style.setProperty("--pdf-column", readerShare + "fr");
    columns.style.setProperty("--text-column", (100 - readerShare) + "fr");
    $("comparisonSplitter").setAttribute("aria-valuenow", String(readerShare));
    $("comparisonSplitter").setAttribute("aria-valuetext", "PDF 区域 " + readerShare + "%");
  }
  function endSplitterDrag() {
    const splitter = $("comparisonSplitter"), pointer = splitterPointer; splitterPointer = null;
    if (pointer !== null && splitter.hasPointerCapture(pointer)) splitter.releasePointerCapture(pointer);
    splitter.closest(".reader-workspace").dataset.resizing = "false";
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
  function updateTextComparison() {
    const card = $("translationCard"), toggle = $("toggleTextComparison");
    const visible = viewMode === "bilingual" || (viewMode === "translated" && translatedComparisonOpen);
    const returnFocus = (!visible && card.contains(document.activeElement)) ||
      ((!visible || !wideReader.matches) && document.activeElement === $("comparisonSplitter"));
    card.hidden = !visible;
    document.body.dataset.comparisonOpen = String(visible);
    toggle.hidden = viewMode !== "translated";
    toggle.setAttribute("aria-expanded", String(visible));
    toggle.title = visible ? "收起文字对照" : "展开文字对照";
    // 双语模式始终保留文字对照；需要全宽阅读时使用原文或译文模式。
    $("closeTextComparison").hidden = viewMode !== "translated";
    $("comparisonSplitter").hidden = !visible || !wideReader.matches;
    if (!visible || !wideReader.matches) endSplitterDrag();
    if (returnFocus) (viewMode === "translated" ? toggle : $("viewMode")).focus({preventScroll: true});
  }
  $("toggleTextComparison").onclick = () => {
    if (viewMode !== "translated") return;
    translatedComparisonOpen = !translatedComparisonOpen;
    updateTextComparison();
  };
  $("closeTextComparison").onclick = () => {
    if (viewMode !== "translated") return;
    translatedComparisonOpen = false;
    updateTextComparison();
  };
  // 原文=全宽 PDF；译文=原位译文（对照默认收起）；双语=原 PDF+文字对照。
  // 模式切换不触碰翻译会话与缓存，不发请求、不清结果、不中断任务。
  function applyViewMode() {
    document.body.dataset.viewMode = viewMode;
    $("viewMode").value = viewMode;
    $("pageViewTitle").textContent = viewMode === "translated" ? "原位译文" : "原 PDF";
    updateTextComparison();
    renderer.setVisible(viewMode === "translated");
  }
  $("viewMode").onchange = () => {
    viewMode = $("viewMode").value;
    translatedComparisonOpen = false;
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
    if (!configDraft || !translationState?.configReady) return;
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
  /** 保留正在操作的按钮状态；列表折叠再展开不能启动第二次下载。授权仍在点击链同步发起。 */
  function bindResourceButton(button, {store, entry, tasks, statusId, render, remove = false}) {
    const existing = tasks.get(entry.code);
    if (existing) { existing.button = button; button.disabled = true; button.textContent = existing.text; }
    button.onclick = () => {
      if (tasks.has(entry.code)) return;
    const task = {button, text: remove ? "正在删除…" : "下载中…", controller: new AbortController(), remove};
      let work;
      try {
        // 不能把 authorize 移到 Promise 回调或 await 后，否则会丢失用户授权手势。
        const authorization = remove ? null : store.authorize();
        tasks.set(entry.code, task); button.disabled = true; button.textContent = task.text;
        appendResourceCancel(button.closest("li"), task);
        statusChannel = statusId === "ocrModelStatus" ? "models" : "fonts";
        resourceMessage(statusId, task.text + entry.label);
        work = remove ? store.remove(entry.code) : store.download(entry.code, {authorization, signal: task.controller.signal,
          onProgress({loaded, total}) {
            task.text = total > 0 ? "下载中 " + Math.min(100, Math.round(loaded / total * 100)) + "%" : "下载中…";
            task.button.textContent = task.text;
            resourceMessage(statusId, entry.label + "：" + task.text);
          }});
      } catch (error) { work = Promise.reject(error); }
      void Promise.resolve(work)
        .then(() => resourceMessage(statusId, entry.label + (remove ? "已从本机删除" : "已安装，可离线使用")))
        .catch(error => resourceMessage(statusId, task.controller.signal.aborted ? "已取消下载：" + entry.label :
          E.normalize(error, remove ? "storage" : "download").message, !task.controller.signal.aborted))
        .finally(() => { tasks.delete(entry.code); void render(); refreshStatusUI(); });
    };
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
  async function renderExportFonts(){
    const host=$("exportFontList");
    const version = ++fontRenderVersion;
    let installed;
    try{installed=await fontStore.installed();}catch(_){installed=new Set();}
    if (version !== fontRenderVersion) return;
    host.replaceChildren();
    for(const entry of fontRegistry.list()){
      const item=document.createElement("li"),name=document.createElement("span"),tag=document.createElement("span");
      name.textContent=entry.label;tag.className="model-status";
      const note=document.createElement("span");note.className="font-note";
      note.textContent="覆盖："+entry.coverage+"　不含："+entry.gaps;
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
  }
  $("exportFonts").addEventListener("toggle",()=>{if($("exportFonts").open)void renderExportFonts();});
  void renderExportFonts();
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
      if (granted && $("pdfUrl").value === bridgeUrl) void session.load({authorization});
    });
  }
  showReaderPanel("file", false);
  applyViewMode();
  applyHashState();
  refreshStatusUI();
  // 复用已有阅读页标签属于同文档 hash 导航；地址变化必须重读来源，避免跨入口复用旧来源。
  window.addEventListener("hashchange", applyHashState);
  window.addEventListener("pagehide", () => { statusObserver.disconnect();
    for (const task of [...modelDownloads.values(), ...fontDownloads.values()]) task.controller.abort();
    finishPassword(null); exporter.dispose(); translation.dispose(); session.dispose(); });
  // 退回 BFCache 的页面已释放所有文档；重新载入干净阅读页，绝不恢复失效 Worker。
  window.addEventListener("pageshow", event => { if (event.persisted) location.reload(); });
})();
