/** 结构化导出真实结果：合并单元格、超高行跨页、统计和未翻译原文保留。 */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http'),{chromium}=require('playwright');
const {PDFDocument,StandardFonts}=require('../pdf/vendor/pdf-lib/pdf-lib.min.js'),{worker}=require('./pdf-export.cjs');
(async()=>{
 const source=await PDFDocument.create(),font=await source.embedFont(StandardFonts.Helvetica),p=source.addPage([600,800]);
 p.drawText('Retained original source',{x:40,y:740,size:14,font});const bytes=Buffer.from(await source.save());
 const grid={id:'table',rows:3,columns:2,widths:[.35,.65],cells:[
  {id:'a',row:0,column:0,rowSpan:2,colSpan:1},{id:'b',row:0,column:1,rowSpan:1,colSpan:1},
  {id:'c',row:1,column:1,rowSpan:1,colSpan:1},{id:'d',row:2,column:0,rowSpan:1,colSpan:2}]};
 const texts=['Long merged cell content. '.repeat(1800)+' MERGED_TAIL','Top right cell','Second right cell','Full width final row'];
 const blocks=grid.cells.map((cell,i)=>({id:cell.id,order:i,role:'text',eligible:true,reliable:true,height:12,text:'Source '+cell.id,table:grid,cell,
  rect:{x:40,y:100+i*80,right:500,bottom:140+i*80},lines:[{}]}));
 blocks.push({id:'num',order:4,role:'number',eligible:false,reliable:true,height:12,text:'42',rect:{x:40,y:500,right:100,bottom:520}});
 blocks.push({id:'failed',order:5,role:'text',eligible:true,reliable:true,height:12,text:'Original text that must not disappear',rect:{x:40,y:550,right:500,bottom:570}});
 const results=grid.cells.map((cell,i)=>[cell.id,{status:'translated',text:texts[i],userEdited:i===1}]);results.push(['num',{status:'unchanged',text:'42'}],['failed',{status:'failed',reason:'test failure'}]);
 const done=await worker({job:'export',requestId:'complex',mode:'structured',bytes,fontCode:'builtin',fontLabel:'Helvetica',fontMetrics:{ascent:.718,lineHeight:1.25},pages:[{snapshot:{
  identity:{documentId:'source',numPages:1,page:1,to:'en'},geometry:{width:600,height:800,transform:[1,0,0,-1,0,800]},blocks,results}}]});
 assert.equal(done.stats.translated,4);assert.equal(done.stats.edited,1);assert.equal(done.stats.unchanged,1);assert.equal(done.stats.retained,1);assert.equal(done.stats.tables,1);assert.equal(done.stats.sourcePages,1);
 assert.ok(done.stats.pages>3,'merged cell must actually cross page boundaries');
 // 无效表格只回退自身：前后有效段落仍在正文，表格成功译文进入补充页。
 const badGrid={id:'bad-grid',rows:2,columns:2,widths:[1,1],rect:{x:40,y:180,right:500,bottom:260},cells:[
  {id:'bad-cell',row:0,column:0,rowSpan:2,colSpan:2},{id:'overlap-cell',row:1,column:1,rowSpan:1,colSpan:1}]};
 const before={id:'before',order:0,role:'text',eligible:true,reliable:true,source:'native',height:12,text:'Source paragraph before the table.',kind:'paragraph',
  rect:{x:40,y:100,right:500,bottom:120},lines:[]};
 const bad={...before,id:'bad-cell',order:1,text:'Source table cell.',table:badGrid,cell:badGrid.cells[0],rect:{x:40,y:180,right:500,bottom:220}};
 const after={...before,id:'after',order:2,text:'Source paragraph after the table.',rect:{x:40,y:300,right:500,bottom:320}};
 const partial=await worker({job:'export',requestId:'region-rollback',mode:'structured',bytes,fontCode:'builtin',fontLabel:'Helvetica',fontMetrics:{ascent:.718,lineHeight:1.25},pages:[{snapshot:{
  identity:{documentId:'source',numPages:1,page:1,to:'en'},geometry:{pageNumber:1,width:600,height:800,transform:[1,0,0,-1,0,800]},
  blocks:[before,bad,after],results:[['before',{status:'translated',text:'Valid first paragraph.'}],['bad-cell',{status:'translated',text:'Translated cell retained in the supplement.'}],['after',{status:'translated',text:'Valid last paragraph.'}]]}}]});
 assert.equal(partial.stats.translated,3);assert.ok(partial.stats.supplementalPages>0);
 const report=partial.stats.per[0],supplement=new Set(report.output.filter(page=>page.supplemental).map(page=>page.page));
 for(const id of ['before','after'])assert.ok(report.anchors.some(a=>a.id===id&&!supplement.has(a.page)),'valid region must survive another region failing');
 assert.ok(report.anchors.some(a=>a.id==='bad-cell'&&supplement.has(a.page)));
 assert.ok(report.diagnostics.some(d=>d.stage==='table'));assert.equal(report.quality.state,'retained');assert.equal(report.quality.retainedRegions,1);
 // 各栏从同一页独立续排：左右任意一栏变长都不能推迟另一栏的起点。
 const left={...before,id:'left',text:'Left source text.',rect:{x:40,y:100,right:250,bottom:220}};
 const right={...before,id:'right',order:1,text:'Right source text.',rect:{x:300,y:100,right:510,bottom:220}};
 const columns=await worker({job:'export',requestId:'column-order',mode:'structured',bytes,fontCode:'builtin',fontLabel:'Helvetica',fontMetrics:{ascent:.718,lineHeight:1.25},pages:[{snapshot:{
  identity:{documentId:'source',numPages:1,page:1,to:'en'},geometry:{pageNumber:1,width:600,height:800,transform:[1,0,0,-1,0,800]},blocks:[left,right],
  results:[['left',{status:'translated',text:'The left column expands across multiple pages. '.repeat(250)}],['right',{status:'translated',text:'The next source column follows the complete left column.'}]]}}]});
 const anchors=columns.stats.per[0].anchors,leftPages=anchors.filter(a=>a.id==='left').map(a=>a.page),rightPages=anchors.filter(a=>a.id==='right').map(a=>a.page);
 assert.ok(new Set(leftPages).size>1);assert.equal(Math.min(...rightPages),Math.min(...leftPages),'short right column starts on the first shared page');
 assert.ok(anchors.filter(a=>a.id==='left').every(a=>a.x>=40-.1&&a.x+a.width<=250+.1));
 assert.ok(anchors.filter(a=>a.id==='right').every(a=>a.x>=300-.1&&a.x+a.width<=510+.1));
 assert.equal(columns.stats.sourcePages,0);assert.equal(columns.stats.per[0].quality.state,'layout-checked');
 const tail={...before,id:'tail',order:2,text:'Full width paragraph after both columns.',rect:{x:40,y:320,right:510,bottom:340}};
 for(const [index,counts] of [[0,[1,250]],[1,[250,180]]]){
  const generated=await worker({job:'export',requestId:'independent-columns-'+index,mode:'structured',bytes,fontCode:'builtin',fontLabel:'Helvetica',fontMetrics:{ascent:.718,lineHeight:1.25},pages:[{snapshot:{
   identity:{documentId:'source',numPages:1,page:1,to:'en'},geometry:{pageNumber:1,width:600,height:800,transform:[1,0,0,-1,0,800]},blocks:[left,right,tail],
   results:[['left',{status:'translated',text:'Left column content expands independently. '.repeat(counts[0])}],['right',{status:'translated',text:'Right column content expands independently. '.repeat(counts[1])}],['tail',{status:'translated',text:'This full width paragraph follows both completed columns.'}]]}}]});
  const output=generated.stats.per[0],a=output.anchors.filter(a=>a.id==='left'),b=output.anchors.filter(a=>a.id==='right'),t=output.anchors.filter(a=>a.id==='tail');
  assert.ok(a.length&&b.length&&t.length);assert.equal(Math.min(...a.map(a=>a.page)),Math.min(...b.map(a=>a.page)));
  assert.ok(new Set(b.map(a=>a.page)).size>1,'long right column continues across pages');
  assert.ok(Math.min(...t.map(a=>a.page))>=Math.max(...a.concat(b).map(a=>a.page)),'full width content waits for both columns');
  const firstTail=t[0];assert.ok(a.concat(b).filter(a=>a.page===firstTail.page).every(a=>a.y+a.height<=firstTail.y+.1),'full width content starts below both column endings');
  assert.equal(generated.stats.sourcePages,0);assert.equal(output.quality.state,'layout-checked');
 }
 // 真实生成链路：字体内部编号与源块字号不同的正文仍使用同样的输出行高。
 const typedBlocks=[
  {...before,id:'style-title',kind:'heading',headingLevel:1,height:18,rect:{x:40,y:60,right:510,bottom:82}},
  {...before,id:'style-a',order:1,height:10,fontName:'A',rect:{x:40,y:140,right:510,bottom:160}},
  {...before,id:'style-b',order:2,height:10.7,fontName:'B',rect:{x:40,y:230,right:510,bottom:251}},
  {...before,id:'style-c',order:3,height:12,fontName:'C',rect:{x:40,y:320,right:510,bottom:342}},
  {...before,id:'style-note',order:4,kind:'footnote',height:6,rect:{x:40,y:560,right:510,bottom:574}}
 ];
 const typed=await worker({job:'export',requestId:'unified-typography',mode:'structured',bytes,fontCode:'builtin',fontLabel:'Helvetica',fontMetrics:{ascent:.718,lineHeight:1.25},pages:[{snapshot:{
  identity:{documentId:'source',numPages:1,page:1,to:'en'},geometry:{pageNumber:1,width:600,height:800,transform:[1,0,0,-1,0,800]},blocks:typedBlocks,
  results:typedBlocks.map(block=>[block.id,{status:'translated',text:block.id==='style-title'?'Document heading':block.id==='style-note'?'Publication note.':'An ordinary paragraph using the same output typography across fonts.'}])}}]});
 const typedReport=typed.stats.per[0],heightFor=id=>typedReport.anchors.find(anchor=>anchor.id===id)?.height;
 assert.equal(typed.stats.translated,5);assert.equal(typed.stats.sourcePages,0);
 assert.equal(typedReport.typography.body,10);assert.equal(heightFor('style-a'),heightFor('style-b'));
 assert.equal(heightFor('style-b'),heightFor('style-c'));
 assert.ok(heightFor('style-title')>heightFor('style-a'));assert.ok(heightFor('style-note')<heightFor('style-a'));
 const root=path.resolve(__dirname,'..');
 const server=http.createServer((req,res)=>{const url=new URL(req.url,'http://localhost');if(url.pathname==='/result.pdf'){res.setHeader('Content-Type','application/pdf');res.end(done.bytes);return;}
  if(url.pathname==='/'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><meta charset="utf-8">');return;}
  const file=path.resolve(root,'.'+url.pathname);if(!file.startsWith(path.join(root,'pdf/vendor')+path.sep)||!fs.existsSync(file)){res.writeHead(404);res.end();return;}
  res.setHeader('Content-Type',file.endsWith('.mjs')?'text/javascript':'application/octet-stream');res.end(fs.readFileSync(file));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;
 try{browser=await chromium.launch({headless:true});const tab=await browser.newPage();await tab.goto('http://127.0.0.1:'+server.address().port);
  const result=await tab.evaluate(async()=>{
   const pdfjs=await import('/pdf/vendor/build/pdf.mjs');pdfjs.GlobalWorkerOptions.workerSrc='/pdf/vendor/build/pdf.worker.mjs';
   const loading=pdfjs.getDocument({url:'/result.pdf',standardFontDataUrl:'/pdf/vendor/standard_fonts/',verbosity:0}),doc=await loading.promise;
   let text='',paths=0,outside=0,dark=0;const dimensions=[];
   for(let n=1;n<=doc.numPages;n++){
    const page=await doc.getPage(n),content=await page.getTextContent(),view=page.getViewport({scale:1});
    text+=content.items.map(item=>item.str||'').join(' ');const canvas=document.createElement('canvas');canvas.width=Math.ceil(view.width);canvas.height=Math.ceil(view.height);
    const ctx=canvas.getContext('2d',{willReadFrequently:true});await page.render({canvasContext:ctx,viewport:view}).promise;
    const ops=await page.getOperatorList();paths+=ops.fnArray.filter(x=>x===pdfjs.OPS.constructPath).length;
    for(const item of content.items){if(!item.str?.trim())continue;const m=pdfjs.Util.transform(view.transform,item.transform);
      if(m[4]<-1||m[5]<-1||m[4]+item.width>view.width+1||m[5]>view.height+1)outside++;
      dimensions.push({text:item.str,x:m[4],y:m[5]});}
    const pixels=ctx.getImageData(0,0,canvas.width,canvas.height).data;for(let i=0;i<pixels.length;i+=4)if(pixels[i]<150&&pixels[i+1]<150&&pixels[i+2]<150)dark++;
    canvas.width=canvas.height=0;page.cleanup();
   }
   await loading.destroy();return {text,paths,outside,dark,dimensions};
  });
  // PDF 内容流逐页书写；右列会插在跨页左列的两个片段之间。按实际单元格横坐标恢复再核对全文，
  // 不能把内容流的线性串当成表格阅读顺序，也不能只检查尾部关键字。
  const compact=result.text.replace(/\s/g,''),leftColumn=result.dimensions.filter(item=>item.x>60&&item.x<120).map(item=>item.text).join('').replace(/\s/g,'');
  assert.ok(leftColumn.includes(texts[0].replace(/\s/g,'')),'all merged-cell text retained in its physical column');
  for(const text of texts.slice(1))assert.ok(compact.includes(text.replace(/\s/g,'')),'all remaining table-cell text retained');
  assert.match(result.text,/Original text that must not disappear/);assert.match(result.text,/Retained original source/);assert.equal(result.outside,0);assert.ok(result.paths>10,'real cell borders must be drawn');assert.ok(result.dark>1000);
  const right=result.dimensions.find(x=>x.text==='Top right cell'),left=result.dimensions.find(x=>x.text.startsWith('Long merged'));
  assert.ok(right&&left&&right.x>left.x+100,'cell content is in separate physical columns');
  console.log('PASS complex export: 4 translated, 1 unchanged, 1 failed; merged cells and full table text across '+done.stats.pages+' output pages; bounds, columns and source preservation verified');
 }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
