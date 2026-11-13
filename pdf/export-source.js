(function(global) {
  "use strict";
  /** 导出只读源文件，不让可选 /Info 元数据阻断页面解析；错误不包含正文或来源地址。 */
  async function load({bytes,lib,error}) {
    let data;
    try{
      data=bytes instanceof ArrayBuffer?new Uint8Array(bytes):ArrayBuffer.isView(bytes)?new Uint8Array(bytes.buffer,bytes.byteOffset,bytes.byteLength):null;
    }catch(_){data=null;}
    if(!data?.byteLength)throw error("EXPORT_SOURCE_BYTES","源文件字节为空或已释放，请重新打开 PDF 后导出");
    let header=false;
    for(let i=0;i+4<Math.min(data.length,1024);i++)if(data[i]===37&&data[i+1]===80&&data[i+2]===68&&data[i+3]===70&&data[i+4]===45){header=true;break;}
    if(!header)throw error("EXPORT_SOURCE_BYTES","导出收到的内容没有 PDF 文件头，请重新选择本地 PDF 后重试");
    try{
      // pdf-lib 默认更新元数据，可能因无效 /Info 引用而使可阅读的文档在 load 阶段失败。
      // 源文档仅供复制页面与裁图，不需要写入生成器或修改日期，也不忽略加密限制。
      return await lib.PDFDocument.load(data,{updateMetadata:false});
    }catch(cause){
      const is=name=>typeof lib[name]==="function"&&cause instanceof lib[name];
      if(is("EncryptedPDFError")||cause?.name==="EncryptedPDFError")
        throw error("EXPORT_ENCRYPTED","加密 PDF 暂不支持自动排版导出；可使用译文编辑器的「导出本页编辑稿」，或另存为未加密文件后重试");
      const category=["MissingPDFHeaderError","PDFObjectParsingError","PDFInvalidObjectParsingError","PDFStreamParsingError","NumberParsingError","StalledParserError","UnexpectedObjectTypeError","MissingCatalogError"]
        .find(is)||"PDF_PARSE_FAILED";
      throw error("EXPORT_SOURCE_UNSUPPORTED","阅读器已能打开文件，但自动导出组件未能解析源 PDF（"+category+"）；这不等于文件损坏。可改用译文编辑器的「导出本页编辑稿」，或另存为标准 PDF 后重试");
    }
  }
  global.BT_PDF_EXPORT_SOURCE={load};
})(typeof window!=="undefined"?window:self);
