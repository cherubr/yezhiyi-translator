(function(global) {
  "use strict";
  /**
   * P5-B/P5-C/P5b 导出编排（页侧）：只负责取字节、独立取证、选字体、投喂导出 Worker 与落地下载。
   * 不触发翻译请求与 OCR，不修改原始 PDF，不复用可见画布（证据位图独立预算、独立矩阵）。
   * 多页导出（P5b）：「导出」首击只做范围体检并列出缺失页，绝不悄悄发翻译请求或下载字体；
   * 补译走「翻译缺失页」（可取消，已完成页与已花额度保留），部分导出走「缺失页保留原文导出」，
   * 两者都必须由用户显式点选。真正导出时字体选级与下载授权仍留在点击手势内（同步完成）。
   * 证据判定与阅读层同一口径（pdf/pixel-evidence.js）：default-deny，扫描/复杂区域的遮罩由导出独立复核；
   * 逐页取证、取证完即释放画布，任一时刻只有一张证据位图存活。任一页失败即整单失败，只在全部生成后下载。
   * 字体门禁两层：注册表（pdf/export-fonts.js）只按文字类别选级并拦下无字体/需整形的文字；
   * 逐字缺字由 Worker 用真实嵌入字体权威判定（EXPORT_GLYPH_MISSING），页侧不维护缺字表以免与字体漂移。
   */
  const E = global.BT_PDF_ERRORS, EV = global.BT_PDF_PIXEL_EVIDENCE, P = global.BT_PDF_LAYOUT_PLANNER;
  const F = global.BT_PDF_EXPORT_FONTS, FS = global.BT_PDF_FONT_STORE;
  const WORKER_FILE = "pdf/export-worker.js";
  const EVIDENCE_SCALE = 2;              // 证据位图倍率：高于屏幕常见缩放，证明密度更强
  const EVIDENCE_PIXEL_BUDGET = 8000000; // 与可见画布预算独立，互不挤占
  const SAMPLE_PER_CHUNK = 8;            // 每轮采样块数，轮间让出事件循环，避免卡住阅读页交互
  const RELOAD_MS = 120000, COMPOSE_MS = 180000, COMPOSE_PER_PAGE_MS = 30000;
  // 双语口径每页多一次「内容流重编为 Form XObject + 引用绘制」，按每页 8 秒追加预算。
  const COMPOSE_PAIR_MS = 8000;
  const MAX_RANGE_PAGES = 50;            // 与 session 的单轮准备上限同值：一次导出不超过 50 页
  // Worker 原样透传的错误码：这些码的文案由 Worker/注册表给出，页侧不改写也不吞掉。
  const PASSTHROUGH_CODES = new Set(["EXPORT_ENCRYPTED", "EXPORT_SOURCE_CHANGED", "EXPORT_GLYPH_MISSING", "EXPORT_FONT_FAILED"]);
  function compose(a, b) {
    return [a[0]*b[0]+a[2]*b[1], a[1]*b[0]+a[3]*b[1], a[0]*b[2]+a[2]*b[3], a[1]*b[2]+a[3]*b[3],
      a[0]*b[4]+a[2]*b[5]+a[4], a[1]*b[4]+a[3]*b[5]+a[5]];
  }
  function invert(m) {
    const det = m[0]*m[3] - m[1]*m[2];
    if (!Number.isFinite(det) || det === 0) return null;
    return [m[3]/det, -m[1]/det, -m[2]/det, m[0]/det, (m[2]*m[5]-m[3]*m[4])/det, (m[1]*m[4]-m[0]*m[5])/det];
  }
  const yieldToPage = () => new Promise(resolve => setTimeout(resolve, 0));
  /** 文件名只取基名并去除路径/控制字符；原文与译文导出后缀区分，页码写入译文文件名。 */
  function fileName(name, suffix) {
    const base = String(name || "document").replace(/\.(pdf)$/i, "").replace(/[/\\:*?"<>|\u0000-\u001f]/g, "_").slice(0, 80) || "document";
    return base + suffix + ".pdf";
  }
  /** 连续页码压成「1-3,5,8」，用于文件名与界面提示，绝不列出上百个页码。 */
  function compact(pages) {
    const out = [];
    for (const page of pages) {
      const last = out[out.length - 1];
      if (last && last.to + 1 === page) { last.to = page; continue; }
      out.push({from: page, to: page});
    }
    return out.map(({from, to}) => (to > from ? from + "-" + to : String(from))).join(",");
  }
  /**
   * 书签计数如实播报：单页导出本就不建大纲，不报缺失；多页缺失必须写明不影响译文，
   * 绝不能让「书签构造失败」被界面读成成功。
   */
  function bookmarkNote(stats) {
    const count = Number(stats && stats.bookmarks) || 0;
    if (count > 0) return "；页码书签 " + count + " 条";
    return (Number(stats && stats.pages) || 0) > 1 ? "；页码书签未生成（不影响译文）" : "";
  }
  /**
   * 页码范围解析：接受「1-3,5,8-9」，容忍全角数字/逗号/顿号/分号、空格与多种连字符
   * （1 - 2、1~2、１－３、U+2010–U+2015、数学减号 U+2212、全角连字符 U+FF0D）；
   * 去重升序，上限 MAX_RANGE_PAGES。空白回落为当前页（与「本页译文」同一口径），
   * 越界、倒序区间和无法识别的片段直接报错，绝不做静默裁剪或截断。
   */
  function parseRange(text, numPages, fallbackPage) {
    const raw = String(text ?? "")
      .replace(/[\uFF10-\uFF19]/g, ch => String(ch.charCodeAt(0) - 0xFF10))
      .replace(/\s*[-\u2010-\u2015\u2212\uFF0D~\uFF5E\u301C]\s*/g, "-")
      .replace(/-{2,}/g, "-")
      .replace(/[，、；：\s]+/g, ",")
      .replace(/,+/g, ",").replace(/^,|,$/g, "");
    if (!raw) return {pages: Number.isInteger(fallbackPage) && fallbackPage >= 1 && fallbackPage <= numPages ? [fallbackPage] : [], error: null};
    if (!/^[0-9,-]+$/.test(raw)) return {pages: [], error: "页码范围只能包含数字、逗号和减号，例如 1-3,5,8-9"};
    const pages = new Set();
    for (const part of raw.split(",")) {
      if (!part) return {pages: [], error: "页码范围格式不正确，例如 1-3,5,8-9"};
      const bounds = part.split("-");
      if (bounds.some(v => !/^\d+$/.test(v)) || bounds.length > 2)
        return {pages: [], error: "无法识别的页码：" + part};
      const from = Number(bounds[0]), to = bounds.length === 2 ? Number(bounds[1]) : from;
      if (to < from) return {pages: [], error: "页码区间起点不能大于终点：" + part};
      if (from < 1 || to > numPages)
        return {pages: [], error: "页码超出文档范围（共 " + numPages + " 页）：" + part};
      for (let page = from; page <= to; page++) {
        pages.add(page);
        if (pages.size > MAX_RANGE_PAGES)
          return {pages: [], error: "一次最多导出 " + MAX_RANGE_PAGES + " 页，请缩小页码范围"};
      }
    }
    return {pages: [...pages].sort((a, b) => a - b), error: null};
  }

  function create({session, getDocument, getSnapshot, getSnapshots, getPageStatus, getStamp, preparePages,
    getPage = () => 1, getMarkers, getName, onState}) {
    let active = null, preparing = null, disposed = false, revokeTimer = 0;
    // pages/missing/partial/need 为最近一次范围体检结果，供阅读页展示清单与决定按钮可用性；task 区分导出/补译两种取消。
    const state = {phase: "idle", message: "导出前请先读取 PDF", busy: false, task: null, stats: null,
      pages: null, need: null, missing: null, partial: null, checkedText: null, checkedStamp: null};
    const publish = () => { if (!disposed) onState({...state}); };
    function download(bytes, name) {
      const blob = new Blob([bytes], {type: "application/pdf"});
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url; anchor.download = name; anchor.rel = "noopener";
      document.body.append(anchor); anchor.click(); anchor.remove();
      // 下载已由点击同步接管；延迟回收对象 URL，避免过早释放导致部分环境下载失败。
      if (revokeTimer) clearTimeout(revokeTimer);
      revokeTimer = setTimeout(() => { revokeTimer = 0; URL.revokeObjectURL(url); }, 10000);
    }
    /** 原始字节重读：本地文件重读 / 在线来源重新下载；只读，不触碰阅读器与渲染状态。 */
    async function reloadBytes(signal, phase) {
      Object.assign(state, {phase, message: "正在重新读取源文件字节…"}); publish();
      const result = await E.wait(session.reloadBytes({signal, onProgress: value => {
        state.message = "正在重新读取源文件：" + (value.loaded / 1048576).toFixed(1) + " MiB" +
          (value.total ? " / " + (value.total / 1048576).toFixed(1) + " MiB" : "") + "…";
        publish();
      }}), {signal, ms: RELOAD_MS, stage: "export"});
      return result;
    }
    /** 独立证据位图：scale=2、viewRotation=0，与可见画布无关；返回 {canvas, matrix, pxPerCss}。 */
    async function evidenceCanvas(currentDocument, snapshot, signal) {
      Object.assign(state, {phase: "rendering", message: "正在渲染第 " + snapshot.identity.page + " 页导出校验位图（不上传）…"}); publish();
      const canvas = document.createElement("canvas");
      const handle = currentDocument.renderPage({pageNumber: snapshot.identity.page, scale: EVIDENCE_SCALE,
        viewRotation: 0, canvas, pixelBudget: EVIDENCE_PIXEL_BUDGET}, {signal});
      try {
        const info = await E.wait(handle.promise, {signal, ms: RELOAD_MS, stage: "export"});
        E.check(signal);
        const base = invert(snapshot.geometry.transform);
        const matrix = base ? compose(info.viewportTransform, base) : null;
        if (!matrix) throw E.create("EXPORT_FAILED", "页面坐标变换不可逆，无法校验导出区域", "export", false);
        return {canvas, matrix, pxPerCss: canvas.width / info.width};
      } catch (error) {
        canvas.width = canvas.height = 0;
        throw error;
      } finally { handle.dispose(); }
    }
    /**
     * 分块采样：只取证结构先验后仍待定的块（规划器 evidence=null 时的 pending 集合），
     * 先验已淘汰的块不浪费整页渲染与像素读取。
     */
    async function collectEvidence(bitmap, targets, byId, signal, pageNumber) {
      const evidence = new Map();
      const label = "正在独立复核第 " + pageNumber + " 页可遮盖区域";
      Object.assign(state, {phase: "sampling", message: label + "：0 / " + targets.length}); publish();
      for (let index = 0; index < targets.length; index++) {
        E.check(signal);
        evidence.set(targets[index], EV.sample({canvas: bitmap.canvas, block: byId.get(targets[index]),
          matrix: bitmap.matrix, pxPerCss: bitmap.pxPerCss}));
        if (index % SAMPLE_PER_CHUNK === SAMPLE_PER_CHUNK - 1) {
          state.message = label + "：" + (index + 1) + " / " + targets.length; publish();
          await yieldToPage();
        }
      }
      return evidence;
    }
    /**
     * 单页取证：先跑一次无证据规划，只有仍需像素佐证的块才触发整页渲染；取证结束立即释放画布。
     * 多页范围逐页调用，任一时刻只有一张证据位图存活（8 Mi 像素/页，与可见画布预算互不挤占）。
     */
    async function pageEvidence(currentDocument, snapshot, signal) {
      const results = new Map(snapshot.results);
      const rows = snapshot.blocks.map(block => ({block, result: results.get(block.id) || null}));
      const pre = P.plan({geometry: snapshot.geometry, rows, evidence: null, domFailures: null});
      const byId = new Map(snapshot.blocks.map(block => [block.id, block]));
      const targets = pre.pending.filter(id => byId.has(id));
      if (!targets.length) return [];
      const bitmap = await evidenceCanvas(currentDocument, snapshot, signal);
      try {
        return [...await collectEvidence(bitmap, targets, byId, signal, snapshot.identity.page)];
      } finally {
        bitmap.canvas.width = bitmap.canvas.height = 0;
      }
    }
    /** 每次导出新建 Worker、结束即终止；不复用实例，避免上一次异常状态污染下一次导出。 */
    function composeInWorker(job, signal, onProgress, timeoutMs = COMPOSE_MS) {
      return new Promise((resolve, reject) => {
        let worker = null, settled = false, timeout = 0;
        // 所有出口（完成/失败/取消/超时）统一经 finish：清超时定时器、摘取消监听、终止 Worker。
        const finish = (error, value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          signal?.removeEventListener("abort", abort);
          try { worker?.terminate(); } catch (_) {}
          worker = null;
          if (error) reject(error); else resolve(value);
        };
        const abort = () => finish(signal?.reason || E.cancelled());
        // 多页导出的超时随页数放宽：每页都要重算规划、绘制与子集保存，固定 180 秒会误杀长范围。
        timeout = setTimeout(() => finish(E.create("TIMEOUT", "导出处理超时，请重试", "export")), timeoutMs);
        try {
          worker = new Worker(chrome.runtime.getURL(WORKER_FILE), {name: "yezhiyi-pdf-export"});
        } catch (_) {
          finish(E.create("EXPORT_FAILED", "导出组件无法加载，请重新加载扩展后重试", "export", false));
          return;
        }
        worker.addEventListener("error", () => finish(E.create("EXPORT_FAILED", "导出组件运行失败，请重试", "export")), {once: true});
        worker.addEventListener("message", event => {
          const message = event.data;
          if (!message || message.requestId !== job.requestId) return;
          if (message.type === "progress") { onProgress(message); return; }
          if (message.type === "done") { finish(null, message); return; }
          if (message.type === "error") {
            const passthrough = PASSTHROUGH_CODES.has(message.code);
            // 字体嵌入失败重试可能恢复（重新下载/重读存储），其余透传码重试无意义。
            finish(E.create(passthrough ? message.code : "EXPORT_FAILED", message.message || "导出失败", "export",
              passthrough ? message.code === "EXPORT_FONT_FAILED" : true));
          }
        });
        signal?.addEventListener("abort", abort, {once: true});
        if (signal?.aborted) { abort(); return; }
        // 字节以转移方式投递，页侧不再保留副本；Worker 完成后同样转移回页侧。
        const transfer = [job.bytes];
        if (job.fontBytes) transfer.push(job.fontBytes);
        worker.postMessage(job, {transfer});
      });
    }
    /** 前置条件不满足时只置失败态并返回（不抛出），阅读页无需额外捕获即可展示原因。 */
    function refuse(message) {
      Object.assign(state, {phase: "failed", busy: false, task: null, message}); publish();
    }
    /** 异步阶段失败的统一落态：取消与失败文案不同，其余原样展示页侧/Worker 给出的原因。 */
    function failWith(error, stage) {
      const failure = E.normalize(error, stage);
      if (failure.code === "CANCELLED")
        Object.assign(state, {phase: "cancelled", message: stage === "prepare" ?
          "补译已取消，已完成页的译文与已花额度已保留" : "导出已取消，未生成文件"});
      else Object.assign(state, {phase: "failed", message: failure.message});
      publish();
    }
    /**
     * 范围体检（纯同步，不发任何请求）：把所选页分成 ready / partial / missing / no-text。
     * missing = 该页没有任何可用译文，导出只会得到原文页，必须让用户显式选择补译或保留原文；
     * partial 与 no-text 不拦导出（未译段、无正文页按原文照录），但计入 need 供「翻译缺失页」补缺。
     */
    function describeRange(pages) {
      const byPage = new Map((getPageStatus(pages) || []).map(item => [item.page, item]));
      const missing = [], partial = [], noText = [], ready = [];
      for (const page of pages) {
        const status = byPage.get(page);
        const kind = status ? status.state : "missing";
        if (kind === "missing") missing.push(page);
        else if (kind === "partial") partial.push(page);
        else if (kind === "no-text") noText.push(page);
        else ready.push(page);
      }
      return {missing, partial, noText, ready, need: missing.concat(partial).sort((a, b) => a - b)};
    }
    /**
     * 体检结果写入导出状态：阅读页据此展示缺失清单并决定「翻译缺失页」「保留原文导出」是否可用。
     * checkedText/checkedStamp 记录这次清单对应的范围与翻译口径，补译入口必须两者都对得上才放行。
     */
    function publishRange(pages, range, text) {
      Object.assign(state, {pages, missing: range.missing, partial: range.partial, need: range.need,
        checkedText: text, checkedStamp: getStamp()});
      return range;
    }
    /** 补译清单是否仍对应当前范围与当前翻译口径；过期一律让用户重新体检，绝不用旧清单发翻译请求。 */
    function rangeIsCurrent(text) {
      if (!state.pages || !state.pages.length || state.checkedText !== text)
        return "页码范围已改动，请先点击「导出」重新体检";
      if (!state.checkedStamp || getStamp() !== state.checkedStamp)
        return "翻译设置或目标语言已变化，请先点击「导出」重新体检";
      return null;
    }
    /** 当前页导出。`pair` 为真时走 P5-D 双语口径：原文页照录 + 对照页成对，文件名与状态文案随之分叉。 */
    async function run(mode, pair) {
      if (disposed) return;
      if (active) { refuse("已有导出任务在进行，请先取消或等待完成"); return; }
      if (preparing) { refuse("正在补译缺失页，请先取消或等待完成"); return; }
      const controller = new AbortController(), signal = controller.signal;
      const currentDocument = getDocument(), snapshot = mode === "translated" ? getSnapshot() : null;
      const name = getName();
      if (!currentDocument) { refuse("当前没有可导出的文档，请先读取 PDF"); return; }
      if (mode === "translated" && !snapshot) { refuse("本页还没有翻译结果，请先翻译本页再导出译文"); return; }
      // 选级与下载授权必须同步完成（点击手势链内）：注册表只按文字类别选级，逐字缺字由 Worker 权威拒绝。
      let selection = null, authorization = null;
      if (mode === "translated") {
        const texts = [];
        for (const [, result] of snapshot.results)
          if (result && result.status === "translated" && result.text && result.text.trim())
            texts.push(F.normalize(result.text));
        selection = F.select(texts);
        if (selection.blocked.length) {
          refuse("本页译文包含导出字体无法绘制的文字：" + F.describeBlocked(selection.blocked) +
            "。请改用原文导出，或把目标语言改为该字体覆盖的语言");
          return;
        }
        if (selection.font !== "builtin") authorization = FS.authorize();
      }
      active = {controller};
      Object.assign(state, {busy: true, task: "export", stats: null, phase: "preparing", message: "正在准备导出…"}); publish();
      let source = null, fontBytes = null;
      try {
        // 字体先行：权限与网络问题尽早暴露，避免白做一次整页证据渲染。
        const fontCode = selection ? selection.font : "builtin";
        if (fontCode !== "builtin") {
          Object.assign(state, {phase: "preparing",
            message: "正在准备导出字体（" + F.label(fontCode) + "）…"}); publish();
          fontBytes = await FS.obtain(fontCode, {authorization, signal, onProgress: ({loaded, total}) => {
            state.message = "正在下载导出字体：" + (loaded / 1048576).toFixed(1) + " MiB" +
              (total ? " / " + (total / 1048576).toFixed(1) + " MiB" : "") + "…";
            publish();
          }});
          E.check(signal);
        }
        source = await reloadBytes(signal, "preparing");
        E.check(signal);
        let bytes = source.bytes;
        if (mode === "original") {
          Object.assign(state, {phase: "saving", message: "正在生成导出文件…"}); publish();
          download(bytes, fileName(name, ""));
          Object.assign(state, {phase: "done", message: "原文 PDF 已导出（未修改任何内容）",
            stats: {mode: "original", pages: null}}); publish();
          return;
        }
        // 身份冻结校验：快照取自调用瞬间，异步过程中翻页/换文档/改目标语言都使本次导出失效。
        const live = getSnapshot();
        if (!live || live.identity.documentId !== snapshot.identity.documentId || live.identity.page !== snapshot.identity.page ||
            live.identity.to !== snapshot.identity.to)
          throw E.create("EXPORT_SOURCE_CHANGED", "导出过程中页面或翻译设置已变化，请重新导出", "export", false);
        // 取证与多页导出走同一入口：无待定块则整页位图渲染直接跳过，取证完即释放画布。
        const evidence = new Map(await pageEvidence(currentDocument, snapshot, signal));
        E.check(signal);
        Object.assign(state, {phase: "composing", message: "正在生成导出 PDF…"}); publish();
        const transferable = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
          ? bytes.buffer : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        bytes = null;
        let fontBuffer = null;
        if (fontBytes) {
          fontBuffer = fontBytes.byteOffset === 0 && fontBytes.byteLength === fontBytes.buffer.byteLength
            ? fontBytes.buffer : fontBytes.buffer.slice(fontBytes.byteOffset, fontBytes.byteOffset + fontBytes.byteLength);
          fontBytes = null;
        }
        const job = {job: "export", requestId: crypto.randomUUID(), bytes: transferable,
          mode: pair ? "bilingual" : "translated",
          pages: [{snapshot, evidence: [...evidence], markerNumbers: [...(getMarkers()?.numbers || [])]}],
          fontCode, fontLabel: F.label(fontCode), fontMetrics: F.metrics(fontCode)};
        if (fontBuffer) job.fontBytes = fontBuffer;
        const done = await composeInWorker(job, signal,
          message => { if (message.message) { state.message = message.message; publish(); } });
        E.check(signal);
        // 双语口径的成对页只在真有原位译文时追加，故「对照页」数可小于页数——原文页始终保留，绝不伪装成对。
        const head = !pair ? "译文 PDF 已导出：原位 " + done.stats.overlay + " 段"
          : done.stats.pairs ? "双语 PDF 已导出：原文 " + done.stats.selected + " 页 + 对照 " + done.stats.pairs +
            " 页，原位 " + done.stats.overlay + " 段"
          : "双语 PDF 已导出：原文 " + done.stats.selected + " 页（本页译文未能原位显示，未追加对照页）";
        download(done.bytes, fileName(name, (pair ? "-双语-" : "-译文-") + "p" + snapshot.identity.page));
        Object.assign(state, {phase: "done", message: head + "，附录 " + done.stats.appendixItems + " 段（" +
          done.stats.appendixPages + " 页），共 " + done.stats.pages + " 页；字体 " +
          (done.stats.customFont ? F.label(done.stats.font) : "内置标准字体") + bookmarkNote(done.stats),
          stats: {...done.stats, mode: pair ? "bilingual" : "translated"}}); publish();
      } catch (error) {
        if (disposed) return;
        failWith(error, "export");
      } finally {
        source?.dispose();
        if (active && active.controller === controller) active = null;
        state.busy = false; state.task = null; publish();
      }
    }
    /**
     * 多页导出（「译文 PDF（所选页）」）。首击只做范围体检：有页完全没译文时列出清单并停下，
     * 绝不静默发翻译请求、也不在没确认的情况下产出原文页——补译与保留原文都是另一次显式点击。
     * 体检通过后，「冻结快照 → 选级 → 下载授权」全部同步完成（留在点击手势链内），之后才进入异步取证与合成。
     * 逐页取证任一时刻只有一张证据位图存活；任一页失败即整单失败，只在全部生成后下载一个文件。
     */
    async function runRange(text, keepMissing, pair) {
      if (disposed) return;
      if (active) { refuse("已有导出任务在进行，请先取消或等待完成"); return; }
      if (preparing) { refuse("正在补译缺失页，请先取消或等待完成"); return; }
      const currentDocument = getDocument(), name = getName();
      if (!currentDocument) { refuse("当前没有可导出的文档，请先读取 PDF"); return; }
      const stampNow = getStamp();
      if (!stampNow) { refuse("当前还没有可用的翻译设置，请先读取并翻译 PDF"); return; }
      const parsed = parseRange(text, currentDocument.numPages, getPage());
      if (parsed.error) { refuse(parsed.error); return; }
      const pages = parsed.pages;
      const range = publishRange(pages, describeRange(pages), text);
      if (range.missing.length && !keepMissing) {
        Object.assign(state, {busy: false, task: null, phase: "incomplete", stats: null,
          message: "第 " + compact(range.missing) + " 页还没有可用译文（共选 " + pages.length + " 页）：" +
            "点「翻译缺失页」逐页补译，或点「缺失页保留原文导出」把这些页按原文照录。" +
            (range.partial.length ? "第 " + compact(range.partial) + " 页部分完成，未译段按原文保留。" : "") +
            (range.noText.length ? "第 " + compact(range.noText) + " 页没有可译正文，按原文照录。" : "")});
        publish();
        return;
      }
      const checkStamp = () => {
        if (getStamp() !== stampNow)
          throw E.create("EXPORT_SOURCE_CHANGED", "导出过程中源文档或翻译设置已变化，请重新导出", "export", false);
      };
      // 冻结：快照一次性克隆，之后的 await 不再新增克隆；翻页只影响屏幕，不改变本次所选页内容。
      // 屏上回退标记只属于当前可见页，故只有该页复用其编号，其余页由导出侧另编号（记录为已知限制）。
      const markerPage = getPage(), markers = [...(getMarkers()?.numbers || [])], shown = getSnapshot();
      const snapshots = getSnapshots(pages), frozen = [], texts = [];
      pages.forEach((page, index) => {
        const snapshot = snapshots[index];
        // 只把「真有译文」的快照交给 Worker：无正文页/全失败页即便有条目也按原文照录，
        // 既省一次整页证据渲染，也让状态里的「按原文保留」如实数到这些页。
        const entries = snapshot ? [...snapshot.results] : [];
        const translated = entries.filter(([, result]) =>
          result && result.status === "translated" && result.text && result.text.trim());
        if (!translated.length) { frozen.push({page, snapshot: null, evidence: null, markerNumbers: []}); return; }
        const reuse = page === markerPage && !!shown && shown.identity.documentId === snapshot.identity.documentId;
        frozen.push({page, snapshot, evidence: null, markerNumbers: reuse ? markers : []});
        for (const [, result] of translated) texts.push(F.normalize(result.text));
      });
      if (!texts.length) {
        refuse("所选页都没有可用译文，请点「翻译缺失页」补译，或改用原文导出（整份文件）");
        return;
      }
      const selection = F.select(texts);
      if (selection.blocked.length) {
        refuse("所选页译文包含导出字体无法绘制的文字：" + F.describeBlocked(selection.blocked) +
          "。请改用原文导出，或把目标语言改为该字体覆盖的语言");
        return;
      }
      const authorization = selection.font === "builtin" ? null : FS.authorize();
      const controller = new AbortController(), signal = controller.signal;
      active = {controller};
      Object.assign(state, {busy: true, task: "export", stats: null, phase: "preparing",
        message: "正在准备导出（共 " + pages.length + " 页）…"}); publish();
      let source = null, fontBytes = null;
      try {
        // 字体先行：权限与网络问题尽早暴露，避免白做多页证据渲染。整单只用一只字体，子集字形跨页累加。
        const fontCode = selection.font;
        if (fontCode !== "builtin") {
          Object.assign(state, {phase: "preparing",
            message: "正在准备导出字体（" + F.label(fontCode) + "）…"}); publish();
          fontBytes = await FS.obtain(fontCode, {authorization, signal, onProgress: ({loaded, total}) => {
            state.message = "正在下载导出字体：" + (loaded / 1048576).toFixed(1) + " MiB" +
              (total ? " / " + (total / 1048576).toFixed(1) + " MiB" : "") + "…";
            publish();
          }});
        }
        E.check(signal); checkStamp();
        source = await reloadBytes(signal, "preparing");
        E.check(signal); checkStamp();
        for (const entry of frozen) {
          if (!entry.snapshot) continue;
          entry.evidence = await pageEvidence(currentDocument, entry.snapshot, signal);
          E.check(signal); checkStamp();
        }
        Object.assign(state, {phase: "composing", message: "正在生成导出 PDF…"}); publish();
        let bytes = source.bytes;
        const transferable = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
          ? bytes.buffer : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        bytes = null;
        let fontBuffer = null;
        if (fontBytes) {
          fontBuffer = fontBytes.byteOffset === 0 && fontBytes.byteLength === fontBytes.buffer.byteLength
            ? fontBytes.buffer : fontBytes.buffer.slice(fontBytes.byteOffset, fontBytes.byteOffset + fontBytes.byteLength);
          fontBytes = null;
        }
        const job = {job: "export", requestId: crypto.randomUUID(), bytes: transferable,
          mode: pair ? "bilingual" : "translated",
          pages: frozen.map(entry => entry.snapshot
            ? {snapshot: entry.snapshot, evidence: entry.evidence, markerNumbers: entry.markerNumbers}
            : {page: entry.page}),
          fontCode, fontLabel: F.label(fontCode), fontMetrics: F.metrics(fontCode)};
        if (fontBuffer) job.fontBytes = fontBuffer;
        const done = await composeInWorker(job, signal,
          message => { if (message.message) { state.message = message.message; publish(); } },
          COMPOSE_MS + (COMPOSE_PER_PAGE_MS + (pair ? COMPOSE_PAIR_MS : 0)) * (pages.length - 1));
        E.check(signal);
        // 保留页数只能按 per 数：Worker 的 selected 含按原文照录页，用 pages.length - selected 恒为 0。
        const kept = (done.stats.per || []).filter(item => item.original).length;
        // 有译文但一段都没入位的页不出对照页（否则等于把原文页重贴一遍），如实报成「未追加对照页」。
        const unpaired = pair ? (done.stats.per || []).filter(item => !item.original && !item.pair).length : 0;
        download(done.bytes, fileName(name, (pair ? "-双语-" : "-译文-") +
          (pages.length === 1 ? "p" + pages[0] : compact(pages))));
        const head = pair
          ? "双语 PDF 已导出：所选 " + pages.length + " 页中原文 " + done.stats.selected + " 页 + 对照 " +
            done.stats.pairs + " 页" + (unpaired ? "（" + unpaired + " 页译文未能原位显示，未追加对照页）" : "") +
            "，原位 " + done.stats.overlay + " 段"
          : "译文 PDF 已导出：所选 " + pages.length + " 页中原位 " + done.stats.overlay + " 段";
        Object.assign(state, {phase: "done", message: head + "，附录 " + done.stats.appendixItems + " 段（" +
          done.stats.appendixPages + " 页），输出共 " + done.stats.pages + " 页" +
          (kept ? "，另有 " + kept + " 页按原文保留" : "") + "；字体 " +
          (done.stats.customFont ? F.label(done.stats.font) : "内置标准字体") + bookmarkNote(done.stats),
          stats: {...done.stats, mode: pair ? "bilingual" : "translated", range: pages.slice(), kept}}); publish();
      } catch (error) {
        if (disposed) return;
        failWith(error, "export");
      } finally {
        source?.dispose();
        if (active && active.controller === controller) active = null;
        state.busy = false; state.task = null; publish();
      }
    }
    /**
     * 「翻译缺失页」：补译最近一次体检那份范围中的 need 页（缺失 + 部分完成），逐页无头跑提取→分类→OCR→翻译。
     * 范围文本或翻译口径与体检时不一致即拒绝——绝不用过期清单发翻译请求；need 也按当前缓存现场重算。
     * 取消只停循环：已完成页与已花额度结果保留；缓存预算耗尽或服务熔断终止本轮并回报剩余页。
     * 完成后不自动导出——字体下载授权必须留在另一次点击手势内，且用户应先看到补译结果再决定。
     */
    async function prepareMissing(text) {
      if (disposed) return;
      if (preparing) { refuse("已有补译任务在进行，请先取消或等待完成"); return; }
      if (active) { refuse("导出任务进行中，请先取消或等待完成"); return; }
      if (!getDocument()) { refuse("当前没有可导出的文档，请先读取 PDF"); return; }
      if (!getStamp()) { refuse("当前还没有可用的翻译设置，请先读取并翻译 PDF"); return; }
      const stale = rangeIsCurrent(text);
      if (stale) { refuse(stale); return; }
      const pages = state.pages.slice();
      const need = describeRange(pages).need;
      if (!need.length) { refuse("所选页都已翻译完成，请再次点击「导出」生成译文 PDF"); return; }
      const stampNow = getStamp();
      const controller = new AbortController(), signal = controller.signal;
      preparing = {controller};
      Object.assign(state, {busy: true, task: "prepare", stats: null, phase: "preparing",
        message: "正在翻译缺失页（共 " + need.length + " 页，逐页进行，可取消）…"}); publish();
      try {
        // 不套整体超时：逐页准备含 OCR 与服务排队，时长不可预估；停止靠取消信号与后台自身的请求超时。
        const summary = await preparePages(need, {signal, onProgress: progress => {
          state.message = progress.stage === "translating"
            ? "正在翻译第 " + progress.page + " 页：" + (progress.done || 0) + " / " + (progress.total || 0) + " 段…"
            : progress.stage === "recognizing" ? "第 " + progress.page + " 页：" + (progress.message || "正在识别文字…")
              : "正在读取第 " + progress.page + " 页…";
          publish();
        }});
        const range = publishRange(pages, describeRange(pages), text);
        // 无正文页只在补译时才被真正探明：回报里与「译完的页」分开数，不让用户以为空白页也产出了译文。
        const empty = summary.done.filter(item => item.state === "no-text").map(item => item.page);
        const done = summary.done.filter(item => item.state !== "no-text").map(item => item.page);
        const failed = summary.failed.map(item => item.page);
        const stopped = summary.stopped;
        Object.assign(state, {busy: false, task: null, phase: stopped && stopped.reason !== "cancelled" ? "failed" : "incomplete",
          message: "补译结束：完成 " + done.length + " 页" + (done.length ? "（第 " + compact(done) + " 页）" : "") +
            (empty.length ? "，第 " + compact(empty) + " 页没有可译正文，按原文照录" : "") +
            (failed.length ? "，失败 " + failed.length + " 页（第 " + compact(failed) + " 页）" : "") +
            (stopped ? (stopped.reason === "cancelled" ? "，已取消，第 " + stopped.page + " 页起未继续（已完成页保留）"
              : stopped.reason === "budget" ? "，译文缓存已达上限，第 " + stopped.page + " 页起未准备，请缩小页码范围或分次导出"
                : stopped.reason === "fatal" ? "，服务或识别模型异常已终止本轮（第 " + stopped.page + " 页）"
                  : "，翻译设置或文档已变化，本轮已终止") : "") +
            "。" + (getStamp() === stampNow && range.missing.length
              ? "仍缺第 " + compact(range.missing) + " 页译文，可再次补译或选择保留原文导出。"
              : range.missing.length ? "请重新体检（点击「导出」）后再选择导出方式。"
                : "缺失页已补齐，请再次点击「导出」生成译文 PDF。")});
        publish();
      } catch (error) {
        if (disposed) return;
        failWith(error, "prepare");
      } finally {
        if (preparing && preparing.controller === controller) preparing = null;
        state.busy = false; state.task = null; publish();
      }
    }
    function cancel() {
      if (active) { active.controller.abort(E.cancelled()); return; }
      if (preparing) preparing.controller.abort(E.cancelled());
    }
    function dispose() {
      disposed = true; cancel();
      if (revokeTimer) { clearTimeout(revokeTimer); revokeTimer = 0; }
      active = null; preparing = null;
    }
    publish();
    return {exportOriginal: () => run("original"), exportTranslated: pair => run("translated", !!pair),
      exportRange: (text, keepMissing, pair) => runRange(text, !!keepMissing, !!pair),
      prepareMissing, cancel, dispose};
  }
  global.BT_PDF_EXPORTER = {create, fileName, parseRange, compact};
})(window);
