/** 目录结构与显式人工放置回归；不访问网络或翻译服务。按项目约定本轮只补源码。 */
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const window={},env={window,self:window};
for(const file of ['errors','reading-structure','toc-structure','block-processor','structured-reader','reflow-typography','editor-model','layout-planner','inplace-editor'])
  vm.runInNewContext(fs.readFileSync('pdf/'+file+'.js','utf8'),env,{filename:file+'.js'});
const P=window.BT_PDF_BLOCKS,S=window.BT_PDF_STRUCTURED,M=window.BT_PDF_EDITOR_MODEL,L=window.BT_PDF_LAYOUT_PLANNER;
const text=(str,x,y,width=str.length*5,size=10)=>({str,width,transform:[size,0,0,size,x,800-y-size*.8],fontName:'body',dir:'ltr'});
const process=items=>P.process({pageNumber:1,width:600,height:800,transform:[1,0,0,-1,0,800],styles:{body:{ascent:.8,descent:-.2,fontFamily:'serif'}},items},{});
const titles=['Introduction','Safety guidance','Reference material'];
const native=process(titles.flatMap((title,i)=>[text(title,40,100+i*16,160),text('.'.repeat(35),210,100+i*16,270),text(String(4+i*3),510,100+i*16,15)]));
const entries=native.blocks.filter(block=>block.toc?.part==='title');
assert.equal(entries.length,3,'directory entries cannot merge into a paragraph');
assert.deepEqual(Array.from(entries,block=>block.text),titles,'only titles enter translation');
assert.deepEqual(Array.from(entries,block=>block.toc.pageLabel),['4','7','10']);
assert.ok(native.blocks.some(block=>block.toc?.part==='page'),'page source geometry remains available');
const rows=native.blocks.map(block=>({block,result:{status:'translated',text:'Translated '+block.text}}));
const toc=S.sections(rows,[],{pageLayout:true}).find(node=>node.kind==='toc');
assert.equal(toc.items.length,3,'ornaments and page numbers cannot become independent prose');
const draft=M.seed({rows,geometry:native});
const flatten=nodes=>nodes.flatMap(node=>typeof node==='string'?[]:[node,...flatten(node.children||[])]);
const modelNodes=flatten(draft.children);
assert.equal(modelNodes.filter(node=>node.tocRole==='page').length,3,'editor keeps a separate page column');
assert.equal(modelNodes.find(node=>node.tocRole==='table').tag,'table');
const cleanedAgain=M.clean(draft);
assert.equal(flatten(cleanedAgain.children).filter(node=>node.tocRole==='page').length,3,'directory formatting survives local document sanitizing');
const multiline=process([
  text('First entry',40,100,140),text('........',210,100,270),text('4',510,100,15),
  text('A long title that starts above',40,116,220),
  text('and finishes on the next row',40,132,160),text('........',210,132,270),text('7',510,132,15),
  text('Third entry',40,148,160),text('........',210,148,270),text('10',510,148,15)
]);
const multipleEntries=multiline.blocks.filter(block=>block.toc?.part==='title');
assert.equal(multipleEntries.length,3);
assert.match(multipleEntries[1].text,/starts above.*finishes/,'wrapped title fragments share one directory entry');
const inline=process(titles.map((title,i)=>text(title+' ................ '+(i+1),40,100+i*16,480)));
assert.equal(inline.blocks.filter(block=>block.toc?.part==='title').length,3);
assert.ok(inline.blocks.every(block=>block.toc?.unresolvedGeometry),'single-item leaders cannot be guessed into safe mask coordinates');
const result=L.plan({geometry:inline,rows:inline.blocks.map(block=>({block,result:{status:'translated',text:'Translation'}})),measure:s=>s.length*5});
assert.equal(result.stats.overlay,0);assert.equal(result.fallbacks[0].reason,'toc-geometry');
const ordinary=process(Array.from({length:7},(_,i)=>[text('Product category '+i,40,100+i*16,180),text(String(i+1),510,100+i*16,15)]).flat());
assert.ok(ordinary.blocks.every(block=>!block.toc),'right-aligned numbers alone do not establish a directory');
const manualBlock={id:'manual-a',text:'source',height:10,rect:{x:40,y:40,right:140,bottom:70},role:'text',eligible:false,reliable:false};
const manual={status:'translated',text:'Manual text',userEdited:true,manualPlacement:{rect:{...manualBlock.rect},fontSize:10}};
const geometry={width:600,height:800},measure=(s,size)=>s.length*size*.5;
const placed=L.plan({geometry,rows:[{block:manualBlock,result:manual}],measure});
assert.equal(placed.stats.overlay,1,'explicit manual placement works without automatic background evidence');
assert.deepEqual(Array.from(placed.placements.get('manual-a').maskColor),[255,255,255]);
const measuredFamilies=[];
const familyPlan=L.plan({geometry,rows:[{block:manualBlock,result:{...manual,fontFamily:'monospace'}}],
  measure:(value,size,family)=>{measuredFamilies.push(family);return value.length*size*.5;}});
assert.ok(measuredFamilies.length&&measuredFamilies.every(family=>family==='monospace'),'chosen family participates in line measurement');
assert.equal(familyPlan.placements.get('manual-a').fontFamily,'monospace');
assert.match(L.fontStack('serif'),/Songti/);
assert.equal(L.fontStack('untrusted-font'),L.constants.FONT_STACK,'unknown families use the standard stack');
const textStyle={bold:true,italic:true,color:'#CC2244',align:'center',lineHeight:1.8},measuredStyles=[];
const styledPlan=L.plan({geometry,rows:[{block:manualBlock,result:{...manual,textStyle}}],
  measure:(value,size,family,style)=>{measuredStyles.push(style);return value.length*size*(style.bold ? .55 : .5);}});
const styledPlacement=styledPlan.placements.get('manual-a');
assert.ok(styledPlacement,'formatting must retain explicit manual placement');
assert.equal(styledPlacement.align,'center');assert.equal(styledPlacement.textStyle.color,'#cc2244');
assert.equal(styledPlacement.lineHeight,manual.manualPlacement.fontSize*1.8);
assert.ok(measuredStyles.length&&measuredStyles.every(style=>style.bold&&style.italic),'weight and slant must reach the width calculation');
const safeStyle=L.normalizeTextStyle({bold:'true',italic:1,color:'url(unsafe)',align:'justify',lineHeight:NaN});
assert.equal(safeStyle.bold,false);assert.equal(safeStyle.italic,false);assert.equal(safeStyle.color,'#243247');
assert.equal(safeStyle.align,null);assert.equal(safeStyle.lineHeight,1.45);
const overflow=L.plan({geometry,rows:[{block:manualBlock,result:{...manual,manualPlacement:{...manual.manualPlacement,fontSize:72}}}],measure});
assert.equal(overflow.stats.overlay,0);assert.equal(overflow.fallbacks[0].reason,'manual-fit');
const overlapping=L.plan({geometry,rows:[{block:manualBlock,result:manual},{block:{...manualBlock,id:'manual-b'},result:manual}],measure});
assert.equal(overlapping.stats.overlay,2,'explicit manual frames may overlap without losing either saved correction');
assert.equal(overlapping.fallbacks.length,0);
const layered=L.plan({geometry,rows:[
  {block:manualBlock,result:{...manual,correctionOrder:20}},
  {block:{...manualBlock,id:'manual-b'},result:{...manual,correctionOrder:10,manualPlacement:{fontSize:10,rect:{x:40,y:65,right:140,bottom:105}}}}
],measure});
assert.deepEqual(Array.from(layered.placements.keys()),['manual-b','manual-a'],'last saved frame must paint last even when it appears first in source order');
assert.equal(layered.placements.get('manual-b').maskRect.bottom,105,'partial overlap cannot crop or expand the older frame');
const raised=L.plan({geometry,rows:[
  {block:manualBlock,result:{...manual,correctionOrder:20}},
  {block:{...manualBlock,id:'manual-b'},result:{...manual,correctionOrder:30}}
],measure});
assert.deepEqual(Array.from(raised.placements.keys()),['manual-a','manual-b'],'editing an old frame must raise it above newer frames');
const automatic=L.plan({geometry,rows:[{block:manualBlock,result:{status:'translated',text:'Automatic'}}],measure});
assert.equal(automatic.stats.overlay,0,'manual support must not weaken automatic placement guards');
const outside=L.plan({geometry,rows:[{block:manualBlock,result:{...manual,manualPlacement:{fontSize:10,rect:{x:-2,y:0,right:100,bottom:40}}}}],measure});
assert.equal(outside.stats.overlay,0);assert.equal(outside.fallbacks[0].reason,'manual-bounds');
const edit=window.BT_PDF_INPLACE_EDITOR,editPlanner={measure,wrapText:L.wrapText};
const fitRect={x:30,y:30,right:130,bottom:55},originalRect=JSON.stringify(fitRect);
const fitting=edit.fitText('Direct editing text',fitRect,12,'sans-serif',true,editPlanner);
assert.equal(fitting.ok,true);assert.ok(fitting.size<12&&fitting.size>=4,'inline editing reduces font size within the existing paragraph');
assert.equal(JSON.stringify(fitRect),originalRect,'automatic fitting cannot enlarge the replacement area');
assert.equal(edit.fitText('Direct editing text',fitRect,12,'sans-serif',false,editPlanner).ok,false,'fixed font size reports overflow');
assert.equal(edit.fitText('text',fitRect,NaN,'serif',true,editPlanner).ok,false);
assert.equal(edit.fitText('text',{...fitRect,right:fitRect.x},10,'serif',true,editPlanner).ok,false);
const stylePlanner={measure,wrapText:L.wrapText,normalizeTextStyle:L.normalizeTextStyle};
const oneLine={x:0,y:0,right:200,bottom:16};
assert.equal(edit.fitText('text',oneLine,10,'sans-serif',false,stylePlanner).ok,true);
assert.equal(edit.fitText('text',oneLine,10,'sans-serif',false,stylePlanner,{lineHeight:2}).ok,false,'line spacing must participate in the popup fit guard');
const regionRows=[
  {block:{id:'second',height:10,rect:{x:20,y:40,right:100,bottom:55}}},
  {block:{id:'first',height:10,rect:{x:20,y:20,right:100,bottom:35}}},
  {block:{id:'outside',height:10,rect:{x:160,y:20,right:240,bottom:35}}}
];
assert.deepEqual(Array.from(edit.rowsInRect(regionRows,{x:15,y:15,right:110,bottom:60}),row=>row.block.id),['first','second'],'rectangle brings existing paragraphs into the dialog in reading order');
assert.equal(edit.rowsInRect(regionRows,{x:300,y:300,right:400,bottom:400}).length,0,'empty rectangles start with blank text');
assert.equal(edit.rowsInRect(regionRows,{x:95,y:20,right:110,bottom:35}).length,0,'touching a tiny edge must not import a whole paragraph');
const editLayers=[
  {block:{id:'top',height:10,rect:{x:20,y:20,right:100,bottom:50}},result:{...manual,correctionOrder:30,manualPlacement:{rect:{x:20,y:20,right:100,bottom:50},fontSize:10}}},
  {block:{id:'bottom',height:10,rect:{x:20,y:20,right:100,bottom:55}},result:{...manual,correctionOrder:10,manualPlacement:{rect:{x:20,y:20,right:100,bottom:55},fontSize:10}}}
];
const editRect=(block,result)=>result?.manualPlacement?.rect||block.rect;
assert.deepEqual(Array.from(edit.rowsForEdit(editLayers,{x:20,y:20,right:100,bottom:50},editRect),row=>row.block.id),['top'],'reopening overlapping corrections must import only the visible top layer');
assert.equal(edit.rowsForEdit([...editLayers,regionRows[0]],{x:15,y:15,right:110,bottom:65},editRect).length,3,'a larger selection must retain independently selected paragraphs');
assert.deepEqual(Array.from(edit.rowsForEdit(editLayers.map(row=>({...row,result:{...row.result,correctionOrder:0}})),{x:20,y:20,right:100,bottom:50},editRect),row=>row.block.id),['bottom'],'legacy layers with equal order must follow their drawing order');
const editableRect={x:30,y:40,right:130,bottom:90},bounds={width:200,height:160};
const moved=edit.adjustRect(editableRect,500,-500,'move',bounds);
assert.deepEqual({...moved},{x:100,y:0,right:200,bottom:50},'moving clamps to page edges without shrinking the frame');
const shrunk=edit.adjustRect(editableRect,500,500,'wn',bounds);
assert.equal(shrunk.right-shrunk.x,4);assert.equal(shrunk.bottom-shrunk.y,4,'resizing keeps the minimum text area');
const enlarged=edit.adjustRect(editableRect,500,500,'es',bounds);
assert.equal(enlarged.right,bounds.width);assert.equal(enlarged.bottom,bounds.height,'resizing cannot leave the PDF page');
assert.deepEqual(editableRect,{x:30,y:40,right:130,bottom:90},'drag calculations cannot mutate the starting rectangle');
console.log('PASS PDF directory structure and explicit manual placement');
