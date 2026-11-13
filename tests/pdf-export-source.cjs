/** 源 PDF 导出读取边界与字体规范化回归；不联网。 */
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const window={},env={window,ArrayBuffer,Uint8Array};
vm.runInNewContext(fs.readFileSync('pdf/export-source.js','utf8'),env);
vm.runInNewContext(fs.readFileSync('pdf/export-fonts.js','utf8'),env);
const load=window.BT_PDF_EXPORT_SOURCE.load,error=(code,message)=>Object.assign(new Error(message),{code});
const bytes=new TextEncoder().encode('%PDF-1.7\nmock source');
(async()=>{
  const F=window.BT_PDF_EXPORT_FONTS,raw={status:'translated',text:'A\u200bT\u2060₁\ufe0f Z',inline:[
    {start:2,end:6,runs:[{text:'T\u2060',height:10,shift:0},{text:'₁\ufe0f',height:6,shift:3}]}
  ],machine:{text:'old\u200b result'}},before=JSON.stringify(raw),normalized=F.normalizeResult(raw);
  assert.equal(normalized.text,'AT₁ Z');assert.equal(normalized.machine.text,'old result');
  assert.equal(normalized.inline[0].start,1);assert.equal(normalized.inline[0].end,3);
  assert.equal(normalized.inline[0].runs.map(run=>run.text).join(''),'T₁');
  assert.equal(normalized.inline[0].runs[1].shift,3,'normalization preserves real subscript geometry');
  assert.equal(JSON.stringify(raw),before,'export normalization never edits stored translations');
  assert.equal(F.normalize('∗\u200b'),'∗','visible mathematical symbols must remain unchanged');
  assert.equal(F.normalizeResult({text:'\u200b',inline:[{start:0,end:1,runs:[{text:'\u200b'}]}]}).inline.length,0);
  let called=0;
  const lib={PDFDocument:{async load(data,options){
    called++;assert.ok(data instanceof Uint8Array);assert.equal(options.updateMetadata,false);
    assert.equal(options.ignoreEncryption,undefined,'encryption restrictions must remain intact');
    assert.equal(new TextDecoder().decode(data),'%PDF-1.7\nmock source');return {source:true};
  }}};
  assert.equal((await load({bytes:bytes.buffer,lib,error})).source,true);
  const padded=new Uint8Array(bytes.length+20);padded.set(bytes,10);
  await load({bytes:padded.subarray(10,10+bytes.length),lib,error});
  assert.equal(called,2,'a view must keep its byte offset and length');
  for(const bad of [null,new ArrayBuffer(0),new TextEncoder().encode('<html>login page</html>')])
    await assert.rejects(load({bytes:bad,lib,error}),cause=>cause.code==='EXPORT_SOURCE_BYTES');
  assert.equal(called,2,'empty or non-PDF data cannot reach the parser');
  class EncryptedPDFError extends Error{}
  class PDFObjectParsingError extends Error{}
  const failed=cause=>({EncryptedPDFError,PDFObjectParsingError,PDFDocument:{async load(){throw cause;}}});
  await assert.rejects(load({bytes,lib:failed(new EncryptedPDFError()),error}),cause=>cause.code==='EXPORT_ENCRYPTED');
  await assert.rejects(load({bytes,lib:failed(new PDFObjectParsingError('private document text')),error}),cause=>
    cause.code==='EXPORT_SOURCE_UNSUPPORTED'&&cause.message.includes('PDFObjectParsingError')&&!cause.message.includes('private document text'));
  await assert.rejects(load({bytes,lib:failed(new Error('private source address')),error}),cause=>
    cause.code==='EXPORT_SOURCE_UNSUPPORTED'&&cause.message.includes('PDF_PARSE_FAILED')&&!cause.message.includes('private source address'));
  console.log('PASS PDF export source: bytes, metadata, encryption and safe errors');
})().catch(cause=>{console.error(cause);process.exitCode=1;});
