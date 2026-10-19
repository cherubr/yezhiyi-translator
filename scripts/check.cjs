const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),manifest=JSON.parse(fs.readFileSync(path.join(root,'manifest.json')));
function check(file){const r=spawnSync(process.execPath,['--check',file],{stdio:'inherit'});if(r.status!==0)process.exit(r.status||1);}
function walk(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,entry.name);if(entry.isDirectory())walk(p);else if(/\.(c?js)$/.test(p))check(p);}}
for(const dir of ['background','content','core','settings','scripts','tests'])walk(path.join(root,dir));
for(const ref of [manifest.background.service_worker,...manifest.content_scripts.flatMap(x=>[...x.js,...x.css]),...Object.values(manifest.icons),...Object.values(manifest.action.default_icon)])
 if(!fs.existsSync(path.join(root,ref)))throw Error('缺少扩展文件：'+ref);
const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json')));
if(pkg.version!==manifest.version)throw Error('package.json 与 Manifest 版本不一致');
console.log('PASS: 全项目语法、Manifest引用和版本一致性');
