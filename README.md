# 页知译 · 网页双语翻译

当前版本：**0.9.0**。基于 Chrome Manifest V3 的网页双语翻译扩展，支持 Google、MyMemory、百度及多家 AI 服务。

## 功能

- 网页双语和仅译文模式，支持段落、侧栏、表单标签、图标旁文字和网页弹框。
- 可见区域优先翻译，滚动及动态内容变化后补翻。
- 悬浮球、控制面板、划词和悬停翻译。
- 取消后还原原文并暂停当前页面补翻，手动翻译可恢复。
- API 密钥和服务配置保存在本机 `chrome.storage.local`；普通偏好使用同步存储。旧配置自动迁移。

## 安装与更新

1. 下载或克隆仓库。
2. 打开 `chrome://extensions`，开启开发者模式。
3. 点击“加载已解压的扩展程序”，选择包含 `manifest.json` 的目录。
4. 在扩展设置页选择翻译服务，并填写所需配置。

更新代码后，重新加载扩展并刷新目标网页。API 密钥保存在浏览器扩展存储中，请勿提交到仓库；本机存储不等同于加密存储。

## 开发验证

本地安装 Node.js 后运行：

```sh
node tests/regression.cjs
node tests/storage.cjs
node tests/network.cjs
```

浏览器布局测试使用 `node tests/browser-layout.cjs`，需另行安装 Playwright 及 Chromium。当前环境已通过逻辑回归和语法检查，尚未完成真实 Chrome 下的布局、性能及真实翻译接口验收。

## 已知限制

- 暂不覆盖 iframe、Shadow DOM、浏览器原生弹窗及图片内文字。
- 输入值、密码、placeholder 和原生下拉选项保持原样。
- 翻译服务需要可用的网络、相应权限及账号配置，部分服务可能收费。
- 长页面和频繁变化的页面仍需进行性能验证。

## 版本管理

以 `manifest.json` 为版本来源；设置页自动读取该版本。项目目录建议统一使用 `yezhiyi-translator`，无需随版本升级改名。
