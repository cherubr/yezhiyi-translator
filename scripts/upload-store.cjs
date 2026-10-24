const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API_URL = 'https://chromewebstore.googleapis.com';
const SCOPE = 'https://www.googleapis.com/auth/chromewebstore';

/** 读取发布版本和安装包路径，要求标签、Manifest 和开发包版本完全一致。 */
function readRelease(root, tag) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const version = manifest.version;
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version) ||
      version.split('.').some(n => Number(n) > 65535 || String(Number(n)) !== n) ||
      version === '0.0.0' || pkg.version !== version) {
    throw new Error('Manifest 与 package.json 必须使用一致且有效的三段版本号');
  }
  if (tag !== 'v' + version) throw new Error('发布标签必须与版本一致：v' + version);
  return { version, filePath: path.join(root, 'dist', 'yezhiyi-translator-' + version + '.zip') };
}

/** 从环境读取三个 GitHub Secrets；只校验和返回，禁止打印原始 JSON 或私钥。 */
function readCredentials(env) {
  for (const name of ['CWS_SERVICE_ACCOUNT_JSON', 'CWS_PUBLISHER_ID', 'CWS_EXTENSION_ID']) {
    if (!env[name]?.trim()) throw new Error('请配置 GitHub Actions Secret：' + name);
  }
  let serviceAccount;
  try { serviceAccount = JSON.parse(env.CWS_SERVICE_ACCOUNT_JSON); }
  catch (_) { throw new Error('CWS_SERVICE_ACCOUNT_JSON 不是有效 JSON'); }
  if (!serviceAccount || serviceAccount.type !== 'service_account' ||
      typeof serviceAccount.client_email !== 'string' ||
      !/^[^\s@]+@[^\s@]+\.iam\.gserviceaccount\.com$/.test(serviceAccount.client_email) ||
      typeof serviceAccount.private_key !== 'string') {
    throw new Error('请使用 Google 服务账号的 JSON 密钥文件内容');
  }
  const publisherId = env.CWS_PUBLISHER_ID.trim(), extensionId = env.CWS_EXTENSION_ID.trim();
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(publisherId)) throw new Error('CWS_PUBLISHER_ID 格式无效');
  if (!/^[a-p]{32}$/.test(extensionId)) throw new Error('CWS_EXTENSION_ID 必须是商店条目的 32 位扩展 ID');
  return { serviceAccount, publisherId, extensionId };
}

/** 使用 Node 内置 RSA 签名构造服务账号断言；授权端点与范围固定，不信任 JSON 内的自定义 token_uri。 */
function createAssertion(serviceAccount, now = Date.now) {
  const issuedAt = Math.floor(now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const claims = Buffer.from(JSON.stringify({ iss: serviceAccount.client_email, scope: SCOPE,
    aud: TOKEN_URL, iat: issuedAt, exp: issuedAt + 3600 })).toString('base64url');
  const input = header + '.' + claims;
  try {
    const key = crypto.createPrivateKey(serviceAccount.private_key);
    if (key.asymmetricKeyType !== 'rsa') throw new Error('Unsupported key');
    return input + '.' + crypto.sign('RSA-SHA256', Buffer.from(input), key).toString('base64url');
  } catch (_) { throw new Error('服务账号私钥无效，请重新检查 CWS_SERVICE_ACCOUNT_JSON'); }
}

/** 发送带截止时间的请求；不跟随重定向，不输出令牌、请求正文或服务端任意错误内容。 */
async function requestJson(fetchImpl, url, options, label) {
  let response;
  try {
    response = await fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(60000) });
  } catch (_) { throw new Error(label + '连接失败或超时，请检查网络和服务状态'); }
  if (!response.ok) throw new Error(label + '失败（HTTP ' + response.status + '），请检查服务账号授权、API 启用和商店版本');
  try { return await response.json(); }
  catch (_) { throw new Error(label + '未返回有效 JSON，请到商店后台检查状态'); }
}

/**
 * 仅上传已有商店条目的安装包；处理中时查询状态，不调用提交审核或发布接口。
 * @param {Object} config 已校验的凭据、版本和安装包路径。
 * @param {Object} [options={}] 测试可注入 fetch、等待函数、时钟与轮询次数。
 * @returns {Promise<Object>} 上传处理成功后的版本和状态；失败或超时拒绝。
 */
async function uploadDraft(config, options = {}) {
  const { filePath, version, publisherId, extensionId, serviceAccount } = config;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const maxPolls = options.maxPolls ?? 24, pollIntervalMs = options.pollIntervalMs ?? 5000;
  const zip = fs.readFileSync(filePath);
  if (zip.length < 4 || zip.readUInt32LE(0) !== 0x04034b50) throw new Error('待上传文件不是有效的非空 ZIP 安装包');
  const token = await requestJson(fetchImpl, TOKEN_URL, { method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: createAssertion(serviceAccount, options.now) }) }, 'Google 授权');
  if (typeof token?.access_token !== 'string' || !token.access_token.trim()) throw new Error('Google 授权未返回访问令牌');
  const name = 'publishers/' + publisherId + '/items/' + extensionId;
  const headers = { Authorization: 'Bearer ' + token.access_token };
  const uploaded = await requestJson(fetchImpl, API_URL + '/upload/v2/' + name + ':upload', {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/zip' }, body: zip
  }, '商店安装包上传');
  if (uploaded?.itemId && uploaded.itemId !== extensionId) throw new Error('上传响应的扩展 ID 不匹配，请检查商店条目');
  if (uploaded?.crxVersion && uploaded.crxVersion !== version) throw new Error('商店识别的安装包版本与当前标签不一致');
  // V2 枚举使用 IN_PROGRESS；上传方法文档也保留了 UPLOAD_IN_PROGRESS 的说明。
  const stateOf = value => value === 'UPLOAD_IN_PROGRESS' ? 'IN_PROGRESS' : value;
  let state = stateOf(uploaded?.uploadState);
  for (let count = 0; state === 'IN_PROGRESS' && count < maxPolls; count++) {
    await sleep(pollIntervalMs);
    const status = await requestJson(fetchImpl, API_URL + '/v2/' + name + ':fetchStatus',
      { method: 'GET', headers }, '商店上传状态查询');
    if (status?.itemId && status.itemId !== extensionId) throw new Error('上传状态的扩展 ID 不匹配');
    state = stateOf(status?.lastAsyncUploadState);
  }
  if (state === 'IN_PROGRESS') throw new Error('商店仍在处理上传，请到开发者后台确认；本流程未提交审核');
  if (state !== 'SUCCEEDED') throw new Error('商店未确认上传成功，请检查版本是否递增及开发者后台的安装包错误');
  return { version, state, extensionId, sha256: crypto.createHash('sha256').update(zip).digest('hex') };
}

/** 校验标签对应代码已进入 main；只读 Git 历史，不合并分支、不推送标签。 */
function checkReleaseSource(root, env) {
  if (env.GITHUB_EVENT_NAME === 'workflow_dispatch' && env.GITHUB_REF !== 'refs/heads/main') {
    throw new Error('手动运行请在 Actions 中选择 main 分支，再填写已存在的版本标签');
  }
  try { execFileSync('git', ['merge-base', '--is-ancestor', 'HEAD', 'refs/remotes/origin/main'],
    { cwd: root, stdio: 'ignore' }); }
  catch (_) { throw new Error('标签对应提交尚未合入远程 main，或缺少 main 历史，停止上传'); }
}

/** 执行来源/凭据检查或真实草稿上传；真实请求前再次核对 main 归属。 */
async function main() {
  const root = path.resolve(__dirname, '..');
  const release = readRelease(root, process.env.RELEASE_TAG);
  if (process.argv.includes('--check-release')) {
    checkReleaseSource(root, process.env);
    console.log('发布来源检查通过：v' + release.version + '，代码已合入 main');
    return;
  }
  const credentials = readCredentials(process.env);
  if (process.argv.includes('--check-config')) {
    createAssertion(credentials.serviceAccount);
    console.log('上传配置格式检查通过；账号权限将在真实请求中验证');
    return;
  }
  checkReleaseSource(root, process.env);
  const result = await uploadDraft({ ...release, ...credentials });
  console.log('已上传商店草稿：' + result.version + '；未提交审核或发布。SHA256：' + result.sha256);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    '### Chrome 商店草稿上传成功\n\n版本：`' + result.version + '`\n\nSHA256：`' + result.sha256 +
    '`\n\n请到 Chrome 商店开发者后台检查草稿，并按需手动提交审核。\n');
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { readRelease, readCredentials, createAssertion, uploadDraft, checkReleaseSource };
