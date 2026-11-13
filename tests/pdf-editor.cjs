/** 编辑稿白名单模型：不执行 DOM/浏览器，不联网、不截图。 */
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const context={window:{}};
for(const name of ['structured-reader','reflow-typography','editor-model'])vm.runInNewContext(fs.readFileSync('pdf/'+name+'.js','utf8'),context);
const M=context.window.BT_PDF_EDITOR_MODEL,page={width:600,height:800,margin:20};
assert.equal(M.hasContent({children:[{tag:'p',children:[' \u200b',{tag:'br',children:[]}]}]}),false,'empty paragraphs and caret placeholders are not document content');
assert.equal(M.hasContent({children:[{tag:'table',children:[]}]}),true,'a table remains meaningful even with empty cells');
assert.equal(M.hasContent({children:[{tag:'img',children:[]}]}),true,'image-only pages must not be treated as blank');
const source={version:1,page,style:{fontSize:'10pt'},children:[{tag:'section',columns:2,widths:[2,1],children:[
  {tag:'div',children:[{tag:'h1',style:{fontSize:'18pt',fontWeight:'bold'},children:['Heading']},{tag:'p',sourceId:'1:0',style:{lineHeight:'1.5'},children:['A paragraph.']}]},
  {tag:'div',children:[{tag:'table',children:[{tag:'tbody',children:[{tag:'tr',children:[{tag:'td',rowSpan:2,colSpan:1,children:['Cell']}]}]}]},{tag:'hr',pageBreak:true,children:[]}]}]}]};
const before=JSON.stringify(source),clean=M.clean(source);
assert.equal(JSON.stringify(source),before,'sanitizer does not mutate drafts');
assert.equal(clean.children[0].widths[0],2);assert.equal(clean.children[0].children[1].children[0].children[0].children[0].children[0].rowSpan,2);
assert.equal(clean.children[0].children[1].children[1].pageBreak,true);
const untrusted=M.clean({version:1,page,style:{fontSize:'999pt',backgroundImage:'url(https://example.org/track)'},children:[{tag:'p',onclick:'run()',style:{fontFamily:'remote-font',textAlign:'center',width:'calc(100vw)'},children:['<script>literal text</script>']}]});
assert.equal(untrusted.style.fontSize,undefined);assert.equal(untrusted.style.backgroundImage,undefined);
assert.equal(untrusted.children[0].onclick,undefined);assert.equal(untrusted.children[0].style.textAlign,'center');
assert.equal(untrusted.children[0].children[0],'<script>literal text</script>','text remains text, never HTML');
const margins=M.styles({marginLeft:'auto',marginRight:'0pt',backgroundImage:'url(https://example.org/track)'});
assert.equal(margins.marginLeft,'auto');assert.equal(margins.marginRight,'0pt');assert.equal(margins.backgroundImage,undefined);
const linked=M.clean({version:1,page,children:[{tag:'pre',sourceId:'code-a',sourceIds:['code-a','code-b','code-b',null,9],children:['code']}]});
assert.deepEqual(Array.from(linked.children[0].sourceIds),['code-a','code-b'],'grouped region keeps all distinct source anchors');
assert.throws(()=>M.clean({version:1,page,children:[{tag:'script',children:['run()']}]}),/不支持/);
for(const src of ['https://example.org/a.png','data:image/svg+xml;base64,AAAA','data:image/png;base64,PHN2Zz4='])
  assert.throws(()=>M.clean({version:1,page,children:[{tag:'img',src,children:[]}]}),/图片/);
assert.throws(()=>M.clean({version:1,page:{...page,width:NaN},children:[]}),/尺寸/);
assert.throws(()=>M.clean({version:1,page,children:['x'.repeat(400001)]}),/文字过多/);
let nested='text';for(let i=0;i<50;i++)nested={tag:'div',children:[nested]};
assert.throws(()=>M.clean({version:1,page,children:[nested]}),/结构过大/);
const rows=[{block:{id:'a',order:0,kind:'paragraph',eligible:true,reliable:true,role:'text',height:10,text:'Original source paragraph.',rect:{x:40,y:80,right:250,bottom:120},lines:[]},result:{status:'translated',text:'Translated paragraph.'}},
  {block:{id:'b',order:1,kind:'paragraph',eligible:true,reliable:true,role:'text',height:10,text:'Second source paragraph.',rect:{x:300,y:80,right:510,bottom:120},lines:[]},result:{status:'failed',reason:'test'}}];
const rowsBefore=JSON.stringify(rows),seed=M.seed({rows,geometry:{width:600,height:800,pageNumber:1,visuals:[]}});
assert.equal(seed.children[0].columns,2);assert.equal(seed.children[0].children[0].children[0].children[0],'Translated paragraph.');
assert.equal(seed.children[0].children[1].children[0].status,'failed','failed source is not labeled as translated');
assert.equal(JSON.stringify(rows),rowsBefore,'document editing never rewrites translation results');
const codeRows=rows.map((row,index)=>({block:{...row.block,id:'code-'+index,role:'code',kind:'code',rawText:'mov r'+index+', 1',flow:{id:'code-region',type:'code',rect:{x:40,y:80,right:510,bottom:120}}},result:{status:'skipped'}}));
const codeSeed=M.seed({rows:codeRows,geometry:{width:600,height:800,pageNumber:1,visuals:[]}});
assert.deepEqual(Array.from(codeSeed.children[0].sourceIds),['code-0','code-1'],'every source line can locate a grouped code region');
assert.equal(context.window.BT_PDF_STRUCTURED.create,undefined,'legacy per-paragraph DOM editor is deleted');
console.log('PASS PDF editor model: semantic layout, sanitation, data-only images, bounds and source isolation');
