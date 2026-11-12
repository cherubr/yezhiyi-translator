(function(global) {
  "use strict";
  const E=global.BT_PDF_ERRORS;
  // 仅展示生成器返回的 PDF；编号与命中区域是定位按钮，不参与文字绘制或覆盖。
  function create({panel,viewport,status,previous,next,retry,cancel,font,getInput,generate,onLocate,onEdit}) {
    let visible=false,dirty=true,revision=0,timer=null,resizeTimer=null,controller=null,reader=null,handle=null;
    let data=null,page=1,selected=null,pendingReveal=null,scope="",disposed=false,renderToken=0,frame=null,restore=null,failure=null,renderFailed=false;
    const positions=new Map();
    function remember(){if(!scope||!data)return;positions.delete(scope);positions.set(scope,{page,x:viewport.scrollLeft,y:viewport.scrollTop,selected});
      if(positions.size>128)positions.delete(positions.keys().next().value);}
    function controls(busy=!!controller){
      const waiting=dirty&&!failure;
      previous.disabled=busy||waiting||!data||page<=1;next.disabled=busy||waiting||!data||page>=data.stats.pages;
      cancel.hidden=!busy;retry.hidden=busy||!(dirty||failure||renderFailed)||!getInput().available||getInput().busy;
      font.hidden=busy||!failure?.needsFont;
    }
    function clearFrame(){renderToken++;handle?.cancel();handle=null;if(frame){frame.canvas.width=frame.canvas.height=0;frame=null;}viewport.replaceChildren();}
    async function closeReader(){const old=reader;reader=null;clearFrame();if(old)await old.close();}
    const abort=()=>{controller?.abort(E.cancelled());controller=null;};
    function describe(){
      const source=data.stats.per[0],entry=source.output.find(item=>item.page===page);
      const translations=source.output.filter(item=>item.kind==="translation"),originals=source.output.filter(item=>item.kind==="source");
      status.textContent="对应原文第 "+source.page+" 页 · "+(entry?.kind==="source"?"原文保留页":"译文第 "+(translations.findIndex(item=>item.page===page)+1)+" / "+translations.length+" 页")+
        (entry?.supplemental?"（补充译文）":"")+(originals.length?" · 另含原文保留页 "+originals.length+" 页":"")+
        (source.quality?.state==="retained"?" · 部分区域保留原文":"")+
        (source.warnings?.length?" · "+source.warnings.join("；"):"")+
        (failure?" · "+(failure.cancelled?"重排已取消":"更新失败")+"，当前显示上次版本："+failure.message:"");
    }
    function highlight(id){selected=id;if(frame)for(const button of frame.layer.children)button.classList.toggle("reflow-selected",button.dataset.blockId===id);}
    async function paint(doc,done,number,input,signal,onTask){
      let canvas=null;
      try{
        const size=await doc.pageSize({pageNumber:number,viewRotation:input.rotation},{signal});
        E.check(signal);
        const width=Math.max(1,viewport.clientWidth-24),height=Math.max(1,viewport.clientHeight-24);
        const scale=input.fitMode?Math.max(.25,Math.min(4,width/size.width,input.fitMode==="fit-page"?height/size.height:Infinity)):input.scale;
        const viewKey=[number,scale,input.rotation].join(":");
        if(frame?.doc===doc&&frame.key===viewKey)return frame;
        canvas=document.createElement("canvas");
        const task=doc.renderPage({pageNumber:number,scale,viewRotation:input.rotation,canvas,pixelBudget:4000000},{signal});onTask?.(task);
        const info=await task.promise;
        E.check(signal);
        const sheet=document.createElement("div"),layer=document.createElement("div");sheet.className="reflow-sheet";layer.className="reflow-locations";
        sheet.style.width=info.width+"px";sheet.style.height=info.height+"px";
        canvas.setAttribute("role","img");canvas.setAttribute("aria-label","重排译文第 "+number+" 页");
        sheet.append(canvas,layer);
        const entry=done.stats.per[0].output.find(item=>item.page===number);
        if(!entry||!Number.isFinite(entry.height)||entry.height<=0)
          throw E.create("REFLOW_PREVIEW_INVALID","重排页面信息不完整，请重新生成。","render");
        const point=(x,y)=>{const m=info.viewportTransform,py=entry.height-y;return [m[0]*x+m[2]*py+m[4],m[1]*x+m[3]*py+m[5]];};
        // 同段的每个行框独立命中，不能合并成覆盖邻栏、表格空白和其他段落的大矩形。
        const anchors=done.stats.per[0].anchors.filter(a=>a.page===number),focusable=new Set();
        for(const a of anchors){
          const points=[point(a.x,a.y),point(a.x+a.width,a.y),point(a.x,a.y+a.height),point(a.x+a.width,a.y+a.height)],
            x=Math.max(0,Math.min(...points.map(p=>p[0]))),y=Math.max(0,Math.min(...points.map(p=>p[1]))),
            right=Math.min(info.width,Math.max(...points.map(p=>p[0]))),bottom=Math.min(info.height,Math.max(...points.map(p=>p[1])));
          if(right<=x||bottom<=y)continue;
          const button=document.createElement("button");button.type="button";button.className="reflow-anchor";button.dataset.blockId=a.id;
          if(focusable.has(a.id))button.tabIndex=-1;else focusable.add(a.id);
          button.style.cssText="left:"+x+"px;top:"+y+"px;width:"+(right-x)+"px;height:"+(bottom-y)+"px";
          button.setAttribute("aria-label","定位对应原文；双击编辑译文");button.title="点击定位原文，双击编辑译文";
          button.onclick=()=>{highlight(a.id);onLocate(a.id);};button.ondblclick=()=>onEdit(a.id);
          layer.append(button);
        }
        return {canvas,layer,sheet,key:viewKey,doc,number};
      }catch(error){if(canvas)canvas.width=canvas.height=0;throw error;}
    }
    function install(nextFrame){
      if(frame!==nextFrame){if(frame)frame.canvas.width=frame.canvas.height=0;frame=nextFrame;viewport.replaceChildren(frame.sheet);}
      renderFailed=false;highlight(selected);describe();controls();
      if(restore){viewport.scrollLeft=restore.x;viewport.scrollTop=restore.y;restore=null;}
      if(pendingReveal)reveal(pendingReveal);
    }
    async function render(){
      if(!visible||!reader||!data||dirty&&!failure||controller||disposed)return;
      const token=++renderToken,doc=reader,done=data,number=page,old=handle;old?.cancel();if(old)try{await old.promise;}catch(_){}
      if(token!==renderToken||doc!==reader||disposed)return;
      let painted=null;
      try{
        painted=await paint(doc,done,number,getInput(),undefined,task=>{handle=task;});
        if(token!==renderToken||doc!==reader||disposed){if(painted!==frame)painted.canvas.width=painted.canvas.height=0;return;}
        handle=null;install(painted);
      }catch(error){
        if(token===renderToken&&doc===reader&&error.code!=="CANCELLED"){
          renderFailed=true;status.textContent="译文第 "+number+" 页显示失败，可重试；画面保留上次成功页面，翻译结果未清除。";controls();
        }
      }
    }
    async function build(authorization){
      const input=getInput();if(disposed||!visible||input.busy)return;
      if(!input.available){data=null;void closeReader();failure=null;status.textContent="翻译当前页后生成重排译文。";controls();return;}
      abort();const local=new AbortController(),version=revision;controller=local;controls(true);status.textContent="正在重建译文页面…";
      let candidate=null,painted=null;
      const current=()=>controller===local&&version===revision&&!disposed&&getInput().scope===input.scope;
      try{
        const done=await generate({signal:local.signal,authorization,onProgress:value=>{if(version===revision&&!local.signal.aborted&&value.message)status.textContent=value.message;}});
        E.check(local.signal);if(!current())return;
        candidate=global.BT_PDF_READER.create();
        await candidate.open(new Uint8Array(done.bytes),{signal:local.signal,onPassword:async()=>null});
        E.check(local.signal);if(!current())return;
        remember();const saved=positions.get(input.scope)||null,number=Math.min(saved?.page||1,done.stats.pages);
        // 首屏在离屏 canvas 上完成后才交换；打开或绘制失败均不撤掉上次有效结果。
        painted=await paint(candidate,done,number,getInput(),local.signal);
        E.check(local.signal);if(!current())return;
        remember();const old=reader;renderToken++;handle?.cancel();handle=null;
        reader=candidate;candidate=null;data=done;scope=input.scope;restore=positions.get(scope)||saved;page=number;
        if(!pendingReveal)selected=restore?.selected||selected;dirty=false;failure=null;
        install(painted);painted=null;if(old)void old.close();
      }catch(error){
        if(!current())return;
        dirty=true;failure={message:error.code==="CANCELLED"?"可重新生成。":error.message||"重排译文生成失败，请重试。",
          cancelled:error.code==="CANCELLED",needsFont:error.code==="REFLOW_FONT_NEEDED"};
        if(data)describe();else status.textContent=failure.message+" 已有译文仍可在下方「编辑译文」中查看。";
      }finally{
        if(painted)painted.canvas.width=painted.canvas.height=0;
        if(candidate)await candidate.close();
        const active=current();if(controller===local)controller=null;
        if(active){controls();if(!dirty||failure)void render();}
      }
    }
    function update(){
      dirty=true;revision++;renderToken++;handle?.cancel();abort();clearTimeout(timer);
      const input=getInput();
      if(input.scope!==scope){remember();data=null;selected=null;pendingReveal=null;failure=null;renderFailed=false;void closeReader();scope=input.scope;}
      if(!visible)return;
      controls();if(input.busy){status.textContent="翻译处理中，完成后更新重排译文。";return;}
      timer=setTimeout(()=>{timer=null;void build();},450);
    }
    function reveal(id){
      selected=id;pendingReveal=id;
      // 更新期间只记住最后一次点击，等待当前页的有效生成结果，不能使用旧页映射。
      if(!visible||!data||dirty||controller)return;
      const source=data.stats.per[0],anchors=source.anchors.filter(a=>a.id===id);
      // 保留原区域与补充译文可能共用块 ID；优先展示真正的补充译文。
      const outputs=new Map(source.output.map(item=>[item.page,item]));
      const a=anchors.find(a=>outputs.get(a.page)?.supplemental)||
        anchors.find(a=>outputs.get(a.page)?.kind==="translation")||anchors[0];
      if(!a){pendingReveal=null;onEdit(id);return;}
      if(a.page!==page||frame?.doc!==reader||frame?.number!==page){
        page=a.page;restore=null;void render();return;
      }
      highlight(id);const target=Array.from(frame.layer.children).find(button=>button.dataset.blockId===id);
      pendingReveal=null;
      if(!target){onEdit(id);return;}
      target.scrollIntoView({block:"nearest",inline:"nearest"});target.focus({preventScroll:true});
    }
    previous.onclick=()=>{if(page>1){page--;pendingReveal=null;restore={x:0,y:0};viewport.scrollTop=0;void render();}};
    next.onclick=()=>{if(data&&page<data.stats.pages){page++;pendingReveal=null;restore={x:0,y:0};viewport.scrollTop=0;void render();}};
    retry.onclick=()=>{if(renderFailed&&!dirty){void render();return;}dirty=true;void build();};
    cancel.onclick=()=>{revision++;abort();dirty=true;failure={cancelled:true,message:"可重新生成。"};controls();
      if(data)describe();else status.textContent="重排已取消，可重新生成。";};
    font.onclick=()=>{const authorization=global.BT_PDF_FONT_STORE.authorize();void build(authorization);};
    const observer=new ResizeObserver(()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>void render(),180);});observer.observe(viewport);
    controls();
    return {update,reveal,highlight,setVisible(value){const changed=visible!==value;visible=value;if(!value){remember();clearTimeout(timer);return;}if(dirty&&!failure&&changed)update();else if(changed||!frame)void render();},
      refresh(){if(visible&&(!dirty||failure)){remember();restore=positions.get(scope)||null;void render();}},clear(){revision++;abort();clearTimeout(timer);data=null;dirty=true;scope="";selected=pendingReveal=null;failure=null;renderFailed=false;positions.clear();void closeReader();controls();},
      dispose(){disposed=true;revision++;abort();clearTimeout(timer);clearTimeout(resizeTimer);observer.disconnect();void closeReader();}};
  }
  global.BT_PDF_REFLOW_PREVIEW={create};
})(window);
