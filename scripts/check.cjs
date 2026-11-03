/**
 * 开发/CI 的只读检查入口：npm run check。
 * 检查顺序为 JS 语法 → Manifest 直接引用的资源 → Manifest/package 版本。
 * 本脚本不会加载扩展、执行被检查的 JS、运行功能测试、打包或访问商店。
 * 依赖锁文件版本、所有 HTML 的脚本引用及真实浏览器行为不在本脚本检查范围内。
 */
// fs/path 用于读取项目；spawnSync 用当前 Node 启动语法检查子进程。
const fs = require("node:fs"),
  path = require("node:path"),
  { spawnSync } = require("node:child_process");
// 以脚本位置而非终端当前目录定位仓库，避免从其他目录调用时检查错项目。
const root = path.resolve(__dirname, ".."),
  manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json")));

/**
 * 调用当前 Node 的 --check，只解析指定文件而不执行其代码。
 * 子进程输出直接显示在终端；失败立即终止整个检查，供 CI 判断失败。
 * @param {string} file 待检查 JS 文件路径。
 * @returns {void} 成功继续；失败以子进程状态码退出，缺少状态码时使用 1。
 */
function check(file) {
  const r = spawnSync(process.execPath, ["--check", file], {
    stdio: "inherit",
  });
  if (r.status !== 0) process.exit(r.status || 1);
}

/**
 * 递归扫描入口指定的目录，逐个检查 .js、.cjs 和 .mjs。
 * 不从仓库根目录扫描，因此不会进入根目录的 node_modules 或 .local；
 * 指定目录内的子目录会继续扫描，包括 PDF/OCR 随包附带的 JS。
 * @param {string} dir 本轮递归的目录绝对路径。
 * @returns {void} 文件读取或语法失败会向外抛出/退出，不跳过错误文件。
 */
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p);
    else if (/\.(c?js|mjs)$/.test(p)) check(p);
  }
}

// 运行代码、开发工具与测试脚本均需语法有效；不在此处执行它们。
for (const dir of [
  "background",
  "content",
  "core",
  "settings",
  "pdf",
  "ocr",
  "scripts",
  "tests",
])
  walk(path.join(root, dir));

// 只核对下面列出的 Manifest 字段：Worker、内容脚本 JS/CSS 和两组图标。
// flatMap 把多个 content_scripts 配置展开；图标路径取各尺寸对应的值。
// 资源存在并不代表内容正确，也不能代替阅读页 HTML/module 依赖检查。
for (const ref of [
  manifest.background.service_worker,
  ...manifest.content_scripts.flatMap((x) => [...x.js, ...x.css]),
  ...Object.values(manifest.icons),
  ...Object.values(manifest.action.default_icon),
])
  if (!fs.existsSync(path.join(root, ref))) throw Error("缺少扩展文件：" + ref);

// 此处只比较两个版本字符串；不修改版本，也不校验 package-lock.json。
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json")));
if (pkg.version !== manifest.version)
  throw Error("package.json 与 Manifest 版本不一致");

// 仅当以上所有步骤都完成时输出通过信息。
console.log("PASS: 全项目语法、Manifest引用和版本一致性");
