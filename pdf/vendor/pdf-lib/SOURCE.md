# pdf-lib PDF 导出引擎资源说明

本目录为 P5 翻译结果导出的本地 PDF 生成资源，全部随扩展打包，运行时不访问 CDN、不发起任何网络请求（源码级核验无 fetch/XHR/WebSocket），不修改原始 PDF 字节——只读取原文件、复制页对象、叠加遮罩与译文后另存为新文件。

## 来源

1. **pdf-lib 1.17.1**（npm 包 `pdf-lib@1.17.1`）
   - 官方仓库：https://github.com/Hopding/pdf-lib
   - 下载方式：`https://registry.npmjs.org/pdf-lib/-/pdf-lib-1.17.1.tgz` tarball 直链（仅解包，未执行任何第三方脚本）
   - tarball SHA-1（npm `dist.shasum`）：`9e7dd21261a0c1fb17992580885b39e7d08f451f`
   - tarball SHA-512（npm `dist.integrity`）：`57f9a9c890284ec3787273f7d6f734c1f340d7ea76d1ebeaaa76a9d0a2e8454374624fe9df0379d83384b0be2804570b75befa865a4a3edcc9220a3aee3fd72f`（本地实测与 registry 一致，2026-11-09）
   - 引入文件：`dist/pdf-lib.min.js`（UMD 单文件构建）
   - 许可证：MIT（tarball 内 `LICENSE.md` 随包引入）；bundle 头部另嵌 Microsoft tslib 的 Apache-2.0 版权横幅，随原样分发保留署名

2. **@pdf-lib/fontkit 1.1.1**（npm 包 `@pdf-lib/fontkit@1.1.1`）
   - 官方仓库：https://github.com/Hopding/fontkit
   - 下载方式：`https://registry.npmjs.org/@pdf-lib/fontkit/-/fontkit-1.1.1.tgz` tarball 直链（同上）
   - tarball SHA-1（npm `dist.shasum`）：`f18473892b65e3253eb73f4569785abd2c03b1e0`
   - tarball SHA-512：`2a331dee0acd6a92164bf0e6d20bdf1c48a54b202678bbeb10655ca8b1a2d1561e6eeaaacd36e0176f5e7c2c7bb6fc7e2046c6df341c8914969771a4512be366`（与 registry 一致）
   - 引入文件：`dist/fontkit.umd.min.js`（UMD 单文件构建）
   - 许可证：MIT；tarball 与上游仓库均无 LICENSE 文件，署名记录见本目录 `LICENSE.fontkit.md`
   - 用途：`PDFDocument#registerFontkit` 注册后供 P5-C 自定义字体子集嵌入；P5-B 仅标准字体，导出 Worker 不加载本文件，P5-C 接入

## 选型说明

- P5 主路径为「加载原 PDF → `copyPages` 复制页对象 → 叠加遮罩矩形与译文 → `save` 另存新文件」，pdf-lib 是可复制既有 PDF 页对象、不重渲染页面的纯 JS MIT 库；jsPDF 无法读入既有 PDF 页面，整页图像化重建丢失矢量原文与可搜索文字，服务端方案违反隐私边界（详见 P5-A 报告）。
- pdf-lib 上游自 2021 年起停止维护，为 P5-A 已接受的风险；版本钉死 1.17.1，无远程依赖、无构建步骤。
- 未引入 `.map`、`es/`、`cjs/`、`src/`、`ts3.4/` 等非运行文件。

## MV3 使用注意（源码级核验结论，spike 2026-11-09）

- UMD 全局名为 **`PDFLib`（大写）** 与 **`fontkit`**：`self.PDFLib`、`self.fontkit`；`pdf/export-worker.js` 以 classic Worker `importScripts` 同源加载，CSP `script-src 'self'` 覆盖，manifest 无需改动。
- 已用 VM 模拟 classic Worker 作用域（仅 `self`，无 module/exports/define）核验：两包全局落位与 API 形状正常（`PDFLib.PDFDocument/StandardFonts/degrees/rgb`、`fontkit.create`）。
- 两包均无 eval、`importScripts`、fetch/XHR/WebSocket、远程代码加载；bundle 内出现的 http(s) 字符串仅为许可证与文档引用。`pdf-lib.min.js` 末尾有一条 `//# sourceMappingURL=pdf-lib.min.js.map` 注释，`.map` 未随包，仅影响 DevTools 源码映射（404），无运行时行为。
- `fontkit.umd.min.js` 存在一处 `Function("binder",…)` 动态构造，位于 `Function.prototype.bind || function…` 的 ES5 polyfill 回退分支；Chrome 原生提供 bind，该分支永不执行（与 tesseract vendor 的 `new Function("return this")` 同级处理）。
- `registerFontkit` 是 **`PDFDocument` 实例方法**（`doc.registerFontkit(fontkit)`），不是模块级导出。
- 标准字体（Helvetica 等）仅 WinAnsi 编码：非 WinAnsi 字符 `drawText` 抛 `WinAnsi cannot encode "×" (0x…)`，不会产出缺字内容——这是页侧导出预检（P5-B）与自定义字体嵌入（P5-C）的行为依据。
- `PDFDocument.load` 对损坏字节与加密 PDF 抛错（pdf-lib 不能解密用户口令 PDF），导出侧统一归类 EXPORT_FAILED 并给出明确文案。
- `copyPages` 保留页面尺寸与 `/Rotate`：90° 旋转页复制输出已验证旋转与尺寸一致，导出叠加需自行换算固有旋转（见 P5 坐标契约）。
- 功能 spike 闭环通过：create → drawText/drawRectangle → save → load → copyPages → 叠加 → save → 复读校验（node v24，脚本 `/tmp/p5b-spike.cjs`，一次性验证用，不入包）。

## 升级流程

1. 从 registry 下载新版本 tarball，比对 npm `dist.shasum`（SHA-1）与 `dist.integrity`（SHA-512）。
2. 重新核验本文件「MV3 使用注意」各项：UMD 全局名、动态构造分支、WinAnsi 抛错行为、`copyPages` 旋转/尺寸保留、`registerFontkit` 形状。
3. 替换文件后重算 SHA-256/字节数更新 `integrity.json`，并同步本文件版本与哈希记录。

## 完整性

逐文件 SHA-256 与字节数见同目录 `integrity.json`。
