(function(global) {
  "use strict";
  // 重排专用中间模型。只派生布局副本，不修改送翻块、结果、人工修订或原位坐标。
  const VERSION=2;
  const valid=r=>r&&[r.x,r.y,r.right,r.bottom].every(Number.isFinite)&&r.right>r.x&&r.bottom>r.y;
  const union=rects=>({x:Math.min(...rects.map(r=>r.x)),y:Math.min(...rects.map(r=>r.y)),right:Math.max(...rects.map(r=>r.right)),bottom:Math.max(...rects.map(r=>r.bottom))});
  const overlap=(a,b)=>Math.max(0,Math.min(a.right,b.right)-Math.max(a.x,b.x))*Math.max(0,Math.min(a.bottom,b.bottom)-Math.max(a.y,b.y));
  const median=values=>{const sorted=values.filter(n=>Number.isFinite(n)&&n>0).sort((a,b)=>a-b);return sorted[Math.floor(sorted.length/2)]||10;};
  function page({rows,geometry}) {
    const structured=global.BT_PDF_STRUCTURED,byId=new Map(structured.items(rows).map(item=>[item.id,item]));
    let nodes=structured.sections(rows.map(({block})=>({block})),geometry.visuals||[],{pageLayout:true});
    const sourceRect=node=>{
      const rects=[node.grid?.rect,node.flow?.rect,node.visual?.rect,...node.items.map(item=>item.block.rect)].filter(valid);
      return rects.length?union(rects):null;
    };
    nodes=nodes.map((node,index)=>({...node,id:node.id||"region:"+(node.items[0]?.id??index),items:node.items.map(item=>byId.get(item.id)||item),rect:sourceRect(node)}));
    const ordinary=node=>!node.flow&&!node.grid&&!node.visual&&node.items.length===1&&node.items[0].block.source==="native"&&valid(node.rect);
    const body=nodes.filter(node=>ordinary(node)&&node.items[0].block.role==="text"&&node.items[0].block.text.length>40);
    const em=median((body.length?body:nodes).flatMap(node=>node.items.map(item=>item.block.height))),removed=new Set(),repairs=[];
    let operations=0;
    // 老快照或有歧义的行内碎片不能独立裁成一个排版节点。保留完整局部区域，译文另行提供。
    for(const node of nodes){
      if(removed.has(node)||!ordinary(node))continue;
      const b=node.items[0].block;
      if(!b.inlineUncertain&&!(b.height<em*.85&&node.rect.right-node.rect.x<em*3&&!["header","footer","heading","subheading"].includes(node.kind)))continue;
      const near=[];
      for(const owner of nodes){
        if(++operations>250000)break;
        if(owner===node||removed.has(owner)||!ordinary(owner)||owner.items[0].block.role!=="text"||owner.items[0].block.height<b.height*1.1)continue;
        const dx=Math.max(0,node.rect.x-owner.rect.right,owner.rect.x-node.rect.right),dy=Math.max(0,node.rect.y-owner.rect.bottom,owner.rect.y-node.rect.bottom);
        if(dx<=em&&dy<=em*.5)near.push({owner,score:dx+dy});
      }
      near.sort((a,b)=>a.score-b.score);
      if(!near.length){node.unresolvedInline=true;continue;}
      const owner=near[0].owner,members=[node,owner],rect=union(members.map(n=>n.rect));
      const foreign=nodes.some(other=>other!==node&&other!==owner&&!removed.has(other)&&valid(other.rect)&&overlap(rect,other.rect)>em*em*.1);
      if(foreign||near[1]&&near[1].score-near[0].score<em*.15){node.unresolvedInline=true;continue;}
      removed.add(node);removed.add(owner);
      repairs.push({id:owner.id+":retained",kind:"retained",items:members.flatMap(n=>n.items),rect,sourceRegion:rect,
        flow:{id:owner.id+":retained",type:"retained",rect,sourceRect:rect},reason:"INLINE_UNRESOLVED"});
    }
    nodes=[...nodes.filter(node=>!removed.has(node)),...repairs].sort((a,b)=>(a.visual?.order??Math.min(...a.items.map(item=>item.block.order??item.index))) -
      (b.visual?.order??Math.min(...b.items.map(item=>item.block.order??item.index))));
    const ownership=new Map(),issues=[];
    if(operations>250000)issues.push({code:"STRUCTURE_BUDGET",id:"page"});
    if(geometry.structure?.inline?.complete===false)issues.push({code:"INLINE_BUDGET",id:"page"});
    for(const node of nodes){
      node.sourceIds=node.items.map(item=>item.id);
      node.evidence=node.grid?"table-rules":node.flow?"region":node.items.some(item=>item.block.tag)?"pdf-tag":"geometry";
      node.confidence=node.unresolvedInline||node.reason||!valid(node.rect)?"uncertain":"supported";
      node.relations={caption:node.visual?.captionId||null,headingLevel:node.items[0]?.block.headingLevel||null,
        cells:node.grid?.cells?.map(cell=>({id:cell.id,row:cell.row,column:cell.column,rowSpan:cell.rowSpan,colSpan:cell.colSpan}))||[]};
      for(const id of node.sourceIds){if(ownership.has(id))issues.push({code:"DUPLICATE_SOURCE",id});else ownership.set(id,node.id);}
      if(node.unresolvedInline)issues.push({code:"INLINE_UNRESOLVED",id:node.id});
    }
    for(const id of byId.keys())if(!ownership.has(id))issues.push({code:"SOURCE_UNASSIGNED",id});
    const tree=structured.readingLayout(nodes,{pageLayout:true});
    const visit=(part,path="root",lane=null)=>{
      if(part.kind==="node"){
        part.node.column=lane;part.node.path=path;return;
      }
      part.children.forEach((child,index)=>visit(child,path+"."+index,part.kind==="columns"?path+":"+index:lane));
    };
    visit(tree);
    return {version:VERSION,pageNumber:geometry.pageNumber,width:geometry.width,height:geometry.height,nodes,tree,issues,
      sourceCount:byId.size,tagged:nodes.some(node=>node.evidence==="pdf-tag"),complete:!issues.length&&nodes.every(node=>node.confidence==="supported")};
  }
  function prune(tree,allowed) {
    if(tree.kind==="node")return allowed.has(tree.node)?tree:null;
    const children=tree.children.map(child=>prune(child,allowed)).filter(Boolean);
    return children.length?{...tree,children}:null;
  }
  // 写入前的几何守卫；矩形是实际落笔范围，不使用定位按钮的大框作碰撞依据。
  function validator({width,height,limit=200000}) {
    let boxes=[],comparisons=0;const cells=new Map(),step=Math.max(width,height)/32;
    const keys=(box,page)=>{
      const out=[];
      for(let x=Math.max(0,Math.floor(box.x/step));x<=Math.min(32,Math.floor(box.right/step));x++)
        for(let y=Math.max(0,Math.floor(box.y/step));y<=Math.min(32,Math.floor(box.bottom/step));y++)out.push(page+":"+x+":"+y);
      return out;
    };
    const index=(entry,id)=>{for(const key of keys(entry.box,entry.page)){if(!cells.has(key))cells.set(key,[]);cells.get(key).push(id);}};
    const add=(box,{page,region,layer="content"})=>{
      if(!valid(box)||box.x<-.05||box.y<-.05||box.right>width+.05||box.bottom>height+.05)return "OUTPUT_BOUNDS";
      const neighbors=new Set(keys(box,page).flatMap(key=>cells.get(key)||[]));
      for(const id of neighbors){const previous=boxes[id];
        if(previous.page!==page||previous.region===region||previous.layer!==layer)continue;
        if(++comparisons>limit)return "VALIDATION_BUDGET";
        const area=overlap(previous.box,box),tolerance=Math.min(box.bottom-box.y,previous.box.bottom-previous.box.y)*.05;
        if(area>tolerance*tolerance&&Math.min(previous.box.bottom,box.bottom)-Math.max(previous.box.y,box.y)>tolerance&&
          Math.min(previous.box.right,box.right)-Math.max(previous.box.x,box.x)>tolerance)return "OUTPUT_OVERLAP";
      }
      const entry={box,page,region,layer};index(entry,boxes.length);boxes.push(entry);return null;
    };
    return {add,mark:()=>boxes.length,restore:length=>{boxes.length=length;cells.clear();boxes.forEach(index);},
      clear:()=>{boxes=[];cells.clear();comparisons=0;},count:()=>boxes.length};
  }
  global.BT_PDF_REFLOW_MODEL={VERSION,page,prune,validator};
})(typeof window!=="undefined"?window:self);
