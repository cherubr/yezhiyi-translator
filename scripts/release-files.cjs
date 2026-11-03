/**
 * 发布副本的共享模块，供 package.cjs 和发布相关测试 require。
 * 本文件没有独立打包入口，导入时不会复制文件或创建 ZIP。
 * 运行白名单与日志转换只在这里定义，避免打包脚本和测试各维护一套规则。
 */
const fs = require("node:fs"),
  path = require("node:path"),
  vm = require("node:vm");

// 仅复制运行必需目录；目录内资源和第三方许可证会随目录一起复制。
// 文档、脚本、测试、依赖及 .local 不入包，隐私网页由 GitHub Pages 独立提供。
// Object.freeze 防止调用者无意修改当前进程中的白名单。
const RELEASE_FILES = Object.freeze([
  "manifest.json",
  "background",
  "content",
  "core",
  "settings",
  "pdf",
  "ocr",
  "assets",
]);
// 目录白名单还需配合文件类型过滤，不能把运行目录内的笔记和调试文件一起复制。
// 第三方许可证/来源说明另行保留，不能只按扩展名过滤掉无后缀 LICENSE。
const RESOURCE_EXTENSION = /\.(?:js|mjs|html|css|json|png|svg|wasm|gz|traineddata|bcmap|icc|pfb|ttf)$/i;
const EXCLUDED_DIRECTORIES = new Set(["node_modules", "__MACOSX", "coverage", "test-results", "playwright-report"]);

/**
 * 判断白名单目录内文件是否为允许发布的资源；相对路径统一使用 /。
 * 隐藏文件/目录、调试映射、临时/备份文件不会通过此规则。
 * @param {string} relative 项目相对文件路径，不接受绝对路径或父目录跳转。
 * @returns {boolean} 是否允许进入发布副本。
 */
function isReleaseFile(relative) {
  const parts = relative.split("/");
  if (parts.some(part => !part || part === "." || part === ".." || part.startsWith(".") || EXCLUDED_DIRECTORIES.has(part)) || relative.includes("\\")) return false;
  if (relative === "manifest.json") return true;
  if (!RELEASE_FILES.includes(parts[0]) || parts.length < 2) return false;
  const name = parts[parts.length - 1];
  if (RESOURCE_EXTENSION.test(name)) return true;
  // 保留整个第三方资源树中的许可证，以及明确命名的来源/使用说明。
  return /^(?:pdf|ocr)\/vendor\//.test(relative) && (
    /(?:^|[._-])(?:LICENSE|NOTICE|COPYING)(?:[._-].*)?$/i.test(name) ||
    /^(?:SOURCE|README)\.md$/i.test(name) || /-README\.md$/i.test(name)
  );
}

/**
 * 枚举可发布文件，拒绝符号链接和非普通文件，防止跨目录读取。
 * 缺少任一顶层白名单项会失败；排序使三个系统使用一致的 ZIP 条目顺序。
 * @param {string} root 项目根目录或已准备的发布副本。
 * @returns {string[]} 以 / 分隔的相对文件路径。
 */
function listReleaseFiles(root) {
  const files = [];
  function visit(relative, top = false) {
    const absolute = path.join(root, ...relative.split("/"));
    const info = fs.lstatSync(absolute);
    if (info.isSymbolicLink()) throw Error("发布资源不能为符号链接：" + relative);
    if (top && (relative === "manifest.json" ? !info.isFile() : !info.isDirectory()))
      throw Error("发布白名单项类型错误：" + relative);
    if (info.isDirectory()) {
      for (const name of fs.readdirSync(absolute).sort()) {
        // 不进入隐藏目录；其他目录继续遍历，由文件规则决定哪些内容入包。
        if (!name.startsWith(".") && !EXCLUDED_DIRECTORIES.has(name)) visit(relative + "/" + name);
      }
    } else if (!info.isFile()) {
      throw Error("发布资源必须为普通文件：" + relative);
    } else if (isReleaseFile(relative)) files.push(relative);
  }
  for (const item of RELEASE_FILES) visit(item, true);
  return files.sort();
}
// 精确定位 constants.js 的日志声明；全局匹配用于检查是否只有一处目标。
const CONFIG_PATTERN = /const LOG_CONFIG = Object\.freeze\(\{[\s\S]*?\}\);/g;

/**
 * 只替换唯一的日志配置声明；找不到或出现多处时停止打包，不能悄悄发布开发日志。
 * 返回新源码，调用者决定写入何处，本函数不直接改文件。
 * @param {string} source 待转换的 constants.js 源码。
 * @returns {string} 强制 environment=production、level=off 的源码。
 * @throws {Error} 匹配数量不是 1，说明源码形态已变化，需要人工核对转换逻辑。
 */
function productionConstants(source) {
  if ([...source.matchAll(CONFIG_PATTERN)].length !== 1)
    throw Error("无法唯一定位日志配置，拒绝生成发布包");
  // 保留 CRLF/LF，避免临时副本因平台换行产生无关变化。
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  return source.replace(
    CONFIG_PATTERN,
    [
      "const LOG_CONFIG = Object.freeze({",
      '    environment: "production",',
      '    level: "off"',
      "  });",
    ].join(newline),
  );
}

/**
 * 执行配置模块并实际调用各级日志，验证生产配置、不可启用与零控制台输出。
 * 此处只运行包内可信的 constants.js，不加载后台或进行网络请求。
 * @param {string} source 临时副本或实际 ZIP 中读取到的 constants.js。
 * @returns {void} 所有断言通过后返回；调用者据此继续打包/交付。
 * @throws {Error} 配置、冻结状态或实际输出与生产要求不符，或 VM 执行失败。
 */
function verifyReleaseLogging(source) {
  // 用收集器代替真实控制台，连配置模块初始化时的输出也能捕获。
  const printed = [],
    context = {
      console: Object.fromEntries(
        ["log", "debug", "info", "warn", "error"].map((level) => [
          level,
          (...args) => printed.push([level, ...args]),
        ]),
      ),
    };
  // constants.js 兼容 self/window，全指向同一 VM 上下文以读取其注册对象。
  context.self = context;
  context.window = context;
  vm.createContext(context);
  // 限制同步执行时间，避免意外源码让发布检查无限阻塞。
  vm.runInContext(source, context, {
    filename: "release/core/constants.js",
    timeout: 1000,
  });
  const config = context.BT_CONST?.LOG_CONFIG,
    log = context.BT_LOG;
  // 除检查配置值，还要求配置及日志 API 冻结，不能靠运行时改等级重新启用。
  if (
    config?.environment !== "production" ||
    config?.level !== "off" ||
    !Object.isFrozen(config) ||
    !Object.isFrozen(log)
  )
    throw Error("发布包未强制关闭日志");
  // 查询开关和真正调用都要静默；只看 level 字符串不足以证明没有输出。
  for (const level of ["error", "warn", "info", "debug"]) {
    if (log.isEnabled(level)) throw Error("发布包仍可启用日志：" + level);
    log[level]("release logging probe");
  }
  if (printed.length) throw Error("发布包仍输出控制台日志");
}

/**
 * 复制运行白名单，在副本中关闭日志，并验证本轮生成的配置。
 * 调用者应提供独立 staging 目录，不能把 stage 指向开发项目本身；
 * 清理和 ZIP 生成由调用者负责，本函数不清理已有目标内容。
 * @param {string} root 项目根目录，读取源码与运行资源。
 * @param {string} stage 发布临时副本目录，允许写入。
 * @returns {string[]} 成功复制的文件清单，供 ZIP 完整性校验使用。
 * @throws {Error} 白名单文件缺失、复制/写入失败或日志检查失败。
 */
function prepareRelease(root, stage) {
  const sourceRoot = path.resolve(root), destination = path.resolve(stage);
  if (destination === sourceRoot || destination.startsWith(sourceRoot + path.sep))
    throw Error("发布副本不能位于源码目录内部");
  const files = listReleaseFiles(root);
  // 按明确的文件清单复制；保留空顶层目录便于测试和后续校验，不将其写为 ZIP 条目。
  fs.mkdirSync(stage, {recursive:true});
  for (const directory of RELEASE_FILES.filter(item => item !== "manifest.json"))
    fs.mkdirSync(path.join(stage, directory), {recursive:true});
  for (const file of files) {
    const target = path.join(stage, ...file.split("/"));
    fs.mkdirSync(path.dirname(target), {recursive:true});
    fs.copyFileSync(path.join(root, ...file.split("/")), target);
  }
  // 后续读写的都是副本路径，开发源码的日志等级保持不变。
  const constants = path.join(stage, "core/constants.js");
  const source = productionConstants(fs.readFileSync(constants, "utf8"));
  fs.writeFileSync(constants, source);
  verifyReleaseLogging(source);
  return files;
}
// 导出纯转换、验证和副本准备入口，测试可分别验证而不调用真实压缩程序。
module.exports = {
  RELEASE_FILES,
  isReleaseFile,
  listReleaseFiles,
  productionConstants,
  verifyReleaseLogging,
  prepareRelease,
};
