# Tesseract.js OCR 引擎资源说明

本目录为 P4 扫描型 PDF 的本地 OCR 引擎资源，全部随扩展打包，运行时不访问 CDN、不发送页面图像到任何远程 OCR 服务。

## 来源

1. **tesseract.js 7.0.0**（npm 包 `tesseract.js@7.0.0`）
   - 官方仓库：https://github.com/naptha/tesseract.js
   - 下载方式：`npm pack tesseract.js@7.0.0 --ignore-scripts`（仅解包，未执行任何第三方脚本）
   - tarball SHA-512：`7b13c191dfb3fb033506e324c7f063bf8dce78b07184be64296b33ffd258f835dc5dd8818e201c874578f50477a0026a09a2f9a94444d2fc7d128f86e5813b98`
   - 引入文件：`dist/tesseract.min.js`（主线程 UMD 包）、`dist/worker.min.js`（OCR Worker 脚本）及各自 `.LICENSE.txt`
   - 许可证：Apache-2.0

2. **tesseract.js-core 7.0.0**（npm 包 `tesseract.js-core@7.0.0`）
   - 官方仓库：https://github.com/naptha/tesseract.js-core（Emscripten 编译的 Tesseract 5.x）
   - tarball SHA-512：`5a7347e75f0dce66d2abdce04cf7a817c73ec668a54bcac5225d5829b93fa6dbae73ba7a70b3442cdb8f033726b18c38e7471ae9b2daf23dedd1502dab8df957`
   - 引入文件：`tesseract-core-lstm.wasm.js`、`tesseract-core-simd-lstm.wasm.js`、`tesseract-core-relaxedsimd-lstm.wasm.js`（三者均为 WASM 内嵌 base64 的单文件构建，无需额外 `.wasm` 文件；已核验 relaxedsimd-lstm 内嵌 WASM 与同包独立 `.wasm` 文件 SHA-256 一致）及 `LICENSE`
   - 许可证：Apache-2.0

3. **tessdata_fast 语言模型**（GitHub 仓库 `tesseract-ocr/tessdata_fast`）
   - 固定 commit：`87416418657359cb625c412a48b6e1d6d41c29bd`（2024-08-01）
   - 下载方式：`raw.githubusercontent.com` 按上述 commit 直链下载
   - 引入文件：`tessdata/eng.traineddata`（英文）、`tessdata/chi_sim.traineddata`（简体中文）、`tessdata/LICENSE`
   - 许可证：Apache-2.0

## 选型说明

- 仅引入 **LSTM 专用（lstm）三种 SIMD 变体**：tesseract.js 默认 `oem=LSTM_ONLY(1)`，`getCore` 依 Worker 内 `wasm-feature-detect` 探测结果在 relaxedsimd → simd → 基线之间选择 `-lstm.wasm.js`。项目不使用 Legacy 引擎与 `worker.detect`，故未引入 4 个非 lstm 变体（可节省约 24 MiB）。
- 语言模型选用 tessdata_fast（量化 LSTM）而非 tessdata_best/tessdata：体积最小、LSTM_ONLY 模式识别质量满足扫描文档需求；P4-B 按方案仅随包 eng + chi_sim，其余语言由注册表（`pdf/ocr-models.js`）声明，P4-D 已实现按需下载（见下节）。
- 未引入 `.map`、`docs/`、`examples/`、`src/` 等非运行文件。

## MV3 使用注意（源码级核验结论）

- `createWorker` 必须传 `workerBlobURL: false`：默认 `true` 会用 `Blob + importScripts` 启动 Worker，被扩展 CSP 拦截；置 `false` 后走 `new Worker(workerPath)` 同源加载。
- `workerPath` / `corePath` / `langPath` 均传 `chrome.runtime.getURL` 绝对地址（`resolvePaths` 以 `window.location.href` 解析相对路径，扩展页下亦可用，但统一传绝对地址）。
- `corePath` 传本目录地址；Worker 内 `importScripts(corePathImportFile)` 同源加载，WASM 编译由 CSP `wasm-unsafe-eval` 覆盖（manifest 已具备）。
- 必须 `gzip: false`（本地 `.traineddata` 未压缩）且 `cacheMethod: 'none'`（跳过 IndexedDB 读写缓存，语言文件每次从扩展包内加载）。
- `recognize(image, options, output)` 需传 `output: { blocks: true }` 才返回结构树（`GetJSONText`：blocks → paragraphs → lines → words，含 `bbox{x0,y0,x1,y1}`、`confidence`、`text`、`baseline`，坐标为输入位图像素、左上原点）；默认 `blocks: false`。
- 主线程包内仅存一处 `new Function("return this")` 的 globalThis 三级回退（现代环境不会执行到），无其他 eval/远程代码。

## 按需下载语言模型（P4-D）

- 下载源与随包模型**同仓库同固定 commit**：`https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/8741641…/<code>.traineddata`（URL 由 `MODEL_SOURCE` 派生，见 `pdf/ocr-models.js`）。
- 每个可下载条目的 **SHA-256 与字节数**从上述 commit 实测钉死在注册表中；下载后先校验大小与摘要，任一不符拒绝写入（`MODEL_INTEGRITY`）。`.traineddata` 为纯数据文件，不属远程代码，不违反商店政策。
- 下载仅在用户于阅读页「OCR 语言模型」区点击时发起，来源授权走既有 `optional_host_permissions`（`https://*/*`）的 `chrome.permissions.request`，**manifest 无新增权限**。
- 校验通过的模型存入扩展自有 **IndexedDB**（库 `bt-pdf-ocr-models`，meta+blobs 双 store 同事务提交），记录 `modelSource` 版本戳；升级钉死 commit 后旧记录自动失效清理，离线可复用。
- 识别时已安装模型以 `{code, data}` 条目直传字节（`worker.min.js` loadLanguage 的非字符串分支 `e.data` 已在 7.0.0 源码核验；同版本 initialize 的语言名映射存在上游 bug，见「本地补丁」），**不经过 tesseract 内建缓存、不发起网络请求**；随包模型仍走包内 `langPath` 字符串码路径。

## 本地补丁

- **worker.min.js · initialize 语言名映射（1 处，2026-11-09）**：上游 7.0.0（含 latest）initialize 将语言条目映射为 `"string"==typeof t?t:t.data`，对 `{code, data}` 条目会把**模型字节**当作 `api.Init` 的语言名传入，导致 Init 返回 -1、reject `initialization failed`，且主线程 createWorker 的 Promise 因 initialize 拒绝永不落定（识别请求挂起至超时）。本地补丁将该 token 改为 `t:t.code`（与 loadLanguage 的 `<code>.traineddata` 写入逻辑一致），文件字节数不变，补丁后 SHA-256 见 `integrity.json` 的 `patches` 记录。字符串语言码路径不受影响。
- 升级 vendor 后必须在新版源码中重新核验该映射：若上游已修复则丢弃补丁，若未修复则在新 `worker.min.js` 上重打并更新 `integrity.json`。

## 升级流程

1. `npm pack tesseract.js@<新版本> --ignore-scripts` 与 `tesseract.js-core@<对应版本>`，比对 tarball SHA-512 与官方发布值。
2. 重新核验本文件「MV3 使用注意」「按需下载语言模型」与「本地补丁」各项（spawnWorker/getCore/loadLanguage 的 `{code,data}` 直传分支/dump 逻辑可能变化；initialize 语言名映射补丁需按「本地补丁」节重新核验或重打）。
3. 替换文件后运行完整性清单脚本重新生成 `integrity.json`，并同步 `pdf/ocr-models.js` 中的 `engineVersion` 与模型版本。
4. 若升级 `MODEL_SOURCE`（tessdata_fast commit）：重新下载全部可下载条目、重算 SHA-256/字节数并更新注册表；已安装旧模型由版本戳机制自动失效。

## 完整性

逐文件 SHA-256 与字节数见同目录 `integrity.json`。
