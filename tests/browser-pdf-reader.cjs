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
const {PDFDocument, StandardFonts} = require("../pdf/vendor/pdf-lib/pdf-lib.min.js");
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
  return {native: Buffer.from(await doc.save()), blank: Buffer.from(await blank.save()), scanned: Buffer.from(await scanned.save())};
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
        const data = control.long && message.text.includes("Fallback") ? "Long translation example. ".repeat(160) : "Translated: " + message.text;
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

(async () => {
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
    const upload = async (bytes, name = "native.pdf") => {
      if (!await visible("#filePanel")) await page.click("#openFilePanel");
      await page.setInputFiles("#fileInput", {name, mimeType: "application/pdf", buffer: bytes}); await waitReady();
    };
    const calls = () => page.evaluate(() => pdfUiTest.calls.length);
    await upload(pdfs.native);
    assert.equal(await page.locator("#fileName").innerText(), "native.pdf");
    assert.equal(await visible("#readerPanel"), false);
    assert.equal(await visible("#translationCard"), false);
    await page.evaluate(() => { window.savedCanvas = document.querySelector("#canvasHost canvas"); });
    await page.click("#toggleTextComparison"); await page.click("#closeTextComparison");
    for (const mode of ["original", "bilingual", "translated"]) {
      await page.selectOption("#viewMode", mode);
      assert.equal(await visible("#translationCard"), mode === "bilingual");
      assert.equal(await visible(".page-overlay"), mode === "translated");
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
    assert.equal(await visible("#translationCard"), true);
    assert.equal(await visible("#readerPanel"), false, "marker reveals comparison behind configuration panel");
    assert.equal(await page.locator(".translation-row-active").count(), 1);
    await page.keyboard.press("Escape"); assert.equal(await visible("#translationCard"), false);
    assert.equal(await calls(), before);
    await page.click("#toggleTextComparison");
    await page.click("#next"); await waitDone();
    assert.equal(await visible("#translationCard"), true);
    const afterNext = await calls(); await page.click("#previous"); await waitDone();
    assert.equal(await calls(), afterNext, "returning page reuses cached translations");
    await page.selectOption("#zoom", "1.25"); await waitReady();
    await page.click("#rotate"); await waitReady();
    assert.equal(await calls(), afterNext, "zoom and rotation must not request translations");
    console.log("PASS PDF UI: local load, modes, canvas identity, keyboard marker, page cache, zoom/rotation");

    await page.click("#openExportPanel"); await page.selectOption("#exportMode", "range");
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
    await page.selectOption("#exportMode", "original");
    pending = page.waitForEvent("download"); await page.click("#exportNow");
    const original = await pending;
    assert.deepEqual(fs.readFileSync(await original.path()), pdfs.native);
    await page.selectOption("#exportMode", "translated"); await page.check("#exportPair");
    pending = page.waitForEvent("download"); await page.click("#exportNow");
    const translated = await pending, output = await PDFDocument.load(fs.readFileSync(await translated.path()));
    assert.ok(output.getPageCount() >= 2, "paired export includes original and comparison pages");
    await page.evaluate(() => { pdfUiTest.holdExport = true; }); await page.click("#exportNow");
    await page.waitForFunction(() => pdfUiTest.exportHeld); await page.click("#exportCancel");
    await page.waitForFunction(() => document.getElementById("exportCancel").disabled && /取消/.test(document.getElementById("exportStatus").textContent));
    await page.evaluate(() => { pdfUiTest.holdExport = false; });
    console.log("PASS PDF UI: range preflight, explicit prepare, original/translated export with real Worker");

    await page.click("#manageExportFonts"); assert.equal(await visible("#settingsPanel"), true);
    const fontButton = page.locator("#exportFontList button").first(); await fontButton.click();
    assert.equal(await fontButton.isDisabled(), true);
    await page.locator("#exportFonts summary").click(); await page.locator("#exportFonts summary").click();
    assert.equal(await page.locator("#exportFontList button").first().isDisabled(), true);
    assert.equal(await page.evaluate(() => pdfUiTest.authorizations), 1);
    await page.evaluate(() => Object.values(pdfUiTest.downloads)[0].finish(true));
    await page.waitForFunction(() => document.getElementById("exportFontStatus").dataset.error === "true");
    await page.locator("#exportFontList button").first().click();
    await page.evaluate(() => Object.values(pdfUiTest.downloads)[0].finish());
    await page.waitForFunction(() => /已安装/.test(document.getElementById("exportFontList").textContent));
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
    assert.match(await page.locator("#translationProgress").innerText(), /失败 1/);
    await page.click("#translationProgress");
    assert.equal(await page.locator(".translation-row-active .translation-note").getAttribute("data-error"), "true");
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
    await page.click("#openFilePanel"); await page.fill("#pdfUrl", "http://127.0.0.1:" + server.address().port + "/denied.pdf");
    await page.click("#loadUrl"); await page.waitForFunction(() => document.getElementById("status").dataset.error === "true");
    assert.match(await page.locator("#readerStatusSummary").innerText(), /403/);
    assert.equal(await visible("#retrySource"), true); assert.equal(await visible("#retry"), false);
    await page.fill("#pdfUrl", "http://127.0.0.1:" + server.address().port + "/fixture.pdf"); await page.locator("#pdfUrl").press("Enter"); await waitReady();
    assert.equal(await page.locator("#fileName").innerText(), "fixture.pdf");
    await page.click("#openFilePanel"); await page.fill("#pdfUrl", "http://127.0.0.1:" + server.address().port + "/slow.pdf");
    await page.click("#loadUrl"); await page.waitForFunction(() => document.getElementById("loadUrl").disabled);
    assert.equal(await page.locator("#selectFile").isDisabled(), true); await page.click("#cancel");
    await page.waitForFunction(() => !document.getElementById("loadUrl").disabled && /取消/.test(document.getElementById("status").textContent));
    await page.fill("#pdfUrl", "http://127.0.0.1:" + server.address().port + "/fixture.pdf"); await page.click("#loadUrl"); await waitReady();
    console.log("PASS PDF UI: blank-page no-request, OCR-provider boundary, online load and HTTP error recovery");

    for (const width of [1440, 1024, 700, 390]) {
      await page.setViewportSize({width, height: 850});
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "no horizontal document overflow: " + width);
      await page.click("#openSettingsPanel");
      const panel = await page.locator("#readerPanel").boundingBox(); assert.ok(panel.x >= 0 && panel.x + panel.width <= width);
      await page.keyboard.press("Escape");
    }
    await page.emulateMedia({colorScheme: "dark", reducedMotion: "reduce"});
    await page.selectOption("#viewMode", "bilingual"); assert.equal(await visible("#translationCard"), true);
    assert.deepEqual(errors, [], "no unhandled browser errors");
    console.log("PASS PDF UI: responsive bounds, dark/reduced-motion modes and clean browser runtime");
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
