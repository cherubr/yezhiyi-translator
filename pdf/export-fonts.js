(function(global) {
  "use strict";
  /**
   * P5-C 导出字体注册表：纯数据 + 字符分级，不下载、不建 Worker、不触碰 pdf-lib/fontkit。
   *
   * 分级依据全部来自本机实测（.local/p5c/coverage-ranges.cjs、.local/p5c/coverage-edge.cjs，
   * 逐码点精确判定，非抽样）：
   *   builtin = pdf-lib 内置标准字体（Helvetica），只覆盖 WinAnsi(CP1252)，无需下载；
   *   sc/kr   = 按需下载的 Noto Sans 静态子集 OTF，覆盖范围与已知缺口写在条目 coverage/gaps。
   * 判定顺序「先 WinAnsi 再区块」是实测结论：Š š Ÿ Ž ž ˆ ˜ 只有内置字体有字形，
   * 若先按区块选 sc，纯西欧文本会既误报缺字又白下载 8 MB。
   *
   * 本注册表只负责「选哪一级字体」与「哪些文字必须整单阻止」；
   * 权威缺字判定在导出 Worker（fontkit hasGlyphForCodePoint 逐字校验实际绘制的行），
   * 不在这里猜测某个字符是否真有字形——SC/KR 在拉丁扩展、西里尔、希腊区块只是常用子集。
   * 代价是明确的：土耳其语/波兰语/捷克语/匈牙利语/乌克兰语/带音调希腊语等文本会先下载字体，
   * 再由 Worker 列出缺字整单拒绝；页侧不另维护缺字表，避免与字体真实覆盖脱钩后误放行。
   */
  // 字体来源版本：noto-cjk 固定 commit，升级字体时同步修改此处与条目摘要。
  const FONT_SOURCE = "noto-cjk@f8d157532fbfaeda587e826d4cd5b21a49186f7c";
  const FONT_BASE_URL = "https://raw.githubusercontent.com/notofonts/noto-cjk/" +
    FONT_SOURCE.slice(FONT_SOURCE.indexOf("@") + 1) + "/";
  // 两个条目同一许可证，随字体一并记录；.otf 为字体数据文件，不属远程代码。
  const LICENSE = {name: "SIL Open Font License 1.1", file: "Sans/LICENSE",
    bytes: 4301, sha256: "6a73f9541c2de74158c0e7cf6b0a58ef774f5a780bf191f2d7ec9cc53efe2bf2"};
  /**
   * builtin 的度量只能在此声明：pdf-lib 不暴露标准字体的 ascender，也没有 hasGlyphForCodePoint。
   * ascent 0.718 为 Helvetica AFM 上升值，lineHeight 1.25 与规划器现行常量一致，
   * 因此西欧文字导出的排版行为与 P5-B 完全相同；sc/kr 的度量由 Worker 用 fontkit 实测派生。
   */
  const FONTS = [
    {code: "builtin", label: "内置标准字体（西欧文字）", bundled: true, kind: "standard",
      metrics: {ascent: 0.718, lineHeight: 1.25},
      coverage: "WinAnsi(CP1252)：基本拉丁、西欧变音、常用标点与货币符号，无需下载。",
      gaps: "汉字、假名、谚文、越南语、希腊、西里尔及全部非西欧文字。"},
    {code: "sc", label: "汉字·假名（Noto Sans SC）", bundled: false, kind: "subset-otf",
      file: "Sans/SubsetOTF/SC/NotoSansSC-Regular.otf", bytes: 8331336,
      sha256: "faa6c9df652116dde789d351359f3d7e5d2285a2b2a1f04a2d7244df706d5ea9", license: LICENSE,
      coverage: "简体与繁体常用汉字（20976）、平假名与片假名全覆盖、注音符号、越南语全覆盖、" +
        "全角与中日韩标点、基础希腊与俄语西里尔、数学符号、箭头、制表线、康熙部首。",
      gaps: "谚文音节全部缺失；土耳其语 ğışİ、波兰语 ąćęłśŹŻ、捷克语 čďřťůž、匈牙利语 őű、" +
        "波罗的海与克罗地亚语部分变音、带音调希腊字母 άέήίόύώ、乌克兰语 ҐґІіЇїЄє、" +
        "Š š Ÿ Ž ž ˆ ˜（这几个只有内置字体有）、希伯来、阿拉伯、印度系、泰文、表情符号、汉字扩展 B。"},
    {code: "kr", label: "谚文·常用汉字（Noto Sans KR）", bundled: false, kind: "subset-otf",
      file: "Sans/SubsetOTF/KR/NotoSansKR-Regular.otf", bytes: 4644748,
      sha256: "69975a0ac8472717870aefeab0a4d52739308d90856b9955313b2ad5e0148d68", license: LICENSE,
      coverage: "谚文音节全覆盖（11172）、谚文字母与兼容字母、假名全覆盖、韩国教育常用汉字（8138）、" +
        "越南语、全角与中日韩标点、基础希腊与俄语西里尔、数学符号与箭头。",
      gaps: "汉字仅覆盖韩国常用子集（简体中文如「译」缺失）；其余缺口与汉字级条目相同。"}
  ];
  // 必须整单阻止导出的原因；不允许退化成「附录里放缺字方框」。
  const BLOCK_REASONS = {
    shaping: "需要连写整形与上下文变体，当前导出引擎不做字形整形",
    bidi: "需要从右到左双向排版，当前导出引擎不做双向重排",
    "no-font": "注册表暂无覆盖该文字的导出字体条目"
  };
  /**
   * 需要下载字体或必须阻止的文字类别，按码点区间升序判定，命中即止。
   * 区间取 Unicode 区块边界；未命中且非 WinAnsi 的字符按「未注册文字」阻止。
   * block 条目经实测确认 SC/KR 在该区块覆盖数为 0（如希腊扩展、盲文、表情符号、汉字扩展 B），
   * 或该文字本身需要整形/双向排版——即使将来找到字体也不能直接绘制。
   */
  const SCRIPTS = [
    {name: "拉丁扩展与音标", font: "sc", ranges: [[0x100, 0x2AF]]},
    {name: "希腊文", font: "sc", ranges: [[0x370, 0x3FF]]},
    {name: "西里尔文", font: "sc", ranges: [[0x400, 0x52F]]},
    {name: "亚美尼亚文", block: "no-font", ranges: [[0x530, 0x58F]]},
    {name: "希伯来文", block: "bidi", ranges: [[0x590, 0x5FF], [0xFB1D, 0xFB4F]]},
    {name: "阿拉伯文·叙利亚文等", block: "shaping", ranges: [[0x600, 0x8FF], [0xFB50, 0xFDFF], [0xFE70, 0xFEFC]]},
    {name: "印度系文字（天城文·孟加拉文·泰米尔文等）", block: "shaping", ranges: [[0x900, 0xDFF]]},
    {name: "泰文·老挝文·缅甸文", block: "shaping", ranges: [[0xE00, 0x109F]]},
    {name: "格鲁吉亚文", block: "no-font", ranges: [[0x10A0, 0x10FF], [0x2D00, 0x2D2F]]},
    {name: "谚文", font: "kr", ranges: [[0x1100, 0x11FF], [0x3130, 0x318F], [0xAC00, 0xD7AF]]},
    {name: "高棉文", block: "shaping", ranges: [[0x1780, 0x17FF]]},
    {name: "越南语等拉丁扩展附加", font: "sc", ranges: [[0x1E00, 0x1EFF]]},
    {name: "希腊扩展（多调号希腊文）", block: "no-font", ranges: [[0x1F00, 0x1FFF]]},
    {name: "标点·符号·运算符", font: "sc", ranges: [[0x2000, 0x27BF], [0x2E00, 0x2E7F]]},
    {name: "盲文", block: "no-font", ranges: [[0x2800, 0x28FF]]},
    {name: "中日韩部首与符号", font: "sc", ranges: [[0x2E80, 0x303F]]},
    {name: "假名", font: "sc", ranges: [[0x3040, 0x30FF], [0x31F0, 0x31FF]]},
    {name: "注音符号", font: "sc", ranges: [[0x3100, 0x312F]]},
    {name: "中日韩笔画·带圈字母·兼容形式", font: "sc", ranges: [[0x31C0, 0x33FF]]},
    {name: "汉字", font: "sc", ranges: [[0x3400, 0x4DBF], [0x4E00, 0x9FFF], [0xF900, 0xFAFF]]},
    {name: "拉丁合字", font: "sc", ranges: [[0xFB00, 0xFB1C]]},
    {name: "竖排与小型变体形式", font: "sc", ranges: [[0xFE10, 0xFE6F]]},
    {name: "半角与全角形式", font: "sc", ranges: [[0xFF00, 0xFFEF]]},
    {name: "表情符号与图形符号", block: "no-font", ranges: [[0x1F000, 0x1FAFF]]},
    {name: "汉字扩展 B 及以后", block: "no-font", ranges: [[0x20000, 0x3FFFF]]}
  ];
  const UNKNOWN_SCRIPT = {name: "未注册文字", block: "no-font"};
  const SAMPLE_LIMIT = 8;   // 拒绝提示中每个类别最多列出的样例字符数，避免状态行被长文本撑爆
  // WinAnsi(CP1252) 中不在 Latin-1 直接映射内的字符；pdf-lib 内置标准字体只覆盖该字符集。
  const WINANSI_SPECIAL = new Set([0x20AC, 0x201A, 0x192, 0x201E, 0x2026, 0x2020, 0x2021, 0x2C6, 0x2030,
    0x160, 0x2039, 0x152, 0x17D, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014, 0x2DC,
    0x2122, 0x161, 0x203A, 0x153, 0x17E, 0x178]);
  const builtinCovers = cp => cp < 0x80 || (cp >= 0xA0 && cp < 0x100) || WINANSI_SPECIAL.has(cp);
  /**
   * 零宽与双向控制字符：实测 SC/KR 都没有字形，绘制会变成缺字方框，且它们的字面宽度为 0，
   * 剔除后不改变可见排版（阅读层的 DOM 本来也不显示它们）。变体选择符同属不可见格式字符。
   */
  const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFE00-\uFE0F\uFEFF]/g;
  const normalize = text => String(text ?? "").replace(INVISIBLE, "");
  // 控制符与空白不参与分级：各级字体都有空格字形，空白不决定该用哪一级字体。
  const skipChar = ch => {
    const cp = ch.codePointAt(0);
    return cp < 0x20 || (cp >= 0x7F && cp < 0xA0) || /\s/.test(ch);
  };

  function classifyCodePoint(cp) {
    if (builtinCovers(cp)) return {name: "西欧文字", font: "builtin"};
    for (const script of SCRIPTS)
      for (const [low, high] of script.ranges)
        if (cp >= low && cp <= high)
          return script.block ? {name: script.name, block: script.block} : {name: script.name, font: script.font};
    return UNKNOWN_SCRIPT;
  }

  const list = () => FONTS.map(font => ({...font}));
  const has = code => FONTS.some(font => font.code === code && font.bundled);
  const known = code => FONTS.some(font => font.code === code);
  const label = code => FONTS.find(font => font.code === code)?.label || code;
  const entry = code => FONTS.find(font => font.code === code) || null;
  /** 可下载条目 → 钉死直链与摘要；内置或未注册条目返回 null。 */
  const source = code => {
    const font = FONTS.find(item => item.code === code && !item.bundled && item.sha256);
    return font ? {url: FONT_BASE_URL + font.file, sha256: font.sha256, bytes: font.bytes} : null;
  };
  /** 内置字体的度量声明；可下载条目返回 null，表示必须由 Worker 用 fontkit 实测派生。 */
  const metrics = code => entry(code)?.metrics || null;

  /**
   * 为一批文本选定导出字体分级。
   * 任一字符属于必须阻止的类别 → blocked 非空，调用方必须整单拒绝导出（不生成缺字文件）；
   * 谚文优先于汉字：SC 完全没有谚文字形，KR 覆盖 8138 个常用汉字，
   * 混排是否真能绘制仍由 Worker 逐字判定，宁可拒绝也不输出方框。
   * extra 为混排回退级：中英韩混排任何一级都缺字（KR 缺「译」、SC 缺谚文），
   * 主级只决定垂直度量与优先绘制，主级没有的字形由回退级补绘。顺序固定为汉字级→谚文级→内置级，
   * 内置放最后是因为 Š š Ÿ Ž ž ˆ ˜ 只有它有字形；这里只声明「还需要嵌入谁」，不声称该级一定画得出。
   * @param {Iterable<string>} texts 需要绘制的文本（含附录），内部先剔除不可见字符。
   * @returns {{font:"builtin"|"sc"|"kr", extra:("builtin"|"sc"|"kr")[], blocked:{name:string, reason:string, samples:string}[]}}
   */
  function select(texts) {
    const blocked = new Map(), tiers = new Set();
    for (const raw of texts) {
      for (const ch of normalize(raw)) {
        if (skipChar(ch)) continue;
        const found = classifyCodePoint(ch.codePointAt(0));
        if (!found.block) { tiers.add(found.font); continue; }
        const key = found.name + "\u0000" + found.block;
        const item = blocked.get(key) || {name: found.name, reason: found.block, samples: ""};
        if (item.samples.length < SAMPLE_LIMIT) item.samples += ch;
        blocked.set(key, item);
      }
    }
    const font = tiers.has("kr") ? "kr" : tiers.has("sc") ? "sc" : "builtin";
    const extra = ["sc", "kr"].filter(code => tiers.has(code) && code !== font);
    if (font !== "builtin" && tiers.has("builtin")) extra.push("builtin");
    return {font, extra, blocked: [...blocked.values()]};
  }

  /** 把 blocked 结果整理成一句可显示中文说明；类别、原因与样例字符都给全，不含用户译文全文。 */
  function describeBlocked(blocked) {
    return blocked.map(item => item.name + "（" + BLOCK_REASONS[item.reason] +
      (item.samples ? "，如 " + item.samples : "") + "）").join("；");
  }

  global.BT_PDF_EXPORT_FONTS = {FONT_SOURCE, FONT_BASE_URL, LICENSE, BLOCK_REASONS, SAMPLE_LIMIT,
    list, has, known, label, entry, source, metrics,
    builtinCovers, normalize, classifyCodePoint, select, describeBlocked};
})(window);
