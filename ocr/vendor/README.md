# 本地 OCR 依赖

- Tesseract.js 7.0.0：https://github.com/naptha/tesseract.js （Apache-2.0，见 tesseract-LICENSE.md；打包依赖通知见两个 *.LICENSE.txt）
- tesseract.js-core 7.0.0：https://github.com/naptha/tesseract.js-core （见 core/LICENSE，包含上游各 SIMD/LSTM 兼容变体）
- @tesseract.js-data/eng、@tesseract.js-data/chi_sim 1.0.0 的 4.0.0_best_int 数据：https://github.com/naptha/tessdata （Apache-2.0，见 lang/LICENSE）。
- lang/LICENSE 原样取自 https://raw.githubusercontent.com/naptha/tessdata/gh-pages/LICENSE 。

文件从对应固定版本的 npm tarball 原样提取，下载时校验 npm 的 SHA-512 integrity；每个文件的 SHA-256、大小和包地址见 integrity.json。未执行 npm 安装脚本，未修改上游运行代码。

以上资源随扩展分发，运行时不访问 CDN。只有用户发起识别时才加载引擎及语言数据，完成或取消后释放 Worker；语言不写入 IndexedDB（cacheMethod:none）。整套依赖约 49.6 MB，包含不同浏览器指令集的兼容资源。图片和文字不由 OCR 上传；后续点击翻译才将校对后的文字发送给所选服务。
