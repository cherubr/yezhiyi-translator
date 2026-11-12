/**
 * 商店图片/运行图标生成入口：npm run store:assets。
 * 依赖 Playwright 和已安装的 Chromium，使用独立临时资料加载当前扩展。
 * 输出：.local/chrome-web-store/images 下的全部设置导航页、四类服务详情与两张宣传图；
 * 长页面额外输出到 images/previews，保留完整可见内容供本机预览。
 * 同时覆盖 assets/icon16/32/48/128.png；不会提交图片或上传商店。
 * 本脚本加载后立即执行 main，不应作为普通工具模块 require。
 */
const fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os");
const { chromium } = require("playwright");
// 项目位置取脚本上级，图片输出目录由脚本按需创建，不依赖已存在的 .local 资料。
const root = path.resolve(__dirname, ".."),
  out = path.join(root, ".local", "chrome-web-store", "images");
// 一项对应一个真实导航页面；新增导航而未补充文件名时应明确失败，不能悄悄漏拍。
const SETTINGS_SHOTS = Object.freeze({
  general: "settings",
  display: "display-style",
  service: "translation-services",
  behavior: "behavior-preferences",
  glossary: "glossary",
  about: "about",
});
const SERVICE_SHOTS = Object.freeze({
  google: "google-configuration",
  mymemory: "mymemory-configuration",
  baidu: "baidu-configuration",
  ai: "ai-configuration",
});

/**
 * 导出不同尺寸的品牌图标、宣传图及无个人配置的设置页截图。
 * 使用当前源码的真实设置页及标准/小尺寸 SVG；宣传图由下面内联 HTML/CSS 独立排版。
 * @returns {Promise<void>} 所有图片写入并清理浏览器资料后完成。
 * @throws {Error} 浏览器启动、页面加载、图片解码、截图或清理失败。
 */
async function main() {
  // recursive 允许目录不存在时创建，但不会清空已有图片；同名截图会被重写。
  fs.mkdirSync(out, { recursive: true });
  // 独立资料不使用用户 Chrome 账号/设置，避免把真实凭据或偏好拍入截图。
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "yezhiyi-assets-"));
  // 先声明，浏览器启动失败时 finally 可判断是否需要关闭上下文。
  let context;
  try {
    // 只加载当前根目录这一份扩展；固定视口与 1 倍像素比例，使截图像素尺寸稳定。
    // 临时 persistent context 为扩展提供自己的存储和 Service Worker 生命周期。
    context = await chromium.launchPersistentContext(profile, {
      channel: "chromium",
      headless: true,
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 1,
      colorScheme: "light",
      reducedMotion: "reduce",
      args: ["--disable-extensions-except=" + root, "--load-extension=" + root],
    });
    // Worker 可能已经启动；先取现有实例，缺少时等待事件，再从 URL 得到本次扩展 ID。
    // 不写死开发机器上的扩展 ID，保证不同安装路径仍能访问设置页。
    const worker =
      context.serviceWorkers()[0] ||
      (await context.waitForEvent("serviceworker"));
    const id = new URL(worker.url()).host;
    // 截图不测试真实服务，也不加载外部网页；所有图标、字体和脚本使用包内资源。
    await context.route(/^https?:/, route => route.abort());
    const page = await context.newPage();
    // 设置页异常不能悄悄变成一张“版本号正常、表单尚未完成”的成功截图。
    const pageErrors = [];
    page.on("pageerror", error => pageErrors.push(error.message));
    await page.goto("chrome-extension://" + id + "/settings/settings.html");
    // 版本号在迁移/读取配置前已写入，不能单独作为页面就绪信号。
    // 同时等待表单、全部服务卡片及初始化末尾绑定的操作入口。
    const version = JSON.parse(
      fs.readFileSync(path.join(root, "manifest.json"), "utf8"),
    ).version;
    await page.waitForFunction(
      (expected) => {
        const engine = document.querySelector("#engine");
        return document.querySelector("#version")?.textContent === "v" + expected &&
          engine?.options.length > 0 && engine.value !== "" &&
          document.querySelector("#from")?.options.length > 1 &&
          document.querySelector("#to")?.options.length > 1 &&
          document.querySelectorAll("#serviceGrid .service-card").length === 4 &&
          typeof document.querySelector("#manageTranslationServices")?.onclick === "function";
      },
      version,
    );
    /**
     * 等待字体、移开悬停态并检查页面错误，保存顶部 1280×800 的真实界面。
     * 可见内容超过一屏时，另外保存完整页面预览；不会展开默认收起的说明或改写设置。
     * @param {string} name 文件名前缀，不含尺寸和扩展名。
     * @returns {Promise<void>} 截图写入成功后完成；页面异常或截图失败向外抛出。
     */
    const generated = [];
    async function captureSettings(name) {
      await page.evaluate(() => document.fonts.ready);
      await page.mouse.move(1250, 780);
      await page.evaluate(() => window.scrollTo({top:0, behavior:"instant"}));
      if (pageErrors.length) throw Error("设置页初始化失败：" + pageErrors.join("；"));
      const file = name + "-1280x800.png";
      await page.screenshot({path:path.join(out, file), animations:"disabled"});
      generated.push(file);
      const height = await page.evaluate(() => Math.max(document.documentElement.scrollHeight, document.body.scrollHeight));
      if (height > 800) {
        const preview = path.join(out, "previews");
        fs.mkdirSync(preview, {recursive:true});
        const full = name + "-full.png";
        await page.screenshot({path:path.join(preview, full), fullPage:true, animations:"disabled"});
        generated.push("previews/" + full);
      }
    }

    // 逐一真实点击导航：截图反映默认状态，不合成另一套用于宣传的设置界面。
    const tabs = await page.locator(".nav-item").evaluateAll(items => items.map(item => item.dataset.tab));
    if (new Set(tabs).size !== tabs.length || tabs.length !== Object.keys(SETTINGS_SHOTS).length ||
        tabs.some(tab => !Object.hasOwn(SETTINGS_SHOTS, tab)))
      throw Error("设置导航与截图清单不一致，请同步 SETTINGS_SHOTS");
    for (const tab of tabs) {
      await page.locator('.nav-item[data-tab="' + tab + '"]').click();
      await page.locator('.tab-panel.active[data-panel="' + tab + '"]').waitFor({state:"visible"});
      await captureSettings(SETTINGS_SHOTS[tab]);
    }

    // 四种服务详情也是独立界面，逐一覆盖；AI 展示默认厂商的空配置，不逐个切换模型。
    await page.locator('.nav-item[data-tab="service"]').click();
    const services = await page.locator("#serviceGrid .service-card").evaluateAll(items => items.map(item => item.dataset.service));
    if (new Set(services).size !== services.length || services.length !== Object.keys(SERVICE_SHOTS).length ||
        services.some(service => !Object.hasOwn(SERVICE_SHOTS, service)))
      throw Error("服务目录与截图清单不一致，请同步 SERVICE_SHOTS");
    for (const service of services) {
      await page.locator('#serviceGrid .service-card[data-service="' + service + '"]').click();
      await page.locator("#serviceDetailView").waitFor({state:"visible"});
      await page.locator("#useServiceButton").waitFor({state:"visible"});
      if (service === "baidu") {
        for (const input of ["#baiduAppId", "#baiduKey"])
          if (await page.locator(input).inputValue()) throw Error("截图会话不应包含百度凭据");
      }
      if (service === "ai") {
        await page.waitForFunction(() =>
          document.querySelectorAll("#providerGrid .provider-item").length > 0 &&
          document.querySelector("#providerGrid .provider-item.active") !== null &&
          document.querySelector("#openaiBase")?.value !== "" &&
          document.querySelector("#openaiModel")?.value !== ""
        );
        if (await page.locator("#openaiKey").inputValue()) throw Error("截图会话不应包含 API 密钥");
        // 顶部标准图优先展示全部厂商；下方配置和请求参数由完整预览覆盖。
        await page.evaluate(() => window.scrollTo({top:0, behavior:"instant"}));
        for (const provider of await page.locator("#providerGrid .provider-item").all()) {
          const box = await provider.boundingBox();
          if (!box || box.y < 0 || box.y + box.height > 800)
            throw Error("AI 厂商未完整进入截图视口：" + await provider.textContent());
        }
      }
      await captureSettings(SERVICE_SHOTS[service]);
      await page.locator("#backToServices").click();
      await page.locator("#serviceListView").waitFor({state:"visible"});
    }

    // SVG 以 data URL 直接嵌入截图页，不依赖额外图片服务器。
    // 宣传图使用标准源；工具栏 16/32 像素使用同品牌的简化源，避免细节缩小后发虚。
    const svg = fs.readFileSync(path.join(root, "assets/icon.svg"), "utf8");
    const icon =
      "data:image/svg+xml;base64," + Buffer.from(svg).toString("base64");
    const smallIcon = "data:image/svg+xml;base64," + Buffer.from(
      fs.readFileSync(path.join(root, "assets/icon-small.svg"), "utf8"),
    ).toString("base64");
    // 宣传图与图标使用另一页面，避免改变真实设置页的内容或视口。
    const render = await context.newPage();

    // 导出 Manifest 使用的四个尺寸；透明背景 PNG 直接写入根目录 assets，
    // 属于运行资源改动，运行本脚本后需检查 Git 的二进制差异。
    for (const size of [16, 32, 48, 128]) {
      await render.setViewportSize({ width: size, height: size });
      // 去掉浏览器默认 margin，用 img 填满视口，让 PNG 像素与目标尺寸一致。
      await render.setContent(
        '<style>html,body{margin:0;background:transparent}img{display:block;width:100vw;height:100vh}</style><img src="' +
          (size <= 32 ? smallIcon : icon) +
          '">',
      );
      // 等待图片真正解码，避免只完成 DOM 写入就拍到空白图。
      await render.locator("img").evaluate((img) => img.decode());
      await render.screenshot({
        path: path.join(root, "assets", "icon" + size + ".png"),
        omitBackground: true,
      });
    }

    // 小宣传图：440×280，蓝紫渐变底、品牌标题与双语示例卡片。
    // 下方 HTML/CSS 仅用于导出宣传素材，不会注入扩展的普通用户页面。
    await render.setViewportSize({ width: 440, height: 280 });
    await render.setContent(
      '<style>*{box-sizing:border-box}body{margin:0;width:440px;height:280px;background:linear-gradient(125deg,#143992,#4832a2);font-family:Microsoft YaHei,system-ui,sans-serif;color:white;padding:28px}header{display:flex;align-items:center;gap:8px;font-size:27px;font-weight:700}img{width:64px;height:64px}small{display:block;font-size:13px;opacity:.8;margin:0 0 19px 12px}article{background:#fff;border-radius:12px;padding:17px 20px;color:#263457;margin:0 8px;box-shadow:0 8px 28px #08143e55}p{margin:0;font-size:16px}p+p{color:#565fa0;font-size:14px;margin-top:7px}</style><header><img src="' +
        icon +
        '"><span>页知译</span></header><small>网页双语翻译</small><article><p>Read the original. Understand more.</p><p>保留原文，读懂更多。</p></article>',
    );
    await render.locator("img").evaluate((img) => img.decode());
    await render.screenshot({ path: path.join(out, "small-marquee-440x280.png") });

    // 顶部宣传图独立排版，使用不透明背景导出，满足 1400×560 的商店尺寸。
    // 左侧显示品牌和说明，右侧为双语示例卡片；固定宽高和 overflow 防止超出画布。
    await render.setViewportSize({ width: 1400, height: 560 });
    await render.setContent(
      '<style>*{box-sizing:border-box}body{margin:0;width:1400px;height:560px;overflow:hidden;background:linear-gradient(120deg,#102a70,#343294 65%,#5635ae);font-family:Microsoft YaHei,system-ui,sans-serif;color:white;display:flex;align-items:center;padding:70px 86px;gap:100px}section{width:520px;flex-shrink:0}header{display:flex;align-items:center;gap:18px;font-size:64px;font-weight:700}img{width:116px;height:116px}h1{font-size:30px;font-weight:500;margin:24px 0 16px}small{font-size:18px;color:#c9d5ff}article{width:530px;background:#fff;border-radius:22px;padding:36px;color:#263457;box-shadow:0 24px 70px #06123955;transform:rotate(-3deg)}nav{display:flex;gap:7px;margin-bottom:28px}i{width:9px;height:9px;border-radius:50%;background:#c7cff1}p{margin:0;font-size:23px;line-height:1.6}p+p{color:#565fa0;font-size:21px;margin-top:12px}hr{border:0;border-top:1px solid #e6eafa;margin:24px 0}.line{height:8px;background:#e9edf8;border-radius:4px;margin:14px 0;width:85%}.short{width:58%}</style><section><header><img src="' +
        icon +
        '"><span>页知译</span></header><h1>保留原文，读懂更多。</h1><small>网页双语翻译 · 多引擎选择 · 动态内容补翻</small></section><article><nav><i></i><i></i><i></i></nav><p>Read the original.<br>Understand more.</p><p>阅读原文，也读懂每一段。</p><hr><div class="line"></div><div class="line short"></div></article>',
    );
    await render.locator("img").evaluate((img) => img.decode());
    await render.screenshot({
      path: path.join(out, "top-marquee-1400x560.png"),
      omitBackground: false,
    });
    // 到这里表示本轮图片全部写入，打印的是素材目录而非商店上传结果。
    console.log("已生成 " + tabs.length + " 个设置导航页、" + services.length + " 个服务详情页、长页预览、两张宣传图和运行图标：" + out);
    for (const file of generated) console.log("设置截图：" + file);
  } finally {
    // 先关闭上下文以释放资料目录句柄，再进行路径检查和删除。
    // 此清理不回滚已写入的截图/图标，途中失败时可能留下部分新图片。
    if (context) await context.close();
    // 必须同时位于系统临时目录且具有本脚本前缀，才允许递归删除。
    const resolved = path.resolve(profile),
      temp = path.resolve(os.tmpdir()) + path.sep;
    if (
      !resolved.startsWith(temp) ||
      !path.basename(resolved).startsWith("yezhiyi-assets-")
    )
      throw Error("临时资料路径校验失败");
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}
// 异步错误输出后设置失败状态，CI/命令行可据此判断；不强制退出以便完成资源清理。
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
