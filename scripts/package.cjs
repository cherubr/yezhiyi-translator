// 发布打包入口：只收录运行必需文件，拒绝覆盖同名安装包；开发依赖和测试不进入 ZIP。
const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),manifest=JSON.parse(fs.readFileSync(path.join(root,'manifest.json')));
if(!/^\d+\.\d+\.\d+$/.test(manifest.version))throw Error('无效版本');
const files=['manifest.json','background','content','core','settings','assets','PRIVACY.md'];
const dist=path.join(root,'dist');fs.mkdirSync(dist,{recursive:true});
const output=path.join(dist,'yezhiyi-translator-'+manifest.version+'.zip');
if(fs.existsSync(output))throw Error('打包文件已存在，请先另存旧包或手动删除后重试：'+output);
if(process.platform!=='win32')throw Error('当前打包脚本使用 Windows Compress-Archive；其他平台可按白名单手动创建 ZIP');
const quote=s=>"'"+s.replace(/'/g,"''")+"'";
const command='Compress-Archive -LiteralPath @('+files.map(f=>quote(path.join(root,f))).join(',')+') -DestinationPath '+quote(output);
execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{stdio:'inherit'});
console.log('扩展安装包：'+output);
