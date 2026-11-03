/**
 * Chrome 商店草稿上传工具，主要由 chrome-store-upload.yml 调用。
 * 必需环境：RELEASE_TAG、CWS_SERVICE_ACCOUNT_JSON、CWS_PUBLISHER_ID、CWS_EXTENSION_ID。
 * --check-release 只检查版本和 main 归属；--check-config 检查版本及凭据/签名格式；
 * 未传这两个参数时会真实授权、读取现有 ZIP 并上传草稿，不会自动打包。
 * 所有分支均不提交审核、不发布；测试通过导出函数及注入依赖模拟远端接口。
 */
// 仅使用 Node 内置模块：读取 ZIP/版本、拼接路径、RSA 签名/哈希及只读 Git 查询。
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

// 固定授权端点、商店 API 与最小业务范围，不从服务账号 JSON 的地址字段取值。
// 防止误配置 token_uri 后把签名断言或令牌发送到非预期服务器。
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API_URL = "https://chromewebstore.googleapis.com";
const SCOPE = "https://www.googleapis.com/auth/chromewebstore";

/**
 * 读取发布版本并计算待上传 ZIP 路径，不生成或打开安装包。
 * @param {string} root 项目根目录。
 * @param {string} tag 本次发布标签，必须严格等于 v + 版本号。
 * @returns {{version: string, filePath: string}} 版本及 dist 内的安装包路径。
 * @throws {Error} 版本格式、取值范围、package 一致性或标签不满足约束。
 */
function readRelease(root, tag) {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, "manifest.json"), "utf8"),
  );
  const pkg = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8"),
  );
  const version = manifest.version;
  // 使用项目约定的三段版本；逐段拒绝超过 65535、前导零及 0.0.0，
  // 同时要求 package 与 Manifest 一致，不在上传时自动修改源码版本。
  if (
    typeof version !== "string" ||
    !/^\d+\.\d+\.\d+$/.test(version) ||
    version
      .split(".")
      .some((n) => Number(n) > 65535 || String(Number(n)) !== n) ||
    version === "0.0.0" ||
    pkg.version !== version
  ) {
    throw new Error("Manifest 与 package.json 必须使用一致且有效的三段版本号");
  }
  // 先固定标签/版本，避免以错误版本名上传其他安装包。
  if (tag !== "v" + version)
    throw new Error("发布标签必须与版本一致：v" + version);
  return {
    version,
    filePath: path.join(root, "dist", "yezhiyi-translator-" + version + ".zip"),
  };
}

/**
 * 从环境读取 GitHub Actions 注入的三个 Secrets，仅做本机格式校验。
 * @param {Object} env 环境变量对象；测试传入模拟对象，不必读取真实 process.env。
 * @returns {Object} serviceAccount、publisherId、extensionId，均可能包含敏感信息。
 * @throws {Error} 缺少字段、JSON 无效、账号类型或 ID 格式不符。
 * 返回对象不可完整写入日志；格式正确不等于账号已获商店权限。
 */
function readCredentials(env) {
  // 先检查必填项，只报告变量名称，不回显实际值。
  for (const name of [
    "CWS_SERVICE_ACCOUNT_JSON",
    "CWS_PUBLISHER_ID",
    "CWS_EXTENSION_ID",
  ]) {
    if (!env[name]?.trim())
      throw new Error("请配置 GitHub Actions Secret：" + name);
  }
  let serviceAccount;
  // JSON 解析异常转为固定提示，避免输出包含密钥的原始输入。
  try {
    serviceAccount = JSON.parse(env.CWS_SERVICE_ACCOUNT_JSON);
  } catch (_) {
    throw new Error("CWS_SERVICE_ACCOUNT_JSON 不是有效 JSON");
  }
  // 这里只检查服务账号身份和私钥字段类型；RSA 私钥可用性稍后签名时验证。
  if (
    !serviceAccount ||
    serviceAccount.type !== "service_account" ||
    typeof serviceAccount.client_email !== "string" ||
    !/^[^\s@]+@[^\s@]+\.iam\.gserviceaccount\.com$/.test(
      serviceAccount.client_email,
    ) ||
    typeof serviceAccount.private_key !== "string"
  ) {
    throw new Error("请使用 Google 服务账号的 JSON 密钥文件内容");
  }
  const publisherId = env.CWS_PUBLISHER_ID.trim(),
    extensionId = env.CWS_EXTENSION_ID.trim();
  // 约束将要拼入 API 资源路径的 ID；扩展 ID 固定为 32 个 a-p 字符。
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(publisherId))
    throw new Error("CWS_PUBLISHER_ID 格式无效");
  if (!/^[a-p]{32}$/.test(extensionId))
    throw new Error("CWS_EXTENSION_ID 必须是商店条目的 32 位扩展 ID");
  return { serviceAccount, publisherId, extensionId };
}

/**
 * 构造服务账号 JWT 断言，稍后用它向 Google 换取访问令牌。
 * @param {Object} serviceAccount 已校验格式的服务账号，包含邮箱和 RSA 私钥。
 * @param {Function} [now=Date.now] 返回毫秒时间戳，测试可注入固定时钟。
 * @returns {string} header.claims.signature 形式的敏感断言，不可打印。
 * @throws {Error} 私钥无法读取、类型不是 RSA 或签名失败。
 */
function createAssertion(serviceAccount, now = Date.now) {
  // JWT 时间以秒为单位；当前断言有效期一小时，不读取 JSON 内的 token_uri。
  const issuedAt = Math.floor(now() / 1000);
  // base64url 使用 URL 安全字符，分别编码算法头与授权声明。
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", typ: "JWT" }),
  ).toString("base64url");
  // iss=服务账号，scope=商店权限，aud=固定 Google 授权端点，iat/exp=签发/到期。
  const claims = Buffer.from(
    JSON.stringify({
      iss: serviceAccount.client_email,
      scope: SCOPE,
      aud: TOKEN_URL,
      iat: issuedAt,
      exp: issuedAt + 3600,
    }),
  ).toString("base64url");
  const input = header + "." + claims;
  try {
    const key = crypto.createPrivateKey(serviceAccount.private_key);
    if (key.asymmetricKeyType !== "rsa") throw new Error("Unsupported key");
    // 只对前两段的原始拼接结果签名，生成第三段；私钥不直接放入请求正文。
    return (
      input +
      "." +
      crypto.sign("RSA-SHA256", Buffer.from(input), key).toString("base64url")
    );
  } catch (_) {
    throw new Error("服务账号私钥无效，请重新检查 CWS_SERVICE_ACCOUNT_JSON");
  }
}

/**
 * 发送单次请求并解析 JSON；不自动重试、不跟随重定向，避免重复上传或泄露认证信息。
 * @param {Function} fetchImpl fetch 实现；生产使用全局 fetch，测试使用模拟函数。
 * @param {string} url 固定可信端点及经过校验的资源路径。
 * @param {Object} options 方法、请求头和正文；可能包含令牌/签名，不可打印。
 * @param {string} label 面向用户的操作名，例如“Google 授权”。
 * @returns {Promise<Object>} 已解析的 JSON，具体字段由调用者继续检查。
 * @throws {Error} 网络/超时、HTTP 非成功或 JSON 解析失败，均转换为固定说明。
 */
async function requestJson(fetchImpl, url, options, label) {
  let response;
  try {
    // 最后设置 redirect/signal，调用者不能覆盖禁止跳转及每次 60 秒的截止限制。
    response = await fetchImpl(url, {
      ...options,
      redirect: "error",
      signal: AbortSignal.timeout(60000),
    });
  } catch (_) {
    throw new Error(label + "连接失败或超时，请检查网络和服务状态");
  }
  // 不回显服务端任意错误正文，避免它包含请求信息、令牌或其他敏感数据。
  if (!response.ok)
    throw new Error(
      label +
        "失败（HTTP " +
        response.status +
        "），请检查服务账号授权、API 启用和商店版本",
    );
  try {
    return await response.json();
  } catch (_) {
    throw new Error(label + "未返回有效 JSON，请到商店后台检查状态");
  }
}

/**
 * 仅上传已有商店条目的安装包；处理中时查询状态，不调用提交审核或发布接口。
 * @param {Object} config 已校验的凭据、版本和安装包路径。
 * @param {string} config.filePath 已存在 ZIP 的本机路径，不在此函数内打包。
 * @param {string} config.version 已通过标签一致性检查的预期版本。
 * @param {string} config.publisherId 商店发布者 ID。
 * @param {string} config.extensionId 已有商店条目的扩展 ID。
 * @param {Object} config.serviceAccount 用于 Google 授权的服务账号，不可打印。
 * @param {Object} [options={}] 测试可注入 fetch、等待函数、时钟与轮询次数。
 * @param {Function} [options.fetchImpl] 替换真实 fetch，用于模拟授权和上传。
 * @param {Function} [options.sleep] 替换轮询等待，用于无需真实等待的测试。
 * @param {Function} [options.now] 固定 JWT 签发时间的毫秒时钟。
 * @param {number} [options.maxPolls=24] 上传处理中最多查询的次数。
 * @param {number} [options.pollIntervalMs=5000] 每次查询前等待的毫秒数。
 * @returns {Promise<Object>} 上传处理成功后的版本和状态；失败或超时拒绝。
 */
async function uploadDraft(config, options = {}) {
  const { filePath, version, publisherId, extensionId, serviceAccount } =
    config;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  // 默认每次查询前等五秒；轮询次数限制不是整个流程的总超时，网络耗时另算。
  const sleep =
    options.sleep ||
    ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const maxPolls = options.maxPolls ?? 24,
    pollIntervalMs = options.pollIntervalMs ?? 5000;
  const zip = fs.readFileSync(filePath);
  // 只验证 ZIP 本地文件头，避免把明显错误文件上传；不是完整解压或包内容验证。
  // 正式包的生产日志和实际资源应已由 package.cjs 在打包阶段检查。
  if (zip.length < 4 || zip.readUInt32LE(0) !== 0x04034b50)
    throw new Error("待上传文件不是有效的非空 ZIP 安装包");
  // 服务账号私钥在本机签名，只把断言作为 OAuth 表单发送，换取短期 Bearer 令牌。
  const token = await requestJson(
    fetchImpl,
    TOKEN_URL,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: createAssertion(serviceAccount, options.now),
      }),
    },
    "Google 授权",
  );
  if (typeof token?.access_token !== "string" || !token.access_token.trim())
    throw new Error("Google 授权未返回访问令牌");
  // name 定位已有条目；这个流程不会新建商店条目、修改介绍或上传商店截图。
  const name = "publishers/" + publisherId + "/items/" + extensionId;
  const headers = { Authorization: "Bearer " + token.access_token };
  // 整个流程仅发一次上传 POST；服务端异步处理时只查状态，不能重新上传同一包。
  const uploaded = await requestJson(
    fetchImpl,
    API_URL + "/upload/v2/" + name + ":upload",
    {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/zip" },
      body: zip,
    },
    "商店安装包上传",
  );
  // 响应提供身份或版本时必须一致；字段缺省不代表失败，继续检查上传状态。
  if (uploaded?.itemId && uploaded.itemId !== extensionId)
    throw new Error("上传响应的扩展 ID 不匹配，请检查商店条目");
  if (uploaded?.crxVersion && uploaded.crxVersion !== version)
    throw new Error("商店识别的安装包版本与当前标签不一致");
  // V2 枚举使用 IN_PROGRESS；上传方法文档也保留了 UPLOAD_IN_PROGRESS 的说明。
  const stateOf = (value) =>
    value === "UPLOAD_IN_PROGRESS" ? "IN_PROGRESS" : value;
  let state = stateOf(uploaded?.uploadState);
  // 仅处理中才轮询；成功会直接结束，失败或未知状态在循环后统一阻断。
  for (let count = 0; state === "IN_PROGRESS" && count < maxPolls; count++) {
    await sleep(pollIntervalMs);
    const status = await requestJson(
      fetchImpl,
      API_URL + "/v2/" + name + ":fetchStatus",
      { method: "GET", headers },
      "商店上传状态查询",
    );
    if (status?.itemId && status.itemId !== extensionId)
      throw new Error("上传状态的扩展 ID 不匹配");
    // 状态查询使用 lastAsyncUploadState，不能误读上传响应中的 uploadState 字段。
    state = stateOf(status?.lastAsyncUploadState);
  }
  // 超过轮询次数不宣称成功，也不继续重复上传；交由开发者到后台确认。
  if (state === "IN_PROGRESS")
    throw new Error("商店仍在处理上传，请到开发者后台确认；本流程未提交审核");
  if (state !== "SUCCEEDED")
    throw new Error(
      "商店未确认上传成功，请检查版本是否递增及开发者后台的安装包错误",
    );
  // 哈希针对真正上传的 ZIP 字节，不是 GitHub Artifact 外层下载 ZIP。
  return {
    version,
    state,
    extensionId,
    sha256: crypto.createHash("sha256").update(zip).digest("hex"),
  };
}

/**
 * 校验当前检出的标签代码已进入远程 main 的本地引用，不合并、不 fetch、不推送。
 * 工作流必须预先检出目标标签并获取完整历史；本函数不会自行解析 RELEASE_TAG 切换代码。
 * @param {string} root Git 仓库根目录。
 * @param {Object} env 工作流事件和触发分支环境，用于限制手动入口。
 * @returns {void} 手动入口和祖先关系均满足要求后返回。
 * @throws {Error} 手动未选 main、提交未进入 main 或远程引用/历史不足。
 */
function checkReleaseSource(root, env) {
  // 手动工作流选择 main 作为流程来源，实际待上传代码由 checkout 的标签决定。
  if (
    env.GITHUB_EVENT_NAME === "workflow_dispatch" &&
    env.GITHUB_REF !== "refs/heads/main"
  ) {
    throw new Error(
      "手动运行请在 Actions 中选择 main 分支，再填写已存在的版本标签",
    );
  }
  // --is-ancestor 返回成功说明 HEAD 可从 origin/main 历史到达；只读查询，不改 Git。
  // stdio:ignore 不把原始 Git 错误传到输出，统一给用户可操作的检查提示。
  try {
    execFileSync(
      "git",
      ["merge-base", "--is-ancestor", "HEAD", "refs/remotes/origin/main"],
      { cwd: root, stdio: "ignore" },
    );
  } catch (_) {
    throw new Error(
      "标签对应提交尚未合入远程 main，或缺少 main 历史，停止上传",
    );
  }
}

/**
 * 命令行总入口，检查选项以提前 return 阻止真实上传。
 * @returns {Promise<void>} 输出检查/上传结果，可向 GitHub Step Summary 追加摘要。
 * @throws {Error} 任何阶段失败均交给入口 catch，设置命令失败状态。
 */
async function main() {
  const root = path.resolve(__dirname, "..");
  // 即使只检查配置，也先要求 RELEASE_TAG 与代码版本一致。
  const release = readRelease(root, process.env.RELEASE_TAG);
  if (process.argv.includes("--check-release")) {
    // 来源检查不读取上传 Secrets，不签名，也不访问商店网络。
    checkReleaseSource(root, process.env);
    console.log("发布来源检查通过：v" + release.version + "，代码已合入 main");
    return;
  }
  const credentials = readCredentials(process.env);
  if (process.argv.includes("--check-config")) {
    // 生成一次本机签名以验证私钥格式；不检查 main 归属或真实账号权限，不换取令牌。
    createAssertion(credentials.serviceAccount);
    console.log("上传配置格式检查通过；账号权限将在真实请求中验证");
    return;
  }
  // 真正上传前再次执行来源校验，不依赖工作流早先检查的结果。
  checkReleaseSource(root, process.env);
  const result = await uploadDraft({ ...release, ...credentials });
  console.log(
    "已上传商店草稿：" +
      result.version +
      "；未提交审核或发布。SHA256：" +
      result.sha256,
  );
  // 只有确认 SUCCEEDED 后才写 Actions 摘要；记录版本与包哈希，不写凭据或令牌。
  // 若摘要写入失败，命令也会失败，但远端已经成功上传，不会自动回滚商店草稿。
  if (process.env.GITHUB_STEP_SUMMARY)
    fs.appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      "### Chrome 商店草稿上传成功\n\n版本：`" +
        result.version +
        "`\n\nSHA256：`" +
        result.sha256 +
        "`\n\n请到 Chrome 商店开发者后台检查草稿，并按需手动提交审核。\n",
    );
}

// require 时只导出可测试函数；直接运行才进入可能产生真实上传的命令行流程。
// 对外仅输出已整理的错误 message，避免把包含上下文的整个错误对象直接打印。
if (require.main === module)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
module.exports = {
  readRelease,
  readCredentials,
  createAssertion,
  uploadDraft,
  checkReleaseSource,
};
