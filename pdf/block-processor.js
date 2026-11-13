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
    // 行号仅参与语法辨认时跳过；原始字符、坐标和锚点不移除。
    const value=text.replace(/^\s*\d+\s+(?=\S)/u,"");
    return /^\s*[%$]?[A-Za-z_]\w*\s*:=\s*\S/u.test(value)||assembly(value,mono)>=2||/^\s*(?:#include\b|(?:const|let|var|def|function|class|return|import)\s+|(?:for|if|while)\s*\()/u.test(value) ||
      (mono && /[{};=]|=>|\+\+|\b(?:true|false|null)\b/.test(value)) ||
      (/[{}]/.test(value)&&/[:;=]/.test(value));
  }
  // 注释符只在对应代码语法、且不在字符串内部时成立；网址和汇编立即数不按注释拆开。
  function commentAt(text,family) {
    let quote="",escaped=false;
    for(let i=0;i<text.length;i++){
      const ch=text[i];
      if(quote){if(escaped)escaped=false;else if(ch==="\\")escaped=true;else if(ch===quote)quote="";continue;}
      if(ch==='"'||ch==="'"||ch==='`'){quote=ch;continue;}
      if(family!=="python"&&text.startsWith("//",i)&&text[i-1]!==":")return i;
      if(family==="python"&&ch==="#")return i;
      if(family==="asm"&&ch===";")return i;
    }
    return -1;
  }
  function assembly(text,mono) {
    const at=commentAt(text,"asm"),value=(at<0?text:text.slice(0,at)).trim();
    if(value==="...")return mono?1:0;
    if(/^[.$A-Za-z_][\w.$]*:$/u.test(value))return /[._\d]/u.test(value.slice(0,-1))?2:mono?1:0;
    const match=value.match(/^([A-Za-z][\w.]*)\s*(.*)$/u);if(!match)return 0;
    const known=/^(?:mov(?:sx|zx|s|q|l|w|b)?|lea|ld[rbhw]?|lw|sw|str[bh]?|st|push|pop|add|sub|mul|imul|div|idiv|and|or|xor|not|neg|inc|dec|shl|shr|sar|cmp|test|guard|j[a-z]+|b(?:l|ne|eq)?|call|ret|nop)$/i.test(match[1]);
    if(!known&&!mono)return 0;
    const operands=match[2].trim();if(!operands)return known?(mono&&/^(?:ret|nop)$/iu.test(match[1])?2:1):0;
    // 每个操作数只接受标识符、数值、内存寻址及大小限定，拒绝把普通英文句子当指令。
    const atom=/^(?:(?:byte|word|dword|qword|ptr|offset)\s+)*(?:[%$#]?(?:[A-Za-z_.$][\w.$@]*|(?:0x[\da-f]+|[+-]?\d+))(?:(?:\([\w.%+*\-\s,]+\)|\[[\w.$%+*\-\s]+\]))?|\[[\w.$%+*\-\s]+\])$/iu;
    const parts=[];let start=0,depth=0;
    for(let i=0;i<operands.length;i++){
      if("([".includes(operands[i]))depth++;else if(")]".includes(operands[i]))depth--;
      else if(operands[i]===","&&depth===0){parts.push(operands.slice(start,i));start=i+1;}
      if(depth<0)return 0;
    }
    parts.push(operands.slice(start));
    if(depth!==0||!parts.every(part=>atom.test(part.trim())||/^[+-]?\d*\([\w.%+*\-\s,]+\)$/u.test(part.trim())))return 0;
    const register=/(?:^|[^\w])(?:[er]?(?:ax|bx|cx|dx|si|di|bp|sp)|[xyz]mm\d+|r\d+[dwb]?|[xwvsdq]\d+|pc|lr|ra|zero)(?:$|[^\w])/iu.test(operands);
    return register||mono&&known&&/^[+-]?\d+$/u.test(operands)||/[\[\]()]|\b0x[\da-f]+\b|[_.$%#]|\b(?:true|false|null)\b/iu.test(operands)?2:known?1:0;
  }
  function commentSegments(text) {
    const parts=[];
    for(const segment of splitProtected(text)){
      if(segment.protected){parts.push(segment);continue;}
      let offset=0;
      for(const match of segment.text.matchAll(/^\s*(?:\/\/|#|;)\s*|\b0x[\da-f]+\b|\b[A-Za-z_$][\w$]*(?:[._:][\w$]+)+\b|\b[A-Za-z_$][\w$]*(?=\s*\()/giu)){
        if(match.index>offset)parts.push({text:segment.text.slice(offset,match.index)});
        parts.push({text:match[0],protected:true});offset=match.index+match[0].length;
      }
      if(offset<segment.text.length)parts.push({text:segment.text.slice(offset)});
    }
    return parts;
  }
  /** 在普通段落拼接前保护代码。只在原生 textItem 边界拆注释，不猜字符在 PDF 中的位置。 */
  function annotateCode(rows,page) {
    const chunks=[];
    for(const row of rows){
      let group=[];
      const flush=()=>{
        if(!group.length)return;
        let text="";const spans=[];
        for(const f of group){const previous=spans.at(-1)?.fragment;if(previous)text+=separator(previous.text,f.text,f.rect.x-previous.rect.right,f.height);
          const start=text.length;text+=f.text;spans.push({fragment:f,start,end:text.length});}
        const syntax=text.replace(/^\s*\d+\s+(?=\S)/u,""),mono=group.every(f=>f.mono),asm=assembly(syntax,mono),leading=/^\s*(?:\/\/|#(?!include\b)|;)/u.test(syntax);
        const python=/^\s*(?:def\s|class\s|from\s+\S+\s+import\b|(?:if|for|while)\s+.+:\s*$)/u.test(syntax);
        chunks.push({text,spans,mono,row,rect:rectOf(group.flatMap(f=>[[f.rect.x,f.rect.y],[f.rect.right,f.rect.bottom]])),height:median(group.map(f=>f.height)),
          family:asm?"asm":python?"python":"clike",rank:leading?0:asm||((python||code(text,mono))?2:0),font:group[0].fontName,cell:group[0].cell?.id,priorFlow:group[0].flow?.id});group=[];
      };
      for(const f of [...row.fragments].sort((a,b)=>a.rect.x-b.rect.x)){
        if(f.reason||f.flow?.type==="figure"){flush();continue;}
        const prev=group.at(-1);
        if(prev&&(f.columnBreakBefore||prev.cell?.id!==f.cell?.id||prev.flow?.id!==f.flow?.id||prev.mono!==f.mono||f.rect.x-prev.rect.right>Math.max(f.height,prev.height)*1.8))flush();
        group.push(f);
      }
      flush();
    }
    // PDF 常把指令和操作数拆成不同文字项/制表列；先用完整语法确认，不能把操作数漏成正文。
    for(let i=0;i<chunks.length-1;i++){
      const c=chunks[i],next=chunks[i+1];
      if(c.rank===1&&c.family==="asm"&&/^\s*[A-Za-z]+\s*$/u.test(c.text)&&c.row===next.row&&c.cell===next.cell&&c.priorFlow===next.priorFlow&&
        c.font===next.font&&assembly(c.text+" "+next.text,c.mono)>=2){c.rank=2;next.rank=0;}
    }
    // 行号列可为深层缩进提供共同左边界；必须有相邻行的对齐证据，不能仅凭孤立数字扩展代码范围。
    const numbers=chunks.filter(c=>/^\s*\d+\s*$/u.test(c.text)).sort((a,b)=>a.rect.y-b.rect.y),numbersByRow=new Map(),alignedNumbers=new Set();
    for(let i=0;i<numbers.length;i++){
      const n=numbers[i];if(!numbersByRow.has(n.row))numbersByRow.set(n.row,[]);numbersByRow.get(n.row).push(n);
      for(const other of numbers.slice(Math.max(0,i-64),i))if(other.row!==n.row&&other.cell===n.cell&&other.priorFlow===n.priorFlow&&
        Math.abs(other.rect.x-n.rect.x)<=Math.max(n.height,other.height)*.5&&Math.abs(other.rect.y-n.rect.y)<=Math.max(n.height,other.height)*3){
        alignedNumbers.add(n);alignedNumbers.add(other);
      }
    }
    for(const c of chunks.filter(c=>c.rank>0&&c.mono)){
      c.gutter=(numbersByRow.get(c.row)||[]).filter(n=>alignedNumbers.has(n)&&n.cell===c.cell&&n.priorFlow===c.priorFlow&&n.rect.right<=c.rect.x&&
        c.rect.x-n.rect.right<=Math.max(n.height,c.height)*8)
        .sort((a,b)=>b.rect.right-a.rect.right)[0];
    }
    // 同一清单的嵌套缩进可能超过两个字高；用横向交叠或已确认行号列连接，不能跨到另一栏。
    const near=(a,b)=>(a.font===b.font||a.mono&&b.mono)&&a.cell===b.cell&&a.priorFlow===b.priorFlow&&
      (Math.abs(a.rect.x-b.rect.x)<=Math.max(a.height,b.height)*2||Math.min(a.rect.right,b.rect.right)-Math.max(a.rect.x,b.rect.x)>=Math.max(a.height,b.height)||
        a.gutter&&b.gutter&&Math.abs(a.gutter.rect.x-b.gutter.rect.x)<=Math.max(a.height,b.height)*.5)&&
      Math.abs(a.rect.y-b.rect.y)<=Math.max(a.height,b.height)*3;
    for(const chunk of chunks)chunk.active=chunk.rank>=2;
    // 无操作数指令和简单标签必须邻接已确认代码，单独的英文单词不触发保护。
    for(const ordered of [chunks,[...chunks].reverse()])for(let i=0;i<ordered.length;i++){
      const c=ordered[i];if(c.rank!==1||c.active)continue;
      if(ordered.slice(Math.max(0,i-64),i).some(p=>p.active&&near(c,p)))c.active=true;
    }
    const groups=[];
    for(let i=0;i<chunks.length;i++){
      const c=chunks[i];if(!c.active)continue;
      const previous=chunks.slice(Math.max(0,i-64),i).reverse().find(p=>p.active&&near(c,p));
      c.owner=previous?.owner||{id:page.pageNumber+":code:"+c.spans[0].fragment.index,members:[]};
      if(!previous)groups.push(c.owner);c.owner.members.push(c);
      const at=commentAt(c.text,c.family),boundary=at>=0?c.spans.findIndex(span=>span.start<=at&&span.end>at):-1;
      const safe=boundary>=0&&!c.spans[boundary].fragment.text.slice(0,at-c.spans[boundary].start).trim();
      c.assign=c.spans.map((span,index)=>({fragment:span.fragment,side:safe&&index>=boundary?"comment":"code"}));
      if(at>=0&&!safe)c.mixed=true;
    }
    const codeByRow=new Map();
    for(const c of chunks.filter(c=>c.active)){if(!codeByRow.has(c.row))codeByRow.set(c.row,[]);codeByRow.get(c.row).push(c);}
    for(const c of chunks.filter(c=>!c.active)){
      // 单独的行号只有紧邻同一基线上的已确认指令才归入代码，不按数字内容猜测正文性质。
      if(/^\s*\d+\s*$/u.test(c.text)){
        const right=(codeByRow.get(c.row)||[]).filter(p=>p.cell===c.cell&&p.priorFlow===c.priorFlow&&p.rect.x>=c.rect.right&&
          (p.gutter===c||p.rect.x-c.rect.right<=Math.max(p.height,c.height)*2)).sort((a,b)=>a.rect.x-b.rect.x)[0];
        if(right){c.owner=right.owner;c.paired=right;c.owner.members.push(c);c.assign=c.spans.map(span=>({fragment:span.fragment,side:"code"}));continue;}
      }
      const left=(codeByRow.get(c.row)||[]).filter(p=>p.cell===c.cell&&p.priorFlow===c.priorFlow&&p.rect.right<=c.rect.x).sort((a,b)=>b.rect.right-a.rect.right)[0];
      if(!left)continue;
      const comment=commentAt(c.text,left.family)===c.text.search(/\S/u);
      const continuation=left.font===c.font&&(left.family==="asm"&&assembly(left.text+" "+c.text,left.mono)>=2||/^\s*(?:#|\/\/|;)/u.test(c.text));
      if(!comment&&!continuation)continue;
      c.owner=left.owner;c.paired=left;c.mixed=!comment&&commentAt(c.text,left.family)>=0;
      c.owner.members.push(c);c.assign=c.spans.map(span=>({fragment:span.fragment,side:comment?"comment":"code"}));
    }
    // 独立注释行也属于相邻代码区域，不能与后面的正文或其他注释拼成长段。
    for(let i=0;i<chunks.length;i++){
      const c=chunks[i];if(c.active||c.owner||!/^\s*(?:\/\/|#|;)/u.test(c.text))continue;
      const adjacent=chunks.slice(Math.max(0,i-64),i+65).filter(p=>p.active&&near(c,p)&&commentAt(c.text,p.family)===c.text.search(/\S/u))
        .sort((a,b)=>Math.abs(a.rect.y-c.rect.y)-Math.abs(b.rect.y-c.rect.y))[0];
      if(!adjacent)continue;
      c.owner=adjacent.owner;c.owner.members.push(c);c.assign=c.spans.map(span=>({fragment:span.fragment,side:"comment"}));
    }
    for(const group of groups){
      const rect=rectOf(group.members.flatMap(c=>c.spans.flatMap(({fragment:f})=>[[f.rect.x,f.rect.y],[f.rect.right,Math.max(f.rect.bottom,f.inkBottom)]])));
      const flow={id:group.id,type:"code",rect,sourceRect:{...rect}};
      // 一条原生基线就是一行；行号、指令和操作数即使分属不同 textItem 也不能拆成多行。
      const lines=[...new Set(group.members.map(c=>c.row))].sort((a,b)=>a.baseline-b.baseline);
      const lineNumbers=new Map(lines.map((line,index)=>[line,index]));
      for(const c of group.members)for(const {fragment:f,side} of c.assign){
        f.codeRole=side;f.codeMixed=!!c.mixed;
        // 表格和已有图形关系优先；新增关系只组织普通代码清单。
        if(!f.table&&!f.flow)f.flow={...flow,column:0,part:group.id+":"+lineNumbers.get(c.row),line:lineNumbers.get(c.row)};
      }
    }
  }
  function formula(text) {
    // 片段级保护只认含运算符的真公式：裸数字（年份、统计值）不再加保护标记，
    // 避免密集标记放大服务漏译时的整块失败；纯数字行仍由 role 判定（无字母）归为 formula 跳过。
    if(!/[\p{L}]/u.test(text))return /[=≠≤≥∑∫√±×÷^]/u.test(text);
    if(text.length>200||!/[=≠≤≥∑∫√±×÷^]/u.test(text))return false;
    const words=text.match(/\p{L}+/gu)||[];
    return words.every(word=>Array.from(word).length<=2||/^(?:sin|cos|tan|log|ln|exp|max|min)$/i.test(word));
  }
  // 数字、脚注和符号无需翻译，但不是公式；原生与 OCR 共用同一分类。
  function roleOf(text,mono=false) {
    if(code(text,mono))return "code";
    if(formula(text))return "formula";
    if(!/\p{L}/u.test(text))return /\p{N}/u.test(text)?"number":"symbol";
    if(/^(?:doi:\s*)?10\.\d{4,9}\/\S+$/iu.test(text.trim()))return "identifier";
    if(/^[A-Za-z_]\w*(?:[._:][A-Za-z_]\w*)+$/u.test(text.trim()))return "identifier";
    if(/^[+-]?\d+(?:[.,]\d+)?(?:e[+-]?\d+)?\s*(?:%|[munpkMGTµμ]?(?:s|m|g|Hz|B|b|W|V|A|Pa|K)|°[CF])$/u.test(text.trim()))return "measurement";
    return text.trim().split(/\s+/u).every(part=>/^(?:https?:\/\/|www\.)\S+$/.test(part)||/^[\w.+-]+@[\w.-]+$/.test(part))?"identifier":"text";
  }
  const protectedReason=role=>role==="number"?"数字或引用编号保持原样":role==="symbol"?"符号保持原样":role==="code"?"代码保持原样":role==="formula"?"公式保持原样":
    role==="author"?"作者姓名与标记保持原样":role==="affiliation"?"作者机构保持原样":role==="measurement"?"数值与单位保持原样":"链接或标识符保持原样";
  function splitProtected(text, protect=false) {
    if(protect)return [{text,protected:true}];
    const parts=[];let offset=0;
    for(const match of text.matchAll(/(?:https?:\/\/|www\.)[^\s<>]+|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|(?:doi:\s*)?10\.\d{4,9}\/[^\s<>]+|\[\d+(?:\s*[-,]\s*\d+)*\]|`[^`\n]+`/giu)){
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
  // 在拼行前辨认局部重复的栏间留白。只标记原生项之间的真实间隙，
  // 不切开 textItem，也不把页眉跨栏、单个大空格或已有表格关系当成新栏。
  function markColumnBreaks(rows) {
    const gaps=rows.map(row=>{
      const fragments=[...row.fragments].sort((a,b)=>a.rect.x-b.rect.x),out=[];
      for(let i=1;i<fragments.length;i++){
        const left=fragments[i-1],right=fragments[i],em=Math.max(left.height,right.height);
        if(left.reason||right.reason||left.table||right.table||left.flow||right.flow)continue;
        if(right.rect.x-left.rect.right>=em*.75)out.push({start:left.rect.right,end:right.rect.x,right,em});
      }
      return out;
    });
    for(let i=0;i<rows.length;i++)for(const gap of gaps[i]){
      const cut=(gap.start+gap.end)/2,support=[];
      for(let j=Math.max(0,i-8);j<Math.min(rows.length,i+9);j++){
        if(Math.abs(rows[j].baseline-rows[i].baseline)>gap.em*8)continue;
        const other=gaps[j].find(g=>g.start<=cut&&g.end>=cut);
        if(other)support.push({gap:other,y:rows[j].baseline});
      }
      if(support.length>=3&&Math.max(...support.map(s=>s.y))-Math.min(...support.map(s=>s.y))>=gap.em*2)
        for(const item of support)item.gap.right.columnBreakBefore=true;
    }
  }
  /** XY 空白切分：先分栏，再按全宽标题等水平区域分层；不跨栏逐行拼句。 */
  function readingOrder(blocks, depth=0) {
    if(blocks.length<2||depth>16)return [...blocks].sort((a,b)=>a.rect.y-b.rect.y||a.rect.x-b.rect.x);
    const height=median(blocks.map(b=>b.height));
    for(const [start,end,minimum] of [["x","right",height*.75],["y","bottom",height]]){
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
  function process(page,probe) {
    if(page.items.length>MAX_ITEMS)throw global.BT_PDF_ERRORS.create("TEXT_BUDGET", "本页文字项过多，暂不自动翻译", "extract",false);
    let chars=0;const fragments=[],seen=new Set(),damagedFonts=new Set();
    const tags=new Map();
    for(const tag of page.structure?.tags||[]){const prior=tags.get(tag.id);tags.set(tag.id,prior&&prior.group!==tag.group?{conflict:true}:tag);}
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
      const encoding=quality(item.str);if(encoding)damagedFonts.add(item.fontName);
      const reason=encoding||((item.dir==="ttb"||Math.abs(unit[1])>0.15||unit[0]<0)?"旋转或竖排阅读顺序暂不能确认":"");
      const tagged=(item.markedIds||[]).map(id=>tags.get(id)).filter(tag=>tag&&!tag.conflict),tag=tagged.at(-1);
      fragments.push({text:item.str,index,rect,height,baseline:matrix[5],inkBottom,tag,direction:item.dir==="rtl"?"rtl":"ltr",
        fontName:item.fontName,fontFamily:style.fontFamily||"",
        mono:/mono|courier|console/i.test(style.fontFamily||""),reason,hasEOL:item.hasEOL});
    }
    // 同一字体映射已出现损坏时，其他碰巧落入合法 Unicode 的片段也不能视为可靠。
    // 仅在当前页、当前字体内传播证据；不凭“像哪种语言”猜测，也不影响其他正常字体。
    for(const fragment of fragments)if(!fragment.reason&&damagedFonts.has(fragment.fontName))fragment.reason="同字体文字映射不能可靠确认";
    const structure=global.BT_PDF_READING_STRUCTURE;
    const tables=structure?structure.detect(fragments,probe?.rules,page.pageNumber):[];
    for(const fragment of fragments)structure?.assign(fragment,tables);
    structure?.contributors(fragments,page.pageNumber);
    const figures=structure?.figures(fragments,probe,tables,page.pageNumber)||[];
    const em=median(fragments.map(f=>f.height));
    const contains=(outer,inner)=>inner.x>=outer.x&&inner.y>=outer.y&&inner.right<=outer.right&&inner.bottom<=outer.bottom;
    // 不能重建的图片/大绘图不静默丢失：结构化导出保留对应源页，不把它们猜成表格或流程图。
    const graphics=[...(probe?.images||[]).map(image=>image.rect),...(probe?.vectorRects||[])
      .filter(rect=>(rect.right-rect.x)*(rect.bottom-rect.y)>=em*em*4)];
    const inline=structure?.inlineFragments(fragments)||{complete:false,groups:0};
    const rows=[];
    for(const fragment of fragments.sort((a,b)=>(a.rowBaseline??a.baseline)-(b.rowBaseline??b.baseline)||a.rect.x-b.rect.x)){
      const row=rows[rows.length-1],baseline=fragment.rowBaseline??fragment.baseline;
      if(row&&Math.abs(row.baseline-baseline)<=Math.max(2,Math.min(row.height,fragment.height)*0.3))row.fragments.push(fragment);
      else rows.push({baseline,height:fragment.height,fragments:[fragment]});
    }
    const lines=[];
    markColumnBreaks(rows);
    annotateCode(rows,page);
    global.BT_PDF_TOC?.annotate(rows,page);
    const byIndex=new Map(fragments.map(fragment=>[fragment.index,fragment]));
    for(const fragment of fragments)if(fragment.inlineOwner!==undefined){
      const owner=byIndex.get(fragment.inlineOwner);
      if(owner){fragment.codeRole=owner.codeRole;fragment.flow=owner.flow;fragment.columnBreakBefore=false;}
    }
    const fontWeights=new Map();
    for(const f of fragments)if(!f.reason&&!f.flow&&!f.table&&!f.mono&&f.text.length>=20)
      fontWeights.set(f.fontName,(fontWeights.get(f.fontName)||0)+f.text.length);
    const bodyFont=[...fontWeights].sort((a,b)=>b[1]-a[1])[0]?.[0];
    for(const row of rows){
      let group=[];
      const flush=()=>{
        if(!group.length)return;
        const directional=group.filter(f=>/\p{L}/u.test(f.text));
        const directions=new Set(directional.map(f=>f.direction)),rtl=directions.size===1&&directions.has("rtl");
        const ordered=rtl?[...group].reverse():group;
        const segments=[],runs=[];let previous=null,offset=0;
        const append=part=>{segments.push(part);offset+=part.text.length;};
        const attached=new Set(ordered.filter(f=>f.inlineOwner!==undefined).map(f=>f.inlineOwner));
        for(const f of ordered){
          const gap=previous?(rtl?previous.rect.x-f.rect.right:f.rect.x-previous.rect.right):0;
          if(previous){const join=f.inlineOwner===previous.index||f.inlineOwner!==undefined&&f.inlineOwner===previous.inlineOwner?"":separator(previous.text,f.text,gap,f.height);if(join)append({text:join});}
          const owner=ordered.find(item=>item.index===f.inlineOwner),shift=owner?f.baseline-owner.baseline:0;
          const run={text:f.text,start:offset,end:offset+f.text.length,height:f.height,shift,fontName:f.fontName,fontFamily:f.fontFamily,index:f.index};
          runs.push(run);
          if(f.inlineOwner!==undefined){
            const last=segments.at(-1);
            // 空连接符不打断原子；短变量和附标共用一个保护标记，翻译服务不能拆散 T 与下标。
            const target=last;
            if(target?.inlineHost===f.inlineOwner){target.text+=f.text;target.runs.push({...run,start:undefined,end:undefined});offset+=f.text.length;}
            else append({text:f.text,protected:true,runs:[{...run,start:undefined,end:undefined}],attachPrevious:true});
          }else if(f.codeRole==="comment")for(const part of commentSegments(f.text))append(part);
          else{
            const protect=f.codeRole==="code"||!!f.contributorRole||/^[®©™†‡*#+\s]+$/u.test(f.text)||code(f.text,f.mono)||formula(f.text);
            const tail=attached.has(f.index)&&!protect?f.text.match(/[\p{L}\p{N}\p{M}_]+$/u):null;
            // 只把独立的短变量并入原子，不把自然语言单词或整句错误地保护起来。
            const atomic=tail&&/^\p{L}\p{M}*[\p{N}_]*$/u.test(tail[0])&&(tail.index===0||/[\s([{]$/u.test(f.text.slice(0,tail.index)));
            if(atomic){
              for(const part of splitProtected(f.text.slice(0,tail.index)))append(part);
              append({text:tail[0],protected:true,inlineHost:f.index,runs:[{...run,text:tail[0],start:undefined,end:undefined,shift:0}]});
            }else for(const part of splitProtected(f.text,protect))append(part);
          }
          previous=f;
        }
        const toc=group[0].toc;
        let text=segments.map(p=>p.text).join("").trim();
        if(toc?.part==="title") {
          text=toc.rowTitle;const prefix=text.match(/^(\s*(?:\d+(?:\.\d+)*[.)、．]?|[IVXLCDM]+[.)、．])\s+)/u);
          segments.splice(0,segments.length,...(prefix?[{text:prefix[0],protected:true},{text:text.slice(prefix[0].length)}]:[{text}]));runs.splice(0,runs.length);
        }
        const rect=rectOf(group.flatMap(f=>[[f.rect.x,f.rect.y],[f.rect.right,f.rect.bottom]]));
        const base=group.filter(f=>f.inlineOwner===undefined),dominant=[...base].sort((a,b)=>b.text.length-a.text.length)[0]||group[0];
        const tagged=base.filter(f=>f.tag),tag=base.length&&tagged.length===base.length&&tagged.every(f=>f.tag.group===tagged[0].tag.group)?tagged[0].tag:null;
        lines.push({text,segments,runs,rect,tag,toc,inlineUncertain:group.some(f=>f.inlineUncertain),table:group[0].table,cell:group[0].cell,flow:group[0].flow,runInBody:group[0].runInBody,contributorRole:group.find(f=>f.contributorRole)?.contributorRole,
          fontName:dominant.fontName,fontFamily:dominant.fontFamily,
          height:median(base.map(f=>f.height)),inkBottom:Math.max(...group.map(f=>f.inkBottom)),indices:group.map(f=>f.index),anchorIndices:group.filter(f=>f.inlineOwner===undefined).map(f=>f.index),direction:rtl?"rtl":"ltr",
          codeRole:group[0].codeRole,codeMixed:group.some(f=>f.codeMixed),
          reason:group.find(f=>f.reason)?.reason||(directions.size>1?"双向混排顺序需人工确认":""),
          mono:group.every(f=>f.mono)});
        group=[];
      };
      for(const fragment of row.fragments.sort((a,b)=>a.rect.x-b.rect.x)){
        const previous=group[group.length-1];
        // 行首短语与后文在原生字体项边界发生样式转换，且有句点/冒号：保留行内小标题身份。
        // 不切开 textItem，不根据译文长度反推标题结束位置。
        const prefix=group.map(f=>f.text).join("").trim();
        const headingPrefix=previous&&!fragment.flow&&!fragment.table&&!fragment.codeRole&&/^\d+(?:\.\d+)*\.?$/u.test(prefix)&&
          fragment.fontName===previous.fontName&&(previous.height>em*1.12||bodyFont&&previous.fontName!==bodyFont)&&
          Math.abs(fragment.baseline-previous.baseline)<previous.height*.2&&fragment.rect.x-previous.rect.right<=previous.height*3;
        if(previous&&!fragment.toc&&bodyFont&&fragment.fontName===bodyFont&&previous.fontName!==bodyFont&&!fragment.flow&&!fragment.table&&!fragment.codeRole&&!fragment.reason&&
          group.every(f=>f.fontName===previous.fontName&&!f.reason)&&group.length&&prefix.length<=80&&
          /\p{L}.*[.:：]$/u.test(prefix)&&!/^\d+[.)]$/u.test(prefix)&&/^[\s\p{L}]/u.test(fragment.text)&&
          !fragment.columnBreakBefore&&Math.abs(fragment.baseline-previous.baseline)<previous.height*.2&&fragment.rect.x-previous.rect.right>=-previous.height*.1&&fragment.rect.x-previous.rect.right<previous.height){
          flush();const heading=lines.at(-1);Object.assign(heading,{kind:"subheading",headingLevel:2,headingEvidence:"run-in-style",runIn:true});fragment.runInBody={x:heading.rect.x};
        }
        if(previous&&(fragment.toc?.id!==previous.toc?.id||fragment.toc?.part!==previous.toc?.part||!fragment.toc&&(fragment.columnBreakBefore&&!headingPrefix||fragment.tag&&previous.tag&&fragment.tag.group!==previous.tag.group||fragment.codeRole!==previous.codeRole||fragment.cell?.id!==previous.cell?.id||fragment.flow?.id!==previous.flow?.id||fragment.flow?.column!==previous.flow?.column||
          fragment.flow?.part!==previous.flow?.part||fragment.flow?.caption!==previous.flow?.caption||!headingPrefix&&fragment.rect.x-previous.rect.right>Math.max(fragment.height,previous.height)*1.8 ||
          (fragment.inlineOwner===undefined&&previous.inlineOwner===undefined&&Math.min(fragment.height,previous.height)/Math.max(fragment.height,previous.height)<0.7))))flush();
        group.push(fragment);
      }
      flush();
    }
    structure?.annotateLines(lines,page);
    const paragraphs=[];
    for(const line of lines.sort((a,b)=>a.rect.y-b.rect.y||a.rect.x-b.rect.x)){
      const role=line.toc?.part==="title"?"text":line.tag?.role==="Formula"?"formula":line.tag?.role==="Code"?"code":line.codeRole==="code"?"code":line.codeRole==="comment"?"text":line.contributorRole||roleOf(line.text,line.mono);
      line.isCaption=/^(?:fig(?:ure)?\.?|table|图|圖|表)\s*\d/iu.test(line.text);
      const startsStructure=!!line.toc||["heading","subheading"].includes(line.kind)||/^(?:(?:[-•◦]|\d+[.)])\s|(?:fig(?:ure)?\.?|table|图|圖|表)\s*\d)/iu.test(line.text);
      let parent=null;
      if(line.toc?.part==="title")parent=paragraphs.find(p=>p.toc?.id===line.toc.id&&p.toc.part==="title");
      if(!line.toc&&role==="text"&&["heading","subheading"].includes(line.kind)&&!line.runIn&&!/^\d+(?:\.\d+)*(?:\.|\s)/u.test(line.text)){
        parent=paragraphs.slice(-16).reverse().find(p=>p.kind===line.kind&&p.headingLevel===line.headingLevel&&!p.runIn&&!p.reason&&
          !p.flow&&!p.table&&(!p.tag||!line.tag||p.tag.group===line.tag.group)&&p.lines.length<3&&p.fontName===line.fontName&&p.direction===line.direction&&
          Math.min(p.height,line.height)/Math.max(p.height,line.height)>.9&&
          line.rect.y-p.rect.bottom>=-line.height*.2&&line.rect.y-p.rect.bottom<line.height*.7&&
          (Math.abs(p.rect.x-line.rect.x)<line.height*.5||Math.abs(p.rect.x+p.rect.right-line.rect.x-line.rect.right)<line.height));
      }
      if(role==="text"&&!line.reason&&!startsStructure){
        parent=paragraphs.slice(-128).reverse().find(p=>!p.toc&&p.role==="text"&&!p.reason&&!p.isCaption&&!["heading","subheading"].includes(p.kind)&&
          (!p.tag||!line.tag||p.tag.group===line.tag.group)&&p.codeRole===line.codeRole&&p.direction===line.direction&&p.cell?.id===line.cell?.id&&
          p.flow?.id===line.flow?.id&&p.flow?.column===line.flow?.column&&p.flow?.part===line.flow?.part&&p.flow?.caption===line.flow?.caption&&
          line.rect.y-p.rect.bottom>=-line.height*0.25&&line.rect.y-p.rect.bottom<line.height*0.9&&
          (Math.abs((line.direction==="rtl"?line.rect.right:line.rect.x)-(line.direction==="rtl"?p.rect.right:p.rect.x))<line.height*0.8||
            p.runInBody&&Math.abs(line.rect.x-p.runInBody.x)<line.height*.8||
            line.flow?.type==="figure"&&!!line.flow.part)&&
          Math.min(p.height,line.height)/Math.max(p.height,line.height)>0.8);
      }
      if(parent){
        const last=parent.segments.at(-1),hyphen=last&&!last.protected&&/[\p{Script=Latin}][\-\u00ad]$/u.test(parent.text)&&/^\p{Ll}/u.test(line.text);
        if(hyphen){parent.text=parent.text.slice(0,-1);last.text=last.text.replace(/[\-\u00ad]$/u,"");
          const run=parent.runs.at(-1);if(run)parent.runs[parent.runs.length-1]={...run,text:run.text.slice(0,-1),end:run.end-1};}
        const join=hyphen||/\p{Script=Han}$/u.test(parent.text)&&/^\p{Script=Han}/u.test(line.text)?"":" ";
        const runOffset=parent.text.length+join.length;
        parent.runs.push(...line.runs.map(run=>({...run,start:run.start+runOffset,end:run.end+runOffset})));
        parent.text+=join+line.text;parent.segments.push({text:join},...line.segments);parent.lines.push(line);
        parent.inkBottom=Math.max(parent.inkBottom,line.inkBottom);
        parent.inlineUncertain=parent.inlineUncertain||line.inlineUncertain;
        parent.rect={x:Math.min(parent.rect.x,line.rect.x),y:Math.min(parent.rect.y,line.rect.y),right:Math.max(parent.rect.right,line.rect.right),bottom:Math.max(parent.rect.bottom,line.rect.bottom)};
      }else paragraphs.push({...line,role,lines:[line],segments:[...line.segments],runs:[...line.runs]});
    }
    let blocks=readingOrder(paragraphs).map((block,order)=>({...block,id:page.pageNumber+":"+order+":"+block.lines.flatMap(l=>l.indices).join("-"),
      editAnchor:page.pageNumber+":native:"+block.lines.flatMap(l=>l.anchorIndices||l.indices).join("-"),
      order,source:"native",quad:[[block.rect.x,block.rect.y],[block.rect.right,block.rect.y],[block.rect.right,block.rect.bottom],[block.rect.x,block.rect.bottom]],
      quality:{text:block.reason?"uncertain":"reliable",order:block.reason?"uncertain":"reliable",reasons:block.reason?[block.reason]:[]},
      placement:{mode:"text-only",reasons:["P2 基础段落对照"]},
      reliable:!block.reason,eligible:!block.reason&&block.role==="text",
      reason:block.reason||(block.codeMixed?"代码与注释共用文字项，无法可靠分离；整行保留":block.role!=="text"?protectedReason(block.role):"")}));
    structure?.describe(blocks,page);
    for(const block of blocks)if(block.toc){
      block.kind=block.toc.part==="title"?"toc-entry":"literal";
      block.role=block.toc.part==="title"?"text":"symbol";
      block.eligible=block.toc.part==="title"&&!block.reason;
    }
    const visuals=structure?.visuals(blocks,probe,figures,tables,page)||[];
    // 保持既有段落 ID：视觉节点只参与排序，不作为新的翻译任务或译文数据源。
    const visualAtoms=visuals.filter(v=>!v.flow).map(v=>({id:v.id,visual:v,rect:v.rect,height:em,direction:"ltr"}));
    if(structure){
      const ordered=structure.order([...blocks,...visualAtoms],readingOrder);
      blocks=ordered.flatMap((block,order)=>{if(block.visual){block.visual.order=order;return [];}return [{...block,order}];});
      for(const visual of visuals.filter(v=>v.flow))visual.order=Math.min(...blocks.filter(b=>b.flow?.id===visual.id).map(b=>b.order));
    }
    for(const block of blocks)block.rawText=block.lines.map(line=>line.text).join("\n");
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
      tables,visuals,structure:{version:3,tagged:!!page.structure?.tags?.length,inline},retainSourceGraphics:graphics.some(rect=>!tables.some(table=>contains(table.rect,rect))&&!visuals.some(visual=>contains(visual.rect,rect))),
      empty:!blocks.length,unreliable:blocks.filter(b=>!b.reliable).length};
  }
  // P4-B OCR 置信度分层：≥75 可信赖（允许原位遮罩）；60–75 送翻但仅对照显示；<60 不自动送翻。
  const OCR_HIGH = 75, OCR_LOW = 60;
  /** 页面类型分类：可靠文字量、文字层可靠性与位图/文字/绘制算子数多信号联合判定，不用单一覆盖率阈值。 */
  function classifyPage(processed, probe) {
    // 无需翻译的代码、数字、标识符也能证明原生文字层可靠，不能因此整页改走 OCR。
    const reliable = processed.blocks.filter(b => b.reliable);
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
        layoutGroup:typeof line.layoutGroup==="string"?line.layoutGroup:"",
        regions: Number.isInteger(line.regionIndex) ? [line.regionIndex] : [],
        segments: splitProtected(text, code(text, false) || formula(text))});
    });
    const paragraphs = [];
    for (const line of lineModels.sort((a,b)=>a.rect.y-b.rect.y||a.rect.x-b.rect.x)) {
      const role = roleOf(line.text);
      let parent = null;
      if (role === "text") {
        parent = paragraphs.slice(-64).reverse().find(p => p.role === "text" &&p.regions.join(":")===line.regions.join(":")&&p.layoutGroup===line.layoutGroup&&
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
      const reason = confidence < OCR_LOW ? "OCR 置信度过低，未自动翻译"
        : confidence < OCR_HIGH ? "OCR 置信度中等，不做原位遮罩" : paragraph.role!=="text"?protectedReason(paragraph.role):"";
      return {id: pageNumber + ":ocr:" + order + ":" + paragraph.indices.join("-"), order, source: "ocr",
        text: paragraph.text, segments: paragraph.segments, lines: paragraph.lines, rect: paragraph.rect,
        height: paragraph.height, direction: "ltr", role: paragraph.role, mono: false, confidence,
        regions: [...new Set(paragraph.lines.flatMap(l => l.regions))].sort((a, b) => a - b),
        quad: [[paragraph.rect.x, paragraph.rect.y], [paragraph.rect.right, paragraph.rect.y],
          [paragraph.rect.right, paragraph.rect.bottom], [paragraph.rect.x, paragraph.rect.bottom]],
        quality: {text: confidence >= OCR_HIGH ? "reliable" : "uncertain", order: confidence >= OCR_HIGH ? "reliable" : "uncertain",
          reasons: reason && paragraph.role === "text" ? [reason] : []},
        placement: {mode: "text-only", reasons: ["P4-B OCR 段落对照"]},
        reliable: confidence >= OCR_HIGH,
        eligible: confidence >= OCR_LOW && paragraph.role === "text", reason};
    });
    global.BT_PDF_READING_STRUCTURE?.describe(blocks,{width,height,pageNumber});
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
    const reliable = model.blocks.filter(b => b.reliable).map(b => b.rect);
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
    const garbled = model.blocks.filter(garbledBlock).map(b => inflateRect(b.rect, Math.max(2,b.height*.35)));
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
    // 邮箱、数字、公式同样是可靠原生文字；不能因为无需翻译就再次混入 OCR 副本。
    const reliable = model.blocks.filter(b => b.reliable).map(b => b.rect);
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
    const structure=global.BT_PDF_READING_STRUCTURE;
    if(structure)for(const block of kept){
      structure.assign(block,model.tables||[]);
      if(!block.table){
        const owner=native.find(item=>item.flow?.type==="figure"&&block.rect.x>=item.flow.rect.x&&block.rect.right<=item.flow.rect.right&&
          block.rect.y>=item.flow.rect.y&&block.rect.bottom<=item.flow.rect.bottom);
        if(owner)block.flow={...owner.flow,caption:false,part:"ocr"};
      }
    }
    const ordered=structure?structure.order([...native,...kept],readingOrder):readingOrder([...native,...kept]);
    const blocks = ordered.map((block, order) => ({...block, order}));
    return {...model, blocks, empty: !blocks.length, unreliable: blocks.filter(b => !b.reliable).length,
      source: "mixed", engine: ocrModel.engine, engineVersion: ocrModel.engineVersion, modelVersion: ocrModel.modelVersion,
      stats: {native: native.length, ocr: kept.length, deduped, replaced}};
  }
  global.BT_PDF_BLOCKS = {process, classifyPage, processOcr, planOCR, merge,
    // 会话层的方向重试以送翻阈值为唯一判据，故把常量导出，避免与 OCR_HIGH/OCR_LOW 漂移。
    thresholds: {ocrHigh: OCR_HIGH, ocrLow: OCR_LOW},
    matrix: {compose: transform, invert, apply: applyPoint}};
})(window);
