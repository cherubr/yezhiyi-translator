/** 首次进入时的当前页／范围导出体检，不创建 Worker、不发翻译请求。 */
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const window={},env={window,setTimeout,clearTimeout,AbortController};
for(const file of ['errors','export-fonts','exporter'])vm.runInNewContext(fs.readFileSync('pdf/'+file+'.js','utf8'),env);
(async()=>{
  let page=2,stamp='config-a',prepared=0,read=0,state;
  const statuses=new Map(),document={id:'source',numPages:4};
  const exporter=window.BT_PDF_EXPORTER.create({session:{reloadBytes(){read++;throw new Error('source must not be read during preflight');}},
    getDocument:()=>document,getSnapshot:()=>null,getSnapshots:pages=>pages.map(()=>null),getStamp:()=>stamp,getPage:()=>page,
    getLayout:()=>'structured',getMarkers:()=>null,getName:()=>'source.pdf',
    getPageStatus:pages=>pages.map(page=>({page,state:statuses.get(page)||'missing'})),
    preparePages:async pages=>{prepared++;assert.deepEqual(Array.from(pages),[2]);statuses.set(2,'ready');return {done:[{page:2,state:'ready'}],failed:[],stopped:null};},
    onState:value=>{state=value;}});
  await exporter.exportTranslated();
  assert.equal(state.phase,'incomplete');assert.deepEqual(Array.from(state.need),[2]);assert.equal(state.checkedText,'2');
  assert.equal(prepared,0);assert.equal(read,0,'first export must show explicit choices before translating or reading source bytes');
  await exporter.prepareMissing('2');
  assert.equal(prepared,1);assert.equal(state.need.length,0);assert.match(state.message,/完成 1 页/);
  page=3;statuses.set(3,'partial');
  await exporter.exportTranslated();
  assert.equal(state.phase,'incomplete');assert.equal(state.missing.length,0);assert.deepEqual(Array.from(state.need),[3],'partial-only pages must also expose the prepare action');
  assert.equal(state.checkedText,'3');
  await exporter.prepareMissing('2');
  assert.equal(state.phase,'failed');assert.equal(prepared,1,'a stale current-page selection must not start translation');
  await exporter.exportRange('1-4',false);
  assert.deepEqual(Array.from(state.pages),[1,2,3,4]);assert.deepEqual(Array.from(state.need),[1,3,4]);
  stamp='config-b';await exporter.prepareMissing('1-4');
  assert.equal(state.phase,'failed');assert.equal(prepared,1,'configuration changes must invalidate pending prepare choices');
  assert.equal(read,0);exporter.dispose();
  console.log('PASS PDF export preflight: first entry, partial pages, explicit prepare and stale choices');
})().catch(error=>{console.error(error);process.exitCode=1;});
