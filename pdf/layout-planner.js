(function(global) {
  "use strict";
  /**
   * P3-C 布局规划器：纯计算，全部在固定坐标系（scale=1、固有旋转、PDF 点）内规划。
   * default-deny：结构先验、几何冲突、像素佐证三层证据任一缺失或存疑即回退，绝不写回 P2 提取字段。
   * 首版禁用区域扩展（expansion 恒为 null）；放不下按换行→有限缩字→回退处理，不裁切文字。
   */
  const MASK_PAD = 1.5, CLEARANCE = 2, RING = 2, LINE_PAD = 1;
  const FS_STEP = 0.94, FS_REL_FLOOR = 0.75, FS_BODY_FLOOR = 0.6, FS_LEAD_MAX = 2.2;
  const MEASURE_MARGIN = 0.97, LINE_HEIGHT = 1.25;
  const MAX_DOM_TIERS = 8;                // DOM 实测验证失败的最大字号降级次数，超限即回退
  const FONT_STACK = 'system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif';
  const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
  let measureContext = null;
  function measureCanvas() {
    if (!measureContext) {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      measureContext = canvas.getContext("2d");
    }
    return measureContext;
  }
  function measure(text, fontSize) {
    const context = measureCanvas();
    context.font = fontSize + "px " + FONT_STACK;
    context.direction = "ltr";
    return context.measureText(text).width;
  }
  const median = values => {
    const sorted = values.filter(n => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
    return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
  };
  function inflate(rect, pad) {
    return {x: rect.x - pad, y: rect.y - pad, right: rect.right + pad, bottom: rect.bottom + pad};
  }
  function intersects(a, b) {
    return a.x < b.right && b.x < a.right && a.y < b.bottom && b.y < a.bottom;
  }
  function clampToPage(rect, geometry) {
    return {x: Math.max(0, rect.x), y: Math.max(0, rect.y),
      right: Math.min(geometry.width, rect.right), bottom: Math.min(geometry.height, rect.bottom)};
  }
  /**
   * 贪心换行：CJK 逐字可断，拉丁词为原子（词前有空格才可断），超长词字符级硬断；
   * \n 强制断行。只依赖测量函数与 MEASURE_MARGIN 安全余量，不裁切任何字符。
   * @param {(text:string,fontSize:number)=>number} [measureFn] 宽度测量；缺省用 DOM canvas 实测（浏览器路径）。
   * @returns {string[]} 行文本数组；空文本返回空数组。
   */
  function wrapText(text, fontSize, maxWidth, measureFn) {
    const widthOf = measureFn || measure;
    const lines = [];
    for (const raw of String(text).split("\n")) {
      // 原子序列：{t:文本, gap:与前原子间是否有空白, brk:是否允许在其前断行}
      const atoms = [];
      let word = "", gapPending = false;
      const flushWord = () => {
        if (!word) return;
        atoms.push({t: word, gap: gapPending, brk: gapPending});
        word = ""; gapPending = false;
      };
      for (const ch of raw) {
        if (/\s/.test(ch)) { flushWord(); if (atoms.length) gapPending = true; continue; }
        if (CJK.test(ch)) { flushWord(); atoms.push({t: ch, gap: gapPending, brk: atoms.length > 0}); gapPending = false; continue; }
        word += ch;
      }
      flushWord();
      let line = "";
      for (const atom of atoms) {
        const joiner = atom.gap && line ? " " : "";
        const candidate = line + joiner + atom.t;
        if (!line) { line = atom.t; continue; }
        if (widthOf(candidate, fontSize) <= maxWidth) { line = candidate; continue; }
        if (atom.brk) { lines.push(line); line = atom.t; continue; }
        // 词内字符级硬断：找不到断点也不裁切
        let fit = line + joiner;
        for (const ch of atom.t) {
          if (widthOf(fit + ch, fontSize) <= maxWidth) fit += ch;
          else { lines.push(fit.replace(/ $/, "")); fit = ch; }
        }
        line = fit;
      }
      if (line) lines.push(line);
    }
    return lines;
  }
  /**
   * 字号适配：先 fs0 换行，溢出按 FS_STEP 逐级缩小到文档相对下限；domTier 为 DOM 验证失败降级次数。
   * 下限 = min(fs0, max(0.75×fs0, 0.6×页面正文中位高度))，不使用通用绝对值。
   * 行节奏：译文行数不超过原文行数时按可用高度均分行距贴合原文行距，上限 FS_LEAD_MAX 防拉散。
   * @param {(text:string,fontSize:number)=>number} [measureFn] 宽度测量；缺省用 DOM canvas 实测。
   * @param {number} [lineHeightRatio] 行高倍数；缺省 LINE_HEIGHT（阅读层行为不变），
   *   导出侧按嵌入字体实测注入（汉字级字体 1.448），避免固定值装不下字体自身墨迹。
   * @returns {{lines:string[],fontSize:number,lineHeight:number}|null} null 表示放不下，应回退。
   */
  function fitBlock(text, blockHeight, bodyMedian, box, domTier, originalLines, measureFn, lineHeightRatio) {
    if ((domTier || 0) >= MAX_DOM_TIERS) return null;
    const lead = Number.isFinite(lineHeightRatio) && lineHeightRatio > 0 ? lineHeightRatio : LINE_HEIGHT;
    const fs0 = blockHeight > 0 ? blockHeight : (bodyMedian || 12);
    const floor = Math.min(fs0, Math.max(FS_REL_FLOOR * fs0, FS_BODY_FLOOR * (bodyMedian || fs0)));
    const availWidth = (box.right - box.x) * MEASURE_MARGIN;
    const availHeight = box.bottom - box.y;
    let fontSize = fs0;
    for (let tier = 0; tier < (domTier || 0); tier++) fontSize *= FS_STEP;
    while (fontSize >= floor - 1e-6) {
      const lines = wrapText(text, fontSize, availWidth, measureFn);
      let lineHeight = fontSize * lead;
      if (originalLines > 1 && lines.length > 1 && lines.length <= originalLines)
        lineHeight = Math.min(availHeight / lines.length, fontSize * FS_LEAD_MAX);
      if (lines.length && lines.length * lineHeight <= availHeight) return {lines, fontSize, lineHeight};
      if (fontSize <= floor + 1e-6) break;
      fontSize = Math.max(floor, fontSize * FS_STEP);
    }
    return null;
  }
  /**
   * 整页规划：按阅读顺序对每个已译候选块做三层判定，输出独立 Plan。
   * @param {Object} input {geometry, rows, evidence:Map|null, domFailures:Map|null, measure?, lineHeight?}；
   *   measure 为可选宽度测量函数、lineHeight 为可选行高倍数（导出侧注入嵌入字体的实测度量），
   *   缺省时分别用 DOM canvas 实测与 LINE_HEIGHT，浏览器阅读路径行为不变。
   * @returns {Object} {placements:Map, fallbacks:[{blockId,reason}], pending:[blockId], stats}
   */
  function plan(input) {
    const placements = new Map(), fallbacks = [], pending = [];
    const geometry = input && input.geometry, rows = (input && input.rows) || [];
    const evidence = input && input.evidence, domFailures = (input && input.domFailures) || null;
    const measureFn = typeof (input && input.measure) === "function" ? input.measure : measure;
    const lineHeightRatio = Number.isFinite(input && input.lineHeight) ? input.lineHeight : LINE_HEIGHT;
    if (!geometry || !Number.isFinite(geometry.width) || !Number.isFinite(geometry.height))
      return {placements, fallbacks, pending, stats: {overlay: 0, fallback: 0, pending: 0}};
    const bodyMedian = median(rows.filter(r => r.block.eligible && r.block.role === "text").map(r => r.block.height))
      || median(rows.map(r => r.block.height)) || 12;
    // 第一层：结构先验。仅 translated 且有译文才是候选；unchanged 原文即正确，不遮盖也不回退。
    const candidates = [];
    for (const {block, result} of rows) {
      if (!result || !result.text || !result.text.trim()) continue;
      if (result.status !== "translated") continue;
      if (!block.eligible || !block.reliable || block.role !== "text") {
        fallbacks.push({blockId: block.id, reason: "prior"}); continue;
      }
      if (!(block.height >= bodyMedian * 0.5 && block.height <= bodyMedian * 3)) {
        fallbacks.push({blockId: block.id, reason: "atypical-size"}); continue;
      }
      candidates.push({block, result});
    }
    const placedRects = [];
    for (const {block, result} of candidates) {
      if (block.rect.x < -1 || block.rect.y < -1 || block.rect.right > geometry.width + 1 || block.rect.bottom > geometry.height + 1) {
        fallbacks.push({blockId: block.id, reason: "bounds"}); continue;
      }
      // 遮罩底边覆盖到字体墨迹底 inkBottom（CJK 字体盒高于 1em，块末行基线以下残墨否则露出）；
      // 再以同列后续块结构顶 inkLimit 为硬上限（含遮罩外扩），扩展绝不越入邻段；
      // 译文盒仍按 1em 结构盒范围，保持既有行距排版不变。
      const inkLimit = Number.isFinite(block.inkLimit) ? block.inkLimit - MASK_PAD : Infinity;
      const inkBottom = Math.min(Number.isFinite(block.inkBottom) ? block.inkBottom : block.rect.bottom, inkLimit);
      const baseRect = inflate(block.rect, MASK_PAD);
      const maskRect = clampToPage({...baseRect, bottom: Math.max(baseRect.bottom, inkBottom + MASK_PAD)}, geometry);
      // 几何冲突仍按 1em 结构盒判定：扩展底边落在下一行墨迹顶之上的空白区，参与冲突判定会误伤紧排块。
      const clearanceRect = inflate(baseRect, CLEARANCE);
      let conflict = false;
      for (const other of rows) {
        if (other.block === block || !other.block.rect) continue;
        if (intersects(clearanceRect, other.block.rect)) { conflict = true; break; }
      }
      if (conflict) { fallbacks.push({blockId: block.id, reason: "overlap"}); continue; }
      if (placedRects.some(rect => intersects(rect, baseRect))) {
        fallbacks.push({blockId: block.id, reason: "placed-conflict"}); continue;
      }
      // 第三层：像素佐证。缺失=待采样；密度不足或任一判定失败=回退（default-deny）。
      const found = evidence ? evidence.get(block.id) : null;
      if (!found) { pending.push(block.id); continue; }
      if (!found.densitySufficient) { fallbacks.push({blockId: block.id, reason: "indeterminate"}); continue; }
      if (!found.background || !found.background.uniform) { fallbacks.push({blockId: block.id, reason: "background"}); continue; }
      if (found.hasStrokes) { fallbacks.push({blockId: block.id, reason: "strokes"}); continue; }
      if (!found.inkConfined || found.solidInk) { fallbacks.push({blockId: block.id, reason: "graphics"}); continue; }
      const domTier = domFailures ? domFailures.get(block.id) || 0 : 0;
      // 译文盒顶对齐原文首行（遮罩仍外扩 MASK_PAD 保证覆盖），消除 1.5pt 首行偏移。
      const textRect = {x: maskRect.x, y: block.rect.y, right: maskRect.right, bottom: baseRect.bottom};
      const fit = fitBlock(result.text, block.height, bodyMedian, textRect, domTier, (block.lines || []).length, measureFn, lineHeightRatio);
      if (!fit) { fallbacks.push({blockId: block.id, reason: domTier ? "dom-overflow" : "fit"}); continue; }
      placements.set(block.id, {blockId: block.id, rect: block.rect, maskRect, textRect,
        maskColor: found.background.color, fontSize: fit.fontSize, lineHeight: fit.lineHeight,
        lines: fit.lines, direction: block.direction === "rtl" ? "rtl" : "ltr",
        align: block.direction === "rtl" ? "right" : "left", expansion: null});
      placedRects.push(baseRect);
    }
    return {placements, fallbacks, pending, stats: {overlay: placements.size, fallback: fallbacks.length, pending: pending.length}};
  }
  global.BT_PDF_LAYOUT_PLANNER = {plan, wrapText, measure, inflate, intersects,
    constants: {MASK_PAD, CLEARANCE, RING, LINE_PAD, LINE_HEIGHT, FONT_STACK, MAX_DOM_TIERS}};
})(typeof window !== "undefined" ? window : self);
