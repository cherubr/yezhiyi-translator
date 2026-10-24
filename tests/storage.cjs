/**
 * 测试模块：共享存储与旧配置迁移。
 * 隔离方式：内存 sync/local 分区及可注入写入失败。
 * 验收范围：本机密钥优先、迁移成功后删除旧值、失败保留、普通样式偏好同步。
 * 执行：node tests/storage.cjs
 */
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync(require('node:path').join(__dirname, '../core/constants.js'), 'utf8');
/**
 * 创建隔离的 sync/local 内存存储，记录写入顺序并按场景注入迁移失败。
 */
function setup(syncData, localData = {}, failWrite = false) {
  const sync = structuredClone(syncData), local = structuredClone(localData);
  const writes = [];
  /**
   * 生成单个存储区的 get/set/remove 模拟接口，记录操作以检查分流顺序。
   */
  function area(data, name) {
    return {
      async get(keys) { return Object.fromEntries(keys.filter(k => Object.hasOwn(data, k)).map(k => [k, structuredClone(data[k])])); },
      async set(values) {
        if (name === 'local' && failWrite) throw new Error('local write failed');
        writes.push({ name, values: structuredClone(values) });
        Object.assign(data, structuredClone(values));
      },
      async remove(keys) { keys.forEach(k => delete data[k]); }
    };
  }
  const window = {};
  vm.runInNewContext(source, { window, chrome: { storage: { sync: area(sync, 'sync'), local: area(local, 'local') } } });
  return { storage: window.BT_STORAGE, sync, local, writes };
}
(async () => {
  const t = setup({ engine: 'ai', aiProvider: 'openai', aiKeys: { openai: { key: 'old' }, deepseek: { key: 'other' } }, baiduAppId: 'app', baiduKey: 'secret' }, { aiKeys: { openai: { key: '' } } });
  const cfg = await t.storage.get();
  assert.equal(cfg.aiKeys.openai.key, '', 'explicit local clearing wins');
  assert.equal(cfg.aiKeys.deepseek.key, 'other');
  assert.equal(cfg.baiduKey, 'secret');
  assert.equal(t.sync.aiKeys, undefined);
  assert.equal(t.sync.baiduKey, undefined);
  assert.equal(t.sync.baiduAppId, undefined);
  await t.storage.set({ engine: 'baidu', aiKeys: { openai: { key: 'new' } }, baiduKey: 'new-secret', mode: 'bilingual' });
  assert.equal(t.local.aiKeys.openai.key, 'new');
  assert.equal(t.local.baiduKey, 'new-secret');
  assert.equal(t.sync.engine, 'baidu');
  assert.ok(t.writes.filter(w => w.name === 'sync').every(w => !('aiKeys' in w.values) && !('baiduKey' in w.values)));
  const legacy = setup({ openaiKey: 'legacy', openaiBase: 'https://example.test', openaiModel: 'model', aiProvider: 'custom' });
  await Promise.all([legacy.storage.migrateCredentials(), legacy.storage.migrateCredentials()]);
  assert.equal(legacy.local.aiKeys.custom.key, 'legacy');
  assert.equal(legacy.sync.openaiKey, undefined);
  const failed = setup({ baiduKey: 'keep-me' }, {}, true);
  await assert.rejects(failed.storage.get(), /local write failed/);
  assert.equal(failed.sync.baiduKey, 'keep-me', 'failed migration preserves synced credentials');
  const policies=setup({concurrency:10,requestPolicies:{baidu:{mode:'manual',qps:10,maxConcurrent:4}}});
  const policyCfg=await policies.storage.get();
  assert.equal(policyCfg.concurrency,10,'旧值不被擅自换算或删除');
  assert.equal(policies.local.requestPolicies.baidu.qps,10);
  assert.equal(policies.sync.requestPolicies,undefined);
  await policies.storage.set({requestPolicies:{google:{mode:'manual',qps:3,maxConcurrent:2}},requestPolicyVersion:1});
  assert.equal(policies.local.requestPolicyVersion,1);
  assert.equal(policies.sync.requestPolicyVersion,undefined);
  const noPolicy=setup({concurrency:10});await noPolicy.storage.get();assert.equal(noPolicy.local.requestPolicies,undefined,'没有策略则用默认值，不从旧并发换算');
 const styleStorage=setup({},{});
 await styleStorage.storage.set({translationStyle:{fontSize:120,color:'#cc3300'}});
 assert.equal(styleStorage.sync.translationStyle.fontSize,120,'样式随普通偏好同步');
 assert.equal(styleStorage.local.translationStyle,undefined,'不混入本机凭据分区');
 assert.equal((await styleStorage.storage.get()).translationStyle.color,'#cc3300');
  console.log('PASS: 请求策略迁移、本机分流及旧并发不换算');
  console.log('PASS: credential migration, local precedence, legacy migration, split writes, failed migration preservation');
})().catch(error => { console.error(error); process.exitCode = 1; });
