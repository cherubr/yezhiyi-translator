/** PDF.js 6.4 的绘制适配：只隐藏已成功匹配的字形，保留文字推进及全部非文字绘制。 */
export function createTextRecorder(OPS){
  const operations=new Map(),visited=new Set(),stack=[];
  let state={font:null,color:"#000000",mode:0,unsafe:false};
  function filter(index,list){
    if(visited.has(index))return true;visited.add(index);
    const op=list.fnArray[index],args=list.argsArray[index]||[];
    if([OPS.save,OPS.paintFormXObjectBegin,OPS.beginGroup,OPS.beginAnnotation].includes(op)){
      stack.push({...state});
      if(op===OPS.beginAnnotation||op===OPS.beginGroup&&(args[0]?.smask||args[0]?.knockout))state.unsafe=true;
    }
    else if([OPS.restore,OPS.paintFormXObjectEnd,OPS.endGroup,OPS.endAnnotation].includes(op))state=stack.pop()||state;
    else if(op===OPS.setFont)state.font=args[0];
    else if(op===OPS.setTextRenderingMode)state.mode=args[0];
    else if(op===OPS.setFillRGBColor)state.color=args[0];
    else if(op===OPS.setFillColorN||op===OPS.setFillTransparent)state.unsafe=true;
    else if(op===OPS.setGState)for(const [key,value]of args[0]){
      if(key==="Font")state.font=value[0];
      if(key==="SMask"&&value||key==="BM"&&value!=="source-over"||key==="ca"&&value!==1||key==="TR"&&value)state.unsafe=true;
    }
    if(op===OPS.showText)operations.set(index,{...state,text:args[0].filter(glyph=>typeof glyph!=="number").map(glyph=>glyph.unicode||"").join("")});
    return true;
  }
  return {operations,filter};
}

const normalize=text=>text.normalize("NFKC").replace(/[\s\u00ad]/gu,"");

/** 文字流、字体、原坐标三者一致才替换；任一字形无法匹配则整块保留原文。 */
export function matchTextOperations({items,blocks,layouts,operations,bboxes,fontFor}){
  const owners=new Map(),ranges=[],expected=new Map(),coverage=new Map(),byBlock=new Map(),styles=new Map();
  blocks.forEach((block,index)=>block.indices.forEach(item=>{if(owners.has(item))owners.set(item,-1);else owners.set(item,index);}));
  let source="";
  for(const [itemIndex,item]of items.entries()){
    if(typeof item.str!=="string")continue;
    const text=normalize(item.str);if(!text)continue;
    // 异常超大文字页保持可阅读，不为匹配无限分配内存。
    if(source.length+text.length>2000000)return {byBlock:new Map(),styles:new Map()};
    const owner=owners.get(itemIndex)??-1;
    ranges.push({start:source.length,end:source.length+text.length,owner,font:item.fontName});source+=text;
    if(owner>=0)expected.set(owner,(expected.get(owner)||0)+text.length);
  }
  let cursor=0,rangeIndex=0;
  for(const [op,record]of operations){
    const text=normalize(record.text);if(!text)continue;
    const offset=source.slice(cursor,cursor+128+text.length).indexOf(text);if(offset<0||offset>128)continue;
    const start=cursor+offset;
    const end=start+text.length;cursor=end;
    while(rangeIndex<ranges.length&&ranges[rangeIndex].end<=start)rangeIndex++;
    const range=ranges[rangeIndex];if(!range)continue;
    const owner=range.owner,rect=layouts[owner],font=fontFor(record.font);
    if(owner<0||!rect||blocks[owner].translate===false||record.unsafe||record.mode>2||!font||font.isType3Font)continue;
    let valid=true;
    for(let i=rangeIndex;i<ranges.length&&ranges[i].start<end;i++)if(ranges[i].owner!==owner||ranges[i].font!==record.font){valid=false;break;}
    if(!valid||!bboxes||op>=bboxes.length||bboxes.isEmpty(op))continue;
    if(bboxes.maxX(op)<rect.left-.012||bboxes.minX(op)>rect.left+rect.width+.012||bboxes.maxY(op)<rect.top-.012||bboxes.minY(op)>rect.top+rect.height+.012)continue;
    if(!byBlock.has(owner))byBlock.set(owner,[]);byBlock.get(owner).push(op);
    coverage.set(owner,(coverage.get(owner)||0)+text.length);
    if(!styles.has(owner))styles.set(owner,{color:record.color,bold:!!font.bold,italic:!!font.italic});
  }
  for(const owner of byBlock.keys())if(coverage.get(owner)!==expected.get(owner)){byBlock.delete(owner);styles.delete(owner);}
  return {byBlock,styles};
}

/** 临时替换当前绘制调用的字形参数；每个操作后恢复，不改包内 PDF.js 或原文件。 */
export function createTextFilter(OPS,suppressed){
  let restore=()=>{};
  return {
    filter(index,list){
      restore();restore=()=>{};
      if(list.fnArray[index]!==OPS.showText||!suppressed.has(index))return true;
      const original=list.argsArray[index];
      list.argsArray[index]=[original[0].map(glyph=>typeof glyph==="number"?glyph:{...glyph,isInFont:false,fontChar:"",unicode:"",accent:null})];
      restore=()=>{list.argsArray[index]=original;};
      return true;
    },
    restore(){restore();restore=()=>{};}
  };
}
