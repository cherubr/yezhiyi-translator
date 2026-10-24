/**
 * 测试模块：自定义接口授权。
 * 隔离方式：VM 中模拟 permissions 和设置页 DOM。
 * 验收范围：地址解析、用户授权/拒绝、后台权限阻断；不代替真实授权弹框验收。
 * 执行：node tests/permissions.cjs
 */
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
let allowed = true, requested = [], sent = [], fetched = 0;
const window = {};
const context = {
  window, self: window, URL, TextEncoder, setTimeout, clearTimeout, console,
  chrome: {
    permissions: {
      request(details) { requested.push(details); return Promise.resolve(allowed); },
      async contains() { return allowed; }
    },
    runtime: { async sendMessage(message) { sent.push(message); return { ok: true, data: '你好' }; } }
  }
};
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(root,'core/providers.js'),'utf8'), context);
// AI 请求构造依赖保护标记模块，与真实后台的导入保持一致。
vm.runInContext(fs.readFileSync(path.join(root,'core/translation-units.js'),'utf8'), context);
vm.runInContext(fs.readFileSync(path.join(root,'core/request-policy.js'),'utf8'), context);
const access = window.BT_AI_ACCESS;
(async () => {
  assert.equal(access.getEndpoint('openai',{}).origin,'https://api.openai.com/*');
  assert.equal(access.getEndpoint('custom',{base:'https://proxy.example.test:8443/v1/'}).base,'https://proxy.example.test:8443/v1');
  assert.equal(access.getEndpoint('custom',{base:'https://proxy.example.test:8443/v1/'}).origin,'https://proxy.example.test:8443/*');
  assert.equal(access.getEndpoint('ollama',{}).origin,'http://localhost:11434/*');
  for (const base of ['bad-url','file:///tmp/api','https://user:secret@example.test/v1','https://example.test/v1?key=secret']) {
    assert.throws(()=>access.getEndpoint('custom',{base}));
  }
  assert.throws(()=>access.getEndpoint('custom',{base:'http://remote.example.test/v1'}),/HTTPS/);
  assert.equal(access.getEndpoint('custom',{base:'http://127.0.0.1:8080/v1'}).origin,'http://127.0.0.1:8080/*');
  const task=access.request('custom',{base:'https://proxy.example.test/v1'});
  assert.equal(requested.length,1,'permission requested synchronously in click call chain');
  await task;
  allowed=false;
  await assert.rejects(access.request('custom',{base:'https://proxy.example.test/v1'}),/未获得/);

  const resultEl={};
  Object.assign(context,{
    cfg:{aiProvider:'custom',aiKeys:{}}, editingProvider:'custom',
    PROVIDERS:window.AI_PROVIDERS,
    document:{getElementById:()=>resultEl},
    refreshDefaultServiceButton:()=>{},
    readProviderInputs:()=>({key:'test-key',base:'https://proxy.example.test/v1',model:'test-model'})
  });
  const settings=fs.readFileSync(path.join(root,'settings/settings.js'),'utf8');
  const testStart=settings.indexOf('async function runTest('),testEnd=settings.indexOf('function bindNav(');
  assert.ok(testStart>=0&&testEnd>testStart,'设置页测试方法及边界必须存在');
  vm.runInContext(settings.slice(testStart,testEnd),context);
  const btn={disabled:false};
  await context.runTest('ai','result',btn);
  assert.equal(sent.length,0,'denied access does not send translation');
  assert.equal(btn.disabled,false);
  assert.match(resultEl.textContent,/未获得/);
  allowed=true;
  await context.runTest('ai','result',btn);
  assert.equal(sent.length,1);
  assert.equal(sent[0].aiConfig.base,'https://proxy.example.test/v1');
  assert.equal(sent[0].aiProvider,'custom');

  window.BT_STORAGE={async get(){return {aiProvider:'custom',aiKeys:{custom:{key:'test',base:'https://proxy.example.test/v1'}}};}};
  context.fetchWithTimeout=async()=>{fetched++;return {ok:true,async json(){return {choices:[{message:{content:'译文'}}]};}};};
  const worker=fs.readFileSync(path.join(root,'background/service-worker.js'),'utf8');
  const aiStart=worker.indexOf('async function translateAI('),aiEnd=worker.indexOf('async function fetchWithTimeout(');
  assert.ok(aiStart>=0&&aiEnd>aiStart,'AI 请求方法及网络封装边界必须存在');
  vm.runInContext(worker.slice(aiStart,aiEnd),context);
  allowed=false;
  await assert.rejects(context.translateAI('text','en','zh-CN'),/尚未授权/);
  assert.equal(fetched,0,'background does not fetch without permission');
  allowed=true;
  assert.equal(await context.translateAI('text','en','zh-CN'),'译文');
  assert.equal(fetched,1);
  console.log('PASS: 域名解析、同步授权、授权拒绝阻断、设置页测试、后台权限检查');
})().catch(error=>{console.error(error);process.exitCode=1;});