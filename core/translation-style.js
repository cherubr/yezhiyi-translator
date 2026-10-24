(function(global){
  "use strict";
  // 共享外观默认值：字号为百分比，行高 0 表示继承，段落间距单位为 em。
  const DEFAULTS=Object.freeze({fontFamily:"inherit",fontSize:100,color:"inherit",fontWeight:"inherit",lineHeight:0,paragraphSpacing:0.4});
  // 仅使用预设的本机字体族，不接受任意 CSS 或远程字体地址。
  const FONTS=Object.freeze({
    inherit:"inherit",system:'system-ui, -apple-system, "Segoe UI", sans-serif',
    sans:'"Microsoft YaHei", "PingFang SC", sans-serif',
    serif:'"Songti SC", SimSun, serif',monospace:'ui-monospace, Consolas, monospace'
  });
  /**
   * 把不可信存储值收敛到字体/颜色白名单及数值范围，返回新的安全配置。
   * @param {*} value 待校验的外观设置。
   * @returns {Object} 可用于预览和网页译文的统一样式配置。
   */
  function normalize(value){
    const v=value&&typeof value==="object"&&!Array.isArray(value)?value:{};
    const number=(key,min,max)=>typeof v[key]==="number"&&Number.isFinite(v[key])
      ?Math.max(min,Math.min(max,v[key])):DEFAULTS[key];
    return {
      fontFamily:Object.hasOwn(FONTS,v.fontFamily)?v.fontFamily:DEFAULTS.fontFamily,
      fontSize:number("fontSize",80,200),
      color:typeof v.color==="string"&&/^#[0-9a-f]{6}$/i.test(v.color)?v.color.toLowerCase():"inherit",
      fontWeight:["inherit","normal","bold"].includes(v.fontWeight)?v.fontWeight:"inherit",
      lineHeight:v.lineHeight===0||v.lineHeight===undefined?0:number("lineHeight",1.2,2.4),
      paragraphSpacing:number("paragraphSpacing",0,1.2)
    };
  }
  /**
   * 将安全配置映射为译文节点上的局部 CSS 变量，预览和实际译文共用。
   * 紧凑控件的行高和间距由 CSS 保持；此操作不重新翻译。
   * @param {Element} element 译文节点或设置页预览节点。
   * @param {*} value 待校验的样式设置。
   * @returns {Object} 实际应用的安全配置。
   */
  function apply(element,value){
    const v=normalize(value);
    const vars={
      "--bt-translation-font":FONTS[v.fontFamily],"--bt-translation-scale":String(v.fontSize/100),
      "--bt-translation-color":v.color,"--bt-translation-weight":v.fontWeight,
      "--bt-translation-line-height":v.lineHeight?String(v.lineHeight):"inherit",
      "--bt-translation-top-gap":v.paragraphSpacing+"em",
      "--bt-translation-bottom-gap":Number((v.paragraphSpacing*1.5).toFixed(3))+"em"
    };
    for(const [key,val]of Object.entries(vars))element.style.setProperty(key,val);
    return v;
  }
  global.BT_TRANSLATION_STYLE=Object.freeze({DEFAULTS,FONTS,normalize,apply});
})(typeof self!=="undefined"?self:globalThis);
