# PDF.js 本地资源

- 来源：Mozilla PDF.js，npm 包 `pdfjs-dist@6.5.438`。
- 官方发行：https://github.com/mozilla/pdf.js/releases/tag/v6.5.438
- 下载：https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-6.5.438.tgz
- 许可证：Apache-2.0，见本目录 LICENSE；字体、CMap、ICC 和解码器另保留各自许可证。
- 引入日期：2026-11-06。已比对 npm 发布的归档 SHA-512，逐文件 SHA-256 与字节数见 integrity.json。这只是资源引入完整性核对，不是运行或兼容性测试。

本目录从该固定发行包重新选取：build/pdf.mjs、build/pdf.worker.mjs、cmaps/、standard_fonts/、iccs/、wasm/ 中的图像解码与色彩资源。不复制 source maps、完整 Viewer、scripting sandbox、QuickJS、注释编辑资源或额外 renderer Worker；不修改第三方源码。

阅读页使用公开 getDocument/getPage/getViewport/render/cleanup/destroy API，通过实际 module Worker 的 port 接入，设置 isEvalSupported:false、useWorkerFetch:false 和固定的包内资源 URL。WASM 仅用于本机图像解码及色彩处理，不加载远程可执行代码。PDF 中的脚本不运行。

升级时须同步主模块/Worker/资源、document-reader.js 的版本、完整性清单和许可证，另行授权运行验收。项目 package.json/锁文件不添加运行依赖。仅支持具备该发行版所需现代 Web API 的 Chrome；本轮未执行浏览器兼容性验证。
