(function(global) {
  "use strict";
  // 重排专用样式表：只读源结构，不把字体内部编号、译文长度或送翻进度当作排版样式。
  const VERSION=1,positive=n=>Number.isFinite(n)&&n>0;
  const clamp=(n,min,max)=>Math.max(min,Math.min(max,n));
  const median=values=>{const sorted=values.filter(positive).sort((a,b)=>a-b);return sorted[Math.floor(sorted.length/2)]||0;};
  const weighted=values=>{
    const sorted=values.filter(item=>positive(item.size)&&positive(item.weight)).sort((a,b)=>a.size-b.size);
    const total=sorted.reduce((sum,item)=>sum+item.weight,0);let sum=0;
    for(const item of sorted){sum+=item.weight;if(sum>=total/2)return item.size;}
    return 0;
  };
  const dominant=values=>{
    const groups=[];
    for(const entry of [...values].sort((a,b)=>a.size-b.size)){
      let group=groups.at(-1);
      if(!group||entry.size>group.min*1.15){group={min:entry.size,entries:[],weight:0};groups.push(group);}
      group.entries.push(entry);group.weight+=entry.weight;
    }
    groups.sort((a,b)=>b.weight-a.weight||a.min-b.min);
    return groups.length?weighted(groups[0].entries):0;
  };
  const nominal=item=>median((item.block.lines||[]).map(line=>line.height))||item.block.height;
  const sourceIndent=item=>{
    const lines=item.block.lines||[],rect=r=>r&&[r.x,r.y,r.right,r.bottom].every(Number.isFinite);
    if(lines.length<2||!lines.every(line=>rect(line.rect)))return 0;
    const size=nominal(item),offset=lines[0].rect.x-Math.min(...lines.slice(1).map(line=>line.rect.x));
    return offset>=size*.2&&offset<=size*3?offset/size:0;
  };
  function create({items,nodes=[]}) {
    const retainedIds=new Set(nodes.filter(node=>["contributors","figure","code","retained"].includes(node.kind))
      .flatMap(node=>node.items.map(item=>item.id)));
    const entries=items.filter(item=>positive(nominal(item))).map(item=>({item,size:nominal(item),
      weight:Math.max(1,Math.min(400,String(item.block.text||"").replace(/\s/gu,"").length))}));
    const ordinary=entry=>!entry.item.block.table&&!entry.item.block.flow&&!entry.item.block.visualId&&
      !retainedIds.has(entry.item.id)&&entry.item.block.role==="text"&&entry.item.block.reliable!==false;
    const paragraphs=entries.filter(entry=>ordinary(entry)&&!entry.item.block.mono&&["paragraph","list"].includes(entry.item.kind));
    // 正文证据不足时逐级回退；脚注、作者及大标题不能通过字符数量压过正文。
    const substantial=paragraphs.filter(entry=>(entry.item.block.lines?.length||0)>1||String(entry.item.block.text||"").length>=40);
    const fallback=entries.filter(entry=>ordinary(entry)&&!["heading","subheading","header","footer","footnote","caption"].includes(entry.item.kind));
    const pool=substantial.length?substantial:paragraphs.length?paragraphs:fallback.length?fallback:entries;
    const bodySize=dominant(pool)||10;
    const classSize=(kind,min,max,defaultRatio)=>{
      const matched=entries.filter(entry=>entry.item.kind===kind||kind==="table"&&entry.item.block.table||kind==="code"&&entry.item.block.codeRole);
      return bodySize*clamp((dominant(matched)||bodySize*defaultRatio)/bodySize,min,max);
    };
    const style=(size,lineHeight,before,after)=>Object.freeze({size,lineHeight,before:size*before,after:size*after});
    const styles={
      paragraph:style(bodySize,1.5,.45,.15),list:style(bodySize,1.5,.2,.15),
      footnote:style(classSize("footnote",.65,.9,.78),1.45,.2,.1),
      caption:style(classSize("caption",.8,1,.9),1.45,.35,.35),
      header:style(classSize("header",.65,.9,.8),1.35,0,0),
      footer:style(classSize("footer",.65,.9,.8),1.35,0,0),
      table:style(classSize("table",.8,1,.9),1.45,.35,.35),
      code:style(classSize("code",.75,1,.85),1.4,.35,.35)
    };
    const headingLevel=item=>{
      const level=Number(item.block.headingLevel);
      return Number.isInteger(level)&&level>=1?clamp(level,1,6):item.kind==="heading"?1:2;
    };
    let deeper=bodySize;
    for(let level=6;level>=1;level--){
      const candidates=entries.filter(entry=>["heading","subheading"].includes(entry.item.kind)&&headingLevel(entry.item)===level);
      const defaultRatio=level===1?1.5:level===2?1.25:1.1;
      // 有源标题证据时保留其层级尺度；不能把封面大标题强行压成固定模板字号。
      const size=Math.max(deeper,dominant(candidates)||bodySize*defaultRatio,bodySize*1.05);
      styles["heading"+level]=style(size,1.35,.8,.4);deeper=size;
    }
    const indents=paragraphs.map(entry=>sourceIndent(entry.item)).filter(positive),indentEm=median(indents);
    const resolve=(item,kind)=>{
      const role=kind||item.kind;
      if(["heading","subheading"].includes(role))return styles["heading"+headingLevel(item)];
      if(item.block.flow?.caption)return styles.caption;
      if(!kind&&item.block.table)return styles.table;
      if(!kind&&item.block.codeRole)return styles.code;
      return styles[role]||styles.paragraph;
    };
    return {version:VERSION,bodySize,styles:Object.freeze(styles),resolve,
      indent(item,width){
        if(item.kind!=="paragraph"||item.block.runInBody||item.block.flow||item.block.table||item.block.direction==="rtl")return 0;
        if(!sourceIndent(item))return 0;
        const style=resolve(item),indent=style.size*(indentEm||sourceIndent(item));
        return width-indent>=style.size*4?indent:0;
      },
      inline(run,sourceSize,size){
        const ratio=run.height/sourceSize,shift=run.shift/sourceSize;
        // 普通基线文字不继承字体包围盒噪声；真实上下标仍按原子的相对大小与位移保留。
        return {text:run.text,size:Math.abs(shift)<=.08&&ratio>=.8&&ratio<=1.2?size:size*ratio,shift:size*shift};
      },
      summary(){return {version:VERSION,body:bodySize,footnote:styles.footnote.size,caption:styles.caption.size,
        table:styles.table.size,code:styles.code.size,evidence:substantial.length?"paragraphs":paragraphs.length?"short-paragraphs":"limited"};}
    };
  }
  global.BT_PDF_REFLOW_TYPOGRAPHY={VERSION,create};
})(typeof window!=="undefined"?window:self);
