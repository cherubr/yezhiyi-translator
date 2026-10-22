// 权限回归：验证接口地址解析、用户点击授权、拒绝授权阻断及后台访问检查。
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
  vm.runInContext(settings.slice(settings.indexOf('async function runTest('),settings.indexOf('// ---------- 导航 ----------')),context);
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
  vm.runInContext(worker.slice(worker.indexOf('async function translateAI('),worker.indexOf('// 为网络请求设置超时')),context);
  allowed=false;
  await assert.rejects(context.translateAI('text','en','zh-CN'),/尚未授权/);
  assert.equal(fetched,0,'background does not fetch without permission');
  allowed=true;
  assert.equal(await context.translateAI('text','en','zh-CN'),'译文');
  assert.equal(fetched,1);
  console.log('PASS: 域名解析、同步授权、授权拒绝阻断、设置页测试、后台权限检查');
})().catch(error=>{console.error(error);process.exitCode=1;});