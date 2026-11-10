(function(global) {
  "use strict";
  const MAX_ITEMS = 12000, MAX_CHARS = 200000;
  const median = values => { const sorted = values.filter(n => n > 0).sort((a,b) => a-b); return sorted[Math.floor(sorted.length/2)] || 12; };
  function rectOf(points) {
    const xs=points.map(p=>p[0]),ys=points.map(p=>p[1]);
    return {x:Math.min(...xs),y:Math.min(...ys),right:Math.max(...xs),bottom:Math.max(...ys)};
  }
  function transform(a,b) {
    return [a[0]*b[0]+a[2]*b[1],a[1]*b[0]+a[3]*b[1],a[0]*b[2]+a[2]*b[3],a[1]*b[2]+a[3]*b[3],a[0]*b[4]+a[2]*b[5]+a[4],a[1]*b[4]+a[3]*b[5]+a[5]];
  }
  function invert(m) {
    const d=m[0]*m[3]-m[1]*m[2];
    return [m[3]/d,-m[1]/d,-m[2]/d,m[0]/d,(m[2]*m[5]-m[3]*m[4])/d,(m[1]*m[4]-m[0]*m[5])/d];
  }
  const applyPoint=(m,x,y)=>[m[0]*x+m[2]*y+m[4],m[1]*x+m[3]*y+m[5]];
  function quality(text) {
    if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFD\uD800-\uDFFF]/u.test(text)) return "文字包含损坏编码";
    if (/[\p{Private_Use}\p{Unassigned}]/u.test(text)) return "文字映射不能可靠确认";
    return "";
  }
  function code(text, mono) {
    return /^\s*(?:#include\b|(?:const|let|var|def|function|class|return|import)\s+|(?:for|if|while)\s*\()/u.test(text) ||
      (mono && /[{};=]|=>|\+\+|\b(?:true|false|null)\b/.test(text)) ||
      (/[{}]/.test(text)&&/[:;=]/.test(text));
  }
  function formula(text) {
    // 片段级保护只认含运算符的真公式：裸数字（年份、统计值）不再加保护标记，
    // 避免密集标记放大服务漏译时的整块失败；纯数字行仍由 role 判定（无字母）归为 formula 跳过。
    if(!/[\p{L}]/u.test(text))return /[=≠≤≥∑∫√±×÷^]/u.test(text);
    if(text.length>200||!/[=≠≤≥∑∫√±×÷^]/u.test(text))return false;
    const words=text.match(/\p{L}+/gu)||[];
    return words.every(word=>Array.from(word).length<=2||/^(?:sin|cos|tan|log|ln|exp|max|min)$/i.test(word));
  }
  function splitProtected(text, protect=false) {
    if(protect)return [{text,protected:true}];
    const parts=[];let offset=0;
    for(const match of text.matchAll(/(?:https?:\/\/|www\.)[^\s<>]+|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|`[^`\n]+`/gu)){
      if(match.index>offset)parts.push({text:text.slice(offset,match.index)});
      parts.push({text:match[0],protected:true});offset=match.index+match[0].length;
    }
    if(offset<text.length)parts.push({text:text.slice(offset)});
    return parts;
  }
  function separator(a,b,gap,height) {
    if(/\s$/.test(a)||/^\s/.test(b))return "";
    if(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]$/u.test(a)&&/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(b))return "";
    return gap>height*0.12 ? " " : "";
  }
  /** XY 空白切分：先分栏，再按全宽标题等水平区域分层；不跨栏逐行拼句。 */
  function readingOrder(blocks, depth=0) {
    if(blocks.length<2||depth>16)return [...blocks].sort((a,b)=>a.rect.y-b.rect.y||a.rect.x-b.rect.x);
    const height=median(blocks.map(b=>b.height));
    for(const [start,end,minimum] of [["x","right",height*1.5],["y","bottom",height]]){
      const intervals=blocks.map(b=>[b.rect[start],b.rect[end]]).sort((a,b)=>a[0]-b[0]);
      let edge=intervals[0][1],cut=null,gap=0;
      for(const interval of intervals.slice(1)){
        if(interval[0]-edge>Math.max(minimum,gap)){gap=interval[0]-edge;cut=(interval[0]+edge)/2;}
        edge=Math.max(edge,interval[1]);
      }
      if(cut!==null){
        const before=blocks.filter(b=>b.rect[end]<=cut),after=blocks.filter(b=>b.rect[start]>=cut);
        if(before.length&&after.length&&before.length+after.length===blocks.length){
          if(start==="x"&&blocks.filter(b=>b.direction==="rtl").length>blocks.length/2)return [...readingOrder(after,depth+1),...readingOrder(before,depth+1)];
          return [...readingOrder(before,depth+1),...readingOrder(after,depth+1)];
        }
      }
    }
    return [...blocks].sort((a,b)=>a.rect.y-b.rect.y||a.rect.x-b.rect.x);
  }
  function process(page) {
    if(page.items.length>MAX_ITEMS)throw global.BT_PDF_ERRORS.create("TEXT_BUDGET", "本页文字项过多，暂不自动翻译", "extract",false);
    let chars=0;const fragments=[],seen=new Set();
    for(let index=0;index<page.items.length;index++){
      const item=page.items[index];if(typeof item.str!=="string"||!item.str.trim())continue;
      chars+=item.str.length;
      if(chars>MAX_CHARS)throw global.BT_PDF_ERRORS.create("TEXT_BUDGET", "本页文字量过大，暂不自动翻译", "extract",false);
      const matrix=transform(page.transform,item.transform),height=Math.hypot(matrix[2],matrix[3]);
      const advance=Math.hypot(matrix[0],matrix[1]);
      if(!Number.isFinite(height+advance)||height<=0||advance<=0)continue;
      const unit=[matrix[0]/advance,matrix[1]/advance],vertical=[matrix[2]/height,matrix[3]/height];
      const width=Math.abs(item.width)*Math.hypot(page.transform[0],page.transform[1]);
      if(!Number.isFinite(width)||width<=0)continue;
      const style=page.styles[item.fontName]||{},ascent=Number.isFinite(style.ascent)?style.ascent:0.8;
      // CJK 字体盒常高于 1em（如 ascent 1.06 / descent -0.44）：结构 rect 保持 1em 行盒（段落切分依赖），
      // 另记 inkBottom = 基线以下墨迹底（descent 封顶 0.5em），供遮罩与采样带覆盖块末行残墨。
      const descent=Number.isFinite(style.descent)?Math.max(style.descent,-0.5):-0.2;
      const inkBottom=matrix[5]+vertical[1]*height*descent;
      const top=[matrix[4]+vertical[0]*height*ascent,matrix[5]+vertical[1]*height*ascent];
      // viewport 已包含 Y 轴翻转；字体上行方向沿矩阵第二列。
      const quad=[top,[top[0]+unit[0]*width,top[1]+unit[1]*width],
        [top[0]+unit[0]*width-vertical[0]*height,top[1]+unit[1]*width-vertical[1]*height],
        [top[0]-vertical[0]*height,top[1]-vertical[1]*height]];
      const rect=rectOf(quad),key=item.str+":"+Math.round(rect.x)+":"+Math.round(rect.y);
      if(seen.has(key))continue;seen.add(key);
      const reason=quality(item.str)||((item.dir==="ttb"||Math.abs(unit[1])>0.15||unit[0]<0)?"旋转或竖排阅读顺序暂不能确认":"");
      fragments.push({text:item.str,index,rect,height,baseline:matrix[5],inkBottom,direction:item.dir==="rtl"?"rtl":"ltr",
        mono:/mono|courier|console/i.test(style.fontFamily||""),reason,hasEOL:item.hasEOL});
    }
    const rows=[];
    for(const fragment of fragments.sort((a,b)=>a.baseline-b.baseline||a.rect.x-b.rect.x)){
      const row=rows[rows.length-1];
      if(row&&Math.abs(row.baseline-fragment.baseline)<=Math.max(2,Math.min(row.height,fragment.height)*0.3))row.fragments.push(fragment);
      else rows.push({baseline:fragment.baseline,height:fragment.height,fragments:[fragment]});
    }
    const lines=[];
    for(const row of rows){
      let group=[];
      const flush=()=>{
        if(!group.length)return;
        const directional=group.filter(f=>/\p{L}/u.test(f.text));
        const directions=new Set(directional.map(f=>f.direction)),rtl=directions.size===1&&directions.has("rtl");
        const ordered=rtl?[...group].reverse():group;
        const segments=[];let previous=null;
        for(const f of ordered){
          const gap=previous?(rtl?previous.rect.x-f.rect.right:f.rect.x-previous.rect.right):0;
          if(previous)segments.push({text:separator(previous.text,f.text,gap,f.height)});
          segments.push(...splitProtected(f.text,code(f.text,f.mono)||formula(f.text)));previous=f;
        }
        const text=segments.map(p=>p.text).join("").trim();
        const rect=rectOf(group.flatMap(f=>[[f.rect.x,f.rect.y],[f.rect.right,f.rect.bottom]]));
        lines.push({text,segments,rect,height:median(group.map(f=>f.height)),inkBottom:Math.max(...group.map(f=>f.inkBottom)),indices:group.map(f=>f.index),direction:rtl?"rtl":"ltr",
          reason:group.find(f=>f.reason)?.reason||(directions.size>1?"双向混排顺序需人工确认":""),
          mono:group.every(f=>f.mono)});
        group=[];
      };
      for(const fragment of row.fragments.sort((a,b)=>a.rect.x-b.rect.x)){
        const previous=group[group.length-1];
        if(previous&&(fragment.rect.x-previous.rect.right>Math.max(fragment.height,previous.height)*1.8 ||
          Math.min(fragment.height,previous.height)/Math.max(fragment.height,previous.height)<0.7))flush();
        group.push(fragment);
      }
      flush();
    }
    const paragraphs=[];
    for(const line of lines.sort((a,b)=>a.rect.y-b.rect.y||a.rect.x-b.rect.x)){
      const role=code(line.text,line.mono)?"code":(!/[\p{L}]/u.test(line.text)||formula(line.text))?"formula":/^(?:https?:\/\/|www\.)\S+$/.test(line.text)||/^[\w.+-]+@[\w.-]+$/.test(line.text)?"identifier":"text";
      let parent=null;
      if(role==="text"&&!line.reason){
        parent=paragraphs.slice(-128).reverse().find(p=>p.role==="text"&&!p.reason&&p.direction===line.direction&&
          line.rect.y-p.rect.bottom>=-line.height*0.25&&line.rect.y-p.rect.bottom<line.height*0.9&&
          Math.abs((line.direction==="rtl"?line.rect.right:line.rect.x)-(line.direction==="rtl"?p.rect.right:p.rect.x))<line.height*0.8&&
          Math.min(p.height,line.height)/Math.max(p.height,line.height)>0.8);
      }
      if(parent){
        const join=/\p{Script=Han}$/u.test(parent.text)&&/^\p{Script=Han}/u.test(line.text)?"":" ";
        parent.text+=join+line.text;parent.segments.push({text:join},...line.segments);parent.lines.push(line);
        parent.inkBottom=Math.max(parent.inkBottom,line.inkBottom);
        parent.rect={x:Math.min(parent.rect.x,line.rect.x),y:Math.min(parent.rect.y,line.rect.y),right:Math.max(parent.rect.right,line.rect.right),bottom:Math.max(parent.rect.bottom,line.rect.bottom)};
      }else paragraphs.push({...line,role,lines:[line],segments:[...line.segments]});
    }
    const blocks=readingOrder(paragraphs).map((block,order)=>({...block,id:page.pageNumber+":"+order+":"+block.lines.flatMap(l=>l.indices).join("-"),
      order,source:"native",quad:[[block.rect.x,block.rect.y],[block.rect.right,block.rect.y],[block.rect.right,block.rect.bottom],[block.rect.x,block.rect.bottom]],
      quality:{text:block.reason?"uncertain":"reliable",order:block.reason?"uncertain":"reliable",reasons:block.reason?[block.reason]:[]},
      placement:{mode:"text-only",reasons:["P2 基础段落对照"]},
      reliable:!block.reason,eligible:!block.reason&&block.role==="text",
      reason:block.reason||(block.role!=="text"?"保留代码、公式或标识符":"")}));
    // inkLimit = 同列后续最近块的结构顶：遮罩向 inkBottom 扩展时的硬上限，保证不越入邻段。
    for(const block of blocks){
      let limit=Infinity;
      for(const other of blocks){
        if(other===block||other.rect.y<=block.rect.y+1e-6)continue;
        if(block.rect.x<other.rect.right&&other.rect.x<block.rect.right)limit=Math.min(limit,other.rect.y);
      }
      block.inkLimit=limit;
    }
    return {pageNumber:page.pageNumber,width:page.width,height:page.height,blocks,
      empty:!blocks.length,unreliable:blocks.filter(b=>!b.reliable).length};
  }
  // P4-B OCR 置信度分层：≥75 可信赖（允许原位遮罩）；60–75 送翻但仅对照显示；<60 不自动送翻。
  const OCR_HIGH = 75, OCR_LOW = 60;
  /** 页面类型分类：可靠文字量、文字层可靠性与位图/文字/绘制算子数多信号联合判定，不用单一覆盖率阈值。 */
  function classifyPage(processed, probe) {
    const reliable = processed.blocks.filter(b => b.reliable && b.eligible);
    const reliableChars = reliable.reduce((n,b) => n + b.text.length, 0);
    const images = probe?.imageOps || 0, showText = probe?.showTextOps || 0, total = probe?.totalOps || 0;
    // 有正文量、或无位图时存在任何可靠文字，都走原生文字路径；位图主导且文字缺失/不可靠才判扫描。
    if (reliableChars >= 32 || reliable.length >= 3 || (!images && reliable.length))
      return images > 0
        ? {type: "mixed", reasons: ["有可靠文字层", "含位图图片区域"]}
        : {type: "text", reasons: ["有可靠文字层"]};
    if (images > 0) return {type: "scanned", reasons: [reliable.length || showText ? "文字层缺失或不可靠" : "无文字层", "含整页位图"]};
    if (showText > 0) {
      // 固有旋转/竖排页的文字层本身完好，只是阅读顺序不能确认（P2 default-deny，不放宽）：
      // 如实标注原因，仍走 OCR——渲染图像是直立的，这是该类页面唯一可用的翻译路径。
      const rotated = processed.blocks.some(b => !b.reliable) &&
        processed.blocks.every(b => b.reliable || b.reason === "旋转或竖排阅读顺序暂不能确认");
      return {type: "scanned", reasons: rotated
        ? ["文字层为固有旋转或竖排，阅读顺序暂不能确认", "以 OCR 替代（按直立渲染图像识别）"]
        : ["文字层字符全部不可靠（乱码或异常映射）", "以 OCR 替代"]};
    }
    if (total > 2) return {type: "scanned", reasons: ["无文字层且仅矢量绘制（可能为转曲文字）", "以 OCR 替代"]};
    return {type: "blank", reasons: ["无文字与图形内容"]};
  }
  /** OCR 行结果 → 统一文字块模型：坐标先由位图像素换算回固定坐标，再复用原生段落组装与阅读顺序。 */
  function processOcr({pageNumber, width, height, result, bitmap}) {
    const lines = result?.lines || [];
    if (lines.length > 4000) throw global.BT_PDF_ERRORS.create("TEXT_BUDGET", "本页识别行数过多，暂不自动翻译", "ocr", false);
    // bitmap.viewportTransform 为 scale 渲染视口矩阵，pixelScale=画布像素/视口点，pageTransform=VT_1；
    // 像素 → 视口点 → 固定坐标必须补乘 VT_1，否则与原生块坐标系不一致（Y 翻转/旋转页错位）。
    const k = bitmap.pixelScale > 0 ? bitmap.pixelScale : 1;
    const toFixed = transform(bitmap.pageTransform, transform(invert(bitmap.viewportTransform), [1/k, 0, 0, 1/k, 0, 0]));
    const lineModels = [];
    lines.forEach((line, index) => {
      const text = typeof line.text === "string" ? line.text.trim() : "";
      if (!text) return;
      const rect = rectOf([applyPoint(toFixed, line.bbox.x0, line.bbox.y0), applyPoint(toFixed, line.bbox.x1, line.bbox.y1)]);
      if (!Number.isFinite(rect.x + rect.y) || rect.right <= rect.x || rect.bottom <= rect.y) return;
      const confidence = Math.max(0, Math.min(100, Number(line.confidence) || 0));
      lineModels.push({text, confidence, rect, height: Math.max(rect.bottom - rect.y, 1), indices: [index], direction: "ltr", mono: false, reason: "",
        regions: Number.isInteger(line.regionIndex) ? [line.regionIndex] : [],
        segments: splitProtected(text, code(text, false) || formula(text))});
    });
    const paragraphs = [];
    for (const line of lineModels) {
      const role = code(line.text, false) ? "code" : (!/[\p{L}]/u.test(line.text) || formula(line.text)) ? "formula" : "text";
      let parent = null;
      if (role === "text") {
        parent = paragraphs.slice(-64).reverse().find(p => p.role === "text" &&
          line.rect.y - p.rect.bottom >= -line.height * 0.35 && line.rect.y - p.rect.bottom < line.height * 0.9 &&
          Math.abs(line.rect.x - p.rect.x) < line.height * 0.8 &&
          Math.min(p.height, line.height) / Math.max(p.height, line.height) > 0.7);
      }
      if (parent) {
        const join = /\p{Script=Han}$/u.test(parent.text) && /^\p{Script=Han}/u.test(line.text) ? "" : " ";
        parent.text += join + line.text; parent.segments.push({text: join}, ...line.segments); parent.lines.push(line);
        parent.indices = parent.lines.flatMap(l => l.indices);
        parent.confidenceSum += line.confidence * line.text.length; parent.textLength += line.text.length;
        parent.height = median(parent.lines.map(l => l.height));
        parent.rect = {x: Math.min(parent.rect.x, line.rect.x), y: Math.min(parent.rect.y, line.rect.y),
          right: Math.max(parent.rect.right, line.rect.right), bottom: Math.max(parent.rect.bottom, line.rect.bottom)};
      } else {
        paragraphs.push({...line, role, lines: [line], segments: [...line.segments], indices: [...line.indices],
          confidenceSum: line.confidence * line.text.length, textLength: line.text.length});
      }
    }
    const blocks = readingOrder(paragraphs).map((paragraph, order) => {
      const confidence = paragraph.textLength ? Math.round(paragraph.confidenceSum / paragraph.textLength) : 0;
      const reason = paragraph.role !== "text" ? "保留代码、公式或标识符"
        : confidence < OCR_LOW ? "OCR 置信度过低，未自动翻译"
        : confidence < OCR_HIGH ? "OCR 置信度中等，不做原位遮罩" : "";
      return {id: pageNumber + ":ocr:" + order + ":" + paragraph.indices.join("-"), order, source: "ocr",
        text: paragraph.text, segments: paragraph.segments, lines: paragraph.lines, rect: paragraph.rect,
        height: paragraph.height, direction: "ltr", role: paragraph.role, mono: false, confidence,
        regions: [...new Set(paragraph.lines.flatMap(l => l.regions))].sort((a, b) => a - b),
        quad: [[paragraph.rect.x, paragraph.rect.y], [paragraph.rect.right, paragraph.rect.y],
          [paragraph.rect.right, paragraph.rect.bottom], [paragraph.rect.x, paragraph.rect.bottom]],
        quality: {text: confidence >= OCR_HIGH ? "reliable" : "uncertain", order: confidence >= OCR_HIGH ? "reliable" : "uncertain",
          reasons: reason && paragraph.role === "text" ? [reason] : []},
        placement: {mode: "text-only", reasons: ["P4-B OCR 段落对照"]},
        reliable: confidence >= OCR_HIGH && paragraph.role === "text",
        eligible: confidence >= OCR_LOW && paragraph.role === "text", reason};
    });
    return {pageNumber, width, height, blocks, empty: !blocks.length,
      unreliable: blocks.filter(b => !b.reliable).length, source: "ocr",
      engine: result?.engine || "", engineVersion: result?.engineVersion || "", modelVersion: result?.modelVersion || ""};
  }
  // P4-C 区域规划阈值：过小的图片/矢量簇不单独识别；转曲候选保守限量，区域总数控制 OCR 成本。
  const REGION_MIN_SIDE = 48, REGION_MIN_AREA = 4800, MAX_REGIONS = 8, MAX_OUTLINED = 2,
    HIDDEN_COVERAGE = 0.5, DEDUP_CONTAIN = 0.6;
  const rectArea = r => Math.max(0, r.right - r.x) * Math.max(0, r.bottom - r.y);
  function intersectArea(a, b) {
    const w = Math.min(a.right, b.right) - Math.max(a.x, b.x), h = Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y);
    return w > 0 && h > 0 ? w * h : 0;
  }
  const inflateRect = (r, d) => ({x: r.x - d, y: r.y - d, right: r.right + d, bottom: r.bottom + d});
  const unionRect = (a, b) => ({x: Math.min(a.x, b.x), y: Math.min(a.y, b.y),
    right: Math.max(a.right, b.right), bottom: Math.max(a.bottom, b.bottom)});
  const clampRect = (r, w, h) => {
    const rect = {x: Math.max(0, Math.min(r.x, r.right)), y: Math.max(0, Math.min(r.y, r.bottom)),
      right: Math.min(w, Math.max(r.x, r.right)), bottom: Math.min(h, Math.max(r.y, r.bottom))};
    return rect.right > rect.x && rect.bottom > rect.y ? rect : null;
  };
  const rectsOverlap = (a, b) => a.x < b.right && b.x < a.right && a.y < b.bottom && b.y < a.bottom;
  /** 贪心首次适配聚簇：与已有簇外接矩形（外扩 gap 后）相交则并入，否则新建；返回 {rect,count}。 */
  function clusterRects(rects, gap) {
    const clusters = [];
    for (const rect of rects) {
      const padded = inflateRect(rect, gap);
      const hit = clusters.find(c => rectsOverlap(padded, c.rect));
      if (hit) { hit.rect = unionRect(hit.rect, padded); hit.count++; }
      else clusters.push({rect: {...padded}, count: 1});
    }
    return clusters;
  }
  const garbledBlock = b => b.source === "native" && !b.reliable &&
    /损坏编码|映射不能可靠确认/.test((b.quality?.reasons || []).join("|"));
  /**
   * P4-C 区域规划：由探针结果与原生块推导需要 OCR 的候选区域，纯函数。
   * A 图片区域（可靠文字覆盖过半视为隐藏文字层，跳过）；B 乱码文字层聚簇；
   * C 矢量路径密集簇（疑似转曲文字，保守判定且不与可靠内容相交）。
   * 重叠候选取并集，按类型优先级与面积排序，总数截断到 MAX_REGIONS。
   */
  function planOCR(model, probe) {
    const warnings = [], candidates = [];
    const reliable = model.blocks.filter(b => b.reliable && b.eligible).map(b => b.rect);
    const imageRects = [];
    for (const image of probe?.images || []) {
      const rect = clampRect(image.rect, model.width, model.height);
      if (!rect) continue;
      imageRects.push(rect);
      if (Math.min(rect.right - rect.x, rect.bottom - rect.y) < REGION_MIN_SIDE || rectArea(rect) < REGION_MIN_AREA) continue;
      const covered = reliable.reduce((sum, r) => sum + intersectArea(r, rect), 0);
      if (covered >= rectArea(rect) * HIDDEN_COVERAGE) continue;
      candidates.push({type: "image", rank: 0, reason: "图片区域缺少可靠文字层", rect});
    }
    const garbled = model.blocks.filter(garbledBlock).map(b => inflateRect(b.rect, 2));
    for (const cluster of clusterRects(garbled, 6)) {
      const rect = clampRect(cluster.rect, model.width, model.height);
      if (rect) candidates.push({type: "garbled", rank: 1, reason: "文字层乱码或映射不可靠", rect});
    }
    const outlined = clusterRects(probe?.vectorRects || [], 12)
      .filter(cluster => cluster.count >= 8)
      .map(cluster => clampRect(cluster.rect, model.width, model.height))
      .filter(rect => rect && Math.min(rect.right - rect.x, rect.bottom - rect.y) >= REGION_MIN_SIDE && rectArea(rect) >= REGION_MIN_AREA)
      .filter(rect => !reliable.some(r => rectsOverlap(rect, r)) && !imageRects.some(r => rectsOverlap(rect, r)) &&
        !candidates.some(c => rectsOverlap(rect, c.rect)))
      .sort((a, b) => rectArea(b) - rectArea(a));
    // 限量截断必须可见：只播报「识别 2 处」而不说还有候选被上限挡在外面，等于把覆盖不全伪装成覆盖完整。
    if (outlined.length > MAX_OUTLINED)
      warnings.push("疑似转曲区域 " + outlined.length + " 处超过上限，仅识别面积最大的 " + MAX_OUTLINED + " 处");
    for (const rect of outlined.slice(0, MAX_OUTLINED))
      candidates.push({type: "outlined", rank: 2, reason: "矢量密集区域疑似转曲文字", rect});
    const merged = [];
    for (const candidate of candidates) {
      const hit = merged.find(m => rectsOverlap(m.rect, candidate.rect));
      if (hit) {
        hit.rect = unionRect(hit.rect, candidate.rect);
        if (candidate.rank < hit.rank) { hit.rank = candidate.rank; hit.type = candidate.type; hit.reason = candidate.reason; }
      } else merged.push({...candidate});
    }
    merged.sort((a, b) => a.rank - b.rank || rectArea(b.rect) - rectArea(a.rect));
    const regions = merged.slice(0, MAX_REGIONS).map(({type, reason, rect}) => ({type, reason, rect}));
    if (merged.length > regions.length)
      warnings.push("候选区域 " + merged.length + " 处超过上限，仅识别优先级最高的 " + regions.length + " 处");
    return {regions, warnings};
  }
  /**
   * P4-C 合并：原生块与区域 OCR 块几何去重，避免同一文字重复显示或重复翻译。
   * OCR 块被可靠原生块覆盖 ≥60% 判为隐藏文字层重复而丢弃；OCR 块相互重叠保留置信度高者；
   * 乱码原生块仅在与存活 OCR 块相交时被替换移除，无识别结果时保留占位提示。
   * order 按合并后阅读顺序重排；返回 source:"mixed" 的新模型与统计。
   */
  function merge(model, ocrModel) {
    const reliable = model.blocks.filter(b => b.reliable && b.eligible).map(b => b.rect);
    const kept = [];
    let deduped = 0;
    for (const block of ocrModel.blocks) {
      const area = rectArea(block.rect);
      const covered = reliable.reduce((sum, r) => sum + intersectArea(r, block.rect), 0);
      if (area > 0 && covered / area >= DEDUP_CONTAIN) { deduped++; continue; }
      const rival = kept.find(k => intersectArea(k.rect, block.rect) /
        Math.max(1, Math.min(rectArea(k.rect), area)) >= DEDUP_CONTAIN);
      if (rival) {
        deduped++;
        if ((block.confidence || 0) > (rival.confidence || 0)) kept[kept.indexOf(rival)] = block;
        continue;
      }
      kept.push(block);
    }
    const native = [];
    let replaced = 0;
    for (const block of model.blocks) {
      if (garbledBlock(block) && kept.some(k => rectsOverlap(k.rect, block.rect))) { replaced++; continue; }
      native.push(block);
    }
    const blocks = readingOrder([...native, ...kept]).map((block, order) => ({...block, order}));
    return {...model, blocks, empty: !blocks.length, unreliable: blocks.filter(b => !b.reliable).length,
      source: "mixed", engine: ocrModel.engine, engineVersion: ocrModel.engineVersion, modelVersion: ocrModel.modelVersion,
      stats: {native: native.length, ocr: kept.length, deduped, replaced}};
  }
  global.BT_PDF_BLOCKS = {process, classifyPage, processOcr, planOCR, merge,
    // 会话层的方向重试以送翻阈值为唯一判据，故把常量导出，避免与 OCR_HIGH/OCR_LOW 漂移。
    thresholds: {ocrHigh: OCR_HIGH, ocrLow: OCR_LOW},
    matrix: {compose: transform, invert, apply: applyPoint}};
})(window);
