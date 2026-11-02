/** 两页标准 PDF，用于真实解析、翻页和网络传输测试，不包含外部资源。 */
function pdfFixture(){
 const streams=['q 0.06 0.09 0.14 rg 35 730 300 36 re f Q BT /F1 18 Tf 1 1 1 rg 40 740 Td (Hello PDF first page.) Tj ET BT /F1 18 Tf 40 704 Td (Read the account guide.) Tj ET','BT /F1 18 Tf 40 740 Td (Second PDF page.) Tj ET'];
 const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>',
  '<< /Length '+streams[0].length+' >>\nstream\n'+streams[0]+'\nendstream',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>',
  '<< /Length '+streams[1].length+' >>\nstream\n'+streams[1]+'\nendstream','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
 let pdf='%PDF-1.4\n';const offsets=[0];
 objects.forEach((object,index)=>{offsets.push(Buffer.byteLength(pdf));pdf+=(index+1)+' 0 obj\n'+object+'\nendobj\n';});
 const start=Buffer.byteLength(pdf);pdf+='xref\n0 '+offsets.length+'\n0000000000 65535 f \n';
 for(const offset of offsets.slice(1))pdf+=String(offset).padStart(10,'0')+' 00000 n \n';
 pdf+='trailer\n<< /Size '+offsets.length+' /Root 1 0 R >>\nstartxref\n'+start+'\n%%EOF\n';return Buffer.from(pdf);
}
/** 含标题、作者上标、双栏正文、三列表格及代码的三页排版夹具。 */
function structuredPdfFixture(){
 const text=(value,x,y,size=9,font='F1')=>'BT /'+font+' '+size+' Tf '+x+' '+y+' Td ('+value.replace(/[\\()]/g,'\\$&')+') Tj ET';
 const streams=[[
  text('A Shared Document Title',190,730,20,'F2'),text('Across Two Lines',225,706,20,'F2'),
  text('Alice Alpha',230,665,11),text('*',285,669,7),text(', Bob Beta',289,665,11),text('Example University',250,646,9),text('reader@example.test',245,635,9),
  text('Abstract',40,580,12,'F2'),text('This paragraph begins on the first printed line,',40,564),text('and continues on the next printed line.',40,552),
  text('A new paragraph starts with an indent.',52,540),text('Then it returns to the normal left edge.',40,528),
  text('The right column starts independently here.',320,580),text('Its text must stay out of the left paragraph.',320,568)
 ].join('\n'),[
  ['Feature','Function','Description'],['CPU','Scheduler','Balances all running tasks'],['RAM','Capacity','Supports additional memory']
 ].flatMap((values,row)=>values.map((value,column)=>text(value,[40,180,320][column],720-row*40,10))).join('\n'),[
  text('Example program',40,740,12,'F2'),text('1 for (var i = 0; i < 10; ++i) {',40,710,10,'F3'),text('2   if (ready[i])',40,698,10,'F3'),text('3     continue;',40,686,10,'F3'),text('4 }',40,674,10,'F3')
 ].join('\n')];
 const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R 5 0 R 7 0 R] /Count 3 >>'];
 streams.forEach((stream,index)=>objects.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 9 0 R /F2 10 0 R /F3 11 0 R >> >> /Contents '+(4+index*2)+' 0 R >>','<< /Length '+stream.length+' >>\nstream\n'+stream+'\nendstream'));
 objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>','<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>');
 let pdf='%PDF-1.4\n';const offsets=[0];objects.forEach((object,index)=>{offsets.push(Buffer.byteLength(pdf));pdf+=(index+1)+' 0 obj\n'+object+'\nendobj\n';});
 const start=Buffer.byteLength(pdf);pdf+='xref\n0 '+offsets.length+'\n0000000000 65535 f \n'+offsets.slice(1).map(offset=>String(offset).padStart(10,'0')+' 00000 n \n').join('')+'trailer\n<< /Size '+offsets.length+' /Root 1 0 R >>\nstartxref\n'+start+'\n%%EOF\n';return Buffer.from(pdf);
}
/** 非文字图形、跨越文字区域的连线、彩色背景、位图和保留代码。 */
function diagramPdfFixture(){
 const stream=[
  'BT /F1 18 Tf 40 744 Td (A workflow example) Tj ET',
  'q 0.94 0.96 0.98 rg 80 430 460 240 re f Q',
  'q 0.1 0.2 0.5 RG 2 w 120 590 140 70 re S 340 590 140 70 re S 230 460 140 70 re S Q',
  'q 0.8 0.1 0.1 RG 2 w 260 625 m 340 625 l S 330 630 m 340 625 l 330 620 l S 410 590 m 300 530 l S Q',
  'q 0.2 0.6 0.3 RG 1 w 150 612 m 220 640 l S Q',
  'BT /F1 12 Tf 150 620 Td (Start) Tj ( task) Tj ET',
  'BT /F1 12 Tf 365 620 Td (Process data) Tj ET',
  'BT /F1 12 Tf 250 490 Td (Finish task) Tj ET',
  'BT /F2 10 Tf 80 370 Td (const total = 42;) Tj ET',
  'q 35 0 0 35 490 690 cm /Im1 Do Q',
  // 裁切文字必须原样保留，不能通过删字形破坏后面的填色。
  'q BT /F1 18 Tf 7 Tr 80 300 Td (CLIP) Tj ET 0.2 0.3 0.8 rg 70 280 100 50 re f Q'
 ].join('\n');
 const image='ff000000ff000000ffffffff>';
 const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R /F2 6 0 R >> /XObject << /Im1 7 0 R >> >> /Contents 4 0 R >>',
  '<< /Length '+stream.length+' >>\nstream\n'+stream+'\nendstream','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>','<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>',
  '<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length '+image.length+' >>\nstream\n'+image+'\nendstream'];
 let pdf='%PDF-1.4\n';const offsets=[0];objects.forEach((object,index)=>{offsets.push(Buffer.byteLength(pdf));pdf+=(index+1)+' 0 obj\n'+object+'\nendobj\n';});
 const start=Buffer.byteLength(pdf);pdf+='xref\n0 '+offsets.length+'\n0000000000 65535 f \n'+offsets.slice(1).map(offset=>String(offset).padStart(10,'0')+' 00000 n \n').join('')+'trailer\n<< /Size '+offsets.length+' /Root 1 0 R >>\nstartxref\n'+start+'\n%%EOF\n';return Buffer.from(pdf);
}
module.exports={pdfFixture,structuredPdfFixture,diagramPdfFixture};
