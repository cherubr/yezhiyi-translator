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
  // 连续阅读独立排版：坐标只用于辨认区域，不把译文锁在原始文字框内。
  // 表格、代码、作者组与图形均为不可拆分节点；导出仍使用 sections 的既有接口。
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
  function create({host,onSave,onRestore,onLocate,onVisual=()=>false}) {
    const cards=new Map(),tables=new Map(),flows=new Map(),regions=new Map(),drafts=new Map(),pending=new Set(),errors=new Map();let rows=[],scope="",selected=null,visuals=[];
    const key=id=>scope+":"+id;
    function render(next,nextScope=scope,nextVisuals=visuals) {
      if(nextScope!==scope){scope=nextScope;cards.clear();tables.clear();flows.clear();regions.clear();host.replaceChildren();}
      rows=next;visuals=nextVisuals;const model=items(rows),keep=new Set(model.map(item=>item.id));
      for(const [id,card] of cards)if(!keep.has(id)){card.element.remove();cards.delete(id);}
      host.querySelector(".structured-empty")?.remove();
      if(!model.length&&!visuals.length){const empty=document.createElement("p");empty.className="structured-empty";
        empty.textContent=rows.length?"本页没有可可靠展示的文字，请查看原文或翻译检查。":"点击开始翻译后，在此连续阅读本页译文。";
        host.replaceChildren(empty);return;}
      model.forEach((item,index)=>{
        let card=cards.get(item.id);
        if(!card){
          const element=document.createElement("article"),text=document.createElement("div"),actions=document.createElement("div"),note=document.createElement("p"),
            editor=document.createElement("textarea"),edit=document.createElement("button"),restore=document.createElement("button"),save=document.createElement("button"),cancel=document.createElement("button");
          element.className="structured-block";element.dataset.blockId=item.id;element.tabIndex=0;element.setAttribute("aria-label","译文段落，按 Enter 定位原文");
          text.className="structured-text";text.dir="auto";actions.className="structured-actions";note.className="structured-note";
          editor.className="structured-editor";editor.dir="auto";editor.setAttribute("aria-label","编辑本段译文");editor.maxLength=32000;
          for(const [button,label] of [[edit,"编辑"],[restore,"恢复机器翻译"],[save,"保存"],[cancel,"取消"]]){button.type="button";button.textContent=label;actions.append(button);}
          element.append(text,note,editor,actions);card={element,text,actions,note,editor,edit,restore,save,cancel};cards.set(item.id,card);
          edit.onclick=()=>{
            if(drafts.size>=50&&!drafts.has(key(item.id))){note.textContent="未保存的编辑过多，请先保存已有修改";return;}
            const current=rows.find(row=>row.block.id===item.id);drafts.set(key(item.id),{text:current.result.text,pending:false,error:""});render(rows);editor.focus();
          };
          editor.oninput=()=>{const draft=drafts.get(key(item.id));if(draft)draft.text=editor.value;};
          cancel.onclick=()=>{drafts.delete(key(item.id));render(rows);edit.focus();};
          const commit=async restoring=>{
            const savedKey=key(item.id),draft=drafts.get(savedKey);
            if(draft?.pending||pending.has(savedKey))return;
            if(!restoring&&!draft?.text.trim()){note.textContent="译文不能为空";editor.focus();return;}
            pending.add(savedKey);errors.delete(savedKey);if(draft)draft.pending=true;save.disabled=cancel.disabled=restore.disabled=true;editor.disabled=true;
            try{await (restoring?onRestore(item.id):onSave(item.id,draft.text));drafts.delete(savedKey);}
            catch(error){if(draft){draft.pending=false;draft.error=error.message;}else errors.set(savedKey,error.message);}
            finally{pending.delete(savedKey);if(savedKey===key(item.id)){render(rows);if(drafts.has(savedKey))editor.focus();}}
          };
          save.onclick=()=>void commit(false);restore.onclick=()=>void commit(true);
          element.addEventListener("click",event=>{if(!event.target.closest("button,textarea,details,summary"))onLocate(item.id);});
          element.addEventListener("keydown",event=>{if(event.target===element&&(event.key==="Enter"||event.key===" ")){event.preventDefault();onLocate(item.id);}});
        }
        card.text.className="structured-text structured-"+item.kind;card.text.setAttribute("role",["heading","subheading"].includes(item.kind)?"heading":"paragraph");
        if(["heading","subheading"].includes(item.kind))card.text.setAttribute("aria-level",item.kind==="heading"?"2":"3");else card.text.removeAttribute("aria-level");
        if(card.text.textContent!==item.text)card.text.textContent=item.text;
        const draft=drafts.get(key(item.id)),editable=item.success&&item.block.eligible&&item.block.role==="text";
        card.editor.hidden=!draft;card.text.hidden=!!draft;card.edit.hidden=!editable||!!draft;card.restore.hidden=!item.result?.userEdited||!!draft;
        card.save.hidden=card.cancel.hidden=!draft;card.save.disabled=card.cancel.disabled=card.editor.disabled=!!draft?.pending;card.restore.disabled=pending.has(key(item.id));
        if(draft&&card.editor.value!==draft.text)card.editor.value=draft.text;
        const retained=item.result?.status==="skipped"&&item.block.reliable&&item.block.role!=="text";
        card.element.title=retained?item.result.reason||"保留原文":"";
        card.note.textContent=draft?.error||errors.get(key(item.id))||(draft?.pending?"正在保存…":item.result?.userEdited?"已修改":item.success||retained?"":
          item.result?.status==="failed"?"翻译失败："+item.result.reason:item.result?.status==="skipped"?"保留原文："+item.result.reason:"尚未翻译");
        card.element.dataset.status=item.success?"translated":item.result?.status||"pending";
        card.actions.hidden=!editable&&!draft&&!item.result?.userEdited;card.element.dataset.table=String(!!item.block.table);card.element.dataset.kind=item.kind;
      });
      arrange(model);highlight(selected);
    }
    // 普通段落与真实表格共用同一套段落节点，保留编辑、编号与定位事件。
    function arrange(model) {
      const roots=[],used=new Set(),usedFlows=new Set(),contents=new Map(),usedCodeLines=new Map(),codeEnds=new Map();
      for(const item of model){
        const card=cards.get(item.id).element,grid=item.block.table,cell=item.block.cell;
        if(!grid||!cell){
          const visual=visuals.find(v=>v.id===item.block.visualId),flow=item.block.flow||(visual?{id:visual.id,type:"figure"}:null);
          if(!flow){roots.push(card);continue;}
          let group=flows.get(flow.id);
          if(!group){
            const wrapper=document.createElement("section"),body=document.createElement("div"),lanes=[];
            wrapper.className="structured-group structured-"+flow.type;wrapper.dataset.structureId=flow.id;
            if(flow.type==="figure"){
              const details=document.createElement("details"),summary=document.createElement("summary"),note=document.createElement("p");
              details.className="structured-figure-labels";summary.textContent="图中标注";
              note.className="structured-note";note.textContent="图形与连线请参照左侧原图；下方为对应文字。";details.append(summary,note,body);
              group={wrapper,body,lanes,lines:new Map(),summary,details};
            }else if(flow.type==="code"){
              body.className="structured-code-lines";wrapper.setAttribute("aria-label","代码与对应注释");group={wrapper,body,lanes,lines:new Map()};
            }else{
              body.className="structured-contributor-columns";
              for(let i=0;i<flow.columns;i++){const lane=document.createElement("div");body.append(lane);lanes.push(lane);}
              group={wrapper,body,lanes,lines:new Map()};
            }
            if(flow.type==="figure")wrapper.append(group.details);else wrapper.append(body);flows.set(flow.id,group);
          }
          if(!usedFlows.has(flow.id)){usedFlows.add(flow.id);roots.push(group.wrapper);}
          let target=group.lanes[flow.column]||group.body;
          if(flow.type==="code"){
            const key=flow.part||item.id;
            let line=group.lines.get(key);
            if(!line){const element=document.createElement("div"),code=document.createElement("div"),comment=document.createElement("div");
              element.className="structured-code-line";code.className="structured-code-source";comment.className="structured-code-comment";
              code.dir="ltr";
              element.append(code,comment);group.body.append(element);line={element,code,comment};group.lines.set(key,line);}
            if(!usedCodeLines.has(flow.id))usedCodeLines.set(flow.id,new Set());usedCodeLines.get(flow.id).add(key);
            if(!contents.has(group.body))contents.set(group.body,[]);
            if(!contents.get(group.body).includes(line.element))contents.get(group.body).push(line.element);
            target=item.block.codeRole==="comment"?line.comment:line.code;
            // 只为阅读显示恢复行首缩进；原生代码字符与原页坐标不改写。
            if(item.block.codeRole==="code"){
              const start=codeEnds.get(target)??flow.rect.x;
              card.style.marginInlineStart=Math.max(0,(item.block.rect.x-start)/Math.max(1,item.block.height))+"em";
              codeEnds.set(target,item.block.rect.right);
            }else card.style.marginInlineStart="";
          }
          if(!contents.has(target))contents.set(target,[]);contents.get(target).push(card);continue;
        }
        let table=tables.get(grid.id);
        if(!table){
          const wrapper=document.createElement("div"),element=document.createElement("table"),cols=document.createElement("colgroup"),body=document.createElement("tbody"),cells=new Map();
          wrapper.className="structured-table-wrap";wrapper.dataset.structureId=grid.id;wrapper.tabIndex=0;wrapper.setAttribute("aria-label","译文表格，可横向滚动");
          element.className="structured-table";element.style.minWidth=(grid.columns*10)+"em";
          for(const fraction of grid.widths){const col=document.createElement("col");col.style.width=(fraction*100)+"%";cols.append(col);}
          const rows=Array.from({length:grid.rows},()=>{const row=document.createElement("tr");body.append(row);return row;});
          for(const descriptor of grid.cells){const td=document.createElement("td");td.rowSpan=descriptor.rowSpan;td.colSpan=descriptor.colSpan;rows[descriptor.row].append(td);cells.set(descriptor.id,td);}
          element.append(cols,body);wrapper.append(element);table={wrapper,cells};tables.set(grid.id,table);
        }
        if(!used.has(grid.id)){used.add(grid.id);roots.push(table.wrapper);}
        const target=table.cells.get(cell.id);if(!target){roots.push(card);continue;}
        if(!contents.has(target))contents.set(target,[]);contents.get(target).push(card);
      }
      for(const visual of visuals){
        let group=flows.get(visual.id);
        if(!group){const wrapper=document.createElement("section"),body=document.createElement("div");
          wrapper.className="structured-group structured-figure";wrapper.dataset.structureId=visual.id;wrapper.append(body);
          group={wrapper,body,lanes:[]};flows.set(visual.id,group);}
        if(!group.media){const media=document.createElement("canvas");media.className="structured-visual";media.setAttribute("role","img");
          media.setAttribute("aria-label","保留的原始图形");media.tabIndex=0;group.wrapper.prepend(media);group.media=media;
          const locate=()=>{if(visual.captionId)onLocate(visual.captionId);};media.onclick=locate;
          media.onkeydown=event=>{if(event.key==="Enter"||event.key===" "){event.preventDefault();locate();}};}
        if(onVisual(group.media,visual)){
          const note=group.wrapper.querySelector(":scope > .structured-note");if(note)note.textContent="原始图形已保留，以下为关联文字。";
        }
        if(!usedFlows.has(visual.id)){usedFlows.add(visual.id);roots.push(group.wrapper);}
      }
      for(const [parent,children] of contents)children.forEach((child,index)=>{if(parent.children[index]!==child)parent.insertBefore(child,parent.children[index]||null);});
      for(const [id,table] of tables)if(!used.has(id)){table.wrapper.remove();tables.delete(id);}
      for(const [id,group] of flows)if(!usedFlows.has(id)){if(group.media)group.media.width=group.media.height=0;group.wrapper.remove();flows.delete(id);}
      for(const [id,group] of flows)if(group.lines)for(const [key,line] of group.lines)if(!usedCodeLines.get(id)?.has(key)){line.element.remove();group.lines.delete(key);}
      for(const group of flows.values())if(group.summary)group.summary.textContent="图中标注（"+(group.body.children.length||0)+"）";
      const rootMap=new Map(roots.map(element=>[element.dataset.structureId||element.dataset.blockId,element])),usedRegions=new Set();
      const place=(parent,children)=>children.forEach((child,index)=>{if(parent.children[index]!==child)parent.insertBefore(child,parent.children[index]||null);});
      const build=(node,path)=>{
        if(node.kind==="node")return rootMap.get(node.node.id||node.node.items[0]?.id);
        let region=regions.get(path);
        if(!region){region=document.createElement("div");regions.set(path,region);}
        usedRegions.add(path);region.className="structured-region structured-region-"+node.kind;
        region.dir=node.direction||"ltr";
        if(node.kind==="columns")region.style.gridTemplateColumns=node.children.map(child=>Math.max(1,child.rect.right-child.rect.x)+"fr").join(" ");
        else region.style.removeProperty("grid-template-columns");
        const children=node.children.map((child,index)=>build(child,path+":"+index)).filter(Boolean);
        place(region,children);
        // 先移动仍有效的段落，再移除过时容器，编辑器与选中身份不会重建。
        for(const child of [...region.children])if(!children.includes(child))child.remove();
        return region;
      };
      const page=build(readingLayout(sections(rows,visuals)),"page");place(host,[page]);
      for(const [path,region] of regions)if(!usedRegions.has(path)){region.remove();regions.delete(path);}
      for(const child of [...host.children])if(child!==page)child.remove();
    }
    function highlight(id){selected=id;for(const [key,card] of cards){card.element.classList.toggle("structured-selected",key===id);if(key===id)card.element.setAttribute("aria-current","true");else card.element.removeAttribute("aria-current");}}
    function reveal(id){const card=cards.get(id);if(!card)return;card.element.scrollIntoView({block:"nearest",behavior:"auto"});card.element.focus({preventScroll:true});highlight(id);}
    function refreshVisuals(){for(const visual of visuals){const media=flows.get(visual.id)?.media;if(media)onVisual(media,visual);}}
    return {render,highlight,reveal,refreshVisuals,hasDrafts:()=>drafts.size>0,discardDrafts(){drafts.clear();render(rows);},clear(){
      for(const group of flows.values())if(group.media)group.media.width=group.media.height=0;
      drafts.clear();errors.clear();cards.clear();tables.clear();flows.clear();regions.clear();host.replaceChildren();rows=[];visuals=[];scope="";selected=null;}};
  }
  global.BT_PDF_STRUCTURED={items,sections,readingLayout,create};
})(typeof window!=="undefined"?window:self);
