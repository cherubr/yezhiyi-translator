(function(global) {
  "use strict";
  /**
   * OCR 语言模型注册表：纯数据声明，与识别算法解耦。
   * bundled=true 表示模型已随扩展打包（pdf/vendor/tesseract/tessdata/）；
   * bundled=false 为按需下载条目（P4-D）：sha256/bytes 从固定 commit 实测钉死，
   * 下载、校验与本地持久化由 ocr-model-store.js 负责，可用性判定不在本注册表。
   * 扩展语言只在此处新增条目，不在 OCR 核心代码中硬编码封闭白名单。
   */
  const ENGINE = "tesseract";
  const ENGINE_VERSION = "7.0.0";
  // 语言模型来源版本：tessdata_fast 固定 commit，升级模型时同步修改并重建 integrity.json。
  const MODEL_SOURCE = "tessdata_fast@87416418657359cb625c412a48b6e1d6d41c29bd";
  // 按需下载与随包模型同源同 commit 直链；.traineddata 为数据文件，不属远程代码。
  const MODEL_BASE_URL = "https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/" +
    MODEL_SOURCE.slice(MODEL_SOURCE.indexOf("@") + 1) + "/";
  const MODELS = [
    {code: "eng", label: "英语", bundled: true},
    {code: "chi_sim", label: "简体中文", bundled: true},
    {code: "chi_tra", label: "繁体中文", bundled: false, sha256: "529c5b5797d64b126065cd55f2bb4c7fd7b15790798091b1ff259941a829330b", bytes: 2366642},
    {code: "jpn", label: "日语", bundled: false, sha256: "1f5de9236d2e85f5fdf4b3c500f2d4926f8d9449f28f5394472d9e8d83b91b4d", bytes: 2471260},
    {code: "kor", label: "韩语", bundled: false, sha256: "6b85e11d9bbf07863b97b3523b1b112844c43e713df8b66418a081fd1060b3b2", bytes: 1677415},
    {code: "fra", label: "法语", bundled: false, sha256: "ced037562e8c80c13122dece28dd477d399af80911a28791a66a63ac1e3445ca", bytes: 1130365},
    {code: "spa", label: "西班牙语", bundled: false, sha256: "6f2e04d02774a18f01bed44b1111f2cd7f3ba7ac9dc4373cd3f898a40ea6b464", bytes: 2294433},
    {code: "deu", label: "德语", bundled: false, sha256: "19d219bbb6672c869d20a9636c6816a81eb9a71796cb93ebe0cb1530e2cdb22d", bytes: 1525436},
    {code: "rus", label: "俄语", bundled: false, sha256: "e16e5e036cce1d9ec2b00063cf8b54472625b9e14d893a169e2b0dedeb4df225", bytes: 3861738},
    {code: "ara", label: "阿拉伯语", bundled: false, sha256: "e3206d3dc87fd50c24a0fb9f01838615911d25168f4e64415244b67d2bb3e729", bytes: 1432056}
  ];
  // 扩展源语言代码（core/constants.js LANGUAGES.from）→ 模型代码；"auto" 无固定映射。
  const LANGUAGE_MAP = {
    "en": "eng", "zh-CN": "chi_sim", "zh-TW": "chi_tra",
    "ja": "jpn", "ko": "kor", "fr": "fra", "es": "spa", "de": "deu", "ru": "rus", "ar": "ara"
  };
  // 源语言为自动检测（或不在映射表）时，扫描页只用随包模型做一次组合识别；
  // 不随已安装模型增长，保证内存与耗时有可预测上限（P4-D 决策）。
  const DEFAULT_LANGUAGES = MODELS.filter(model => model.bundled).map(model => model.code);

  const list = () => MODELS.map(model => ({...model}));
  const has = code => MODELS.some(model => model.code === code && model.bundled);
  const known = code => MODELS.some(model => model.code === code);
  const label = code => MODELS.find(model => model.code === code)?.label || code;
  /** 可下载条目 → 钉死直链与摘要；随包或未注册条目返回 null。 */
  const source = code => {
    const model = MODELS.find(item => item.code === code && !item.bundled && item.sha256);
    return model ? {url: MODEL_BASE_URL + code + ".traineddata", sha256: model.sha256, bytes: model.bytes} : null;
  };
  /**
   * 源语言 → 识别语言集合。auto/未设置回退全部随包模型做一次组合识别；
   * 映射得到注册条目即返回（含按需下载模型，是否已安装由 store/provider 判定）；
   * 不在注册表时报缺（missing），由调用方给出明确提示，不套用错误模型。
   */
  function resolveLanguages(sourceLanguage) {
    if (!sourceLanguage || sourceLanguage === "auto") return {languages: [...DEFAULT_LANGUAGES], missing: []};
    const code = LANGUAGE_MAP[sourceLanguage];
    if (code && known(code)) return {languages: [code], missing: []};
    return {languages: [], missing: [code || sourceLanguage]};
  }
  global.BT_PDF_OCR_MODELS = {ENGINE, ENGINE_VERSION, MODEL_SOURCE, DEFAULT_LANGUAGES, list, has, known, label, source, resolveLanguages};
})(window);
