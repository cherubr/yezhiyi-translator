(function(global) {
  "use strict";
  const M=global.BT_PDF_EDITOR_MODEL,O=global.BT_PDF_EDITOR_OPERATIONS;
  function create({viewport,paper,toolbar,status,getInput,onLocate,onVisual,storage=global.BT_PDF_EDITOR_STORE.create()}) {
    const entries=new Map(),listeners=[],printJobs=new Map();
    let current=null,mountedEntry=null,range=null,loadToken=0,disposed=false,captureTimer=null,saveTimer=null,selected=null,composing=false;
    let editorZoom="reader",markedCell=null,markedImage=null,searchIndex=-1,searchTimer=null,editingCommand=false,lastEditType="",pasteMode="formatted";
    const search=toolbar.querySelector("#editorFind"),findControl=name=>search.querySelector('[data-find="'+name+'"]');
    const recovery=viewport.parentElement.querySelector("#editorRecovery"),recoverButton=viewport.parentElement.querySelector("#editorRecover");
    const listen=(node,event,handler)=>{node.addEventListener(event,handler);listeners.push(()=>node.removeEventListener(event,handler));};
    const message=text=>{status.textContent=text;};
    const isAvailable=()=>current?.document&&mountedEntry===current&&!current.loading&&getInput().key===current.key&&(getInput().available||current.custom);
    const writable=()=>isAvailable()&&!getInput().busy;
    function controls() {
      const enabled=!!writable();if(paper.contentEditable!==String(enabled))paper.contentEditable=String(enabled);paper.setAttribute("aria-disabled",String(!enabled));
      for(const control of toolbar.querySelectorAll("button,select,input"))control.disabled=!enabled;
      toolbar.querySelector('#editorAutoExport').disabled=!enabled||!getInput().available;
      toolbar.querySelector('[data-action="reset"]').disabled=!enabled||!getInput().available;
      if(current?.readError){toolbar.querySelector('[data-action="save"]').disabled=true;toolbar.querySelector('[data-action="reset"]').disabled=true;}
      if(current?.document){
        toolbar.querySelector('[data-action="undo"]').disabled=!enabled||!current.invalidError&&current.position<=0;
        toolbar.querySelector('[data-action="redo"]').disabled=!enabled||current.position>=current.history.length-1;
      }
      tableControls();
      imageControls();
      recovery.hidden=!(current?.custom&&mountedEntry===current&&!current.intentionalEmpty&&!current.dirty&&!M.hasContent(current.document));
      recoverButton.disabled=!enabled||!getInput().available;
    }
    function describe() {
      const meta=viewport.parentElement.querySelector("#editorMeta");
      if(!current){
        status.dataset.state="idle";message("翻译当前页后，可在这里直接编辑文字和排版。");
        if(meta)meta.textContent="编辑稿与机器译文独立保存 · 分页以打印预览为准";return;
      }
      const input=getInput(),state=current.readError?"本机存储不可用，改动仅留在当前页面":current.saveError?current.saveError:
        current.loading?"正在读取本页编辑稿…":current.saving?"正在保存编辑稿…":composing?"正在输入…":current.dirty?"有未保存改动":
        current.custom&&!M.hasContent(current.document)?"本机保存的编辑稿为空":current.custom?"编辑稿已保存到本机":
        !current.document?"等待本页译文就绪":"自动导入当前译文，编辑后独立保存";
      status.dataset.state=current.readError||current.saveError?"error":current.saving?"saving":current.dirty?"dirty":"saved";
      message("对应原文第 "+input.page+" 页 · "+state+(input.busy?" · 翻译处理中，完成后可编辑":""));
      if(meta)meta.textContent=paper.textContent.replace(/[\s\u200b]/gu,"").length.toLocaleString()+" 字符 · 编辑稿独立保存 · 分页以打印预览为准";
    }
    function install(document) {
      mountedEntry=null;
      const {data,fragment}=M.hydrate(document,global.document);paper.replaceChildren(fragment);paper.removeAttribute("style");
      Object.assign(paper.style,data.style);paper.style.width=data.page.width+"pt";paper.style.minHeight=data.page.height+"pt";paper.style.padding=data.page.margin+"pt";
      current.document=data;current.needsCapture=false;mountedEntry=current;range=null;highlight(selected);refresh();controls();
      syncPageControls();searchIndex=-1;if(!search.hidden)findMatches();
    }
    function caret() {
      const value=global.getSelection(),active=value?.rangeCount&&paper.contains(value.anchorNode)&&paper.contains(value.focusNode)?value.getRangeAt(0):range;
      const mark=O.bookmark(paper,active);if(mark)mark.view={x:viewport.scrollLeft,y:viewport.scrollTop};return mark;
    }
    function history(document,force=false) {
      current.carets||=[];
      const mark=caret(),previous=current.document;
      if(JSON.stringify(previous)===JSON.stringify(document)){current.carets[current.position]=mark;return false;}
      current.history.splice(current.position+1);
      current.carets.splice(current.position+1);
      if(!force&&current.lastInput&&Date.now()-current.lastInput<600&&current.position>0)current.history[current.position]=document;
      else{current.history.push(document);current.position++;}
      current.carets[current.position]=mark;
      current.lastInput=force?0:Date.now();
      while(current.history.length>30||current.history.length>2&&current.history.reduce((sum,item)=>sum+JSON.stringify(item).length*2,0)>24*1024*1024){current.history.shift();current.carets.shift();current.position--;}
      current.document=document;current.version++;current.dirty=true;current.custom=true;return true;
    }
    function capture(force=false) {
      clearTimeout(captureTimer);captureTimer=null;
      // 只有已挂载且发生真实编辑的本页 DOM 才能写回；加载占位、清屏及失焦不能成为编辑稿。
      if(!current?.document||current.loading||mountedEntry!==current||composing&&!force)return;
      if(!current.needsCapture&&!editingCommand){
        current.carets||=[];current.carets[current.position]=caret();return;
      }
      try{
        const document=M.serialize(paper,current.document.page);current.invalidError=null;
        current.needsCapture=false;
        if(history(document,force)){
          current.intentionalEmpty=!M.hasContent(document);
          clearTimeout(saveTimer);saveTimer=setTimeout(()=>{saveTimer=null;void save(current);},900);
        }
        if(!search.hidden)findMatches();
        describe();controls();
      }catch(error){current.dirty=true;current.invalidError=error.message;message(error.message+"；当前内容尚未保存，请减少内容后重试。");}
    }
    async function save(entry=current) {
      if(!entry?.document||entry.loading||entry===current&&composing)return false;if(entry===current)capture();
      if(entry.invalidError){if(entry===current)message(entry.invalidError);return false;}
      if(entry.readError){message("读取本机编辑稿失败，不能覆盖原记录；请使用导出编辑稿保留当前内容。");return false;}
      if(entry.saving)return entry.saving;
      if(!entry.dirty&&!entry.custom){entry.dirty=true;entry.custom=true;entry.version++;}
      if(!entry.dirty)return true;
      entry.saveError=null;
      entry.saving=(async()=>{
        try{
          while(entry.dirty){
            if(entry===current&&composing)break;
            if(entry===current)capture();
            if(entry.invalidError)throw new Error(entry.invalidError);
            const version=entry.version,document=entry.document;
            const saved=await storage.write(entry.key,document,entry.revision,{intentionalEmpty:entry.intentionalEmpty});
            entry.revision=saved.revision;entry.saved=document;
            if(entry.version===version)entry.dirty=false;
          }
          if(current===entry)describe();return true;
        }catch(error){entry.saveError=error.message;return false;}
        finally{entry.saving=null;if(current===entry)describe();}
      })();if(current===entry)describe();return entry.saving;
    }
    function selection() {
      const value=global.getSelection();
      if(!value?.rangeCount||!paper.contains(value.anchorNode)||!paper.contains(value.focusNode))return;
      range=value.getRangeAt(0).cloneRange();
      if(current&&!captureTimer&&!composing&&!editingCommand){current.carets||=[];current.carets[current.position]=caret();}
      if(toolbar.contains(global.document.activeElement))return;
      const node=value.anchorNode.nodeType===1?value.anchorNode:value.anchorNode.parentElement;if(!node)return;
      const runs=O.textRuns(paper,range),parents=[...new Set(runs.length?runs.map(run=>run.text.parentElement):[node])];
      const css=new Map(),styleOf=element=>{if(!css.has(element))css.set(element,getComputedStyle(element));return css.get(element);};
      const formats=parents.map(parent=>{
        const style=styleOf(parent);let underline=false;
        for(let ancestor=parent;ancestor&&paper.contains(ancestor);ancestor=ancestor.parentElement)
          if(styleOf(ancestor).textDecorationLine.includes("underline")){underline=true;break;}
        return {size:String(Math.round(parseFloat(style.fontSize)*72/96*100)/100),
          family:style.fontFamily.includes("monospace")?"monospace":style.fontFamily.includes("serif")&&!style.fontFamily.includes("sans-serif")?"serif":"sans-serif",
          bold:parseInt(style.fontWeight)>=600||style.fontWeight==="bold",italic:style.fontStyle!=="normal",underline};
      });
      for(const action of ["size","family"]){
        const values=[...new Set(formats.map(format=>format[action]))],control=toolbar.querySelector('[data-action="'+action+'"]');
        control.value=values.length===1?values[0]:"";if(action==="size")control.placeholder=values.length===1?"字号":"混合";
      }
      for(const action of ["bold","italic","underline"]){
        const values=[...new Set(formats.map(format=>format[action]))],button=toolbar.querySelector('[data-action="'+action+'"]');
        button.setAttribute("aria-pressed",values.length===1?String(values[0]):"mixed");
        button.dataset.baseTitle||=button.title;button.title=button.dataset.baseTitle+(values.length>1?"（选区包含多种格式）":"");
      }
      const targets=blocks(),set=(action,values)=>{
        const control=toolbar.querySelector('[data-action="'+action+'"]'),unique=[...new Set(values)];
        control.value=unique.length===1?unique[0]:"";
      };
      set("format",targets.map(target=>target.tagName.toLowerCase()));
      set("align",targets.map(target=>{const align=getComputedStyle(target).textAlign;return align==="start"?"left":align==="end"?"right":align;}));
      set("leading",targets.map(target=>{const css=getComputedStyle(target);return String(Math.round(parseFloat(css.lineHeight)/parseFloat(css.fontSize)*100)/100);}));
      set("spacing",targets.map(target=>String(Math.round(parseFloat(getComputedStyle(target).marginBottom)*72/96*100)/100)));
      toolbar.querySelector('[data-action="columns"]').value=node.closest("section.editor-columns")?.dataset.columns||"1";
      tableControls();
      imageControls();
    }
    function currentImage() {
      if(!range||range.collapsed||range.startContainer!==range.endContainer||range.endOffset-range.startOffset!==1)return null;
      const image=range.startContainer.childNodes[range.startOffset];return image?.nodeName==="IMG"&&paper.contains(image)?image:null;
    }
    function imageControls() {
      const image=currentImage();
      if(markedImage!==image){markedImage?.classList.remove("editor-active-image");image?.classList.add("editor-active-image");markedImage=image;}
      for(const control of toolbar.querySelectorAll(".editor-image-tools button,.editor-image-tools select")){
        control.disabled=!writable()||!image;control.title=image?"调整当前图片，可撤销":"请先点击编辑区中的图片";
      }
      if(image&&!toolbar.contains(global.document.activeElement)){
        toolbar.querySelector('[data-action="image-width"]').value=image.style.width.endsWith("%")?String(parseFloat(image.style.width)):"100";
        toolbar.querySelector('[data-action="image-align"]').value=image.style.marginRight==="0pt"||image.style.marginRight==="0px"?"right":image.style.marginLeft==="0pt"||image.style.marginLeft==="0px"?"left":"center";
      }
    }
    function syncPageControls() {
      const page=current?.document?.page;if(!page)return;
      for(const key of ["width","height","margin"])toolbar.querySelector('[data-page="'+key+'"]').value=String(Math.round(page[key]*25.4/72*100)/100);
      toolbar.querySelector('[data-page="preset"]').value="custom";
    }
    function findMatches() {
      const result=O.find(paper,findControl("query").value,{caseSensitive:findControl("case").checked});
      searchIndex=Math.min(searchIndex,result.ranges.length-1);
      findControl("status").textContent=!findControl("query").value?"请输入查找内容":result.limited?"匹配超过 2000 处，请缩短查找范围":
        result.ranges.length?(searchIndex>=0?String(searchIndex+1)+" / ":"共 ")+result.ranges.length+" 处":"没有匹配内容";
      return result;
    }
    function showMatch(matches,index) {
      if(!matches.length)return;
      searchIndex=(index+matches.length)%matches.length;range=matches[searchIndex].cloneRange();restoreSelection();
      const node=range.startContainer.nodeType===1?range.startContainer:range.startContainer.parentElement;
      node?.scrollIntoView({block:"nearest",inline:"nearest"});findMatches();selection();
    }
    function searchAction(action) {
      if(!writable()||composing)return;
      try{
        const result=findMatches(),matches=result.ranges;
        if(action==="next"||action==="previous"){
          showMatch(matches,searchIndex<0?(action==="previous"?matches.length-1:0):searchIndex+(action==="previous"?-1:1));return;
        }
        if(!matches.length)return;
        if(result.limited){findControl("status").textContent="匹配超过 2000 处，请先缩短查找范围再替换";return;}
        if(action==="replace"&&searchIndex<0){showMatch(matches,0);return;}
        capture(true);const replacement=findControl("replacement").value,count=action==="replace-all"?matches.length:1;
        const targets=action==="replace-all"?matches:[matches[searchIndex]];
        if(paper.textContent.length+targets.reduce((sum,target)=>sum+replacement.length-target.toString().length,0)>400000)
          throw new Error("替换后文字超过编辑稿上限，请减少替换内容");
        let last;
        current.needsCapture=true;
        for(const target of [...targets].reverse()){
          target.deleteContents();const text=global.document.createTextNode(replacement);target.insertNode(text);last=text;
        }
        const next=global.document.createRange();next.setStartAfter(last);next.collapse(true);range=next;restoreSelection();
        capture(true);searchIndex=-1;findMatches();findControl("status").textContent="已替换 "+count+" 处";
      }catch(error){findControl("status").textContent=error.message||"查找替换未完成";}
    }
    function activeCell() {
      const node=range?.startContainer,element=node?.nodeType===1?node:node?.parentElement;
      const cell=element?.closest("td,th");return cell&&paper.contains(cell)?cell:null;
    }
    function simpleTable(cell) {
      const table=cell?.closest("table"),rows=table?[...table.rows]:[],width=rows[0]?.cells.length;
      return rows.length&&width&&rows.every(row=>row.cells.length===width&&[...row.cells].every(cell=>cell.rowSpan===1&&cell.colSpan===1))?table:null;
    }
    function tableControls() {
      const cell=activeCell(),table=simpleTable(cell),enabled=!!writable();
      if(markedCell!==cell){markedCell?.classList.remove("editor-active-cell");cell?.classList.add("editor-active-cell");markedCell=cell;}
      for(const button of toolbar.querySelectorAll('.editor-table-tools button')){
        button.disabled=!enabled||!table;
        button.title=!cell?"请先将光标放到表格单元格中":!table?"含合并单元格或不规则网格，暂不增删行列，以保留结构安全":"调整当前单元格所在行或列，可撤销";
      }
    }
    function focusStart(node) {
      const next=global.document.createRange();next.selectNodeContents(node);next.collapse(true);
      const value=global.getSelection();value.removeAllRanges();value.addRange(next);range=next.cloneRange();
    }
    function editTable(action) {
      const cell=activeCell(),table=simpleTable(cell);
      if(!table)throw new Error("请将光标放到普通表格中；含合并单元格的表格暂不增删行列。");
      const row=cell.parentElement,r=row.rowIndex,c=cell.cellIndex,rows=[...table.rows],width=row.cells.length;
      const empty=tag=>{const cell=global.document.createElement(tag);cell.append(global.document.createElement("br"));return cell;};
      let target;
      if(action==="row-add"){
        if(rows.length>=128)throw new Error("表格最多支持 128 行");
        const next=global.document.createElement("tr");for(let index=0;index<width;index++)next.append(empty(cell.tagName.toLowerCase()));
        row.after(next);target=next.cells[c];
      }else if(action==="column-add"){
        if(width>=64)throw new Error("表格最多支持 64 列");
        for(const item of rows)item.cells[c].after(empty(item.cells[c].tagName.toLowerCase()));target=row.cells[c+1];
      }else if(action==="row-remove"&&rows.length>1){row.remove();target=table.rows[Math.min(r,table.rows.length-1)].cells[c];}
      else if(action==="column-remove"&&width>1){for(const item of rows)item.cells[c].remove();target=row.cells[Math.min(c,row.cells.length-1)];}
      else{target=global.document.createElement("p");target.append(global.document.createElement("br"));table.replaceWith(target);}
      if(action.startsWith("column")){
        for(const group of table.querySelectorAll(":scope > colgroup"))group.remove();
        for(const item of table.rows)for(const cell of item.cells)cell.style.width="";
      }
      focusStart(target);
    }
    function restoreSelection() {
      const x=viewport.scrollLeft,y=viewport.scrollTop;
      paper.focus({preventScroll:true});const value=global.getSelection();value.removeAllRanges();
      if(range&&paper.contains(range.commonAncestorContainer))value.addRange(range);
      else{const next=global.document.createRange();next.selectNodeContents(paper);next.collapse(false);value.addRange(next);}
      viewport.scrollLeft=x;viewport.scrollTop=y;
    }
    function blocks() {
      const value=global.getSelection(),active=value?.rangeCount?value.getRangeAt(0):null;
      if(!active||!paper.contains(active.commonAncestorContainer))return [];
      const all=[...paper.querySelectorAll("p,h1,h2,h3,h4,h5,h6,li,pre,blockquote,td,th")];
      const hits=all.filter(node=>active.intersectsNode(node));
      const leaves=hits.filter(node=>!hits.some(other=>other!==node&&node.contains(other)));
      if(leaves.length)return leaves;
      const node=value.anchorNode.nodeType===1?value.anchorNode:value.anchorNode.parentElement;
      return node&&node!==paper?[node]:[];
    }
    function blockStyle(style) {
      restoreSelection();let targets=blocks();
      if(!targets.length){global.document.execCommand("formatBlock",false,"p");targets=blocks();}
      for(const target of targets)Object.assign(target.style,M.styles(style));
    }
    function inlineStyle(style) {
      restoreSelection();const value=global.getSelection(),selected=value.getRangeAt(0),span=global.document.createElement("span");Object.assign(span.style,M.styles(style));
      if(selected.collapsed){
        const node=selected.startContainer,parent=node.nodeType===1?node:node.parentElement;
        if(parent?.tagName==="SPAN"&&parent.textContent==="\u200b"&&parent.childNodes.length===1)Object.assign(parent.style,M.styles(style));
        else{span.append(global.document.createTextNode("\u200b"));selected.insertNode(span);selected.selectNodeContents(span);selected.collapse(false);}
      }
      else{
        // 每个相交文本节点分别包裹，跨段选择不把整张表或分栏塞进一个行内容器。
        const nodes=O.textRuns(paper,selected),wrappers=[];
        // 先保存边界再修改 DOM；修改后恢复选区，连续设置字体、字号和加粗仍作用于同一段文字。
        for(const {text,start,end} of nodes.reverse()){
          const parent=text.parentElement;
          if(start===0&&end===text.length&&parent?.tagName==="SPAN"&&
            [...parent.childNodes].every(child=>child===text||child.nodeType===3&&!child.length)){
            Object.assign(parent.style,M.styles(style));wrappers.unshift({first:text,last:text});continue;
          }
          const piece=global.document.createRange();piece.setStart(text,start);piece.setEnd(text,end);
          const wrapper=span.cloneNode();wrapper.append(piece.extractContents());piece.insertNode(wrapper);
          wrappers.unshift({first:wrapper.firstChild,last:wrapper.lastChild});
        }
        if(wrappers.length){
          const first=wrappers[0].first,last=wrappers[wrappers.length-1].last;
          selected.setStart(first,0);selected.setEnd(last,last.textContent.length);
        }
      }
      value.removeAllRanges();value.addRange(selected);range=selected.cloneRange();
    }
    function insert(node) {
      restoreSelection();const selection=global.getSelection(),target=selection.getRangeAt(0),last=node.nodeType===11?node.lastChild:node;
      if(!last)return;current.needsCapture=true;target.deleteContents();
      const children=node.nodeType===11?[...node.childNodes]:[node],hasBlock=children.some(child=>child.nodeType===1&&
        /^(?:P|DIV|SECTION|H[1-6]|UL|OL|TABLE|PRE|BLOCKQUOTE|HR|IMG)$/u.test(child.tagName));
      const anchor=target.startContainer,element=anchor.nodeType===1?anchor:anchor.parentElement;
      let paragraph=element?.closest("p,h1,h2,h3,h4,h5,h6,pre");
      if(!paragraph){
        // 编辑区填入纯文本后可能只有 span/b 等行内包装，同样需要从包装外插入块。
        let wrapper=element;
        while(wrapper&&wrapper!==paper&&/^(?:SPAN|B|STRONG|I|EM|U|S|SUP|SUB|CODE)$/u.test(wrapper.tagName)){
          paragraph=wrapper;wrapper=wrapper.parentElement;
        }
      }
      if(hasBlock&&paragraph&&paper.contains(paragraph)){
        // 在段中插表格、图片或多段粘贴时先分开前后文字，不能把块元素嵌进原段落。
        const rest=target.cloneRange();rest.selectNodeContents(paragraph);rest.setStart(target.startContainer,target.startOffset);
        const tail=rest.extractContents(),trailing=global.document.createElement("p");
        if(/^(?:P|H[1-6]|PRE)$/u.test(paragraph.tagName)){
          Object.assign(trailing.style,M.styles(paragraph.style));
          for(const name of ["blockId","sourceIds","status"])if(paragraph.dataset[name])trailing.dataset[name]=paragraph.dataset[name];
          trailing.append(tail);
        }else{const wrapper=paragraph.cloneNode(false);wrapper.append(tail);trailing.append(wrapper);}
        paragraph.after(node);last.after(trailing);
        if(!trailing.hasChildNodes())trailing.append(global.document.createElement("br"));
        focusStart(trailing);
      }else{
        target.insertNode(node);target.setStartAfter(last);target.collapse(true);selection.removeAllRanges();selection.addRange(target);range=target.cloneRange();
        if(hasBlock&&last.nodeType===1&&/^(?:TABLE|HR|IMG)$/u.test(last.tagName)){
          const trailing=global.document.createElement("p");trailing.append(global.document.createElement("br"));last.after(trailing);focusStart(trailing);
        }
      }
    }
    function command(action,value) {
      if(!writable()||composing)return;capture(true);restoreSelection();
      editingCommand=true;
      try{
        const limits={size:[4,144],leading:[1,4],spacing:[0,96]};
        if(limits[action]&&(!Number.isFinite(Number(value))||Number(value)<limits[action][0]||Number(value)>limits[action][1]))
          throw new Error("请输入 "+limits[action][0]+" 至 "+limits[action][1]+" 之间的数值");
        const native={bold:"bold",italic:"italic",underline:"underline",ordered:"insertOrderedList",unordered:"insertUnorderedList",indent:"indent",outdent:"outdent"};
        if(native[action])global.document.execCommand(native[action],false,null);
        else if(action==="size")inlineStyle({fontSize:Number(value)+"pt"});
        else if(action==="family")inlineStyle({fontFamily:value});
        else if(action==="align")blockStyle({textAlign:value});
        else if(action==="leading")blockStyle({lineHeight:value});
        else if(action==="spacing")blockStyle({marginBottom:Number(value)+"pt"});
        else if(action.startsWith("image-")){
          const image=currentImage();if(!image)throw new Error("请先点击编辑区中的图片");
          if(action==="image-width"){
            if(![25,50,75,100].includes(Number(value)))throw new Error("请选择有效的图片宽度");image.style.width=value+"%";
          }else if(action==="image-align"){
            if(!["left","center","right"].includes(value))return;
            image.style.marginLeft=value==="left"?"0pt":"auto";image.style.marginRight=value==="right"?"0pt":"auto";
          }else if(action==="image-remove"){
            const next=global.document.createRange();next.setStartBefore(image);next.collapse(true);image.remove();range=next;restoreSelection();
          }
        }
        else if(action==="page-apply"){
          const page={};
          for(const key of ["width","height","margin"]){
            const field=toolbar.querySelector('[data-page="'+key+'"]');
            if(!field.value.trim()||!Number.isFinite(Number(field.value)))throw new Error("请输入有效的页面尺寸和边距");
            page[key]=Math.round(Number(field.value)*72/25.4*100)/100;
          }
          // 先校验整个快照，再应用尺寸；无效设置不能改动当前编辑稿。
          const document=M.serialize(paper,page);
          if(history(document,true)){clearTimeout(saveTimer);saveTimer=setTimeout(()=>void save(current),900);}
          paper.style.width=page.width+"pt";paper.style.minHeight=page.height+"pt";paper.style.padding=page.margin+"pt";
          syncPageControls();refresh();
        }
        else if(action==="clear-format"){
          global.document.execCommand("removeFormat",false,null);
          inlineStyle({fontFamily:current.document.style.fontFamily||"sans-serif",fontSize:current.document.style.fontSize||"10pt",
            fontWeight:"normal",fontStyle:"normal",textDecorationLine:"none",verticalAlign:"baseline"});
        }
        else if(["row-add","column-add","row-remove","column-remove"].includes(action))editTable(action);
        else if(action==="format"){
          global.document.execCommand("formatBlock",false,value);
          const size=Number(current.document.style.fontSize?.replace("pt",""))||10;
          blockStyle({fontSize:(value==="h1"?size*1.5:value==="h2"?size*1.25:value==="h3"?size*1.1:size)+"pt",fontWeight:value.startsWith("h")?"bold":"normal"});
          for(const target of blocks())for(const child of target.querySelectorAll("span,b,strong,i,em,u,code"))child.style.fontSize="";
        }else if(action==="columns"){
          const anchor=global.getSelection().anchorNode,element=anchor?.nodeType===1?anchor:anchor?.parentElement;
          let container=element?.closest("section.editor-columns");
          if(!container){
            container=global.document.createElement("section");const lane=global.document.createElement("div");lane.append(...paper.childNodes);container.append(lane);paper.append(container);
          }
          const count=Number(value);if(![1,2,3].includes(count))return;
          // 手动分栏以容器为单位；减少栏数时先搬回内容，不能删除原栏中的文字。
          while(container.children.length>count){const extra=container.children[count];container.children[count-1].append(...extra.childNodes);extra.remove();}
          while(container.children.length<count){const lane=global.document.createElement("div"),p=global.document.createElement("p");p.append(global.document.createElement("br"));lane.append(p);container.append(lane);}
          container.dataset.columns=String(count);container.dataset.widths=JSON.stringify(Array(count).fill(1));container.style.gridTemplateColumns="repeat("+count+",minmax(0,1fr))";container.className="editor-columns";
        }else if(action==="table"){
          const rows=Number(toolbar.querySelector('[data-option="rows"]').value),columns=Number(toolbar.querySelector('[data-option="columns"]').value);
          if(!Number.isInteger(rows)||!Number.isInteger(columns)||rows<1||columns<1||rows>20||columns>12)throw new Error("表格最多 20 行、12 列");
          const table=global.document.createElement("table"),body=global.document.createElement("tbody");
          for(let r=0;r<rows;r++){const row=global.document.createElement("tr");for(let c=0;c<columns;c++){const cell=global.document.createElement("td");cell.append(global.document.createElement("br"));row.append(cell);}body.append(row);}
          table.append(body);insert(table);
        }else if(action==="break"){
          const rule=global.document.createElement("hr");rule.dataset.pageBreak="true";rule.className="editor-page-break";rule.contentEditable="false";insert(rule);
        }else if(action==="locate"){
          const anchor=global.getSelection().anchorNode,node=anchor?.nodeType===1?anchor:anchor?.parentElement;
          const source=currentImage()||node?.closest("[data-block-id],[data-source-ids]");
          const ids=source?sourceIds(source):[];
          if(ids.length)onLocate(ids[0]);else message("这部分是手动新增内容，没有对应原文位置。");return;
        }
        selection();capture(true);
      }catch(error){status.dataset.state="error";message(error.message||"本次排版操作未完成");}
      finally{editingCommand=false;}
    }
    function showHistory(delta) {
      if(!writable()||composing)return;capture(true);
      if(current.invalidError&&delta<0){
        current.invalidError=null;install(current.document);current.version++;current.dirty=true;describe();
        clearTimeout(saveTimer);saveTimer=setTimeout(()=>void save(current),900);return;
      }
      const position=current.position+delta;if(position<0||position>=current.history.length)return;
      const mark=current.carets?.[position];
      current.position=position;current.version++;current.dirty=true;current.custom=true;install(current.history[position]);
      current.intentionalEmpty=!M.hasContent(current.document);
      range=O.restore(paper,mark);if(range){
        if(mark?.view){viewport.scrollLeft=mark.view.x;viewport.scrollTop=mark.view.y;}
        restoreSelection();selection();
      }lastEditType="";describe();
      clearTimeout(saveTimer);saveTimer=setTimeout(()=>void save(current),900);
    }
    async function reset() {
      if(!isAvailable()||composing)return;
      if(!getInput().available){message("请先翻译当前页，再重新导入；已有编辑稿不会删除。");return;}
      if(!global.confirm("删除本页已保存的编辑稿，并重新导入当前译文？其他页不受影响。"))return;
      const entry=current;capture(true);clearTimeout(saveTimer);if(entry.saving)await entry.saving;
      try{
        const input=getInput();if(current!==entry||input.key!==entry.key)return;
        const document=M.seed({rows:input.rows,geometry:input.geometry,onVisual});
        await storage.remove(entry.key,entry.revision);
        if(current!==entry||disposed){entries.delete(entry.key);return;}
        entry.revision=0;entry.dirty=false;entry.custom=false;entry.saved=null;entry.version++;
        entry.invalidError=null;
        entry.intentionalEmpty=false;
        entry.history=[document];entry.carets=[];entry.position=0;entry.signature=input.signature;
        install(document);describe();
      }catch(error){message(error.message);}
    }
    function exportPDF() {
      if(!isAvailable()||composing)return;capture(true);
      try{
        const document=M.serialize(paper,current.document.page),token=crypto.randomUUID(),url=chrome.runtime.getURL("pdf/editor-print.html")+"#"+token;
        const popup=global.open(url,"_blank");if(!popup)throw new Error("导出窗口未打开，请允许本阅读器打开打印页后重试");
        const timer=setTimeout(()=>{printJobs.delete(token);if(!disposed)message("打印页未确认接收；编辑稿仍保留，可重新导出。");},20000);
        printJobs.set(token,{popup,document,timer,title:getInput().name.replace(/\.pdf$/iu,"")+"-编辑译文-p"+getInput().page});
        message("已打开打印预览，请选择「另存为 PDF」导出当前编辑排版。");
      }catch(error){message(error.message);}
    }
    listen(recoverButton,"click",()=>{
      if(!writable()||composing||!getInput().available)return;
      capture(true);
      try{
        const input=getInput(),document=M.seed({rows:input.rows,geometry:input.geometry,onVisual});
        if(!M.hasContent(document)){message("当前译文还没有可恢复的内容，请先完成本页翻译。");return;}
        // 显式恢复作为一个可撤销的编辑步骤，不清空数据库，也不删除其他页。
        history(document,true);current.intentionalEmpty=false;current.signature=input.signature;
        install(current.document);describe();clearTimeout(saveTimer);saveTimer=setTimeout(()=>void save(current),900);
      }catch(error){status.dataset.state="error";message(error.message||"本页译文暂时无法恢复，原编辑稿仍保留。");}
    });
    listen(global,"message",event=>{
      if(event.origin!==location.origin||event.data?.type!=="YZY_EDITOR_PRINT_READY")return;
      const job=printJobs.get(event.data.token);if(!job||job.popup!==event.source)return;
      job.popup.postMessage({type:"YZY_EDITOR_PRINT_DOCUMENT",token:event.data.token,document:job.document,title:job.title},location.origin);
      clearTimeout(job.timer);printJobs.delete(event.data.token);
    });
    // 保存选区但允许按钮正常获得焦点，让尚未失焦的字号等输入框先提交 change。
    listen(toolbar,"pointerdown",event=>{if(event.target.closest("button"))selection();});
    listen(toolbar,"click",event=>{
      const ui=event.target.closest("button[data-ui]"),searchButton=event.target.closest("button[data-search]");
      if(ui&&!ui.disabled){
        if(ui.dataset.ui==="page-rotate"){
          const width=toolbar.querySelector('[data-page="width"]'),height=toolbar.querySelector('[data-page="height"]');
          [width.value,height.value]=[height.value,width.value];toolbar.querySelector('[data-page="preset"]').value="custom";
        }else{
          search.hidden=ui.dataset.ui==="close-find"||!search.hidden;
          toolbar.querySelector('[data-ui="find"]').setAttribute("aria-expanded",String(!search.hidden));
          if(!search.hidden){findControl("query").focus();findMatches();}else if(isAvailable())restoreSelection();
        }
        return;
      }
      if(searchButton&&!searchButton.disabled){searchAction(searchButton.dataset.search);return;}
      const button=event.target.closest("button[data-action]");if(!button||button.disabled)return;const action=button.dataset.action;
      if(action==="save")void save();else if(action==="reset")void reset();else if(action==="export")exportPDF();
      else if(action==="image"&&!composing){selection();toolbar.querySelector('input[type="file"]').click();}
      else if(action==="undo")showHistory(-1);else if(action==="redo")showHistory(1);else command(action,button.dataset.value);
    });
    listen(toolbar,"change",event=>{
      const control=event.target;
      if(control.type==="file"){
        const file=control.files?.[0],entry=current;control.value="";if(!file)return;
        if(file.size>4*1024*1024||!/^image\/(?:png|jpeg|webp)$/u.test(file.type)){message("请选择不超过 4 MiB 的 PNG、JPEG 或 WebP 图片。");return;}
        const reader=new FileReader();reader.onerror=()=>message("图片读取失败");reader.onload=()=>{
          if(current!==entry||disposed||!writable())return;
          try{
            const document={version:M.VERSION,page:current.document.page,style:{},children:[{tag:"img",src:String(reader.result),alt:file.name,style:{width:"100%"},children:[]}]};
            insert(M.hydrate(document,global.document).fragment);capture(true);
          }catch(error){message(error.message);}
        };reader.readAsDataURL(file);
      }else if(control.dataset.view==="zoom"){
        editorZoom=control.value;refresh();
      }else if(control.dataset.view==="paste"){
        pasteMode=control.value;
      }else if(control.dataset.page){
        if(control.dataset.page==="preset"){
          const sizes={a4:[210,297],letter:[215.9,279.4]},size=sizes[control.value];
          if(size){toolbar.querySelector('[data-page="width"]').value=size[0];toolbar.querySelector('[data-page="height"]').value=size[1];}
        }else toolbar.querySelector('[data-page="preset"]').value="custom";
      }else if(control.dataset.find==="case"){searchIndex=-1;findMatches();
      }else if(control.dataset.action)command(control.dataset.action,control.value);
    });
    listen(search,"input",event=>{if(event.target.dataset.find!=="query")return;searchIndex=-1;clearTimeout(searchTimer);searchTimer=setTimeout(findMatches,150);});
    listen(search,"keydown",event=>{
      if(event.isComposing)return;
      if(event.key==="Enter"){event.preventDefault();searchAction(event.target.dataset.find==="replacement"?"replace":event.shiftKey?"previous":"next");}
      if(event.key==="Escape"){event.preventDefault();event.stopPropagation();search.hidden=true;toolbar.querySelector('[data-ui="find"]').setAttribute("aria-expanded","false");restoreSelection();}
    });
    listen(paper,"click",event=>{
      if(!isAvailable()||composing)return;
      if(event.target.nodeName==="IMG"&&writable()){
        toggleTools(true);
        const next=global.document.createRange();next.selectNode(event.target);range=next;restoreSelection();selection();
        toolbar.querySelector(".editor-more").open=true;
      }else{
        // 拖选、双击选词和组合输入不触发两侧跳转；普通单击不改右侧光标或滚动。
        if(event.detail>1||!global.getSelection()?.isCollapsed)return;
        selection();
      }
      const source=event.target.closest("[data-block-id],[data-source-ids]");
      const ids=source?sourceIds(source):[];
      if(ids.length)onLocate(ids[0]);
    });
    listen(paper,"focus",()=>{if(writable())global.document.execCommand("defaultParagraphSeparator",false,"p");});
    function finishTyping() {
      if(!writable()||composing)return;
      capture(true);lastEditType="";current.lastInput=0;
    }
    listen(paper,"blur",finishTyping);
    listen(paper,"pointerdown",finishTyping);
    listen(paper,"beforeinput",event=>{
      if(!writable()||composing||event.isComposing||!event.cancelable)return;
      const type=event.inputType||"";
      if(type==="historyUndo"||type==="historyRedo"){event.preventDefault();showHistory(type==="historyUndo"?-1:1);return;}
      const family=type.startsWith("delete")?"delete":type==="insertText"?"text":type;
      if(family!==lastEditType||["insertParagraph","insertLineBreak","deleteByCut"].includes(type)){
        capture(true);if(current)current.lastInput=0;
      }
      lastEditType=family;
      if(type!=="insertParagraph"&&type!=="insertLineBreak")return;
      const value=global.getSelection();if(!value?.rangeCount)return;
      const next=O.newline(paper,value.getRangeAt(0),{soft:type==="insertLineBreak"});if(!next)return;
      event.preventDefault();editingCommand=true;
      try{
        range=next;restoreSelection();selection();capture(true);
        // 工具栏操作保持滚动不跳动，主动换行则要让新光标留在可视范围内。
        const rect=range.getBoundingClientRect(),bounds=viewport.getBoundingClientRect();
        if(rect.height>0){
          if(rect.bottom>bounds.bottom-12)viewport.scrollTop+=rect.bottom-bounds.bottom+12;
          else if(rect.top<bounds.top+12)viewport.scrollTop+=rect.top-bounds.top-12;
        }else{
          const node=range.startContainer.nodeType===1?range.startContainer:range.startContainer.parentElement;
          node?.scrollIntoView({block:"nearest",inline:"nearest"});
        }
        if(current.carets)current.carets[current.position]=caret();
      }
      finally{editingCommand=false;}
    });
    listen(paper,"compositionstart",()=>{capture(true);composing=true;lastEditType="";clearTimeout(captureTimer);clearTimeout(saveTimer);});
    listen(paper,"compositionend",()=>{composing=false;if(current){capture(true);clearTimeout(saveTimer);saveTimer=setTimeout(()=>void save(current),900);}});
    listen(paper,"input",()=>{
      if(!current||mountedEntry!==current)return;current.custom=true;current.dirty=true;current.needsCapture=true;current.version++;searchIndex=-1;
      if(composing)return;
      clearTimeout(captureTimer);captureTimer=setTimeout(()=>capture(),180);
    });
    listen(global.document,"selectionchange",selection);
    listen(paper,"keydown",event=>{
      if(event.isComposing||composing)return;
      if(["ArrowLeft","ArrowRight","ArrowUp","ArrowDown","Home","End","PageUp","PageDown"].includes(event.key))finishTyping();
      if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==="f"&&writable()){
        event.preventDefault();event.stopPropagation();toggleTools(true);search.hidden=false;toolbar.querySelector('[data-ui="find"]').setAttribute("aria-expanded","true");findControl("query").focus();findMatches();return;
      }
      if(event.key==="Tab"&&writable()){
        selection();const cell=activeCell();
        if(cell){
          const table=cell.closest("table"),cells=[...table.rows].flatMap(row=>[...row.cells]),index=cells.indexOf(cell),next=cells[index+(event.shiftKey?-1:1)];
          if(next){event.preventDefault();focusStart(next);selection();return;}
          if(!event.shiftKey&&simpleTable(cell)){event.preventDefault();command("row-add");return;}
        }
      }
      if((event.ctrlKey||event.metaKey)&&!event.altKey&&["b","i","u"].includes(event.key.toLowerCase())){
        event.preventDefault();command({b:"bold",i:"italic",u:"underline"}[event.key.toLowerCase()]);return;
      }
      if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==="s"){event.preventDefault();void save();}
      if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==="z"){event.preventDefault();showHistory(event.shiftKey?1:-1);}
      if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==="y"){event.preventDefault();showHistory(1);}
    });
    listen(paper,"paste",event=>{
      if(!writable()||composing)return;event.preventDefault();capture(true);lastEditType="";
      const text=event.clipboardData?.getData("text/plain")||"",html=event.clipboardData?.getData("text/html");
      const plain=()=>{
        if(!text)return;
        restoreSelection();
        if(paper.textContent.length-global.getSelection().toString().length+text.length>400000)throw new Error("粘贴后文字超过编辑稿上限，请减少粘贴内容");
        // 纯文本沿用光标处格式；单行粘贴不额外拆成新段落。
        if(!global.document.execCommand("insertText",false,text))throw new Error("本次粘贴未完成，请重新定位光标后重试");
        selection();capture(true);
      };
      if(pasteMode==="plain"||!html){
        try{plain();}catch(error){status.dataset.state="error";message(error.message);}return;
      }
      try{
        if(html.length>2*1024*1024)throw new Error("粘贴的格式内容过大");
        // template 内容保持惰性，外部图片、脚本和事件在白名单转换前不得进入活动文档。
        const template=global.document.createElement("template");template.innerHTML=html;
        const data=M.serialize(template.content,current.document.page);
        // 外部粘贴只导入内容和版式，不接受其他文档的原文绑定和翻译状态。
        const detach=node=>{if(typeof node==="string")return;delete node.sourceId;delete node.sourceIds;delete node.status;node.children.forEach(detach);};
        data.children.forEach(detach);
        const nodes=M.hydrate(data,global.document).fragment;
        if(paper.textContent.length-(range?.toString().length||0)+nodes.textContent.length>400000)
          throw new Error("粘贴后文字超过编辑稿上限");
        insert(nodes);capture(true);
      }catch(error){
        try{if(text)plain();else message(error.message||"剪贴板没有可粘贴的文字");}
        catch(fallbackError){status.dataset.state="error";message(fallbackError.message);}
      }
    });
    // 不允许拖入网页 HTML、远程图片或文件，避免绕过粘贴白名单。
    listen(paper,"drop",event=>{event.preventDefault();message("请使用粘贴文字或插入表格；拖入网页和文件不会被执行。");});
    function sourceIds(node) {
      let ids=[];try{ids=JSON.parse(node.dataset.sourceIds||"[]");}catch(_){}
      return [...new Set([node.dataset.blockId,...(Array.isArray(ids)?ids:[])].filter(id=>typeof id==="string"&&id))];
    }
    function sourceNodes(id) {
      if(!isAvailable())return [];
      const nodes=[...paper.querySelectorAll("[data-block-id],[data-source-ids]")];
      const exact=nodes.filter(node=>sourceIds(node).includes(id));if(exact.length)return exact;
      // 已保存的旧代码块只有首项 ID；仅在原模型明确属于同一代码区域时补读关联。
      const rows=getInput().rows,block=rows.find(row=>row.block.id===id)?.block;
      if(block?.flow?.type!=="code")return [];
      return nodes.filter(node=>node.tagName==="PRE"&&rows.some(row=>row.block.id===node.dataset.blockId&&row.block.flow?.id===block.flow.id));
    }
    function highlight(id) {
      selected=id;const matches=new Set(id?sourceNodes(id):[]);
      for(const node of paper.querySelectorAll("[data-block-id],[data-source-ids]"))node.classList.toggle("editor-selected",matches.has(node));
    }
    function reveal(id) {
      const nodes=sourceNodes(id);if(!nodes.length){message("当前编辑稿没有该原文区域的关联，内容可能已删除或来自旧版编辑稿。");return false;}
      const box=viewport.getBoundingClientRect();
      const node=nodes.find(node=>{const rect=node.getBoundingClientRect();return rect.bottom>box.top&&rect.top<box.bottom;})||nodes[0];
      const rect=node.getBoundingClientRect();
      if(rect.top<box.top||rect.bottom>box.bottom)viewport.scrollTop+=rect.top-box.top-12;
      if(rect.left<box.left||rect.right>box.right)viewport.scrollLeft+=rect.left-box.left-12;
      highlight(id);return true;
    }
    function refresh() {
      if(!current?.document||viewport.clientWidth<=24)return;
      const input=getInput(),page=current.document.page,natural=page.width*96/72;
      const mode=editorZoom==="reader"?input.fitMode:editorZoom==="fit"?"fit-width":null;
      // 顶部控制默认联动两侧；自适应按各自阅读区计算，固定比例保持相同倍率。
      // 只改变视图，不写入文档模型，也不影响字号和打印尺寸。
      const factor=mode?Math.max(.1875,Math.min(3,(viewport.clientWidth-24)/natural,
        mode==="fit-page"?(viewport.clientHeight-32)/(page.height*96/72):Infinity)):
        (editorZoom==="reader"?input.scale||1:Number(editorZoom))*.75;
      paper.style.zoom=String(factor);
    }
    function followZoom() {
      editorZoom="reader";toolbar.querySelector('[data-view="zoom"]').value=editorZoom;refresh();
    }
    function toggleTools(show=toolbar.hidden) {
      const button=global.document.getElementById("editorToggleTools");
      toolbar.hidden=!show;button.setAttribute("aria-expanded",String(show));button.textContent=show?"收起工具":"编辑工具";
      button.title=show?"收起排版工具，增加阅读空间；仍可直接编辑正文":"展开文字、图片、表格和页面排版工具";
      if(!show&&toolbar.contains(global.document.activeElement))button.focus({preventScroll:true});
      refresh();
    }
    async function update() {
      if(disposed)return;let input=getInput();
      if(!input.key){clear();return;}
      if(current?.key!==input.key){
        capture(true);composing=false;lastEditType="";if(current?.dirty)void save(current);clearTimeout(saveTimer);range=null;
        let entry=entries.get(input.key);if(!entry){entry={key:input.key,loading:true,document:null,revision:0,version:0,dirty:false,custom:false,history:[],position:0};entries.set(input.key,entry);}
        mountedEntry=null;current=entry;const token=++loadToken;paper.replaceChildren();controls();message("正在读取本页编辑稿…");
        if(entry.loading){
          // 快速往返同一页共用一次读取，迟到的第二次读取不能覆盖刚输入的内容。
          entry.loadPromise||=(async()=>{
            try{
              const record=await storage.read(entry.key);if(record){entry.document=M.clean(record.document);entry.saved=entry.document;entry.revision=record.revision;entry.custom=true;entry.intentionalEmpty=record.intentionalEmpty===true;entry.history=[entry.document];entry.carets=[];}
            }catch(error){entry.readError=true;entry.error=error.message;}
            finally{entry.loading=false;}
          })();
          await entry.loadPromise;
        }
        if(disposed||token!==loadToken||current!==entry)return;
        input=getInput();if(input.key!==entry.key)return;
        if(entry.document)install(entry.document);
        while(entries.size>12){const old=[...entries.values()].find(item=>item!==current&&!item.dirty&&!item.saving);if(!old)break;entries.delete(old.key);}
      }
      if(!current||current.loading)return;
      if(current.document&&mountedEntry!==current)install(current.document);
      if(input.available&&!input.busy&&!current.custom&&!current.dirty&&current.signature!==input.signature){
        try{
          const document=M.seed({rows:input.rows,geometry:input.geometry,onVisual});current.signature=input.signature;current.history=[document];current.carets=[];current.position=0;install(document);
        }catch(error){message(error.message);controls();return;}
      }
      if(!current.document){paper.replaceChildren();const p=global.document.createElement("p");p.textContent=input.busy?"翻译处理中，完成后导入可编辑译文。":"开始翻译后，可直接编辑本页译文和排版。";paper.append(p);}
      controls();describe();refresh();
    }
    function clear() {
      capture(true);composing=false;lastEditType="";if(current?.dirty)void save(current);clearTimeout(saveTimer);mountedEntry=null;current=null;loadToken++;range=null;paper.replaceChildren();controls();describe();
      followZoom();
    }
    const observer=new ResizeObserver(refresh);observer.observe(viewport);controls();describe();
    return {update,refresh,followZoom,toggleTools,highlight,reveal,hasSource:id=>sourceNodes(id).length>0,exportPDF,hasDrafts:()=>composing||!!captureTimer||[...entries.values()].some(entry=>entry.dirty),
      discardDrafts(){
        clearTimeout(captureTimer);captureTimer=null;clearTimeout(saveTimer);
        if([...entries.values()].some(entry=>entry.saving)){message("编辑稿正在保存，请稍后再关闭。");return false;}
        for(const entry of entries.values())if(entry.dirty){entry.dirty=false;entry.invalidError=null;entry.document=entry.saved||null;entry.custom=!!entry.saved;entry.history=entry.document?[entry.document]:[];entry.carets=[];entry.position=0;entry.signature=null;}
        if(current?.document)install(current.document);else void update();return true;
      },clear,dispose(){capture(true);composing=false;if(current?.dirty)void save(current);disposed=true;loadToken++;clearTimeout(captureTimer);clearTimeout(saveTimer);clearTimeout(searchTimer);observer.disconnect();listeners.forEach(remove=>remove());for(const job of printJobs.values())clearTimeout(job.timer);printJobs.clear();}};
  }
  global.BT_PDF_DOCUMENT_EDITOR={create};
})(window);
