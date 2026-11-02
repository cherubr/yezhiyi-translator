const assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const context={URL};context.self=context;vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(__dirname,'../core/pdf-document.js'),'utf8'),context);
const api=context.BT_PDF_DOCUMENT;
assert.equal(api.isPdfUrl('https://example.org/a.PDF?download=1#page=2'),true);
assert.equal(api.isPdfUrl('https://example.org/page?file=a.pdf'),false);
for(const url of ['file:///private/secret.pdf','javascript:alert(1)','https://user:secret@example.org/a.pdf','chrome://settings'])assert.throws(()=>api.sourceUrl(url));
assert.equal(api.sourceUrl('https://example.org/a.pdf#page=2').href,'https://example.org/a.pdf');
const item=(str,x,y,eol=false)=>({str,transform:[12,0,0,12,x,y],width:str.length*6,height:12,hasEOL:eol});
assert.deepEqual(Array.from(api.paragraphs([item('Hello',10,100),item('world',46,100,true),item('Another paragraph.',10,60,true)])),['Hello world','Another paragraph.']);
assert.deepEqual(Array.from(api.paragraphs([item('Left column.',10,100,true),item('Right column.',300,100,true)])),['Left column.','Right column.']);
assert.equal(api.paragraphs([item('12345',0,0,true)]).length,0);
assert.ok(api.paragraphs([item('a'.repeat(20000),0,0,true)]).every(text=>text.length<=6000));
// 原版式定位必须沿用同一组翻译单元，且不能跨栏遮盖或重复遮盖长字符串分片。
const items=[item('Heading',10,100,true),item('Body first line',10,60,true),item('and second line',10,44,true)];
const blocks=api.blocks(items);
assert.deepEqual(Array.from(blocks,block=>block.text),Array.from(api.paragraphs(items)));
assert.deepEqual(Array.from(blocks[1].indices),[1,2]);
const viewport={transform:[2,0,0,-2,0,400],scale:2,width:600,height:400};
const rect=api.layoutRect(blocks[1],items,{},viewport);
assert.ok(rect.left>=0&&rect.top>=0&&rect.left+rect.width<=1&&rect.top+rect.height<=1);
assert.ok(Math.abs(rect.top-(400-120-19.2-1)/400)<.0001,'按字体上升部和 PDF 基线定位');
const tallFont=api.layoutRect(blocks[0],items,{undefined:{ascent:1.2,descent:-.3}},viewport);
assert.ok(tallFont.top+tallFont.height>(400-200)/400,'字体 ascent 超过 1 时仍覆盖基线下方的降部');
assert.equal(api.blocks([item('Left',10,100),item('Right',300,100,true)]).length,2,'同一基线的两栏也独立');
assert.equal(api.blocks([item('Title',10,100,true),{...item('Small body',10,84,true),height:6}]).length,2,'标题与正文字号不同须分开');
assert.equal(api.layoutRect(api.blocks([item('a'.repeat(20000),0,0,true)])[0],items,{},viewport),null);
assert.equal(api.layoutRect(blocks[0],[{...items[0],transform:[0,12,-12,0,10,100]}],{},viewport),null,'旋转文字不错误遮盖');
assert.equal(api.layoutRect(blocks[0],[{...items[0],dir:'ttb'}],{},viewport),null);
// 同一段中的小上标/商标不能拖小正文，大首字也不能放大整段。
const fontItem=(str,height,x)=>({str,height,width:str.length*height*.5,transform:[height,0,0,height,x,100],hasEOL:false});
const mixedFontItems=[fontItem('Normal paragraph body text',12,10),fontItem('®',4,166),fontItem(' continues at its normal size.',12,170)];
const mixedFontRect=api.layoutRect({indices:[0,1,2],positionable:true},mixedFontItems,{},viewport);
assert.equal(mixedFontRect.fontSize*viewport.width,24,'按字符加权正文主要字号，不取最小上标字号');
assert.equal(api.layoutRect({indices:[0,1],positionable:true},[fontItem('A',36,10),fontItem(' normal paragraph with a decorative initial.',12,40)],{},viewport).fontSize*viewport.width,24,'装饰性大首字不决定整段字号');
assert.equal(api.layoutRect({indices:[0],positionable:true},[fontItem('Small figure label',4,10)],{},viewport).fontSize*viewport.width,8,'本身为小号的图注保留原字号基准');
assert.equal(api.isPdfDocument({contentType:'application/pdf'}),true);
assert.equal(api.isPdfDocument({contentType:'text/html',body:{innerText:'Ordinary article'},querySelector:()=>({})}),false);
// 居中标题的缩进、姓名上标不能变成独立翻译段落。
const text=(str,x,y,height,width,fontName='body')=>({...item(str,x,y,true),height,width,fontName,transform:[height,0,0,height,x,y]});
const structured=[text('A Centered Document Title',100,700,20,400),text('Across Two Lines',220,676,20,160),
 {...text('Alice Alpha',160,640,11,95),hasEOL:false},{...text('∗',255,644,7,4),hasEOL:false},text(', Bob Beta',259,640,11,181),text('Carol Gamma',220,624,11,160),
 text('Example University',240,601,9,120),text('reader@example.test',235,590,9,130),text('Abstract',40,535,11,60),
 text('This paragraph starts with a full first printed line.',40,520,9,240),text('and continues naturally on the next printed line.',40,510,9,240),
 text('Another paragraph begins with an indent.',52,500,9,228),text('and returns to its normal left edge.',40,490,9,240),
 text('Right column remains a separate paragraph.',320,520,9,240)];
const structuredBlocks=api.blocks(structured);
assert.equal(structuredBlocks[0].text,'A Centered Document Title Across Two Lines');assert.equal(structuredBlocks[0].kind,'heading');
assert.match(structuredBlocks[1].text,/Alice Alpha∗, Bob Beta\nCarol Gamma/);assert.equal(structuredBlocks[1].kind,'metadata');assert.equal(structuredBlocks[1].translate,false);
assert.ok(structuredBlocks.some(block=>block.text==='This paragraph starts with a full first printed line. and continues naturally on the next printed line.'));
assert.ok(structuredBlocks.some(block=>block.text==='Another paragraph begins with an indent. and returns to its normal left edge.'));
assert.ok(!structuredBlocks.some(block=>block.text.includes('Right column')&&block.text.includes('This paragraph')),'双栏不交叉合并');
const code=api.blocks([text('1 for (var i = 0; i < 10; i++) {',30,100,10,190,'Courier'),text('2   continue;',30,88,10,90,'Courier'),text('3 }',30,76,10,20,'Courier')]);
assert.equal(code.length,1);assert.equal(code[0].kind,'code');assert.equal(code[0].translate,false);assert.match(code[0].text,/\n2   continue;\n3 }/);
const tableItems=[];
for(const [row,values]of [['Feature','Function','Description'],['CPU','Scheduler','Balances all running tasks'],['RAM','Capacity','Supports additional memory']].entries())for(const [column,value]of values.entries())tableItems.push(text(value,[20,150,280][column],400-row*35,10,value.length*5));
const table=api.blocks(tableItems);assert.equal(table.length,9);assert.ok(table.every(block=>block.table?.columns===3));
assert.equal(table[0].table.header,true);assert.equal(table[8].table.row,2);assert.equal(table[8].table.column,2);
assert.equal(new Set(table.flatMap(block=>Array.from(block.indices))).size,9,'表格每项只归属一个单元格');
const article=[];for(let row=0;row<5;row++){article.push(text('Long left column paragraph with many words.',20,300-row*12,10,240));article.push(text('Long right column paragraph with many words.',300,300-row*12,10,240));}
assert.ok(api.blocks(article).every(block=>!block.table),'普通双栏文章不能识别成表格');
console.log('PASS: PDF 来源校验、文字分段/分栏、原版式定位、特殊文字回退及普通网页内嵌 PDF 边界');
console.log('PASS: 居中标题、姓名上标、作者信息、软换行、段首缩进、代码保护、表格单元格及双栏边界');
(async()=>{
 const {createTextRecorder,matchTextOperations,createTextFilter}=await import('../pdf/layout-renderer.mjs');
 const ops={save:1,restore:2,setFont:3,setFillRGBColor:4,setTextRenderingMode:5,showText:6};
 const glyph={unicode:'Hello',fontChar:'Hello',width:500,isInFont:true,isSpace:false,accent:{fontChar:'x'}};
 const list={fnArray:[3,4,6,5,6],argsArray:[['body',10],['#fff'],[[glyph,30]], [7],[[glyph]]]};
 const recorder=createTextRecorder(ops);list.fnArray.forEach((_,index)=>recorder.filter(index,list));
 assert.equal(recorder.operations.get(2).color,'#fff');assert.equal(recorder.operations.get(4).mode,7,'文字裁切模式必须识别为不安全');
 const filter=createTextFilter(ops,new Set([2])),original=list.argsArray[2];filter.filter(2,list);
 assert.equal(list.argsArray[2][0][0].isInFont,false);assert.equal(list.argsArray[2][0][0].fontChar,'');
 assert.equal(list.argsArray[2][0][0].width,500,'隐藏字形必须保留真实字宽与后续文字推进');assert.equal(list.argsArray[2][0][1],30,'保留 TJ 字距');
 filter.filter(3,list);assert.equal(list.argsArray[2],original,'操作完成后恢复共享绘制参数');filter.filter(2,list);filter.restore();assert.equal(list.argsArray[2],original,'取消或异常后同样恢复参数');
 const options={items:[{str:'Hello',fontName:'body'}],blocks:[{indices:[0],translate:true}],layouts:[{left:.1,top:.1,width:.2,height:.1}],operations:new Map([[2,recorder.operations.get(2)]]),bboxes:{length:5,isEmpty:()=>false,minX:()=>.1,maxX:()=>.3,minY:()=>.1,maxY:()=>.2},fontFor:()=>({})};
 assert.equal(matchTextOperations(options).byBlock.size,1);
 assert.equal(matchTextOperations({...options,fontFor:()=>({isType3Font:true})}).byBlock.size,0,'Type3 不删字形');
 assert.equal(matchTextOperations({...options,operations:new Map([[2,recorder.operations.get(4)]])}).byBlock.size,0,'裁切文字保留原绘制');
 assert.equal(matchTextOperations({...options,items:[{str:'Hello world',fontName:'body'}]}).byBlock.size,0,'部分匹配不得遮掉整段原文');
 assert.equal(matchTextOperations({...options,items:[{str:'Hello',fontName:'other'}]}).byBlock.size,0,'字体或文字流不一致不得替换');
 console.log('PASS: PDF 原字形匹配、裁切/特殊字体/部分匹配保留、字宽推进及共享参数恢复');
})().catch(error=>{console.error(error);process.exitCode=1;});
