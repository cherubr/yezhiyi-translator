/** 真实 Worker 字节 + PDF.js 文本与像素核验；字体样本可通过 PDF_TEST_FONT_DIR 指定，不联网。 */
const fs=require("node:fs"),path=require("node:path"),vm=require("node:vm"),assert=require("node:assert/strict"),http=require("node:http");
const {chromium}=require("playwright"),{PDFDocument,StandardFonts}=require("../pdf/vendor/pdf-lib/pdf-lib.min.js");
const ROOT=path.resolve(__dirname,".."),OUT=path.join(ROOT,".local/pdf-product-verification");fs.mkdirSync(OUT,{recursive:true});
async function worker(job){
  const context={setTimeout,clearTimeout,queueMicrotask};context.self=context;let settled=false;
  vm.createContext(context);context.importScripts=(...files)=>files.forEach(file=>vm.runInContext(fs.readFileSync(path.join(ROOT,"pdf",file),"utf8"),context,{filename:file}));
  vm.runInContext(fs.readFileSync(path.join(ROOT,"pdf/export-worker.js"),"utf8"),context);
  const alloc=vm.runInContext("n=>new Uint8Array(n)",context);
  const bytes=value=>{const buffer=alloc(value.length);buffer.set(value);return buffer.buffer;};
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error("Worker timeout")),240000);
    context.postMessage=message=>{if(settled||!["done","error"].includes(message.type))return;settled=true;clearTimeout(timer);
      if(message.type==="error")reject(Object.assign(new Error(message.message),{code:message.code}));else resolve({bytes:Buffer.from(new Uint8Array(message.bytes)),stats:message.stats});};
    const cloned={...job,bytes:bytes(job.bytes)};if(job.fontBytes)cloned.fontBytes=bytes(job.fontBytes);
    if(job.fallbackFonts)cloned.fallbackFonts=job.fallbackFonts.map(item=>({...item,bytes:item.bytes?bytes(item.bytes):null}));
    context.onmessage({data:cloned});
  });
}
module.exports={worker};
if(require.main===module)(async()=>{
  const source=await PDFDocument.create(),font=await source.embedFont(StandardFonts.Helvetica),page=source.addPage([600,800]);
  for(let i=0;i<3;i++)page.drawText("Original paragraph "+i,{x:60,y:700-i*100,size:15,font});
  const native=Buffer.from(await source.save());fs.writeFileSync(path.join(OUT,"original.pdf"),native);
  const blocks=[0,1,2].map(i=>({id:"1:"+i,order:i,text:"Original paragraph "+i,role:"text",height:15,eligible:true,reliable:true,direction:"ltr",lines:[{},{}],
    rect:{x:58,y:84+i*100,right:540,bottom:116+i*100}}));
  const evidence=blocks.map(block=>[block.id,{densitySufficient:true,background:{uniform:true,color:[255,255,255]},hasStrokes:false,inkConfined:true,solidInk:false}]);
  const makeJob=(mode,text,fontBytes,fallbackFonts)=>({job:"export",requestId:"test",mode,bytes:native,
    fontCode:fontBytes?"sc":"builtin",fontLabel:"Test font",fontBytes,fontMetrics:{ascent:.718,lineHeight:1.25},fallbackFonts,
    pages:[{snapshot:{identity:{documentId:"sha-test",numPages:1,page:1,to:"zh"},geometry:{pageNumber:1,width:600,height:800,transform:[1,0,0,-1,0,800]},blocks,
      results:[["1:0",{status:"translated",text,userEdited:true,machine:{status:"translated",text:"OLD MACHINE VERSION"}}],
        ["1:1",{status:"translated",text:(fontBytes?"完整译文日本語한국어 ":"Complete fallback translation. ").repeat(500)+" TAIL_MARKER_END"}],
        ["1:2",{status:"translated",text:"Linux RHCE OpenShift"}]]},evidence,markerNumbers:[["1:1",1]]}]});
  const missing=await worker({...makeJob("structured","unused"),pages:[{page:1}]});
  assert.equal((await PDFDocument.load(missing.bytes)).getPageCount(),1,"explicit keep-missing policy copies the original page without adding an empty translation page");
  // /Info 为非字典时可阅读的页面不应被默认元数据改写拦截。
  const metadataSource=await PDFDocument.load(native,{updateMetadata:false});
  metadataSource.context.trailerInfo.Info=metadataSource.context.obj(17);
  const metadataBytes=Buffer.from(await metadataSource.save());
  const metadataExport=await worker({...makeJob('structured','Metadata-independent translation'),bytes:metadataBytes});
  assert.ok(metadataExport.bytes.length>0,'optional malformed metadata cannot prevent exporting readable pages');
  const outputs=[];
  for(const mode of ['translated','structured']){
    const symbolJob=makeJob(mode,'Keep the mathematical operator ∗ and remove only the zero\u200bwidth marker.'),before=JSON.stringify(symbolJob.pages);
    const symbolExport=await worker(symbolJob);
    assert.ok(symbolExport.stats.fontCodes.includes('builtin-symbol'),'missing mathematical glyphs use the actual PDF Symbol font');
    assert.equal(JSON.stringify(symbolJob.pages),before,'worker normalization must not change caller snapshots');
    const exported=await PDFDocument.load(symbolExport.bytes);
    assert.ok(exported.getPageCount()>0,'both layout modes must export zero-width controls without missing-glyph failures');
  }
  for(const mode of ["translated","structured"]){
    const result=await worker(makeJob(mode,"Saved manual revision B"));
    const name=(mode==="translated"?"preserved":"structured")+"-ascii.pdf";fs.writeFileSync(path.join(OUT,name),result.bytes);
    assert.ok((await PDFDocument.load(result.bytes)).getPageCount()>1,"long translation requires an appendix or natural pagination");
    outputs.push({name,text:"Saved manual revision B",mixed:false});
  }
  const fontDir=process.env.PDF_TEST_FONT_DIR;
  if(fontDir){
    const sc=fs.readFileSync(path.join(fontDir,"NotoSansSC-Regular.otf")),kr=fs.readFileSync(path.join(fontDir,"NotoSansKR-Regular.otf"));
    for(const mode of ["translated","structured"]){
      const result=await worker(makeJob(mode,"人工修订中文日本語한국어",sc,[{code:"kr",label:"Korean",bytes:kr}]));
      const name=(mode==="translated"?"preserved":"structured")+"-mixed.pdf";fs.writeFileSync(path.join(OUT,name),result.bytes);
      assert.ok(result.stats.fontCodes.includes("sc")&&result.stats.fontCodes.includes("kr"));
      outputs.push({name,text:"人工修订中文日本語한국어",mixed:true});
    }
    await assert.rejects(worker(makeJob("structured","中文",Buffer.from("invalid-font-data"))),error=>error.code==="EXPORT_FONT_FAILED");
  }else console.log("UNVERIFIED: CJK font generation requires PDF_TEST_FONT_DIR");
  await assert.rejects(worker(makeJob("structured","中文")),error=>error.code==="EXPORT_GLYPH_MISSING");
  const server=http.createServer((req,res)=>{
    const url=new URL(req.url,"http://localhost"),relative=url.pathname.startsWith("/output/")?path.join(OUT,path.basename(url.pathname)):path.join(ROOT,url.pathname);
    if(!relative.startsWith(ROOT+path.sep)||!fs.existsSync(relative)||!fs.statSync(relative).isFile()){res.writeHead(404);res.end();return;}
    const ext=path.extname(relative);res.setHeader("Content-Type",({".html":"text/html; charset=utf-8",".css":"text/css",".pdf":"application/pdf",".mjs":"text/javascript",".js":"text/javascript",".wasm":"application/wasm"})[ext]||"application/octet-stream");res.end(fs.readFileSync(relative));
  });
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));let browser;
  try{
    browser=await chromium.launch({headless:true});const tab=await browser.newPage();
    await tab.goto("http://127.0.0.1:"+server.address().port+"/pdf/reader.html");
    const results=await tab.evaluate(async ({outputs,missing,savePreviews})=>{
      const pdfjs=await import("/pdf/vendor/build/pdf.mjs");pdfjs.GlobalWorkerOptions.workerSrc="/pdf/vendor/build/pdf.worker.mjs";
      const out=[];
      for(const output of outputs){
        const loading=pdfjs.getDocument({url:"/output/"+output.name,standardFontDataUrl:"/pdf/vendor/standard_fonts/",cMapUrl:"/pdf/vendor/cmaps/",cMapPacked:true,wasmUrl:"/pdf/vendor/wasm/",verbosity:0}),doc=await loading.promise;
        let text="",glyphs=0,ink=0;const images=[];
        for(let n=1;n<=doc.numPages;n++){
          const page=await doc.getPage(n),content=await page.getTextContent();text+=content.items.map(item=>item.str||"").join(" ");
          const view=page.getViewport({scale:1.25}),canvas=document.createElement("canvas");canvas.width=Math.ceil(view.width);canvas.height=Math.ceil(view.height);
          const context=canvas.getContext("2d",{willReadFrequently:true});await page.render({canvasContext:context,viewport:view}).promise;
          for(const item of content.items){
            if(!item.str?.trim())continue;
            const position=pdfjs.Util.transform(view.transform,item.transform);
            if(position[4]<-1||position[5]<-1||position[4]+item.width*view.scale>canvas.width+1||position[5]>canvas.height+1)
              throw new Error("Text outside page bounds: "+output.name+" page "+n);
          }
          const pixels=context.getImageData(0,0,canvas.width,canvas.height).data;
          for(let p=0;p<pixels.length;p+=4)if(pixels[p]<230&&pixels[p+1]<230&&pixels[p+2]<230)ink++;
          if(output.mixed)for(const item of content.items){
            if(!item.str||!/^\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(item.str))continue;
            if(!/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+$/u.test(item.str))continue;
            const m=pdfjs.Util.transform(view.transform,item.transform),chars=Array.from(item.str),w=item.width*view.scale/chars.length,h=Math.hypot(m[2],m[3]);
            for(let i=0;i<chars.length;i++){
              let dark=0;const x0=Math.max(0,Math.floor(m[4]+i*w)),x1=Math.min(canvas.width,Math.ceil(m[4]+(i+1)*w));
              for(let y=Math.max(0,Math.floor(m[5]-h*1.25));y<Math.min(canvas.height,Math.ceil(m[5]+h*.25));y++)for(let x=x0;x<x1;x++){
                const p=(y*canvas.width+x)*4;if(pixels[p]<230&&pixels[p+1]<230&&pixels[p+2]<230)dark++;
              }
              if(!dark)throw new Error("Rendered glyph is blank: "+chars[i]+" in "+output.name);glyphs++;
            }
          }
          if(savePreviews&&(n===1||n===doc.numPages))images.push(canvas.toDataURL("image/png").split(",")[1]);canvas.width=canvas.height=0;page.cleanup();
        }
        out.push({name:output.name,text,ink,glyphs,pages:doc.numPages,images});await loading.destroy();
      }
      const originalLoad=pdfjs.getDocument({data:new Uint8Array(missing),standardFontDataUrl:"/pdf/vendor/standard_fonts/",verbosity:0}),original=await originalLoad.promise;
      const kept=(await (await original.getPage(1)).getTextContent()).items.map(item=>item.str||"").join(" ");
      if(!kept.includes("Original paragraph 0"))throw new Error("Structured keep-missing export lost original content");
      await originalLoad.destroy();return out;
    },{outputs,missing:[...missing.bytes],savePreviews:process.env.PDF_TEST_SAVE_PREVIEWS==="1"});
    for(const result of results){
      const expected=outputs.find(item=>item.name===result.name);
      assert.ok(result.text.replace(/\s/g,"").includes(expected.text.replace(/\s/g,"")),"edited text searchable: "+result.name);
      assert.ok(!result.text.includes("OLD MACHINE VERSION"));assert.ok(result.ink>100);
      assert.ok(result.text.replace(/\s/g,"").includes("TAIL_MARKER_END"),"long paragraph tail retained: "+result.name);
      if(expected.mixed)assert.ok(result.glyphs>=12,"actual per-character CJK rendering audit");
      result.images.forEach((data,index)=>fs.writeFileSync(path.join(OUT,result.name+"."+index+".png"),Buffer.from(data,"base64")));
      console.log("PASS PDF output:",result.name,"pages="+result.pages,"CJK glyph crops="+result.glyphs);
    }
  }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
  console.log("PASS PDF export: real outputs parsed/rendered; edits present; original machine text absent; corrupt/missing fonts rejected");
})().catch(error=>{console.error(error);process.exitCode=1;});
