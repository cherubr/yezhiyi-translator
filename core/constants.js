// ============================================================
// 共享常量 —— 所有上下文统一使用
// ============================================================
(function (global) {
  "use strict";

  const STORAGE_KEYS = [
    "engine", "aiProvider", "aiKeys", "from", "to", "mode", "concurrency",
    "autoTranslate", "hoverPanel",
    "hoverTranslate", "hoverRequireShift",
    "shortcutTranslate", "shortcutKey",
    "baiduAppId", "baiduKey", "baiduVerification", "requestPolicies", "requestPolicyVersion"
  ];

  const DEFAULTS = {
    engine: "google",
    aiProvider: "openai",
    aiKeys: {},
    from: "auto",
    to: "browser",
    mode: "bilingual",
    concurrency: 4, // 仅保留旧版配置兼容，不再控制网络或页面调度。
    requestPolicies: {},
    requestPolicyVersion: 1,
    autoTranslate: false,
    hoverPanel: true,
    hoverTranslate: true,
    hoverRequireShift: true,
    shortcutTranslate: true,
    shortcutKey: "Alt+A",
    baiduAppId: "",
    baiduKey: "",
    baiduVerification: null
  };

  // 日志配置：仅 development 允许打印；修改后重新加载扩展并刷新网页。
  // 等级从少到多：off → error → warn → info → debug，包含所选级别及更严重的日志。
  // 正式打包会在临时副本中强制改为 production + off，不改变这里的开发配置。
  const LOG_CONFIG = Object.freeze({
    environment: "development",
    level: "debug"
  });
  const LOG_LEVELS = Object.freeze({off:0,error:1,warn:2,info:3,debug:4});
  const logThreshold = LOG_CONFIG.environment === "development"
    ? (LOG_LEVELS[LOG_CONFIG.level] ?? 0) : 0;

  /** 统一检查日志门槛；非法级别/环境默认静默，生产环境不能通过提高级别重新打开。 */
  function isLogEnabled(level) {
    return Object.prototype.hasOwnProperty.call(LOG_LEVELS,level) &&
      LOG_LEVELS[level] > 0 && LOG_LEVELS[level] <= logThreshold;
  }
  /**
   * 只转发允许级别的主动日志，不替换全局 console，也不影响网页或浏览器自身日志。
   * 调用方必须先去除原文、译文、凭据和完整请求对象；日志系统不自动脱敏任意对象。
   * 控制台缺失/打印失败不应改变翻译流程，生产环境在访问控制台前直接返回。
   */
  function writeLog(level,args) {
    if(!isLogEnabled(level))return;
    try {
      const target=global.console || (typeof console!=="undefined"?console:null);
      const output=target?.[level];
      if(typeof output==="function")output.apply(target,args);
    } catch (_) {}
  }
  const BT_LOG = Object.freeze({
    isEnabled:isLogEnabled,
    error:(...args)=>writeLog("error",args),
    warn:(...args)=>writeLog("warn",args),
    info:(...args)=>writeLog("info",args),
    debug:(...args)=>writeLog("debug",args)
  });

  const ENGINES = ["google", "baidu", "ai", "mymemory"];

  const MSG = {
    TRANSLATE: "TRANSLATE",
    TEST_BAIDU_CONNECTION: "TEST_BAIDU_CONNECTION",
    CANCEL_TRANSLATION_REQUESTS: "CANCEL_TRANSLATION_REQUESTS",
    START_TRANSLATION: "START_TRANSLATION",
    CANCEL_TRANSLATION: "CANCEL_TRANSLATION",
    TOGGLE_PANEL: "TOGGLE_PANEL",
    OPEN_PANEL: "OPEN_PANEL",
    OPEN_SETTINGS: "OPEN_SETTINGS",
    TRANSLATE_SELECTION: "TRANSLATE_SELECTION",
    GET_STATUS: "GET_STATUS",
    RELOAD_CONFIG: "RELOAD_CONFIG",
    SET_PAGE_STATE: "SET_PAGE_STATE",
    TRANSLATION_REQUEST_STATE: "TRANSLATION_REQUEST_STATE",
    TRANSLATION_DIAGNOSTIC: "TRANSLATION_DIAGNOSTIC"
  };

  // 语言名称、通用代码和百度代码只维护这一份，设置页与面板共同使用。
  const LANGUAGE_OPTIONS = [
    {"value": "zh-CN", "label": "简体中文", "baidu": "zh"},
    {"value": "zh-TW", "label": "繁体中文", "baidu": "cht"},
    {"value": "en", "label": "英语", "baidu": "en"},
    {"value": "ja", "label": "日语", "baidu": "jp"},
    {"value": "ko", "label": "韩语", "baidu": "kor"},
    {"value": "fr", "label": "法语", "baidu": "fra"},
    {"value": "de", "label": "德语", "baidu": "de"},
    {"value": "es", "label": "西班牙语", "baidu": "spa"},
    {"value": "ru", "label": "俄语", "baidu": "ru"},
    {"value": "it", "label": "意大利语", "baidu": "it"},
    {"value": "pt", "label": "葡萄牙语", "baidu": "pt"},
    {"value": "ar", "label": "阿拉伯语", "baidu": "ara"},
    {"value": "th", "label": "泰语", "baidu": "th"},
    {"value": "vi", "label": "越南语", "baidu": "vie"},
    {"value": "id", "label": "印度尼西亚语", "baidu": "id"},
    {"value": "tr", "label": "土耳其语", "baidu": "tr"},
    {"value": "nl", "label": "荷兰语", "baidu": "nl"},
    {"value": "pl", "label": "波兰语", "baidu": "pl"},
    {"value": "sv", "label": "瑞典语", "baidu": "swe"},
    {"value": "da", "label": "丹麦语", "baidu": "dan"},
    {"value": "fi", "label": "芬兰语", "baidu": "fin"},
    {"value": "el", "label": "希腊语", "baidu": "el"},
    {"value": "cs", "label": "捷克语", "baidu": "cs"},
    {"value": "hu", "label": "匈牙利语", "baidu": "hu"},
    {"value": "ro", "label": "罗马尼亚语", "baidu": "rom"},
    {"value": "uk", "label": "乌克兰语", "baidu": "ukr"},
    {"value": "hi", "label": "印地语", "baidu": "hi"},
    {"value": "sl", "label": "斯洛文尼亚语", "baidu": "slo"},
    {"value": "ms", "label": "马来语", "baidu": "may"},
    {"value": "bn", "label": "孟加拉语", "baidu": "ben"},
    {"value": "ur", "label": "乌尔都语", "baidu": "urd"},
    {"value": "ta", "label": "泰米尔语", "baidu": "tam"},
    {"value": "te", "label": "泰卢固语", "baidu": "tel"},
    {"value": "ne", "label": "尼泊尔语", "baidu": "nep"},
    {"value": "fa", "label": "波斯语", "baidu": "per"},
    {"value": "he", "label": "希伯来语", "baidu": "heb"},
    {"value": "no", "label": "挪威语", "baidu": "nor"},
    {"value": "is", "label": "冰岛语", "baidu": "ice"},
    {"value": "bg", "label": "保加利亚语", "baidu": "bul"},
    {"value": "hr", "label": "克罗地亚语", "baidu": "hrv"},
    {"value": "sk", "label": "斯洛伐克语", "baidu": "sk"},
    {"value": "et", "label": "爱沙尼亚语", "baidu": "est"},
    {"value": "lv", "label": "拉脱维亚语", "baidu": "lav"},
    {"value": "lt", "label": "立陶宛语", "baidu": "lit"},
    {"value": "sr", "label": "塞尔维亚语", "baidu": "srp"},
    {"value": "af", "label": "南非荷兰语", "baidu": "afr"},
    {"value": "sw", "label": "斯瓦希里语", "baidu": "swa"},
    {"value": "my", "label": "缅甸语", "baidu": "bur"}
  ];
  const LANGUAGES = {
    from: [{value:"auto",label:"自动检测",baidu:"auto"},...LANGUAGE_OPTIONS],
    to: [{value:"browser",label:"跟随浏览器"},...LANGUAGE_OPTIONS]
  };

  // 使用浏览器界面语言；地区变体归并到接口支持的语言代码。
  /**
   * 把跟随浏览器选项解析为受支持的目标语言；保留手动选择，未知浏览器语言回退为英语。
   *
   * @param {string} value 手动语言代码或 browser。
   * @returns {string} 可交给翻译引擎的通用语言代码。
   */
  function resolveTargetLanguage(value) {
    if (value && value !== "browser") return value;
    let locale = "";
    try { locale = global.chrome?.i18n?.getUILanguage?.() || ""; } catch (_) {}
    locale = (locale || global.navigator?.language || "zh-CN").replace(/_/g,"-").toLowerCase();
    if (locale === "zh" || locale.startsWith("zh-")) {
      return /(?:tw|hk|mo|hant)/.test(locale) ? "zh-TW" : "zh-CN";
    }
    const base = locale.split("-")[0];
    const aliases = {nb:"no",nn:"no",iw:"he",in:"id"};
    const code = aliases[base] || base;
    return LANGUAGE_OPTIONS.some(item=>item.value===code) ? code : "en";
  }

  /**
   * 使用共享语言目录生成下拉选项，显示浏览器实际语言并保留已有的目录外配置。
   *
   * @param {HTMLSelectElement} select 要填充的下拉控件。
   * @param {string} direction from 表示源语言，to 表示目标语言。
   * @param {string} value 当前保存的选项值。
   */
  function fillLanguageSelect(select, direction, value) {
    if (!select) return;
    const options = LANGUAGES[direction] || [];
    const current = typeof value === "string" && value ? value : (direction === "from" ? "auto" : "browser");
    const nodes = options.map(item => {
      const node = select.ownerDocument.createElement("option");
      node.value = item.value;node.textContent = item.value === "browser" ? "跟随浏览器（" + (LANGUAGE_OPTIONS.find(x=>x.value===resolveTargetLanguage("browser"))?.label || "英语") + "）" : item.label;
      return node;
    });
    // 保留已有的非目录配置，不因升级悄悄切换用户的语言。
    if (!options.some(item => item.value === current)) {
      const node = select.ownerDocument.createElement("option");
      node.value = current;node.textContent = "未列出语言（" + current + "）";nodes.push(node);
    }
    select.replaceChildren(...nodes);select.value = current;
  }

  const SHORTCUT_KEYS = [
    "Alt+A", "Alt+W", "Alt+Q", "Alt+E", "Alt+S",
    "Ctrl+Shift+A", "Ctrl+Shift+Z"
  ];

  /** 生成凭据一致性指纹，仅用于匹配测试记录，不作为安全认证或密钥加密。 */
  function getBaiduCredentialFingerprint(config = {}) {
    const appId = typeof config.baiduAppId === "string" ? config.baiduAppId.trim() : "";
    const key = typeof config.baiduKey === "string" ? config.baiduKey.trim() : "";
    if (!appId || !key || typeof global.md5 !== "function") return "";
    return global.md5(JSON.stringify([appId, key]));
  }

  /** 只有当前这一份 AppID 和密钥通过连接测试，百度才可供选择。 */
  function hasVerifiedBaiduCredentials(config = {}) {
    const fingerprint = getBaiduCredentialFingerprint(config);
    return !!fingerprint && config.baiduVerification?.fingerprint === fingerprint;
  }

  const BT_CONST = { LOG_CONFIG, STORAGE_KEYS, DEFAULTS, ENGINES, MSG, LANGUAGES, SHORTCUT_KEYS, fillLanguageSelect, resolveTargetLanguage, getBaiduCredentialFingerprint, hasVerifiedBaiduCredentials };

  // 服务配置包含密钥，只保存在本机；语言和显示模式等普通偏好仍使用同步存储。
  const LOCAL_KEYS = ["aiKeys", "baiduAppId", "baiduKey", "baiduVerification", "requestPolicies", "requestPolicyVersion"];
  const LEGACY_KEYS = ["openaiKey", "openaiBase", "openaiModel"];
  let migration;
  // 同一上下文共享迁移任务；失败后允许重试，避免重复初始化时重复搬运数据。
  /**
   * 将同步区旧密钥迁入本机；本机数据优先，写入成功后才删除同步区旧字段，失败可重试。
   */
  function migrateCredentials() {
    if (migration) return migration;
    migration = (async () => {
      const synced = await chrome.storage.sync.get([...LOCAL_KEYS, ...LEGACY_KEYS, "aiProvider"]);
      const local = await chrome.storage.local.get(LOCAL_KEYS);
      const moved = {};
      // 本机配置优先，包括用户主动清空的密钥，避免旧同步数据覆盖本机修改。
      const providers = { ...(synced.aiKeys || {}), ...(local.aiKeys || {}) };
      if (synced.openaiKey) {
        const pid = synced.aiProvider || "openai";
        if (!Object.prototype.hasOwnProperty.call(providers, pid)) providers[pid] = {
          key: synced.openaiKey, base: synced.openaiBase || "", model: synced.openaiModel || ""
        };
      }
      if (synced.aiKeys || synced.openaiKey) moved.aiKeys = providers;
      if (synced.requestPolicies) moved.requestPolicies = { ...synced.requestPolicies, ...(local.requestPolicies || {}) };
      if (synced.requestPolicyVersion && !local.requestPolicyVersion) moved.requestPolicyVersion = synced.requestPolicyVersion;
      for (const key of ["baiduAppId", "baiduKey"]) {
        if (Object.prototype.hasOwnProperty.call(synced, key) && !Object.prototype.hasOwnProperty.call(local, key)) moved[key] = synced[key];
      }
      // 必须先成功写入本机，再删除同步区旧字段；写入失败时保留原数据。
      if (Object.keys(moved).length) await chrome.storage.local.set(moved);
      await chrome.storage.sync.remove([...LOCAL_KEYS, ...LEGACY_KEYS]);
    })().catch(error => { migration = null; throw error; });
    return migration;
  }
  const BT_STORAGE = {
    migrateCredentials,
    /** 先完成旧密钥迁移，再按 keys 读取并合并同步偏好与本机凭据。 */
    async get(keys = STORAGE_KEYS) {
      // 调用方无需关心存储位置，迁移后合并两类配置返回。
      await migrateCredentials();
      const [synced, local] = await Promise.all([
        chrome.storage.sync.get(keys.filter(key => !LOCAL_KEYS.includes(key))),
        chrome.storage.local.get(keys.filter(key => LOCAL_KEYS.includes(key)))
      ]);
      return { ...synced, ...local };
    },
    /** 按字段分流写入配置；不保证跨存储区事务，任一写入失败会向调用方抛出异常。 */
    async set(config) {
      // 按字段分流写入，防止设置页保存完整配置时把密钥重新写回同步区。
      await migrateCredentials();
      const synced = {}, local = {};
      for (const [key, value] of Object.entries(config)) {
        // 验证记录只由后台实际测试写入，普通表单保存不能覆盖它。
        if (LEGACY_KEYS.includes(key) || key === "baiduVerification") continue;
        (LOCAL_KEYS.includes(key) ? local : synced)[key] = value;
      }
      if (Object.prototype.hasOwnProperty.call(local, "baiduAppId") ||
          Object.prototype.hasOwnProperty.call(local, "baiduKey")) {
        const previous = await chrome.storage.local.get(["baiduAppId", "baiduKey"]);
        const changed = ["baiduAppId", "baiduKey"].some(key =>
          Object.prototype.hasOwnProperty.call(local, key) && local[key] !== previous[key]);
        // 与新凭据在同一笔本机写入中清除旧验证，避免沿用上一份密钥的测试结果。
        if (changed) local.baiduVerification = null;
      }
      if (Object.keys(local).length) await chrome.storage.local.set(local);
      if (Object.keys(synced).length) await chrome.storage.sync.set(synced);
    }
  };

  if (typeof self !== "undefined") self.BT_LOG = BT_LOG;
  if (typeof window !== "undefined") window.BT_LOG = BT_LOG;
  if (typeof self !== "undefined") self.BT_CONST = BT_CONST;
  if (typeof window !== "undefined") window.BT_CONST = BT_CONST;
  if (typeof self !== "undefined") self.BT_STORAGE = BT_STORAGE;
  if (typeof window !== "undefined") window.BT_STORAGE = BT_STORAGE;
})(typeof self !== "undefined" ? self : this);
