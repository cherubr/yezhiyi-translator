/**
 * 跨平台发布 ZIP 入口：npm run package，Windows/macOS/Linux 使用同一 Node.js 实现。
 * 顺序：版本检查 → 白名单临时副本 → 临时 ZIP → 逐条读回校验 → 备份旧包 → 原子替换正式文件。
 * 不运行测试、不上传商店；重复打包自动备份旧包，require 仅导出函数，不生成文件。
 * adm-zip 是固定版本的开发依赖，不进入扩展安装包。
 */
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), {randomUUID} = require("node:crypto");
const AdmZip = require("adm-zip");
const {prepareRelease, verifyReleaseLogging} = require("./release-files.cjs");

/**
 * 读回真正的 ZIP，逐条比较路径、数量和字节，不能只验证压缩前副本。
 * 不解压到磁盘；不接受目录条目、重复条目或清单之外的路径。
 * @param {string} archive ZIP 路径。
 * @param {string} stage 本轮发布副本路径。
 * @param {string[]} files 本轮复制生成的精确文件清单。
 * @param {string} version 期望的 Manifest 版本。
 * @returns {void} 结构、全部文件内容和生产日志校验通过后返回。
 * @throws {Error} ZIP 损坏、缺少/额外文件、内容不符或日志未关闭。
 */
function verifyReleaseArchive(archive, stage, files, version) {
  const zip = new AdmZip(archive), entries = zip.getEntries();
  const expected = new Set(files), seen = new Set();
  if (entries.length !== expected.size) throw Error("安装包文件数量与发布清单不一致");
  for (const entry of entries) {
    const name = entry.entryName;
    if (entry.isDirectory || !expected.has(name) || seen.has(name))
      throw Error("安装包含非预期或重复路径：" + name);
    seen.add(name);
    // getData 会实际解压并检查 CRC，再与发布副本逐字节核对，覆盖二进制资源。
    const data = entry.getData();
    if (!data.equals(fs.readFileSync(path.join(stage, ...name.split("/")))))
      throw Error("安装包文件内容校验失败：" + name);
    if (name === "core/constants.js") verifyReleaseLogging(data.toString("utf8"));
    if (name === "manifest.json" && JSON.parse(data.toString("utf8")).version !== version)
      throw Error("安装包 Manifest 版本不一致");
  }
  if (!seen.has("manifest.json") || !seen.has("core/constants.js"))
    throw Error("安装包缺少 Manifest 或日志配置");
}

/**
 * 创建跨平台发布 ZIP；正式文件出现前已经完成全部检查。
 * @param {string} [root] 项目根目录，默认取脚本上级目录。
 * @returns {string} 通过校验的 dist/yezhiyi-translator-<版本>.zip 绝对路径。
 * @throws {Error} 版本不一致、资源缺失、压缩/校验失败、输出被占用或备份/替换失败。
 */
function packageRelease(root = path.resolve(__dirname, "..")) {
  root = path.resolve(root);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  const version = manifest.version;
  // 版本校验在创建输出目录前完成，不因无效配置留下新产物。
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version) || version === "0.0.0" ||
      version.split(".").some(n => Number(n) > 65535 || String(Number(n)) !== n))
    throw Error("无效版本");
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
  if (pkg.version !== version || lock.version !== version || lock.packages?.[""]?.version !== version)
    throw Error("Manifest、package 和锁文件版本不一致");
  const dist = path.join(root, "dist");
  const output = path.join(dist, "yezhiyi-translator-" + version + ".zip");
  fs.mkdirSync(dist, {recursive:true});
  const lockPath = output + ".lock";
  // 只允许替换普通文件，不能跟随符号链接或覆盖目录。
  const outputState = () => {
    try {
      const state = fs.lstatSync(output, {bigint:true});
      if (!state.isFile()) throw Error("同名安装包不是普通文件，请检查：" + output);
      return state;
    } catch (error) {if (error.code === "ENOENT") return null; throw error;}
  };
  let stage, pending, lockDescriptor = null;
  try {
    try {lockDescriptor = fs.openSync(lockPath, "wx");}
    catch (error) {
      if (error.code === "EEXIST") throw Error("已有同版本打包任务正在运行；若上次异常退出，请确认没有打包进程后删除：" + lockPath);
      throw error;
    }
    const previous = outputState();
    stage = fs.mkdtempSync(path.join(os.tmpdir(), "yezhiyi-release-"));
    // 临时 ZIP 与正式包在同一文件系统，最终替换不会暴露半成品。
    pending = fs.mkdtempSync(path.join(dist, ".yezhiyi-package-"));
    const files = prepareRelease(root, stage), zip = new AdmZip();
    for (const name of files) {
      // ZIP 名称固定用 /，不把 Windows 路径分隔符写入包内；权限统一为普通资源的 0644。
      zip.addFile(name, fs.readFileSync(path.join(stage, ...name.split("/"))), "", 0o644);
    }
    const temporaryZip = path.join(pending, "validated.zip");
    // wx 防止意外覆盖临时目标；正式文件名还没有出现，压缩失败不会留下半成品正式包。
    fs.writeFileSync(temporaryZip, zip.toBuffer(), {flag:"wx"});
    verifyReleaseArchive(temporaryZip, stage, files, version);
    const latest = outputState();
    if (previous ? !latest || ["dev", "ino", "size", "mtimeNs"].some(key => previous[key] !== latest[key]) : latest)
      throw Error("打包期间正式文件已被其他程序修改，请重新打包：" + output);
    if (previous) {
      const backups = path.join(dist, "backups");fs.mkdirSync(backups, {recursive:true});
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const backup = path.join(backups, path.basename(output, ".zip") + "-" + stamp + "-" + randomUUID() + ".zip");
      fs.copyFileSync(output, backup, fs.constants.COPYFILE_EXCL);
      // 先完成校验与备份再原子替换；失败时不删除旧正式包。
      fs.renameSync(temporaryZip, output);
    } else {
      // 首次发布仍不覆盖恰好由其他程序创建的文件。
      fs.linkSync(temporaryZip, output);
    }
    return output;
  } finally {
    // 清理范围仅限本轮创建的临时目录及锁，不清理旧包备份。
    try {
      if (pending) {
        if (path.dirname(pending) !== dist || !path.basename(pending).startsWith(".yezhiyi-package-"))
          throw Error("临时 ZIP 目录超出预期范围");
        fs.rmSync(pending, {recursive:true, force:true});
      }
    } finally {
      try {
        if (stage) {
          if (path.dirname(stage) !== path.resolve(os.tmpdir()) || !path.basename(stage).startsWith("yezhiyi-release-"))
            throw Error("发布副本目录超出预期范围");
          fs.rmSync(stage, {recursive:true, force:true});
        }
      } finally {
        if (lockDescriptor !== null) {
          try {fs.closeSync(lockDescriptor);}
          finally {fs.unlinkSync(lockPath);}
        }
      }
    }
  }
}

if (require.main === module) {
  try {console.log("扩展安装包（生产日志关闭并验证）：" + packageRelease());}
  catch (error) {console.error(error.message); process.exitCode = 1;}
}
module.exports = {packageRelease, verifyReleaseArchive};
