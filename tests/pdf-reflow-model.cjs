/** 纯扩展重排模型：结构来源、通用附标组件、来源守恒和落笔守卫；不联网、不截图。 */
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const context={window:{}};
for(const name of ['errors','reading-structure','block-processor','structured-reader','reflow-model'])
  vm.runInNewContext(fs.readFileSync('pdf/'+name+'.js','utf8'),context);
const B=context.window.BT_PDF_BLOCKS,R=context.window.BT_PDF_READING_STRUCTURE,M=context.window.BT_PDF_REFLOW_MODEL;
const fragment=(text,index,x,baseline,height,width)=>({text,index,height,baseline,rect:{x,y:baseline-height*.8,right:x+width,bottom:baseline+height*.2},direction:'ltr'});
let cases=0;
function test(name,run){run();cases++;console.log('PASS reflow model: '+name);}
test('不依赖字符白名单的多项附标组件',()=>{
  for(const content of [['4',',','5'],['α',',','β'],['世','界'],['∞']]){
    const base=fragment('The variable Ω',0,40,120,10,90),parts=content.map((text,index)=>fragment(text,index+1,131+index*3,124,6,3));
    const result=R.inlineFragments([base,...parts]);assert.equal(result.complete,true);
    for(const part of parts){assert.equal(part.inlineOwner,0);assert.equal(part.rowBaseline,120);}
  }
});
test('同基线邻接正文不标为附标，表格单元格之间不串联',()=>{
  const a=fragment('First',0,40,120,10,40),b=fragment('second',1,82,120,10,40);
  R.inlineFragments([a,b]);assert.equal(b.inlineOwner,undefined);
  const host=fragment('T',2,40,160,10,10),sub=fragment('12',3,51,164,6,6);
  host.cell={id:'left'};sub.cell={id:'right'};R.inlineFragments([host,sub]);assert.equal(sub.inlineOwner,undefined);
});
test('多个相近宿主有歧义时不强行绑定',()=>{
  const a=fragment('A',0,40,120,10,10),b=fragment('B',1,40,120.2,10,10),sub=fragment('12',2,51,124,6,6);
  R.inlineFragments([a,b,sub]);assert.equal(sub.inlineOwner,undefined);assert.equal(sub.inlineUncertain,true);
});
const item=(str,x,y,width=220,size=10,markedIds=[])=>({str,width,fontName:'body',dir:'ltr',transform:[size,0,0,size,x,800-y-size*.8],markedIds});
const page=items=>({pageNumber:1,width:600,height:800,transform:[1,0,0,-1,0,800],items,styles:{body:{ascent:.8,descent:-.2,fontFamily:'serif'}}});
test('同字号标题优先采用真实结构标签，两个 P 标签不会被吞并',()=>{
  const p=page([item('A heading with ordinary font',40,100,220,10,['h']),
    item('First paragraph with a complete source sentence.',40,114,220,10,['p1']),
    item('Second paragraph with another source sentence.',40,128,220,10,['p2'])]);
  p.structure={tags:[{id:'h',role:'H2',group:'0.1'},{id:'p1',role:'P',group:'0.2'},{id:'p2',role:'P',group:'0.3'}]};
  const result=B.process(p,{});assert.equal(result.blocks.length,3);assert.equal(result.blocks[0].kind,'subheading');
  assert.equal(result.blocks[0].headingLevel,2);assert.equal(result.blocks[0].structure.evidence,'pdf-tag');
  assert.equal(result.blocks[1].text,p.items[1].str);
});
test('Formula 标签保护无法由字符运算符辨认的公式',()=>{
  const p=page([item('arbitrary symbolic material',40,100,150,10,['eq'])]);
  p.structure={tags:[{id:'eq',role:'Formula',group:'0.1'}]};
  const result=B.process(p,{});assert.equal(result.blocks[0].role,'formula');assert.equal(result.blocks[0].eligible,false);
});
test('模型保留唯一来源、栏归属和源对象，不写回翻译块',()=>{
  const result=B.process(page([0,1,2,3].flatMap(i=>[
    item('Left body paragraph '+i+' with enough source content.',40,100+i*14,210),
    item('Right body paragraph '+i+' with enough source content.',300,100+i*14,210)])),{});
  const rows=result.blocks.map(block=>({block,result:{status:'translated',text:'translated '+block.id}})),before=JSON.stringify(rows);
  const model=M.page({rows,geometry:{pageNumber:1,width:600,height:800,visuals:[]}});
  const ids=model.nodes.flatMap(node=>Array.from(node.sourceIds));
  assert.equal(ids.length,result.blocks.length);assert.equal(new Set(ids).size,ids.length);
  assert.equal(model.issues.length,0);assert.ok(model.nodes.every(node=>node.column));assert.equal(JSON.stringify(rows),before);
});
test('旧模型孤立小字回退完整局部区域，不独立裁切后插入正文',()=>{
  const common={source:'native',reliable:true,eligible:true,role:'text',height:10,kind:'paragraph',lines:[]};
  const rows=[{block:{...common,id:'body',order:0,text:'A complete body paragraph with enough source text for measuring the body size.',rect:{x:40,y:100,right:250,bottom:140}}},
    {block:{...common,id:'sub',order:1,eligible:false,role:'number',height:6,text:'16',rect:{x:251,y:110,right:257,bottom:116}}}];
  const model=M.page({rows,geometry:{pageNumber:1,width:600,height:800,visuals:[]}});
  assert.equal(model.nodes.length,1);assert.equal(model.nodes[0].kind,'retained');assert.equal(model.nodes[0].sourceIds.length,2);
  assert.equal(model.complete,false);assert.equal(model.nodes[0].flow.sourceRect.right,257);
});
test('输出守卫检查越界、跨区域重叠并支持局部回滚',()=>{
  const guard=M.validator({width:600,height:800}),rect={x:40,y:40,right:140,bottom:60};
  assert.equal(guard.add(rect,{page:1,region:'a'}),null);const mark=guard.mark();
  assert.equal(guard.add({x:150,y:40,right:250,bottom:60},{page:1,region:'b'}),null);
  assert.equal(guard.add({x:130,y:45,right:160,bottom:65},{page:1,region:'c'}),'OUTPUT_OVERLAP');
  assert.equal(guard.add({...rect,right:601},{page:1,region:'b'}),'OUTPUT_BOUNDS');
  assert.equal(guard.add(rect,{page:2,region:'b'}),null);guard.restore(mark);assert.equal(guard.count(),1);
  assert.equal(guard.add({x:150,y:40,right:250,bottom:60},{page:1,region:'b'}),null);
});
console.log('PDF reflow model: '+cases+' cases passed');
