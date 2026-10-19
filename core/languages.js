// 各引擎的语言标识独立转换，覆盖设置页提供的全部语种。
(function(global) {
  "use strict";
  const baidu=Object.fromEntries(global.BT_CONST.LANGUAGES.from.map(item=>[item.value,item.baidu]));
  /**
   * 将通用语言代码转换为指定引擎的代码；百度未配置的语言会明确报错。
   */
  function mapLanguage(engine,code) {
    if(engine==="baidu") {
      if(!baidu[code])throw new Error("百度翻译暂不支持该语言选项："+code);
      return baidu[code];
    }
    return code;
  }
  /**
   * 调用浏览器语言检测，仅接受可靠且占比足够的结果，否则提示用户指定源语言。
   */
  async function detectSourceLanguage(text) {
    if(!chrome.i18n||!chrome.i18n.detectLanguage)throw new Error("此服务需要明确源语言，请在设置中选择源语言");
    const detected=await chrome.i18n.detectLanguage(text),best=detected.languages&&detected.languages[0];
    if(!detected.isReliable||!best||best.language==="und"||best.percentage<70)
      {const error=new Error("部分文字无法识别语言，请为 MyMemory 指定源语言或切换引擎");error.code="NEED_SOURCE_LANGUAGE";throw error;}
    return best.language==="zh"?"zh-CN":best.language;
  }
  global.BT_LANG={mapLanguage,detectSourceLanguage};
})(typeof self!=="undefined"?self:globalThis);
