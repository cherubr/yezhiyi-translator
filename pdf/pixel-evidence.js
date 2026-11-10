(function(global) {
  "use strict";
  /**
   * 像素证据采样（P3-C 阅读层与 P5 导出共用同一判定口径）：纯计算，不绑定渲染代次与 DOM 结构。
   * 调用方提供已渲染画布、块（固定坐标）与显示矩阵；default-deny 阈值与公式即 P3-C 语义，永不放宽。
   * 全分辨率采样（step=1 即该画布的极限证明）；包围盒超读取上限判 densitySufficient=false，不做稀疏抽样冒充证明。
   */
  const MAX_READ_PIXELS = 4000000;        // 单块证据读取像素上限；超限=无法证明=回退
  const BG_TOLERANCE = 26;                // 背景色容差（每通道）
  const BG_UNIFORM_RATIO = 0.97;          // 环背景众数色占比下限
  const INK_RATIO_LIMIT = 0.65;           // 单行带墨迹占比上限（防实底图形）
  const STROKE_MIN_PT = 6;                // 线条游程最小长度（固定坐标 pt）

  function apply(m, x, y) {
    return [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]];
  }
  const near = (c, bg) => Math.abs(c[0] - bg[0]) <= BG_TOLERANCE && Math.abs(c[1] - bg[1]) <= BG_TOLERANCE && Math.abs(c[2] - bg[2]) <= BG_TOLERANCE;
  function fail() {
    return {densitySufficient: false, background: null, hasStrokes: false, inkConfined: true, solidInk: false};
  }
  /** 固定坐标矩形 → 画布设备像素包围盒。 */
  function toCanvasBox(canvas, rect, m, pxPerCss) {
    const corners = [[rect.x, rect.y], [rect.right, rect.y], [rect.right, rect.bottom], [rect.x, rect.bottom]]
      .map(([x, y]) => apply(m, x, y));
    const xs = corners.map(p => p[0] * pxPerCss), ys = corners.map(p => p[1] * pxPerCss);
    return {x0: Math.max(0, Math.floor(Math.min(...xs))), y0: Math.max(0, Math.floor(Math.min(...ys))),
      x1: Math.min(canvas.width, Math.ceil(Math.max(...xs))), y1: Math.min(canvas.height, Math.ceil(Math.max(...ys)))};
  }
  /**
   * 对单块做全分辨率采样出证据。
   * 文字笔画防误判：横向游程只统计行区之外的部分；跨越≥2 个行区的纵向游程视为表格竖线。
   * @param {Object} input {canvas, block, matrix, pxPerCss}；matrix 为固定坐标→画布 CSS 像素的显示矩阵。
   * @returns {{densitySufficient:boolean, background:{uniform:boolean,color:number[]}|null, hasStrokes:boolean, inkConfined:boolean, solidInk:boolean}}
   */
  function sample({canvas, block, matrix: m, pxPerCss}) {
    if (!canvas || !canvas.width || !(pxPerCss > 0) || !Array.isArray(m)) return fail();
    const scale = Math.hypot(m[0], m[1]) || 1;
    const pxPerPt = scale * pxPerCss;
    if (!(pxPerPt > 0)) return fail();
    const planner = global.BT_PDF_LAYOUT_PLANNER, K = planner.constants;
    // 行带与遮罩带底边同步扩展到 inkBottom（并以 inkLimit 为硬上限，与绘制遮罩同公式）：残墨才不会落入采样盲区。
    const inkBottomOf = (node, rect) => {
      const ink = Number.isFinite(node.inkBottom) ? node.inkBottom : rect.bottom;
      const limit = Number.isFinite(node.inkLimit) ? node.inkLimit - K.MASK_PAD : Infinity;
      return Math.max(rect.bottom, Math.min(ink, limit));
    };
    const lines = (block.lines || []).map(line => planner.inflate({...line.rect, bottom: inkBottomOf(line, line.rect)}, K.LINE_PAD))
      .filter(rect => Number.isFinite(rect.x) && Number.isFinite(rect.y) && Number.isFinite(rect.right) && Number.isFinite(rect.bottom));
    const baseMask = planner.inflate(block.rect, K.MASK_PAD);
    const maskRect = {...baseMask, bottom: inkBottomOf(block, block.rect) + K.MASK_PAD};
    // 采样外环仍按 1em 结构盒：外环随遮罩扩展会扫入下一行字形顶墨迹，误判背景不均。
    const region = planner.inflate(baseMask, K.RING);
    const box = toCanvasBox(canvas, region, m, pxPerCss);
    const width = box.x1 - box.x0, height = box.y1 - box.y0;
    if (width <= 0 || height <= 0) return fail();
    if (width * height > MAX_READ_PIXELS) return fail();
    let data;
    try {
      data = canvas.getContext("2d").getImageData(box.x0, box.y0, width, height).data;
    } catch (_) { return fail(); }
    // 采样网格：全分辨率（step=1）。间距换算回固定坐标 = 1/pxPerPt pt；
    // 缩小视图下特征已小于设备像素、当前渲染不可见，视为已达成该画布可证明的极限密度。
    const step = 1;
    const f2c = (fx, fy) => {
      const p = apply(m, fx, fy);
      return [(p[0] * pxPerCss - box.x0) / step, (p[1] * pxPerCss - box.y0) / step];
    };
    const bandOf = rect => {
      const a = f2c(rect.x, rect.y), b = f2c(rect.right, rect.bottom);
      return {sx: Math.min(a[0], b[0]), ex: Math.max(a[0], b[0]), sy: Math.min(a[1], b[1]), ey: Math.max(a[1], b[1])};
    };
    const lineBands = lines.map(bandOf);
    const maskBand = bandOf(maskRect);
    const columns = Math.floor(width / step), rowsN = Math.floor(height / step);
    const at = (col, row) => {
      const offset = (row * step * width + col * step) * 4;
      return [data[offset], data[offset + 1], data[offset + 2]];
    };
    const inside = (band, col, row) => col >= band.sx && col <= band.ex && row >= band.sy && row <= band.ey;
    // 第一遍：环（region 减去 mask）背景众数色，5bit 量化直方图。
    const histogram = new Map();
    let ringTotal = 0;
    for (let row = 0; row < rowsN; row++) {
      for (let col = 0; col < columns; col++) {
        if (inside(maskBand, col, row)) continue;
        const c = at(col, row);
        const key = ((c[0] >> 3) << 10) | ((c[1] >> 3) << 5) | (c[2] >> 3);
        const bucket = histogram.get(key);
        if (bucket) { bucket.n++; bucket.r += c[0]; bucket.g += c[1]; bucket.b += c[2]; }
        else histogram.set(key, {n: 1, r: c[0], g: c[1], b: c[2]});
        ringTotal++;
      }
    }
    if (!ringTotal) return fail();
    let mode = null;
    for (const bucket of histogram.values()) if (!mode || bucket.n > mode.n) mode = bucket;
    const color = [Math.round(mode.r / mode.n), Math.round(mode.g / mode.n), Math.round(mode.b / mode.n)];
    // 第二遍：环均匀度、行区外墨迹、行带墨迹占比、横向线条游程（行区外才计入，避免文字笔画误判）。
    let ringHits = 0, inkViolations = 0, hasStrokes = false, solidInk = false;
    const lineInk = lineBands.map(() => ({ink: 0, total: 0}));
    const runThreshold = Math.max(4, Math.ceil(STROKE_MIN_PT * pxPerPt / step));
    for (let row = 0; row < rowsN; row++) {
      let run = 0, runOutside = false;
      for (let col = 0; col <= columns; col++) {
        const valid = col < columns;
        const isBg = valid && near(at(col, row), color);
        if (valid) {
          if (!inside(maskBand, col, row)) { if (isBg) ringHits++; }
          else for (let index = 0; index < lineBands.length; index++) {
            if (inside(lineBands[index], col, row)) { lineInk[index].total++; if (!isBg) lineInk[index].ink++; }
          }
        }
        if (!valid || isBg) {
          if (run >= runThreshold && runOutside) hasStrokes = true;
          run = 0; runOutside = false;
          continue;
        }
        run++;
        let inLine = false;
        for (let index = 0; index < lineBands.length; index++)
          if (inside(lineBands[index], col, row)) inLine = true;
        if (inLine) continue;
        inkViolations++;
        runOutside = true;
      }
      if (hasStrokes) break;
    }
    // 纵向游程：行区外墨迹或跨越≥2 个行区的连续游程 ≥ 阈值 → 表格竖线/图形（文字竖笔画仅在单行区内）。
    for (let col = 0; col < columns && !hasStrokes; col++) {
      let run = 0, touched = new Set(), outside = false;
      for (let row = 0; row <= rowsN; row++) {
        const valid = row < rowsN;
        const c = valid ? at(col, row) : null;
        const isBg = valid && near(c, color);
        if (!valid || isBg) {
          if (run >= runThreshold && (outside || touched.size >= 2)) hasStrokes = true;
          run = 0; touched = new Set(); outside = false;
          continue;
        }
        run++;
        if (!inside(maskBand, col, row)) { outside = true; continue; }
        let inLine = false;
        for (let index = 0; index < lineBands.length; index++)
          if (inside(lineBands[index], col, row)) { touched.add(index); inLine = true; }
        if (!inLine) outside = true;
      }
    }
    const uniform = ringHits / ringTotal >= BG_UNIFORM_RATIO;
    // 行区外墨迹容忍：抗锯齿边缘噪声按区域采样点比例放宽，团块/图形由游程与占比判定兜底。
    const violationLimit = Math.max(12, Math.floor(0.01 * columns * rowsN));
    const inkConfined = inkViolations <= violationLimit;
    for (const stat of lineInk) if (stat.total > 16 && stat.ink / stat.total > INK_RATIO_LIMIT) { solidInk = true; break; }
    return {densitySufficient: true, background: {uniform, color}, hasStrokes, inkConfined, solidInk};
  }
  global.BT_PDF_PIXEL_EVIDENCE = {sample, fail, constants: {MAX_READ_PIXELS, BG_TOLERANCE, BG_UNIFORM_RATIO, INK_RATIO_LIMIT, STROKE_MIN_PT}};
})(typeof window !== "undefined" ? window : self);
