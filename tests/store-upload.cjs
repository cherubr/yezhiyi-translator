/**
 * 商店上传回归：模拟 Google 授权和 V2 上传，不连接真实接口或使用真实服务账号。
 * 验收签名、版本、失败阻断、异步处理状态，以及始终不调用审核/发布接口。
 * 执行：node tests/store-upload.cjs
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { readRelease, readCredentials, createAssertion, uploadDraft, checkReleaseSource } = require('../scripts/upload-store.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yezhiyi-store-test-'));
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const serviceAccount = { type: 'service_account', client_email: 'test@project.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), token_uri: 'https://untrusted.example/token' };
const env = { CWS_SERVICE_ACCOUNT_JSON: JSON.stringify(serviceAccount), CWS_PUBLISHER_ID: 'publisher-id',
  CWS_EXTENSION_ID: 'a'.repeat(32) };
const response = data => ({ ok: true, status: 200, async json() { return data; } });

(async () => {
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ version: '1.0.1' }));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '1.0.1' }));
  const release = readRelease(root, 'v1.0.1');
  assert.equal(release.version, '1.0.1');
  assert.throws(() => readRelease(root, 'v1.0.0'), /标签必须与版本一致/);
  assert.throws(() => readCredentials({}), /GitHub Actions Secret/);
  assert.throws(() => readCredentials({ ...env, CWS_SERVICE_ACCOUNT_JSON: 'bad' }), /有效 JSON/);
  assert.throws(() => readCredentials({ ...env, CWS_EXTENSION_ID: '../bad' }), /32 位/);
  assert.throws(() => createAssertion({ ...serviceAccount, private_key: 'bad-key' }), /私钥无效/);
  const now = () => 1800000000000;
  const assertion = createAssertion(serviceAccount, now);
  const [header, claims, signature] = assertion.split('.');
  assert.equal(crypto.verify('RSA-SHA256', Buffer.from(header + '.' + claims), publicKey, Buffer.from(signature, 'base64url')), true);
  const decoded = JSON.parse(Buffer.from(claims, 'base64url'));
  assert.equal(decoded.aud, 'https://oauth2.googleapis.com/token');
  assert.equal(decoded.scope, 'https://www.googleapis.com/auth/chromewebstore');
  assert.equal(decoded.iat, now() / 1000); assert.equal(decoded.exp - decoded.iat, 3600);
  // 用独立临时 Git 仓库验证 main 归属；禁用签名和外部 hooks，不触碰项目仓库。
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Store upload test',
    '-c', 'user.email=store-test@example.invalid', '-c', 'commit.gpgSign=false',
    '-c', 'core.hooksPath=' + path.join(root, 'disabled-hooks'), ...args], { cwd: root, stdio: 'pipe' });
  assert.throws(() => checkReleaseSource(root, { GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/dev' }), /选择 main/);
  git('init', '--quiet'); git('add', '--', 'manifest.json', 'package.json'); git('commit', '--quiet', '-m', 'fixture');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  assert.doesNotThrow(() => checkReleaseSource(root, { GITHUB_EVENT_NAME: 'push' }));
  assert.doesNotThrow(() => checkReleaseSource(root, { GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main' }));
  git('commit', '--allow-empty', '--quiet', '-m', 'not in main');
  assert.throws(() => checkReleaseSource(root, { GITHUB_EVENT_NAME: 'push' }), /尚未合入/);
  fs.mkdirSync(path.dirname(release.filePath));
  fs.writeFileSync(release.filePath, Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2]));
  const config = { ...release, ...readCredentials(env) };
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url === 'https://oauth2.googleapis.com/token') return response({ access_token: 'test-access-token' });
    return response({ itemId: env.CWS_EXTENSION_ID, crxVersion: '1.0.1', uploadState: 'SUCCEEDED' });
  };
  const result = await uploadDraft(config, { fetchImpl, now });
  assert.equal(result.state, 'SUCCEEDED'); assert.match(result.sha256, /^[a-f0-9]{64}$/);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, 'https://chromewebstore.googleapis.com/upload/v2/publishers/publisher-id/items/' + env.CWS_EXTENSION_ID + ':upload');
  assert.equal(calls[1].options.headers.Authorization, 'Bearer test-access-token');
  assert.equal(Buffer.isBuffer(calls[1].options.body), true);
  assert.equal(calls[1].options.redirect, 'error');
  assert.equal(calls[0].options.body.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  assert.equal(calls[0].options.body.get('assertion'), assertion);

  let polls = 0, sleeps = 0;
  const pendingCalls = [];
  const pendingFetch = async (url, options) => {
    pendingCalls.push({ url, method: options.method });
    if (url.includes('oauth2')) return response({ access_token: 'token' });
    if (url.endsWith(':upload')) return response({ uploadState: 'IN_PROGRESS' });
    return response({ itemId: env.CWS_EXTENSION_ID, lastAsyncUploadState: ++polls === 1 ? 'IN_PROGRESS' : 'SUCCEEDED' });
  };
  await uploadDraft(config, { fetchImpl: pendingFetch, sleep: async () => { sleeps++; } });
  assert.equal(polls, 2); assert.equal(sleeps, 2);
  assert.equal(pendingCalls.filter(c => c.url.endsWith(':upload')).length, 1, '处理中不能重复上传');
  assert.ok(pendingCalls.every(c => !c.url.endsWith(':publish') && !c.url.includes('cancelSubmission')));
  assert.ok(pendingCalls.slice(2).every(c => c.method === 'GET'));

  const uploadResponse = data => async url => url.includes('oauth2') ? response({ access_token: 'token' }) : response(data);
  await assert.rejects(uploadDraft(config, { fetchImpl: uploadResponse({ uploadState: 'FAILED' }) }), /未确认上传成功/);
  await assert.rejects(uploadDraft(config, { fetchImpl: uploadResponse({ uploadState: 'UNKNOWN' }) }), /未确认上传成功/);
  await assert.rejects(uploadDraft(config, { fetchImpl: uploadResponse(null) }), /未确认上传成功/);
  await assert.rejects(uploadDraft(config, { fetchImpl: uploadResponse({ crxVersion: '1.0.0', uploadState: 'SUCCEEDED' }) }), /版本与当前标签不一致/);
  await assert.rejects(uploadDraft(config, { fetchImpl: uploadResponse({ itemId: 'b'.repeat(32), uploadState: 'SUCCEEDED' }) }), /扩展 ID 不匹配/);
  await assert.rejects(uploadDraft(config, { fetchImpl: async () => ({ ok: false, status: 403 }) }), /HTTP 403/);
  await assert.rejects(uploadDraft(config, { fetchImpl: async () => { throw Error('private-response'); } }), error => !error.message.includes('private-response'));
  await assert.rejects(uploadDraft(config, { fetchImpl: async () => response({}) }), /未返回访问令牌/);
  await assert.rejects(uploadDraft(config, { fetchImpl: uploadResponse({ uploadState: 'IN_PROGRESS', lastAsyncUploadState: 'IN_PROGRESS' }),
    sleep: async () => {}, maxPolls: 2 }), /商店仍在处理/);
  const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/chrome-store-upload.yml'), 'utf8');
  assert.match(workflow, /contents: read/); assert.match(workflow, /cancel-in-progress: false/);
  assert.ok(!workflow.includes(':publish') && !workflow.includes('store:publish'));
  assert.ok(!require('../scripts/release-files.cjs').RELEASE_FILES.includes('scripts'));
  console.log('PASS: 商店上传版本校验、RSA 授权、ZIP 传输、异步状态、错误阻断、隐私及仅上传不送审');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('yezhiyi-store-test-')) throw Error('临时目录校验失败');
  fs.rmSync(root, { recursive: true, force: true });
});
