(function(global){
  "use strict";
  /** 图片读取只接受无凭据的 HTTP/HTTPS 地址；本地图片仍通过选择或粘贴读取。 */
  function sourceUrl(value){
    const url=new URL(value);
    if(!["http:","https:"].includes(url.protocol)||url.username||url.password)throw Error("请填写 HTTP/HTTPS 图片地址，或选择本地图片");
    url.hash="";return url;
  }
  function isImageUrl(value){try{return /\.(png|jpe?g|webp|bmp|gif)$/i.test(sourceUrl(value).pathname);}catch(_){return false;}}
  // 以文档 MIME 判定无后缀图片，不能把普通网页中的单张插图误当成图片文档。
  function isImageDocument(doc){return /^image\/(png|jpeg|webp|bmp|x-ms-bmp|gif)$/i.test(doc.contentType||"");}
  global.BT_IMAGE_DOCUMENT={sourceUrl,isImageUrl,isImageDocument};
})(typeof self!=="undefined"?self:globalThis);
