const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{execFileSync}=require('node:child_process');
const {RELEASE_FILES,prepareRelease,verifyReleaseLogging}=require('./release-files.cjs');
const quote=s=>"'"+s.replace(/'/g,"''")+"'";

/**
 * 创建发布 ZIP；已有同名包直接拒绝覆盖，不修改本地开发配置或历史包。
 */
function packageRelease(root=path.resolve(__dirname,'..')){
  const manifest=JSON.parse(fs.readFileSync(path.join(root,'manifest.json')));
  if(!/^\d+\.\d+\.\d+$/.test(manifest.version))throw Error('无效版本');
  const dist=path.join(root,'dist');fs.mkdirSync(dist,{recursive:true});
  const output=path.join(dist,'yezhiyi-translator-'+manifest.version+'.zip');
  if(fs.existsSync(output))throw Error('打包文件已存在，请先另存旧包或手动删除后重试：'+output);
  if(process.platform!=='win32')throw Error('当前打包脚本使用 Windows Compress-Archive；请在 Windows 下生成经日志校验的发布 ZIP');
  const stage=fs.mkdtempSync(path.join(os.tmpdir(),'yezhiyi-release-'));
  try{
    prepareRelease(root,stage);
    const command='Compress-Archive -LiteralPath @('+RELEASE_FILES.map(f=>quote(path.join(stage,f))).join(',')+') -DestinationPath '+quote(output);
    execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{stdio:'inherit'});
    // 再读取实际 ZIP 中的配置验证，不能只检查压缩前的源码或临时副本。
    const inspect='Add-Type -AssemblyName System.IO.Compression.FileSystem; '+
      '$zip=[System.IO.Compression.ZipFile]::OpenRead('+quote(output)+'); '+
      'try { $entry=$zip.Entries | Where-Object { $_.FullName.Replace("\\","/") -eq "core/constants.js" } | Select-Object -First 1; '+
      'if(-not $entry){throw "Missing release constants"}; '+
      '$reader=[System.IO.StreamReader]::new($entry.Open()); try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8; [Console]::Write($reader.ReadToEnd()) } finally { $reader.Dispose() } } finally { $zip.Dispose() }';
    const archived=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',inspect],{encoding:'utf8'});
    verifyReleaseLogging(archived);
    return output;
  }finally{
    // 只清理本轮创建且已确认位于系统临时目录下的 staging，不递归操作项目和 dist。
    if(path.dirname(stage)!==path.resolve(os.tmpdir())||!path.basename(stage).startsWith('yezhiyi-release-'))throw Error('临时目录超出预期范围');
    fs.rmSync(stage,{recursive:true,force:true});
  }
}
if(require.main===module)console.log('扩展安装包（生产日志关闭并验证）：'+packageRelease());
module.exports={packageRelease};
