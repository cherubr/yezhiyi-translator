/**
 * 测试模块：语言目录与引擎映射。
 * 隔离方式：VM 中模拟语言检测和 HTTP 响应。
 * 验收范围：百度语码、MyMemory 自动检测及无法可靠识别时的提示。
 * 执行：node tests/languages.cjs
 */
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),path=require('node:path');
let detection={isReliable:true,languages:[{language:'en',percentage:98}]},url;
const context={URL,URLSearchParams,TextEncoder,setTimeout,clearTimeout,console,chrome:{i18n:{async detectLanguage(){return detection;}}}};
context.self=context;vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(__dirname,'../core/constants.js'),'utf8'),context);
vm.runInContext(fs.readFileSync(path.join(__dirname,'../core/languages.js'),'utf8'),context);
vm.runInContext(fs.readFileSync(path.join(__dirname,'../core/request-policy.js'),'utf8'),context);
const s=fs.readFileSync(path.join(__dirname,'../background/service-worker.js'),'utf8');
context.BT_STORAGE={async get(){return {baiduAppId:'id',baiduKey:'key'};}};
context.md5=()=> 'signature';
context.fetchWithTimeout=async (value,options)=>{url=options?.body?{searchParams:new URLSearchParams(options.body)}:new URL(value);return {ok:true,async json(){return {trans_result:[{dst:'ok'}],responseData:{translatedText:'ok'}};}};};
vm.runInContext(s.slice(s.indexOf('async function translateMyMemory('),s.indexOf('async function translateAI(')),context);
(async()=>{
 assert.equal(context.BT_CONST.LANGUAGES.to.length,49);
 assert.equal(context.BT_CONST.LANGUAGES.from.length,49);
 assert.equal(context.BT_CONST.DEFAULTS.to,'browser');
 for(const [locale,expected] of Object.entries({'en-US':'en','zh-HK':'zh-TW','zh-Hans':'zh-CN','pt-BR':'pt','nb-NO':'no','xx-XX':'en'})){
   context.chrome.i18n.getUILanguage=()=>locale;
   assert.equal(context.BT_CONST.resolveTargetLanguage('browser'),expected);
   assert.equal(context.BT_CONST.resolveTargetLanguage('ja'),'ja');
 }
 assert.equal(new Set(context.BT_CONST.LANGUAGES.to.map(x=>x.value)).size,49);
 assert.ok(!context.BT_CONST.LANGUAGES.to.some(x=>x.value==='auto'));
 for(const item of context.BT_CONST.LANGUAGES.from)assert.equal(context.BT_LANG.mapLanguage('baidu',item.value),item.baidu);
 for(const [code,expected] of Object.entries({"ms": "may", "bn": "ben", "ur": "urd", "ta": "tam", "te": "tel", "ne": "nep", "fa": "per", "he": "heb", "no": "nor", "is": "ice", "bg": "bul", "hr": "hrv", "sk": "sk", "et": "est", "lv": "lav", "lt": "lit", "sr": "srp", "af": "afr", "sw": "swa", "my": "bur"}))assert.equal(context.BT_LANG.mapLanguage('baidu',code),expected,code);
 assert.equal(context.BT_LANG.mapLanguage('baidu','uk'),'ukr');
 assert.equal(context.BT_LANG.mapLanguage('baidu','vi'),'vie');
 assert.equal(context.BT_LANG.mapLanguage('baidu','ar'),'ara');

 for(const [code,mapped] of Object.entries({auto:'auto','zh-CN':'zh','zh-TW':'cht',en:'en',ja:'jp',ko:'kor',fr:'fra',es:'spa',ru:'ru',de:'de'}))assert.equal(context.BT_LANG.mapLanguage('baidu',code),mapped);
 await context.translateBaidu('text','ja','zh-TW');assert.equal(url.searchParams.get('from'),'jp');assert.equal(url.searchParams.get('to'),'cht');
 await context.translateMyMemory('Hello world','auto','zh-CN');assert.equal(url.searchParams.get('langpair'),'en|zh-CN');
 const previousUrl=url;
 assert.equal(await context.translateMyMemory('Hello world','auto','en'),'Hello world');
 assert.equal(url,previousUrl,'same language must not call MyMemory');
 detection={isReliable:false,languages:[{language:'en',percentage:40}]};
 await assert.rejects(context.translateMyMemory('Short','auto','zh-CN'),/指定源语言/);
 console.log('PASS: 百度全部语言映射、真实参数构造、MyMemory自动识别与不可靠识别提示');
})().catch(e=>{console.error(e);process.exitCode=1;});
