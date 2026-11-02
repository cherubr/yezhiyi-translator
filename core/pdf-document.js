(function(global){
  "use strict";
  const MAX_FILE_BYTES=50*1024*1024;

  /** PDF 来源仅接受普通网络地址；本地文件通过用户选择读取，不开放任意文件路径。 */
  function sourceUrl(value){
    const url=new URL(value);
    if(!["https:","http:"].includes(url.protocol)||url.username||url.password)throw Error("请填写 HTTP/HTTPS PDF 地址，或选择本地 PDF 文件");
    url.hash="";return url;
  }
  function isPdfUrl(value){
    try{return /\.pdf$/i.test(new URL(value).pathname);}catch(_){return false;}
  }
  function isPdfDocument(doc){
    return doc.contentType==="application/pdf"||(!doc.body?.innerText?.trim()&&!!doc.querySelector('embed[type="application/pdf"], object[type="application/pdf"]'));
  }

  /** 只移除软连字符；真实连字符保留，避免改变技术名称。 */
  function joinLines(a,b){
    const soft=/\u00ad$/u.test(a);a=a.replace(/\u00ad$/u,"");b=b.trim();
    if(!a)return b;
    return a+(soft||/[-‐‑]$/u.test(a)||/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]$/u.test(a)&&/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(b)?"":" ")+b;
  }

  /** 基线以本行正文为准，较小的上标不改变基线或触发新行。 */
  function textLines(items,styles){
    const lines=[];let current=null;
    const flush=()=>{
      if(!current)return;
      current.atoms.sort((a,b)=>a.x-b.x||a.index-b.index);
      const widths=current.atoms.filter(atom=>atom.mono&&atom.right>atom.x).map(atom=>(atom.right-atom.x)/Array.from(atom.text).length).sort((a,b)=>a-b);
      const spaceWidth=widths.length?widths[Math.floor(widths.length/2)]:current.height*.53;
      let text="",codeText="",previous=null,mono=0,weight=0;
      for(const atom of current.atoms){
        const gap=previous?atom.x-previous.right:0;
        const space=previous&&gap>Math.max(.5,current.height*.12)&&!/^\s|^[,.;:!?，。；：！？]/u.test(atom.text)&&!/[\s]$/u.test(text);
        text+=(space?" ":"")+atom.text;
        const count=space?Math.max(1,Math.min(40,Math.round(gap/Math.max(1,spaceWidth)))):0;
        codeText+=" ".repeat(count)+atom.text;
        const size=Math.max(1,atom.text.trim().length);weight+=size;if(atom.mono)mono+=size;previous=atom;
      }
      lines.push({...current,text:text.trim(),codeText:codeText.trimEnd(),spaceWidth,mono:mono/weight>.65,order:lines.length});current=null;
    };
    for(const [index,item]of items.entries()){
      if(typeof item.str!=="string")continue;
      if(!item.str.trim()){if(item.hasEOL)flush();continue;}
      const m=item.transform||[1,0,0,1,0,0],height=Math.abs(item.height)||Math.hypot(m[2],m[3])||12;
      const x=Number(m[4])||0,y=Number(m[5])||0,width=Math.max(0,Number(item.width)||0);
      const mono=/mono|courier|consolas/iu.test((styles[item.fontName]?.fontFamily||"")+" "+(item.fontName||""));
      const codeGap=current&&mono&&current.monoOnly&&x-current.right<height*16;
      if(current&&(Math.abs(y-current.y)>Math.max(2,height*.6,current.height*.6)||!codeGap&&x-current.right>Math.max(24,height*4)||x<current.lastX-height*.5))flush();
      if(!current)current={atoms:[],left:x,right:x+width,y,height,lastX:x,monoOnly:true};
      if(height>current.height){current.height=height;current.y=y;}
      current.atoms.push({index,text:item.str,x,y,right:x+width,height,mono});
      current.monoOnly=current.monoOnly&&mono;
      current.left=Math.min(current.left,x);current.right=Math.max(current.right,x+width);current.lastX=x;
      if(item.hasEOL)flush();
    }
    flush();return lines;
  }

  /** 依据字号、居中关系及等宽字体区分结构；不按站点、作者名或论文标题匹配。 */
  function classifyLines(lines){
    const sizes=new Map();
    for(const line of lines){const size=Math.round(line.height*2)/2;sizes.set(size,(sizes.get(size)||0)+line.text.length);}
    const body=[...sizes].sort((a,b)=>b[1]-a[1])[0]?.[0]||12;
    let left=Infinity,right=-Infinity;
    for(const line of lines){left=Math.min(left,line.left);right=Math.max(right,line.right);}
    // 正文最后一行常不铺满页面，优先用大标题的轴线判断居中。
    const titles=lines.filter(line=>line.height>=body*1.6&&line.text.length>10).slice(0,3);
    const center=titles.length?titles.reduce((sum,line)=>sum+(line.left+line.right)/2,0)/titles.length:(left+right)/2;
    let frontMatter=false;
    for(const line of lines){
      line.centered=Math.abs((line.left+line.right)/2-center)<Math.max(line.height*2,(right-left)*.065);
      const contact=/^(?:\{[^{}]+\}|[^\s{}@=;]+)@[^\s@=;]+\.[^\s@=;]+$/u.test(line.text)||/^(?:https?:\/\/|www\.)\S+$/iu.test(line.text);
      const syntax=/[;=]|\b(?:for|if|while|return|continue|const|let|var|function|class|def|import)\b|^\s*(?:mov|push|pop|cmp|jne|je|jmp|add|sub|and|call|ret|ld|st|guard)\b|^\s*\d*\s*[{}\[\]]/u.test(line.text);
      line.kind=contact?"metadata":line.mono&&syntax?"code":line.height>=body*1.18?"heading":/^(?:Fig(?:ure)?\.?|Table|图|表)\s*\d/iu.test(line.text)?"caption":/^(?:[•●▪◦‣*-]\s*|\(?\d+[.)]\s+)/u.test(line.text)?"list":line.height<body*.8?"label":"paragraph";
      line.level=line.height>=body*1.6?1:2;
      const previous=lines[line.order-1];
      if(frontMatter&&previous&&previous.y-line.y>Math.max(body*3.5,previous.height*2.2))frontMatter=false;
      if(line.kind==="heading"&&line.level===1&&line.centered)frontMatter=true;
      else if(frontMatter){
        if(!line.centered&&!contact)frontMatter=false;
        else line.kind="metadata";
      }
    }
    // 代码中的独立括号/行号沿用相邻等宽代码的类别。
    for(let i=0;i<lines.length;i++)if(lines[i].mono&&/^[\d\s{}()[\];:+-]+$/u.test(lines[i].text)&&[lines[i-1],lines[i+1]].some(line=>line?.kind==="code"))lines[i].kind="code";
    return body;
  }

  /** 仅将重复对齐、无跨列文字的高置信区域组成表格，其余保留段落。 */
  function tableRegion(lines,height){
    if(lines.length>2000)return null;
    const atoms=lines.filter(line=>!["code","metadata","label"].includes(line.kind)).flatMap(line=>line.atoms).filter(atom=>atom.height>=height*.8&&!atom.mono&&/\p{L}|\p{N}/u.test(atom.text));
    if(atoms.length>12000)return null;
    const anchors=[];
    for(const atom of atoms){
      let anchor=anchors.find(value=>Math.abs(value.x-atom.x)<height*.4);
      if(!anchor){anchor={x:atom.x,ys:new Set()};anchors.push(anchor);}anchor.ys.add(Math.round(atom.y/Math.max(2,height*.4)));
    }
    const columns=[];
    for(const anchor of anchors.filter(value=>value.ys.size>=3).sort((a,b)=>b.ys.size-a.ys.size))if(columns.every(x=>Math.abs(x-anchor.x)>height*3.8)&&columns.length<6)columns.push(anchor.x);
    columns.sort((a,b)=>a-b);if(columns.length<2)return null;
    const aligned=atoms.filter(atom=>columns.some(x=>Math.abs(x-atom.x)<height*.6));
    const bands=[];
    for(const atom of [...aligned].sort((a,b)=>b.y-a.y)){
      let band=bands.find(value=>Math.abs(value.y-atom.y)<height*.45);
      if(!band){band={y:atom.y,columns:new Set()};bands.push(band);}band.columns.add(columns.findIndex(x=>Math.abs(x-atom.x)<height*.6));
    }
    const shared=bands.filter(band=>band.columns.size>=2);
    if(shared.length<3||columns.some((_,column)=>shared.filter(band=>band.columns.has(column)).length<2))return null;
    const top=shared[0].y,bottom=shared[shared.length-1].y;
    const relevant=lines.filter(line=>line.y<=top+height*.5&&line.y>=bottom-height*.5);
    const crosses=atom=>columns.some(x=>atom.x<x-height*.6&&atom.right>x+height*.6);
    if(relevant.some(line=>line.atoms.some(crosses)||["code","metadata","label"].includes(line.kind)))return null;
    // 两栏正文有长段跨满左栏，不应误当作两列表格。
    if(columns.length===2){
      const first=aligned.filter(atom=>Math.abs(atom.x-columns[0])<height*.6);
      if(first.some(atom=>atom.right-atom.x>(columns[1]-columns[0])*.72))return null;
    }
    let low=bottom;
    for(const line of lines.filter(line=>line.y<bottom-height*.5).sort((a,b)=>b.y-a.y)){
      if(low-line.y>height*1.8||line.left<columns[0]-height||line.atoms.some(crosses)||["code","metadata","label"].includes(line.kind))break;
      relevant.push(line);low=line.y;
    }
    const selected=new Set(relevant),rows=[];
    for(const atom of relevant.flatMap(line=>line.atoms).sort((a,b)=>b.y-a.y||a.x-b.x)){
      let row=rows.find(value=>Math.abs(value.y-atom.y)<height*.45);
      if(!row){row={y:atom.y,atoms:[]};rows.push(row);}row.atoms.push(atom);
    }
    const groups=[];
    for(const row of rows){
      if(!groups.length||groups[groups.length-1].lastY-row.y>height*1.4)groups.push({lastY:row.y,cells:columns.map(()=>[])});
      const group=groups[groups.length-1];group.lastY=row.y;
      for(const atom of row.atoms){let column=0;while(column+1<columns.length&&atom.x>=columns[column+1]-height*.6)column++;group.cells[column].push(atom);}
    }
    if(groups.length<2)return null;
    const id=Math.min(...relevant.map(line=>line.order)),units=[];
    const right=Math.max(...relevant.flatMap(line=>line.atoms.map(atom=>atom.right)));
    const widths=columns.map((x,index)=>((columns[index+1]||right)-x)/(right-columns[0]));
    for(const [row,group]of groups.entries())for(const [column,cell]of group.cells.entries()){
      if(!cell.length)continue;
      const cellLines=textLines(cell.map(atom=>({str:atom.text,width:atom.right-atom.x,height:atom.height,transform:[atom.height,0,0,atom.height,atom.x,atom.y]})),{});
      const text=cellLines.reduce((value,line)=>joinLines(value,line.text),"");
      let rowSpan=1;if(row>0)while(row+rowSpan<groups.length&&!groups[row+rowSpan].cells[column].length)rowSpan++;
      units.push({text,indices:cell.map(atom=>atom.index),kind:"cell",translate:true,table:{id,row,column,rows:groups.length,columns:columns.length,widths,rowSpan,header:row===0&&group.cells.every(value=>value.length)}});
    }
    return {id,selected,units};
  }

  /** 从同行文字、语义块到展示结构；两种视图始终共用同一组文字索引。 */
  function blocks(items,styles={}){
    const lines=textLines(items,styles);if(!lines.length)return [];
    const height=classifyLines(lines),table=tableRegion(lines,height),result=[];let group=null;
    const flush=()=>{
      if(!group)return;
      const first=group.lines[0],indices=group.lines.flatMap(line=>line.atoms.map(atom=>atom.index));
      let text="";
      if(first.kind==="code"){
        const left=Math.min(...group.lines.map(line=>line.left));
        text=group.lines.map(line=>" ".repeat(Math.min(40,Math.max(0,Math.round((line.left-left)/line.spaceWidth))))+line.codeText).join("\n");
      }else if(first.kind==="metadata")text=group.lines.map(line=>line.text).join("\n");
      else text=group.lines.reduce((value,line)=>joinLines(value,line.text),"");
      result.push({text,indices,kind:first.kind,level:first.level,centered:first.centered,translate:!["code","metadata"].includes(first.kind)});group=null;
    };
    for(const line of lines){
      if(table?.selected.has(line)){flush();if(line.order===table.id)result.push(...table.units);continue;}
      const previous=group?.lines[group.lines.length-1],first=group?.lines[0];
      if(previous){
        const sameKind=line.kind===first.kind||first.kind==="list"&&line.kind==="paragraph";
        const gap=previous.y-line.y,centered=line.centered&&previous.centered&&["heading","metadata"].includes(line.kind);
        const indent=line.kind==="paragraph"&&first.kind!=="list"&&line.left-previous.left>height*.8;
        const separate=!sameKind||line.kind==="list"||gap<=0||gap>Math.max(8,previous.height*1.65)||Math.abs(line.height-previous.height)>previous.height*.18||!centered&&Math.abs(line.left-previous.left)>Math.max(40,height*4)||indent;
        if(separate)flush();
      }
      if(!group)group={lines:[]};group.lines.push(line);
    }
    flush();
    return result.flatMap(block=>{
      const chars=Array.from(block.text),chunks=[];
      for(let offset=0;offset<chars.length;offset+=6000)chunks.push({...block,text:chars.slice(offset,offset+6000).join(""),positionable:chars.length<=6000});
      return chunks;
    }).filter(block=>block.kind==="code"||block.table||/\p{L}/u.test(block.text));
  }
  function paragraphs(items,styles){return blocks(items,styles).map(block=>block.text);}

  /** 将文字基线及字体度量映射到当前画布；无法可靠定位的块保留在左右对照中。 */
  function layoutRect(block,items,styles,viewport){
    if(!block.positionable)return null;
    let left=Infinity,top=Infinity,right=-Infinity,bottom=-Infinity;
    const fontHeights=[];let fontWeight=0;
    const [a,b,c,d,e,f]=viewport.transform;
    for(const index of block.indices){
      const item=items[index],m=item.transform,style=styles[item.fontName]||{};
      if(!m?.every(Number.isFinite)||style.vertical||item.dir==="ttb")return null;
      const dx=a*m[0]+c*m[1],dy=b*m[0]+d*m[1];
      // 旋转/竖排不强行按横排遮盖；完整译文仍可在左右对照中阅读。
      if(dx<=0||Math.abs(dy)>Math.abs(dx)*.02)return null;
      const height=Math.hypot(a*m[2]+c*m[3],b*m[2]+d*m[3]);
      const x=a*m[4]+c*m[5]+e,y=b*m[4]+d*m[5]+f;
      const ascent=Number.isFinite(style.ascent)?style.ascent:Number.isFinite(style.descent)?1+style.descent:.8;
      const descent=Number.isFinite(style.descent)?Math.min(0,style.descent):-.2;
      const width=Math.abs(item.width*viewport.scale);
      if(![x,y,height,width,ascent,descent].every(Number.isFinite)||height<=0||width<=0)return null;
      left=Math.min(left,x);right=Math.max(right,x+width);
      top=Math.min(top,y-height*ascent);bottom=Math.max(bottom,y-height*descent);
      // 上标、商标和脚注仍参与定位，但不以最小字形决定整段字号。
      const weight=Array.from(item.str||"").filter(char=>/\S/u.test(char)).length;
      if(weight){fontHeights.push({height,weight});fontWeight+=weight;}
    }
    // 一点边缘余量覆盖字体抗锯齿，同时严格限制在页面内部。
    left=Math.max(0,left-1);top=Math.max(0,top-1);
    right=Math.min(viewport.width,right+1);bottom=Math.min(viewport.height,bottom+1);
    if(!(right>left&&bottom>top)||!fontWeight)return null;
    fontHeights.sort((a,b)=>a.height-b.height);
    let fontHeight=fontHeights[0].height,accumulated=0;
    for(const sample of fontHeights){accumulated+=sample.weight;if(accumulated>=fontWeight/2){fontHeight=sample.height;break;}}
    return {left:left/viewport.width,top:top/viewport.height,width:(right-left)/viewport.width,
      height:(bottom-top)/viewport.height,fontSize:fontHeight/viewport.width};
  }
  global.BT_PDF_DOCUMENT={MAX_FILE_BYTES,sourceUrl,isPdfUrl,isPdfDocument,paragraphs,blocks,layoutRect};
})(typeof self!=="undefined"?self:globalThis);
