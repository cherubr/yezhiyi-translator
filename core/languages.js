(function(global) {
  "use strict";
  // 百度语码映射，由共享语言目录生成，不单独维护第二份列表。
  const baidu=Object.fromEntries(global.BT_CONST.LANGUAGES.from.map(item=>[item.value,item.baidu]));
  /**
   * 转换引擎语码；百度缺少映射时报错，其他引擎保留输入代码。
   * @param {string} engine 引擎标识。
   * @param {string} code 通用语言代码。
   * @returns {string} 可传给对应接口的语码。
   */
  function mapLanguage(engine,code) {
    if(engine==="baidu") {
      if(!baidu[code])throw new Error("百度翻译暂不支持该语言选项："+code);
      return baidu[code];
    }
    return code;
  }
  /**
   * 使用浏览器识别源语言；仅接受可靠且首选语种占比至少 70% 的结果。
   * @param {string} text 本次待识别文字。
   * @returns {Promise<string>} 识别语码，zh 转换为 zh-CN。
   * @throws {Error} 不可靠结果带 NEED_SOURCE_LANGUAGE，提示手动指定，不视为服务故障。
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
