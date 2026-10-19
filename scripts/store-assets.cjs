// 从现有 SVG 和真实扩展界面导出商店图片；使用独立临时配置，不读取个人资料或访问外部翻译接口。
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),out=path.join(root,'docs','store');
/** 导出不同尺寸的品牌图标、宣传图及无个人配置的设置页截图。 */
async function main(){
 fs.mkdirSync(out,{recursive:true});
 const profile=fs.mkdtempSync(path.join(os.tmpdir(),'yezhiyi-assets-'));
 let context;
 try{
  context=await chromium.launchPersistentContext(profile,{channel:'chromium',headless:true,viewport:{width:1280,height:800},deviceScaleFactor:1,args:['--disable-extensions-except='+root,'--load-extension='+root]});
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
  const id=new URL(worker.url()).host;
  const page=await context.newPage();
  await page.goto('chrome-extension://'+id+'/settings/settings.html');
  await page.waitForFunction(()=>document.querySelector('#version')?.textContent==='v1.0.0');
  await page.screenshot({path:path.join(out,'settings-1280x800.png'),animations:'disabled'});
  const svg=fs.readFileSync(path.join(root,'assets/icon.svg'),'utf8');
  const icon='data:image/svg+xml;base64,'+Buffer.from(svg).toString('base64');
  const render=await context.newPage();
  for(const size of [16,32,48,128]){
   await render.setViewportSize({width:size,height:size});
   await render.setContent('<style>html,body{margin:0;background:transparent}img{display:block;width:100vw;height:100vh}</style><img src="'+icon+'">');
   await render.locator('img').evaluate(img=>img.decode());
   await render.screenshot({path:path.join(root,'assets','icon'+size+'.png'),omitBackground:true});
  }
  await render.setViewportSize({width:440,height:280});
  await render.setContent('<style>*{box-sizing:border-box}body{margin:0;width:440px;height:280px;background:linear-gradient(125deg,#143992,#4832a2);font-family:Microsoft YaHei,system-ui,sans-serif;color:white;padding:28px}header{display:flex;align-items:center;gap:8px;font-size:27px;font-weight:700}img{width:64px;height:64px}small{display:block;font-size:13px;opacity:.8;margin:0 0 19px 12px}article{background:#fff;border-radius:12px;padding:17px 20px;color:#263457;margin:0 8px;box-shadow:0 8px 28px #08143e55}p{margin:0;font-size:16px}p+p{color:#565fa0;font-size:14px;margin-top:7px}</style><header><img src="'+icon+'"><span>页知译</span></header><small>网页双语翻译</small><article><p>Read the original. Understand more.</p><p>保留原文，读懂更多。</p></article>');
  await render.locator('img').evaluate(img=>img.decode());
  await render.screenshot({path:path.join(out,'promo-440x280.png')});
  // 顶部宣传图独立排版，使用不透明背景导出，满足 1400×560 的商店尺寸。
  await render.setViewportSize({width:1400,height:560});
  await render.setContent('<style>*{box-sizing:border-box}body{margin:0;width:1400px;height:560px;overflow:hidden;background:linear-gradient(120deg,#102a70,#343294 65%,#5635ae);font-family:Microsoft YaHei,system-ui,sans-serif;color:white;display:flex;align-items:center;padding:70px 86px;gap:100px}section{width:520px;flex-shrink:0}header{display:flex;align-items:center;gap:18px;font-size:64px;font-weight:700}img{width:116px;height:116px}h1{font-size:30px;font-weight:500;margin:24px 0 16px}small{font-size:18px;color:#c9d5ff}article{width:530px;background:#fff;border-radius:22px;padding:36px;color:#263457;box-shadow:0 24px 70px #06123955;transform:rotate(-3deg)}nav{display:flex;gap:7px;margin-bottom:28px}i{width:9px;height:9px;border-radius:50%;background:#c7cff1}p{margin:0;font-size:23px;line-height:1.6}p+p{color:#565fa0;font-size:21px;margin-top:12px}hr{border:0;border-top:1px solid #e6eafa;margin:24px 0}.line{height:8px;background:#e9edf8;border-radius:4px;margin:14px 0;width:85%}.short{width:58%}</style><section><header><img src="'+icon+'"><span>页知译</span></header><h1>保留原文，读懂更多。</h1><small>网页双语翻译 · 多引擎选择 · 动态内容补翻</small></section><article><nav><i></i><i></i><i></i></nav><p>Read the original.<br>Understand more.</p><p>阅读原文，也读懂每一段。</p><hr><div class="line"></div><div class="line short"></div></article>');
  await render.locator('img').evaluate(img=>img.decode());
  await render.screenshot({path:path.join(out,'marquee-1400x560.png'),omitBackground:false});
  console.log('已生成商店宣传图、真实设置截图和图标：'+out);
 }finally{
  if(context)await context.close();
  const resolved=path.resolve(profile),temp=path.resolve(os.tmpdir())+path.sep;
  if(!resolved.startsWith(temp)||!path.basename(resolved).startsWith('yezhiyi-assets-'))throw Error('临时资料路径校验失败');
  fs.rmSync(resolved,{recursive:true,force:true});
 }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
