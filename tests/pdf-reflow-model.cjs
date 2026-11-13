/** 纯扩展重排模型：结构来源、通用附标组件、来源守恒和落笔守卫；不联网、不截图。 */
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const context={window:{}};
for(const name of ['errors','reading-structure','block-processor','structured-reader','reflow-model','reflow-typography'])
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
const T=context.window.BT_PDF_REFLOW_TYPOGRAPHY;
const styled=(id,height,kind='paragraph',extra={})=>({id,kind,block:{id,height,kind,role:'text',reliable:true,
  text:'A complete source paragraph used to determine the document typography.',lines:[],...extra}});
test('正文样式不随字体内部编号和译文长度变化，脚注不拉低正文',()=>{
  const rows=[styled('body-a',10,'paragraph',{fontName:'font-A'}),styled('body-b',10.8,'paragraph',{fontName:'font-B'}),
    styled('body-c',12,'paragraph',{fontName:'font-C'}),styled('small',6,'footnote',{text:'Fine print. '.repeat(400)})];
  const before=JSON.stringify(rows),first=T.create({items:rows});
  assert.equal(first.resolve(rows[0]).size,first.resolve(rows[1]).size);
  assert.equal(first.resolve(rows[1]).size,first.resolve(rows[2]).size);
  assert.ok(first.bodySize>=10);assert.ok(first.styles.footnote.size<first.bodySize);
  const revised=rows.slice().reverse().map(row=>({...row,result:{status:'translated',text:'Different target length. '.repeat(1000)},block:{...row.block,fontName:'renamed-'+row.id}}));
  const second=T.create({items:revised});assert.equal(second.bodySize,first.bodySize);
  assert.equal(JSON.stringify(rows),before,'typography never writes back into source rows');
});
test('行内首项字号异常不控制正文，标题与表格使用各自统一层级',()=>{
  const rows=[styled('mixed',5,'paragraph',{lines:[{height:10},{height:10},{height:10}]}),styled('body',10),
    styled('title',18,'heading',{headingLevel:1}),styled('section',12,'subheading',{headingLevel:2}),
    styled('cell-a',8,'table',{table:{id:'table-a'}}),styled('cell-b',11,'table',{table:{id:'table-b'}})];
  const typography=T.create({items:rows});assert.equal(typography.bodySize,10);
  assert.ok(typography.resolve(rows[2]).size>=typography.resolve(rows[3]).size);
  assert.ok(typography.resolve(rows[3]).size>typography.bodySize);
  assert.equal(typography.resolve(rows[4]).size,typography.resolve(rows[5]).size);
});
test('缩进需要源行证据，普通基线文字归一而真实附标保持比例',()=>{
  const indented=styled('indent',10,'paragraph',{lines:[{height:10,rect:{x:60,y:50,right:200,bottom:60}},
    {height:10,rect:{x:40,y:65,right:240,bottom:75}}]}),continuation=styled('continuation',10);
  const typography=T.create({items:[indented,continuation]});
  assert.equal(typography.indent(continuation,200),0);assert.ok(typography.indent(indented,200)>0);
  assert.equal(typography.indent(indented,30),0,'narrow region does not lose its remaining line width');
  const normal=typography.inline({text:'normal',height:10.6,shift:0},10,10);
  const superscript=typography.inline({text:'16',height:6,shift:-3},10,10);
  assert.equal(normal.size,10);assert.equal(superscript.size,6);assert.equal(superscript.shift,-3);
});
console.log('PDF reflow model: '+cases+' cases passed');
