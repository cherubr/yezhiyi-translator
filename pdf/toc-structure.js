(function(global) {
  "use strict";
  const dots = /(?:[.．·…⋯]\s*){3,}/u, pageLabel = /^(?:[0-9０-９]{1,5}|[ivxlcdm]{1,12})$/iu;
  /** 在拼段前识别重复的标题、引导点、右端页码关系；目录标题只作辅助证据。 */
  function annotate(rows, page) {
    const heading=rows.some(row=>/^(?:目[录錄次]|table\s+of\s+contents|contents|sommaire|inhaltsverzeichnis)$/iu.test(row.fragments.map(f=>f.text).join("").trim()));
    const candidates = [];
    const lanes=[];
    for(const row of rows){
      const parts=[...row.fragments].sort((a,b)=>a.rect.x-b.rect.x);let start=0;
      for(let i=1;i<parts.length;i++)if(pageLabel.test(parts[i-1].text.trim())&&parts[i].rect.x-parts[i-1].rect.right>row.height*2&&
        /\p{L}/u.test(parts.slice(start,i-1).map(f=>f.text).join(""))){lanes.push({...row,fragments:parts.slice(start,i)});start=i;}
      lanes.push({...row,fragments:parts.slice(start)});
    }
    for (const row of lanes) {
      const parts = row.fragments.filter(f=>!f.reason&&!f.table&&!f.flow&&!f.mono).sort((a,b)=>a.rect.x-b.rect.x);
      if (!parts.length || parts.length !== row.fragments.length) continue;
      const last = parts.at(-1), text = parts.map(f=>f.text).join("").trim();
      const inline = text.match(/^(.*?)([.．·…⋯\s]{3,})([0-9０-９]{1,5}|[ivxlcdm]{1,12})\s*$/iu);
      let title, label, titleParts, ornaments, unresolved = false;
      if (parts.length > 1 && pageLabel.test(last.text.trim()) && /\p{L}/u.test(parts.slice(0,-1).map(f=>f.text).join(""))) {
        label = last.text.trim(); ornaments = parts.filter(f=>f!==last&&/^[.．·…⋯\s]+$/u.test(f.text));
        titleParts = parts.filter(f=>f!==last&&!ornaments.includes(f));
        title = titleParts.map(f=>f.text).join("").replace(/[.．·…⋯\s]+$/u,"").trim();
        unresolved = titleParts.some(f=>dots.test(f.text));
      } else if (inline && dots.test(inline[2])) {
        title = inline[1].trim(); label = inline[3]; titleParts = parts; ornaments = []; unresolved = true;
      } else continue;
      if (!title || !/\p{L}/u.test(title)) continue;
      candidates.push({row,parts,title,label,titleParts,ornaments,unresolved,right:last.rect.right,x:titleParts[0].rect.x,
        em:row.height,leader:dots.test(text),tagged:parts.some(f=>/^TOC/u.test(f.tag?.role||""))});
    }
    const groups = [];
    for (const item of candidates) {
      let group = groups.find(group=>Math.abs(group[0].right-item.right)<=Math.max(group[0].em,item.em));
      if (!group) { group=[]; groups.push(group); } group.push(item);
    }
    for (const group of groups) {
      group.sort((a,b)=>a.row.baseline-b.row.baseline);
      const ordered = group.map(item=>Number(item.label)).filter(Number.isFinite);
      const monotone = ordered.slice(1).filter((n,i)=>n>=ordered[i]).length;
      // 无点线目录要求更多行且页码基本递增，避免把普通数值清单当作目录。
      if (group.length < 3 || !(group.filter(item=>item.leader||item.tagged).length>=3 ||
        heading&&group.length>=6&&ordered.length>=6&&monotone>=ordered.length-2)) continue;
      const id = page.pageNumber+":toc:"+group[0].parts[0].index;
      const rect = {x:Math.min(...group.map(i=>i.x)),y:Math.min(...group.map(i=>i.parts[0].rect.y)),
        right:Math.max(...group.map(i=>i.right)),bottom:Math.max(...group.flatMap(i=>i.parts.map(f=>f.rect.bottom)))};
      const left = Math.min(...group.map(i=>i.x));
      for (let index=0;index<group.length;index++) {
        const item=group[index],previous=group[index-1];
        const continued=previous?rows.filter(row=>row.baseline>previous.row.baseline+item.em*.4&&row.baseline<item.row.baseline-item.em*.4):[];
        if(continued.length>0&&continued.length<=3&&item.row.baseline-continued[0].baseline<=item.em*1.7*continued.length&&continued.every(row=>{
          const fs=row.fragments;return fs.length&&fs.every(f=>!f.reason&&!f.table&&!f.flow&&!f.mono&&!f.toc&&f.height>item.em*.8&&f.height<item.em*1.2)&&
            Math.abs(Math.min(...fs.map(f=>f.rect.x))-item.x)<item.em*2&&Math.max(...fs.map(f=>f.rect.right))<item.right-item.em&&/\p{L}/u.test(fs.map(f=>f.text).join(""));
        })){
          item.continued=continued;
          rect.y=Math.min(rect.y,...continued.flatMap(row=>row.fragments.map(f=>f.rect.y)));
        }
        const entry = {regionId:id,id:id+":"+item.parts[0].index,title:item.title,pageLabel:item.label,
          level:Math.max(0,Math.min(6,Math.round((item.x-left)/Math.max(1,item.em)))),rect,
          unresolvedGeometry:item.unresolved};
        const titleRows=[...(item.continued||[]).map(row=>({parts:row.fragments,title:row.fragments.slice().sort((a,b)=>a.rect.x-b.rect.x).map(f=>f.text).join("").trim()})),{parts:item.parts,title:item.title}];
        for(const row of titleRows)for (const fragment of row.parts) {
          fragment.columnBreakBefore=false;
          fragment.codeRole=fragment.contributorRole=undefined;
          fragment.toc={...entry,rowTitle:row.title,part:row.parts!==item.parts||item.titleParts.includes(fragment)?"title":item.ornaments.includes(fragment)?"leader":"page"};
        }
      }
    }
  }
  global.BT_PDF_TOC = {annotate};
})(typeof window!=="undefined"?window:self);
