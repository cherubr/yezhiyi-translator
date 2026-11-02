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

  /** 按 PDF 自带的阅读顺序合并同一行，遇到换栏、段落间距和长段上限时分开。 */
  function blocks(items){
    const result=[];let line="",previous=null,previousLine=null,paragraph="",lineItems=[],paragraphItems=[];
    const flushParagraph=()=>{
      if(paragraph.trim())result.push({text:paragraph.trim(),indices:paragraphItems});
      paragraph="";paragraphItems=[];
    };
    const flushLine=()=>{
      if(!line.trim())return;
      const text=line.trim();
      const y=previous?.transform?.[5]||0,x=previousLine?.startX;
      if(previousLine?.lastY!==undefined&&
        (Math.abs(y-previousLine.lastY)>Math.max(8,previousLine.height*1.8)||
         Math.abs((previous?.height||12)-previousLine.height)>previousLine.height*.25||
         (previousLine.startX!==undefined&&previous?.lineX!==undefined&&Math.abs(previous.lineX-x)>Math.max(40,previousLine.height*4))))flushParagraph();
      if(paragraph.length+text.length>6000)flushParagraph();
      paragraph+=(paragraph?"\n":"")+text;
      paragraphItems.push(...lineItems);lineItems=[];
      previousLine={lastY:y,height:previous?.height||12,startX:previous?.lineX};line="";
    };
    for(const [index,item] of items.entries()){
      if(typeof item.str!=="string")continue;
      const height=Math.abs(item.height)||Math.hypot(item.transform?.[2]||0,item.transform?.[3]||12)||12;
      const x=item.transform?.[4]||0,y=item.transform?.[5]||0;
      const gap=x-((previous?.transform?.[4]||0)+(previous?.width||0));
      if(previous&&line&&(Math.abs(y-previous.transform[5])>Math.max(2,height*.45)||gap>height*4))flushLine();
      const lineX=line?previous?.lineX:x;
      if(line&&item.str&&!/\s$/.test(line)&&!/^\s/.test(item.str)){
        if(gap>Math.max(.5,height*.12))line+=" ";
      }
      line+=item.str;
      if(item.str.trim())lineItems.push(index);
      previous={...item,height,lineX,transform:item.transform||[1,0,0,1,x,y]};
      if(item.hasEOL)flushLine();
    }
    flushLine();flushParagraph();
    return result.flatMap(block=>{
      // 极少数 PDF 将整页编码为一个字符串；仍限制完整单元大小，网络分片继续由后台执行。
      const chars=Array.from(block.text),chunks=[];
      for(let offset=0;offset<chars.length;offset+=6000)chunks.push({...block,text:chars.slice(offset,offset+6000).join(""),positionable:chars.length<=6000});
      return chunks;
    }).filter(block=>/\p{L}/u.test(block.text));
  }
  function paragraphs(items){return blocks(items).map(block=>block.text);}

  /** 将文字基线及字体度量映射到当前画布；无法可靠定位的块保留在左右对照中。 */
  function layoutRect(block,items,styles,viewport){
    if(!block.positionable)return null;
    let left=Infinity,top=Infinity,right=-Infinity,bottom=-Infinity,fontHeight=Infinity;
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
      fontHeight=Math.min(fontHeight,height);
    }
    // 一点边缘余量覆盖字体抗锯齿，同时严格限制在页面内部。
    left=Math.max(0,left-1);top=Math.max(0,top-1);
    right=Math.min(viewport.width,right+1);bottom=Math.min(viewport.height,bottom+1);
    if(!(right>left&&bottom>top))return null;
    return {left:left/viewport.width,top:top/viewport.height,width:(right-left)/viewport.width,
      height:(bottom-top)/viewport.height,fontSize:fontHeight/viewport.width};
  }
  global.BT_PDF_DOCUMENT={MAX_FILE_BYTES,sourceUrl,isPdfUrl,isPdfDocument,paragraphs,blocks,layoutRect};
})(typeof self!=="undefined"?self:globalThis);
