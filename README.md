# 页知译 · 网页双语翻译

Chrome Manifest V3 扩展，支持网页双语阅读、开放式 Shadow DOM、iframe 与技术术语表。

[功能与使用](#功能与使用) · [本地开发](#本地开发) · [发布流程](#发布流程) · [变更记录](CHANGELOG.md) · [隐私说明](docs/privacy.html)

当前代码版本为 **1.0.2**，以 [manifest.json](manifest.json) 为准。1.0.2 尚未发布；商店已安装版本与本仓库开发版本可能不同。

旧 PDF 翻译和图片文字识别模块已移除；新的 PDF 模块尚未重建，当前版本暂不提供这两项功能。

## 功能与使用

### 网页翻译

- 支持 Google、MyMemory、百度和 OpenAI 兼容 AI 接口，也可连接本机 Ollama 或自定义接口。
- 支持双语对照、仅译文、选中文字翻译，以及鼠标所在段落的 Shift 翻译与还原。
- 当前页开始翻译后，会随滚动和动态内容更新继续补翻；取消后恢复原文并暂停本页补翻。
- 支持开放式 Shadow DOM 和 Chrome 允许访问的 iframe；子框架随主页面开始或取消，不重复显示控制面板。
- 可调整译文字体、字号、颜色、字重、行高与间距，设置页提供实时预览。
- 提供 48 种语言选项，默认自动检测源语言，目标语言跟随浏览器。

新安装默认关闭自动翻译。点击悬浮球开始或取消整页翻译；默认快捷键为 Windows/Linux `Ctrl+Shift+Y`、macOS `Command+Shift+Y`。单段翻译默认要求把鼠标停在文字上按 Shift；设置中可调整悬停行为。

关闭“自动翻译”只影响新页面自动启动；已经开始翻译的页面需要点击取消才能停止补翻。取消后仍可主动使用 Shift 翻译单段。浏览器后退、前进恢复页面时保留已有译文和暂停状态；配置变化后按新配置处理。

### 技术术语表

在设置页添加原词和固定译法；译法留空则保留原词。内置规则保留 Linux、RHCE、OpenShift 等名称，统一网页翻译中的术语。

自定义规则支持指定语言、大小写控制和 JSON 导入导出，最多 500 条，仅保存于本机。自定义规则优先于内置规则，长词和具体语言规则优先。导入后需点击保存；保存后已启动的网页会清理旧译文并补翻。

## 安装与配置

1. 下载或克隆仓库，在 `chrome://extensions` 开启开发者模式。
2. 选择“加载已解压的扩展程序”，加载包含 `manifest.json` 的项目根目录。
3. 打开扩展设置，选择翻译服务。百度需配置凭据并通过连接测试；多数 AI 服务需配置自己的接口、密钥和模型，自定义来源需主动授权。
4. 使用自己的账号时，费用、额度和网络可用性由服务方决定。“已配置”不代表真实连接可用。

修改运行文件后，需要重新加载扩展并刷新网页。加载源码无需构建；运行开发工具和测试需要 Node.js。

## 隐私与权限

网页文字直接发送给所选翻译服务。API 凭据、术语表和请求策略仅存本机，普通偏好可经 Chrome 同步。

扩展通过网站访问权限读取允许访问的页面，使用 `webNavigation` 核验前进/后退恢复和 iframe 活动文档，不保存或上传浏览历史。

完整说明见 [隐私与数据说明](docs/privacy.html)。隐私正文仅维护此网页，由 GitHub Pages 对外提供。

## 本地开发

项目使用原生 JavaScript、HTML 和 CSS，无框架及构建步骤。开发环境使用 **Node.js 22**，开发依赖按锁文件安装（Playwright 用于浏览器测试，adm-zip 用于跨平台打包，均不进入扩展包）：

```sh
npm ci
npx playwright install chromium
```

| 命令 | 用途与影响 |
| --- | --- |
| `npm run check` | 检查 JS 语法、Manifest 引用及 Manifest/package 版本一致性；不代替功能测试 |
| `npm test` | 运行存储、权限、调度、采集、术语表、页面会话和打包等逻辑测试 |
| `npm run test:browser` | 运行 Chromium 网页、扩展、Shadow DOM、iframe 与导航集成测试 |
| `npm run package` | Windows/macOS/Linux 使用 Node.js 生成并校验发布 ZIP，拒绝覆盖同名旧包 |
| `npm run test:package` | 在独立临时项目测试跨平台 ZIP、文件过滤、完整性及失败清理，不生成正式项目包 |
| `npm run store:assets` | 生成全部 6 个设置导航页、4 个服务详情页截图及两张宣传图；长页另存完整预览，同时重写 `assets/icon*.png`，仅在图片相关任务使用 |

测试使用独立浏览器资料和本地模拟翻译服务；不能替代真实 Chrome、第三方站点和真实账号验收。打包测试只使用系统临时目录中的小型夹具；CI 为 Windows、macOS、Linux 配置同一项打包回归，普通分支检查不会上传商店。

本次移除旧 PDF/OCR 模块后，按用户要求跳过测试和检查，当前代码尚未重新验收；此前通过记录不代表本次改动已通过。

开发日志由 `core/constants.js` 的 `LOG_CONFIG` 控制，支持 `off/error/warn/info/debug`。日志禁止包含原文、译文、密钥和完整请求；发布脚本在临时副本中强制关闭日志，不改开发源码。

### 目录

| 目录 | 职责 |
| --- | --- |
| `background/` | 后台消息、页面会话、权限校验与翻译服务调用 |
| `content/` | 网页采集、译文展示、Shift、悬浮球与控制面板 |
| `core/` | 共享配置、存储、语言、术语表与请求调度 |
| `settings/` | 扩展设置页 |
| `assets/` | 运行图标与图标源文件 |
| `tests/`、`scripts/` | 测试及开发、发布工具，随代码提交 |
| `.github/workflows/` | 自动检查与商店草稿上传流程 |
| `docs/` | 公开隐私网页，保留既有访问路径 |

`.local/`、`dist/`、依赖和个人编辑器配置由 `.gitignore` 排除，不进入 Git 或扩展包。`.local/` 不是项目依赖；图片脚本按需创建 `.local/chrome-web-store/images/`，不会自动清理旧目录。

`npm run store:assets` 使用独立 Chromium 资料，等待控件渲染完成后逐一点击导航及服务卡片。页面保持默认状态，不展开收起的说明、不填写凭据、不测试连接或启用服务，并阻断外部网页请求。同名图片会被重写：

```text
.local/chrome-web-store/images/
├── small-marquee-440x280.png          小宣传图
├── top-marquee-1400x560.png           顶部宣传图
├── settings-1280x800.png              基本设置
├── display-style-1280x800.png         显示样式
├── translation-services-1280x800.png  翻译服务列表
├── behavior-preferences-1280x800.png  行为偏好
├── glossary-1280x800.png              技术术语表
├── about-1280x800.png                 关于
├── google-configuration-1280x800.png  Google 服务详情
├── mymemory-configuration-1280x800.png MyMemory 服务详情
├── baidu-configuration-1280x800.png   百度配置
├── ai-configuration-1280x800.png      AI 厂商列表与配置入口
└── previews/                         超过一屏的页面另存 *-full.png
```

标准设置截图从顶部取景，尺寸均为 1280×800；AI 图优先展示全部厂商。完整预览用于查看长页下方内容，尺寸随内容高度变化，不作为标准商店截图。商店普通截图最多选五张，不需要将全部生成图片都上传。

运行图标输出到 `assets/icon16.png`、`icon32.png`、`icon48.png`、`icon128.png`。16/32 像素使用加粗、简化的 `assets/icon-small.svg`，48/128 像素和宣传图使用 `assets/icon.svg`；调整品牌时需核对两个源文件。图片脚本不上传商店。新增导航或服务时，应同步脚本中的截图清单，避免遗漏。

## 发布流程

长期开发分支为 `dev`，稳定分支为 `main`，功能任务从 `dev` 创建临时分支。版本变更需同步 Manifest、package、锁文件和 CHANGELOG。

- `scripts/release-files.cjs` 定义发布白名单和文件过滤，`scripts/package.cjs` 用 Node.js 在 Windows、macOS 和 Linux 生成 `dist/yezhiyi-translator-<版本>.zip`，无需 PowerShell 或系统 ZIP 命令。先生成临时包，逐条读回比对路径、文件内容、版本及生产日志，通过后才生成正式文件；失败清理临时产物，同名正式包不会被覆盖。
- 白名单目录为 `background/`、`content/`、`core/`、`settings/`、`assets/`，另含根目录 `manifest.json`。目录内按允许的运行资源类型复制，过滤调试映射、隐藏文件、临时备份及依赖缓存；新增资源类型需同步维护规则。符号链接不入包并报错。
- 安装包仅包含 Manifest、运行文件和资源。README、CHANGELOG、测试、脚本、本机资料及独立隐私网页均不进入安装包。
- 推送版本一致的 `v*` 标签会触发 [商店上传工作流](.github/workflows/chrome-store-upload.yml)，校验对应提交已进入远程 `main`，默认执行检查、测试、打包，再上传现有商店条目的草稿。
- 也可在 Actions 中选择 `main` 手动运行并填写标签；手动运行允许关闭自动化测试，但仍执行源码检查和打包校验。普通分支推送、GitHub Release 不触发商店上传。
- 上传依赖仓库 Secrets：`CWS_SERVICE_ACCOUNT_JSON`、`CWS_PUBLISHER_ID`、`CWS_EXTENSION_ID`。不要将真实凭据写入仓库。
- 该流程只上传草稿并确认处理结果，不提交审核或发布。审核需在商店后台手动操作；隐私网页由现有 GitHub Pages 配置独立发布。

## 限制与反馈

- 不支持封闭式 Shadow DOM、浏览器内置页面或系统弹框；iframe 受 Chrome 网站访问和沙箱限制。视频画面、音频及字幕翻译尚未接入。
- 自动采集跳过输入值、可编辑区域、代码和明确禁译区域；主动 Shift 可覆盖网页禁译标记，仍跳过输入、编辑与代码。
- 语言选项是本地目录，不代表各服务都支持；MyMemory 的部分短文本需手动指定源语言。
- 请求有去重、有限内存缓存、限流和有限重试；取消不能撤回服务端已收到的内容或保证免除费用。

问题反馈：[GitHub Issues](https://github.com/cherubr/yezhiyi-translator/issues)。

本项目尚未添加开源许可证。开发依赖按各自附带的许可证使用。
