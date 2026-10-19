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
    "baiduAppId", "baiduKey"
  ];

  const DEFAULTS = {
    engine: "google",
    aiProvider: "openai",
    aiKeys: {},
    from: "auto",
    to: "zh-CN",
    mode: "bilingual",
    concurrency: 4,
    autoTranslate: false,
    hoverPanel: true,
    hoverTranslate: true,
    hoverRequireShift: true,
    shortcutTranslate: true,
    shortcutKey: "Alt+A",
    baiduAppId: "",
    baiduKey: ""
  };

  const ENGINES = ["google", "baidu", "ai", "mymemory"];

  const MSG = {
    TRANSLATE: "TRANSLATE",
    START_TRANSLATION: "START_TRANSLATION",
    CANCEL_TRANSLATION: "CANCEL_TRANSLATION",
    TOGGLE_PANEL: "TOGGLE_PANEL",
    OPEN_PANEL: "OPEN_PANEL",
    OPEN_SETTINGS: "OPEN_SETTINGS",
    TRANSLATE_SELECTION: "TRANSLATE_SELECTION",
    GET_STATUS: "GET_STATUS",
    RELOAD_CONFIG: "RELOAD_CONFIG"
  };

  const LANGUAGES = {
    from: [
      { value: "auto", label: "自动检测" },
      { value: "zh-CN", label: "简体中文" },
      { value: "zh-TW", label: "繁体中文" },
      { value: "en", label: "英语" },
      { value: "ja", label: "日语" },
      { value: "ko", label: "韩语" },
      { value: "fr", label: "法语" },
      { value: "de", label: "德语" },
      { value: "es", label: "西班牙语" },
      { value: "ru", label: "俄语" }
    ],
    to: [
      { value: "zh-CN", label: "简体中文" },
      { value: "zh-TW", label: "繁体中文" },
      { value: "en", label: "英语" },
      { value: "ja", label: "日语" },
      { value: "ko", label: "韩语" }
    ]
  };

  const SHORTCUT_KEYS = [
    "Alt+A", "Alt+W", "Alt+Q", "Alt+E", "Alt+S",
    "Ctrl+Shift+A", "Ctrl+Shift+Z"
  ];

  const BT_CONST = { STORAGE_KEYS, DEFAULTS, ENGINES, MSG, LANGUAGES, SHORTCUT_KEYS };

  // 服务配置包含密钥，只保存在本机；语言和显示模式等普通偏好仍使用同步存储。
  const LOCAL_KEYS = ["aiKeys", "baiduAppId", "baiduKey"];
  const LEGACY_KEYS = ["openaiKey", "openaiBase", "openaiModel"];
  let migration;
  // 同一上下文共享迁移任务；失败后允许重试，避免重复初始化时重复搬运数据。
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
    async get(keys = STORAGE_KEYS) {
      // 调用方无需关心存储位置，迁移后合并两类配置返回。
      await migrateCredentials();
      const [synced, local] = await Promise.all([
        chrome.storage.sync.get(keys.filter(key => !LOCAL_KEYS.includes(key))),
        chrome.storage.local.get(keys.filter(key => LOCAL_KEYS.includes(key)))
      ]);
      return { ...synced, ...local };
    },
    async set(config) {
      // 按字段分流写入，防止设置页保存完整配置时把密钥重新写回同步区。
      await migrateCredentials();
      const synced = {}, local = {};
      for (const [key, value] of Object.entries(config)) {
        if (LEGACY_KEYS.includes(key)) continue;
        (LOCAL_KEYS.includes(key) ? local : synced)[key] = value;
      }
      if (Object.keys(local).length) await chrome.storage.local.set(local);
      if (Object.keys(synced).length) await chrome.storage.sync.set(synced);
    }
  };

  if (typeof self !== "undefined") self.BT_CONST = BT_CONST;
  if (typeof window !== "undefined") window.BT_CONST = BT_CONST;
  if (typeof self !== "undefined") self.BT_STORAGE = BT_STORAGE;
  if (typeof window !== "undefined") window.BT_STORAGE = BT_STORAGE;
})(typeof self !== "undefined" ? self : this);
