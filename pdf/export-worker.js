/* P5-B/P5-C/P5b/P5-D 导出 Worker（classic）：按页码升序复制原 PDF 页对象 → 同一布局契约下以导出字体真实度量
   逐页重算原位规划 → 全部门禁通过后才落笔叠加遮罩与译文 → 所有未入位译文合成一份全局附录（多页按「第 N 页」分组）
   → 另存新文件。绝不修改源字节，绝不发起翻译/OCR/网络。任务载荷为 pages:[{snapshot,evidence,markerNumbers}]，
   主字体字段（fontCode/fontLabel/fontMetrics/fontBytes）在任务顶层共享，混排回退级由 fallbackFonts:[{code,label,bytes}] 追加；
   同一次导出按码点逐级绘制，子集字形跨页累加。
   importScripts 相对路径以本文件（pdf/）解析；布局规划器注入字体度量后不依赖 DOM/canvas。
   fontkit 用于自定义字体子集嵌入与逐字缺字判定；字体字节由页侧按需下载后随任务转移进来。
   「缺失页保留原文导出」时该页条目只有 {page}：无快照即原样复制源页，不规划、不绘制、不进附录。
   job.mode="bilingual"（P5-D 双语导出）：每页先照录原文页，再在真有原位译文时追加一张同尺寸同 /Rotate 的对照页
   （drawPage 引用原文页内容后叠遮罩与译文），输出按「原文页 → 对照页」相邻成对；附录仍集中在末尾不单另成对。 */
importScripts("structured-reader.js", "reflow-model.js", "reflow-typography.js", "layout-planner.js", "export-fonts.js", "reflow-document.js", "export-source.js", "vendor/pdf-lib/pdf-lib.min.js", "vendor/pdf-lib/fontkit.umd.min.js");
(function(global) {
  "use strict";
  const P = global.BT_PDF_LAYOUT_PLANNER;
  const {PDFDocument, StandardFonts, degrees, rgb, PDFName, PDFHexString} = global.PDFLib;
  const fontkit = global.fontkit;
  // 译文墨色：浅色背景用阅读页同色深墨（#243247），深色背景用浅墨，保证附录与原位译文都可阅读。
  const INK_DARK = rgb(36 / 255, 50 / 255, 71 / 255), INK_LIGHT = rgb(224 / 255, 231 / 255, 240 / 255);
  const MISSING_SAMPLE_LIMIT = 12;   // 缺字提示最多列出的字符数，避免状态行被长文本撑爆
  function invert(m) {
    const det = m[0] * m[3] - m[1] * m[2];
    if (!Number.isFinite(det) || det === 0) return null;
    return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det,
      (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
  }
  function apply(m, x, y) {
    return [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]];
  }
  function error(code, message) {
    const e = new Error(message); e.code = code; return e;
  }
  /** 固定坐标矩形四角 → 用户空间轴对齐包围盒（90° 倍数旋转下等价）；非有限值返回 null。 */
  function userBox(M, rect) {
    const pts = [[rect.x, rect.y], [rect.right, rect.y], [rect.right, rect.bottom], [rect.x, rect.bottom]]
      .map(([x, y]) => apply(M, x, y));
    if (pts.some(p => !Number.isFinite(p[0]) || !Number.isFinite(p[1]))) return null;
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    const x = Math.min(...xs), y = Math.min(...ys);
    return {x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y};
  }
  const luminance = c => (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;
  const toBytes = value => value instanceof Uint8Array ? value : new Uint8Array(value);
  /**
   * 字体文件头嗅探：把损坏字节交给 fontkit 会触发无界内存分配（实测 4 GiB 仍不返回），
   * 因此嵌入前先按 OpenType/TrueType 魔数拒绝，只认 OTTO、0x00010000、true、ttcf 四种容器。
   * 头部有效但内部表损坏的字体仍可能长时间解析——生产路径由下载时 sha256 与读取时字节数双重校验兜住。
   */
  function sniffFont(bytes) {
    if (!bytes || bytes.length < 12) return false;
    const tag = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
    return tag === "OTTO" || tag === "true" || tag === "ttcf" ||
      (bytes[0] === 0 && bytes[1] === 1 && bytes[2] === 0 && bytes[3] === 0);
  }

  /**
   * 能否安全子集：只有 sfnt 表目录里带 glyf（TrueType 轮廓）且不带 fvar（可变字体）的静态字体可以。
   * P7-B 用同一批汉字、同一绘制坐标做四格实测，逐字统计栅格图墨迹（CoreGraphics）并用 Chrome 内置
   * PDF 引擎复核，结论（详见 docs/pdf/progress.md）：
   *   CFF/OTTO + 子集 = 前三个绘制字形必失（与是哪个字无关，换顺序后空白跟着换位），Chrome 里整页零字；
   *   可变字体 + 子集 = 六个字只出一个；两者整表嵌入都正常，静态 glyf 子集六个全出且文件仅十几 KB。
   * 也就是说 @pdf-lib/fontkit 1.1.1 的子集器只对「静态 TrueType」可靠，CFF 子集产物是无效字体程序，
   * 这正是此前中文/韩文译文「导出成功但看不到字」「阅读器显示与导出不一致」的根因。
   * CFF 因此整表嵌入：宁可导出文件变大，也不产出缺字的 PDF。ttcf 是字体集合，表目录不在固定位置，一并走整表。
   */
  function canSubsetFont(bytes) {
    if (String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) === "ttcf") return false;
    const numTables = (bytes[4] << 8) | bytes[5];
    let glyf = false;
    for (let i = 0; i < numTables; i++) {
      const p = 12 + i * 16;
      if (p + 4 > bytes.length) return false;
      const key = String.fromCharCode(bytes[p], bytes[p + 1], bytes[p + 2], bytes[p + 3]);
      if (key === "fvar") return false;
      if (key === "glyf") glyf = true;
    }
    return glyf;
  }

  /**
   * 准备一个字体分级并派生其度量与逐字覆盖判定。
   * 内置分级：pdf-lib 标准字体不暴露 ascender，度量由页侧注册表声明（Helvetica AFM 0.718 / 1.25，
   * 与 P5-B 完全一致）；能否绘制等价于 pdf-lib 的 WinAnsi 编码是否接受该字符。
   * 自定义分级：先只解析度量与字形覆盖（决定能不能画、画多宽），子集嵌入推迟到该级真的落笔时（ensure）。
   * 推迟是必须的：pdf-lib 在 save() 里才生成子集，一个字形都没用到的分级会编码出空子集，
   * 实测抛 RangeError 且不被 Worker 的 try/catch 接住——整单导出连错误码都拿不到，直接进程级失败。
   * 页侧注册表与真实字形可能有偏差（如某级根本用不上），落笔时嵌入也顺带消除了这种「多给一级就炸」。
   * 宽度按 fontkit 逐码点字宽求和：与 pdf-lib CustomFont.widthOfTextAtSize 实测逐样本完全相等（差 0），
   * 因此嵌入前就能规划，且不会改变任何排版常量。
   * 垂直度量必须按字体派生：汉字级字体上升比 1.16、行高比 1.448，沿用 Helvetica 常量会让译文顶出行盒并压到邻行。
   */
  async function embedTier(out, entry) {
    const label = entry.label || entry.code || "导出字体";
    if (!entry.bytes) {
      const metrics = entry.metrics;
      if (!metrics || !Number.isFinite(metrics.ascent) || !(metrics.lineHeight > 0))
        throw error("EXPORT_FAILED", "缺少内置字体度量，无法安全排版");
      const font = await out.embedFont(entry.standardFont || StandardFonts.Helvetica);
      return {code: entry.code || "builtin", label, custom: false, metrics, used: false,
        covers: cp => { try { font.widthOfTextAtSize(String.fromCodePoint(cp), 1); return true; } catch (_) { return false; } },
        widthOf: (text, size) => font.widthOfTextAtSize(text, size),
        ensure: async () => font};
    }
    if (!fontkit) throw error("EXPORT_FAILED", "字体组件未加载，无法嵌入导出字体；请重新加载扩展后重试");
    const bytes = toBytes(entry.bytes);
    if (!sniffFont(bytes))
      throw error("EXPORT_FONT_FAILED", "导出字体（" + label + "）文件头无效，未生成文件；请在导出字体管理中删除后重新下载");
    out.registerFontkit(fontkit);
    let parsed;
    try {
      parsed = fontkit.create(bytes);
    } catch (cause) {
      throw error("EXPORT_FONT_FAILED", "导出字体（" + label + "）解析失败，未生成文件" +
        (cause && cause.message ? "（" + String(cause.message).slice(0, 120) + "）" : ""));
    }
    if (!parsed || typeof parsed.hasGlyphForCodePoint !== "function")
      throw error("EXPORT_FONT_FAILED", "导出字体（" + label + "）字形不可读，无法判定能否绘制；请在导出字体管理中删除该字体后重新下载");
    let ascent, descent, upem;
    try {
      // 字体头部完好但 head/OS2 表被截断时，fontkit 的度量 getter 自身就会抛 TypeError；
      // 不接住它会以裸错误冒出去，用户看到的是内部报错而不是「字体异常、可重新下载」。
      ascent = parsed.ascent;
      descent = parsed.descent;
      upem = parsed.unitsPerEm;
    } catch (_) {
      throw error("EXPORT_FONT_FAILED", "导出字体（" + label + "）内部数据损坏，未生成文件；请在导出字体管理中删除该字体后重新下载");
    }
    if (!Number.isFinite(ascent) || !(upem > 0))
      throw error("EXPORT_FONT_FAILED", "导出字体（" + label + "）度量不可读，无法安全排版；请在导出字体管理中删除该字体后重新下载");
    // 实测：pdf-lib 的非子集分支靠 fontkit 的 font.cff 判定轮廓味型，而 vendor 的 fontkit UMD 没有该
    // getter，于是 CFF 整表被写成 /CIDFontType2 + /FontFile2（规范要求 FontFile2 必须是 glyf 程序）。
    // Chrome 内置引擎与 macOS 预览都能读出并画出全部字形（P7-B 截图取证），Acrobat/WPS 待人工验证；
    // 修正这处声明需要改 vendor 或事后重写字体对象，属核心高风险项，按任务书只报告不擅自实施。
    const subsets = canSubsetFont(bytes);
    let font = null;
    return {code: entry.code, label, custom: true, used: false, subsets,
      metrics: {ascent: ascent / upem, lineHeight: (ascent - descent) / upem},
      covers: cp => {
        try { return parsed.hasGlyphForCodePoint(cp); }
        catch (_) { throw error("EXPORT_FONT_FAILED", "导出字体（" + label + "）字形表损坏，无法判定能否绘制；请在导出字体管理中删除该字体后重新下载"); }
      },
      widthOf: (text, size) => {
        let total = 0;
        for (const ch of String(text)) {
          const glyph = parsed.glyphForCodePoint(ch.codePointAt(0));
          if (!glyph) return NaN;
          total += glyph.advanceWidth;
        }
        return total / upem * size;
      },
      ensure: async () => {
        if (font) return font;
        try {
          font = await out.embedFont(bytes, {subset: subsets});
        } catch (cause) {
          throw error("EXPORT_FONT_FAILED", "导出字体（" + label + "）嵌入失败，未生成文件" +
            (cause && cause.message ? "（" + String(cause.message).slice(0, 120) + "）" : ""));
        }
        return font;
      }};
  }

  /**
   * 建立本次导出的字体分级集合：主字体（job.fontBytes/fontMetrics/fontLabel）决定行高与上升部，
   * job.fallbackFonts 只补主字体没有的字形——混排（如中英韩）任何单级都缺字，整单拒绝会让用户无论改选哪级都导出失败。
   * 逐字判定按「主级 → 回退级」次序取第一个真有字形的分级，因此单语言文本的绘制结果与单字体时逐字节相同；
   * 基线与行高始终由主字体派生，回退级不参与垂直度量（不新增排版常量，也不改动原位安全阈值）。
   */
  async function setupFont(out, job) {
    const tiers = [await embedTier(out, {code: job.fontCode, label: job.fontLabel,
      bytes: job.fontBytes, metrics: job.fontMetrics})];
    for (const extra of Array.isArray(job.fallbackFonts) ? job.fallbackFonts : [])
      tiers.push(await embedTier(out, extra));
    const main = tiers[0], chosen = new Map();
    // CFF 的标准拉丁数字在部分阅读器中会发生 CID 错映射；可用 WinAnsi 字形优先由标准字体绘制。
    // 不修改 vendor/嵌入映射；主字体仍决定安全行高，混排宽度统一按实际绘制分级重算。
    let standard=tiers.find(tier=>!tier.custom);
    if(!standard){standard=await embedTier(out,{code:"builtin",label:"内置标准字体",metrics:{ascent:.718,lineHeight:1.25}});tiers.push(standard);}
    // 人工修订的西文字体使用 PDF 标准字体；其他字符继续走既有字形回退，不冒充已嵌入宋体。
    const styleKey=(family,style)=>[family||"sans-serif",style.bold,style.italic].join(":");
    const families=new Map([[styleKey("sans-serif",P.normalizeTextStyle()),standard]]);
    const variants={
      "sans-serif":[StandardFonts.Helvetica,StandardFonts.HelveticaBold,StandardFonts.HelveticaOblique,StandardFonts.HelveticaBoldOblique],
      serif:[StandardFonts.TimesRoman,StandardFonts.TimesRomanBold,StandardFonts.TimesRomanItalic,StandardFonts.TimesRomanBoldItalic],
      monospace:[StandardFonts.Courier,StandardFonts.CourierBold,StandardFonts.CourierOblique,StandardFonts.CourierBoldOblique]};
    for(const [,result] of (job.pages||[]).flatMap(page=>page.snapshot?.results||[])){
      if(!result?.userEdited)continue;
      const family=variants[result.fontFamily]?result.fontFamily:"sans-serif",style=P.normalizeTextStyle(result.textStyle),key=styleKey(family,style);
      if(families.has(key))continue;
      const name=variants[family][Number(style.bold)+Number(style.italic)*2];
      const tier=await embedTier(out,{code:"builtin-"+key,label:"西文修订字体（"+name+"）",standardFont:name,metrics:{ascent:.718,lineHeight:1.25}});
      families.set(key,tier);tiers.push(tier);
    }
    // PDF 标准符号字体补充数学／技术字形；按真实编码覆盖选用，不替换正文字符。
    for(const [code,name,label] of [["builtin-symbol",StandardFonts.Symbol,"内置数学符号字体"],["builtin-dingbats",StandardFonts.ZapfDingbats,"内置标记符号字体"]])
      tiers.push(await embedTier(out,{code,label,standardFont:name,metrics:{ascent:1,lineHeight:1.25}}));
    // 同一码点只判定一次分级：分段与缺字门禁共用该结论，宽度也按判定出的那只字体实测。
    const tierFor = cp => {
      if (!chosen.has(cp)) chosen.set(cp, standard.covers(cp)?standard:tiers.find(tier => tier.covers(cp)) || null);
      return chosen.get(cp);
    };
    const runWidth = (tier, text, size) => {
      try { return tier.widthOf(text, size); } catch (_) { return NaN; }
    };
    /** 一行文本按实际绘制级切成连续段；任一段无级可绘制返回 null（调用方按不可绘制处理）。 */
    function runs(text, size, family, textStyle) {
      const list = [],style=P.normalizeTextStyle(textStyle),preferred=families.get(styleKey(family,style));
      for (const ch of String(text)) {
        const cp=ch.codePointAt(0);
        const tier = preferred?.covers(cp)?preferred:tierFor(cp);
        if (!tier) return null;
        const last = list[list.length - 1];
        if (last && last.tier === tier) { last.text += ch; continue; }
        list.push({tier, text: ch});
      }
      for (const run of list) {
        const width = runWidth(run.tier, run.text, size);
        if (!Number.isFinite(width)) return null;
        // 非西文仍使用已下载的字形，模拟粗斜体并把外伸量计入换行宽度。
        run.synthetic=run.tier.custom&&(style.bold||style.italic);
        run.boldOffset=run.synthetic&&style.bold?size*.025:0;
        run.italic=run.synthetic&&style.italic;
        run.width = width+run.boldOffset+(run.italic?size*.35:0);
      }
      return list;
    }
    /** 一行文本的真实宽度 = 各级分段宽度之和；不可绘制返回 Infinity → fitBlock 失败 → 回退附录。 */
    const measure = (text, size, family, textStyle) => {
      const list = runs(text, size, family, textStyle);
      return list ? list.reduce((total, run) => total + run.width, 0) : Infinity;
    };
    /** 落笔前嵌入该级子集并记为「本次真的用到」：统计只报实际参与绘制的分级。 */
    async function drawRun(target, run, x, y, size, ink, rotate) {
      const font = await run.tier.ensure();
      run.tier.used = true;
      if(!run.synthetic){target.drawText(run.text, {x, y, size, font, color: ink, rotate});return;}
      // 先转到文字局部坐标，再倾斜／加粗；旋转页与普通页使用同一套效果。
      const radians=rotate.angle*Math.PI/180,c=Math.cos(radians),s=Math.sin(radians),lib=global.PDFLib;
      target.pushOperators(lib.pushGraphicsState(),lib.concatTransformationMatrix(c,s,-s,c,x,y));
      try{
        const options={x:run.italic?size*.08:0,y:0,size,font,color:ink,ySkew:degrees(run.italic?12:0)};
        target.drawText(run.text,options);
        if(run.boldOffset)target.drawText(run.text,{...options,x:options.x+run.boldOffset});
      }finally{target.pushOperators(lib.popGraphicsState());}
    }
    return {custom: main.custom, ascent: main.metrics.ascent,
      lineHeight: main.metrics.lineHeight, labels: tiers.map(tier => tier.label),
      codes: tiers.map(tier => tier.code), runs, measure, drawRun,
      usedCodes: () => tiers.filter(tier => tier.used).map(tier => tier.code),
      /** 实际落笔但只能整表嵌入的分级（CFF 轮廓）：页侧据此如实说明导出文件为什么变大。 */
      fullCodes: () => tiers.filter(tier => tier.custom && tier.used && !tier.subsets).map(tier => tier.code),
      canRender: ch => tierFor(ch.codePointAt(0)) !== null};
  }

  /**
   * 逐字缺字门禁（default-deny）：任何将要绘制的字符没有字形就整单拒绝，绝不输出缺字方框文件。
   * 只看实际绘制的字符串——规划器已把空白折叠为 U+0020，页侧已剔除零宽与双向控制字符，
   * 因此不可见字符不会造成误判；页侧注册表只决定嵌入哪几级，权威判定在这里（逐级 hasGlyphForCodePoint）。
   */
  function assertRenderable(setup, label, texts, what) {
    const missing = [];
    for (const text of texts) {
      for (const ch of String(text)) {
        if (setup.canRender(ch) || missing.includes(ch)) continue;
        missing.push(ch);
        if (missing.length >= MISSING_SAMPLE_LIMIT) break;
      }
      if (missing.length >= MISSING_SAMPLE_LIMIT) break;
    }
    if (!missing.length) return;
    throw error("EXPORT_GLYPH_MISSING", "导出字体（" + label + "）无法绘制" + what + "中的 " +
      missing.length + (missing.length >= MISSING_SAMPLE_LIMIT ? " 个以上" : " 个") + "字符：" +
      missing.map(ch => ch + "(U+" + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, "0") + ")").join(" ") +
      "；已拒绝导出以免生成缺字文件。正文与内置符号字体均未覆盖这些字形；可使用「导出本页编辑稿」由浏览器打印，或保留原文导出");
  }

  /**
   * 单页绘制模型：按该页几何基准重算规划，并逐块预校验（行宽可测、遮罩盒非退化）。
   * 校验不通过的块不入位，交给全局附录兜底——绝不画半截遮罩。
   */
  function planSheet(item, setup, measure) {
    const {snapshot, geometry, M} = item;
    const results = new Map(snapshot.results || []);
    const rows = (snapshot.blocks || []).map(block => ({block, result: results.get(block.id) || null}));
    const evidence = new Map(item.evidence || []);
    const plan = P.plan({geometry, rows, evidence, domFailures: null, measure, lineHeight: setup.lineHeight});
    // 文本方向角：固定坐标 +x（文字前进方向）经 VT₁⁻¹ 线性部分映射到用户空间的角度；/Rotate 保持原样不动。
    const angle = Math.atan2(M[1], M[0]) * 180 / Math.PI;
    const placed = [];
    for (const [blockId, pl] of plan.placements) {
      const widths = [];
      let ok = true;
      for (const line of pl.lines) {
        try { widths.push(measure(line, pl.fontSize, pl.fontFamily, pl.textStyle)); } catch (_) { ok = false; break; }
        if (!Number.isFinite(widths[widths.length - 1])) { ok = false; break; }
      }
      const box = ok ? userBox(M, pl.maskRect) : null;
      if (!ok || !box || box.width <= 0 || box.height <= 0) continue;
      const boxes=(pl.maskRects||[pl.maskRect]).map(rect=>userBox(M,rect));
      if(boxes.some(rect=>!rect||rect.width<=0||rect.height<=0))continue;
      placed.push({blockId, pl, widths, box, boxes});
    }
    return {rows, plan, angle, placed, drawn: new Set(placed.map(({blockId}) => blockId))};
  }
  /**
   * 导出件页码跳转书签（PDF 大纲）。pdf-lib 无大纲高层 API：在此手工建 /Outlines 对象图并挂到 Catalog，
   * 每项 /A 为 GoTo + [页对象 /Fit]，/First /Last /Prev /Next 必须是间接引用（写成直接对象读者端不合规）。
   * 标题用 PDFHexString（UTF-16BE）承载中文；≥2 项时才设 /PageMode /UseOutlines，单页导出不打扰默认视图。
   * 返回写入的条目数：0=未构造（条目不足或异常），调用方必须在状态里如实说明，不得当作已生成。
   */
  function addOutlines(out, entries) {
    const items = (entries || []).filter(entry => entry && entry.page && entry.page.ref && entry.title);
    if (items.length < 2) return 0;
    try {
      const context = out.context;
      const rootDict = context.obj({Type: "Outlines", Count: items.length});
      const rootRef = context.register(rootDict);
      let first = null, last = null;
      for (const entry of items) {
        const dict = context.obj({Title: PDFHexString.fromText(String(entry.title)), Parent: rootRef,
          A: {S: "GoTo", D: [entry.page.ref, PDFName.of("Fit")]}});
        const ref = context.register(dict);
        if (last) { last.dict.set(PDFName.of("Next"), ref); dict.set(PDFName.of("Prev"), last.ref); }
        else first = ref;
        last = {dict, ref};
      }
      rootDict.set(PDFName.of("First"), first);
      rootDict.set(PDFName.of("Last"), last.ref);
      out.catalog.set(PDFName.of("Outlines"), rootRef);
      out.catalog.set(PDFName.of("PageMode"), PDFName.of("UseOutlines"));
      return items.length;
    } catch (_) {
      return 0;
    }
  }
  /**
   * 书签条目：按输出页序逐项自说明，标题同时给出「输出第几页」与「源文档第几页」，
   * 双语成对页原文/对照各一条，保留原文页与附录页单独成条（附录首页带页区间与段数）。
   */
  function outlineEntries(out, sheets, appendixSheets, items, multi, bilingual) {
    const index = new Map();
    out.getPages().forEach((page, position) => index.set(page.ref.toString(), position + 1));
    const at = page => index.get(page.ref.toString());
    const entries = [];
    for (const sheet of sheets) {
      const original = at(sheet.sheet), target = at(sheet.target);
      if (!Number.isFinite(original) || !Number.isFinite(target)) continue;
      if (!sheet.snapshot) {
        entries.push({title: "第 " + original + " 页（原第 " + sheet.page + " 页，未翻译，保留原文）", page: sheet.sheet});
        continue;
      }
      if (bilingual && sheet.paired) {
        entries.push({title: "第 " + original + " 页 原文（原第 " + sheet.page + " 页）", page: sheet.sheet});
        entries.push({title: "第 " + target + " 页 对照译文（原第 " + sheet.page + " 页，" + sheet.placed.length + " 段原位）", page: sheet.target});
        continue;
      }
      entries.push({title: (multi ? "第 " + target + " 页" : "译文") + "（原第 " + sheet.page + " 页，" +
        sheet.placed.length + " 段原位）", page: sheet.target});
    }
    if (appendixSheets.length) {
      const first = at(appendixSheets[0]);
      const span = appendixSheets.length > 1 ? "（第 " + first + "–" + at(appendixSheets[appendixSheets.length - 1]) + " 页）" : "（第 " + first + " 页）";
      entries.push({title: "回退译文附录" + span + "共 " + items.length + " 段", page: appendixSheets[0]});
      for (const sheet of appendixSheets.slice(1)) {
        const position = at(sheet);
        if (Number.isFinite(position)) entries.push({title: "附录续第 " + position + " 页", page: sheet});
      }
    }
    return entries;
  }

  /** 自然分页的纯译文阅读版；复用相同的字体选级、逐字门禁与有效译文快照。 */
  async function exportTranslated(job) {
    const {requestId} = job;
    const jobs = Array.isArray(job.pages) ? job.pages.map(item=>item?.snapshot?{...item,snapshot:{...item.snapshot,
      results:(item.snapshot.results||[]).map(([id,result])=>[id,global.BT_PDF_EXPORT_FONTS.normalizeResult(result)])}}:item) : null;
    const progress = (stage, message) => postMessage({type: "progress", requestId, stage, message});
    if (!jobs || !jobs.length) throw error("EXPORT_FAILED", "缺少导出页数据，请重新读取并翻译后再导出");
    progress("load", "正在读取源 PDF…");
    const loaded=await global.BT_PDF_EXPORT_SOURCE.load({bytes:job.bytes,lib:global.PDFLib,error});
    // 逐页身份校验：同一文档、页数与源一致、页码有效且不重复、坐标基准可逆。任何一页不合格整单拒绝。
    // snapshot 缺失的条目是「保留原文页」（未翻译页显式保留导出）：只按页码复制，不规划、不绘制、不入附录。
    const numPages = loaded.getPageCount();
    const reference = jobs.find(pageJob => pageJob && pageJob.snapshot && pageJob.snapshot.identity);
    const documentId = reference ? reference.snapshot.identity.documentId : null;
    const seen = new Set();
    const targets = [];
    for (const pageJob of jobs) {
      const snapshot = pageJob && pageJob.snapshot;
      const identity = snapshot && snapshot.identity;
      const page = identity ? identity.page : pageJob && pageJob.page;
      if (!Number.isInteger(page) || page < 1 || page > numPages)
        throw error("EXPORT_FAILED", "导出页码无效（第 " + page + " 页），请刷新阅读页后重试");
      if (seen.has(page)) throw error("EXPORT_FAILED", "导出页码重复（第 " + page + " 页），请重新选择页码范围");
      seen.add(page);
      if (!snapshot) { targets.push({page, snapshot: null}); continue; }
      if (identity.documentId !== documentId)
        throw error("EXPORT_SOURCE_CHANGED", "导出快照来自不同文档或已不完整，请重新读取并翻译后再导出");
      if (identity.numPages !== numPages)
        throw error("EXPORT_SOURCE_CHANGED", "源文件与翻译结果不一致（页数已变化），请重新读取并翻译后再导出");
      const geometry = snapshot.geometry;
      if (!geometry || !Array.isArray(geometry.transform))
        throw error("EXPORT_FAILED", "第 " + page + " 页缺少页面坐标基准，请重新翻译本页后再导出");
      const M = invert(geometry.transform);
      if (!M) throw error("EXPORT_FAILED", "第 " + page + " 页坐标变换不可逆，无法导出");
      targets.push({page, snapshot, geometry, M, evidence: pageJob.evidence, markerNumbers: pageJob.markerNumbers});
    }
    // 复制源页必须按页码升序：输出页序与阅读顺序一致，附录按页分组也以此为序。
    targets.sort((a, b) => a.page - b.page);

    const out = await PDFDocument.create();
    const setup = await setupFont(out, job);
    if(job.mode==="structured")return global.BT_PDF_REFLOW_DOCUMENT.compose({out,setup,targets,job,loaded,userBox,error,rgb,degrees,addOutlines});
    const ascent = setup.ascent;
    // 此处只完成度量与字形覆盖判定（解析），子集嵌入推迟到各级真正落笔时进行。
    progress("font", setup.codes.length > 1 ? "正在准备导出字体（混排 " + setup.codes.length + " 级）…"
      : job.fontBytes ? "正在解析导出字体…" : "正在准备内置导出字体…");
    const fontLabel = setup.labels.join(" + ");
    /**
     * 落笔前的逐级分段。返回 null 意味着该字符实际画不出来（字体文件被截断/损坏时，覆盖判定可能
     * 仍通过而宽度读不出）。这里必须显式报字体异常并中止导出：既不能让 for..of 抛出生涩的 TypeError，
     * 更不能跳过这一段——静默少画就是「导出成功但看不到字」。
     */
    const splitRuns = (text, size, family, textStyle) => {
      const list = setup.runs(text, size, family, textStyle);
      if (list) return list;
      // 指到具体字符：覆盖判定说画得出、实际分段失败时，用户和排查者都需要知道是哪一个字。
      let miss = "";
      for (const ch of String(text)) {
        if (!setup.canRender(ch) || !Number.isFinite(setup.measure(ch, size))) { miss = ch; break; }
      }
      throw error("EXPORT_FONT_FAILED", "导出字体（" + fontLabel + "）无法绘制" +
        (miss ? "「" + miss + "」(U+" + miss.codePointAt(0).toString(16).toUpperCase().padStart(4, "0") + ")" : "译文") +
        "，字体文件可能不完整或已损坏；请在导出字体管理中删除该字体后重新下载");
    };
    // 注入规划器的宽度度量即各级导出字体的真实度量（按绘制级分段实测后求和）；
    // 不可绘制字符返回 Infinity → fitBlock 失败 → 回退附录，缺字门禁随后按逐级判定整单拒绝。
    const measure = setup.measure;

    progress("plan", targets.length > 1 ? "正在按导出字体度量规划 " + targets.length + " 页原位译文…"
      : "正在按导出字体度量规划原位译文…");
    const copied = await out.copyPages(loaded, targets.map(({page}) => page - 1));
    const sheets = copied.map((sheet, index) => Object.assign({sheet}, targets[index],
      targets[index].snapshot ? planSheet(targets[index], setup, measure)
        : {rows: [], plan: null, placed: [], drawn: new Set()}));
    // 落笔前先过缺字门禁：任一页任一行有无字形字符即整单拒绝，不画半截遮罩。
    assertRenderable(setup, fontLabel, sheets.flatMap(sheet => sheet.placed.map(({pl}) => pl.lines).flat()), "原位译文");
    const bilingual = job.mode === "bilingual";
    // P5-D 成对页：原文页入册后不再动笔，真有原位译文的页追加一张对照页——用 Form XObject 引用同一份页内容，
    // 遮罩与译文只落在对照页上。资源（字体/图像）按引用共享，体积接近单份译文导出，不像整页二次复制那样翻倍。
    // 无 /Contents 的页必须前置跳过：pdf-lib 的 embedPage 对这类页不在当场报错，而是迟到达 save() 才抛，整单白做。
    for (const sheet of sheets) {
      out.addPage(sheet.sheet);
      sheet.target = sheet.sheet;
      sheet.paired = false;
      if (!bilingual || !sheet.snapshot || !sheet.placed.length) continue;
      // 无法成对（页没有内容流，或结构异常）时绝不把遮罩画到原文页上：清空本页原位结果，译文照旧进附录。
      const unpair = message => {
        progress("draw", message);
        sheet.placed = [];
        sheet.drawn = new Set();
      };
      if (!sheet.sheet.node.Contents()) {
        unpair("第 " + sheet.page + " 页没有内容流，无法生成对照页；该页译文改入附录");
        continue;
      }
      try {
        if (sheets.length > 1) progress("draw", "正在生成第 " + sheet.page + " 页对照页…");
        const box = sheet.sheet.getMediaBox();
        const embedded = await out.embedPage(sheet.sheet);
        const companion = out.addPage([embedded.width, embedded.height]);
        companion.setRotation(degrees(sheet.sheet.getRotation().angle));  // addPage 只收尺寸参数：/Rotate 必须显式设
        companion.setMediaBox(box.x, box.y, embedded.width, embedded.height);
        companion.drawPage(embedded, {x: 0, y: 0});
        sheet.target = companion;
        sheet.paired = true;
      } catch (_) {
        unpair("第 " + sheet.page + " 页结构不支持对照页；该页译文改入附录");
      }
    }

    // 附录：所有有译文但未入位的块（回退/待证/绘制降级）按阅读顺序编号列出，绝不丢失译文。
    // 编号优先复用阅读页回退标记号（页侧传入），新降级块接续最大号继续编；块 id 含页码，跨页天然不冲突。
    const sentNumbers = new Map();
    let nextNumber = 1;
    for (const sheet of sheets)
      for (const [blockId, number] of (sheet.markerNumbers || [])) {
        sentNumbers.set(blockId, number);
        if (number >= nextNumber) nextNumber = number + 1;
      }
    const multi = sheets.length > 1;
    const appendixRows = [];
    for (const sheet of sheets)
      for (const {block, result} of sheet.rows)
        if (result && result.status === "translated" && result.text && result.text.trim() && !sheet.drawn.has(block.id))
          appendixRows.push({page: sheet.page, block, result});
    // 附录按「页码升序 → 页内阅读顺序」编号，与阅读页翻页顺序一致。
    appendixRows.sort((a, b) => a.page - b.page || (a.block.order || 0) - (b.block.order || 0));
    const items = appendixRows.map(item => ({...item, number: sentNumbers.get(item.block.id) || nextNumber++}));
    // 附录模型先于任何落笔建立：多页时按「第 N 页」分组，编号全局唯一（块 id 含页码，天然不冲突）。
    // 附录纸张尺寸沿用第一页的固有宽高，与单页导出口径一致。
    let appendixPages = 0, appendixLanguage = "none", appendix = null;
    const appendixSheets = [];
    if (items.length) {
      const base = sheets.find(sheet => sheet.geometry);
      const W = base.geometry.width, H = base.geometry.height, MARGIN = 36;
      const BODY = 10.5, TITLE = 15, ITEM_GAP = 7, GROUP_GAP = BODY * 1.6;
      // 附录行高同样按字体派生：汉字级字体沿用固定 13.5 会让相邻行墨迹重叠。
      const LH = BODY * setup.lineHeight;
      // 中文附录只在字体真有这些汉字字形时使用：谚文级字体只覆盖韩国常用汉字，画不出「译」「显」等字。
      const zhTitle = "附录：未能原位显示的译文";
      const zhNote = "共 " + items.length + " 段；" + (multi ? "译文按页码分组，" : "") + "编号与阅读页回退标记一致（如有）。";
      const zhGroup = page => "第 " + page + " 页";
      // 单页附录不画分组标题，因此也不因「第/页」缺字而改变语言判定：与 P5-C 输出口径完全一致。
      const useChinese = [...(zhTitle + zhNote + (multi ? zhGroup(1) : ""))].every(ch => setup.canRender(ch));
      const title = useChinese ? zhTitle : "Appendix: Translations Not Placed In-Page";
      const note = useChinese ? zhNote : items.length + " item(s)" +
        (multi ? "; grouped by source page" : "") + "; numbers match the reading view markers where available.";
      appendixLanguage = useChinese ? "zh" : "ascii";
      const group = multi ? (page => useChinese ? zhGroup(page) : "Page " + page) : null;
      const bodyLines = items.map(item => ({page: item.page, number: item.number, group: group && group(item.page),
        lines: P.wrapText(item.result.text, BODY, W - 2 * MARGIN - 24, measure)}));
      assertRenderable(setup, fontLabel, [title, note,
        ...bodyLines.flatMap(item => [item.group, "[" + item.number + "]", ...item.lines].filter(Boolean))], "附录");
      appendix = {W, H, MARGIN, BODY, TITLE, ITEM_GAP, GROUP_GAP, LH, title, note, bodyLines};
    }

    for (const sheet of sheets) {
      if (!sheet.snapshot) {
        if (multi) progress("draw", "第 " + sheet.page + " 页没有可用译文，按原文保留…");
        continue;
      }
      progress("draw", multi ? "正在绘制第 " + sheet.page + " 页原位译文（" + sheet.placed.length + " 处）…"
        : "正在绘制原位译文（" + sheet.placed.length + " 处）…");
      const {M, angle} = sheet;
      const target = sheet.target;
      for (const {pl, widths, boxes} of sheet.placed) {
        const mc = Array.isArray(pl.maskColor) && pl.maskColor.length === 3 ? pl.maskColor : [255, 255, 255];
        const customColor=pl.textStyle?.color;
        const ink = customColor?rgb(...[1,3,5].map(offset=>parseInt(customColor.slice(offset,offset+2),16)/255)):
          luminance(mc) < 0.55 ? INK_LIGHT : INK_DARK;
        for(const box of boxes)target.drawRectangle({x: box.x, y: box.y, width: box.width, height: box.height,
          color: rgb(mc[0] / 255, mc[1] / 255, mc[2] / 255)});
        for (const [index, line] of pl.lines.entries()) {
          // 基线锚点：行盒顶 + i×行高 + 上升部；右对齐块以行宽回退锚点。全部在固定坐标计算后经 M 映射。
          const yFixed = pl.textRect.y + index * pl.lineHeight + ascent * pl.fontSize;
          // 逐级分段绘制：每段用自己的字体（落笔时才嵌入该级子集），前进量按该段实测宽度累计后再经 M 映射（旋转页偏移方向随之正确）。
          let xFixed = pl.align === "right" ? pl.textRect.right - widths[index] : pl.align === "center"?
            (pl.textRect.x+pl.textRect.right-widths[index])/2:pl.textRect.x;
          for (const run of splitRuns(line, pl.fontSize, pl.fontFamily, pl.textStyle)) {
            const p = apply(M, xFixed, yFixed);
            await setup.drawRun(target, run, p[0], p[1], pl.fontSize, ink, degrees(angle));
            xFixed += run.width;
          }
        }
      }
    }

    if (appendix) {
      progress("draw", "正在生成附录页（" + items.length + " 段未入位译文）…");
      const {W, H, MARGIN, BODY, TITLE, ITEM_GAP, GROUP_GAP, LH, title, note, bodyLines} = appendix;
      // 附录坐标：cursor 为距页顶的固定坐标游标；附录页无 /Rotate，y_user = H − 基线距顶。
      // 跨页时每页重画标题，附录页自说明；换页分组只画一次组标题，绝不在同组条目之间插行。
      let sheet = null, cursor = 0, lastPage = 0;
      // 附录同样逐级分段绘制：基线 y 由主字体上升部派生，各段只沿 x 方向按自身宽度前进。
      const drawRuns = async (text, x, y, size) => {
        let offset = x;
        for (const run of splitRuns(text, size)) {
          await setup.drawRun(sheet, run, offset, y, size, INK_DARK, degrees(0));
          offset += run.width;
        }
      };
      const newSheet = async () => {
        sheet = out.addPage([W, H]); appendixPages++; appendixSheets.push(sheet);
        await drawRuns(title, MARGIN, H - MARGIN - TITLE * ascent, TITLE);
        cursor = MARGIN + TITLE + 8;
      };
      const drawLine = (text, x, top) => drawRuns(text, x, H - top - BODY * ascent, BODY);
      await newSheet();
      await drawLine(note, MARGIN, cursor);
      cursor += BODY * 1.6;
      for (const item of bodyLines) {
        if (!item.lines.length) continue;
        if (item.page !== lastPage) {
          lastPage = item.page;
          if (item.group) {
            if (cursor + GROUP_GAP + LH > H - MARGIN) await newSheet();
            await drawLine(item.group, MARGIN, cursor);
            cursor += GROUP_GAP;
          }
        }
        if (cursor + LH > H - MARGIN) await newSheet();
        await drawLine("[" + item.number + "]", MARGIN, cursor);
        for (const line of item.lines) {
          // 单段本身也可能长于一页：逐行分页，续页沿用原编号，不裁切、不丢尾文。
          if(cursor+LH>H-MARGIN){await newSheet();await drawLine("["+item.number+"]",MARGIN,cursor);}
          await drawRuns(line, MARGIN + 24, H - cursor - BODY * ascent, BODY);
          cursor += LH;
        }
        cursor += ITEM_GAP;
      }
    }

    progress("save", "正在生成导出文件…");
    // 书签在全部页面（含对照页与附录页）就位后建立：输出页号此时才确定。构造失败不阻断导出，
    // 但 bookmarks=0 会由页侧状态如实写出「页码书签未生成」，绝不静默假装已生成。
    const bookmarks = addOutlines(out, outlineEntries(out, sheets, appendixSheets, items, multi, bilingual));
    const saved = await out.save();
    const bytes = saved.byteOffset === 0 && saved.byteLength === saved.buffer.byteLength
      ? saved.buffer : saved.buffer.slice(saved.byteOffset, saved.byteOffset + saved.byteLength);
    const sum = pick => sheets.reduce((total, sheet) => total + pick(sheet), 0);
    const counts = sheet => sheet.plan ? {fallback: sheet.plan.fallbacks.length, pending: sheet.plan.pending.length}
      : {fallback: 0, pending: 0};
    return {bytes, stats: {mode: bilingual ? "bilingual" : "translated", pairs: sum(sheet => sheet.paired ? 1 : 0),
      overlay: sum(sheet => sheet.placed.length), fallback: sum(sheet => counts(sheet).fallback),
      pending: sum(sheet => counts(sheet).pending), selected: sheets.length,
      appendixItems: items.length, appendixPages, appendixLanguage, pages: out.getPageCount(), bookmarks,
      font: job.fontCode || "builtin", fontCodes: setup.usedCodes(), fontFull: setup.fullCodes(), customFont: setup.custom,
      per: sheets.map(sheet => Object.assign({page: sheet.page, overlay: sheet.placed.length,
        original: !sheet.snapshot, pair: !!sheet.paired}, counts(sheet)))}};
  }

  global.onmessage = event => {
    const job = event.data;
    if (!job || job.job !== "export") return;
    void exportTranslated(job).then(
      ({bytes, stats}) => postMessage({type: "done", requestId: job.requestId, bytes, stats}, {transfer: [bytes]}),
      cause => postMessage({type: "error", requestId: job.requestId,
        code: cause && cause.code ? cause.code : "EXPORT_FAILED",
        message: cause && cause.message ? cause.message : "导出失败"}));
  };
})(self);
