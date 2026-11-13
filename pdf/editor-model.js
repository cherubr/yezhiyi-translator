(function(global) {
  "use strict";
  // 编辑稿只保存白名单结构与数值样式；不存储或重新执行粘贴进来的 HTML。
  const VERSION=1,MAX_BYTES=16*1024*1024,MAX_NODES=12000,MAX_TEXT=400000;
  const tags=new Set(["p","div","section","span","h1","h2","h3","h4","h5","h6","strong","b","em","i","u","s","sup","sub",
    "br","ul","ol","li","blockquote","pre","code","table","thead","tbody","tr","th","td","colgroup","col","img","hr"]);
  const blocked=new Set(["script","style","iframe","object","embed","svg","math","link","meta","form","input","textarea","select","button"]);
  const length=(value,min,max)=>{
    const match=String(value||"").trim().match(/^(-?\d+(?:\.\d+)?)(pt|px|%)$/u);
    return match&&Number(match[1])>=min&&Number(match[1])<=max?match[0]:null;
  };
  const image=value=>typeof value==="string"&&value.length<=6*1024*1024&&
    /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/u.test(value)&&
    /^(?:data:image\/png;base64,iVBORw0KGgo|data:image\/jpeg;base64,\/9j\/|data:image\/webp;base64,UklGR)/u.test(value);
  function styles(input={}) {
    const out={},choices={fontFamily:["sans-serif","serif","monospace"],fontWeight:["normal","bold","400","500","600","700","800","900"],
      fontStyle:["normal","italic"],textDecorationLine:["none","underline","line-through"],textAlign:["left","center","right","justify","start","end"],
      whiteSpace:["normal","pre-wrap"],verticalAlign:["baseline","super","sub"]};
    for(const [key,allowed] of Object.entries(choices))if(allowed.includes(input[key]))out[key]=input[key];
    for(const key of ["fontSize","marginTop","marginBottom","marginLeft","marginRight","paddingLeft","paddingRight","textIndent"]){
      const value=length(input[key],key==="textIndent"?-72:0,key==="fontSize"?144:96);
      if(value&&(!value.endsWith("%")||key!=="fontSize")&&(key!=="fontSize"||parseFloat(value)>=4))out[key]=value;
    }
    for(const key of ["marginLeft","marginRight"])if(input[key]==="auto")out[key]="auto";
    if(length(input.width,1,2000)&&(!input.width.endsWith("%")||parseFloat(input.width)<=100))out.width=input.width;
    if(Number(input.lineHeight)>=1&&Number(input.lineHeight)<=4)out.lineHeight=String(Number(input.lineHeight));
    return out;
  }
  function clean(document) {
    if(!document||document.version!==VERSION||!document.page)throw new Error("编辑稿格式不受支持");
    const {width,height,margin}=document.page;
    if(![width,height,margin].every(Number.isFinite)||width<72||height<72||width>14400||height>14400||margin<0||margin>=Math.min(width,height)/3)
      throw new Error("编辑稿页面尺寸无效");
    let count=0,characters=0;
    const visit=(node,depth=0)=>{
      if(++count>MAX_NODES||depth>48)throw new Error("编辑稿结构过大，请减少内容");
      if(typeof node==="string"){
        characters+=node.length;if(characters>MAX_TEXT)throw new Error("编辑稿文字过多");return node;
      }
      if(!node||!tags.has(node.tag))throw new Error("编辑稿包含不支持的内容");
      const out={tag:node.tag,style:styles(node.style)};
      if(typeof node.sourceId==="string"&&node.sourceId.length<=3000)out.sourceId=node.sourceId;
      if(Array.isArray(node.sourceIds)){
        const ids=[...new Set(node.sourceIds.filter(id=>typeof id==="string"&&id.length>0&&id.length<=3000))];
        if(ids.length>2048)throw new Error("编辑稿来源关联过多");
        if(ids.length)out.sourceIds=ids;
      }
      if(["pending","failed","skipped","unchanged","translated"].includes(node.status))out.status=node.status;
      if(["table","title","leader","page"].includes(node.tocRole))out.tocRole=node.tocRole;
      if(node.columns&&node.tag==="section"&&[1,2,3].includes(node.columns))out.columns=node.columns;
      if(out.columns&&Array.isArray(node.widths)&&node.widths.length===out.columns&&node.widths.every(value=>Number.isFinite(value)&&value>0&&value<=10000))out.widths=[...node.widths];
      for(const key of ["rowSpan","colSpan"])if(Number.isInteger(node[key])&&node[key]>=1&&node[key]<=100)out[key]=node[key];
      if(node.tag==="img"){
        if(!image(node.src))throw new Error("图片过大或格式不受支持，请使用 PNG、JPEG 或 WebP");
        out.src=node.src;out.alt=String(node.alt||"图片").slice(0,200);
      }
      if(node.pageBreak&&node.tag==="hr")out.pageBreak=true;
      out.children=(node.children||[]).map(child=>visit(child,depth+1));return out;
    };
    const result={version:VERSION,page:{width,height,margin},style:styles(document.style),children:(document.children||[]).map(node=>visit(node))};
    if(JSON.stringify(result).length*2>MAX_BYTES)throw new Error("编辑稿超过本机保存大小限制，请减少图片");
    return result;
  }
  function serialize(root,page) {
    let count=0,characters=0;
    const visit=(node,depth=0)=>{
      if(++count>MAX_NODES||depth>48)throw new Error("编辑稿结构过大，请减少内容");
      if(node.nodeType===3){characters+=node.textContent.length;if(characters>MAX_TEXT)throw new Error("编辑稿文字过多");}
      if(node.nodeType===3)return node.textContent;
      if(node.nodeType!==1)return null;
      const tag=node.tagName.toLowerCase();if(blocked.has(tag))return null;
      const children=[...node.childNodes].flatMap(child=>{const value=visit(child,depth+1);return value===null?[]:Array.isArray(value)?value:[value];});
      // 粘贴的未知包装层仅取其文字/安全子节点，不沿用属性和链接。
      if(!tags.has(tag))return children;
      const out={tag,children,style:styles(node.style),sourceId:node.dataset.blockId,status:node.dataset.status};
      out.tocRole=node.dataset.tocRole;
      if(node.dataset.sourceIds){try{out.sourceIds=JSON.parse(node.dataset.sourceIds);}catch(_){}}
      if(tag==="section"){
        out.columns=Number(node.dataset.columns)||undefined;
        try{if(node.dataset.widths?.length<200)out.widths=JSON.parse(node.dataset.widths);}catch(_){}
      }
      if(tag==="td"||tag==="th"){out.rowSpan=node.rowSpan;out.colSpan=node.colSpan;}
      if(tag==="img"){out.src=node.getAttribute("src");out.alt=node.getAttribute("alt");}
      if(tag==="hr"&&node.dataset.pageBreak==="true")out.pageBreak=true;
      return out;
    };
    const style=styles(root.style);
    // 纸张尺寸与页边距属于 page，不能在根节点重复存储为文字样式。
    for(const key of ["width","paddingLeft","paddingRight"])delete style[key];
    return clean({version:VERSION,page,style,children:[...root.childNodes].flatMap(node=>{const value=visit(node);return value===null?[]:Array.isArray(value)?value:[value];})});
  }
  function hydrate(document,owner) {
    const data=clean(document),fragment=owner.createDocumentFragment();
    const visit=node=>{
      if(typeof node==="string")return owner.createTextNode(node);
      const element=owner.createElement(node.tag);Object.assign(element.style,node.style);
      if(node.sourceId)element.dataset.blockId=node.sourceId;
      if(node.sourceIds)element.dataset.sourceIds=JSON.stringify(node.sourceIds);
      if(node.status)element.dataset.status=node.status;
      if(node.tocRole)element.dataset.tocRole=node.tocRole;
      if(node.columns){
        element.dataset.columns=String(node.columns);element.className="editor-columns";
        element.dataset.widths=JSON.stringify(node.widths||Array(node.columns).fill(1));
        element.style.gridTemplateColumns=(node.widths||Array(node.columns).fill(1)).map(value=>"minmax(0,"+value+"fr)").join(" ");
      }
      if(node.tag==="td"||node.tag==="th"){if(node.rowSpan)element.rowSpan=node.rowSpan;if(node.colSpan)element.colSpan=node.colSpan;}
      if(node.tag==="img"){element.src=node.src;element.alt=node.alt;element.draggable=false;}
      if(node.pageBreak){element.dataset.pageBreak="true";element.className="editor-page-break";element.contentEditable="false";}
      for(const child of node.children)element.append(visit(child));return element;
    };
    for(const node of data.children)fragment.append(visit(node));return {data,fragment};
  }
  function seed({rows,geometry,onVisual}) {
    const S=global.BT_PDF_STRUCTURED,T=global.BT_PDF_REFLOW_TYPOGRAPHY,items=S.items(rows),nodes=S.sections(rows,geometry.visuals||[],{pageLayout:true});
    const typography=T.create({items,nodes}),size=typography.bodySize;
    const paragraph=item=>{
      const rank=Number.isInteger(item.block.headingLevel)&&item.block.headingLevel>0?Math.min(6,item.block.headingLevel):item.kind==="heading"?1:2;
      const style=typography.resolve(item),tag=["heading","subheading"].includes(item.kind)?"h"+rank:
        item.block.role==="code"?"pre":"p";
      return {tag,sourceId:item.id,status:item.result?.status||"pending",style:{fontSize:style.size+"pt",lineHeight:String(style.lineHeight),
        marginTop:style.before+"pt",marginBottom:style.after+"pt",textIndent:typography.indent(item,geometry.width)+"pt",
        fontFamily:tag==="pre"?"monospace":["serif","monospace"].includes(item.result?.fontFamily)?item.result.fontFamily:"sans-serif",fontWeight:tag.startsWith("h")?"bold":"normal",whiteSpace:"pre-wrap"},children:[item.text]};
    };
    const region=node=>{
      if(node.kind==="toc")return [{tag:"table",tocRole:"table",children:[
        {tag:"colgroup",children:[77,15,8].map(width=>({tag:"col",style:{width:width+"%"},children:[]}))},
        {tag:"tbody",children:node.items.map(item=>{
          const title=paragraph(item);Object.assign(title.style,{textIndent:"0pt",whiteSpace:"normal"});
          return {tag:"tr",sourceId:item.id,children:[
            {tag:"td",tocRole:"title",style:{paddingLeft:Math.min(72,item.block.toc.level*12)+"pt"},children:[title]},
            {tag:"td",tocRole:"leader",children:["·".repeat(120)]},
            {tag:"td",tocRole:"page",children:[item.block.toc.pageLabel]}
          ]};
        })}]}];
      if(node.kind==="table"&&node.grid){
        const grid=node.grid;
        if(!Number.isInteger(grid.rows)||grid.rows<1||grid.rows>128||!Number.isInteger(grid.columns)||grid.columns<1||grid.columns>64||
          !Array.isArray(grid.widths)||grid.widths.length!==grid.columns||grid.widths.some(width=>!Number.isFinite(width)||width<=0)||!Array.isArray(grid.cells))return node.items.map(paragraph);
        const tableRows=Array.from({length:grid.rows},()=>({tag:"tr",children:[]}));
        for(const cell of grid.cells)tableRows[cell.row]?.children.push({tag:"td",rowSpan:cell.rowSpan,colSpan:cell.colSpan,children:node.items.filter(item=>item.block.cell?.id===cell.id).map(paragraph)});
        const sum=grid.widths.reduce((total,value)=>total+value,0)||1;
        return [{tag:"table",children:[{tag:"colgroup",children:grid.widths.map(width=>({tag:"col",style:{width:width/sum*100+"%"},children:[]}))},{tag:"tbody",children:tableRows}]}];
      }
      if(node.kind==="code"){
        const lines=new Map();
        for(const item of node.items){const key=item.block.flow?.part||item.id;if(!lines.has(key))lines.set(key,[]);lines.get(key).push(item);}
        const value=[...lines.values()].sort((a,b)=>Math.min(...a.map(item=>item.block.rect.y))-Math.min(...b.map(item=>item.block.rect.y)))
          .map(items=>items.sort((a,b)=>a.block.rect.x-b.block.rect.x).map(item=>item.block.codeRole==="comment"?item.text:item.block.rawText||item.block.text).join("  ")).join("\n");
        return [{tag:"pre",sourceId:node.items[0]?.id,sourceIds:node.items.map(item=>item.id),style:{fontFamily:"monospace",fontSize:typography.styles.code.size+"pt",whiteSpace:"pre-wrap"},children:[value]}];
      }
      if(node.kind==="figure"){
        const visual=node.visual||{id:node.id,pageNumber:geometry.pageNumber,sourceRect:node.flow?.sourceRect||node.flow?.rect};
        const canvas=global.document?.createElement("canvas");let picture=null;
        try{if(canvas&&visual.sourceRect&&onVisual?.(canvas,visual)){
          const src=canvas.toDataURL("image/png");if(image(src))picture={tag:"img",src,alt:"原始图形",style:{width:"100%"},children:[]};
        }}catch(_){picture=null;}finally{if(canvas)canvas.width=canvas.height=0;}
        const captions=node.items.filter(item=>item.kind==="caption"||item.block.flow?.caption||item.id===visual.captionId);
        if(picture){
          picture.sourceId=visual.id||node.id;
          picture.sourceIds=[visual.id||node.id,...node.items.filter(item=>!captions.includes(item)).map(item=>item.id)].filter(Boolean);
        }
        return picture?[picture,...captions.map(paragraph)]:[{tag:"p",children:["图形暂无法提取，请参照左侧原文。"]},...node.items.map(paragraph)];
      }
      return node.items.map(paragraph);
    };
    const build=tree=>tree.kind==="node"?region(tree.node):tree.kind==="columns"?
      [{tag:"section",columns:Math.min(3,tree.children.length),widths:tree.children.map(child=>Math.max(1,child.rect.right-child.rect.x)),children:tree.children.map(child=>({tag:"div",children:build(child)}))}]:tree.children.flatMap(build);
    return clean({version:VERSION,page:{width:geometry.width,height:geometry.height,margin:Math.min(size*2,geometry.width/12,geometry.height/12)},
      style:{fontSize:size+"pt",fontFamily:"sans-serif",lineHeight:"1.5"},children:build(S.readingLayout(nodes,{pageLayout:true}))});
  }
  function hasContent(document) {
    const visit=node=>typeof node==="string"?!!node.replace(/[\s\u200b]/gu,""):
      node.tag==="img"||node.tag==="table"||(node.children||[]).some(visit);
    return !!document?.children?.some(visit);
  }
  global.BT_PDF_EDITOR_MODEL={VERSION,MAX_BYTES,clean,styles,serialize,hydrate,seed,hasContent};
})(typeof window!=="undefined"?window:self);
