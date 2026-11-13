/**
 * PDF 阅读器 UI 集成回归：真实 PDF.js、文字流水线、原位层与导出 Worker。
 * 隔离 Chrome 消息、OCR 识别结果及资源下载，不请求厂商接口、不下载模型，不截图。
 * 不验证真实 OCR 准确率、商店权限弹窗或外网可用性。
 * 执行：node tests/browser-pdf-reader.cjs
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const {chromium} = require("playwright");
const {PDFDocument, StandardFonts,rgb} = require("../pdf/vendor/pdf-lib/pdf-lib.min.js");
const root = path.resolve(__dirname, "..");

async function fixtures() {
  const doc = await PDFDocument.create(), font = await doc.embedFont(StandardFonts.Helvetica);
  for (let index = 1; index <= 4; index++) {
    const page = doc.addPage([600, 800]);
    for (let row = 0; row < 4; row++) page.drawText(
      (row === 2 ? "Fallback example" : "Reading example") + " page " + index + " paragraph " + row + ".",
      {x: 60, y: 700 - row * 100, size: 15, font});
  }
  const blank = await PDFDocument.create(); blank.addPage([600, 800]);
  const scanned = await PDFDocument.create();
  // 固定的一像素数据只用于触发图片页分类；识别结果在测试边界替身中提供。
  const png = await scanned.embedPng(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64"));
  scanned.addPage([600, 800]).drawImage(png, {x: 30, y: 30, width: 540, height: 740});
  const complex=await PDFDocument.create(),cf=await complex.embedFont(StandardFonts.Helvetica);
  const put=(p,s,x,y,size=10)=>p.drawText(s,{x,y,size,font:cf});
  const p1=complex.addPage([600,800]);put(p1,'A structured research document',60,740,22);
  for(const [x,name,mail] of [[60,'Alice Smith','alice@example.org'],[310,'Bob Jones','bob@example.org']]){
    put(p1,name,x,695);put(p1,'Research Institute',x,681);put(p1,mail,x,667,9);
  }
  put(p1,'Abstract',60,620,15);put(p1,'This paragraph describes a table with aligned cells.',60,600);
  const xs=[50,200,360,550],ys=[500,440,380,320];
  for(const y of ys)p1.drawLine({start:{x:xs[0],y},end:{x:xs.at(-1),y},thickness:.7});
  for(const x of xs)p1.drawLine({start:{x,y:ys[0]},end:{x,y:ys.at(-1)},thickness:.7});
  for(let r=0;r<3;r++)for(let c=0;c<3;c++)put(p1,r===0?'Heading '+c:'Cell '+r+' '+c,xs[c]+10,ys[r]-25);
  const p2=complex.addPage([600,800]);put(p2,'A safe architecture diagram',60,740,20);
  for(let i=0;i<3;i++){
    const y=610-i*95;p2.drawRectangle({x:210,y:y-50,width:180,height:50,borderWidth:1,borderColor:rgb(0,0,0)});
    put(p2,['Input','Feed Forward','Output'][i],235,y-28);
    if(i<2)p2.drawLine({start:{x:300,y:y-50},end:{x:300,y:y-95},thickness:1});
  }
  put(p2,'Figure 1: a connected pipeline.',200,350);put(p2,'The original connections must stay intact.',60,290);
  const p3=complex.addPage([600,800]),photo=await complex.embedPng(fs.readFileSync(path.join(root,'assets/icon128.png')));
  put(p3,'A photograph and its caption',60,740,20);p3.drawImage(photo,{x:80,y:430,width:200,height:140});
  put(p3,'Figure 2: original photograph.',80,410);put(p3,'The caption remains associated with this picture.',60,350);
  const p4=complex.addPage([600,800]);put(p4,'Formula and code are protected',60,740,20);
  put(p4,'y = x^2 + 1',60,650,14);put(p4,'const answer = 42;',60,600,12);put(p4,'Only this natural language explanation is translated.',60,550);
  put(complex.addPage([900,400]),'Landscape page',60,330,20);put(complex.addPage([300,450]),'Small page',30,390,20);
  const chart=complex.addPage([600,800]);put(chart,'Chart data must stay unchanged',60,740,20);
  chart.drawLine({start:{x:70,y:400},end:{x:430,y:400},thickness:1});chart.drawLine({start:{x:70,y:400},end:{x:70,y:580},thickness:1});
  for(const [i,h] of [60,120,90].entries()){
    chart.drawRectangle({x:100+i*100,y:400,width:50,height:h,color:rgb(.1,.3,.8)});put(chart,String(h),110+i*100,410);
  }
  put(chart,'Figure 3: measured values.',80,380);put(chart,'Only labels are translated. Bar heights remain original.',60,320);
  return {native: Buffer.from(await doc.save()), blank: Buffer.from(await blank.save()), scanned: Buffer.from(await scanned.save()),complex:Buffer.from(await complex.save())};
}

function installChrome() {
  const listeners = () => { const values = []; return {addListener(fn) { values.push(fn); }, removeListener(fn) { const i = values.indexOf(fn); if (i >= 0) values.splice(i, 1); }, fire(value) { values.slice().forEach(fn => fn(value)); }}; };
  const control = window.pdfUiTest = {calls: [], delay: 0, fail: false, long: true, revision: 1, downloads: {}, authorizations: 0};
  const NativeWorker = window.Worker;
  window.Worker = class extends NativeWorker {
    constructor(url, options) { super(url, options); this.isExport = String(url).includes("export-worker.js"); }
    postMessage(...args) {
      if (this.isExport && control.holdExport) { control.exportHeld = true; return; }
      super.postMessage(...args);
    }
  };
  const ports = [], changed = listeners();
  window.chrome = {
    runtime: {
      getURL: value => location.origin + "/" + value,
      connect() {
        const onMessage = listeners(), onDisconnect = listeners();
        const port = {onMessage, onDisconnect, postMessage(message) {
          if (message.type === "CONTEXT" || message.type === "BIND_BATCH") setTimeout(() => onMessage.fire({
            type: "REPLY", id: message.id, ok: true, data: message.type === "CONTEXT" ? {
              revision: control.revision, engine: "google", aiProvider: "openai", from: "auto", to: "fr",
              services: [{value: "google", text: "Google test service", ready: true}]
            } : {}
          }), 0);
        }, disconnect() { onDisconnect.fire(); }};
        ports.push(port); return port;
      },
      sendMessage(message, callback) {
        if (message.action !== "TRANSLATE") { callback?.({ok: true}); return; }
        control.calls.push(message); const fail = control.fail || !!(control.failAt && message.text.includes(control.failAt));
        control.fail = false; if (fail) control.failAt = "";
        const data = control.targetText || (control.long && message.text.includes("Fallback") ? "Long translation example. ".repeat(160) : "Translated: " + message.text);
        setTimeout(() => callback(fail ? {ok: false, code: "TEST_FAILURE", error: "Test translation failure"} : {ok: true, data}), control.delay);
      }
    },
    permissions: {request: () => Promise.resolve(true), contains: (_, callback) => callback(true)},
    storage: {onChanged: changed}
  };
  control.disconnect = () => ports.at(-1).disconnect();
  control.invalidate = () => { control.revision++; ports.at(-1).onMessage.fire({type: "CONFIG_INVALIDATED"}); };
}

function installResources() {
  const control = window.pdfUiTest;
  for (const [kind, store] of [["model", BT_PDF_OCR_MODEL_STORE], ["font", BT_PDF_FONT_STORE]]) {
    const installed = new Set();
    store.installed = async () => new Set(installed);
    // 面板的存储占用行读这一项：桩件按注册表钉死体积折算，避免测试触碰真实 IndexedDB。
    store.usage = async () => ({codes: [...installed], count: installed.size,
      bytes: [...installed].reduce((total, code) => total + (BT_PDF_EXPORT_FONTS.entry(code)?.bytes || 0), 0)});
    store.authorize = () => { control.authorizations++; return {test: true}; };
    store.remove = async code => { installed.delete(code); };
    store.download = (code, {authorization, signal, onProgress}) => new Promise((resolve, reject) => {
      if (!authorization?.test) return reject(new Error("Missing synchronous authorization"));
      signal?.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")), {once: true});
      control.downloads[kind + code] = {finish(fail = false) {
        if (fail) reject(new Error("Test resource failure"));
        else { installed.add(code); resolve(); }
      }};
      onProgress({loaded: 50, total: 100});
    });
  }
  control.ocrCalls = 0;
  BT_PDF_OCR.create = () => ({terminate: async () => {}, recognize: async ({image}) => {
    control.ocrCalls++;
    if (control.ocrDelay) await new Promise(resolve => setTimeout(resolve, control.ocrDelay));
    return {lines: [{text: "Recognized text from a scanned page.", confidence: 98,
      bbox: {x0: image.width * .1, y0: image.height * .1, x1: image.width * .8, y1: image.height * .13}}]};
  }});
}

module.exports={fixtures};
if(require.main===module)(async () => {
  const pdfs = await fixtures();
  const readerCode = fs.readFileSync(path.join(root, "pdf/reader.js"), "utf8");
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/fixture.pdf") { res.writeHead(200, {"Content-Type": "application/pdf"}); res.end(pdfs.native); return; }
    if (url.pathname === "/denied.pdf") { res.writeHead(403); res.end(); return; }
    if (url.pathname === "/slow.pdf") {
      res.writeHead(200, {"Content-Type": "application/pdf"}); res.write(pdfs.native.subarray(0, 20));
      const timer = setTimeout(() => res.end(pdfs.native.subarray(20)), 5000);
      res.on("close", () => clearTimeout(timer)); return;
    }
    if (url.pathname === "/pdf/reader.js") {
      res.writeHead(200, {"Content-Type": "text/javascript"});
      res.end("(" + installResources.toString() + ")();\n" + readerCode); return;
    }
    if (!/^\/(pdf|core)\//.test(url.pathname)) { res.writeHead(404); res.end(); return; }
    const file = path.resolve(root, "." + url.pathname);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
    const types = {".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm"};
    res.writeHead(200, {"Content-Type": types[path.extname(file)] || "application/octet-stream"}); fs.createReadStream(file).pipe(res);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  let browser;
  try {
    browser = await chromium.launch({headless: true, ...(process.env.BROWSER_CHANNEL ? {channel: process.env.BROWSER_CHANNEL} : {})});
    const context = await browser.newContext({viewport: {width: 1440, height: 900}, acceptDownloads: true});
    await context.addInitScript(installChrome);
    await context.route("**/*", route => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
    const page = await context.newPage(), errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto("http://127.0.0.1:" + server.address().port + "/pdf/reader.html");
    const visible = selector => page.locator(selector).isVisible();
    const waitReady = () => page.waitForFunction(() => !document.getElementById("startTranslation").disabled);
    const waitDone = () => page.waitForFunction(() => !document.getElementById("startTranslation").disabled && /完成/.test(document.getElementById("translationStatus").textContent));
    const setZoom = async value => {
      if (value.startsWith("fit-")) {
        for (let i=0; i<2 && await page.locator("#zoomFit").getAttribute("data-mode")!==value; i++) {
          await page.click("#zoomFit"); await waitReady();
        }
        assert.equal(await page.locator("#zoomFit").getAttribute("data-mode"),value);
      } else { await page.fill("#zoom",Number(value)*100+"%"); await page.locator("#zoom").press("Enter"); }
    };
    const upload = async (bytes, name = "native.pdf") => {
      if (!await visible("#filePanel")) await page.click("#openFilePanel");
      await page.evaluate(()=>{
        window.firstPdfFrame=null;window.pdfFrameObserver?.disconnect();
        window.pdfFrameObserver=new MutationObserver(()=>{const canvas=document.querySelector('#canvasHost canvas');if(!canvas)return;
          const rect=canvas.getBoundingClientRect(),v=document.getElementById('viewport');window.firstPdfFrame={width:rect.width,height:rect.height,vw:v.clientWidth,vh:v.clientHeight};window.pdfFrameObserver.disconnect();});
        window.pdfFrameObserver.observe(document.getElementById('canvasHost'),{childList:true,subtree:true});
      });
      await page.setInputFiles("#fileInput", {name, mimeType: "application/pdf", buffer: bytes}); await waitReady();
      assert.equal(await page.inputValue("#zoom"),"100%","opening a local PDF resets the previous document's zoom choice");
      assert.ok(await page.evaluate(()=>firstPdfFrame&&firstPdfFrame.width>0&&firstPdfFrame.height>0),'first frame is rendered at the requested scale');
      assert.equal(await page.locator("#zoom").getAttribute("data-scale"),"1");
      assert.equal(await page.locator("#zoomFit").getAttribute("data-mode"),"");
    };
    const calls = () => page.evaluate(() => pdfUiTest.calls.length);
    const setViewMode = async mode => {
      const button = page.locator({original:"#showOriginal",translated:"#showTranslated",bilingual:"#showBilingual"}[mode]);
      if (await button.isVisible()) {await button.click();assert.equal(await button.getAttribute("aria-pressed"),"true");}
      else await page.selectOption("#viewMode",mode);
    };
    await upload(pdfs.native);
    const pristineExportCalls=await calls();
    await page.click('#openExportPanel');await page.selectOption('#exportContent','translated');await page.selectOption('#exportPages','current');
    await page.waitForFunction(()=>!document.getElementById('exportNow').disabled);
    await page.click('#exportNow');await page.waitForSelector('#exportPreflight');
    assert.equal(await visible('#exportPrepare'),true,'an untranslated current page can enter export and offer explicit preparation');
    assert.equal(await calls(),pristineExportCalls,'first export preflight cannot implicitly send translation requests');
    await page.click('#openExportPanel');
    const languageCalls=await calls();
    assert.equal(await visible('#translationConfigSummary'),true);
    assert.equal(await visible('#translationFrom'),false,'language pickers stay collapsed behind the compact right-side summary');
    await page.click('#translationConfigSummary');
    assert.equal(await visible('#translationFrom'),true);assert.equal(await visible('#translationTo'),true);
    await page.selectOption('#translationTo','es');
    assert.equal(await visible('#applyHeaderConfig'),true,'language configuration is available without opening settings');
    assert.equal(await visible('#settingsPanel'),false);assert.equal(await calls(),languageCalls,'choosing a language does not translate');
    await page.selectOption('#translationTo','fr');assert.equal(await visible('#applyHeaderConfig'),false,'returning to the applied language clears the pending configuration');
    await page.keyboard.press('Escape');assert.equal(await visible('#languagePopover'),false);
    await page.click("#zoomIn"); await waitReady();
    assert.equal(await page.inputValue("#zoom"),"110%");
    await page.click("#zoomOut"); await waitReady();
    assert.equal(await page.inputValue("#zoom"),"100%");
    await setZoom('0.712');await waitReady();
    assert.equal(await page.inputValue('#zoom'),'71%','toolbar rounds the displayed percentage');
    assert.ok(Math.abs(Number(await page.locator('#zoom').getAttribute('data-scale'))-.712)<1e-12,'display rounding preserves the precise rendering scale');
    await page.locator('#zoom').focus();await page.locator('#zoom').press('Tab');
    assert.ok(Math.abs(Number(await page.locator('#zoom').getAttribute('data-scale'))-.712)<1e-12,'focusing the rounded display must not write the rounded value back');
    await page.click('#zoomIn');await waitReady();assert.equal(await page.inputValue('#zoom'),'80%','zoom in snaps to the next whole ten percent');
    await setZoom('0.712');await waitReady();
    await page.click('#zoomOut');await waitReady();assert.equal(await page.inputValue('#zoom'),'70%','zoom out snaps to the previous whole ten percent');
    await setZoom('1');await waitReady();
    await page.fill("#zoom","500%"); await page.locator("#zoom").press("Enter");
    assert.equal(await page.locator("#zoom").getAttribute("data-scale"),"1");
    await page.locator("#zoom").press("Escape");
    await setZoom("fit-page"); await waitReady();
    assert.match(await page.inputValue('#zoom'),/^\d+%$/,'fit mode displays an integer without discarding the calculated scale');
    assert.equal(await page.locator('#zoomFit svg').count(),2,'fit icons survive state updates');
    await page.locator("#zoom").focus(); await page.keyboard.press("Escape");
    assert.equal(await page.locator("#zoomFit").getAttribute("data-mode"),"fit-page","cancelled editing preserves fit mode");
    await page.waitForFunction(() => {
      const viewport=document.getElementById("viewport"),canvas=viewport.querySelector("canvas"),style=getComputedStyle(viewport);
      if(!canvas||document.getElementById("zoomFit").dataset.mode!=="fit-page"||document.getElementById("startTranslation").disabled)return false;
      const box=canvas.getBoundingClientRect(),width=viewport.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight),
        height=viewport.clientHeight-parseFloat(style.paddingTop)-parseFloat(style.paddingBottom);
      return box.width<=width&&box.height<=height&&Math.min(width-box.width,height-box.height)<5;
    });
    // 默认 100%；适配入口另验，以下用固定百分比检查节点身份。
    await setZoom("1"); await waitReady();
    assert.equal(await page.locator("#fileName").innerText(), "native.pdf");
    assert.equal(await visible("#readerPanel"), false);
    assert.equal(await visible("#translationCard"), false);
    await page.evaluate(() => { window.savedCanvas = document.querySelector("#canvasHost canvas"); });
    await page.click("#toggleTextComparison"); await page.click("#closeTextComparison");
    for (const mode of ["original", "bilingual", "translated"]) {
      await setViewMode(mode);
      assert.equal(await visible("#translationCard"), false);
      assert.equal(await visible("#structuredCard"), mode === "bilingual");
      assert.equal(await visible("#canvasHost .page-overlay"), mode === "translated");
      if(mode==="original")assert.equal(await page.locator("#toggleTextComparison").isDisabled(),true);
      else {
        await page.click("#toggleTextComparison");assert.equal(await visible("#translationCard"),true);
        await page.click("#toggleTextComparison");assert.equal(await visible("#translationCard"),false);
        assert.equal(await visible("#structuredCard"),mode==="bilingual");
      }
      if (mode === "bilingual") {
        const previousShare=Number(await page.locator('#comparisonSplitter').getAttribute('aria-valuenow'));
        await page.locator("#comparisonSplitter").focus(); await page.keyboard.press("ArrowLeft");
        assert.equal(Number(await page.locator("#comparisonSplitter").getAttribute("aria-valuenow")),previousShare-5);
        const box = await page.locator("#comparisonSplitter").boundingBox();
        await page.mouse.move(box.x + 4, box.y + 30); await page.mouse.down();
        await page.mouse.move(box.x + 90, box.y + 30); await page.mouse.up();
        assert.ok(Number(await page.locator("#comparisonSplitter").getAttribute("aria-valuenow")) > previousShare-5);
      }
    }
    assert.equal(await page.evaluate(() => savedCanvas === document.querySelector("#canvasHost canvas")), true);
    assert.equal(await calls(), 0, "display-only actions must not translate");
    await page.click("#translationConfigSummary"); assert.equal(await visible("#languagePopover"), true);
    assert.match(await page.locator("#translationConfigSummary").innerText(), /^Google 翻译 · 自动 → 法语$/);
    await page.click("#openFilePanel"); assert.equal(await visible("#settingsPanel"), false);
    assert.equal(await visible("#retry"), false); assert.equal(await visible("#cancel"), false);
    await page.keyboard.press("Escape");
    await page.click("#startTranslation"); await waitDone();
    await page.waitForSelector(".pdf-marker");
    // 实时修订只写草稿层，取消恢复；不触碰源 Canvas、已保存译文或翻译请求。
    const previewCalls=await calls();await setViewMode('translated');await page.click('#toggleInplaceEdit');
    // 开启修订会改变顶部工具栏高度；等布局稳定后再按可见页面坐标画框。
    await page.waitForFunction(()=>document.body.dataset.inplaceEdit==='true');
    await page.locator('#canvasHost canvas').evaluate(async canvas=>{
      const viewport=document.getElementById('viewport');viewport.scrollTop=0;
      let prior='',stable=0;
      for(let i=0;i<120&&stable<4;i++){
        await new Promise(requestAnimationFrame);const rect=canvas.getBoundingClientRect(),key=[rect.x,rect.y,rect.width,rect.height].join(',');
        stable=key===prior?stable+1:0;prior=key;
      }
    });
    const previewCanvas=await page.locator('#canvasHost canvas').boundingBox();
    await page.mouse.move(previewCanvas.x+20,previewCanvas.y+35);await page.mouse.down();
    await page.mouse.move(previewCanvas.x+200,previewCanvas.y+80,{steps:4});await page.mouse.up();
    await page.waitForSelector('#inplacePanel');await page.fill('#inplaceText','Live revision preview');
    await page.waitForFunction(()=>document.querySelector('#canvasHost .draft-placement-layer .pdf-place-text')?.textContent==='Live revision preview');
    const previewStart=await page.locator('#canvasHost .draft-placement-layer .pdf-place-text').boundingBox();
    const selectionBox=await page.locator('#inplaceSelection').boundingBox();
    await page.mouse.move(selectionBox.x+25,selectionBox.y+20);await page.mouse.down();
    await page.mouse.move(selectionBox.x+55,selectionBox.y+60,{steps:4});await page.mouse.up();
    await page.waitForFunction(start=>document.querySelector('#canvasHost .draft-placement-layer .pdf-place-text').getBoundingClientRect().left>start+20,previewStart.x);
    assert.equal(await page.locator('#canvasHost .draft-placement-layer .pdf-place-mask').count(),2,'moving retains the original white mask as well as the destination mask');
    await page.click('#inplaceCancel');
    assert.equal(await page.locator('#canvasHost .draft-placement-layer > *').count(),0,'cancel removes all transient preview content');
    assert.equal(await page.locator('#canvasHost .pdf-place[hidden]').count(),0,'cancel restores previously hidden saved blocks');
    assert.equal(await calls(),previewCalls,'live editing never sends new translation requests');
    await page.click('#toggleInplaceEdit');
    const before = await calls();
    await page.click("#openSettingsPanel");
    await page.locator(".pdf-marker").first().focus(); await page.keyboard.press("Enter");
    assert.equal(await page.locator("#fallbackTranslations").count(),0,"no permanent below-page fallback region");
    assert.equal(await visible("#translationCard"), true);
    assert.equal(await visible("#readerPanel"), false, "explicit comparison action restores comparison in the shared sidebar");
    assert.equal(await page.locator("#translationRows .translation-row-active").count(), 1);
    await page.locator("#translationRows .translation-row-active").click();
    await page.waitForSelector(".pdf-marker-flash");
    assert.equal(await page.locator(".pdf-marker-active").getAttribute("data-block-id"),
      await page.locator("#translationRows .translation-row-active").getAttribute("data-block-id"));
    assert.equal(await page.locator("#translationRows .translation-row-active").getAttribute("aria-current"), "true");
    const comparisonState = await page.evaluate(() => {
      const rows = document.getElementById("translationRows"); rows.scrollTop = 35;
      return {top: rows.scrollTop, selected: document.querySelector("#translationRows .translation-row-active").dataset.blockId};
    });
    await page.click("#openSettingsPanel");
    assert.equal(await visible("#translationCard"), false, "task panel hides background comparison");
    assert.equal(await page.locator("#translationCard").evaluate(node => node.inert), true);
    await page.click("#openExportPanel"); assert.equal(await visible("#settingsPanel"), false);
    await page.click("#openExportPanel");
    assert.equal(await visible("#translationCard"), true);
    assert.deepEqual(await page.evaluate(() => ({top: document.getElementById("translationRows").scrollTop,
      selected: document.querySelector("#translationRows .translation-row-active").dataset.blockId})), comparisonState);
    await page.selectOption("#comparisonFilter", "fallback");
    assert.ok(await page.locator(".translation-row:visible").count() > 0);
    await page.selectOption("#comparisonFilter", "failed");
    assert.equal(await page.locator(".translation-row:visible").count(), 0);
    assert.equal(await visible("#comparisonFilterEmpty"), true);
    await page.selectOption("#comparisonFilter", "all");
    const retainedScroll = await page.locator("#translationRows").evaluate(node => { node.scrollTop = 40; return node.scrollTop; });
    await page.click("#toggleTextComparison"); await page.click("#toggleTextComparison");
    assert.equal(await page.locator("#translationRows").evaluate(node => node.scrollTop), retainedScroll);
    await page.keyboard.press("Escape"); assert.equal(await visible("#translationCard"), false);
    assert.equal(await calls(), before);
    await page.click("#toggleTextComparison");
    await page.click("#next"); await waitDone();
    assert.equal(await visible("#translationCard"), true);

    const afterNext = await calls(); await page.click("#previous"); await waitDone();

    assert.equal(await calls(), afterNext, "returning page reuses cached translations");
    await setZoom("1.25"); await waitReady();
    await page.click("#rotate"); await waitReady();
    assert.equal(await calls(), afterNext, "zoom and rotation must not request translations");
    await setViewMode("original");
    await setZoom("fit-page"); await waitReady();
    const fitted = await page.evaluate(() => {
      const viewport = document.getElementById("viewport"), canvas = viewport.querySelector("canvas"), style = getComputedStyle(viewport);
      window.fittedCanvas = canvas;
      return {width: canvas.getBoundingClientRect().width, height: canvas.getBoundingClientRect().height,
        availableWidth: viewport.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
        availableHeight: viewport.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom),
        scale: document.getElementById("zoom").value, page: document.getElementById("pageNumber").value,
        rotation: document.getElementById("rotate").title};
    });
    assert.ok(fitted.width <= fitted.availableWidth && fitted.height <= fitted.availableHeight);
    for (const mode of ["bilingual", "translated", "original"]) {
      await setViewMode(mode);
      assert.equal(await page.inputValue("#pageNumber"), fitted.page);
      assert.equal(await page.locator("#rotate").getAttribute("title"), fitted.rotation);
      await page.waitForTimeout(250);await waitReady();
      assert.equal(await page.locator('#zoomFit').getAttribute('data-mode'),'fit-page','mode changes preserve automatic fitting rather than a fixed percentage');
      await page.waitForFunction(()=>{
        const viewport=document.getElementById('viewport'),canvas=viewport.querySelector('canvas'),style=getComputedStyle(viewport),box=canvas.getBoundingClientRect();
        return box.width<=viewport.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight)&&
          box.height<=viewport.clientHeight-parseFloat(style.paddingTop)-parseFloat(style.paddingBottom);
      });
    }
    await page.click("#translationFallback");
    assert.equal(await page.inputValue("#viewMode"), "translated", "explicit check action leaves original-only reading");
    await page.waitForTimeout(250);await waitReady();await page.click("#translationFallback");
    await page.waitForSelector(".pdf-marker-flash");
    const flashMetrics = () => page.evaluate(() => {
      const flash = document.querySelector(".pdf-marker-flash"), box = flash.getBoundingClientRect(), border = parseFloat(getComputedStyle(flash).borderLeftWidth);
      const canvas = document.querySelector("#canvasHost canvas").getBoundingClientRect(), scale = Number(document.getElementById("zoom").dataset.scale);
      return [box.left - canvas.left + border, box.top - canvas.top + border, box.width - 2 * border, box.height - 2 * border].map(value => value / scale);
    });
    const beforeFitHighlight = await flashMetrics();
    await setZoom("fit-width"); await waitReady();
    assert.equal(await page.evaluate(() => {
      const viewport = document.getElementById("viewport"), style = getComputedStyle(viewport), canvas = viewport.querySelector("canvas");
      const available = viewport.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      return canvas.getBoundingClientRect().width <= available && available - canvas.getBoundingClientRect().width < 5;
    }), true);
    await page.click("#translationFallback"); await page.waitForSelector(".pdf-marker-flash");
    const afterFitHighlight = await flashMetrics();
    assert.ok(afterFitHighlight.every((value, index) => Math.abs(value - beforeFitHighlight[index]) < .5),
      "rotated-page highlight keeps the same PDF coordinates after fit zoom");
    // 自适应随分栏宽度变化更新，固定百分比不受对照开关影响。
    const fitScale = await page.locator("#zoom").getAttribute("data-scale");
    await page.locator("#comparisonSplitter").focus(); await page.keyboard.press("Home");
    await page.waitForFunction(previous => document.getElementById("zoom").dataset.scale !== previous &&
      !document.getElementById("startTranslation").disabled, fitScale);
    assert.equal(await page.locator("#zoomFit").getAttribute("data-mode"), "fit-width");
    await setZoom("1.25"); await waitReady();
    const fixedCanvas = await page.locator("#canvasHost canvas").evaluate(node => {window.fixedCanvas = node; return true;});
    await page.click("#toggleTextComparison"); await page.click("#toggleTextComparison");
    await page.waitForTimeout(250);
    assert.equal(await page.inputValue("#zoom"), "125%");
    assert.equal(await page.evaluate(() => fixedCanvas === document.querySelector("#canvasHost canvas")), fixedCanvas);
    assert.equal(await page.evaluate(() => localStorage.getItem("bt-pdf-reader-share")), "35");
    await page.locator("#viewport").evaluate(node => { node.scrollTop = 60; });
    await setZoom("2"); await waitReady();
    assert.ok(await page.locator("#viewport").evaluate(node => node.scrollTop > 30), "zoom preserves the reading position");
    await page.click("#zoomIn"); await waitReady();
    assert.ok(parseFloat(await page.inputValue("#zoom")) > 0);
    assert.equal(await calls(), afterNext, "fit and mode changes reuse translated results");
    // 双语右侧编号 → 译文模式与对应翻译检查；左侧原文不额外添加可见编号。
    await setViewMode("bilingual");await page.selectOption("#bilingualLayout","page");
    assert.equal(await page.locator("#canvasHost .pdf-marker:visible").count(),0);
    const rightMarker=page.locator('#bilingualCanvasHost .pdf-marker').first();await rightMarker.waitFor();
    const rightId=await rightMarker.getAttribute("data-block-id"),markerCalls=await calls(),sourcePage=await page.inputValue("#pageNumber");
    await rightMarker.focus();await page.keyboard.press("Enter");
    assert.equal(await page.inputValue("#viewMode"),"translated");
    assert.equal(await visible("#translationCard"),true);assert.equal(await visible("#structuredCard"),false);
    assert.equal(await page.inputValue("#bilingualLayout"),"page","marker navigation does not switch to reflow");
    assert.equal(await page.inputValue("#pageNumber"),sourcePage);
    await page.waitForFunction(id=>document.activeElement?.classList.contains("translation-row-active")&&document.activeElement.dataset.blockId===id,rightId);
    assert.equal(await calls(),markerCalls,"marker navigation reuses results without translation requests");
    await setViewMode("original");assert.equal(await visible("#canvasHost .page-overlay"),false);
    await setViewMode("bilingual");await page.selectOption("#bilingualLayout","flow");
    await page.waitForFunction(()=>document.getElementById('editorPaper').contentEditable==='true');
    assert.equal(await page.locator('#reflowEditor').count(),0,'folded legacy editor is deleted');
    assert.equal(await calls(),markerCalls,'opening editable layout reuses existing translation');
    await setViewMode("translated");
    console.log("PASS PDF UI: local load, modes, canvas identity, keyboard marker, bilingual translation inspection navigation, page cache, zoom/rotation");

    await page.click("#openExportPanel"); await page.selectOption("#exportPages", "custom");
    await page.fill("#exportRange", "1-4"); await page.click("#exportNow");
    await page.waitForSelector("#exportPreflight"); assert.equal(await visible("#exportPrepare"), true);
    assert.equal(await calls(), afterNext, "range preflight must not translate");
    await page.fill("#exportRange", "1"); assert.equal(await visible("#exportPreflight"), false);
    await page.fill("#exportRange", "1-4"); await page.click("#exportNow");
    let pending = page.waitForEvent("download"); await page.click("#exportKeepMissing");
    const kept = await pending, keptPdf = await PDFDocument.load(fs.readFileSync(await kept.path()));
    assert.ok(keptPdf.getPageCount() >= 4); assert.equal(await calls(), afterNext);
    await page.click("#exportNow"); await page.waitForSelector("#exportPreflight");
    await page.click("#exportPrepare"); await page.waitForFunction(() => document.getElementById("exportCancel").disabled && /补译结束/.test(document.getElementById("exportStatus").textContent));
    await page.selectOption("#exportPages", "all");
    assert.equal(await page.inputValue("#exportRange"), "1-4");
    assert.match(await page.textContent("#exportSelectionInfo"), /4 页/);
    await page.selectOption("#exportContent", "original");
    assert.equal(await page.locator("#exportPages").isDisabled(), true);
    pending = page.waitForEvent("download"); await page.click("#exportNow");
    const original = await pending;
    assert.deepEqual(fs.readFileSync(await original.path()), pdfs.native);
    await page.selectOption("#exportContent", "translated"); await page.selectOption("#exportPages", "current");
    pending = page.waitForEvent("download"); await page.click("#exportNow");
    assert.ok((await PDFDocument.load(fs.readFileSync(await (await pending).path()))).getPageCount() > 0);
    await page.selectOption("#exportLayout", "structured");
    pending = page.waitForEvent("download"); await page.click("#exportNow");
    const translated = await pending, output = await PDFDocument.load(fs.readFileSync(await translated.path()));
    assert.ok(output.getPageCount() >= 2, "long structured export naturally paginates");
    await page.evaluate(() => { pdfUiTest.holdExport = true; }); await page.click("#exportNow");
    await page.waitForFunction(() => pdfUiTest.exportHeld); await page.click("#exportCancel");
    await page.waitForFunction(() => document.getElementById("exportCancel").disabled && /取消/.test(document.getElementById("exportStatus").textContent));
    await page.evaluate(() => { pdfUiTest.holdExport = false; });
    console.log("PASS PDF UI: range preflight, explicit prepare, original/translated export with real Worker");

    await page.click("#manageExportFonts"); assert.equal(await visible("#settingsPanel"), true);
    const fontButton = page.locator("#exportFontList button").first(); await fontButton.click();
    assert.equal(await fontButton.isDisabled(), true);
    // P7-D：默认层级的状态行在「管理字体」之外，列表里发起下载时它同步显示「下载中」。
    await page.waitForFunction(() => document.getElementById("exportFontState").textContent === "下载中");
    assert.match(await page.textContent("#exportFontDetail"), /正在下载/);
    assert.equal(await page.locator("#exportFonts").evaluate(element => element.contains(document.getElementById("exportFontState"))), false,
      "status line must stay outside the 管理字体 disclosure");
    await page.locator("#exportFonts > summary").click(); await page.locator("#exportFonts > summary").click();
    assert.equal(await page.locator("#exportFontList button").first().isDisabled(), true);
    assert.equal(await page.evaluate(() => pdfUiTest.authorizations), 1);
    await page.evaluate(() => Object.values(pdfUiTest.downloads)[0].finish(true));
    await page.waitForFunction(() => document.getElementById("exportFontStatus").dataset.error === "true");
    await page.locator("#exportFontList button").first().click();
    await page.evaluate(() => Object.values(pdfUiTest.downloads)[0].finish());
    await page.waitForFunction(() => /已安装/.test(document.getElementById("exportFontList").textContent));
    // P7-D：存储占用按真正存入本机的那一项统计；损坏字体的重下载入口随已安装项出现。
    await page.waitForFunction(() => /本机已存 1 项/.test(document.getElementById("exportFontStorage").textContent));
    assert.equal(await page.isVisible("#exportFontRepair"), true);
    // 维护能力仍在同一层：删除后占用归零，状态行不再停留在「下载中」。
    await page.locator("#exportFontList button").first().click();
    await page.waitForFunction(() => /没有已下载的导出字体/.test(document.getElementById("exportFontStorage").textContent));
    assert.equal(await page.evaluate(() => document.getElementById("exportFontState").textContent === "下载中"), false,
      "idle status line should not stay on 下载中");
    await page.locator("#ocrModels summary").click();
    await page.locator("#ocrModelList button").first().click();
    await page.locator("#ocrModelList .resource-cancel").click();
    await page.waitForFunction(() => /已取消下载/.test(document.getElementById("ocrModelStatus").textContent));
    assert.equal(await page.locator("#ocrModelStatus").getAttribute("data-error"), "false");
    await page.locator("#ocrModelList button").first().click();
    await page.locator("#ocrModels summary").click(); await page.locator("#ocrModels summary").click();
    assert.equal(await page.locator("#ocrModelList button").first().isDisabled(), true);
    await page.evaluate(() => Object.entries(pdfUiTest.downloads).find(([key]) => key.startsWith("model"))[1].finish());
    await page.waitForFunction(() => /已安装/.test(document.getElementById("ocrModelList").textContent));
    await page.locator("#ocrModelList button").first().click();
    await page.waitForFunction(() => !/已安装/.test(document.getElementById("ocrModelList").textContent));
    await page.keyboard.press("Escape");
    console.log("PASS PDF UI: resource authorization, retained download state, errors/retry and model deletion");

    await page.evaluate(() => { pdfUiTest.delay = 600; pdfUiTest.long = false; });
    await page.click("#startTranslation"); await page.waitForFunction(() => !document.getElementById("activityIndicator").hidden);
    await page.click("#cancelTranslation"); assert.match(await page.locator("#startTranslation").innerText(), /继续/);
    await page.click("#startTranslation"); await waitDone();
    await page.evaluate(() => { pdfUiTest.delay = 600; });
    const beforeDisconnect = await calls();
    await page.click("#startTranslation"); await page.waitForFunction(count => pdfUiTest.calls.length > count, beforeDisconnect);
    await page.evaluate(() => pdfUiTest.disconnect());
    await page.waitForFunction(() => /中断/.test(document.getElementById("translationStatus").textContent));
    assert.equal(await page.locator("#translationPanelStatus").getAttribute("data-error"), "true");
    await page.evaluate(() => { pdfUiTest.delay = 0; }); await page.click("#startTranslation"); await waitDone();
    await page.click('#translationConfigSummary');await page.selectOption("#translationTo", "es");
    assert.ok(await page.locator(".translation-result").count() > 0, "draft configuration preserves existing translations");
    assert.equal(await visible("#applyHeaderConfig"), true);
    assert.equal(await visible("#settingsPanel"), false);
    assert.equal(await page.locator("#startTranslation").isDisabled(), true);
    await page.click("#applyHeaderConfig");
    assert.equal(await visible('#languagePopover'),false,'applying a language restores the compact header');
    assert.equal(await page.locator(".translation-result").count(), 0);
    await page.keyboard.press("Escape"); await page.click("#startTranslation"); await waitDone();
    await page.evaluate(() => { pdfUiTest.failAt = "paragraph 3"; }); await page.click("#startTranslation");
    await page.waitForFunction(() => document.getElementById("startTranslation").textContent === "重试未完成");
    assert.match(await page.locator("#translationFailed").innerText(), /失败 1/);
    if (!await visible("#translationCard")) await page.click("#toggleTextComparison");
    await page.selectOption("#comparisonFilter", "failed");
    assert.equal(await page.locator(".translation-row:visible").count(), 1);
    assert.match(await page.locator(".translation-row:visible .translation-note").innerText(), /翻译失败/);
    await page.click("#toggleTextComparison");
    await page.click("#translationFailed");
    assert.equal(await page.inputValue("#comparisonFilter"), "failed");
    assert.equal(await page.locator("#translationRows .translation-row-active .translation-note").getAttribute("data-error"), "true");
    const retryBefore = await calls(); await page.click("#startTranslation"); await waitDone();
    assert.equal(await calls(), retryBefore + 1, "continue retries only the failed remaining block");
    console.log("PASS PDF UI: busy/cancel/continue, backend disconnect and configuration isolation");

    await page.evaluate(() => { pdfUiTest.delay = 400; });
    const lateBefore = await calls(); await page.click("#startTranslation");
    await page.waitForFunction(count => pdfUiTest.calls.length > count, lateBefore);
    await upload(pdfs.blank, "blank.pdf");
    // 旧请求可返回，但新文件的对照区不能接收旧译文。
    await page.waitForFunction(() => document.getElementById("fileName").textContent === "blank.pdf");
    await page.evaluate(() => { pdfUiTest.delay = 0; }); const blankBefore = await calls();
    await page.click("#startTranslation");
    await page.waitForFunction(() => /空白页/.test(document.getElementById("translationStatus").textContent));
    assert.equal(await calls(), blankBefore);
    await upload(pdfs.scanned, "scan.pdf"); await page.evaluate(() => { pdfUiTest.ocrDelay = 500; });
    await page.click("#startTranslation");
    await page.waitForFunction(() => /识别/.test(document.getElementById("translationStatus").textContent));
    await page.click("#cancelTranslation");
    await page.evaluate(() => { pdfUiTest.ocrDelay = 0; }); await page.click("#startTranslation"); await waitDone();
    assert.doesNotMatch(await page.locator("#translationRows").textContent(), /Reading example/);
    assert.ok(await page.evaluate(() => pdfUiTest.ocrCalls) > 0);
    assert.match(await page.locator("#translationRows").textContent(), /Recognized text/);
    const ocrCount = await page.evaluate(() => pdfUiTest.ocrCalls), scanCalls = await calls();
    await setZoom("fit-page"); await waitReady();
    for (const mode of ["original", "bilingual", "translated"]) await setViewMode(mode);
    assert.equal(await page.evaluate(() => pdfUiTest.ocrCalls), ocrCount, "reading layout must not rerun OCR");
    assert.equal(await calls(), scanCalls);
    await page.click("#openFilePanel"); await page.fill("#pdfUrl", "http://127.0.0.1:" + server.address().port + "/denied.pdf");
    await page.click("#loadUrl"); await page.waitForFunction(() => document.getElementById("status").dataset.error === "true");
    assert.match(await page.locator("#readerStatusSummary").innerText(), /403/);
    assert.equal(await visible("#retrySource"), true); assert.equal(await visible("#retry"), false);
    await page.fill("#pdfUrl", "http://127.0.0.1:" + server.address().port + "/fixture.pdf"); await page.locator("#pdfUrl").press("Enter"); await waitReady();
    assert.equal(await page.locator("#fileName").innerText(), "fixture.pdf");
    assert.equal(await page.inputValue("#zoom"),"100%","opening an online PDF uses the same 100% default");
    await page.click("#openFilePanel"); await page.fill("#pdfUrl", "http://127.0.0.1:" + server.address().port + "/slow.pdf");
    await page.click("#loadUrl"); await page.waitForFunction(() => document.getElementById("loadUrl").disabled);
    assert.equal(await page.locator("#selectFile").isDisabled(), true); await page.click("#cancel");
    await page.waitForFunction(() => !document.getElementById("loadUrl").disabled && /取消/.test(document.getElementById("status").textContent));
    await page.fill("#pdfUrl", "http://127.0.0.1:" + server.address().port + "/fixture.pdf"); await page.click("#loadUrl"); await waitReady();
    console.log("PASS PDF UI: blank-page no-request, OCR-provider boundary, online load and HTTP error recovery");

    await page.evaluate(() => { pdfUiTest.targetText = "你好 · 日本語 · Linux"; });
    await page.click("#startTranslation"); await waitDone();
    assert.match(await page.locator("#translationRows").textContent(), /你好 · 日本語 · Linux/);
    for (const width of [1440, 1024, 700, 390]) {
      await page.setViewportSize({width, height: 850});
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "no horizontal document overflow: " + width);
      await page.click("#openSettingsPanel");
      const panel = await page.locator("#readerPanel").boundingBox(); assert.ok(panel.x >= 0 && panel.x + panel.width <= width);
      await page.keyboard.press("Escape");
    }
    await page.emulateMedia({colorScheme: "dark", reducedMotion: "reduce"});
    await setViewMode("bilingual"); assert.equal(await visible("#structuredCard"), true);
    await page.reload();
    await page.waitForFunction(() => document.getElementById("translationConfigSummary").textContent.includes("Google"));
    assert.equal(await page.locator("#comparisonSplitter").getAttribute("aria-valuenow"), "35", "restore saved split ratio");
    await page.setViewportSize({width:1440,height:900});
    await upload(pdfs.native);await page.click("#startTranslation");await waitDone();await setViewMode("bilingual");
    assert.equal(await page.inputValue('#bilingualLayout'),'flow','bilingual defaults to the document editor');
    await page.selectOption('#bilingualLayout','page');
    await page.waitForSelector('#bilingualCanvasHost .pdf-place-text');
    assert.equal(await visible('#editorViewport'),false);
    assert.equal(await visible('#translationCard'),false);
    const bilingualCalls=await calls();
    await page.evaluate(()=>{window.bilingualSourceCanvas=document.querySelector('#canvasHost canvas');});
    const rightPage=await page.evaluate(()=>{
      const source=document.querySelector('#canvasHost canvas'),copy=document.querySelector('#bilingualCanvasHost canvas');
      return {sourceRatio:source.width/source.height,copyRatio:copy.width/copy.height,pixels:copy.width*copy.height};
    });
    assert.ok(Math.abs(rightPage.sourceRatio-rightPage.copyRatio)<.01,'translated page preserves the source page aspect ratio');
    assert.ok(rightPage.pixels<=4000000,'one bounded preview bitmap');
    await page.click('#openSettingsPanel');assert.equal(await page.locator('#bilingualCanvasHost canvas').count(),0,'hidden task panels release the preview');
    await page.keyboard.press('Escape');await page.waitForSelector('#bilingualCanvasHost .pdf-place-text');
    await page.selectOption('#bilingualLayout','flow');assert.equal(await visible('#editorViewport'),true);
    assert.equal(await page.locator('#bilingualCanvasHost canvas').count(),0);
    await page.selectOption('#bilingualLayout','page');await page.waitForSelector('#bilingualCanvasHost .pdf-place-text');
    assert.equal(await calls(),bilingualCalls,'bilingual presentation and task panels must not translate');
    assert.equal(await page.evaluate(()=>bilingualSourceCanvas===document.querySelector('#canvasHost canvas')),true);
    await page.selectOption('#bilingualLayout','flow');
    await page.waitForFunction(()=>document.getElementById('editorPaper').contentEditable==='true');
    assert.equal(await page.locator('#reflowEditor, .structured-actions, .structured-editor').count(),0);
    // 双向定位只改变滚动与高亮，不修改编辑稿、切换模式或发起翻译。
    const linkedBefore=await page.locator('#editorPaper').textContent(),linkedCalls=await calls();
    const sourceAt=await page.locator('#editorPaper [data-block-id]').first().getAttribute('data-block-id');
    await page.locator('#editorPaper [data-block-id]').first().click();await page.waitForSelector('#canvasHost .pdf-marker-flash');
    assert.equal(await page.locator('#editorPaper .editor-selected').first().getAttribute('data-block-id'),sourceAt);
    await page.evaluate(()=>document.querySelector('#canvasHost .pdf-marker-flash')?.remove());
    await page.locator('#viewport').evaluate(node=>{node.scrollTop=0;node.scrollLeft=0;});
    await page.locator('#canvasHost canvas').evaluate(canvas=>{
      const rect=canvas.getBoundingClientRect();canvas.dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:rect.left+rect.width*100/600,clientY:rect.top+rect.height*95/800}));
    });
    assert.equal(await page.locator('#editorPaper .editor-selected').first().getAttribute('data-block-id'),sourceAt,'source text click highlights its editor paragraph');
    assert.equal(await page.locator('#editorPaper').textContent(),linkedBefore);assert.equal(await calls(),linkedCalls);
    assert.equal(await page.inputValue('#viewMode'),'bilingual');
    await page.click('#next');await waitDone();
    await page.waitForFunction(()=>document.getElementById('editorStatus').textContent.includes('原文第 2 页')&&document.getElementById('editorPaper').textContent.trim().length>0);
    await page.click('#previous');await waitDone();
    await page.waitForFunction(()=>document.getElementById('editorStatus').textContent.includes('原文第 1 页')&&document.getElementById('editorPaper').textContent.trim().length>0);
    await page.evaluate(async()=>{
      // 用独立宿主和延迟存储重现翻页清屏时失焦，不动真实阅读器和数据库。
      const host=document.createElement('div');host.innerHTML=document.getElementById('structuredCard').innerHTML;
      const paper=host.querySelector('#editorPaper'),viewport=host.querySelector('#editorViewport'),toolbar=host.querySelector('#editorToolbar'),status=host.querySelector('#editorStatus');
      const documentFor=text=>({version:1,page:{width:600,height:800,margin:20},style:{fontSize:'10pt'},children:text?[{tag:'p',sourceId:'block',children:[text]}]:[]});
      const saved=new Map([['A',{document:documentFor('Page A draft'),revision:1}],['B',{document:documentFor('Page B draft'),revision:1}],['C',{document:documentFor(''),revision:1}]]),writes=[];
      let key='A',releaseB;
      const input=()=>({key,page:key==='A'?1:key==='B'?2:3,name:'test.pdf',available:true,busy:false,signature:key,
        rows:[{block:{id:'block',text:'Source paragraph',role:'text',kind:'paragraph',height:10,eligible:true,reliable:true,order:0,rect:{x:20,y:20,right:250,bottom:50},lines:[]},result:{status:'translated',text:'Recovered translation'}}],
        geometry:{pageNumber:3,width:600,height:800,visuals:[]},scale:1});
      const storage={read:async value=>{if(value==='B')await new Promise(resolve=>{releaseB=resolve;});return saved.get(value)||null;},
        write:async(value,document,revision,meta)=>{writes.push({value,document,meta});const record={document,revision:revision+1,...meta};saved.set(value,record);return record;},remove:async()=>{}};
      const replace=paper.replaceChildren.bind(paper);
      paper.replaceChildren=(...nodes)=>{replace(...nodes);paper.dispatchEvent(new FocusEvent('blur'));};
      const editor=BT_PDF_DOCUMENT_EDITOR.create({viewport,paper,toolbar,status,getInput:input,onLocate:()=>{},storage});
      try{
        await editor.update();if(paper.textContent!=='Page A draft')throw new Error('first draft not mounted');
        key='B';const waiting=editor.update();paper.dispatchEvent(new FocusEvent('blur'));
        key='A';await editor.update();releaseB();await waiting;
        if(paper.textContent!=='Page A draft'||writes.length)throw new Error('late read or cleared DOM overwrote an untouched draft');
        key='B';await editor.update();if(paper.textContent!=='Page B draft'||writes.length)throw new Error('cached-page mount became an empty saved draft');
        key='C';await editor.update();if(host.querySelector('#editorRecovery').hidden)throw new Error('legacy blank draft has no recovery entry');
        host.querySelector('#editorRecover').click();if(!paper.textContent.includes('Recovered translation'))throw new Error('blank draft recovery did not import existing translation');
        toolbar.querySelector('[data-action="save"]').click();await new Promise(resolve=>setTimeout(resolve,0));
        replace();paper.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'deleteContentBackward'}));
        toolbar.querySelector('[data-action="save"]').click();await new Promise(resolve=>setTimeout(resolve,0));
        if(saved.get('C').intentionalEmpty!==true)throw new Error('intentional user clearing was not distinguished from a legacy empty draft');
      }finally{editor.dispose();}
    });
    await page.evaluate(()=>{
      const O=BT_PDF_EDITOR_OPERATIONS,root=document.createElement('div');
      const rect={x:0,y:0,right:100,bottom:100},small={x:20,y:20,right:30,bottom:30};
      if(O.pickSource([{id:'large',rect},{id:'small',rect:small}],25,25)?.id!=='small')throw new Error('overlapping region chose the first rather than smallest target');
      if(O.pickSource([{id:'small',rect:small},{id:'line',rect,lines:[{rect:small}]}],25,25)?.id!=='line')throw new Error('text-line evidence was ignored');
      if(O.pickSource([{id:'small',rect:small}],80,80))throw new Error('blank space guessed another paragraph');
      root.innerHTML='<p>Alpha <b>Beta</b> a+b[0] 😀</p><p>Gamma</p><table><tbody><tr><td>One</td><td>Two</td></tr></tbody></table>';
      if(O.find(root,'alpha beta').ranges.length!==1)throw new Error('styled text not found');
      if(O.find(root,'alpha beta',{caseSensitive:true}).ranges.length)throw new Error('case-sensitive search ignored');
      if(O.find(root,'a+b[0]').ranges.length!==1||O.find(root,'😀').ranges.length!==1)throw new Error('literal or unicode search failed');
      if(O.find(root,'😀Gamma').ranges.length||O.find(root,'OneTwo').ranges.length)throw new Error('search crossed a structure boundary');
      const match=O.find(root,'Beta').ranges[0],mark=O.bookmark(root,match);root.innerHTML=root.innerHTML;
      if(O.restore(root,mark)?.toString()!=='Beta')throw new Error('selection bookmark not restored');
      root.textContent='x x x';const limited=O.find(root,'x',{limit:2});if(!limited.limited||limited.ranges.length!==2)throw new Error('match budget ignored');
      root.style.fontSize='10pt';root.innerHTML='<h2>Title</h2>';
      let range=document.createRange();range.selectNodeContents(root.firstChild);range.collapse(false);
      if(!O.newline(root,range)||root.lastElementChild.tagName!=='P'||root.lastElementChild.style.fontSize!=='10pt')throw new Error('heading did not continue as body');
      root.innerHTML='<p>one <b>two</b> three</p>';
      range=document.createRange();range.setStart(root.querySelector('b').firstChild,1);range.collapse(true);
      if(!O.newline(root,range,{soft:true})||root.children.length!==1||root.textContent!=='one two three'||root.querySelector('b').textContent!=='t')throw new Error('soft break lost text or changed trailing styles');
      root.innerHTML='<table><tbody><tr><td><p>Cell text</p></td></tr></tbody></table>';
      range=document.createRange();range.setStart(root.querySelector('p').firstChild,4);range.collapse(true);
      if(!O.newline(root,range)||root.querySelectorAll('td').length!==1||root.querySelectorAll('td > p').length!==2)throw new Error('paragraph break damaged the table');
    });
    const beforeEditor=await calls();
    await page.locator('#editorPaper').evaluate(node=>{
      node.innerHTML='<p><span style="font-size:10pt;font-family:sans-serif">small </span><strong style="font-size:20pt;font-family:serif">large</strong></p>';
      node.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText'}));node.focus();
      const range=document.createRange();range.selectNodeContents(node);getSelection().removeAllRanges();getSelection().addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
    });
    assert.equal(await page.locator('[data-action="size"]').inputValue(),'','mixed font sizes do not show a misleading single value');
    assert.equal(await page.locator('[data-action="family"]').inputValue(),'');
    assert.equal(await page.locator('[data-action="bold"]').getAttribute('aria-pressed'),'mixed');
    await page.locator('#editorPaper').fill('Draft');await page.locator('[data-action="save"]').click();
    await page.waitForFunction(()=>document.getElementById('editorStatus').textContent.includes('编辑稿已保存'));
    await page.locator('#editorPaper').press('ControlOrMeta+End');await page.keyboard.type(' typed');
    await page.locator('#editorPaper').evaluate(node=>{
      node.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));
      document.execCommand('insertText',false,'中文');
      node.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'中文'}));
    });
    await page.locator('#editorPaper').press('ControlOrMeta+Z');
    assert.equal(await page.locator('#editorPaper').textContent(),'Draft typed','undo separates IME text from earlier typing');
    await page.locator('#editorPaper').evaluate(node=>{
      const data=new DataTransfer();data.setData('text/plain',' pasted');
      node.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));
    });
    await page.locator('#editorPaper').press('ControlOrMeta+Z');
    assert.equal(await page.locator('#editorPaper').textContent(),'Draft typed','undoing paste preserves previously typed text');
    await page.locator('.editor-more summary').click();await page.selectOption('[data-view="paste"]','plain');
    await page.locator('#editorPaper').press('ControlOrMeta+End');
    const beforePlainParagraphs=await page.locator('#editorPaper p').count();
    await page.locator('#editorPaper').evaluate(node=>{
      const data=new DataTransfer();data.setData('text/plain',' plain');data.setData('text/html','<h1> plain</h1>');
      node.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));
    });
    assert.equal(await page.locator('#editorPaper').textContent(),'Draft typed plain');
    assert.equal(await page.locator('#editorPaper p').count(),beforePlainParagraphs,'single-line plain paste stays in the current paragraph');
    assert.equal(await page.locator('#editorPaper h1').count(),0,'plain paste ignores clipboard formatting');
    await page.locator('#editorPaper').press('ControlOrMeta+Z');
    await page.selectOption('[data-view="paste"]','formatted');await page.locator('.editor-more summary').click();
    await page.locator('#editorPaper').fill('An edited document paragraph.');
    await page.locator('#editorPaper').press('ControlOrMeta+A');
    await page.locator('[data-action="size"]').fill('14');
    await page.locator('[data-action="bold"]').click();
    assert.equal(await page.evaluate(()=>getSelection().toString()),'An edited document paragraph.','consecutive toolbar changes use the same selection');
    const beforeFormatSpans=await page.locator('#editorPaper span').count();
    for(let size=15;size<=22;size++){
      await page.locator('[data-action="size"]').fill(String(size));await page.locator('[data-action="size"]').press('Tab');
    }
    await page.locator('[data-action="size"]').fill('14');await page.locator('[data-action="size"]').press('Tab');
    assert.ok(await page.locator('#editorPaper span').count()<=beforeFormatSpans+1,'repeated font changes reuse an existing format wrapper');
    await page.locator('[data-action="save"]').click();
    await page.waitForFunction(()=>document.getElementById('editorStatus').textContent.includes('编辑稿已保存'));
    assert.ok(await page.locator('#editorPaper span').evaluateAll(nodes=>nodes.some(node=>node.style.fontSize==='14pt')));
    await page.locator('#editorPaper').click();await page.locator('#editorPaper').press('ControlOrMeta+End');
    await page.locator('.editor-more summary').click();
    await page.locator('[data-action="table"]').click();
    assert.equal(await page.locator('#editorPaper table td').count(),4);
    assert.equal(await page.locator('#editorPaper p table, #editorPaper span table').count(),0,'block insertion stays outside paragraph and inline wrappers');
    await page.locator('#editorPaper table td').first().click();
    await page.locator('[data-action="row-add"]').click();assert.equal(await page.locator('#editorPaper table tr').count(),3);
    await page.locator('[data-action="column-add"]').click();assert.equal(await page.locator('#editorPaper table td').count(),9);
    await page.locator('[data-action="row-remove"]').click();
    await page.locator('[data-action="column-remove"]').click();assert.equal(await page.locator('#editorPaper table td').count(),4);
    const beforeZoom=await page.locator('#editorPaper').evaluate(node=>node.textContent);
    await page.selectOption('[data-view="zoom"]','1.5');
    assert.equal(await page.locator('#editorPaper').evaluate(node=>node.style.zoom),'1.125');
    assert.equal(await page.locator('#editorPaper').textContent(),beforeZoom,'view zoom does not change document content');
    await page.fill('#zoom','120%');await page.locator('#zoom').press('Enter');await waitReady();
    assert.equal(await page.locator('[data-view="zoom"]').inputValue(),'reader','top zoom resumes linked control of both sides');
    await page.waitForFunction(()=>Math.abs(Number(document.getElementById('editorPaper').style.zoom)-.9)<.00001);
    await page.click('#zoomIn');await waitReady();
    await page.waitForFunction(()=>Math.abs(Number(document.getElementById('editorPaper').style.zoom)-.975)<.00001);
    await page.click('#zoomOut');await waitReady();
    await page.waitForFunction(()=>Math.abs(Number(document.getElementById('editorPaper').style.zoom)-.9)<.00001);
    await page.click('#zoomFit');await waitReady();
    assert.equal(await page.locator('[data-view="zoom"]').inputValue(),'reader','fit actions keep the editor linked');
    await page.click('#editorToggleTools');assert.equal(await visible('#editorToolbar'),false);
    assert.equal(await page.locator('#editorPaper').getAttribute('contenteditable'),'true','collapsing tools preserves direct editing');
    assert.equal(await page.locator('#editorPaper').textContent(),beforeZoom,'collapsing tools preserves the current document');
    await page.click('#editorToggleTools');assert.equal(await visible('#editorToolbar'),true);
    await page.locator('[data-ui="find"]').click();
    await page.locator('[data-find="query"]').fill('edited document');
    await page.locator('[data-search="next"]').click();
    assert.equal(await page.evaluate(()=>getSelection().toString()),'edited document','search works across inline formatting');
    await page.locator('[data-find="replacement"]').fill('revised document');
    await page.locator('[data-search="replace"]').click();
    assert.match(await page.locator('#editorPaper').textContent(),/An revised document paragraph/);
    await page.locator('[data-action="undo"]').click();
    assert.match(await page.locator('#editorPaper').textContent(),/An edited document paragraph/);
    assert.equal(await page.evaluate(()=>getSelection().toString()),'edited document','undo restores the edited selection');
    await page.locator('[data-ui="close-find"]').click();
    await page.selectOption('[data-page="preset"]','a4');await page.locator('[data-page="margin"]').fill('15');
    await page.locator('[data-action="page-apply"]').click();
    const editorPage=await page.locator('#editorPaper').evaluate(node=>({width:node.style.width,padding:node.style.padding}));
    assert.equal(editorPage.width,'595.28pt');assert.equal(editorPage.padding,'42.52pt');
    await page.locator('[data-page="margin"]').fill('1000');await page.locator('[data-action="page-apply"]').click();
    assert.equal(await page.locator('#editorPaper').evaluate(node=>node.style.padding),'42.52pt','invalid margins leave the document unchanged');
    await page.locator('[data-action="save"]').click();await page.waitForFunction(()=>document.getElementById('editorStatus').textContent.includes('编辑稿已保存'));
    await page.click('#next');await waitDone();await page.click('#previous');await waitDone();
    await page.waitForFunction(()=>document.getElementById('editorPaper').textContent.includes('An edited document paragraph.'));
    assert.equal(await page.locator('#editorPaper table td').count(),4,'page-local custom layout survives navigation');
    assert.ok(!(await page.locator('#translationRows').textContent()).includes('An edited document paragraph.'),'custom editor does not overwrite machine results');
    await page.click('#openSettingsPanel');await page.keyboard.press('Escape');
    assert.match(await page.locator('#editorPaper').textContent(),/An edited document paragraph/);
    assert.equal(await calls(),beforeEditor,'editing and returning to cached pages must not translate');
    await page.context().addInitScript(()=>{window.print=()=>{window.__editorPrinted=true;};});
    const popupPromise=page.waitForEvent('popup');await page.locator('[data-action="export"]').click();const printPage=await popupPromise;
    await printPage.waitForFunction(()=>window.__editorPrinted===true);
    assert.match(await printPage.locator('#printPaper').textContent(),/An edited document paragraph/);
    assert.equal(await printPage.locator('#printPaper table td').count(),4,'print output uses custom layout');
    assert.equal(await printPage.locator('#printPaper').evaluate(node=>node.style.width),'595.28pt','custom paper size reaches the print document');await printPage.close();
    await page.reload();await page.waitForFunction(()=>document.getElementById('translationConfigSummary').textContent.includes('Google'));
    await upload(pdfs.native);await setViewMode('bilingual');await page.selectOption('#bilingualLayout','flow');
    await page.waitForFunction(()=>document.getElementById('editorPaper').textContent.includes('An edited document paragraph.'));
    assert.equal(await page.locator('#editorPaper').getAttribute('contenteditable'),'true','saved custom document opens without translating again');
    // 存储事务拒绝迟到写入和并行编辑冲突，不覆盖另一页或另一标签保存的版本。
    await page.evaluate(async()=>{
      const store=BT_PDF_EDITOR_STORE.create(),key='editor-transaction-regression',document={version:1,page:{width:600,height:800,margin:20},style:{},children:[{tag:'p',children:['sample']}]};
      const first=await store.write(key,document,0);let conflict=false;
      try{await store.write(key,document,0);}catch(_){conflict=true;}
      if(!conflict)throw new Error('conflicting write accepted');
      const second=await store.write(key,document,first.revision);await store.remove(key,second.revision);
      if(await store.read(key))throw new Error('document not removed');
    });
    console.log('PASS PDF editor: direct editing, format, tables, persistence, page isolation, print model and storage conflicts');
    await page.evaluate(()=>{pdfUiTest.long=false;delete pdfUiTest.targetText;});
    await upload(pdfs.complex,'complex-content.pdf');await setViewMode('bilingual');await page.selectOption('#bilingualLayout','flow');
    await page.click('#startTranslation');await waitDone();await page.waitForSelector('#editorPaper table');
    assert.equal(await page.locator('#editorPaper table td').count(),9,'source table imports with cell structure');
    await page.click('#next');await waitDone();await page.waitForSelector('#editorPaper img');
    assert.equal(await page.locator('#editorPaper img').count(),1,'diagram imports once rather than as separate labels');
    assert.match(await page.locator('#editorPaper img').getAttribute('src'),/^data:image\/png;base64,/);
    await page.locator('#editorPaper img').click();
    await page.waitForSelector('#canvasHost .pdf-marker-flash');
    assert.equal(await page.locator('#editorPaper img.editor-selected').count(),1,'figure click locates and highlights the original region');
    await page.selectOption('[data-action="image-width"]','50');await page.selectOption('[data-action="image-align"]','right');
    const imageStyle=await page.locator('#editorPaper img').evaluate(node=>({width:node.style.width,left:node.style.marginLeft,right:node.style.marginRight}));
    assert.equal(imageStyle.width,'50%');assert.equal(imageStyle.left,'auto');assert.ok(['0pt','0px'].includes(imageStyle.right));
    await page.locator('[data-action="save"]').click();await page.waitForFunction(()=>document.getElementById('editorStatus').textContent.includes('编辑稿已保存'));
    await page.click('#previous');await waitDone();await page.click('#next');await waitDone();
    await page.waitForFunction(()=>document.querySelector('#editorPaper img')?.style.width==='50%');
    assert.deepEqual(errors, [], "no unhandled browser errors");
    console.log("PASS PDF UI: responsive bounds, dark/reduced-motion modes and clean browser runtime");
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
