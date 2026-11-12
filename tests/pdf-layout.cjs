const assert=require("node:assert/strict"),fs=require("node:fs"),vm=require("node:vm");
const sandbox={self:{}};vm.runInNewContext(fs.readFileSync("pdf/layout-planner.js","utf8"),sandbox);
const P=sandbox.self.BT_PDF_LAYOUT_PLANNER,measure=(text,size)=>Array.from(text).length*size*.5;
const word="LongUnbrokenIdentifier0123456789".repeat(3),lines=P.wrapText(word,10,60,measure);
assert.equal(lines.join(""),word);assert.ok(lines.length>1);assert.ok(lines.every(line=>measure(line,10)<=60));
const block={id:"a",eligible:true,reliable:true,role:"text",height:12,rect:{x:20,y:20,right:120,bottom:80},lines:[{},{}]};
const row={block,result:{status:"translated",text:word}};
const evidence=new Map([["a",{densitySufficient:true,background:{uniform:true,color:[255,255,255]},hasStrokes:false,inkConfined:true,solidInk:false}]]);
const geometry={width:600,height:800};
const plan=P.plan({rows:[row],geometry,evidence,measure});assert.ok(plan.placements.has("a"));
const placement=plan.placements.get("a");assert.ok(placement.lines.every(line=>measure(line,placement.fontSize)<=placement.textRect.right-placement.textRect.x));
assert.ok(placement.fontSize>=block.height*.75);
const neighbor={block:{...block,id:"b",rect:{x:110,y:20,right:200,bottom:80}},result:null};
assert.ok(P.plan({rows:[row,neighbor],geometry,evidence,measure}).fallbacks.some(item=>item.reason==="overlap"));
const bad=new Map([["a",{...evidence.get("a"),hasStrokes:true}]]);
assert.ok(P.plan({rows:[row],geometry,evidence:bad,measure}).fallbacks.some(item=>item.reason==="strokes"));
for(const [reason,override] of [["indeterminate",{densitySufficient:false}],["background",{background:{uniform:false}}],["graphics",{inkConfined:false}]]){
 const altered=new Map([["a",{...evidence.get("a"),...override}]]),result=P.plan({rows:[row],geometry,evidence:altered,measure});
 assert.equal(result.placements.size,0);assert.equal(result.fallbacks[0].reason,reason);
}
const tooLong={...row,result:{status:"translated",text:"Text too long to fit. ".repeat(2000)}};
assert.equal(P.plan({rows:[tooLong],geometry,evidence,measure}).fallbacks[0].reason,"fit");
assert.equal(P.plan({rows:[row],geometry,evidence,measure,domFailures:new Map([["a",8]])}).fallbacks[0].reason,"dom-overflow");
assert.equal(P.plan({rows:[row],geometry,evidence:new Map(),measure}).pending.length,1);
console.log("PASS PDF layout: unbroken words preserved, bounded fit, readable floor, neighboring text and graphics protection");

// 原框只能容纳一行，译文需要三行；没有真实空白证据仍必须回退。
const short={...block,rect:{x:20,y:20,right:120,bottom:32},lines:[{rect:{x:20,y:20,right:120,bottom:32}}]};
const expandedRow={block:short,result:{status:"translated",text:"A".repeat(40)}},expandedRows=[expandedRow];
const candidate=P.expansionRect({block:short,result:expandedRow.result,geometry,rows:expandedRows,measure});
assert.ok(candidate.bottom>short.rect.bottom);
assert.equal(P.plan({rows:expandedRows,geometry,evidence,measure}).placements.size,0,'free-looking geometry alone is not proof');
const expansionEvidence=new Map([['a',{...evidence.get('a'),expansion:{rect:candidate,blank:true,color:[255,255,255]}}]]);
const expanded=P.plan({rows:expandedRows,geometry,evidence:expansionEvidence,measure}).placements.get('a');
assert.ok(expanded);assert.equal(expanded.fontSize,short.height,'confirmed whitespace preserves the original font size');
assert.ok(expanded.textRect.bottom>expanded.maskRect.bottom,'translation grows without enlarging the source mask');
assert.equal(expanded.lines.join(''),expandedRow.result.text);
const nextRow={block:{...short,id:'next',rect:{x:20,y:50,right:120,bottom:62}},result:null};
const limited=P.plan({rows:[expandedRow,nextRow],geometry,evidence:expansionEvidence,measure});
assert.ok(!limited.placements.has('a')||limited.placements.get('a').textRect.bottom<=48,'even a stale larger proof cannot cross a new neighbor');
const inCell={...short,table:{id:'table'},cell:{rect:{x:10,y:10,right:130,bottom:45}}};
assert.ok(P.expansionRect({block:inCell,result:expandedRow.result,geometry,rows:[{block:inCell}],measure}).bottom<=43);
assert.equal(P.expansionRect({block:{...short,flow:{type:'figure'}},result:expandedRow.result,geometry,rows:[],measure}),null);
const figureArea={...geometry,visuals:[{rect:{x:10,y:48,right:150,bottom:100}}]};
assert.ok(P.expansionRect({block:short,result:expandedRow.result,geometry:figureArea,rows:expandedRows,measure}).bottom<=46);
const wrongProof=new Map([['a',{...evidence.get('a'),expansion:{rect:{...candidate,x:0},blank:true,color:[255,255,255]}}]]);
assert.equal(P.plan({rows:expandedRows,geometry,evidence:wrongProof,measure}).placements.size,0);
// 紧邻但未相交的文字不能因固定边距而全部回退；真实源字形重叠仍拒绝。
const tightA={...short,id:'tight-a'},tightB={...short,id:'tight-b',rect:{x:20,y:33,right:120,bottom:45}};
const tightRows=[tightA,tightB].map(block=>({block,result:{status:'translated',text:'OK'}}));
const tightEvidence=new Map(tightRows.map(row=>[row.block.id,{...evidence.get('a')}]))
const tightPlan=P.plan({rows:tightRows,geometry,evidence:tightEvidence,measure});
assert.equal(tightPlan.placements.size,2,'tight adjacent blocks remain coverable');
assert.ok(tightPlan.placements.get('tight-a').maskRect.bottom<=tightPlan.placements.get('tight-b').maskRect.y);
const genuinelyOverlapping={...tightB,rect:{...tightB.rect,y:31}};
assert.equal(P.plan({rows:[tightRows[0],{block:genuinelyOverlapping,result:null}],geometry,evidence:tightEvidence,measure}).fallbacks[0].reason,'overlap');
const title={...block,kind:'heading',structure:{confidence:'reliable'},height:48,rect:{x:20,y:20,right:400,bottom:100}};
const bodies=Array.from({length:3},(_,i)=>({block:{...short,id:'body'+i,rect:{x:20,y:200+i*50,right:400,bottom:220+i*50}},result:null}));
const titleRow={block:title,result:{status:'translated',text:'Title'}};
assert.ok(P.plan({rows:[titleRow,...bodies],geometry,evidence,measure}).placements.has('a'),'a reliable heading is not rejected just for being larger than body text');
assert.equal(P.plan({rows:[{...titleRow,block:{...title,structure:{confidence:'uncertain'}}},...bodies],geometry,evidence,measure}).placements.size,0);

// 实际像素取证：原文字所在区域相同，只改变下方空间中的单个像素。
sandbox.document={createElement:()=>({getContext:()=>({font:'12px',measureText(text){return {width:measure(text,parseFloat(this.font))};}})})};
vm.runInNewContext(fs.readFileSync('pdf/pixel-evidence.js','utf8'),sandbox);
const EV=sandbox.self.BT_PDF_PIXEL_EVIDENCE;
const sample=foreign=>EV.sample({block:short,result:expandedRow.result,geometry,rows:expandedRows,matrix:[1,0,0,1,0,0],pxPerCss:1,
 canvas:{width:600,height:800,getContext:()=>({getImageData(x,y,w,h){
  const data=new Uint8ClampedArray(w*h*4).fill(255);
  for(let py=0;py<h;py++)for(let px=0;px<w;px++){
   const sx=x+px,sy=y+py;
   if(sx>=24&&sx<=28&&sy>=24&&sy<=28||foreign&&sx===50&&sy===45){const i=(py*w+px)*4;data[i]=data[i+1]=data[i+2]=0;}
  }
  return {data};
 }})}});
assert.equal(sample(false).expansion?.blank,true,'uniform source pixels are real evidence');
assert.equal(sample(true).expansion,undefined,'a foreign pixel below the source text forbids expansion');
const compact={...short,id:'compact',height:10,rect:{x:10,y:20,right:90,bottom:39},lines:[
 {rect:{x:10,y:20,right:90,bottom:30}},{rect:{x:10,y:29,right:90,bottom:39}}
]};
const compactSample=(start,end)=>EV.sample({block:compact,geometry,rows:[{block:compact}],matrix:[1,0,0,1,0,0],pxPerCss:1,
 canvas:{width:600,height:800,getContext:()=>({getImageData(x,y,w,h){
  const data=new Uint8ClampedArray(w*h*4).fill(255);
  for(let py=0;py<h;py++)for(let px=0;px<w;px++)if(x+px===20&&y+py>=start&&y+py<=end){const i=(py*w+px)*4;data[i]=data[i+1]=data[i+2]=0;}
  return {data};
 }})}});
assert.equal(compactSample(25,31).hasStrokes,false,'one glyph touching two padded line bands is not a cross-line rule');
assert.equal(compactSample(22,38).hasStrokes,true,'a true rule crossing two line centers stays protected');
console.log('PASS PDF coverage: verified blank pixels, unchanged masks, readable font, neighbor/cell/figure boundaries and stale-proof rejection');
