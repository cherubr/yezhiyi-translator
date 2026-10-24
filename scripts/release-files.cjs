const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const RELEASE_FILES=Object.freeze(['manifest.json','background','content','core','settings','assets','PRIVACY.md']);
const CONFIG_PATTERN=/const LOG_CONFIG = Object\.freeze\(\{[\s\S]*?\}\);/g;

/**
 * 只替换唯一的日志配置声明；找不到或出现多处时停止打包，不能悄悄发布开发日志。
 */
function productionConstants(source){
  if([...source.matchAll(CONFIG_PATTERN)].length!==1)throw Error('无法唯一定位日志配置，拒绝生成发布包');
  const newline=source.includes('\r\n')?'\r\n':'\n';
  return source.replace(CONFIG_PATTERN,['const LOG_CONFIG = Object.freeze({',
    '    environment: "production",','    level: "off"','  });'].join(newline));
}

/**
 * 执行配置模块并实际调用各级日志，验证生产配置、不可启用与零控制台输出。
 */
function verifyReleaseLogging(source){
  const printed=[],context={console:Object.fromEntries(['log','debug','info','warn','error'].map(level=>[level,(...args)=>printed.push([level,...args])]))};
  context.self=context;context.window=context;vm.createContext(context);
  vm.runInContext(source,context,{filename:'release/core/constants.js',timeout:1000});
  const config=context.BT_CONST?.LOG_CONFIG,log=context.BT_LOG;
  if(config?.environment!=='production'||config?.level!=='off'||!Object.isFrozen(config)||!Object.isFrozen(log))
    throw Error('发布包未强制关闭日志');
  for(const level of ['error','warn','info','debug']){
    if(log.isEnabled(level))throw Error('发布包仍可启用日志：'+level);
    log[level]('release logging probe');
  }
  if(printed.length)throw Error('发布包仍输出控制台日志');
}

/**
 * 复制运行白名单，在副本中关闭日志，并验证本轮生成的配置。
 */
function prepareRelease(root,stage){
  for(const file of RELEASE_FILES)fs.cpSync(path.join(root,file),path.join(stage,file),{recursive:true});
  const constants=path.join(stage,'core/constants.js');
  const source=productionConstants(fs.readFileSync(constants,'utf8'));
  fs.writeFileSync(constants,source);verifyReleaseLogging(source);
}
module.exports={RELEASE_FILES,productionConstants,verifyReleaseLogging,prepareRelease};
