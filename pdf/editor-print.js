(function() {
  "use strict";
  const token=location.hash.slice(1),paper=document.getElementById("printPaper"),status=document.getElementById("printStatus"),button=document.getElementById("print");
  let received=false;
  button.onclick=()=>window.print();
  window.addEventListener("message",async event=>{
    if(received||event.source!==window.opener||event.origin!==location.origin||event.data?.type!=="YZY_EDITOR_PRINT_DOCUMENT"||event.data.token!==token)return;
    received=true;
    try{
      const {data,fragment}=BT_PDF_EDITOR_MODEL.hydrate(event.data.document,document);paper.replaceChildren(fragment);Object.assign(paper.style,data.style);
      paper.style.width=data.page.width+"pt";paper.style.minHeight=data.page.height+"pt";paper.style.padding=data.page.margin+"pt";
      // 页面尺寸已由模型校验为有限数值，只生成本地 @page 规则。
      const style=document.createElement("style");style.textContent="@page { size: "+data.page.width+"pt "+data.page.height+"pt; margin: "+data.page.margin+"pt; }";document.head.append(style);
      document.title=String(event.data.title||"编辑译文").slice(0,200);
      await document.fonts.ready;
      await Promise.all([...paper.querySelectorAll("img")].map(img=>img.complete?Promise.resolve():new Promise(resolve=>{img.onload=img.onerror=resolve;})));
      status.textContent="选择「另存为 PDF」；分页以打印预览为准。";button.disabled=false;window.print();
    }catch(error){status.textContent=error.message||"编辑稿无法导出，请返回阅读器重试。";}
  });
  if(window.opener&&/^[a-f0-9-]{36}$/u.test(token))window.opener.postMessage({type:"YZY_EDITOR_PRINT_READY",token},location.origin);
  else status.textContent="请从译文编辑器点击「导出编辑稿」打开此页。";
})();
