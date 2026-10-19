// 各引擎的语言标识独立转换，覆盖设置页提供的全部语种。
(function(global) {
  "use strict";
  const baidu=Object.fromEntries(global.BT_CONST.LANGUAGES.from.map(item=>[item.value,item.baidu]));
  function mapLanguage(engine,code) {
    if(engine==="baidu") {
      if(!baidu[code])throw new Error("百度翻译暂不支持该语言选项："+code);
      return baidu[code];
    }
    return code;
  }
  async function detectSourceLanguage(text) {
    if(!chrome.i18n||!chrome.i18n.detectLanguage)throw new Error("此服务需要明确源语言，请在设置中选择源语言");
    const detected=await chrome.i18n.detectLanguage(text),best=detected.languages&&detected.languages[0];
    if(!detected.isReliable||!best||best.language==="und"||best.percentage<70)
      throw new Error("无法可靠识别源语言，请为 MyMemory 手动选择源语言");
    return best.language==="zh"?"zh-CN":best.language;
  }
  global.BT_LANG={mapLanguage,detectSourceLanguage};
})(typeof self!=="undefined"?self:globalThis);
