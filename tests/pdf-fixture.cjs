/** 两页标准 PDF，用于真实解析、翻页和网络传输测试，不包含外部资源。 */
function pdfFixture(){
 const streams=['BT /F1 18 Tf 40 740 Td (Hello PDF first page.) Tj 0 -36 Td (Read the account guide.) Tj ET','BT /F1 18 Tf 40 740 Td (Second PDF page.) Tj ET'];
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
module.exports={pdfFixture};
