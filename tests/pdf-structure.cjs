/** 几何驱动结构回归：真实处理器输入文字片段/绘图证据，核对内容、坐标、顺序及保护范围。 */
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const env={window:{}};for(const file of ['errors','reading-structure','block-processor','structured-reader'])vm.runInNewContext(fs.readFileSync('pdf/'+file+'.js','utf8'),env);
const P=env.window.BT_PDF_BLOCKS,S=env.window.BT_PDF_STRUCTURED;
let count=0;
function test(name,fn){fn();count++;console.log('PASS structure: '+name);}
const text=(str,x,y,width=str.length*5,size=10)=>({str,width,height:size,transform:[size,0,0,size,x,800-y-size*.8],fontName:'body',dir:'ltr'});
const page=(items,n=1)=>({pageNumber:n,width:600,height:800,transform:[1,0,0,-1,0,800],styles:{body:{ascent:.8,descent:-.2,fontFamily:'serif'}},items});
const process=(items,probe={})=>P.process(page(items),probe);
const values=model=>Array.from(model.blocks,b=>b.text);
test('同一行与连续段落合并，并保留片段与原始行',()=>{
 const m=process([text('Hello',50,100,25),text('world',78,100,30),text('continued sentence.',50,114,100)]);
 assert.equal(m.blocks.length,1);assert.equal(m.blocks[0].text,'Hello world continued sentence.');assert.equal(m.blocks[0].lines.length,2);assert.match(m.blocks[0].rawText,/\n/);
});
test('英文行尾断词消除，原始行仍保留连字符',()=>{
 const b=process([text('An inter-',50,100,200),text('national agreement.',50,114,200)]).blocks[0];
 assert.equal(b.text,'An international agreement.');assert.match(b.rawText,/inter-\n/);assert.equal(b.segments.map(x=>x.text).join(''),b.text);
});
test('跨栏标题与三栏正文不按 Y 交错',()=>{
 const m=process([text('Wide section title',40,20,500,20),...Array.from({length:3},(_,c)=>[text('Column '+c+' first.',40+c*180,100,140),text('Column '+c+' second.',40+c*180,114,140)]).flat()]);
 assert.equal(m.blocks[0].kind,'heading');assert.deepEqual(values(m).slice(1),[0,1,2].map(c=>'Column '+c+' first. Column '+c+' second.'));
});
test('作者姓名、机构、邮箱分栏；上标不成为独立请求',()=>{
 const m=process([text('Alice Smith',60,100,60),text('*',121,98,3,6),text('Lab Alpha',65,112,55),text('alice@a.org',55,124,75),text('Bob Jones',260,100,60),text('+',321,98,3,6),text('Lab Beta',265,112,55),text('bob@b.org',255,124,75)]);
 assert.equal(m.blocks.filter(b=>b.role==='author').length,2);assert.equal(m.blocks.filter(b=>b.role==='affiliation').length,2);
 assert.equal(m.blocks.filter(b=>b.role==='identifier').length,2);assert.equal(m.blocks.filter(b=>b.eligible).length,0);
 assert.ok(m.blocks.some(b=>b.text.includes('*')));assert.ok(m.blocks.some(b=>b.text.includes('+')));assert.ok(!m.blocks.some(b=>['*','+'].includes(b.text)));
 assert.equal(S.sections(m.blocks.map(block=>({block}))).length,1);
});
test('DOI、URL、引用和数值单位有实际保护片段',()=>{
 const m=process([text('See [12] and 10.1234/abc and https://example.org.',50,100,430),text('10 ms',50,160,40)]);
 const b=m.blocks.find(b=>b.eligible);assert.deepEqual(Array.from(b.segments.filter(s=>s.protected),s=>s.text),['[12]','10.1234/abc','https://example.org.']);assert.equal(m.blocks.at(-1).role,'measurement');
});
test('列表与图注不吞并相邻正文',()=>{
 const m=process([text('- First item',50,100,150),text('- Second item',50,114,150),text('Figure 2: caption',50,150,150),text('Body starts here.',50,164,150)]);
 assert.equal(m.blocks.filter(b=>b.kind==='list').length,2);assert.equal(m.blocks.find(b=>b.isCaption).text,'Figure 2: caption');assert.ok(values(m).includes('Body starts here.'));
});
test('页眉页脚、页码与脚注分类保留原文',()=>{
 const m=process([text('Running title',50,3,160,7),text('Body paragraph.',50,100,250,12),text('A footnote.',50,700,120,8),text('7',300,785,6,8)]);
 assert.equal(m.blocks.find(b=>b.text==='Running title').kind,'header');assert.equal(m.blocks.find(b=>b.text==='7').kind,'footer');assert.equal(m.blocks.find(b=>b.text==='A footnote.').kind,'footnote');
});
function grid(merged=false){const rules=[100,160,220,280].flatMap(y=>y===160&&merged?[{x:160,y,right:400,bottom:y}]:[{x:40,y,right:160,bottom:y},{x:160,y,right:400,bottom:y}]);rules.push({x:160,y:100,right:160,bottom:280});return rules;}
test('分段表线重建行列且表格按行排序',()=>{
 const m=process([text('A1',50,110,30),text('B1',170,110,30),text('A2',50,170,30),text('B2',170,170,30),text('A3',50,230,30),text('B3',170,230,30)],{rules:grid()});
 assert.equal(m.tables.length,1);assert.equal(m.tables[0].rows,3);assert.equal(m.tables[0].columns,2);assert.deepEqual(values(m),['A1','B1','A2','B2','A3','B3']);
});
test('缺少内部边界的矩形区域保留合并单元格',()=>{
 const m=process([text('Merged',50,110,50),text('B1',170,110,30),text('B2',170,170,30),text('A3',50,230,30),text('B3',170,230,30)],{rules:grid(true)});
 assert.equal(m.tables.length,1);assert.ok(m.tables[0].cells.some(c=>c.rowSpan===2));
});
test('图形节点、连线和图注关联，不把节点标题当正文标题',()=>{
 const boxes=[{x:60,y:80,right:160,bottom:110},{x:60,y:135,right:160,bottom:165},{x:60,y:190,right:160,bottom:220}];
 const m=process([text('Input',80,90,40),text('Process',80,145,50),text('Output',80,200,40),text('Figure 1: pipeline',60,235,170)],{vectorRects:boxes,rules:[{x:110,y:110,right:110,bottom:190}]});
 assert.equal(m.visuals.length,1);assert.equal(m.visuals[0].sourceRect.y,80);assert.ok(m.blocks.slice(0,3).every(b=>b.kind==='figure'));
 const nodes=S.sections(m.blocks.map(block=>({block,result:{status:'translated',text:btoa(block.id)}})));
 assert.equal(nodes.length,1);assert.equal(nodes[0].kind,'figure');assert.equal(nodes[0].items.length,4);
});
test('普通图片去重并关联图注；整页扫描不重复插图',()=>{
 const rect={x:60,y:80,right:250,bottom:200};
 const m=process([text('Figure 1: photo',60,215,180),text('Body paragraph.',60,300,240)],{images:[{rect},{rect}]});assert.equal(m.visuals.length,1);assert.ok(m.visuals[0].captionId);
 const full=process([text('Scanned body',60,100,200)],{images:[{rect:{x:0,y:0,right:600,bottom:800}}]});assert.equal(full.visuals.length,0);
});
test('跨页保守记录续接候选，不合并不同页身份',()=>{
 const a=P.process(page([text('The continued inter-',50,760,220)])),b=P.process(page([text('national discussion.',50,20,220)],2));
 assert.equal(a.blocks[0].continuation.toNext,true);assert.equal(b.blocks[0].continuation.fromPrevious,true);assert.notEqual(a.blocks[0].id,b.blocks[0].id);
});
test('OCR 分区、双栏顺序和低置信门禁',()=>{
 const model=P.processOcr({pageNumber:1,width:600,height:800,bitmap:{pixelScale:1,viewportTransform:[1,0,0,1,0,0],pageTransform:[1,0,0,1,0,0]},result:{lines:[
 {text:'Right line one.',confidence:98,bbox:{x0:330,y0:100,x1:530,y1:110},regionIndex:1},
 {text:'Left line two.',confidence:98,bbox:{x0:50,y0:114,x1:240,y1:124},regionIndex:0},
 {text:'Left line one.',confidence:98,bbox:{x0:50,y0:100,x1:240,y1:110},regionIndex:0},
 {text:'Uncertain noise',confidence:30,bbox:{x0:50,y0:200,x1:200,y1:210},regionIndex:0}]}});
 assert.equal(model.blocks[0].text,'Left line one. Left line two.');assert.ok(model.blocks.find(b=>b.text==='Uncertain noise'&&!b.eligible));assert.equal(S.items(model.blocks.map(block=>({block}))).length,2);
});
test('原生受保护邮箱参与 OCR 去重',()=>{
 const block={id:'mail',source:'native',reliable:true,eligible:false,role:'identifier',height:10,direction:'ltr',text:'a@b.com',rect:{x:30,y:30,right:150,bottom:40}};
 const model=P.merge({blocks:[block],tables:[]},{blocks:[{...block,id:'ocr',source:'ocr',confidence:99}]});assert.equal(model.blocks.length,1);assert.equal(model.stats.deduped,1);
});
test('公式、代码和代码标识符保留且不自动送翻',()=>{
 const m=process([text('y = x^2 + 1',50,100,200),text('const answer = 42;',50,150,250),text('snake_case',50,200,100)]);
 assert.deepEqual(Array.from(m.blocks,b=>b.role),['formula','code','identifier']);assert.ok(m.blocks.every(b=>!b.eligible));
});
test('缺少边界证据的复杂表格保留全部文字，不伪造单元格',()=>{
 const m=process([text('A',50,100,15),text('B',200,100,15),text('C',50,150,15),text('D',200,150,15)],{rules:[{x:40,y:90,right:300,bottom:90}]});
 assert.equal(m.tables.length,0);assert.equal(values(m).join('').split('').sort().join(''),'ABCD');
});
test('带图注但没有原生标签的矢量图仍有安全视觉节点',()=>{
 const m=process([text('Figure 3: an outlined chart',50,220,250),text('Body text follows.',50,300,240)],{vectorRects:[{x:50,y:80,right:300,bottom:200}]});
 assert.equal(m.visuals.length,1);assert.ok(m.visuals[0].captionId);assert.equal(m.visuals[0].sourceRect.bottom,200);
});
test('字体映射损坏证据只在当前页同字体传播，不误信合法 Unicode 乱码',()=>{
 const input=page([text('Broken \ue000',50,100,150),text('Accidentally valid Latin',50,150,250),{...text('Healthy other font',50,200,220),fontName:'healthy'}]);
 input.styles.healthy={ascent:.8,descent:-.2,fontFamily:'sans-serif'};
 const m=P.process(input);assert.equal(m.blocks.filter(b=>b.reliable).length,1);assert.equal(m.blocks.find(b=>b.reliable).text,'Healthy other font');
 assert.equal(m.blocks.filter(b=>!b.reliable).length,2);assert.ok(P.planOCR(m,{}).regions.length>0);
});
const monoPage=items=>{const input=page(items);input.styles.body.fontFamily='monospace';return input;};
test('汇编指令、寄存器、标签和缩进作为代码保护，注释按原坐标独立送翻',()=>{
 const m=P.process(monoPage([
  text('mov edx, ebx(748)',50,100,110),text('// load the array',185,100,150),
  text('jne side_exit_1',50,114,110),text('// exit if not an array',185,114,180),
  text('side_exit_1:',50,128,90),text('ret',65,142,25)
 ]));
 const code=m.blocks.filter(b=>b.role==='code'),comments=m.blocks.filter(b=>b.codeRole==='comment');
 assert.equal(code.length,4);assert.ok(code.every(b=>!b.eligible&&b.segments.every(s=>s.protected)));
 assert.equal(comments.length,2);assert.ok(comments.every(b=>b.eligible&&b.rect.x===185));
 assert.ok(comments.every(b=>b.segments.some(s=>s.protected&&s.text.includes('//'))));
 assert.equal(S.sections(m.blocks.map(block=>({block}))).length,1,'code and comments form one region');
 assert.ok(code.find(b=>b.text==='ret').rect.x>code[0].rect.x,'source indentation coordinates are unchanged');
 assert.equal(P.classifyPage(m,{showTextOps:20,totalOps:30}).type,'text');
});
test('同一 textItem 内的代码与注释不猜测边界，整行保留',()=>{
 const b=P.process(monoPage([text('mov eax, ebx // load a value',50,100,300)])).blocks[0];
 assert.equal(b.role,'code');assert.equal(b.eligible,false);assert.equal(b.codeMixed,true);assert.match(b.reason,/无法可靠分离/);
 assert.equal(P.classifyPage({blocks:[b]},{showTextOps:1,totalOps:3}).type,'text','protected code must not trigger full-page OCR');
});
test('代码字符串中的网址和注释符不被拆成可翻译注释',()=>{
 const m=P.process(monoPage([text('const url = "https://example.org/#anchor";',50,100,310),text('const literal = "// not a comment";',50,114,300)]));
 assert.ok(m.blocks.every(b=>b.role==='code'&&!b.eligible));assert.ok(!m.blocks.some(b=>b.codeRole==='comment'));
});
test('普通正文里的指令同名词不会触发代码保护',()=>{
 const m=process([text('Add a new entry to the document.',50,100,280),text('Call the service when ready.',50,150,260)]);
 assert.ok(m.blocks.every(b=>b.role==='text'&&b.eligible));assert.ok(m.blocks.every(b=>b.flow?.type!=='code'));
});
test('AT&T 汇编地址与 Python 字符串中的井号按语法保留',()=>{
 const m=P.process(monoPage([text('movq (%rax,%rdx,8), %rcx',50,100,240),text('def load(value):',50,160,140),text('# keep side_exit_1 unchanged',210,160,230)]));
 assert.equal(m.blocks.find(b=>b.text.startsWith('movq')).role,'code');
 const comment=m.blocks.find(b=>b.codeRole==='comment');assert.ok(comment?.eligible);
 assert.ok(comment.segments.some(s=>s.protected&&s.text==='side_exit_1'));
});
test('制表列拆开的指令及操作数均不送翻',()=>{
 const m=P.process(monoPage([text('mov',50,100,20),text('eax, ebx(8)',110,100,90),text('// copy a value',235,100,120),text('push 0',50,114,60)]));
 assert.ok(m.blocks.filter(b=>b.rect.x<210).every(b=>b.role==='code'&&!b.eligible));
 assert.equal(m.blocks.filter(b=>b.codeRole==='comment'&&b.eligible).length,1);
});
test('非等宽字体的中间代码也保护赋值、索引存储和守卫指令',()=>{
 const m=process([
  text('v0 := ld state[748]',50,100,150),text('// load the array',230,100,140),
  text('st sp[0], v0',50,114,120),text('v1 := i2f(v0)',50,128,130),text('guard v1',50,142,80)
 ]);
 assert.equal(m.blocks.filter(b=>b.role==='code').length,4);
 assert.ok(m.blocks.filter(b=>b.role==='code').every(b=>!b.eligible));
 const comment=m.blocks.find(b=>b.codeRole==='comment');assert.ok(comment?.eligible);
 assert.equal(S.sections(m.blocks.map(block=>({block}))).length,1);
});
test('独立代码注释保留自己的行身份，不串接后续注释',()=>{
 const m=process([text('v0 := ld state[0]',50,100,150),text('// load a value',50,114,150),
  text('st sp[0], v0',50,128,120),text('// save a value',50,142,150),text('guard v0',50,156,80)]);
 const comments=m.blocks.filter(b=>b.codeRole==='comment');assert.equal(comments.length,2);
 assert.notEqual(comments[0].flow.part,comments[1].flow.part);assert.ok(comments.every(b=>b.eligible));
});
const layoutNodes=tree=>tree.kind==='node'?[tree.node]:Array.from(tree.children).flatMap(layoutNodes);
const columnRegions=tree=>tree.kind==='node'?[]:[...(tree.kind==='columns'?[tree]:[]),...tree.children.flatMap(columnRegions)];
test('连续阅读保留跨栏标题并独立重建两栏正文，不重复或丢失节点',()=>{
 const m=process([text('Wide section title',40,20,500,20),...[0,1].flatMap(c=>Array.from({length:4},(_,i)=>text('Column '+c+' line '+i+'.',40+c*250,100+i*14,210)))]);
 const nodes=S.sections(m.blocks.map(block=>({block}))),tree=S.readingLayout(nodes),columns=columnRegions(tree);
 assert.equal(columns.length,1);assert.equal(columns[0].children.length,2);
 assert.equal(layoutNodes(tree)[0],nodes[0]);assert.equal(layoutNodes(tree).length,nodes.length);
 assert.equal(new Set(layoutNodes(tree)).size,nodes.length);
 assert.ok(!layoutNodes(columns[0]).includes(nodes[0]),'wide heading remains outside columns');
});
test('连续阅读不把孤立标签拼成正文栏，缺少坐标时保留原有顺序',()=>{
 const m=process([text('Short left label',40,100,120),text('Short right label',300,100,120)]);
 assert.equal(columnRegions(S.readingLayout(S.sections(m.blocks.map(block=>({block}))))).length,0);
 const nodes=[{kind:'paragraph',items:[{id:'a',block:{height:10}}]},{kind:'paragraph',items:[{id:'b',block:{height:10}}]}];
 assert.deepEqual(layoutNodes(S.readingLayout(nodes)),nodes);
});
test('窄栏距的同字体正文在拼行前分开，不能先合并再尝试分栏',()=>{
 const m=process([0,1,2,3].flatMap(i=>[text('Left paragraph line '+i+'.',40,100+i*14,210),text('Right paragraph line '+i+'.',260,100+i*14,210)]));
 assert.equal(m.blocks.length,2);assert.ok(m.blocks.every(b=>!(b.text.includes('Left')&&b.text.includes('Right'))));
 assert.equal(columnRegions(S.readingLayout(S.sections(m.blocks.map(block=>({block}))))).length,1);
});
test('正文旁的带行号代码整组排序，不将不同栏的同基线文字混合',()=>{
 const code=['1 for (var i = 2; i < 100; ++i) {','2 if (!primes[i])','3 continue;',
  '4 for (var k = i + i; k < 100; k += i)','5 primes[k] = false;','6 }'];
 const input=page(code.flatMap((line,i)=>[text('Regular prose line '+i+'.',40,100+i*12,210),
  {...text(line,260,100+i*12,220,9),fontName:'listing'}]));
 input.styles.listing={ascent:.8,descent:-.2,fontFamily:'monospace'};
 const m=P.process(input),program=m.blocks.filter(b=>b.role==='code');
 assert.equal(program.length,6);assert.ok(program.every(b=>!b.eligible&&!b.text.includes('Regular')));
 assert.equal(new Set(program.map(b=>b.flow?.id)).size,1);
 const nodes=S.sections(m.blocks.map(block=>({block})));assert.equal(nodes.filter(n=>n.kind==='code').length,1);
 assert.equal(columnRegions(S.readingLayout(nodes)).length,1);
 assert.ok(m.blocks.filter(b=>b.eligible).every(b=>!b.text.includes('primes')));
});
test('分开的行号与深层缩进指令归入同一代码清单与源行',()=>{
 const input=page([text('1',260,100,6,9),{...text('for (var i = 0; i < 9; ++i) {',275,100,220,9),fontName:'listing'},
  text('2',260,114,6,9),{...text('continue;',310,114,70,9),fontName:'listing'},
  text('3',260,128,6,9),{...text('}',275,128,6,9),fontName:'listing'}]);
 input.styles.listing={ascent:.8,descent:-.2,fontFamily:'monospace'};
 const m=P.process(input);assert.ok(m.blocks.every(b=>b.role==='code'&&!b.eligible));
 assert.equal(new Set(m.blocks.map(b=>b.flow.id)).size,1);
 for(const y of [100,114,128])assert.equal(new Set(m.blocks.filter(b=>Math.abs(b.rect.y-y)<1).map(b=>b.flow.part)).size,1);
});
test('正文中的单处大空格不产生持续栏间隔证据',()=>{
 const m=process([text('A short',40,100,40),text('gap in one sentence.',90,100,120),text('Normal following sentence.',40,114,180)]);
 assert.equal(m.blocks.length,1);assert.match(m.blocks[0].text,/A short gap in one sentence/);
});
test('拼段前识别同字号编号标题和小标题，不吞并正文，阅读层复用层级',()=>{
 const input=page([{...text('3. Trace Trees',40,100,110),fontName:'f17'},
  text('In this section we describe traces and the trees they form.',40,114,230),text('The following body continues in the same column.',40,128,230),
  {...text('3.1 Traces',40,166,85),fontName:'f17'},text('A trace is a simply typed path through the program.',40,180,230)]);
 input.styles.f17={ascent:.8,descent:-.2,fontFamily:'serif'};
 const m=P.process(input),chapter=m.blocks.find(b=>b.text==='3. Trace Trees'),section=m.blocks.find(b=>b.text==='3.1 Traces');
 assert.equal(chapter.kind,'heading');assert.equal(chapter.headingLevel,1);
 assert.equal(section.kind,'subheading');assert.equal(section.headingLevel,2);
 assert.ok(m.blocks.some(b=>b.text.startsWith('In this section')&&b.lines.length===2));
 for(const item of S.items(m.blocks.map(block=>({block}))))assert.equal(item.kind,item.block.kind);
});
test('行首样式短标题独立，后续正文仍合并为完整段落',()=>{
 const input=page([{...text('Type specialization.',40,100,90),fontName:'f17'},
  text('All primitives are necessarily type specialized.',133,100,210),text('The next line continues the same paragraph.',40,114,230)]);
 input.styles.f17={ascent:.8,descent:-.2,fontFamily:'serif'};
 const m=P.process(input),title=m.blocks.find(b=>b.text==='Type specialization.');
 assert.equal(title.kind,'subheading');assert.equal(title.runIn,true);
 const body=m.blocks.find(b=>b.text.startsWith('All primitives'));
 assert.equal(body.kind,'paragraph');assert.equal(body.lines.length,2);assert.ok(body.runInBody);
});
test('正文中的普通字体到斜体切换不误判为行首标题',()=>{
 const input=page([text('An ordinary sentence.',40,100,100),{...text(' emphasized phrase',143,100,90),fontName:'f18'},
  text('The next ordinary sentence continues the body text.',40,114,230)]);
 input.styles.f18={ascent:.8,descent:-.2,fontFamily:'serif'};
 const m=P.process(input);assert.ok(m.blocks.every(b=>!b.runIn));assert.equal(m.blocks.length,1);
});
test('相邻变量下标属于同一行并作为有基线信息的原子保护',()=>{
 const m=process([text('The trace T',40,100,70),text('16',111,105,6,6),text(' is recorded.',119,100,100)]);
 assert.equal(m.blocks.length,1);const b=m.blocks[0],atom=b.segments.find(s=>s.protected&&s.text==='T16');
 assert.ok(atom);assert.equal(atom.runs.length,2);assert.equal(atom.runs[0].shift,0);assert.ok(atom.runs[1].shift>0);
 assert.equal(b.height,10);assert.equal(b.anchorIndices.length,2);assert.equal(b.segments.map(s=>s.text).join(''),b.text);
 assert.equal(b.runs.map(r=>r.text).join(''),'The trace T16 is recorded.');
});
test('同字号同基线的数字不被误识别为上下标',()=>{
 const m=process([text('In',40,100,10),text('2026',53,100,20),text(' the body continues.',76,100,130)]);
 assert.equal(m.blocks.length,1);assert.ok(!m.blocks[0].segments.some(s=>s.runs?.some(r=>r.shift)));
});
test('重排区域不将窄碎片与正文误分为两栏',()=>{
 const blocks=[{id:'small',order:0,height:6,role:'number',reliable:true,text:'16',rect:{x:40,y:100,right:46,bottom:106}},
  {id:'body',order:1,height:10,role:'text',eligible:true,reliable:true,text:'Body paragraph',rect:{x:65,y:100,right:280,bottom:200}}];
 const tree=S.readingLayout(S.sections(blocks.map(block=>({block}))),{pageLayout:true});
 assert.equal(columnRegions(tree).length,0);assert.equal(layoutNodes(tree).length,2);
});
console.log('PDF structure: '+count+' cases passed');
