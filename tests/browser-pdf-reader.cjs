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
    postMessage(...args) { if (this.isExport && control.holdExport) { control.exportHeld = true; return; } super.postMessage(...args); }
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
    await page.click("#zoomIn"); await waitReady();
    assert.equal(await page.inputValue("#zoom"),"110%");
    await page.click("#zoomOut"); await waitReady();
    assert.equal(await page.inputValue("#zoom"),"100%");
    await page.fill("#zoom","500%"); await page.locator("#zoom").press("Enter");
    assert.equal(await page.locator("#zoom").getAttribute("data-scale"),"1");
    await page.locator("#zoom").press("Escape");
    await setZoom("fit-page"); await waitReady();
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
        await page.locator("#comparisonSplitter").focus(); await page.keyboard.press("ArrowLeft");
        assert.equal(await page.locator("#comparisonSplitter").getAttribute("aria-valuenow"), "55");
        const box = await page.locator("#comparisonSplitter").boundingBox();
        await page.mouse.move(box.x + 4, box.y + 30); await page.mouse.down();
        await page.mouse.move(box.x + 90, box.y + 30); await page.mouse.up();
        assert.ok(Number(await page.locator("#comparisonSplitter").getAttribute("aria-valuenow")) > 55);
      }
    }
    assert.equal(await page.evaluate(() => savedCanvas === document.querySelector("#canvasHost canvas")), true);
    assert.equal(await calls(), 0, "display-only actions must not translate");
    await page.click("#translationConfigSummary"); assert.equal(await visible("#settingsPanel"), true);
    assert.match(await page.locator("#translationConfigSummary").innerText(), /^Google 翻译 · 自动 → 法语$/);
    await page.click("#openFilePanel"); assert.equal(await visible("#settingsPanel"), false);
    assert.equal(await visible("#retry"), false); assert.equal(await visible("#cancel"), false);
    await page.keyboard.press("Escape");
    await page.click("#startTranslation"); await waitDone();
    await page.waitForSelector(".pdf-marker");
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
      assert.equal(await page.inputValue("#zoom"), fitted.scale);
      assert.equal(await page.inputValue("#pageNumber"), fitted.page);
      assert.equal(await page.locator("#rotate").getAttribute("title"), fitted.rotation);
      await page.waitForTimeout(250);await waitReady();
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
    await page.click("#openSettingsPanel"); await page.selectOption("#translationTo", "es");
    assert.ok(await page.locator(".translation-result").count() > 0, "draft configuration preserves existing translations");
    assert.equal(await visible("#applyTranslationConfig"), true);
    assert.equal(await page.locator("#startTranslation").isDisabled(), true);
    await page.click("#applyTranslationConfig");
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
    assert.equal(await page.inputValue('#bilingualLayout'),'page','bilingual defaults to the translated page, independently of translation checks');
    await page.waitForSelector('#bilingualCanvasHost .pdf-place-text');
    assert.equal(await visible('#structuredRows'),false);
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
    await page.selectOption('#bilingualLayout','flow');assert.equal(await visible('#structuredRows'),true);
    assert.equal(await page.locator('#bilingualCanvasHost canvas').count(),0);
    await page.selectOption('#bilingualLayout','page');await page.waitForSelector('#bilingualCanvasHost .pdf-place-text');
    assert.equal(await calls(),bilingualCalls,'bilingual presentation and task panels must not translate');
    assert.equal(await page.evaluate(()=>bilingualSourceCanvas===document.querySelector('#canvasHost canvas')),true);
    await page.selectOption('#bilingualLayout','flow');
    const firstBlock=page.locator("#structuredRows .structured-block").first();
    const machineText=await firstBlock.locator(".structured-text").textContent();
    await setZoom("0.75");await waitReady();
    const locateCalls=await calls();await page.evaluate(()=>{window.locateCanvas=document.querySelector("#canvasHost canvas");});
    await firstBlock.locator(".structured-text").click();
    assert.equal(await firstBlock.getAttribute("aria-current"),"true");
    await page.locator("#structuredRows .structured-block").nth(1).locator(".structured-text").click();
    assert.equal(await firstBlock.getAttribute("aria-current"),null);
    await page.locator("#canvasHost canvas").click({position:{x:60,y:71}});
    assert.equal(await firstBlock.getAttribute("aria-current"),"true");
    assert.equal(await calls(),locateCalls,"two-way structured navigation must not translate");
    assert.equal(await page.evaluate(()=>locateCanvas===document.querySelector("#canvasHost canvas")),true,"two-way navigation preserves canvas");
    await setZoom("1");await waitReady();
    const editText=async text=>{
      await firstBlock.getByRole("button",{name:"编辑",exact:true}).click();
      await firstBlock.locator("textarea").fill(text);
      await firstBlock.getByRole("button",{name:"保存",exact:true}).click();
      await firstBlock.locator("textarea").waitFor({state:"hidden"});
    };
    await editText("Saved manual revision B");
    assert.match(await firstBlock.textContent(),/已修改/);
    await setViewMode("translated");
    await page.waitForFunction(()=>document.querySelector("#canvasHost .pdf-place-text")?.textContent.replace(/\s/g,"").includes("SavedmanualrevisionB"));
    await setViewMode("bilingual");
    await firstBlock.getByRole("button",{name:"编辑",exact:true}).click();await firstBlock.locator("textarea").fill("   ");
    await firstBlock.getByRole("button",{name:"保存",exact:true}).click();assert.match(await firstBlock.textContent(),/不能为空/);
    await firstBlock.locator("textarea").fill("Unsaved draft");
    await page.click("#openSettingsPanel");assert.equal(await visible("#structuredCard"),false);
    await page.keyboard.press("Escape");assert.equal(await firstBlock.locator("textarea").inputValue(),"Unsaved draft","task panels preserve editor draft");
    await setViewMode("original");assert.equal(await visible("#structuredCard"),false);await setViewMode("bilingual");
    assert.equal(await firstBlock.locator("textarea").inputValue(),"Unsaved draft");
    await page.click("#next");await waitDone();await page.click("#previous");await waitDone();
    assert.equal(await firstBlock.locator("textarea").inputValue(),"Unsaved draft");
    await firstBlock.getByRole("button",{name:"取消",exact:true}).click();
    assert.equal(await firstBlock.locator(".structured-text").textContent(),"Saved manual revision B");
    await page.click("#startTranslation");await waitDone();assert.equal(await firstBlock.locator(".structured-text").textContent(),"Saved manual revision B");
    await setZoom("1.25");await waitReady();
    const parseExport=async buffer=>page.evaluate(async bytes=>{
      const pdfjs=await import("/pdf/vendor/build/pdf.mjs");pdfjs.GlobalWorkerOptions.workerSrc="/pdf/vendor/build/pdf.worker.mjs";
      const loading=pdfjs.getDocument({data:new Uint8Array(bytes),standardFontDataUrl:"/pdf/vendor/standard_fonts/",verbosity:0}),doc=await loading.promise;
      let text="";for(let i=1;i<=doc.numPages;i++)text+=(await (await doc.getPage(i)).getTextContent()).items.map(item=>item.str||"").join(" ");
      await loading.destroy();return text;
    },[...buffer]);
    await page.click("#openExportPanel");assert.equal(await page.inputValue("#zoom"),"125%");
    assert.equal(await page.locator("#exportContent option[value=bilingual]").count(),0);
    for(const layout of ["preserved","structured"]){
      await page.selectOption("#exportContent","translated");await page.selectOption("#exportPages","current");await page.selectOption("#exportLayout",layout);
      const downloadPromise=page.waitForEvent("download");await page.click("#exportNow");const downloaded=await downloadPromise;
      assert.ok((await parseExport(fs.readFileSync(await downloaded.path()))).includes("Saved manual revision B"),"effective edits exported: "+layout);
    }
    await page.keyboard.press("Escape");assert.equal(await visible("#structuredCard"),true);assert.equal(await page.inputValue("#zoom"),"125%");
    await firstBlock.getByRole("button",{name:"恢复机器翻译",exact:true}).click();
    await page.waitForFunction(expected=>document.querySelector("#structuredRows .structured-text")?.textContent===expected,machineText);
    await editText("Saved manual revision B");
    await page.evaluate(()=>{pdfUiTest.delay=600;});const delayedCalls=await calls();await page.click("#startTranslation");
    await page.waitForFunction(count=>pdfUiTest.calls.length>count,delayedCalls);
    await editText("Saved manual revision C");await waitDone();
    assert.equal(await firstBlock.locator(".structured-text").textContent(),"Saved manual revision C");
    await page.reload();await upload(pdfs.native,"same-content-new-name.pdf");await page.click("#startTranslation");await waitDone();await setViewMode("bilingual");
    await page.selectOption('#bilingualLayout','flow');
    assert.equal(await firstBlock.locator(".structured-text").textContent(),"Saved manual revision C","saved edits survive reopening same bytes under a new name");
    await page.click("#openSettingsPanel");await page.selectOption("#translationTo","es");await page.click("#applyTranslationConfig");await page.keyboard.press("Escape");
    await page.click("#startTranslation");await waitDone();assert.notEqual(await firstBlock.locator(".structured-text").textContent(),"Saved manual revision C");
    await page.click("#openSettingsPanel");await page.selectOption("#translationTo","fr");await page.click("#applyTranslationConfig");await page.keyboard.press("Escape");
    await page.click("#startTranslation");await waitDone();assert.equal(await firstBlock.locator(".structured-text").textContent(),"Saved manual revision C");
    console.log("PASS PDF product: three modes, edit/save/cancel/restore, drafts, real edited exports, late-task protection and persistent language isolation");
    // 真实 PDF.js 结构、图片保留与编辑/导出链路；服务边界仍为可计数替身。
    await page.evaluate(()=>{pdfUiTest.delay=0;pdfUiTest.long=false;delete pdfUiTest.targetText;});
    await upload(pdfs.complex,'complex-content.pdf');await setViewMode('bilingual');
    const complexCalls=await calls();await page.click('#startTranslation');await waitDone();
    await page.waitForSelector('#structuredRows table');
    assert.equal(await page.locator('#structuredRows table tr').count(),3);
    assert.equal(await page.locator('#structuredRows table td').count(),9);
    assert.equal(await page.locator('.structured-contributor-columns').count(),1);
    const sent=await page.evaluate(n=>pdfUiTest.calls.slice(n).map(x=>x.text),complexCalls);
    assert.ok(!sent.some(s=>/Alice Smith|Bob Jones|alice@example|bob@example|Research Institute/.test(s)),'authors and affiliations stay protected');
    const cell=page.locator('#structuredRows td .structured-block').filter({hasText:'Translated: Cell 1 0'});
    await cell.hover();await cell.getByRole('button',{name:'编辑',exact:true}).click();
    await cell.locator('textarea').fill('Edited table cell');await cell.getByRole('button',{name:'保存',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('#structuredRows table')?.textContent.includes('Edited table cell'));
    await page.click('#openExportPanel');await page.selectOption('#exportPages','current');await page.selectOption('#exportLayout','structured');
    let complexDownload=page.waitForEvent('download');await page.click('#exportNow');let exported=await complexDownload;
    assert.match(await parseExport(fs.readFileSync(await exported.path())),/Edited table cell/);
    assert.match(exported.suggestedFilename(),/结构化译文/);await page.keyboard.press('Escape');
    await page.click('#next');await waitDone();
    await page.waitForFunction(()=>{const c=document.querySelector('#structuredRows .structured-visual');return c&&!c.hidden&&c.width>10;});
    assert.equal(await page.locator('#structuredRows .structured-visual').count(),1,'one diagram preview, not one per label');
    const diagramPixels=await page.locator('#structuredRows .structured-visual').evaluate(canvas=>{
      const pixels=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;let dark=0;
      for(let i=0;i<pixels.length;i+=4)if(pixels[i]<150&&pixels[i+1]<150&&pixels[i+2]<150)dark++;return dark;
    });assert.ok(diagramPixels>50,'the diagram contains real original strokes');
    const label=page.locator('#structuredRows .structured-figure .structured-block').filter({hasText:'Translated: Input'});
    await label.hover();await label.getByRole('button',{name:'编辑',exact:true}).click();await label.locator('textarea').fill('Edited graph label');
    await label.getByRole('button',{name:'保存',exact:true}).click();await page.waitForFunction(()=>document.getElementById('structuredRows').textContent.includes('Edited graph label'));
    const revisedLabel=page.locator('#structuredRows .structured-figure .structured-block').filter({hasText:'Edited graph label'});
    await revisedLabel.click();await page.waitForSelector('.pdf-marker-flash');
    await page.click('#openExportPanel');await page.selectOption('#exportLayout','structured');complexDownload=page.waitForEvent('download');await page.click('#exportNow');exported=await complexDownload;
    assert.match(await parseExport(fs.readFileSync(await exported.path())),/Edited graph label/);await page.keyboard.press('Escape');
    const noReissue=await calls();await setZoom("1.25");await waitReady();
    await setViewMode('original');await setViewMode('translated');await setViewMode('bilingual');assert.equal(await calls(),noReissue);
    assert.match(await revisedLabel.textContent(),/Edited graph label/,'graph label edit survives zoom and mode changes');
    await page.click('#next');await waitDone();
    await page.waitForFunction(()=>{const c=document.querySelector('#structuredRows .structured-visual');return c&&!c.hidden&&c.width>10;});
    assert.equal(await page.locator('#structuredRows .structured-visual').count(),1);
    const photo=await page.locator('#structuredRows .structured-visual').evaluate(canvas=>{
      const p=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;let colored=0;
      for(let i=0;i<p.length;i+=4)if(p[i+2]>p[i]+30)colored++;return {ratio:canvas.width/canvas.height,colored};
    });assert.ok(photo.colored>100,'embedded bitmap retains its colored pixels');assert.ok(Math.abs(photo.ratio-200/140)<.03);
    await page.click('#openExportPanel');await page.selectOption('#exportLayout','structured');complexDownload=page.waitForEvent('download');await page.click('#exportNow');exported=await complexDownload;
    const exportedImage=await page.evaluate(async bytes=>{
      const pdfjs=await import('/pdf/vendor/build/pdf.mjs');const loading=pdfjs.getDocument({data:new Uint8Array(bytes),standardFontDataUrl:'/pdf/vendor/standard_fonts/',verbosity:0}),doc=await loading.promise;
      let images=0;for(let i=1;i<=doc.numPages;i++){const ops=await (await doc.getPage(i)).getOperatorList();images+=ops.fnArray.filter(x=>x===pdfjs.OPS.paintImageXObject||x===pdfjs.OPS.paintInlineImageXObject).length;}
      await loading.destroy();return images;
    },[...fs.readFileSync(await exported.path())]);assert.equal(exportedImage,1,'structured export preserves the bitmap once');
    await page.keyboard.press('Escape');
    await page.click('#next');await waitDone();
    assert.ok(!await page.evaluate(()=>pdfUiTest.calls.some(x=>x.text==='y = x^2 + 1'||x.text==='const answer = 42;')));
    for(const number of [5,6]){
      await page.fill('#pageNumber',String(number));await page.locator('#pageNumber').press('Enter');await waitDone();
      await setZoom("fit-page");await waitReady();
      assert.equal(await page.evaluate(()=>{const v=document.getElementById('viewport'),c=v.querySelector('canvas').getBoundingClientRect();return c.width<=v.clientWidth&&c.height<=v.clientHeight;}),true);
    }
    await page.fill('#pageNumber','7');await page.locator('#pageNumber').press('Enter');await waitDone();
    await page.waitForFunction(()=>{const c=document.querySelector('#structuredRows .structured-visual');return c&&!c.hidden&&c.width>10;});
    assert.equal(await page.locator('#structuredRows .structured-visual').count(),1,'one original chart, not reconstructed bars');
    assert.ok(await page.locator('#structuredRows .structured-visual').evaluate(canvas=>{
      const pixels=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;let blue=0;
      for(let i=0;i<pixels.length;i+=4)if(pixels[i+2]>pixels[i]+50)blue++;return blue>100;
    }),'source chart bars remain visible');
    await page.fill('#pageNumber','1');await page.locator('#pageNumber').press('Enter');await waitDone();
    assert.match(await page.locator('#structuredRows table').textContent(),/Edited table cell/,'table-cell edit survives page-cache eviction');
    console.log('PASS PDF complex: 3x3 table, author protection, edited cells, original diagram/bitmap pixels, one-image export, mixed page sizes and cache eviction');
    // 模拟后续结构规则把旧版可编辑文字改判为保护内容；已有修订仍能明确撤销，不能卡死恢复入口。
    await page.evaluate(()=>{const process=BT_PDF_BLOCKS.process;BT_PDF_BLOCKS.process=(...args)=>{
      const model=process(...args);for(const block of model.blocks)if(block.text==='Cell 1 0'){block.role='author';block.eligible=false;block.reason='作者姓名与标记保持原样';}return model;
    };});
    await upload(pdfs.complex,'protected-migration.pdf');await page.click('#startTranslation');await waitDone();
    const migrated=page.locator('#structuredRows table .structured-block').filter({hasText:'Edited table cell'});
    await migrated.hover();await migrated.getByRole('button',{name:'恢复机器翻译',exact:true}).click();
    await page.waitForFunction(()=>!document.querySelector('#structuredRows table')?.textContent.includes('Edited table cell'));
    assert.ok((await page.locator('#structuredRows table .structured-text').allTextContents()).includes('Cell 1 0'),'restore keeps the newly protected original, not an obsolete machine translation');
    console.log('PASS PDF edit migration: saved revision remains removable after protected-content reclassification');
    assert.deepEqual(errors, [], "no unhandled browser errors");
    console.log("PASS PDF UI: responsive bounds, dark/reduced-motion modes and clean browser runtime");
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
