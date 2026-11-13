(function(global) {
  "use strict";
  const validRect=r=>r&&[r.x,r.y,r.right,r.bottom].every(Number.isFinite)&&r.right>r.x&&r.bottom>r.y;
  const bounds=list=>({x:Math.min(...list.map(r=>r.x)),y:Math.min(...list.map(r=>r.y)),
    right:Math.max(...list.map(r=>r.right)),bottom:Math.max(...list.map(r=>r.bottom))});
  // 仅组织重排的显示副本；块 ID、翻译请求及修订身份保持原样。
  function groupPageRegions(input) {
    const nodes=[...input],available=n=>!n.flow&&!n.grid&&!n.visual&&n.items.length===1&&
      n.items[0].block.source!=="ocr"&&n.items[0].block.reliable&&validRect(n.items[0].block.rect);
    const plain=nodes.filter(available),removed=new Set();
    const email=/[^\s@]+@[^\s@]+\.[A-Za-z]{2,}/u;
    const mails=plain.filter(n=>email.test(n.items[0].block.text));
    // 用邮箱、短行、字号与连续的行带交叉确认作者区，支持 {a,b}@domain 共享邮箱。
    for(const seed of mails){
      if(removed.has(seed))continue;
      const size=seed.items[0].block.height;if(!(size>0))continue;
      let rect={...seed.items[0].block.rect},members=[seed],changed=true;
      while(changed&&members.length<128){
        changed=false;
        for(const node of plain){
          if(removed.has(node)||members.includes(node))continue;
          const b=node.items[0].block,r=b.rect;
          if(["heading","subheading","caption","list","header","footer"].includes(node.kind)||b.table||
            ["code","formula","measurement"].includes(b.role)||b.height>size*1.6||b.height<size*.45||b.text.length>400||/[.!?。！？]\s*$/u.test(b.text))continue;
          const distance=Math.max(0,rect.y-r.bottom,r.y-rect.bottom),overlap=Math.min(rect.right,r.right)-Math.max(rect.x,r.x);
          if(distance>size*2.5||overlap<=0)continue;
          members.push(node);rect=bounds([rect,r]);changed=true;
        }
      }
      const letters=members.filter(n=>n!==seed&&/\p{L}/u.test(n.items[0].block.text)&&!email.test(n.items[0].block.text));
      const before=letters.filter(n=>n.items[0].block.rect.bottom<=seed.items[0].block.rect.y+size);
      const evidence=before.reduce((n,node)=>n+Math.min(4,node.items[0].block.lines?.length||1),0);
      if(evidence<2||rect.bottom-rect.y>size*35)continue;
      // 整块复制不能夹入未归属的正文、表格或其他图片。
      if(input.some(node=>!members.includes(node)&&node.items.some(item=>{
        const r=item.block.rect;return validRect(r)&&r.x<rect.right&&r.right>rect.x&&r.y<rect.bottom&&r.bottom>rect.y;
      })))continue;
      for(const n of members)removed.add(n);
      const items=members.flatMap(n=>n.items).sort((a,b)=>a.block.order-b.block.order);
      nodes.push({id:seed.items[0].id+":authors",kind:"contributors",items,
        flow:{id:seed.items[0].id+":authors",type:"contributors",rect,sourceRect:rect,columns:1}});
    }
    // 行内关系由原生模型提供；这里不再用符号白名单进行第二次猜测。
    const free=plain.filter(n=>!removed.has(n));
    const headings=free.filter(n=>!removed.has(n)&&["heading","subheading"].includes(n.kind)).sort((a,b)=>a.items[0].block.rect.y-b.items[0].block.rect.y);
    for(let i=0;i<headings.length-1;i++){
      const a=headings[i],b=headings[i+1];if(removed.has(a)||removed.has(b)||a.kind!==b.kind)continue;
      const ar=bounds(a.items.map(i=>i.block.rect)),br=bounds(b.items.map(i=>i.block.rect)),size=a.items[0].block.height;
      if(Math.abs((ar.x+ar.right-br.x-br.right)/2)>size||br.y-ar.bottom>size*.8||br.y<ar.bottom-size*.2||
        Math.abs(b.items[0].block.height-size)>size*.15)continue;
      a.items.push(...b.items);a.joinedHeading=true;removed.add(b);
    }
    return nodes.filter(n=>!removed.has(n));
  }
  // 只派生可信的文本层级；没有单元格/合并证据时绝不拼造表格。
  function items(rows) {
    const heights=rows.filter(row=>row.block.eligible&&row.block.reliable).map(row=>row.block.height).filter(n=>n>0).sort((a,b)=>a-b);
    const median=heights[Math.floor(heights.length/2)]||12;
    // 无法可靠送翻的 OCR/损坏或旋转文字仅供检查，不把猜测文字混入阅读正文。
    return rows.map((row,index)=>{
      const {block,result}=row,success=["translated","unchanged"].includes(result?.status);
      let kind="paragraph";
      if(!block.table&&!block.flow&&block.reliable&&block.role==="text"&&(block.lines?.length||1)<=3&&block.text.length<180&&block.height>=median*1.4)
        kind=block.height>=median*1.8?"heading":"subheading";
      else if(!block.table&&block.reliable&&/^(?:[-•◦]|\d+[.)])\s/u.test(block.text))kind="list";
      else if(["number","symbol"].includes(block.role))kind="literal";
      else if(block.role!=="text")kind="protected";
      else if(!block.table&&!block.flow&&block.height<median*.85)kind="footnote";
      // 新原生模型已在拼段前确定层级；此处不得再用另一套字号规则覆盖它。
      if(block.structure?.version>=2&&block.kind&&(block.role==="text"||block.kind!=="paragraph"))kind=block.kind;
      else if(["heading","subheading","caption","header","footer","footnote","formula","code","list"].includes(block.kind))kind=block.kind;
      return {id:block.id,block,result,index,kind,success,
        text:success?result.text:(block.reliable||block.source==="ocr"||block.role!=="text"?(block.role==="code"?block.rawText||block.text:block.text):"文字层无法可靠提取，请查看左侧原文。")};
    }).filter(item=>!(!item.block.reliable&&!item.block.eligible&&!item.success)).sort((a,b)=>(Number.isFinite(a.block.order)?a.block.order:a.index)-(Number.isFinite(b.block.order)?b.block.order:b.index));

  }
  // 阅读区与导出共用结构节点，不从译文文案反推表格、作者或图形。
  function sections(rows,visuals=[],{pageLayout=false}={}) {
    const out=[],groups=new Map();
    for(const item of items(rows)){
      const grid=item.block.table,flow=item.block.flow;
      const descriptor=grid&&item.block.cell?grid:flow||visuals.find(v=>v.id===item.block.visualId);
      if(!descriptor){out.push({kind:item.kind,items:[item]});continue;}
      let node=groups.get(descriptor.id);
      if(!node){node={id:descriptor.id,kind:grid&&item.block.cell?"table":flow?.type||"figure",grid,flow,items:[]};groups.set(descriptor.id,node);out.push(node);}
      node.items.push(item);
    }
    for(const visual of visuals){let node=groups.get(visual.id);if(!node){node={id:visual.id,kind:"figure",items:[]};groups.set(visual.id,node);out.push(node);}node.visual=visual;}
    const nodes=pageLayout?groupPageRegions(out):out;
    return nodes.sort((a,b)=>(a.visual?.order??a.items[0]?.block.order??a.items[0]?.index??Infinity)-(b.visual?.order??b.items[0]?.block.order??b.items[0]?.index??Infinity));
  }
  // 自动重排与编辑稿共用的区域树：坐标用于辨认区域，不把译文锁在原始文字框内。
  // 此模块仅保留结构模型，旧的逐段 DOM 编辑器已经删除。
  function readingLayout(nodes,{pageLayout=false}={}) {
    const valid=r=>r&&[r.x,r.y,r.right,r.bottom].every(Number.isFinite)&&r.right>r.x&&r.bottom>r.y;
    const union=rects=>({x:Math.min(...rects.map(r=>r.x)),y:Math.min(...rects.map(r=>r.y)),
      right:Math.max(...rects.map(r=>r.right)),bottom:Math.max(...rects.map(r=>r.bottom))});
    const entries=nodes.map((node,index)=>{
      const rects=[node.grid?.rect,node.flow?.rect,node.visual?.rect,...node.items.map(item=>item.block.rect)].filter(valid);
      return {node,index,rect:rects.length?union(rects):null};
    });
    const heights=nodes.flatMap(node=>node.items.map(item=>item.block.height)).filter(n=>n>0&&Number.isFinite(n)).sort((a,b)=>a-b);
    const em=heights[Math.floor(heights.length/2)]||12;
    const leaf=entry=>({kind:"node",node:entry.node,rect:entry.rect});
    function split(list,depth=0) {
      const rect=list.length&&list.every(e=>e.rect)?union(list.map(e=>e.rect)):null;
      const stack=()=>({kind:"stack",rect,children:list.map(leaf)});
      if(list.length<2||depth>=10||!rect)return stack();
      // 全区域贯通的空白才可作为栏间隔；宽标题自然阻断此切分，先经水平分区处理。
      const gaps=axis=>{
        const end=axis==="x"?"right":"bottom",sorted=[...list].sort((a,b)=>a.rect[axis]-b.rect[axis]),out=[];
        let edge=sorted[0].rect[end];
        for(const item of sorted.slice(1)){
          const gap=item.rect[axis]-edge;
          if(gap>=em*(axis==="x" ? .75 : 1))out.push({cut:(edge+item.rect[axis])/2,gap});
          edge=Math.max(edge,item.rect[end]);
        }
        return out.sort((a,b)=>b.gap-a.gap);
      };
      for(const {cut} of gaps("x")){
        const left=list.filter(e=>e.rect.right<=cut),right=list.filter(e=>e.rect.x>=cut);
        if(!left.length||!right.length||left.length+right.length!==list.length)continue;
        const a=union(left.map(e=>e.rect)),b=union(right.map(e=>e.rect));
        // 孤立的两个短标签不构造正文栏；不从无边界的零散文字猜表格。
        const overlap=Math.min(a.bottom,b.bottom)-Math.max(a.y,b.y);
        if(Math.min(a.right-a.x,b.right-b.x)<em*8||overlap<3*em)continue;
        const lanes=[left,right].sort((a,b)=>Math.min(...a.map(e=>e.index))-Math.min(...b.map(e=>e.index)));
        const children=lanes.map(lane=>split(lane,depth+1));
        // 固定每栏的区域宽度，后续短标题、首行缩进和行内小字不得重新压窄栏目。
        for(const child of children)child.lane={x:child.rect.x,right:child.rect.right};
        return {kind:"columns",rect,direction:lanes[0]===left?"ltr":"rtl",children};
      }
      for(const {cut} of gaps("y")){
        const top=list.filter(e=>e.rect.bottom<=cut),bottom=list.filter(e=>e.rect.y>=cut);
        if(top.length&&bottom.length&&top.length+bottom.length===list.length)
          return {kind:"stack",rect,children:[split(top,depth+1),split(bottom,depth+1)]};
      }
      return stack();
    }
    return split(entries);
  }
  global.BT_PDF_STRUCTURED={items,sections,readingLayout};
})(typeof window!=="undefined"?window:self);
