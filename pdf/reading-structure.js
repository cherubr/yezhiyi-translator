(function(global) {
  "use strict";
  // 只用页面几何与文字尺度确认有线表格；无边界证据时保留原有正文/分栏路径。
  const median=values=>{const sorted=values.filter(n=>n>0&&Number.isFinite(n)).sort((a,b)=>a-b);return sorted[Math.floor(sorted.length/2)]||1;};
  const overlap=(a,b,c,d)=>Math.max(0,Math.min(b,d)-Math.max(a,c));
  // 在拼行前建立附标组件：比较真实字号、基线、方向及空间连续性，不使用符号白名单。
  // 每个组件只能有一个明确宿主；有歧义时保留证据，交给重排区域守卫处理。
  function inlineFragments(fragments) {
    const usable=fragments.filter(f=>!f.reason&&Number.isFinite(f.baseline)&&f.height>0),byIndex=new Map(usable.map(f=>[f.index,f]));
    const em=median(usable.map(f=>f.height)),bucketSize=em*2,buckets=new Map(),ends=new Map();let comparisons=0;
    const compatible=(a,b)=>a.direction===b.direction&&a.cell?.id===b.cell?.id&&a.flow?.id===b.flow?.id&&a.flow?.column===b.flow?.column&&
      (!a.tag||!b.tag||a.tag.group===b.tag.group);
    const key=(x,y)=>x+":"+y;
    for(const f of usable){const k=key(Math.floor(f.rect.x/bucketSize),Math.floor(f.baseline/bucketSize));
      if(!buckets.has(k))buckets.set(k,[]);buckets.get(k).push(f);
      const e=key(Math.floor((f.direction==="rtl"?f.rect.x:f.rect.right)/bucketSize),Math.floor(f.baseline/bucketSize));
      if(!ends.has(e))ends.set(e,[]);ends.get(e).push(f);}
    const nearby=f=>{
      const out=[],x=Math.floor(f.rect.right/bucketSize),y=Math.floor(f.baseline/bucketSize),radius=Math.min(8,Math.ceil(f.height/bucketSize)+1);
      for(let dx=-radius;dx<=radius;dx++)for(let dy=-radius;dy<=radius;dy++)out.push(...(buckets.get(key(x+dx,y+dy))||[]));
      return out;
    };
    const roots=new Map(usable.map(f=>[f.index,f.index]));
    const root=id=>{let next=id;while(roots.get(next)!==next)next=roots.get(next);while(id!==next){const old=roots.get(id);roots.set(id,next);id=old;}return next;};
    // 同字号、同基线、紧邻的多个 PDF 项先组成候选（如多位下标及其中的标点）。
    for(const f of usable){
      for(const other of nearby(f)){
        if(++comparisons>250000)return {complete:false,groups:0};
        if(other===f||!compatible(f,other)||Math.min(f.height,other.height)/Math.max(f.height,other.height)<.85||
          Math.abs(f.baseline-other.baseline)>Math.min(f.height,other.height)*.2)continue;
        const gap=other.rect.x-f.rect.right;
        if(gap<-.1*f.height||gap>Math.min(f.height,other.height)*.3)continue;
        roots.set(root(other.index),root(f.index));
      }
    }
    const clusters=new Map();for(const f of usable){const id=root(f.index);if(!clusters.has(id))clusters.set(id,[]);clusters.get(id).push(f);}
    const groups=[...clusters.values()].map(members=>({members,height:median(members.map(f=>f.height)),baseline:members.map(f=>f.baseline).sort((a,b)=>a-b)[Math.floor(members.length/2)],
      rect:{x:Math.min(...members.map(f=>f.rect.x)),y:Math.min(...members.map(f=>f.rect.y)),right:Math.max(...members.map(f=>f.rect.right)),bottom:Math.max(...members.map(f=>f.rect.bottom))}}));
    let count=0;
    for(const candidate of groups.sort((a,b)=>b.height-a.height)){
      const first=candidate.members[0],choices=[];
      // 大片同字号正文不可能是行内附标；限制来自相对几何而非字符内容。
      if(candidate.rect.right-candidate.rect.x>candidate.height*10)continue;
      for(const member of candidate.members){
        // 搜索候选左缘附近的宿主右缘，使用空间桶避免对整页反复全量排序。
        const x=Math.floor((first.direction==="rtl"?candidate.rect.right:candidate.rect.x)/bucketSize),y=Math.floor(candidate.baseline/bucketSize);
        for(let dx=-2;dx<=2;dx++)for(let dy=-2;dy<=2;dy++)for(const host of ends.get(key(x+dx,y+dy))||[]){
          if(++comparisons>500000)return {complete:false,groups:count};
          const symbolOnly=candidate.members.every(f=>!/[\p{L}\p{N}]/u.test(f.text))&&candidate.rect.right-candidate.rect.x<candidate.height;
          const shift=candidate.baseline-host.baseline,vertical=overlap(candidate.rect.y,candidate.rect.bottom,host.rect.y,host.rect.bottom);
          const gap=host.direction==="rtl"?host.rect.x-candidate.rect.right:candidate.rect.x-host.rect.right;
          const shifted=candidate.rect.right-candidate.rect.x<host.height*1.5&&Math.abs(shift)>=host.height*.2&&
            Math.abs(shift)<=host.height*.6&&vertical>=candidate.height*.55&&gap<=host.height*.25;
          if(root(host.index)===root(member.index)||!compatible(first,host)||candidate.height>host.height*(symbolOnly||shifted?1.05:.9)||
            !/[\p{L}\p{N}]/u.test(host.text))continue;
          if(Math.abs(shift)<host.height*.12||Math.abs(shift)>host.height*.85||vertical<=0)continue;
          if(gap<-.15*host.height||gap>host.height*.65)continue;
          if(!choices.some(c=>c.host.index===host.index))choices.push({host,score:Math.abs(gap)/host.height+Math.abs(shift)/host.height*.15});
        }
        break;
      }
      choices.sort((a,b)=>a.score-b.score);
      if(!choices.length)continue;
      if(choices[1]&&choices[1].score-choices[0].score<.12){for(const f of candidate.members)f.inlineUncertain=true;continue;}
      let host=choices[0].host,depth=0;
      while(host.inlineOwner!==undefined&&depth++<8)host=byIndex.get(host.inlineOwner)||host;
      if(depth>8||candidate.members.includes(host)){for(const f of candidate.members)f.inlineUncertain=true;continue;}
      for(const f of candidate.members){f.inlineOwner=host.index;f.rowBaseline=host.baseline;f.inlineGroup="inline:"+host.index;}
      count++;
    }
    return {complete:true,groups:count};
  }
  function detect(fragments,rules,pageNumber) {
    const em=median(fragments.map(item=>item.height)),tolerance=em*.2;
    let horizontal=[],vertical=[];
    for(const rect of (rules||[]).slice(0,2000)){
      const w=rect.right-rect.x,h=rect.bottom-rect.y;
      if(w>=em*3&&h<=tolerance)horizontal.push({index:horizontal.length,axis:(rect.y+rect.bottom)/2,start:rect.x,end:rect.right});
      else if(h>=em*2&&w<=tolerance)vertical.push({axis:(rect.x+rect.right)/2,start:rect.y,end:rect.bottom});
    }
    // 单条表线可能按单元格分别描绘，且描边/包围盒会重复上报。先合并共线且接续的线段。
    // 容差来自页面文字尺度；不跨越真实空隙，不按某份文件的坐标或列数拼接。
    const stitch=lines=>{
      const axes=[];
      for(const line of [...lines].sort((a,b)=>a.axis-b.axis||a.start-b.start)){
        let group=axes[axes.length-1];
        if(!group||Math.abs(group.axis-line.axis)>tolerance){group={axis:line.axis,segments:[]};axes.push(group);}
        group.segments.push(line);
      }
      const merged=[];
      for(const group of axes){let run=null;
        for(const line of group.segments.sort((a,b)=>a.start-b.start||a.end-b.end)){
          if(run&&line.start<=run.end+tolerance)run.end=Math.max(run.end,line.end);
          else {run={axis:group.axis,start:line.start,end:line.end};merged.push(run);}
        }
      }
      return merged.map((line,index)=>({...line,index}));
    };
    horizontal=stitch(horizontal);vertical=stitch(vertical);
    const unique=values=>values.sort((a,b)=>a-b).reduce((list,value)=>{if(!list.length||value-list[list.length-1]>tolerance)list.push(value);return list;},[]);
    const coverage=(lines,axis,start,end)=>{
      const spans=lines.filter(line=>Math.abs(line.axis-axis)<=tolerance).map(line=>[Math.max(start,line.start),Math.min(end,line.end)])
        .filter(([a,b])=>b>a).sort((a,b)=>a[0]-b[0]);
      let covered=0,edge=start;
      for(const [a,b] of spans){covered+=Math.max(0,b-Math.max(edge,a));edge=Math.max(edge,b);}
      return covered>=Math.max(0,end-start-tolerance*2);
    };
    const tables=[],examined=new Set();
    // 最宽边界先行，已确认区域内不再重复创建子表格。宽度只决定搜索顺序，不决定是否为表格。
    for(const seed of [...horizontal].sort((a,b)=>(b.end-b.start)-(a.end-a.start))){
      if(tables.length>=16)break;
      if(tables.some(table=>seed.axis>=table.rect.y-tolerance&&seed.axis<=table.rect.bottom+tolerance&&seed.start>=table.rect.x-tolerance&&seed.end<=table.rect.right+tolerance))continue;
      const aligned=horizontal.filter(line=>Math.abs(line.start-seed.start)<=tolerance&&Math.abs(line.end-seed.end)<=tolerance);
      if(aligned.length<3)continue;
      const key=aligned.map(line=>line.index).join(":");if(examined.has(key))continue;examined.add(key);
      const baseYs=unique(aligned.map(line=>line.axis));if(baseYs.length<3||baseYs.length>257)continue;
      const splits=vertical.filter(line=>{
        if(line.axis<=seed.start+tolerance||line.axis>=seed.end-tolerance)return false;
        let crossed=0;return aligned.some(h=>h.axis>=line.start-tolerance&&h.axis<=line.end+tolerance&&++crossed>=2);
      });
      if(!splits.length)continue;
      const top=Math.min(...splits.map(line=>line.start)),bottom=Math.max(...splits.map(line=>line.end));
      const hs=horizontal.filter(line=>line.axis>=top-tolerance&&line.axis<=bottom+tolerance&&line.start>=seed.start-tolerance&&line.end<=seed.end+tolerance);
      const xs=unique([seed.start,...splits.map(line=>line.axis),seed.end]);
      let ys=unique(hs.map(line=>line.axis));
      const cols=xs.length-1;
      if(cols<2||ys.length<3)continue;
      // 开放底边：至少两条不同列分界在同一位置终止，且横向边界已反复确认。
      // 使用真实竖线终点补齐最后一行，不用最后一条横线截掉整行正文。
      const endGroups=[];
      for(const line of splits){let group=endGroups.find(group=>Math.abs(group.value-line.end)<=tolerance);
        if(!group){group={value:line.end,axes:new Set()};endGroups.push(group);}group.axes.add(line.axis);}
      const openBottom=endGroups.filter(group=>group.axes.size>=2&&group.value>ys[ys.length-1]+em).sort((a,b)=>b.value-a.value)[0];
      if(openBottom)ys=unique([...ys,openBottom.value]);
      // 表头可能只画下边线：要求同一文字行在多个独立列内都有完整文字，才能恢复开放表头。
      const firstRule=ys[0],headerGroups=[];
      for(const fragment of fragments){
        const rect=fragment.rect;
        if(rect.bottom>firstRule+tolerance||rect.y<firstRule-em*3)continue;
        const col=xs.findIndex((x,i)=>i<cols&&rect.x>=x-tolerance&&rect.right<=xs[i+1]+tolerance);
        if(col<0)continue;
        let group=headerGroups.find(group=>Math.abs(group.baseline-fragment.baseline)<=tolerance);
        if(!group){group={baseline:fragment.baseline,items:[],columns:new Set()};headerGroups.push(group);}
        group.items.push(fragment);group.columns.add(col);
      }
      const header=headerGroups.filter(group=>group.columns.size>=2&&group.columns.size>=cols/2).sort((a,b)=>b.baseline-a.baseline)[0];
      let openTop=false;
      if(header){
        const inset=fragments.filter(item=>item.rect.y>=firstRule&&item.rect.y<ys[1]).map(item=>item.rect.y-firstRule).filter(n=>n>0);
        const padding=inset.length?Math.min(em,Math.min(...inset)):tolerance;
        ys=unique([Math.min(...header.items.map(item=>item.rect.y))-padding,...ys]);openTop=true;
      }
      const rows=ys.length-1;
      if(rows<2||rows*cols>256||(!openTop&&!coverage(hs,ys[0],xs[0],xs[cols]))||(!openBottom&&!coverage(hs,ys[rows],xs[0],xs[cols])))continue;
      const rect={x:xs[0],y:ys[0],right:xs[cols],bottom:ys[rows]};
      const inside=fragments.filter(item=>item.rect.x>=rect.x-tolerance&&item.rect.right<=rect.right+tolerance&&item.rect.y>=rect.y-tolerance&&item.rect.bottom<=rect.bottom+tolerance);
      if(inside.length<4)continue;
      const occupied=new Set(inside.map(item=>{const cx=(item.rect.x+item.rect.right)/2,cy=(item.rect.y+item.rect.bottom)/2;
        return (ys.findIndex((y,i)=>i<rows&&cy>=y&&cy<=ys[i+1]))+":"+(xs.findIndex((x,i)=>i<cols&&cx>=x&&cx<=xs[i+1]));}));
      if(new Set([...occupied].map(key=>key.split(":")[0])).size<2||new Set([...occupied].map(key=>key.split(":")[1])).size<2)continue;
      const parent=Array.from({length:rows*cols},(_,i)=>i),root=i=>{while(parent[i]!==i){parent[i]=parent[parent[i]];i=parent[i];}return i;};
      const join=(a,b)=>{parent[root(a)]=root(b);};
      for(let row=0;row<rows;row++)for(let col=0;col<cols;col++){
        const index=row*cols+col;
        if(col+1<cols&&!(openTop&&row===0)&&!coverage(vertical,xs[col+1],ys[row],ys[row+1]))join(index,index+1);
        if(row+1<rows&&!coverage(hs,ys[row+1],xs[col],xs[col+1]))join(index,index+cols);
      }
      const groups=new Map();
      for(let i=0;i<parent.length;i++){const key=root(i);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(i);}
      const id=pageNumber+":grid:"+rect.x.toFixed(2)+":"+rect.y.toFixed(2),cells=[];let ambiguous=false;
      for(const indices of groups.values()){
        const r0=Math.min(...indices.map(i=>Math.floor(i/cols))),r1=Math.max(...indices.map(i=>Math.floor(i/cols))),
          c0=Math.min(...indices.map(i=>i%cols)),c1=Math.max(...indices.map(i=>i%cols));
        // L 形等非矩形连通区域不能解释成合并单元格，整组退回正文而不伪造结构。
        if(indices.length!==(r1-r0+1)*(c1-c0+1)){ambiguous=true;break;}
        cells.push({id:id+":"+r0+":"+c0,row:r0,column:c0,rowSpan:r1-r0+1,colSpan:c1-c0+1,
          rect:{x:xs[c0],y:ys[r0],right:xs[c1+1],bottom:ys[r1+1]}});
      }
      if(ambiguous||cells.length<4)continue;
      // 跨过内部边界的原生文字说明网格假设与文本冲突，不截断文字以凑表格。
      if(inside.some(item=>!cells.some(cell=>item.rect.x>=cell.rect.x-tolerance&&item.rect.right<=cell.rect.right+tolerance&&item.rect.y>=cell.rect.y-tolerance&&item.rect.bottom<=cell.rect.bottom+tolerance)))continue;
      if(tables.some(table=>overlap(rect.x,rect.right,table.rect.x,table.rect.right)*overlap(rect.y,rect.bottom,table.rect.y,table.rect.bottom)>0))continue;
      tables.push({id,rect,rows,columns:cols,widths:xs.slice(1).map((x,i)=>(x-xs[i])/(rect.right-rect.x)),cells:cells.sort((a,b)=>a.row-b.row||a.column-b.column)});
    }
    return tables;
  }
  function assign(item,tables) {
    for(const table of tables){
      const tolerance=item.height*.2,rect=item.rect;
      const cell=table.cells.find(cell=>rect.x>=cell.rect.x-tolerance&&rect.right<=cell.rect.right+tolerance&&rect.y>=cell.rect.y-tolerance&&rect.bottom<=cell.rect.bottom+tolerance);
      if(cell){item.table=table;item.cell=cell;return;}
    }
  }
  // 邮箱为多作者区域提供明确的列锚点。只在相邻邮箱行附近分栏，绝不把整页正文按邮箱切列。
  function contributors(fragments,pageNumber) {
    const emails=fragments.filter(f=>!f.reason&&!f.table&&/^[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\s*$/u.test(f.text));
    if(emails.length>128)return; // 大型地址名录保持既有路径，不做无界的作者区域搜索。
    const bands=[];
    for(const email of emails.sort((a,b)=>a.baseline-b.baseline)){
      let band=bands.find(b=>Math.abs(b.baseline-email.baseline)<Math.min(b.height,email.height)*.5);
      if(!band){band={baseline:email.baseline,height:email.height,emails:[]};bands.push(band);}band.emails.push(email);
    }
    for(const band of bands){
      if(band.emails.length<2&&!bands.some(other=>other.emails.length>=2))continue;
      const anchors=band.emails.sort((a,b)=>a.rect.x-b.rect.x),em=median(anchors.map(f=>f.height));
      const previous=bands.filter(b=>b.baseline<band.baseline-em).at(-1);
      const top=Math.max(previous?previous.baseline+em:0,band.baseline-em*4);
      const rect={x:anchors[0].rect.x-em*2,y:top,right:anchors.at(-1).rect.right+em*2,bottom:Math.max(...anchors.map(f=>f.rect.bottom))+em*.3};
      const id=pageNumber+":contributors:"+anchors.map(f=>f.index).join("-");
      const members=fragments.filter(f=>!f.table&&!f.reason&&f.rect.y>=top&&f.rect.bottom<=rect.bottom&&f.rect.x>=rect.x&&f.rect.right<=rect.right);
      // 完整文本必须落在某一邮箱列周围；横跨多列的标题不会归入作者。
      const centers=anchors.map(f=>(f.rect.x+f.rect.right)/2);
      for(const f of members){
        const col=centers.findIndex((center,i)=>f.rect.x>=(i?(centers[i-1]+center)/2:rect.x)-em*.2&&
          f.rect.right<=(i+1<centers.length?(center+centers[i+1])/2:rect.right)+em*.2);
        if(col>=0)f.flow={id,type:"contributors",column:col,columns:centers.length,rect};
      }
      for(let col=0;col<centers.length;col++){
        const column=members.filter(f=>f.flow?.id===id&&f.flow.column===col&&/\p{L}/u.test(f.text)&&f!==anchors[col]);
        if(!column.length)continue;
        const first=Math.min(...column.map(f=>f.baseline));
        if(first>=anchors[col].baseline-em*.5)continue;
        for(const f of column)f.contributorRole=Math.abs(f.baseline-first)<em*.3?"author":"affiliation";
      }
    }
  }
  // 图形需有实际绘图证据和图注，或多个带文字的相连图形；普通正文和已确认表格优先。
  function figures(fragments,probe,tables,pageNumber) {
    const em=median(fragments.map(f=>f.height)),clusters=[];
    const intersects=(a,b,pad=0)=>a.x<b.right+pad&&b.x<a.right+pad&&a.y<b.bottom+pad&&b.y<a.bottom+pad;
    for(const rect of [...(probe?.vectorRects||[]),...(probe?.rules||[]),...(probe?.images||[]).map(i=>i.rect)].slice(0,4064)){
      if(!rect||(rect.right-rect.x<em&&rect.bottom-rect.y<em)||tables.some(t=>intersects(t.rect,rect)))continue;
      let combined={...rect},count=1;
      // 传递合并，而非只吸收第一个命中簇，避免箭头把同一流程图拆为多个区域。
      for(let i=clusters.length-1;i>=0;i--)if(intersects(combined,clusters[i].rect,em*.6)){
        const old=clusters.splice(i,1)[0];count+=old.count;
        combined={x:Math.min(combined.x,old.rect.x),y:Math.min(combined.y,old.rect.y),right:Math.max(combined.right,old.rect.right),bottom:Math.max(combined.bottom,old.rect.bottom)};
        i=clusters.length;
      }
      clusters.push({rect:combined,count});
    }
    const groups=[];
    const captionPrefix=/^(?:fig(?:ure)?\.?|图|圖|рис\.?|figura)\s*$/iu;
    const isCaption=f=>/^(?:fig(?:ure)?\.?|图|圖|рис\.?|figura)\s*\d/iu.test(f.text.trim())||
      captionPrefix.test(f.text.trim())&&fragments.some(next=>/^\d/u.test(next.text.trim())&&
        Math.abs(next.baseline-f.baseline)<em*.3&&next.rect.x>=f.rect.right-em*.2&&next.rect.x-f.rect.right<em);
    for(const cluster of clusters.sort((a,b)=>(b.rect.right-b.rect.x)*(b.rect.bottom-b.rect.y)-(a.rect.right-a.rect.x)*(a.rect.bottom-a.rect.y)).slice(0,64)){
      const rect=cluster.rect;
      const labels=fragments.filter(f=>!f.table&&!f.flow&&f.rect.x>=rect.x-em*.2&&f.rect.right<=rect.right+em*.2&&f.rect.y>=rect.y-em*.2&&f.rect.bottom<=rect.bottom+em*.2);
      const caption=fragments.find(f=>!f.table&&!f.flow&&isCaption(f)&&
        f.rect.y>=rect.bottom-em*.2&&f.rect.y-rect.bottom<em*4&&overlap(f.rect.x,f.rect.right,rect.x,rect.right)>0);
      // 没有图注时须至少三个图形及三个短标签；拒绝整页边框或长正文包围盒。
      if(!caption&&(cluster.count<3||labels.length<3||labels.some(f=>f.text.length>100)))continue;
      if(!caption){
        const boxes=[];
        for(const box of probe?.vectorRects||[]){
          if(box.x<rect.x||box.y<rect.y||box.right>rect.right||box.bottom>rect.bottom||
            (box.right-box.x)*(box.bottom-box.y)>(rect.right-rect.x)*(rect.bottom-rect.y)*.5)continue;
          if(!labels.some(f=>f.rect.x>=box.x-em*.2&&f.rect.right<=box.right+em*.2&&f.rect.y>=box.y-em*.2&&f.rect.bottom<=box.bottom+em*.2))continue;
          if(!boxes.some(other=>intersects(other,box)))boxes.push(box);
        }
        if(boxes.length<3)continue;
      }
      if(!labels.length&&!caption)continue;
      const extent={...rect,bottom:caption?Math.max(rect.bottom,caption.rect.bottom):rect.bottom};
      if(groups.some(group=>intersects(group.rect,extent)))continue;
      const flow={id:pageNumber+":figure:"+groups.length,type:"figure",rect:extent,sourceRect:{...rect}};
      groups.push(flow);
      for(const f of labels){
        const box=(probe?.vectorRects||[]).filter(r=>r.x<=f.rect.x+em*.2&&r.right>=f.rect.right-em*.2&&r.y<=f.rect.y+em*.2&&r.bottom>=f.rect.bottom-em*.2)
          .sort((a,b)=>(a.right-a.x)*(a.bottom-a.y)-(b.right-b.x)*(b.bottom-b.y))[0];
        f.flow={...flow,part:box?[box.x,box.y,box.right,box.bottom].map(n=>n.toFixed(2)).join(":"):""};
      }
      if(caption)for(const f of fragments){
        if(!f.table&&!f.flow&&Math.abs(f.baseline-caption.baseline)<em*.3&&overlap(f.rect.x,f.rect.right,rect.x,rect.right)>0)
          f.flow={...flow,caption:true};
      }
    }
    return groups;
  }
  function order(blocks,ordinaryOrder) {
    const atoms=[],groups=new Map();
    for(const block of blocks){
      const group=block.table&&block.cell?block.table:block.flow;
      if(!group){atoms.push(block);continue;}
      let atom=groups.get(group.id);
      if(!atom){atom={rect:group.rect,height:block.height,direction:block.direction,members:[]};groups.set(group.id,atom);atoms.push(atom);}
      atom.members.push(block);
    }
    return ordinaryOrder(atoms).flatMap(atom=>atom.members?atom.members.sort((a,b)=>
      a.cell&&b.cell?a.cell.row-b.cell.row||a.cell.column-b.cell.column||a.rect.y-b.rect.y||a.rect.x-b.rect.x:
      (a.flow?.column??0)-(b.flow?.column??0)||a.rect.y-b.rect.y||a.rect.x-b.rect.x):[atom]);
  }
  // 在拼段前识别标题边界；字形名称只用于比较，不从 PDF 内部字体 ID 猜测粗体。
  function annotateLines(lines,page) {
    const ordinary=lines.filter(line=>!line.flow&&!line.table&&!line.reason&&!line.mono&&/\p{L}/u.test(line.text));
    const body=ordinary.filter(line=>line.text.length>=40&&line.rect.y>page.height*.05&&line.rect.bottom<page.height*.95);
    const em=median((body.length?body:ordinary).map(line=>line.height)),weights=new Map();
    for(const line of body.length?body:ordinary)weights.set(line.fontName,(weights.get(line.fontName)||0)+line.text.length);
    const bodyFont=[...weights].sort((a,b)=>b[1]-a[1])[0]?.[0];
    const ordered=[...ordinary].sort((a,b)=>a.rect.y-b.rect.y||a.rect.x-b.rect.x),positions=new Map(ordered.map((line,index)=>[line,index]));
    const neighbor=(line,direction)=>{
      const index=positions.get(line);
      for(let step=1;step<=128;step++){
        const other=ordered[index+direction*step];if(!other)break;
        if(overlap(line.rect.x,line.rect.right,other.rect.x,other.rect.right)<=0)continue;
        if(direction>0?other.rect.y>=line.rect.bottom-em*.2:other.rect.bottom<=line.rect.y+em*.2)return other;
      }
      return null;
    };
    for(const line of ordinary){
      if(line.kind)continue;
      if(/^H[1-6]?$/u.test(line.tag?.role||"")){
        line.headingLevel=Number(line.tag.role.slice(1))||1;line.kind=line.headingLevel===1?"heading":"subheading";line.headingEvidence="pdf-tag";continue;
      }
      const value=line.text.trim(),number=value.match(/^(\d+(?:\.\d+)*)(?:\.\s+|\s+)(?=\p{L})/u);
      const short=value.length<=140&&(value.match(/\S+/gu)||[]).length<=16&&!/[!?;。！？；]$/u.test(value);
      const contrast=!!line.fontName&&!!bodyFont&&line.fontName!==bodyFont;
      if(!short||!number&&!contrast&&line.height<em*1.35)continue;
      const after=neighbor(line,1),before=neighbor(line,-1);
      const separated=!before||line.rect.y-before.rect.bottom>=em*.6;
      const bodyAfter=after&&after.height<=line.height*1.1&&after.text.length>value.length;
      const numbered=number&&short&&(line.height>=em*1.12||contrast&&bodyAfter||separated&&bodyAfter&&number[1].includes("."));
      const display=short&&line.height>=em*1.35;
      const standalone=short&&contrast&&bodyAfter&&(separated&&value.length<=60||/[.:：]$/u.test(value));
      if(numbered||display||standalone){
        line.kind=numbered?(number[1].includes(".")?"subheading":"heading"):display?"heading":"subheading";
        line.headingLevel=numbered?number[1].split(".").length:display?1:2;
        line.headingEvidence=numbered?"number-and-style":display?"size":"style-and-spacing";
      }
    }
  }
  function describe(blocks,page) {
    const text=blocks.filter(b=>!b.flow&&!b.table&&b.role==="text"),body=text.filter(b=>b.rect.y>page.height*.08&&b.rect.bottom<page.height*.85);
    const em=median((body.length?body:text).map(b=>b.height));
    for(const block of blocks){
      const text=block.text.trim(),small=block.height<em*.85,edge=block.height*2;
      block.kind=block.cell?"table":block.flow?.caption?"caption":block.flow?.type==="figure"?"figure":
        block.role==="formula"?"formula":block.role==="code"?"code":
        !block.flow&&/^H[1-6]?$/u.test(block.tag?.role||"")&&["heading","subheading"].includes(block.kind)?block.kind:
        /^(?:fig(?:ure)?\.?|table|图|圖|表|рис\.?|табл\.?)\s*\d/iu.test(text)?"caption":
        block.role==="number"&&block.rect.y>page.height-edge*2?"footer":
        !block.flow&&small&&block.rect.bottom<edge?"header":!block.flow&&small&&block.rect.y>page.height-edge*2?"footer":
        !block.flow&&["heading","subheading"].includes(block.kind)?block.kind:
        !block.flow&&/^(?:[-•◦]|\d+[.)])\s/u.test(text)?"list":
        !block.flow&&block.role==="text"&&(block.lines?.length||1)<=3&&text.length<180&&block.height>=em*1.4?"heading":
        !block.flow&&small?"footnote":"paragraph";
      block.structure={version:3,confidence:block.reliable?"reliable":"uncertain",fallback:!block.reliable,
        evidence:block.headingEvidence|| (block.tag?"pdf-tag":"geometry"),sourceItems:block.lines?.flatMap(line=>line.indices||[])||[]};
      // 跨页不拼接请求：只记录可核对的边界候选，防止把下一页另一栏/另一节强行续入。
      if(block.kind==="paragraph"&&block.role==="text"&&!block.flow){
        block.continuation={fromPrevious:block.rect.y<em*6&&/^\p{Ll}/u.test(text),
          toNext:block.rect.bottom>page.height-em*6&&!/[.!?。！？:]$/u.test(text)};
      }
    }
  }
  function visuals(blocks,probe,figures,tables,page) {
    const em=median(blocks.map(b=>b.height)),out=[],area=r=>(r.right-r.x)*(r.bottom-r.y);
    const inside=(outer,inner)=>inner.x>=outer.x-em*.2&&inner.right<=outer.right+em*.2&&inner.y>=outer.y-em*.2&&inner.bottom<=outer.bottom+em*.2;
    const candidates=[...figures.map(f=>({id:f.id,rect:f.sourceRect,flow:f})),...(probe?.images||[]).map(image=>({rect:image.rect}))];
    for(const candidate of candidates){
      const rect=candidate.rect;
      if(!rect||area(rect)>=page.width*page.height*.8||rect.right-rect.x<em*2||rect.bottom-rect.y<em*2||
        rect.x<0||rect.y<0||rect.right>page.width||rect.bottom>page.height||tables.some(t=>inside(t.rect,rect)))continue;
      if(out.some(visual=>inside(visual.rect,rect)))continue;
      // 未确认区域不能裁入周围正文；有原生文字重叠的位图由已确认图形分组负责。
      if(!candidate.flow&&blocks.some(b=>!b.flow&&b.role==="text"&&overlap(b.rect.x,b.rect.right,rect.x,rect.right)*overlap(b.rect.y,b.rect.bottom,rect.y,rect.bottom)>0))continue;
      const caption=blocks.find(b=>b.kind==="caption"&&b.rect.y>=rect.bottom-em*.2&&b.rect.y-rect.bottom<em*4&&overlap(b.rect.x,b.rect.right,rect.x,rect.right)>0);
      const id=candidate.id||page.pageNumber+":image:"+[rect.x,rect.y,rect.right,rect.bottom].map(n=>n.toFixed(2)).join(":");
      if(caption&&!caption.flow)caption.visualId=id;
      out.push({id,kind:"figure",rect,sourceRect:rect,captionId:caption?.id||null,flow:candidate.flow||null,
        pageNumber:page.pageNumber,confidence:"reliable"});
    }
    // 同一区域只显示一次，包含关系以较大的已确认视觉区域为准。
    return out.filter((v,i)=>!out.some((other,j)=>i!==j&&area(other.rect)>area(v.rect)&&inside(other.rect,v.rect)));
  }
  global.BT_PDF_READING_STRUCTURE={detect,assign,contributors,figures,order,inlineFragments,annotateLines,describe,visuals};
})(window);
