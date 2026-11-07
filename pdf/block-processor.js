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
    if(!/[\p{L}]/u.test(text))return /[\d=≠≤≥∑∫√±×÷^]/u.test(text);
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
      const top=[matrix[4]+vertical[0]*height*ascent,matrix[5]+vertical[1]*height*ascent];
      // viewport 已包含 Y 轴翻转；字体上行方向沿矩阵第二列。
      const quad=[top,[top[0]+unit[0]*width,top[1]+unit[1]*width],
        [top[0]+unit[0]*width-vertical[0]*height,top[1]+unit[1]*width-vertical[1]*height],
        [top[0]-vertical[0]*height,top[1]-vertical[1]*height]];
      const rect=rectOf(quad),key=item.str+":"+Math.round(rect.x)+":"+Math.round(rect.y);
      if(seen.has(key))continue;seen.add(key);
      const reason=quality(item.str)||((item.dir==="ttb"||Math.abs(unit[1])>0.15||unit[0]<0)?"旋转或竖排阅读顺序暂不能确认":"");
      fragments.push({text:item.str,index,rect,height,baseline:matrix[5],direction:item.dir==="rtl"?"rtl":"ltr",
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
        lines.push({text,segments,rect,height:median(group.map(f=>f.height)),indices:group.map(f=>f.index),direction:rtl?"rtl":"ltr",
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
        parent.rect={x:Math.min(parent.rect.x,line.rect.x),y:Math.min(parent.rect.y,line.rect.y),right:Math.max(parent.rect.right,line.rect.right),bottom:Math.max(parent.rect.bottom,line.rect.bottom)};
      }else paragraphs.push({...line,role,lines:[line],segments:[...line.segments]});
    }
    const blocks=readingOrder(paragraphs).map((block,order)=>({...block,id:page.pageNumber+":"+order+":"+block.lines.flatMap(l=>l.indices).join("-"),
      order,source:"native",quad:[[block.rect.x,block.rect.y],[block.rect.right,block.rect.y],[block.rect.right,block.rect.bottom],[block.rect.x,block.rect.bottom]],
      quality:{text:block.reason?"uncertain":"reliable",order:block.reason?"uncertain":"reliable",reasons:block.reason?[block.reason]:[]},
      placement:{mode:"text-only",reasons:["P2 基础段落对照"]},
      reliable:!block.reason,eligible:!block.reason&&block.role==="text",
      reason:block.reason||(block.role!=="text"?"保留代码、公式或标识符":"")}));
    return {pageNumber:page.pageNumber,width:page.width,height:page.height,blocks,
      empty:!blocks.length,unreliable:blocks.filter(b=>!b.reliable).length};
  }
  global.BT_PDF_BLOCKS = {process};
})(window);
