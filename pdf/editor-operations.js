(function(global) {
  "use strict";
  // 纯 DOM 操作，不读取翻译会话；查找只在同一段落/单元格内跨行内样式匹配。
  const boundaries=new Set(["P","DIV","SECTION","H1","H2","H3","H4","H5","H6","LI","UL","OL","PRE","BLOCKQUOTE","TABLE","THEAD","TBODY","TR","TD","TH","BR","HR","IMG"]);
  function find(root,query,{caseSensitive=false,limit=2000}={}) {
    if(!query)return {ranges:[],limited:false};
    if(query.length>500)throw new Error("查找文字最多 500 个字符");
    const pattern=new RegExp(query.replace(/[.*+?^${}()|[\]\\]/gu,"\\$&"),caseSensitive?"gu":"giu"),ranges=[];
    let nodes=[],limited=false;
    const flush=()=>{
      if(!nodes.length||limited){nodes=[];return;}
      const text=nodes.map(node=>node.textContent).join("");let match;pattern.lastIndex=0;
      while((match=pattern.exec(text))){
        if(ranges.length>=limit){limited=true;break;}
        const start=match.index,end=start+match[0].length,range=root.ownerDocument.createRange();let offset=0;
        for(const node of nodes){
          const next=offset+node.length;
          if(start>=offset&&start<next)range.setStart(node,start-offset);
          if(end>offset&&end<=next){range.setEnd(node,end-offset);break;}
          offset=next;
        }
        ranges.push(range);
      }
      nodes=[];
    };
    const visit=node=>{
      if(limited)return;
      if(node.nodeType===3){nodes.push(node);return;}
      if(node.nodeType!==1)return;
      const boundary=boundaries.has(node.tagName);if(boundary)flush();
      if(!["BR","HR","IMG"].includes(node.tagName))for(const child of node.childNodes)visit(child);
      if(boundary)flush();
    };
    for(const node of root.childNodes)visit(node);flush();return {ranges,limited};
  }
  function bookmark(root,range) {
    if(!range||!root.contains(range.commonAncestorContainer))return null;
    const point=(node,offset)=>{
      const path=[];let current=node;
      while(current!==root){const parent=current.parentNode;if(!parent)return null;path.unshift([...parent.childNodes].indexOf(current));current=parent;}
      const prefix=root.ownerDocument.createRange();prefix.selectNodeContents(root);prefix.setEnd(node,offset);
      return {path,offset,type:node.nodeType,textOffset:prefix.toString().length};
    };
    return {start:point(range.startContainer,range.startOffset),end:point(range.endContainer,range.endOffset)};
  }
  function restore(root,mark) {
    if(!mark?.start||!mark.end)return null;
    const point=saved=>{
      let node=root;
      for(const index of saved.path){node=node?.childNodes[index];if(!node)break;}
      if(node?.nodeType===saved.type&&saved.offset<=(node.nodeType===3?node.length:node.childNodes.length))return [node,saved.offset];
      const walker=root.ownerDocument.createTreeWalker(root,4);let offset=saved.textOffset,last;
      while((node=walker.nextNode())){last=node;if(offset<=node.length)return [node,offset];offset-=node.length;}
      return last?[last,last.length]:[root,root.childNodes.length];
    };
    try{const range=root.ownerDocument.createRange();range.setStart(...point(mark.start));range.setEnd(...point(mark.end));return range;}catch(_){return null;}
  }
  function newline(root,range,{soft=false}={}) {
    if(!range||!root.contains(range.commonAncestorContainer))return null;
    const element=node=>node.nodeType===1?node:node.parentElement;
    const block=element(range.startContainer)?.closest("p,h1,h2,h3,h4,h5,h6");
    // 列表、代码及跨段选择交由浏览器原生编辑处理，不能拆坏列表或表格结构。
    if(!block||!root.contains(block)||!block.contains(range.endContainer)||block.closest("li,pre"))return null;
    const owner=root.ownerDocument,body=global.BT_PDF_EDITOR_MODEL.styles(root.style);
    range.deleteContents();
    const rest=range.cloneRange();rest.selectNodeContents(block);rest.setStart(range.startContainer,range.startOffset);
    const fragment=rest.extractContents(),next=owner.createRange();
    const ensureLine=node=>{if(!node.textContent&&!node.querySelector("br,img,hr"))node.append(owner.createElement("br"));};
    if(soft){
      const br=owner.createElement("br");range.insertNode(br);
      const after=owner.createDocumentFragment();after.append(fragment);ensureLine(after);block.append(after);
      next.setStartAfter(br);next.collapse(true);
    }else{
      const paragraph=owner.createElement("p");
      if(block.tagName==="P"){
        Object.assign(paragraph.style,global.BT_PDF_EDITOR_MODEL.styles(block.style));
        for(const key of ["blockId","sourceIds","status"])if(block.dataset[key])paragraph.dataset[key]=block.dataset[key];
      }else Object.assign(paragraph.style,{fontFamily:body.fontFamily||"sans-serif",fontSize:body.fontSize||"10pt",lineHeight:body.lineHeight||"1.5",fontWeight:"normal"});
      paragraph.append(fragment);ensureLine(block);ensureLine(paragraph);block.after(paragraph);
      next.selectNodeContents(paragraph);next.collapse(true);
    }
    return next;
  }
  function textRuns(root,range) {
    if(!range||range.collapsed||!root.contains(range.commonAncestorContainer))return [];
    const out=[],add=text=>{
      if(!range.intersectsNode(text))return;
      const start=text===range.startContainer?range.startOffset:0,end=text===range.endContainer?range.endOffset:text.length;
      if(end>start)out.push({text,start,end});
    },base=range.commonAncestorContainer;
    if(base.nodeType===3)add(base);
    else{const walker=root.ownerDocument.createTreeWalker(base,4);let node;while((node=walker.nextNode()))add(node);}
    return out;
  }
  function pickSource(candidates,x,y) {
    const contains=r=>r&&[r.x,r.y,r.right,r.bottom].every(Number.isFinite)&&r.right>r.x&&r.bottom>r.y&&x>=r.x&&x<=r.right&&y>=r.y&&y<=r.bottom;
    const area=r=>(r.right-r.x)*(r.bottom-r.y);
    // 优先真实文字行，之后才按最小段落框命中；不跨空白猜最近的其他段落。
    return candidates.filter(item=>contains(item.rect)).map(item=>{
      const lines=(item.lines||[]).map(line=>line.rect||line).filter(contains);
      return {item,line:lines.length>0,area:lines.length?Math.min(...lines.map(area)):area(item.rect)};
    }).sort((a,b)=>Number(b.line)-Number(a.line)||a.area-b.area)[0]?.item||null;
  }
  global.BT_PDF_EDITOR_OPERATIONS={find,bookmark,restore,newline,textRuns,pickSource};
})(window);
