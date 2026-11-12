/**
 * 跨平台打包回归：只在独立临时项目生成小型 ZIP，不操作项目 dist 或真实商店。
 * 覆盖文件白名单、资源类型、UTF-8/空格路径、生产日志、归档完整性、失败清理和无覆盖发布。
 * 三系统 CI 使用同一脚本；Mac 实际项目包另用系统 unzip/Python 独立验收。
 * 执行：npm run test:package
 */
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const AdmZip = require("adm-zip");
const {packageRelease, verifyReleaseArchive} = require("../scripts/package.cjs");
const {RELEASE_FILES, prepareRelease, isReleaseFile} = require("../scripts/release-files.cjs");
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "yezhiyi-package-test-"));
const constants = fs.readFileSync(path.join(__dirname, "../core/constants.js"), "utf8");
const binary = Buffer.from(Array.from({length:256}, (_, index) => index));

/** 创建具有必要目录、版本文件和模拟运行资源的独立项目。 */
function createProject(name) {
  const root = path.join(fixture, name);
  fs.mkdirSync(root);
  for (const directory of RELEASE_FILES.filter(item => item !== "manifest.json"))
    fs.mkdirSync(path.join(root, directory));
  for (const [file, value] of Object.entries({
    "manifest.json": {manifest_version:3, version:"1.0.2"},
    "package.json": {version:"1.0.2"},
    "package-lock.json": {version:"1.0.2", packages:{"":{version:"1.0.2"}}}
  })) fs.writeFileSync(path.join(root, file), JSON.stringify(value));
  for (const [file, value] of Object.entries({
    "core/constants.js":constants, "content/content.js":"const value = '中文';",
    "content/empty.js":"", "assets/字 图.svg":"<svg>中文</svg>", "assets/bytes.png":binary,
    "pdf/reader.html":"<!doctype html><title>PDF Viewer</title>",
    "pdf/vendor/build/pdf.mjs":"export const version = 1;",
    "pdf/vendor/wasm/openjpeg.wasm":binary, "pdf/vendor/cmaps/sample.bcmap":binary,
    "pdf/vendor/standard_fonts/sample.ttf":binary, "pdf/vendor/LICENSE":"license",
    "pdf/vendor/SOURCE.md":"source", "pdf/vendor/notes.md":"private notes",
    "pdf/vendor/build/pdf.mjs.map":"debug map", "pdf/private.wasm":binary,
    "pdf/vendor/tesseract/worker.min.js":"const worker = 1;",
    "pdf/vendor/tesseract/worker.min.js.LICENSE.txt":"license",
    "pdf/vendor/tesseract/tessdata/eng.traineddata":binary,
    "pdf/vendor/tesseract/tessdata/notes.md":"private notes",
    "core/sample.mjs":"export const version = 1;", "core/sample.json":"{\"value\":1}",
    "content/notes.txt":"Private local notes", "core/sample.mjs.map":"debug map",
    "assets/.DS_Store":"system file", "background/.cache/ignored.js":"cache",
    "content/node_modules/ignored.js":"dependency", "core/notes.md":"local notes",
    "core/engine.wasm":binary, "core/language.gz":binary, "core/LICENSE":"license",
    "settings/settings.js.bak":"backup", "README.md":"project docs", ".local/notes.md":"local"
  })) {
    const target = path.join(root, ...file.split("/"));
    fs.mkdirSync(path.dirname(target), {recursive:true}); fs.writeFileSync(target, value);
  }
  return root;
}

function outputPath(root) {return path.join(root, "dist/yezhiyi-translator-1.0.2.zip");}
function cleanDist(root) {
  const dist = path.join(root, "dist");
  assert.deepEqual(fs.existsSync(dist) ? fs.readdirSync(dist) : [], []);
}

try {
  const root = createProject("跨平台 空格 ' 项目");
  const output = packageRelease(root), zip = new AdmZip(output);
  assert.equal(output, outputPath(root));
  const names = zip.getEntries().map(entry => entry.entryName);
  assert.ok(names.includes("manifest.json"));
  assert.ok(names.every(name => !name.includes("\\") && !name.startsWith("/")));
  for (const name of ["pdf/vendor/notes.md", "pdf/vendor/build/pdf.mjs.map", "pdf/private.wasm", "pdf/vendor/tesseract/tessdata/notes.md", "content/notes.txt", "core/sample.mjs.map", "assets/.DS_Store", "background/.cache/ignored.js", "content/node_modules/ignored.js", "core/notes.md", "core/engine.wasm", "core/language.gz", "core/LICENSE", "settings/settings.js.bak", "README.md", ".local/notes.md", "package.json"])
    assert.ok(!names.includes(name), "杂项不得入包：" + name);
  for (const name of ["core/sample.mjs", "core/sample.json", "pdf/reader.html", "pdf/vendor/build/pdf.mjs", "pdf/vendor/wasm/openjpeg.wasm", "pdf/vendor/cmaps/sample.bcmap", "pdf/vendor/standard_fonts/sample.ttf", "pdf/vendor/LICENSE", "pdf/vendor/SOURCE.md", "pdf/vendor/tesseract/worker.min.js", "pdf/vendor/tesseract/worker.min.js.LICENSE.txt", "pdf/vendor/tesseract/tessdata/eng.traineddata"])
    assert.ok(names.includes(name), "允许的运行资源必须入包：" + name);
  assert.deepEqual(zip.readFile("assets/bytes.png"), binary);
  assert.equal(zip.readAsText("assets/字 图.svg"), "<svg>中文</svg>");
  assert.equal(zip.readAsText("content/empty.js"), "");
  assert.match(zip.readAsText("core/constants.js"), /environment: "production"/);
  assert.equal(fs.readFileSync(path.join(root, "core/constants.js"), "utf8"), constants);
  assert.deepEqual(fs.readdirSync(path.join(root, "dist")), [path.basename(output)]);
  const previous = fs.readFileSync(output);
  assert.throws(() => packageRelease(root), /已存在/);
  assert.deepEqual(fs.readFileSync(output), previous);

  // 读回校验不能只检查日志：同样验证缺项、额外路径、字节变化和损坏归档。
  const stage = path.join(fixture, "stage"), files = prepareRelease(root, stage);
  verifyReleaseArchive(output, stage, files, "1.0.2");
  const modified = path.join(fixture, "modified.zip");
  for (const change of [
    value => value.deleteFile("assets/bytes.png"),
    value => {value.deleteFile("assets/bytes.png"); value.addFile("extra.js", Buffer.from("extra"));},
    value => value.updateFile("content/content.js", Buffer.from("modified")),
    value => value.updateFile("core/constants.js", Buffer.from(constants))
  ]) {
    const altered = new AdmZip(output); change(altered); altered.writeZip(modified);
    assert.throws(() => verifyReleaseArchive(modified, stage, files, "1.0.2"));
  }
  fs.writeFileSync(modified, previous.subarray(0, 40));
  assert.throws(() => verifyReleaseArchive(modified, stage, files, "1.0.2"));
  assert.throws(() => verifyReleaseArchive(output, stage, files, "9.9.9"), /版本/);
  assert.throws(() => prepareRelease(root, path.join(root, "nested")), /源码目录内部/);
  for (const file of ["../secret.js", "/core/a.js", "core\\a.js", "content/.env.json", "content/notes.txt"])
    assert.equal(isReleaseFile(file), false, file);

  for (const [name, mutate] of [
    ["missing", value => fs.rmSync(path.join(value, "settings"), {recursive:true})],
    ["logging", value => fs.writeFileSync(path.join(value, "core/constants.js"), "missing logging config")],
    ["version", value => fs.writeFileSync(path.join(value, "package.json"), '{"version":"1.0.1"}')],
    ["lock", value => fs.writeFileSync(path.join(value, "package-lock.json"), '{"version":"1.0.2","packages":{"":{"version":"1.0.1"}}}')],
    ["invalid-version", value => fs.writeFileSync(path.join(value, "manifest.json"), '{"version":"01.0.2"}')]
  ]) {
    const project = createProject(name); mutate(project);
    assert.throws(() => packageRelease(project)); cleanDist(project);
  }

  // 人为损坏临时 ZIP，验证没有正式文件和残留 staging；不替换被测校验函数。
  const damaged = createProject("damaged"), originalWrite = fs.writeFileSync;
  try {
    fs.writeFileSync = (target, data, options) => originalWrite(target,
      path.basename(String(target)) === "validated.zip" ? Buffer.from("broken zip") : data, options);
    assert.throws(() => packageRelease(damaged));
  } finally {fs.writeFileSync = originalWrite;}
  cleanDist(damaged);

  // 模拟通过预检查后另一个进程先发布，不覆盖也不删除对方文件。
  const racing = createProject("racing"), originalLink = fs.linkSync;
  try {
    fs.linkSync = (source, target) => {fs.writeFileSync(target, "winner", {flag:"wx"}); originalLink(source, target);};
    assert.throws(() => packageRelease(racing), {code:"EEXIST"});
  } finally {fs.linkSync = originalLink;}
  assert.equal(fs.readFileSync(outputPath(racing), "utf8"), "winner");
  assert.deepEqual(fs.readdirSync(path.join(racing, "dist")), [path.basename(outputPath(racing))]);

  // 某些 Windows 环境禁止创建 symlink，权限不足时如实输出跳过，不冒充已验证。
  const links = createProject("links"), link = path.join(links, "assets/link.png");
  let linked = false;
  try {fs.symlinkSync(path.join(links, "assets/bytes.png"), link, "file"); linked = true;}
  catch (error) {if (!["EPERM", "EACCES"].includes(error.code)) throw error; console.log("SKIP: 当前系统不允许创建符号链接夹具");}
  if (linked) {assert.throws(() => packageRelease(links), /符号链接/); cleanDist(links);}

  console.log("PASS: " + process.platform + " 跨平台 ZIP、文件及资源类型过滤、中文路径、生产日志、完整性、失败清理及竞态无覆盖");
} finally {
  if (path.dirname(fixture) !== path.resolve(os.tmpdir()) || !path.basename(fixture).startsWith("yezhiyi-package-test-"))
    throw Error("打包测试目录超出预期");
  fs.rmSync(fixture, {recursive:true, force:true});
}
