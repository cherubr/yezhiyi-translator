(function(global) {
  "use strict";
  function fitText(text,rect,size,family,auto,planner,textStyle) {
    if(!rect||![rect.x,rect.y,rect.right,rect.bottom].every(Number.isFinite)||rect.right-rect.x<4||rect.bottom-rect.y<4)
      return {ok:false,size:10,reason:"文字框太小，请重新画框"};
    if(!Number.isFinite(size)||size<4||size>72)return {ok:false,size:10,reason:"字号应为 4 至 72"};
    const style=planner.normalizeTextStyle?.(textStyle)||{lineHeight:1.45};
    const width=rect.right-rect.x,height=rect.bottom-rect.y,measure=(value,points)=>planner.measure(value,points,family,style);
    let current=size;
    for(let tier=0;tier<64;tier++){
      const lines=planner.wrapText(text||" ",current,width*.97,measure);
      if(lines.length*current*style.lineHeight<=height&&lines.every(line=>measure(line,current)<=width))return {ok:true,size:current};
      if(!auto||current<=4)return {ok:false,size:current,reason:"框内放不下，请缩短文字、调小字号，或取消后重新画大一些"};
      current=Math.max(4,current*.94);
    }
    return {ok:false,size:current,reason:"框内放不下，请调小字号或重新画框"};
  }
  /** 只从框内现有文字带入内容，重画同一处人工译文时优先修改该记录。 */
  function rowsInRect(rows,rect,getRect=block=>block.rect) {
    const area=r=>Math.max(0,r.right-r.x)*Math.max(0,r.bottom-r.y);
    return rows.filter(row=>{
      const r=getRect(row.block,row.result);if(!r||area(r)<=0)return false;
      const intersection=Math.max(0,Math.min(r.right,rect.right)-Math.max(r.x,rect.x))*Math.max(0,Math.min(r.bottom,rect.bottom)-Math.max(r.y,rect.y));
      return intersection/area(r)>=.5;
    }).sort((a,b)=>{
      const ar=getRect(a.block,a.result),br=getRect(b.block,b.result);
      return Math.abs(ar.y-br.y)>Math.min(a.block.height||10,b.block.height||10)*.5?ar.y-br.y:ar.x-br.x;
    });
  }
  /** 框选上层修订时只带入可见的那一层，避免将下层旧文字再次拼入。 */
  function rowsForEdit(rows,rect,getRect=block=>block.rect) {
    const matched=rowsInRect(rows,rect,getRect),area=(rect.right-rect.x)*(rect.bottom-rect.y);
    const manual=matched.filter(row=>row.result?.manualPlacement).sort((a,b)=>{
      const order=row=>Number.isFinite(row.result.correctionOrder)?row.result.correctionOrder:0;
      return order(b)-order(a)||rows.indexOf(b)-rows.indexOf(a);
    });
    const top=manual[0];
    if(top&&area>0){
      const r=getRect(top.block,top.result),intersection=Math.max(0,Math.min(r.right,rect.right)-Math.max(r.x,rect.x))*Math.max(0,Math.min(r.bottom,rect.bottom)-Math.max(r.y,rect.y));
      if(intersection/area>=.9)return [top];
    }
    return matched;
  }
  /** 固定 PDF 坐标中移动／调整矩形，最小尺寸与页面边界始终有效。 */
  function adjustRect(rect,dx,dy,edges,bounds) {
    const r={...rect},clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
    if(edges==="move"){
      dx=clamp(dx,-r.x,bounds.width-r.right);dy=clamp(dy,-r.y,bounds.height-r.bottom);
      return {x:r.x+dx,y:r.y+dy,right:r.right+dx,bottom:r.bottom+dy};
    }
    if(edges.includes("w"))r.x=clamp(r.x+dx,0,r.right-4);
    if(edges.includes("e"))r.right=clamp(r.right+dx,r.x+4,bounds.width);
    if(edges.includes("n"))r.y=clamp(r.y+dy,0,r.bottom-4);
    if(edges.includes("s"))r.bottom=clamp(r.bottom+dy,r.y+4,bounds.height);
    return r;
  }
  function create({getInput,onPrepare,onSave,onSaved,onClear}) {
    const $=id=>document.getElementById(id),panel=$("inplacePanel"),input=$("inplaceText"),box=$("inplaceSelection"),
      toggle=$("toggleInplaceEdit"),planner=global.BT_PDF_LAYOUT_PLANNER,listeners=[],drafts=new Map();
    let active=false,selected=null,drag=null,adjustment=null,panelDrag=null,saving=false,preparing=false,composing=false,disposed=false,noticeTimer=null,panelPositioned=false;
    const identity=()=>getInput().identity;
    const listen=(node,name,fn,options)=>{node.addEventListener(name,fn,options);listeners.push(()=>node.removeEventListener(name,fn,options));};
    function notice(text){$("inplaceNotice").textContent=text;$("inplaceNotice").hidden=false;clearTimeout(noticeTimer);noticeTimer=setTimeout(()=>{$("inplaceNotice").hidden=true;},4000);}
    function controls(){
      const state=getInput(),enabled=!!selected&&state.ready&&!state.busy&&!saving;
      for(const id of ["inplaceText","inplaceFont","inplaceSize","inplaceAutoFit","inplaceBold","inplaceItalic","inplaceColor","inplaceAlign","inplaceLineHeight","inplaceSave","inplaceCancel","inplaceClose"])$(id).disabled=!enabled;
      $("inplaceRestore").hidden=!selected?.blockId;$("inplaceRestore").disabled=!enabled;
      box.dataset.editable=String(enabled);
      for(const button of box.querySelectorAll("button"))button.disabled=!enabled;
      toggle.disabled=saving||preparing||state.busy||!state.supported||!(state.ready||state.canPrepare);
      toggle.hidden=!state.supported;
      $("clearInplaceTranslation").hidden=!state.supported;
      $("clearInplaceTranslation").disabled=saving||preparing||state.busy||!state.ready||!(selected||state.rows.some(row=>row.result?.status==="translated"||row.result?.userEdited));
    }
    function stash(){
      if(!selected)return;
      drafts.delete(selected.key);drafts.set(selected.key,{text:input.value,rect:{...selected.rect},fontFamily:$("inplaceFont").value,size:Number($("inplaceSize").value),auto:$("inplaceAutoFit").checked,textStyle:readStyle()});
      if(drafts.size>64)drafts.delete(drafts.keys().next().value);
    }
    function closeEditor(keep=false){
      stopAdjustment();stopPanelDrag();
      if(keep)stash();else if(selected)drafts.delete(selected.key);
      selected=null;composing=false;input.value="";if(panel.open)panel.close();panel.hidden=true;box.hidden=true;controls();
    }
    function target(viewport){
      const state=getInput(),canvas=viewport?.querySelector("canvas");
      if(!state.ready||!canvas?.width||!state.geometry||!state.view||!(viewport.id==="viewport"?state.left:state.right))return null;
      const bounds=canvas.getBoundingClientRect(),BM=global.BT_PDF_BLOCKS.matrix;
      if(!bounds.width||!bounds.height)return null;
      const matrix=BM.compose(state.view.viewportTransform,BM.invert(state.geometry.transform)),inverse=BM.invert(matrix),kx=bounds.width/state.view.width,ky=bounds.height/state.view.height;
      return {viewport,state,
        point:(x,y)=>BM.apply(inverse,(x-bounds.left)/kx,(y-bounds.top)/ky),
        screen:r=>{
          const points=[[r.x,r.y],[r.right,r.y],[r.right,r.bottom],[r.x,r.bottom]].map(([x,y])=>BM.apply(matrix,x,y));
          const xs=points.map(p=>bounds.left+p[0]*kx),ys=points.map(p=>bounds.top+p[1]*ky);
          return {x:Math.min(...xs),y:Math.min(...ys),right:Math.max(...xs),bottom:Math.max(...ys)};
        }};
    }
    function outline(rect){box.hidden=false;Object.assign(box.style,{left:rect.x+"px",top:rect.y+"px",width:(rect.right-rect.x)+"px",height:(rect.bottom-rect.y)+"px"});}
    function track(){if(selected){const view=target(selected.viewport);if(view)outline(view.screen(selected.rect));else box.hidden=true;}}
    function placePanel(x,y){
      const r=panel.getBoundingClientRect();
      panel.style.left=Math.max(12,Math.min(global.innerWidth-r.width-12,x))+"px";
      panel.style.top=Math.max(12,Math.min(global.innerHeight-r.height-12,y))+"px";
    }
    function containPanel(){if(panel.open){const r=panel.getBoundingClientRect();placePanel(r.left,r.top);}}
    function stopPanelDrag(){const value=panelDrag;panelDrag=null;if(value&&value.node.hasPointerCapture(value.pointer))value.node.releasePointerCapture(value.pointer);}
    function stopAdjustment(cancel=false){
      const value=adjustment;adjustment=null;
      if(value&&cancel&&selected===value.chosen)selected.rect={...value.rect};
      if(value&&box.hasPointerCapture(value.pointer))box.releasePointerCapture(value.pointer);
      if(value){track();preview();}
    }
    listen(panel.querySelector(".inplace-heading"),"pointerdown",event=>{
      if(event.button!==0||saving||composing||event.target.closest("button"))return;
      const r=panel.getBoundingClientRect(),node=event.currentTarget;
      panelDrag={node,pointer:event.pointerId,x:event.clientX,y:event.clientY,left:r.left,top:r.top};
      node.setPointerCapture(event.pointerId);event.preventDefault();
    });
    listen(panel,"pointermove",event=>{
      if(!panelDrag||panelDrag.pointer!==event.pointerId)return;
      placePanel(panelDrag.left+event.clientX-panelDrag.x,panelDrag.top+event.clientY-panelDrag.y);event.preventDefault();
    });
    for(const name of ["pointerup","pointercancel","lostpointercapture"])listen(panel,name,event=>{if(panelDrag?.pointer===event.pointerId)stopPanelDrag();});
    listen(box,"pointerdown",event=>{
      if(!selected||!getInput().ready||getInput().busy||saving||composing||event.button!==0)return;
      const view=target(selected.viewport);if(!view)return;
      const handle=event.target.closest("[data-handle]")?.dataset.handle||"move",screen=view.screen(selected.rect);
      let edges="move";
      if(handle!=="move"){
        // 屏幕上的手柄先映射回固定坐标边，旋转 90° 后仍拖动鼠标所在的那条边。
        const sx=handle.includes("w")?screen.x:handle.includes("e")?screen.right:(screen.x+screen.right)/2;
        const sy=handle.includes("n")?screen.y:handle.includes("s")?screen.bottom:(screen.y+screen.bottom)/2;
        const [x,y]=view.point(sx,sy),r=selected.rect;
        edges=(Math.abs(x-r.x)<.01?"w":Math.abs(x-r.right)<.01?"e":"")+(Math.abs(y-r.y)<.01?"n":Math.abs(y-r.bottom)<.01?"s":"");
      }
      adjustment={chosen:selected,view,pointer:event.pointerId,start:view.point(event.clientX,event.clientY),rect:{...selected.rect},edges};
      box.setPointerCapture(event.pointerId);event.preventDefault();event.stopPropagation();
    });
    listen(box,"pointermove",event=>{
      const value=adjustment;if(!value||value.pointer!==event.pointerId)return;
      if(selected!==value.chosen||selected.identity!==identity()||!getInput().ready){stopAdjustment(true);return;}
      const view=target(selected.viewport);if(!view){stopAdjustment(true);return;}
      const [x,y]=view.point(event.clientX,event.clientY);
      selected.rect=adjustRect(value.rect,x-value.start[0],y-value.start[1],value.edges,view.state.geometry);
      track();preview();event.preventDefault();
    });
    listen(box,"pointerup",event=>{if(adjustment?.pointer===event.pointerId){stopAdjustment();event.preventDefault();}});
    for(const name of ["pointercancel","lostpointercapture"])listen(box,name,event=>{if(adjustment?.pointer===event.pointerId)stopAdjustment(true);});
    // 手柄也支持沿屏幕方向微调；Shift + 方向键加速。
    listen(box,"keydown",event=>{
      if(!selected||saving||composing||getInput().busy||!getInput().ready||!["ArrowLeft","ArrowRight","ArrowUp","ArrowDown"].includes(event.key))return;
      const view=target(selected.viewport);if(!view)return;
      const step=event.shiftKey?10:1,screen=view.screen(selected.rect),cx=(screen.x+screen.right)/2,cy=(screen.y+screen.bottom)/2;
      const [x,y]=view.point(cx,cy),[nx,ny]=view.point(cx+(event.key==="ArrowRight"?step:event.key==="ArrowLeft"?-step:0),cy+(event.key==="ArrowDown"?step:event.key==="ArrowUp"?-step:0));
      selected.rect=adjustRect(selected.rect,nx-x,ny-y,"move",view.state.geometry);track();preview();event.preventDefault();
    });
    const panelObserver=typeof global.ResizeObserver==="function"?new global.ResizeObserver(containPanel):null;
    panelObserver?.observe(panel);
    function readStyle(){return planner.normalizeTextStyle({bold:$("inplaceBold").getAttribute("aria-pressed")==="true",italic:$("inplaceItalic").getAttribute("aria-pressed")==="true",
      color:$("inplaceColor").value,align:$("inplaceAlign").value,lineHeight:Number($("inplaceLineHeight").value)});}
    function preview(){
      if(!selected||composing)return;
      const style=readStyle(),size=Number($("inplaceSize").value);
      const fit=fitText(input.value,selected.rect,size,$("inplaceFont").value,$("inplaceAutoFit").checked,planner,style);
      Object.assign(input.style,{fontFamily:planner.fontStack($("inplaceFont").value),fontSize:(fit.ok?fit.size:Math.max(4,Math.min(72,size||10)))+"px",
        fontWeight:style.bold?"700":"400",fontStyle:style.italic?"italic":"normal",color:style.color,textAlign:style.align||selected.align,lineHeight:String(style.lineHeight)});
      $("inplaceMessage").textContent=fit.ok?"整框文字使用同一样式，白底覆盖。"+($("inplaceAutoFit").checked?"实际字号："+Math.round(fit.size*10)/10+"（自动适配）。":"实际字号："+size+"。")+"弹框预览不代表页面缩放比例。":fit.reason;
      input.setAttribute("aria-invalid",String(!fit.ok));
    }
    function show(view,rect){
      const getRect=(block,result)=>result?.manualPlacement?.rect||view.state.getPlacement?.(block.id,view.viewport.id)?.maskRect||block.rect;
      const rows=rowsForEdit(view.state.rows,rect,getRect);
      const row=rows.length===1?rows[0]:null;
      const key=JSON.stringify([identity(),rect.x,rect.y,rect.right,rect.bottom]);
      selected={identity:identity(),viewport:view.viewport,rect:{...rect},blockId:row?.block.id||null,replaceIds:row?[]:rows.map(row=>row.block.id),key,align:row?.block.direction==="rtl"?"right":"left"};
      const draft=drafts.get(key),layout=row&&view.state.getPlacement?.(row.block.id,view.viewport.id);
      if(draft?.rect)selected.rect={...draft.rect};
      input.value=draft?.text??rows.map(row=>["translated","unchanged"].includes(row.result?.status)?row.result.text:row.block.text).join("\n");
      $("inplaceFont").value=draft?.fontFamily||row?.result?.fontFamily||"sans-serif";
      $("inplaceSize").value=String(draft?.size||row?.result?.manualPlacement?.fontSize||layout?.fontSize||Math.max(4,Math.min(72,row?.block.height||10)));
      $("inplaceAutoFit").checked=draft?.auto??true;
      const style=planner.normalizeTextStyle(draft?.textStyle||row?.result?.textStyle);
      $("inplaceBold").setAttribute("aria-pressed",String(style.bold));$("inplaceItalic").setAttribute("aria-pressed",String(style.italic));
      $("inplaceColor").value=style.color;$("inplaceAlign").value=style.align||selected.align;$("inplaceLineHeight").value=String(style.lineHeight);
      $("inplaceTitle").textContent=rows.length?"修改框内文字":"填写框内文字";
      $("inplaceRestore").textContent=row?.block.source==="manual"?"删除这段译文":"恢复自动结果";
      panel.hidden=false;controls();preview();track();if(!panel.open)panel.show();
      if(!panelPositioned){
        const frame=view.screen(selected.rect),width=panel.getBoundingClientRect().width;
        placePanel(frame.right+width+24<=global.innerWidth?frame.right+12:frame.x-width-12>=12?frame.x-width-12:global.innerWidth-width-16,Math.max(80,frame.y));panelPositioned=true;
      }else containPanel();
      input.focus({preventScroll:true});input.setSelectionRange(input.value.length,input.value.length);
    }
    function stopDrag(){const value=drag;drag=null;if(value?.viewport.hasPointerCapture(value.pointer))value.viewport.releasePointerCapture(value.pointer);}
    for(const viewport of [$("viewport"),$("bilingualViewport")]){
      listen(viewport,"click",event=>{if(active){event.preventDefault();event.stopImmediatePropagation();}},true);
      listen(viewport,"pointerdown",event=>{
        if(!active||saving||getInput().busy||event.button!==0)return;
        const view=target(viewport);if(!view)return;
        if(panel.open){event.preventDefault();event.stopImmediatePropagation();return;}
        const [x,y]=view.point(event.clientX,event.clientY),g=view.state.geometry;
        if(x<0||y<0||x>g.width||y>g.height)return;
        event.preventDefault();event.stopImmediatePropagation();
        drag={view,viewport,pointer:event.pointerId,start:[x,y],rect:{x,y,right:x,bottom:y},identity:identity()};viewport.setPointerCapture(event.pointerId);
      },true);
      listen(viewport,"pointermove",event=>{
        if(!drag||drag.viewport!==viewport||drag.pointer!==event.pointerId)return;
        const [px,py]=drag.view.point(event.clientX,event.clientY),g=drag.view.state.geometry,x=Math.max(0,Math.min(g.width,px)),y=Math.max(0,Math.min(g.height,py)),[sx,sy]=drag.start;
        drag.rect={x:Math.min(sx,x),y:Math.min(sy,y),right:Math.max(sx,x),bottom:Math.max(sy,y)};outline(drag.view.screen(drag.rect));event.preventDefault();
      },true);
      listen(viewport,"pointerup",event=>{
        if(!drag||drag.viewport!==viewport||drag.pointer!==event.pointerId)return;
        const value=drag;stopDrag();event.preventDefault();event.stopImmediatePropagation();
        if(value.identity!==identity()||value.rect.right-value.rect.x<4||value.rect.bottom-value.rect.y<4){box.hidden=true;notice("请拖动画出一个文字框");return;}
        show(value.view,value.rect);
      },true);
      for(const name of ["pointercancel","lostpointercapture"])listen(viewport,name,()=>{if(drag?.viewport===viewport){stopDrag();box.hidden=true;}});
      listen(viewport,"scroll",track,{passive:true});
    }
    async function save(restore=false){
      if(saving||composing||adjustment||panelDrag||!selected||selected.identity!==identity()||!getInput().ready||getInput().busy)return;
      const chosen=selected,text=input.value,fontFamily=$("inplaceFont").value,textStyle=readStyle();
      try{
        const fit=fitText(text,chosen.rect,Number($("inplaceSize").value),fontFamily,$("inplaceAutoFit").checked,planner,textStyle);
        if(!restore&&(!text.trim()||text.length>20000))throw new Error("请输入文字，最多两万字");
        if(!restore&&!fit.ok)throw new Error(fit.reason);
        // 人工画框表示明确覆盖意图；与旧框部分相交时按保存顺序叠放，不要求扩大到整段。
        saving=true;controls();
        const id=await onSave({identity:chosen.identity,blockId:chosen.blockId,replaceIds:chosen.replaceIds,text,fontFamily,textStyle,
          placement:restore?null:{rect:{...chosen.rect},fontSize:fit.size},restore});
        drafts.delete(chosen.key);if(selected===chosen)closeEditor();onSaved(id,restore);notice(restore?"已恢复或删除译文":"已保存，可以继续画框修改");
      }catch(error){if(selected===chosen)$("inplaceMessage").textContent=error.message||"保存失败，请重试";else notice("保存未完成，文字草稿仍保留");}
      finally{saving=false;refresh();}
    }
    function refresh(){
      if(disposed)return;
      const state=getInput();
      if(adjustment&&(selected?.identity!==state.identity||!state.ready))stopAdjustment(true);
      if(drag&&(drag.identity!==state.identity||!state.ready||state.busy)){stopDrag();box.hidden=true;}
      if(selected&&(selected.identity!==state.identity||!state.supported||state.busy)){closeEditor(true);active=false;}
      if(active&&(!state.supported||state.busy)){closeEditor(true);active=false;}
      document.body.dataset.inplaceEdit=String(active);toggle.setAttribute("aria-pressed",String(active));controls();track();
    }
    toggle.onclick=async()=>{
      if(saving||preparing||getInput().busy)return;
      if(!active&&!getInput().ready){
        const expected=identity();preparing=true;refresh();notice("正在准备页面文字…");
        try{await onPrepare();if(disposed||expected!==identity()||!getInput().ready)return;}
        catch(error){notice(error.message||"暂时无法修订，请重试");return;}
        finally{preparing=false;refresh();}
      }
      active=!active;if(!active){stopDrag();closeEditor(true);}else notice("在译文页面拖画一个框，松开鼠标后编辑文字");refresh();
    };
    $("clearInplaceTranslation").onclick=async()=>{
      if(saving||preparing||getInput().busy)return;
      const expected=identity();stopDrag();stopAdjustment();stopPanelDrag();closeEditor();drafts.clear();active=false;saving=true;refresh();
      try{await onClear(expected);notice("已取消本页译文并恢复原文");}
      catch(error){notice(error.message||"清除失败，请重试");}
      finally{saving=false;refresh();}
    };
    const cancel=()=>{if(saving||composing)return;closeEditor();notice("已取消，可以重新画框");};
    $("inplaceClose").onclick=$("inplaceCancel").onclick=cancel;
    $("inplaceSave").onclick=()=>void save();$("inplaceRestore").onclick=()=>void save(true);
    listen(panel,"cancel",event=>{event.preventDefault();cancel();});
    for(const id of ["inplaceFont","inplaceSize","inplaceAutoFit","inplaceColor","inplaceAlign","inplaceLineHeight"])listen($(id),"input",preview);
    for(const id of ["inplaceBold","inplaceItalic"])listen($(id),"click",()=>{$(id).setAttribute("aria-pressed",String($(id).getAttribute("aria-pressed")!=="true"));preview();});
    listen(input,"input",preview);listen(input,"compositionstart",()=>{composing=true;});listen(input,"compositionend",()=>{composing=false;preview();});
    listen(global,"resize",()=>{stopAdjustment();stopPanelDrag();track();containPanel();});
    listen(document,"keydown",event=>{
      if(!active||saving||event.isComposing||composing)return;
      if(event.key==="Escape"&&adjustment){event.preventDefault();stopAdjustment(true);}
      else if(event.key==="Escape"&&panelDrag){event.preventDefault();stopPanelDrag();}
      else if(event.key==="Escape"&&panel.open){event.preventDefault();cancel();}
      else if(event.key==="Escape"){event.preventDefault();stopDrag();box.hidden=true;active=false;refresh();toggle.focus({preventScroll:true});}
      else if((event.ctrlKey||event.metaKey)&&event.key==="Enter"&&panel.open){event.preventDefault();void save();}
    });
    function reset(){stopDrag();closeEditor();drafts.clear();active=false;refresh();}
    function dispose(){disposed=true;stopDrag();panelObserver?.disconnect();clearTimeout(noticeTimer);closeEditor(true);for(const off of listeners)off();}
    return {refresh,reset,dispose};
  }
  global.BT_PDF_INPLACE_EDITOR={create,fitText,rowsInRect,rowsForEdit,adjustRect};
})(window);
