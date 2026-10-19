const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),path=require('node:path');
let detection={isReliable:true,languages:[{language:'en',percentage:98}]},url;
const context={URLSearchParams,console,chrome:{i18n:{async detectLanguage(){return detection;}}}};
context.self=context;vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(__dirname,'../core/languages.js'),'utf8'),context);
const s=fs.readFileSync(path.join(__dirname,'../background/service-worker.js'),'utf8');
context.BT_STORAGE={async get(){return {baiduAppId:'id',baiduKey:'key'};}};
context.md5=()=> 'signature';
context.fetchWithTimeout=async value=>{url=new URL(value);return {ok:true,async json(){return {trans_result:[{dst:'ok'}],responseData:{translatedText:'ok'}};}};};
vm.runInContext(s.slice(s.indexOf('async function translateMyMemory('),s.indexOf('async function translateAI(')),context);
(async()=>{
 for(const [code,mapped] of Object.entries({auto:'auto','zh-CN':'zh','zh-TW':'cht',en:'en',ja:'jp',ko:'kor',fr:'fra',es:'spa',ru:'ru',de:'de'}))assert.equal(context.BT_LANG.mapLanguage('baidu',code),mapped);
 await context.translateBaidu('text','ja','zh-TW');assert.equal(url.searchParams.get('from'),'jp');assert.equal(url.searchParams.get('to'),'cht');
 await context.translateMyMemory('Hello world','auto','zh-CN');assert.equal(url.searchParams.get('langpair'),'en|zh-CN');
 detection={isReliable:false,languages:[{language:'en',percentage:40}]};
 await assert.rejects(context.translateMyMemory('Short','auto','zh-CN'),/手动选择/);
 console.log('PASS: 百度全部语言映射、真实参数构造、MyMemory自动识别与不可靠识别提示');
})().catch(e=>{console.error(e);process.exitCode=1;});
