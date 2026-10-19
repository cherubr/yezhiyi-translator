// 网络回归：验证超时与主动取消的区别、中文错误提示以及敏感查询信息保护。
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync(require('node:path').join(__dirname, '../background/service-worker.js'), 'utf8');
let fetchImpl, cleared = 0;
const context = { cancelledError:()=>Object.assign(new Error("翻译已取消"),{name:"AbortError"}), AbortController, AbortSignal, URL, setTimeout: () => 1, clearTimeout: () => cleared++, fetch: (...args) => fetchImpl(...args) };
vm.createContext(context);
vm.runInContext(source.slice(source.indexOf('async function fetchWithTimeout(')), context);
(async () => {
  fetchImpl = async () => { throw new TypeError('Failed to fetch'); };
  await assert.rejects(context.fetchWithTimeout('https://example.test/path?key=private'), error => {
    assert.match(error.message, /example\.test/);
    assert.match(error.message, /网站访问权限/);
    assert.ok(!error.message.includes('private'));
    return true;
  });
  fetchImpl = async () => { const error = new Error(); error.name = 'AbortError'; throw error; };
  await assert.rejects(context.fetchWithTimeout('https://example.test', {}, 5000), /5 秒/);
  const response = { ok: false, status: 429 };
  fetchImpl = async () => response;
  assert.equal(await context.fetchWithTimeout('https://example.test'), response, 'HTTP errors remain available to provider handlers');
  const cancelController=new AbortController();
  fetchImpl=async (url,options)=>new Promise((resolve,reject)=>{
    options.signal.addEventListener('abort',()=>reject(Object.assign(new Error('cancel'),{name:'AbortError'})),{once:true});
  });
  const cancelled=context.fetchWithTimeout('https://example.test',{signal:cancelController.signal});
  cancelController.abort();
  await assert.rejects(cancelled,error=>error.name==='AbortError'&&!error.message.includes('超时'));
  assert.equal(cleared, 4, 'all outcomes release their timers');
  console.log('PASS: 网络错误中文提示、域名定位、敏感参数保护、超时显示及定时器释放');
})().catch(error => { console.error(error); process.exitCode = 1; });
