(function(global) {
  "use strict";
  const validRect=r=>!!r&&[r.x,r.y,r.right,r.bottom].every(Number.isFinite)&&r.right>r.x&&r.bottom>r.y;
  const union=rects=>({x:Math.min(...rects.map(r=>r.x)),y:Math.min(...rects.map(r=>r.y)),
    right:Math.max(...rects.map(r=>r.right)),bottom:Math.max(...rects.map(r=>r.bottom))});
  // Worker 内生成独立 PDF；不以原页作文字背景，不发起翻译、OCR 或网络请求。
  async function compose({out,setup,targets,loaded,job,userBox,error,rgb,degrees,addOutlines}) {
    const model=global.BT_PDF_STRUCTURED,IR=global.BT_PDF_REFLOW_MODEL,P=global.BT_PDF_LAYOUT_PLANNER;
    const stats={mode:"structured",pages:0,selected:targets.length,translated:0,edited:0,retained:0,unchanged:0,
      tables:0,figures:0,sourcePages:0,protected:0,supplementalPages:0,translationPages:0,overlay:0,appendixItems:0,appendixPages:0,per:[]};
    const outlines=[],ink=rgb(.12,.16,.2),border=rgb(.65,.68,.72);
    let operations=0;
    const budget=()=>{if(++operations>200000||out.getPageCount()>2000)throw error("EXPORT_FAILED","重排内容超过处理预算，请缩小页码范围");};
    const median=list=>{const a=list.filter(n=>n>0&&Number.isFinite(n)).sort((a,b)=>a-b);return a[Math.floor(a.length/2)]||10;};
    // 同类、相近字号才共享样式，小字和脚注不能把整页正文拉低到最小字号。
    const styleSizes=rows=>{
      const groups=[],sizes=new Map();
      for(const item of [...rows].sort((a,b)=>a.block.height-b.block.height)){
        const size=item.block.height;if(!Number.isFinite(size)||size<=0)continue;
        const key=[item.kind,!!item.block.mono,item.block.fontName||""].join(":");
        let group=groups.find(g=>g.key===key&&size/g.min<=1.1);
        if(!group){group={key,min:size,items:[]};groups.push(group);}group.items.push(item);
      }
      for(const group of groups){const size=median(group.items.map(item=>item.block.height));for(const item of group.items)sizes.set(item.id,size);}
      return sizes;
    };
    const clean=text=>String(text||"").replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g,"");
    const drawable=text=>Array.from(text).every(ch=>/\s/u.test(ch)||setup.canRender(ch));
    const translated=item=>item.result?.status==="translated"&&item.block.role==="text"&&!!clean(item.result.text).trim();
    for(const target of targets){
      const source=loaded.getPage(target.page-1),per={page:target.page,output:[],anchors:[],warnings:[],diagnostics:[],original:!target.snapshot};
      stats.per.push(per);
      const keepSource=async()=>{
        const [copy]=await out.copyPages(loaded,[target.page-1]);out.addPage(copy);stats.sourcePages++;
        per.output.push({page:out.getPageCount(),kind:"source",width:copy.getWidth(),height:copy.getHeight()});
        outlines.push({page:copy,title:"Source "+target.page});
      };
      if(!target.snapshot){stats.retained++;await keepSource();continue;}
      const geometry=target.geometry,W=geometry.width,H=geometry.height;
      if(!Number.isFinite(W+H)||W<=0||H<=0)throw error("EXPORT_FAILED","源页尺寸无效，无法重排");
      let needsSource=false;
      const note=message=>{if(!per.warnings.includes(message))per.warnings.push(message);};
      const retain=message=>{needsSource=true;note(message);};
      // 仅记录身份与阶段，不记录原文、译文或解析器的原始异常。
      const diagnostic=(code,stage,id,kind)=>{if(per.diagnostics.length<64)per.diagnostics.push({code,stage,id,kind});};
      const pageRect=r=>{
        if(!validRect(r))return null;
        const clipped={x:Math.max(0,r.x),y:Math.max(0,r.y),right:Math.min(W,r.right),bottom:Math.min(H,r.bottom)};
        return validRect(clipped)?clipped:null;
      };
      const sameRect=(a,b)=>a&&b&&["x","y","right","bottom"].every(key=>a[key]===b[key]);
      const blockRect=block=>{
        const direct=pageRect(block.rect);if(direct)return direct;
        // 只从本块的完整行框或四角恢复；不能拿邻段的区域补齐。
        const lines=block.lines||[];
        if(lines.length&&lines.every(line=>validRect(line.rect)))return pageRect(union(lines.map(line=>line.rect)));
        const quad=block.quad;
        if(Array.isArray(quad)&&quad.length===4&&quad.every(p=>Array.isArray(p)&&p.length===2&&p.every(Number.isFinite)))
          return pageRect(union(quad.map(([x,y])=>({x,y,right:x,bottom:y}))));
        return null;
      };
      const resultMap=new Map(target.snapshot.results),allRows=target.snapshot.blocks.map(original=>{
        const rect=blockRect(original),block=rect?{...original,rect}:original;
        if(rect&&!sameRect(rect,original.rect))diagnostic("REGION_RECOVERED","block",block.id,block.kind);
        return {block,result:resultMap.get(block.id)};
      });
      if(allRows.some(({block})=>block.source==="native"&&!(block.structure?.version>=2)))
        note("旧版文字结构保留现有译文；重新翻译本页后可更新标题与行内格式");
      const rows=model.items(allRows).map(item=>item.block.role==="text"&&!(item.result?.status==="translated"&&!translated(item))?item:
        {...item,text:item.block.rawText||item.block.text}),headers=rows.filter(item=>["header","footer"].includes(item.kind));
      const sizes=styleSizes(rows);
      const bodyRows=allRows.filter(row=>!headers.some(item=>item.id===row.block.id));
      const documentModel=IR.page({rows:bodyRows,geometry}),candidates=documentModel.nodes;
      per.modelVersion=documentModel.version;
      per.quality={state:"pending",sourceItems:documentModel.sourceCount,regions:candidates.length,retainedRegions:0,validatedBoxes:0};
      for(const issue of documentModel.issues)diagnostic(issue.code,"structure",issue.id,"region");
      // 先以源块确定布局，再绑定结果；译文长度和任务进度不得反向改变栏目归属。
      const byId=new Map(rows.map(item=>[item.id,item]));
      const deferred=new Map(),defer=node=>{
        for(const item of node.items)if(translated(item))deferred.set(item.id,item);
        diagnostic("REGION_UNAVAILABLE","region",node.id||node.items[0]?.id,node.kind);
        retain("部分区域无法可靠重建，原内容保留在源页；已成功翻译的文字另页展示");
      };
      const matrix=target.M,canCrop=Array.isArray(matrix)&&matrix.length===6&&matrix.every(Number.isFinite)&&matrix[0]*matrix[3]-matrix[1]*matrix[2]!==0;
      const nodes=[];
      for(const node of candidates){
        node.items=node.items.map(item=>byId.get(item.id)||item);
        if(node.unresolvedInline){defer(node);continue;}
        const choices=[node.flow?.sourceRect,node.visual?.sourceRect,node.grid?.rect,node.visual?.rect,node.flow?.rect];
        // 代码/作者区域由同组文字组成；图形不能用零散标签的包围盒猜测。
        if(["code","contributors"].includes(node.kind)&&node.items.length&&node.items.every(item=>validRect(item.block.rect)))
          choices.push(union(node.items.map(item=>item.block.rect)));
        if(!["table","figure","code","contributors"].includes(node.kind)&&node.items.length&&node.items.every(item=>validRect(item.block.rect)))
          choices.push(union(node.items.map(item=>item.block.rect)));
        if(node.kind==="table"&&node.grid?.cells?.length&&node.grid.cells.every(cell=>validRect(cell?.rect)))
          choices.push(union(node.grid.cells.map(cell=>cell.rect)));
        const raw=choices.find(r=>pageRect(r)),region=raw&&pageRect(raw);
        if(!region||node.items.some(item=>!sameRect(item.block.rect,pageRect(item.block.rect))||!Number.isFinite(item.block.height)||item.block.height<=0)){defer(node);continue;}
        node.sourceRegion=canCrop?region:null;
        if(choices.slice(0,choices.indexOf(raw)).some(r=>r)||!sameRect(raw,region))diagnostic("REGION_RECOVERED","region",node.id||node.items[0]?.id,node.kind);
        // 局部修复只用于重排副本，不更改翻译缓存或共享的结构描述。
        if(node.flow)node.flow={...node.flow,rect:pageRect(node.flow.rect)||region};
        if(node.visual)node.visual={...node.visual,rect:pageRect(node.visual.rect)||region};
        if(node.grid)node.grid={...node.grid,rect:pageRect(node.grid.rect)||region};
        nodes.push(node);
      }
      const activeHeaders=headers.filter(item=>{
        if(sameRect(item.block.rect,pageRect(item.block.rect))&&Number.isFinite(item.block.height)&&item.block.height>0&&canCrop)return true;
        defer({kind:item.kind,items:[item]});return false;
      });
      if(documentModel.issues.some(issue=>["DUPLICATE_SOURCE","STRUCTURE_BUDGET","INLINE_BUDGET"].includes(issue.code))){
        for(const node of nodes)defer(node);nodes.length=0;
      }
      const tree=IR.prune(documentModel.tree,new Set(nodes))||{kind:"stack",rect:null,children:[]},em=median(rows.map(item=>item.block.height)),rect=tree.rect;
      if(allRows.length>rows.length){stats.retained+=allRows.length-rows.length;retain("部分文字无法可靠重建，已保留源页");}
      if(geometry.retainSourceGraphics)retain("存在尚未重建的图形，已保留源页");
      // 页边距沿用源页内容边界，避免把封面的大段下方留白当作分页禁区。
      const margin=Math.min(em,W/8,H/8),side=rect?Math.max(em,Math.min(rect.x,W-rect.right)):margin;
      const continuationTop=Math.max(margin,...activeHeaders.filter(i=>i.kind==="header").map(i=>i.block.rect.bottom+margin));
      let top=rect?Math.max(0,rect.y):margin,bottom=rect?Math.min(H-em,H-Math.max(em,Math.min(side,H-rect.bottom))):H-margin;
      for(const footer of activeHeaders.filter(item=>item.kind==="footer"))bottom=Math.min(bottom,footer.block.rect.y-margin);
      const layoutPossible=!!rect&&nodes.length>0&&bottom-top>=em*3;
      if(!layoutPossible){top=margin;bottom=H-margin;retain("本页不能安全还原结构，已保留源页并单独展示可用译文");}
      const sheets=[],embedded=new Map(),counted=new Set(),commands=[],guard=IR.validator({width:W,height:H});
      let supplemental=false,currentRegion=null;
      const layoutError=(message,stage)=>Object.assign(error("REFLOW_LAYOUT",message),{
        stage,regionId:currentRegion?.id||currentRegion?.items[0]?.id,kind:currentRegion?.kind});
      const regionId=()=>currentRegion?.id||currentRegion?.items[0]?.id||"page";
      const claim=(sheet,box)=>{
        const lane=currentRegion?.outputLane;
        const code=lane&&(box.x<lane.x-.05||box.right>lane.right+.05)?"OUTPUT_COLUMN":guard.add(box,{page:sheet.number,region:regionId()});
        if(code)throw Object.assign(layoutError("重排内容未通过边界或重叠校验","validate"),{detailCode:code});
      };
      const checkText=(value,lines)=>{
        const normalized=text=>clean(text).replace(/\s/gu,"");
        if(normalized(value)!==normalized(lines.join("")))throw layoutError("重排文字覆盖不完整","coverage");
      };
      function count(item){
        if(counted.has(item.id))return;counted.add(item.id);
        if(translated(item)){stats.translated++;if(item.result.userEdited)stats.edited++;}
        else if(item.result?.status==="unchanged"||item.block.reliable&&item.block.role!=="text")stats.unchanged++;
        else {stats.retained++;note("含未完成或受保护内容；对应区域保留原文");}
      }
      function protect(item){
        if(counted.has(item.id))return;counted.add(item.id);stats.protected++;
      }
      function anchor(sheet,id,x,y,width,height){
        budget();if(!id)return;
        if(![x,y,width,height].every(Number.isFinite)||width<0||height<0||x<-.01||y<-.01||x+width>W+.01||y+height>H+.01)
          throw layoutError("重排内容超出纸张范围","anchor");
        per.anchors.push({id,page:sheet.number,x,y,width,height});
      }
      async function crop(sheet,r,x,y,width,ids=[]){
        if(!canCrop||!validRect(r)||![x,y,width].every(Number.isFinite)||width<=0)
          throw layoutError("原始区域不能安全裁切","crop");
        const box=userBox(target.M,r);
        if(!box||![box.x,box.y,box.width,box.height].every(Number.isFinite)||!(box.width>0&&box.height>0))
          throw layoutError("原始区域坐标无效","crop");
        const key=JSON.stringify(box);let asset=embedded.get(key);
        if(!asset){asset=await out.embedPage(source,{left:box.x,bottom:box.y,right:box.x+box.width,top:box.y+box.height});embedded.set(key,asset);}
        const rotation=((source.getRotation().angle%360)+360)%360;
        if(![0,90,180,270].includes(rotation))throw layoutError("该页旋转角度暂不能安全重排","rotation");
        const turned=rotation===90||rotation===270,k=width/(turned?box.height:box.width),w=box.width*k,h=box.height*k;
        let dx=x,dy=H-y-h;
        if(rotation===90)dy=H-y;
        else if(rotation===180){dx=x+w;dy=H-y;}
        else if(rotation===270){dx=x+h;dy=H-y-w;}
        claim(sheet,{x,y,right:x+width,bottom:y+(turned?w:h)});
        commands.push(()=>sheet.pdf.drawPage(asset,{x:dx,y:dy,width:w,height:h,rotate:degrees(-rotation)}));
        for(const id of ids)anchor(sheet,id,x,y,width,turned?w:h);
        return turned?w:h;
      }
      async function sheetAt(index){
        while(sheets.length<=index){
          budget();const pdf=out.addPage([W,H]),sheet={pdf,number:out.getPageCount()};sheets.push(sheet);
          per.output.push({page:sheet.number,kind:"translation",supplemental,width:W,height:H});
          stats.translationPages++;if(supplemental)stats.supplementalPages++;
          outlines.push({page:pdf,title:"Page "+target.page+(sheets.length>1?" ("+sheets.length+")":"")});
          const previousRegion=currentRegion;
          for(const item of supplemental?[]:activeHeaders){
            currentRegion={kind:item.kind,items:[item]};
            const r=item.block.rect,value=clean(item.text),size=sizes.get(item.id)??item.block.height;
            if(translated(item)&&drawable(value)){
              const metrics=textMetrics(value,size),lead=size*metrics.lineHeight,lines=P.wrapText(value,size,r.right-r.x,setup.measure);
              let limit=item.kind==="header"?top:H;
              for(const other of activeHeaders)if(other.id!==item.id&&other.block.rect.y>r.y&&other.block.rect.x<r.right&&other.block.rect.right>r.x)limit=Math.min(limit,other.block.rect.y);
              if(lines.length*lead<=limit-r.y&&lines.every(line=>setup.measure(line,size)<=r.right-r.x+.01)){
                checkText(value,lines);
                for(let i=0;i<lines.length;i++)await draw(sheet,lines[i],r.x,r.y+i*lead,size,metrics.ascent);
                count(item);anchor(sheet,item.id,r.x,r.y,r.right-r.x,lines.length*lead);continue;
              }
            }
            if(!translated(item))count(item);
            await crop(sheet,r,r.x,r.y,r.right-r.x,[item.id]);
          }
          currentRegion=previousRegion;
        }
        return sheets[index];
      }
      const startY=index=>supplemental?margin:index===0?top:Math.min(continuationTop,bottom-em*3);
      const next=cursor=>({sheet:cursor.sheet+1,y:startY(cursor.sheet+1)});
      const later=(a,b)=>a.sheet>b.sheet||a.sheet===b.sheet&&a.y>b.y?a:b;
      const room=(cursor,height)=>cursor.y+height>bottom&&cursor.y>startY(cursor.sheet)+.01?next(cursor):cursor;
      const gap=(cursor,height)=>height<=0?cursor:cursor.y+height<bottom?{...cursor,y:cursor.y+height}:next(cursor);
      function textMetrics(value,size){
        const runs=setup.runs(value,size);if(!runs)throw error("EXPORT_GLYPH_MISSING","重排字体缺少所需字形");
        // 以本段实际字体计量，范围导出增加其他语言的字体时不得改变本段分页。
        let ascent=.718,lineHeight=1.25;
        for(const run of runs){ascent=Math.max(ascent,run.tier.metrics.ascent);lineHeight=Math.max(lineHeight,run.tier.metrics.lineHeight);}
        return {ascent,lineHeight};
      }
      async function draw(sheet,text,x,y,size,ascent){
        budget();const runs=setup.runs(text,size);
        if(!runs)throw error("EXPORT_GLYPH_MISSING","重排字体缺少所需字形，请在设置中准备字体");
        const a=ascent??textMetrics(text,size).ascent;
        if(![x,y,size,a].every(Number.isFinite)||size<=0)throw layoutError("文字绘制参数无效","text");
        const metrics=textMetrics(text,size),width=runs.reduce((sum,run)=>sum+run.width,0);
        if(width>0&&text.trim())claim(sheet,{x,y,right:x+width,bottom:y+size*metrics.lineHeight});
        for(const run of runs){const dx=x;commands.push(()=>setup.drawRun(sheet.pdf,run,dx,H-y-size*a,size,ink,degrees(0)));x+=run.width;}
      }
      async function text(item,cursor,x,width){
        const size=item.reflowSize??sizes.get(item.id)??item.block.height,sourceLines=item.block.lines||[];
        // 统一字号不等于原文字号时，原始绝对行距不再适用，改用该字体的实测行高。
        const useSourceSpacing=size===item.block.height&&sourceLines.length>1;
        const sourceSpacing=useSourceSpacing?sourceLines.slice(1).flatMap((line,i)=>validRect(line.rect)&&validRect(sourceLines[i].rect)?[line.rect.y-sourceLines[i].rect.y]:[]):[];
        const value=clean(item.text),metrics=textMetrics(value,size),lead=Math.max(size*metrics.lineHeight,sourceSpacing.length?median(sourceSpacing):0);
        // 栏的可用宽度来自区域树，短首行/小标题的字框不能成为整段的硬宽度。
        if(![size,x,width,lead].every(Number.isFinite)||!(size>0&&width>size&&lead>0))throw layoutError("文字区域过窄或尺寸无效","text");
        if(!drawable(value))throw error("EXPORT_GLYPH_MISSING","译文字形缺失，请检查字体");
        // 新任务保存的是 decode 校验后的 UTF-16 范围。人工修订和旧结果仅在原子出现唯一时兼容，
        // 绝不按译文长度、出现顺序或原文坐标猜测样式位置。
        let inline=item.plainReflow?[]:item.result?.inline;
        if(!inline&&item.result?.machine?.text===item.text)inline=item.result.machine.inline;
        if(!Array.isArray(inline))inline=null;
        if(!inline){
          inline=[];
          for(const part of item.block.segments||[]){
            if(!part.protected||!part.runs?.length||!part.text)continue;
            const start=item.text.indexOf(part.text);
            if(start>=0&&item.text.indexOf(part.text,start+part.text.length)<0)
              inline.push({start,end:start+part.text.length,runs:part.runs,attachPrevious:!!part.attachPrevious});
          }
        }
        const ranges=[];let end=0;
        for(const part of [...inline].sort((a,b)=>a.start-b.start)){
          if(!Number.isInteger(part.start)||!Number.isInteger(part.end)||part.start<end||part.end<=part.start||part.end>item.text.length||
            !part.runs?.length||part.runs.map(run=>run.text).join("")!==item.text.slice(part.start,part.end)||
            part.runs.some(run=>!Number.isFinite(run.height)||run.height<=0||!Number.isFinite(run.shift)||Math.abs(run.shift)>item.block.height))continue;
          ranges.push(part);end=part.end;
        }
        const atoms=[];let pendingSpace=false,forceBreak=false;
        const cjk=/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]$/u;
        const add=(parts,{east=false,attach=false}={})=>{
          const w=parts.reduce((sum,part)=>sum+setup.measure(part.text,part.size),0),last=atoms.at(-1);
          if(last&&!forceBreak&&(attach||!pendingSpace&&!east&&!last.east)){
            if(pendingSpace)last.parts.push({text:" ",size,shift:0});
            last.parts.push(...parts);last.width+=w+(pendingSpace?setup.measure(" ",size):0);
          }else atoms.push({parts,width:w,space:pendingSpace,newLine:forceBreak,east});
          pendingSpace=false;forceBreak=false;
        };
        const plain=value=>{
          for(const token of clean(value).match(/\n|[^\S\n]+|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|[^\s\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu)||[]){
            if(token==="\n"){forceBreak=true;pendingSpace=false;}
            else if(/^\s/u.test(token))pendingSpace=true;
            else add([{text:token,size,shift:0}],{east:cjk.test(token)});
          }
        };
        let offset=0;
        for(const range of ranges){
          plain(item.text.slice(offset,range.start));
          add(range.runs.map(run=>({text:clean(run.text),size:size*run.height/item.block.height,shift:size*run.shift/item.block.height})),{attach:range.attachPrevious});
          offset=range.end;
        }
        plain(item.text.slice(offset));
        const lines=[];let current={parts:[],width:0};
        const flush=()=>{if(current.parts.length)lines.push(current);current={parts:[],width:0};};
        const put=(parts,w,space=false)=>{if(space&&current.parts.length){current.parts.push({text:" ",size,shift:0});current.width+=setup.measure(" ",size);}current.parts.push(...parts);current.width+=w;};
        for(const atom of atoms){
          if(atom.newLine)flush();
          const space=atom.space&&current.parts.length?setup.measure(" ",size):0;
          if(current.width+space+atom.width>width)flush();
          if(atom.width<=width){put(atom.parts,atom.width,atom.space);continue;}
          // 超长普通单词允许硬换行；有上下标的原子不能截断或缩到不可读。
          if(atom.parts.some(part=>part.shift!==0||part.size!==size))throw layoutError("行内原子超出栏宽","inline");
          for(const part of atom.parts)for(const ch of part.text){
            const w=setup.measure(ch,size);if(w>width)throw layoutError("译文字形超出栏宽","text");
            if(current.width+w>width)flush();put([{text:ch,size,shift:0}],w);
          }
        }
        flush();
        checkText(value,lines.map(line=>line.parts.map(part=>part.text).join("")));
        for(const line of lines){
          const merged=[];
          for(const part of line.parts){const last=merged.at(-1);
            if(last&&last.size===part.size&&last.shift===part.shift)last.text+=part.text;else merged.push({...part});}
          line.parts=merged;line.width=merged.reduce((sum,part)=>sum+setup.measure(part.text,part.size),0);
          line.above=size*metrics.ascent;line.below=lead-line.above;
          for(const part of line.parts){const m=textMetrics(part.text,part.size);
            line.above=Math.max(line.above,part.size*m.ascent-part.shift);
            line.below=Math.max(line.below,part.shift+part.size*(m.lineHeight-m.ascent));
          }
          line.height=line.above+line.below;
          if(!Number.isFinite(line.height)||line.height<=0||line.width>width+.01)throw layoutError("行内排版尺寸无效","inline");
        }
        const r=item.block.rect,center=x+width/2;
        const centered=["heading","subheading","caption"].includes(item.kind)&&Math.abs((r.x+r.right)/2-center)<size;
        const right=item.block.direction==="rtl";
        if(["heading","subheading"].includes(item.kind)){
          const height=lines.reduce((sum,line)=>sum+line.height,0),keep=height+(item.keepAfter??em*1.25);
          if(height>bottom-startY(cursor.sheet))throw layoutError("标题整体超过页面可用高度","heading");
          cursor=room(cursor,keep<=bottom-startY(cursor.sheet)?keep:height);
        }
        for(let i=0;i<lines.length;i++){
          const line=lines[i];cursor=room(cursor,line.height);
          if(cursor.y+line.height>bottom)throw layoutError("单行文字超过页面可用高度","text");
          const sheet=await sheetAt(cursor.sheet),w=line.width;
          let dx=centered?Math.max(x,Math.min(x+width-w,(r.x+r.right-w)/2)):right?x+width-w:x;
          // 只保留有真实多行证据的首行缩进；单行标题不按短字框压窄译文。
          if(i===0&&!centered&&!right&&!item.block.runInBody&&sourceLines.length>1&&sourceLines.every(line=>validRect(line.rect))){
            const indent=Math.max(0,sourceLines[0].rect.x-Math.min(...sourceLines.slice(1).map(l=>l.rect.x)));
            if(indent>0&&w+indent<=width)dx+=indent;
          }
          let advance=dx;
          for(const part of line.parts){const m=textMetrics(part.text,part.size);
            await draw(sheet,part.text,advance,cursor.y+line.above+part.shift-part.size*m.ascent,part.size,m.ascent);advance+=setup.measure(part.text,part.size);}
          for(const id of item.reflowIds||[item.id])anchor(sheet,id,dx,cursor.y,Math.min(Math.max(w,size),x+width-dx),line.height);
          cursor={sheet:cursor.sheet,y:cursor.y+line.height};
        }
        count(item);return cursor;
      }
      async function asset(node,cursor,x,width,r=node.sourceRegion,{protectAll=false}={}){
        r=pageRect(r);
        if(!r||!canCrop){defer(node);return cursor;}
        if(![x,width].every(Number.isFinite)||width<=0)throw layoutError("图形目标区域无效","asset");
        let w=Math.min(width,r.right-r.x),h=(r.bottom-r.y)*w/(r.right-r.x);
        if(h>bottom-top){w*=((bottom-top)/h);h=bottom-top;note("超高图形已等比适配页面");}
        cursor=room(cursor,h);const sheet=await sheetAt(cursor.sheet),dx=Math.min(x+width-w,Math.max(x,r.x));
        await crop(sheet,r,dx,cursor.y,w);
        const k=w/(r.right-r.x);
        for(const item of node.items){const b=item.block.rect;
          if(b.x>=r.x&&b.y>=r.y&&b.right<=r.right&&b.bottom<=r.bottom){if(protectAll)protect(item);else if(!translated(item))count(item);}
          else retain("部分文字超出原图区域，已保留源页供核对");
          const left=Math.max(b.x,r.x),right=Math.min(b.right,r.right),a=Math.max(b.y,r.y),z=Math.min(b.bottom,r.bottom);
          if(right>left&&z>a)anchor(sheet,item.id,dx+(left-r.x)*k,cursor.y+(a-r.y)*k,(right-left)*k,(z-a)*k);}
        return {sheet:cursor.sheet,y:cursor.y+h};
      }
      // 一条原生代码行构成一行布局；注释变长只增高本行，不再集中追加在整段代码后面。
      async function code(node,cursor,x,width){
        if(!canCrop||!validRect(node.sourceRegion)){defer(node);return cursor;}
        const region=node.sourceRegion,k=Math.min(1,width/(region.right-region.x)),groups=new Map();
        for(const item of node.items){
          const b=item.block,key=b.flow?.part??b.flow?.line??item.id;
          if(!groups.has(key))groups.set(key,[]);groups.get(key).push(item);
        }
        const lines=[...groups.values()].sort((a,b)=>Math.min(...a.map(i=>i.block.rect.y))-Math.min(...b.map(i=>i.block.rect.y)));
        for(const items of lines){
          const originals=items.filter(i=>i.block.codeRole!=="comment"),comments=items.filter(i=>i.block.codeRole==="comment");
          const original=originals.length?union(originals.map(i=>i.block.rect)):null;
          const caption=comments.length?union(comments.map(i=>i.block.rect)):null;
          const sourceRects=items.map(i=>i.block.rect),lineRect=union(sourceRects),size=median(items.map(i=>i.block.height))*k;
          const commentX=caption?x+(caption.x-region.x)*k:x+width;
          const commentWidth=x+width-commentX,pieces=[];
          if(comments.length){
            const value=[...comments].sort((a,b)=>a.block.rect.x-b.block.rect.x).map(item=>clean(item.text)).join(" ");
            const success=comments.every(translated),metrics=success?textMetrics(value,size):null;
            if(success&&commentWidth>size&&drawable(value)){
              const wrapped=P.wrapText(value,size,commentWidth,setup.measure);
              checkText(value,wrapped);
              if(wrapped.some(line=>setup.measure(line,size)>commentWidth+.01))throw layoutError("代码注释超出列宽","code");
              pieces.push({items:comments,lines:wrapped,lead:size*metrics.lineHeight,ascent:metrics.ascent});
            }else pieces.push({items:comments,rect:caption,source:true,height:(caption.bottom-caption.y)*k});
          }
          const sourceHeight=original?(original.bottom-original.y)*k:0;
          const height=Math.max(sourceHeight,pieces.reduce((h,p)=>h+(p.source?p.height:p.lines.length*p.lead),0),size*1.2);
          if(height>bottom-startY(cursor.sheet)){
            // 超高注释行保留代码原行，译文通过补充页提供，不能裁断或挤到下一行上。
            cursor=await asset({items,sourceRegion:lineRect},cursor,x+(lineRect.x-region.x)*k,(lineRect.right-lineRect.x)*k);continue;
          }
          cursor=room(cursor,height);const sheet=await sheetAt(cursor.sheet);
          if(original){
            const dx=x+(original.x-region.x)*k;
            await crop(sheet,original,dx,cursor.y,(original.right-original.x)*k,originals.map(i=>i.id));
            for(const item of originals)protect(item);
          }
          let y=cursor.y;
          for(const piece of pieces){
            if(piece.source){
              const r=piece.rect,dx=x+(r.x-region.x)*k;
              await crop(sheet,r,dx,y,(r.right-r.x)*k,piece.items.map(item=>item.id));y+=piece.height;
              for(const item of piece.items)if(!translated(item))count(item);
            }else{
              for(const line of piece.lines){await draw(sheet,line,commentX,y,size,piece.ascent);
                for(const item of piece.items)anchor(sheet,item.id,commentX,y,commentWidth,piece.lead);y+=piece.lead;}
              for(const item of piece.items)count(item);
            }
          }
          cursor={sheet:cursor.sheet,y:cursor.y+height};
        }
        return cursor;
      }
      async function table(node,cursor,x,width){
        const grid=node.grid;
        if(!grid||!Number.isInteger(grid.rows)||!Number.isInteger(grid.columns)||grid.rows<1||grid.columns<1||grid.rows*grid.columns>256||
          !Array.isArray(grid.widths)||grid.widths.length!==grid.columns||!Array.isArray(grid.cells)||!grid.cells.length)
          throw layoutError("表格结构不完整","table");
        if(node.items.some(item=>["code","formula"].includes(item.block.role))){
          note("含代码或公式的表格暂保留原表，已生成译文可在编辑区核对");return asset(node,cursor,x,width,grid.rect);
        }
        if(node.items.some(item=>!translated(item)&&!drawable(clean(item.text)))){
          note("表格含未完成且缺少字体的内容，本表保留原文");return asset(node,cursor,x,width,grid.rect);
        }
        const size=median(node.items.map(item=>item.block.height)),metrics=textMetrics(node.items.map(item=>clean(item.text)).join(" "),size),lead=size*Math.max(1.2,metrics.lineHeight),pad=size*.35;
        const xs=[0],sum=grid.widths.reduce((a,b)=>a+b,0);
        if(!(sum>0)||grid.widths.some(w=>!(w>0&&Number.isFinite(w))))throw layoutError("表格列宽无效","table");
        for(const fraction of grid.widths)xs.push(xs.at(-1)+width*fraction/sum);
        const heights=Array(grid.rows).fill(lead*2),cells=[];
        const occupied=new Set(),cellIds=new Set();
        for(const cell of grid.cells){
          budget();if(!cell||!Number.isInteger(cell.row)||!Number.isInteger(cell.column)||!Number.isInteger(cell.rowSpan)||!Number.isInteger(cell.colSpan)||
            cell.row<0||cell.column<0||cell.rowSpan<1||cell.colSpan<1||cell.row+cell.rowSpan>grid.rows||cell.column+cell.colSpan>grid.columns)
            throw layoutError("表格单元格范围无效","table");
          if(cellIds.has(cell.id))throw layoutError("表格单元格身份重复","table");cellIds.add(cell.id);
          for(let row=cell.row;row<cell.row+cell.rowSpan;row++)for(let col=cell.column;col<cell.column+cell.colSpan;col++){
            const key=row+":"+col;if(occupied.has(key))throw layoutError("表格单元格范围重叠","table");occupied.add(key);
          }
          const available=xs[cell.column+cell.colSpan]-xs[cell.column]-pad*2;
          if(available<size)throw layoutError("源表格的列过窄，无法安全容纳译文","table");
          const contents=node.items.filter(item=>item.block.cell?.id===cell.id),lines=[];
          for(const item of contents){count(item);const value=clean(item.text);
            if(!drawable(value))throw error("EXPORT_GLYPH_MISSING","表格文字缺少可用字形");
            const wrapped=P.wrapText(value,size,available,setup.measure);checkText(value,wrapped);
            for(const line of wrapped){
              if(setup.measure(line,size)>available+.01)throw layoutError("表格文字超出列宽","table");
              lines.push({text:line,id:item.id});
            }
          }
          const need=(lines.length+2)*lead;
          if(cell.rowSpan===1)heights[cell.row]=Math.max(heights[cell.row],need,Math.ceil(((cell.rect?.bottom-cell.rect?.y)||0)/lead)*lead);
          cells.push({cell,lines,need});
        }
        if(occupied.size!==grid.rows*grid.columns||node.items.some(item=>!cellIds.has(item.block.cell?.id)))
          throw layoutError("表格结构存在未归属区域","table");
        for(const {cell,need} of cells){const used=heights.slice(cell.row,cell.row+cell.rowSpan).reduce((a,b)=>a+b,0);
          if(need>used)heights[cell.row+cell.rowSpan-1]+=Math.ceil((need-used)/lead)*lead;}
        const ys=[0];for(const height of heights)ys.push(ys.at(-1)+height);
        let offset=0;
        while(offset<ys.at(-1)-.001){
          cursor=room(cursor,lead*3);let available=Math.floor((bottom-cursor.y)/lead)*lead;
          if(available<lead*3)throw layoutError("页面高度不足以安全分页表格","table");
          let end=Math.min(ys.at(-1),offset+available);
          const boundary=ys.filter(y=>y>offset+.001&&y<=end+.001).at(-1);if(boundary!==undefined)end=boundary;
          if(end<=offset)throw layoutError("表格分页无法继续","table");
          const sheet=await sheetAt(cursor.sheet);
          for(const {cell,lines} of cells){
            const a=ys[cell.row],b=ys[cell.row+cell.rowSpan],start=Math.max(a,offset),stop=Math.min(b,end);if(stop<=start)continue;
            const dx=x+xs[cell.column],w=xs[cell.column+cell.colSpan]-xs[cell.column];
            const rectangle={x:dx,y:H-cursor.y-(stop-offset),width:w,height:stop-start,borderColor:border,borderWidth:.5};
            commands.push(()=>sheet.pdf.drawRectangle(rectangle));
            for(let i=0;i<lines.length;i++){const y=a+lead+i*lead;if(y<offset-.001||y+lead>end+.001)continue;
              await draw(sheet,lines[i].text,dx+pad,cursor.y+y-offset,size,metrics.ascent);
              anchor(sheet,lines[i].id,dx,cursor.y+y-offset,w,lead);}
          }
          cursor={sheet:cursor.sheet,y:cursor.y+end-offset};offset=end;
          if(offset<ys.at(-1)-.001)cursor=next(cursor);
        }
        stats.tables++;return cursor;
      }
      async function nodeContent(node,cursor,x,width,keepAfter=0){
        currentRegion={...node,outputLane:{x,right:x+width}};
        const r=node.grid?.rect||node.flow?.rect||node.visual?.rect;
        if(r&&r.right-r.x<width){const right=x+width;x=Math.max(x,r.x);width=Math.min(right,r.right)-x;
          if(width<=0)throw layoutError("内容区域超出所属栏目","region");}
        if(node.kind==="table")return table(node,cursor,x,width);
        if(node.kind==="code")return code(node,cursor,x,width);
        if(node.kind==="retained"){
          per.quality.retainedRegions++;note("有歧义的行内内容整体保留，成功译文在补充页展示");
          for(const item of node.items)if(translated(item))deferred.set(item.id,item);
          return asset(node,cursor,x,width,node.sourceRegion);
        }
        if(node.kind==="contributors"){
          note("作者、机构、邮箱及所属标记整体保留原样");
          return asset(node,cursor,x,width,node.sourceRegion,{protectAll:true});
        }
        if(node.kind==="figure"){
          let region=node.sourceRegion;
          const captions=node.items.filter(item=>item.block.flow?.caption||item.kind==="caption"||item.id===node.visual?.captionId);
          const outside=captions.filter(item=>validRect(region)&&item.block.rect.y>=region.bottom);
          const sourceItems=node.items.filter(item=>!outside.includes(item));
          if(validRect(region)&&sourceItems.length){
            const expanded=pageRect(union([region,...sourceItems.map(item=>item.block.rect)]));
            const own=new Set(node.items.map(item=>item.id));
            if(expanded&&!outside.some(item=>item.block.rect.x<expanded.right&&item.block.rect.right>expanded.x&&item.block.rect.y<expanded.bottom&&item.block.rect.bottom>expanded.y)&&
              !allRows.some(({block})=>!own.has(block.id)&&validRect(block.rect)&&block.rect.x<expanded.right&&
              block.rect.right>expanded.x&&block.rect.y<expanded.bottom&&block.rect.bottom>expanded.y))region=expanded;
          }
          cursor=await asset({...node,items:sourceItems},cursor,x,width,region,{protectAll:true});
          if(canCrop&&validRect(region)){stats.figures++;if(sourceItems.length)note("图形及图内标注整体保留，图注按译文重排");}
          for(const item of outside){cursor=gap(cursor,item.block.height*.35);cursor=translated(item)?await text(item,cursor,x,width):await asset({items:[item]},cursor,x,width,item.block.rect);}
          return cursor;
        }
        if(node.inline||node.joinedHeading){
          const texts=node.items.filter(item=>item.block.role==="text");
          if(texts.length&&texts.every(translated)){
            const sorted=[...node.items].sort((a,b)=>Math.abs(a.block.rect.y-b.block.rect.y)>em*.6?a.block.rect.y-b.block.rect.y:a.block.rect.x-b.block.rect.x);
            const parts=sorted.map(item=>item.block.role==="text"?clean(item.text):item.block.rawText||item.block.text),value=parts.join(node.joinedHeading?" ":"");
            if(drawable(value)){
              // 合并展示节点后，旧结果中的范围不能继续按第一个块的偏移解释。
              const firstSize=median(texts.map(item=>sizes.get(item.id)||item.block.height)),inline=[];let offset=0;
              sorted.forEach((item,index)=>{
                const source=item.result?.inline;
                if(Array.isArray(source)&&item.text===parts[index])for(const span of source)inline.push({...span,start:span.start+offset,end:span.end+offset,
                  runs:span.runs.map(run=>({...run,height:run.height*firstSize/item.block.height,shift:run.shift*firstSize/item.block.height}))});
                offset+=parts[index].length+(node.joinedHeading?1:0);
              });
              const first=texts[0],safe={...first,text:value,kind:node.kind,keepAfter,reflowIds:node.items.map(item=>item.id),
                result:{...first.result,text:value,inline},reflowSize:firstSize,block:{...first.block,height:firstSize,rect:node.sourceRegion,lines:[]}};
              cursor=await text(safe,cursor,x,width);for(const item of node.items)count(item);return cursor;
            }
          }
          return asset(node,cursor,x,width);
        }
        for(const item of node.items){
          if(translated(item))cursor=await text({...item,keepAfter},cursor,x,width);
          else cursor=await asset({items:[item]},cursor,x,width,item.block.rect);
        }
        return cursor;
      }
      const firstLine=tree=>tree.kind==="node"?Math.max(em,...tree.node.items.map(item=>sizes.get(item.id)||item.block.height))*1.25:
        tree.children?.length?firstLine(tree.children[0]):em*1.25;
      async function layout(tree,cursor,x,width,keepAfter=0){
        budget();if(tree.kind==="node"){
          // 先排版并暂存绘制命令；失败只回滚本区域，不能留下半段文字再叠一层原图。
          const checkpoint={commands:commands.length,boxes:guard.mark(),anchors:per.anchors.length,sheets:sheets.length,output:per.output.length,
            outlines:outlines.length,counted:new Set(counted),stats:Object.fromEntries(Object.entries(stats).filter(([,v])=>typeof v==="number"))};
          try{return await nodeContent(tree.node,cursor,x,width,keepAfter);}
          catch(failure){
            if(failure.code!=="REFLOW_LAYOUT")throw failure;
            commands.length=checkpoint.commands;guard.restore(checkpoint.boxes);per.anchors.length=checkpoint.anchors;
            while(sheets.length>checkpoint.sheets){out.removePage(out.getPageCount()-1);sheets.pop();}
            per.output.length=checkpoint.output;outlines.length=checkpoint.outlines;Object.assign(stats,checkpoint.stats);
            counted.clear();for(const id of checkpoint.counted)counted.add(id);
            currentRegion={...tree.node,outputLane:{x,right:x+width}};diagnostic(failure.detailCode||failure.code,failure.stage,regionId(),tree.node.kind);
            per.quality.retainedRegions++;defer(tree.node);
            // 使用完整区域回退，不将未知结构继续拆成文字碎片。
            if(validRect(tree.node.sourceRegion))return asset(tree.node,cursor,x,width,tree.node.sourceRegion);
            return cursor;
          }
        }
        if(tree.kind==="columns"){
          let end=cursor;
          // 同一分栏区域共享起始页，各栏只在自己的横向范围内独立续页。
          // 返回最晚结束位置，让后续通栏内容等待所有栏目，不把整栏推到另一栏的续页。
          for(const child of tree.children){const lane=child.lane||child.rect,cx=lane.x,cw=lane.right-lane.x;
            const start=gap(cursor,child.rect.y-tree.rect.y);
            end=later(end,await layout(child,start,cx,cw));}
          if(end.sheet>cursor.sheet)note("分栏内容在各自栏目内续页，短栏续页可能留白");
          return end;
        }
        let previous=null;
        for(let index=0;index<tree.children.length;index++){
          const child=tree.children[index],following=tree.children[index+1];
          if(previous&&child.rect&&previous.rect)cursor=gap(cursor,Math.max(0,child.rect.y-previous.rect.bottom));
          const followingSpace=following?Math.max(0,(following.rect?.y||0)-(child.rect?.bottom||0))+firstLine(following):keepAfter;
          cursor=await layout(child,cursor,x,width,followingSpace);previous=child;
        }
        return cursor;
      }
      const pageStart=out.getPageCount(),outlineStart=outlines.length;
      const before=Object.fromEntries(Object.entries(stats).filter(([,value])=>typeof value==="number"));
      const checkOrder=part=>{
        if(part.kind==="node")return per.anchors.filter(a=>part.node.sourceIds.includes(a.id)).map(a=>a.page);
        const spans=part.children.map(checkOrder);
        // 栏间允许共享页面；只校验每栏内部及通栏区域之间的先后顺序。
        if(part.kind!=="columns"){
          let last=0;
          for(const pages of spans){if(!pages.length)continue;
            if(Math.min(...pages)<last)throw layoutError("区域续文的输出顺序不一致","reading-order");last=Math.max(...pages);}
        }
        return spans.flat();
      };
      try{
        if(layoutPossible){await sheetAt(0);await layout(tree,{sheet:0,y:top},rect.x,rect.right-rect.x);checkOrder(tree);}
      }catch(failure){
        // 仅恢复本模块明确识别的排版错误。预算、字体、源文件或未知引擎错误仍原样失败。
        if(failure.code!=="REFLOW_LAYOUT")throw failure;
        while(out.getPageCount()>pageStart)out.removePage(out.getPageCount()-1);
        outlines.length=outlineStart;Object.assign(stats,before);per.output.length=0;per.anchors.length=0;
        sheets.length=0;counted.clear();
        commands.length=0;guard.clear();
        diagnostic(failure.detailCode||failure.code,failure.stage,failure.regionId,failure.kind||"page");
        retain("本页结构排版未通过安全检查，已保留源页并单独展示可用译文");
      }
      // 任何未落笔的成功译文都有显式出口；不能把裁切的原文当作已呈现译文。
      const presented=new Set(per.anchors.map(anchor=>anchor.id));
      for(const item of rows)if(translated(item)){
        if(counted.has(item.id)&&!presented.has(item.id)){
          counted.delete(item.id);stats.translated--;if(item.result.userEdited)stats.edited--;
          diagnostic("OUTPUT_UNASSIGNED","coverage",item.id,item.kind);
        }
        if(!counted.has(item.id))deferred.set(item.id,item);
      }
      if(deferred.size){
        supplemental=true;top=margin;bottom=H-margin;
        let cursor={sheet:sheets.length,y:top};
        const size=Math.min(em,(W-margin*2)/4,(H-margin*2)/4);
        retain("部分成功译文在补充译文页展示，原区域请对照保留的源页");
        for(const item of rows.filter(item=>deferred.has(item.id)&&!counted.has(item.id))){
          currentRegion={kind:"supplement",items:[item],outputLane:{x:margin,right:W-margin}};
          const safe={...item,kind:"paragraph",reflowSize:size,plainReflow:true,block:{...item.block,height:size,lines:[],
            rect:{x:margin,y:top,right:W-margin,bottom:top+size}}};
          cursor=await text(safe,cursor,margin,W-margin*2);cursor=gap(cursor,size*.5);
        }
      }
      for(const item of rows)if(!counted.has(item.id)){counted.add(item.id);stats.retained++;retain("部分内容未能完整重排，已保留源页供核对");}
      per.quality.validatedBoxes=guard.count();
      per.quality.state=needsSource||deferred.size||per.quality.retainedRegions?"retained":"layout-checked";
      // 此处仅表示模型及绘制范围通过守卫，不宣称翻译质量或视觉还原已经人工验收。
      for(const command of commands){budget();await command();}
      if(needsSource||!per.output.length)await keepSource();
      postMessage({type:"progress",requestId:job.requestId,message:"已重排原文第 "+target.page+" 页"});
    }
    stats.bookmarks=addOutlines(out,outlines);stats.pages=out.getPageCount();stats.font=job.fontCode||"builtin";
    stats.fontCodes=setup.usedCodes();stats.fontFull=setup.fullCodes();stats.customFont=setup.custom;
    const bytes=await out.save();return {bytes:bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),stats};
  }
  global.BT_PDF_REFLOW_DOCUMENT={compose};
})(self);
