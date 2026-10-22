# 页知译 · 网页双语翻译

Chrome Manifest V3 网页双语翻译扩展，保留原文并展示译文。
代码版本以 [manifest.json](manifest.json) 为准，版本变更见 [CHANGELOG.md](CHANGELOG.md)。

## 功能

- 支持 Google、MyMemory、百度及 OpenAI 兼容 AI 服务，可连接本机 Ollama 和自定义接口。
- 双语对照、仅译文、选中文字翻译，以及鼠标所在段落的 Shift 翻译与还原。
- 识别正文、侧栏、网页弹框和控件旁说明；正文中的链接与行内代码按同一翻译单元处理。
- 优先翻译可见区域；当前页启动后持续补翻，点击取消后恢复原文并暂停本页补翻。
- 请求去重、有限内存缓存、按服务限流、有限重试；离开标签页暂停新发送，返回后继续。
- 提供 48 种语言选项，默认自动检测源语言、目标语言跟随浏览器，也允许手动覆盖。

## 安装与使用

1. 下载或克隆仓库，打开 `chrome://extensions` 并开启开发者模式。
2. 选择“加载已解压的扩展程序”，加载包含 `manifest.json` 的项目根目录。
3. 在扩展设置中选择翻译服务；百度和多数 AI 服务需自行配置凭据，自定义域名需主动授权。
4. 点击悬浮球开始/取消整页翻译。默认快捷键为 Ctrl+Shift+Y，Mac 为 Command+Shift+Y。
5. 启用单段翻译后，把鼠标停在段落上按 Shift：有译文则还原，没有译文则翻译。
6. 修改代码后重新加载扩展并刷新网页。

新安装默认关闭自动翻译。翻译文字会发送给所选服务；API 凭据和请求配置仅存本机，普通偏好可经 Chrome 同步。
详见 [隐私说明](PRIVACY.md) 和 [公开隐私网页](docs/privacy.html)。

## 目录说明

```text
.
├── background/     后台消息、页面生命周期与翻译服务调用
├── content/        网页采集入口、译文展示、Shift 和控制面板
├── core/           共享配置、语言、翻译单元、请求策略和调度运行时
├── settings/       扩展设置页
├── assets/         扩展运行图标及图标源文件
├── tests/          逻辑与浏览器回归测试，随代码提交
├── scripts/        检查、打包和图片导出工具，随代码提交
├── .github/        GitHub Actions 自动检查
├── docs/           公开隐私网页，保留既有访问路径
├── .local/         本地手册、填写草稿、商店图片与原型，不提交
├── dist/           本地安装包及验收副本，不提交
├── node_modules/   本地开发依赖，不提交
├── manifest.json   扩展入口、权限、资源与版本声明
├── package.json    开发依赖与命令
├── README.md       项目说明
├── CHANGELOG.md    版本变更记录
└── PRIVACY.md      公开隐私说明
```

运行目录保留在根目录，使 Manifest 引用与“加载已解压扩展”的路径清晰稳定。
依赖、生成物、编辑器个人配置及 `.local/` 均由 `.gitignore` 排除；Git 克隆不会带上个人资料。

## 开发与检查

GitHub Actions 使用 Node.js 22；本地推荐使用同一主版本。首次安装或锁文件更新后：

```powershell
npm ci
npx playwright install chromium
```

| 命令 | 用途 |
| --- | --- |
| `npm run check` | 源码语法、Manifest 引用、版本一致性 |
| `npm test` | 日志、采集、存储、权限、语言及调度逻辑回归 |
| `npm run test:browser` | Chromium 布局、动态网页、单段与完整扩展集成测试 |
| `npm run package` | Windows 下生成运行白名单 ZIP，不覆盖同名旧包 |
| `npm run store:assets` | 手动导出本地商店图片、截图与运行图标 |

测试使用独立浏览器资料和模拟服务。真实账号、额度、网络与第三方网页仍需人工验证。
长期开发基准为 `dev`，稳定基准为 `main`；具体任务从 `dev` 创建临时分支，完成后集成测试，再按交付范围合入 `main`。

## 日志与打包

日志在 `core/constants.js` 的 `LOG_CONFIG` 配置：环境为 `development` 时允许按 `off/error/warn/info/debug` 级别打印。
修改后重新加载扩展并刷新网页；详细诊断需在浏览器控制台启用 Verbose/详细级别。
日志不得包含原文、译文、密钥或完整请求对象。

明确准备发布时才执行 `npm run package`。输出为 `dist/yezhiyi-translator-<Manifest版本>.zip`，仅包含运行文件、图标与隐私说明。
脚本在临时发布副本中强制关闭插件主动日志并检查 ZIP，不改本地开发配置；手动压缩源码不会执行此转换。
Git 推送、Tag 与 GitHub Release 均不会自动更新 Chrome 商店。

个人操作手册、发布填写草稿、商店图片和原型集中保留在本地 `.local/`；本地入口为 `.local/README.md`。
这些资料不属于运行代码，不会提交到 GitHub 或进入安装包。

## 已知边界

- 暂不支持 iframe、Shadow DOM、图片文字、浏览器内置页面和原生系统弹框。
- 不翻译输入框已填内容、密码、placeholder 或原生下拉选项；代码与明确禁译内容按采集规则处理。
- 语言选项不是接口实时返回的完整语种列表，实际支持取决于所选服务或模型。
- MyMemory 对部分短文字无法可靠识别源语言，需要手动指定或切换服务。
- 网络可用性、限流、计费和数据处理规则由所选服务决定；取消不能撤回服务端已收到的内容。
- 当前未添加开源许可证。
