/**
 * 测试模块：日志级别与发布静默边界。
 * 隔离方式：VM 记录控制台调用，在独立临时目录生成发布副本。
 * 验收范围：等级过滤、生产强制静默、不改源码和运行代码无旁路打印。
 * 执行：node tests/logging.cjs
 */
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),path=require('node:path'),os=require('node:os');
const {productionConstants,verifyReleaseLogging,prepareRelease}=require('../scripts/release-files.cjs');
const root=path.resolve(__dirname,'..'),source=fs.readFileSync(path.join(root,'core/constants.js'),'utf8');
/**
 * 按指定环境和级别加载日志模块，捕获输出以验证过滤，不修改被测源码文件。
 */
function load(environment,level,throwing=false){
  const printed=[];
  const context={console:Object.fromEntries(['debug','info','warn','error'].map(l=>[l,(...args)=>{if(throwing)throw Error('console unavailable');printed.push({level:l,args});}]))};
  context.self=context;context.window=context;vm.createContext(context);
  const modified=source.replace(/const LOG_CONFIG = Object\.freeze\(\{[\s\S]*?\}\);/,
    'const LOG_CONFIG = Object.freeze('+JSON.stringify({environment,level})+');');
  vm.runInContext(modified,context);return {log:context.BT_LOG,config:context.BT_CONST.LOG_CONFIG,printed};
}
for(const [level,expected]of Object.entries({off:[],error:['error'],warn:['error','warn'],info:['error','warn','info'],debug:['error','warn','info','debug']})){
  const t=load('development',level);
  for(const name of ['error','warn','info','debug'])t.log[name]('safe metadata',{count:1});
  assert.deepEqual(t.printed.map(x=>x.level),expected);
  assert.equal(t.log.isEnabled('invalid'),false);assert.equal(t.log.isEnabled('off'),false);
}
for(const environment of ['production','unknown'])for(const level of ['debug','info','warn','error','off','invalid']){
  const t=load(environment,level);for(const name of ['error','warn','info','debug']){assert.equal(t.log.isEnabled(name),false);t.log[name]('must be silent');}
  assert.equal(t.printed.length,0);
}
assert.equal(load('development','invalid').log.isEnabled('error'),false);
const broken=load('development','debug',true);assert.doesNotThrow(()=>broken.log.error('no impact'));
const release=productionConstants(source);verifyReleaseLogging(release);
assert.throws(()=>verifyReleaseLogging(source),/发布包/);
assert.throws(()=>productionConstants('missing config'),/唯一定位/);
assert.throws(()=>productionConstants(source+source),/唯一定位/);
const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'yezhiyi-log-test-'));
try{
  prepareRelease(root,fixture);
  assert.equal(fs.readFileSync(path.join(root,'core/constants.js'),'utf8'),source,'打包不修改开发配置');
  verifyReleaseLogging(fs.readFileSync(path.join(fixture,'core/constants.js'),'utf8'));
  assert.equal(fs.existsSync(path.join(fixture,'tests')),false);assert.equal(fs.existsSync(path.join(fixture,'node_modules')),false);
  for(const dir of ['background','content','core','settings']){
    const walk=folder=>{for(const entry of fs.readdirSync(folder,{withFileTypes:true})){const file=path.join(folder,entry.name);if(entry.isDirectory())walk(file);else if(file.endsWith('.js')){
      const code=fs.readFileSync(file,'utf8');
      assert.ok(!/console\s*\.\s*(log|info|warn|error|debug)\s*\(/.test(code),'运行代码不能绕过统一日志入口：'+file);
    }}};walk(path.join(fixture,dir));
  }
}finally{
  if(path.dirname(fixture)!==path.resolve(os.tmpdir())||!path.basename(fixture).startsWith('yezhiyi-log-test-'))throw Error('测试目录超出预期');
  fs.rmSync(fixture,{recursive:true,force:true});
}
console.log('PASS: 五级日志、生产强制静默、非法配置关闭、打印异常隔离、发布副本检查及源码保持');
