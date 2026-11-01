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
  function paragraphs(items){
    const result=[];let line="",previous=null,previousLine=null,paragraph="";
    const flushParagraph=()=>{if(paragraph.trim())result.push(paragraph.trim());paragraph="";};
    const flushLine=()=>{
      if(!line.trim())return;
      const text=line.trim();
      const y=previous?.transform?.[5]||0,x=previousLine?.startX;
      if(previousLine?.lastY!==undefined&&
        (Math.abs(y-previousLine.lastY)>Math.max(8,previousLine.height*1.8)||
         (previousLine.startX!==undefined&&previous?.lineX!==undefined&&Math.abs(previous.lineX-x)>Math.max(40,previousLine.height*4))))flushParagraph();
      if(paragraph.length+text.length>6000)flushParagraph();
      paragraph+=(paragraph?"\n":"")+text;
      previousLine={lastY:y,height:previous?.height||12,startX:previous?.lineX};line="";
    };
    for(const item of items){
      if(typeof item.str!=="string")continue;
      const height=Math.abs(item.height)||Math.hypot(item.transform?.[2]||0,item.transform?.[3]||12)||12;
      const x=item.transform?.[4]||0,y=item.transform?.[5]||0;
      if(previous&&line&&Math.abs(y-previous.transform[5])>Math.max(2,height*.45))flushLine();
      const lineX=line?previous?.lineX:x;
      if(line&&item.str&&!/\s$/.test(line)&&!/^\s/.test(item.str)){
        const gap=x-((previous?.transform?.[4]||0)+(previous?.width||0));
        if(gap>Math.max(.5,height*.12))line+=" ";
      }
      line+=item.str;
      previous={...item,height,lineX,transform:item.transform||[1,0,0,1,x,y]};
      if(item.hasEOL)flushLine();
    }
    flushLine();flushParagraph();
    return result.flatMap(text=>{
      // 极少数 PDF 将整页编码为一个字符串；仍限制完整单元大小，网络分片继续由后台执行。
      const chars=Array.from(text),chunks=[];
      for(let offset=0;offset<chars.length;offset+=6000)chunks.push(chars.slice(offset,offset+6000).join(""));
      return chunks;
    }).filter(text=>/\p{L}/u.test(text));
  }
  global.BT_PDF_DOCUMENT={MAX_FILE_BYTES,sourceUrl,isPdfUrl,isPdfDocument,paragraphs};
})(typeof self!=="undefined"?self:globalThis);
