/** 本机样本定向验收。真实 PDF.js + 真实本机 OCR，不调用翻译服务、不保存截图或正文日志。 */
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict'),{chromium}=require('playwright'),{fixtures}=require('./browser-pdf-reader.cjs');
const ROOT=path.resolve(__dirname,'..'),OUT=path.join(ROOT,'.local/pdf-quality');
(async()=>{
 fs.mkdirSync(OUT,{recursive:true});const generated=await fixtures();fs.writeFileSync(path.join(OUT,'complex.pdf'),generated.complex);
 const cases=[
  {id:'english',file:'.local/p5b/samples/export-en.pdf'},
  {id:'chinese',file:'.local/p7/out/fallback/f7-zh-en-src.pdf',script:'Han'},
  {id:'japanese',file:'.local/p7/out/fallback/f7-ja-zh-src.pdf',script:'Japanese'},
  {id:'scanned-en',file:'.local/p4e/samples/S3-en-scanned.pdf',ocr:['eng']},
  {id:'scanned-zh',file:'.local/p4e/samples/S3-zh-scanned.pdf',ocr:['chi_sim','eng']},
  {id:'mixed',file:'.local/p4e/samples/S6-mixed.pdf',ocr:['eng','chi_sim']},
  {id:'vector-chart',file:'.local/p6/samples/D2-bars.pdf'},
  {id:'complex-fixture',file:'.local/pdf-quality/complex.pdf',pages:[1,2,3,4,5,6,7]},
  {id:'attention-paper',file:'.local/pdf-quality/samples/attention.pdf',pages:[1,3]},
  {id:'redhat-table',file:'.local/pdf-quality/samples/redhat.pdf',pages:[1,2]},
  {id:'who-chinese',file:'.local/pdf-quality/samples/who.pdf',pages:[1,2],ocr:['chi_sim','eng']}
 ];
 const server=http.createServer((req,res)=>{const url=new URL(req.url,'http://localhost');
  if(url.pathname==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<!doctype html><meta charset="utf-8">'+['errors','document-reader','reading-structure','block-processor','ocr-models','ocr-model-store','ocr-provider'].map(file=>'<script src="/pdf/'+file+'.js"></script>').join(''));return;}
  const file=path.resolve(ROOT,'.'+url.pathname);if(!file.startsWith(ROOT+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);res.end();return;}
  res.setHeader('Content-Type',({'js':'text/javascript','mjs':'text/javascript','wasm':'application/wasm','pdf':'application/pdf'})[path.extname(file).slice(1)]||'application/octet-stream');fs.createReadStream(file).pipe(res);});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;const results=[],errors=[];
 try{browser=await chromium.launch({headless:true});const tab=await browser.newPage();
  await tab.addInitScript(()=>{window.chrome={runtime:{getURL:file=>location.origin+'/'+file}};});
  await tab.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
  tab.on('pageerror',error=>errors.push(error.message));await tab.goto('http://127.0.0.1:'+server.address().port);
  for(const sample of cases.filter(sample=>!process.env.PDF_SAMPLE_ONLY||sample.id===process.env.PDF_SAMPLE_ONLY)){
   if(!fs.existsSync(path.join(ROOT,sample.file))){results.push({id:sample.id,status:'not-executed',reason:'missing local sample'});continue;}
   let pages;try{pages=await tab.evaluate(async sample=>{
    const bytes=new Uint8Array(await (await fetch('/'+sample.file)).arrayBuffer()),reader=BT_PDF_READER.create(),controller=new AbortController(),signal=controller.signal;
    const opened=await reader.open(bytes,{signal,onPassword:async()=>null}),reports=[];let provider;
    try{for(const pageNumber of sample.pages||[1]){
     const extracted=await reader.extractPage(pageNumber,{signal}),probe=await reader.probePageContent(pageNumber,{signal}),native=BT_PDF_BLOCKS.process(extracted,probe);
     const classification=BT_PDF_BLOCKS.classifyPage(native,probe),plan=BT_PDF_BLOCKS.planOCR(native,probe);
     let ocrLines=0,ocrEligible=0,merged=native,scriptChars=0,dark=0,ocrHan=0,nativeHan=0;
     nativeHan=native.blocks.reduce((sum,b)=>sum+Array.from(b.text).filter(ch=>/\p{Script=Han}/u.test(ch)).length,0);
     if(sample.script){const regex=sample.script==='Han'?/\p{Script=Han}/u:/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
       scriptChars=native.blocks.reduce((n,b)=>n+Array.from(b.text).filter(ch=>regex.test(ch)).length,0);}
     // 单页内存渲染也用于确认源文件可见，不创建 PNG。
     const canvas=document.createElement('canvas'),handle=reader.renderPage({pageNumber,scale:sample.ocr?3:1.5,viewRotation:0,canvas,pixelBudget:8000000},{signal});
     try{const info=await handle.promise,pixels=canvas.getContext('2d',{willReadFrequently:true}).getImageData(0,0,canvas.width,canvas.height).data;
       for(let i=0;i<pixels.length;i+=16)if(pixels[i]<180&&pixels[i+1]<180&&pixels[i+2]<180)dark++;
       if(sample.ocr&&(classification.type==='scanned'||plan.regions.length)){
         const BM=BT_PDF_BLOCKS.matrix,k=canvas.width/info.width,toPixel=BM.compose([k,0,0,k,0,0],BM.compose(info.viewportTransform,BM.invert(extracted.transform)));
         const regions=classification.type==='scanned'?undefined:plan.regions.map(({rect})=>{
           const points=[[rect.x,rect.y],[rect.right,rect.y],[rect.right,rect.bottom],[rect.x,rect.bottom]].map(([x,y])=>BM.apply(toPixel,x,y));
           const left=Math.max(0,Math.floor(Math.min(...points.map(p=>p[0])))),top=Math.max(0,Math.floor(Math.min(...points.map(p=>p[1]))));
           return {left,top,width:Math.min(canvas.width,Math.ceil(Math.max(...points.map(p=>p[0]))))-left,height:Math.min(canvas.height,Math.ceil(Math.max(...points.map(p=>p[1]))))-top};
         }).filter(r=>r.width>=8&&r.height>=8);
         provider=provider||BT_PDF_OCR.create();const result=await provider.recognize({image:canvas,languages:sample.ocr,regions},{signal});ocrLines=result.lines.length;ocrHan=result.lines.reduce((sum,line)=>sum+Array.from(line.text).filter(ch=>/\p{Script=Han}/u.test(ch)).length,0);
         const model=BT_PDF_BLOCKS.processOcr({pageNumber,width:extracted.width,height:extracted.height,result,
           bitmap:{viewportTransform:info.viewportTransform,pageTransform:extracted.transform,pixelScale:canvas.width/info.width}});
         ocrEligible=model.blocks.filter(b=>b.eligible).length;merged=BT_PDF_BLOCKS.merge(native,model);
       }
     }finally{handle.dispose();canvas.width=canvas.height=0;}
     reports.push({page:pageNumber,type:classification.type,native:native.blocks.length,reliable:native.blocks.filter(b=>b.reliable).length,
      eligible:native.blocks.filter(b=>b.eligible).length,tables:native.tables.length,visuals:native.visuals.length,
      merged:merged.blocks.length,ocrLines,ocrEligible,scriptChars,dark,nativeHan,ocrHan,
      eligibleHan:merged.blocks.filter(b=>b.eligible).reduce((sum,b)=>sum+Array.from(b.text).filter(ch=>/\p{Script=Han}/u.test(ch)).length,0),
      kinds:[...new Set(native.blocks.map(b=>b.kind))]});
    }}finally{await provider?.terminate();await reader.close();}
    return reports;
   },sample);
    assert.ok(pages.every(page=>page.dark>20),'actual source pixels must be visible');
    if(sample.script)assert.ok(pages.some(page=>page.scriptChars>0),'native script must actually be extracted');
    if(sample.id.startsWith('scanned-'))assert.ok(pages.some(page=>page.ocrEligible>0),'real OCR must yield eligible text');
    if(sample.id==='redhat-table')assert.equal(pages.find(page=>page.page===2).tables,1,'real segmented table must be recognized');
    if(sample.id==='complex-fixture')assert.ok(pages.some(page=>page.tables)&&pages.some(page=>page.visuals));
    if(sample.id==='who-chinese')assert.ok(pages.every(page=>page.eligible>0||page.ocrEligible>0),'WHO pages need usable native or OCR text');
    if(sample.id==='who-chinese'||sample.id==='scanned-zh')assert.ok(pages.every(page=>page.eligibleHan>0),'Chinese samples must yield actual eligible Han characters');
    results.push({id:sample.id,status:'passed',pages});console.log('PASS sample '+sample.id+': '+JSON.stringify(pages));
   }catch(error){results.push({id:sample.id,status:'failed',pages,reason:error.message});console.log('FAIL sample '+sample.id+': '+error.message+' '+JSON.stringify(pages));}
  }
  assert.deepEqual(errors,[],'no unhandled errors in sample reader/OCR');
 }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));fs.writeFileSync(path.join(OUT,'sample-results.json'),JSON.stringify({results,errors},null,2));}
 const failed=results.filter(r=>r.status==='failed');console.log('PDF samples: '+results.filter(r=>r.status==='passed').length+' passed, '+failed.length+' failed, '+results.filter(r=>r.status==='not-executed').length+' not executed');assert.equal(failed.length,0);
})().catch(error=>{console.error(error);process.exitCode=1;});
