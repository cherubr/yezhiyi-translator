/**
 * 控制面板共享 UI 模块：网页内面板（content.js）与工具栏 Popup 共用同一份
 * 模板和展示逻辑，避免两处各自维护界面。业务逻辑仍在各自宿主：
 * content.js 直接操作页面状态，Popup 通过消息转发指令。
 * 依赖：constants.js（BT_CONST）、request-policy.js（BT_REQUEST_POLICY）、providers.js（BT_SERVICES/AI_PROVIDERS）。
 */
(function (global) {
  "use strict";

  /**
   * 面板完整 HTML 模板；元素 ID 与网页内面板历史保持一致，绑定逻辑由宿主完成。
   * hero 是唯一模式切换区：网页模式显示状态与翻译按钮，PDF 模式显示来源与阅读器入口。
   * @returns {string} 用于 innerHTML 的面板结构。
   */
  function templateHtml() {
    return `
      <div class="bt-modal-panel">
        <div class="bt-modal-header" id="btModalDrag">
          <div class="bt-modal-brand">
            <div class="bt-modal-logo">译</div>
            <div>
              <div class="bt-modal-title">页知译 · 网页双语翻译</div>
              <div class="bt-modal-sub">控制面板</div>
            </div>
          </div>
          <button class="bt-modal-close" title="关闭">✕</button>
        </div>

        <div class="bt-modal-body">
          <div class="bt-modal-hero">
            <div>
              <div class="bt-modal-hero-label" id="btModalHeroLabel">当前页面</div>
              <div class="bt-modal-hero-status" id="btModalStatus">未翻译</div>
              <div class="bt-modal-hint" id="btModalPdfName" role="status" hidden></div>
              <div class="bt-modal-hint" id="btModalError" role="status"></div>
              <div class="bt-modal-hint" id="btModalLanguageNotice" role="status"></div>
              <div class="bt-modal-hint" id="btModalRequestNotice" role="status"></div>
            </div>
            <div class="bt-modal-hero-actions">
              <button class="bt-modal-btn bt-modal-btn-primary" id="btModalTranslate">翻译此页面</button>
              <button class="bt-modal-btn bt-modal-btn-ghost" id="btModalCancel">取消翻译</button>
              <button class="bt-modal-btn bt-modal-btn-primary" id="btModalOpenPdf" hidden>打开当前 PDF 翻译器</button>
            </div>
          </div>

          <div class="bt-modal-section">
            <div class="bt-modal-tool-row" id="btModalOpenPdfAny" role="button" tabindex="0" title="打开 PDF 翻译阅读器">
              <span class="bt-modal-tool-icon" aria-hidden="true">📄</span>
              <span class="bt-modal-tool-text">
                <span class="bt-modal-switch-title">PDF 文档翻译</span>
                <span class="bt-modal-hint">支持在线地址与本地 PDF 文件</span>
              </span>
              <span class="bt-modal-tool-arrow" aria-hidden="true">›</span>
            </div>
          </div>

          <div class="bt-modal-section bt-modal-section-settings">
            <div class="bt-modal-section-title">翻译设置</div>
            <div class="bt-modal-field">
              <label>翻译服务</label>
              <select id="btModalEngine"></select>
              <div class="bt-modal-hint" id="btModalModel"></div>
              <div class="bt-modal-hint" id="btModalRequestPolicy"></div>
            </div>
            <div class="bt-modal-field-row">
              <div class="bt-modal-field">
                <label>源语言</label>
                <select id="btModalFrom"></select>
              </div>
              <div class="bt-modal-field">
                <label>目标语言</label>
                <select id="btModalTo"></select>
              </div>
            </div>
          </div>

          <div class="bt-modal-section bt-modal-section-settings">
            <div class="bt-modal-section-title">显示模式</div>
            <div class="bt-modal-seg" id="btModalModeSeg">
              <button data-mode="bilingual" class="bt-modal-seg-btn">双语对照</button>
              <button data-mode="translation-only" class="bt-modal-seg-btn">仅显示译文</button>
            </div>
          </div>

          <div class="bt-modal-section bt-modal-section-settings">
            <div class="bt-modal-section-title">行为偏好</div>
            <div class="bt-modal-switch-row">
              <div>
                <div class="bt-modal-switch-title">打开网页时自动翻译</div>
                <div class="bt-modal-hint">开启后自动启动当前及新网页；当前页启动后持续补翻，点击取消才停止。</div>
              </div>
              <div class="bt-modal-switch" id="btModalAuto"></div>
            </div>
            <div class="bt-modal-switch-row">
              <div>
                <div class="bt-modal-switch-title">悬停悬浮球显示快捷面板</div>
                <div class="bt-modal-hint">关闭后悬浮球只用于点击翻译。</div>
              </div>
              <div class="bt-modal-switch" id="btModalHover"></div>
            </div>
          </div>
        </div>

        <div class="bt-modal-footer">
          <button class="bt-modal-settings" id="btModalSettings">
            <span>⚙</span> 更多设置
          </button>
          <a class="bt-modal-settings" id="btModalFeedback" href="https://github.com/cherubr/yezhiyi-translator/issues/new" target="_blank" rel="noopener noreferrer" title="前往 GitHub 提交问题">问题反馈 ↗</a>
        </div>
      </div>
    `;
  }

  /**
   * 按状态快照刷新面板展示，只写 DOM，不修改任何宿主状态。
   * snapshot 需包含：模式标志（pdfPage/pdfName/unsupported）、任务状态字段
   * （translating/translated/cancelRequested/visibilityPaused/pageStarted/pagePaused/
   * backgroundTranslating/lastError/languageNoticeCount/requestNotice/autoTranslateSaving）
   * 及配置字段（engine/aiProvider/aiKeys/requestPolicies/from/to/mode/autoTranslate/hoverPanel/
   * baiduAppId/baiduKey/baiduVerification）。缺失字段按未翻译的空状态处理。
   * @param {HTMLElement} root 面板根节点（.bt-modal）。
   * @param {Object} snapshot 展示所需的状态快照。
   */
  function applyState(root, snapshot) {
    if (!root || !snapshot) return;
    const $ = (sel) => root.querySelector(sel);

    const statusEl = $("#btModalStatus");
    const btnT = $("#btModalTranslate");
    const btnC = $("#btModalCancel");
    const btnP = $("#btModalOpenPdf");
    const nameEl = $("#btModalPdfName");

    // PDF 模式只保留来源说明与阅读器入口；不支持页面不显示任何操作按钮。
    const pdfPage = snapshot.pdfPage === true;
    const unsupported = snapshot.unsupported === true;
    // PDF 模式隐藏网页翻译设置区并启用紧凑样式；网页内面板与 Popup 共用本规则。
    root.classList.toggle("bt-modal-pdf", pdfPage);
    root.querySelectorAll(".bt-modal-section-settings").forEach((el) => { el.hidden = pdfPage; });
    const labelEl = $(".bt-modal-hero-label");
    if (labelEl) labelEl.textContent = pdfPage ? "当前 PDF 文档" : "当前页面";
    btnT.hidden = pdfPage || unsupported;
    btnC.hidden = pdfPage || unsupported;
    btnP.hidden = !pdfPage || unsupported;
    nameEl.hidden = !pdfPage;
    if (unsupported) {
      statusEl.textContent = "当前页面不支持翻译";
    } else if (pdfPage) {
      statusEl.textContent = "检测到 PDF 文档";
      nameEl.textContent = snapshot.pdfName || "";
      nameEl.title = nameEl.textContent;
    } else if (snapshot.cancelRequested) {
      statusEl.textContent = "取消中…";
      btnT.textContent = "取消中…";
      btnT.disabled = true;
      btnC.disabled = true;
    } else if (snapshot.visibilityPaused && snapshot.pageStarted && !snapshot.pagePaused) {
      statusEl.textContent = "已暂停（页面不可见）";
      btnT.textContent = snapshot.translated ? "重新翻译" : "翻译此页面";
      btnT.disabled = false; btnC.disabled = false;
    } else if (snapshot.translating && !snapshot.backgroundTranslating) {
      statusEl.textContent = "翻译中…";
      btnT.textContent = "翻译中…";
      btnT.disabled = true;
      btnC.disabled = false;
    } else if (snapshot.translated) {
      statusEl.textContent = "已翻译";
      btnT.textContent = "重新翻译";
      btnT.disabled = false;
      btnC.disabled = false;
    } else {
      statusEl.textContent = "未翻译";
      btnT.textContent = "翻译此页面";
      btnT.disabled = false;
      btnC.disabled = !snapshot.pageStarted;
      if (snapshot.lastError) { statusEl.textContent = "翻译失败，请检查配置"; btnT.textContent = "重试翻译"; }
    }

    // 显示实际正在使用的模型与已保存参数，避免把编辑中的厂商或推荐值当成当前配置。
    const modelEl = $("#btModalModel");
    if (modelEl) {
      const model = (snapshot.aiKeys?.[snapshot.aiProvider] || {}).model || (global.AI_PROVIDERS?.[snapshot.aiProvider] || {}).model || "";
      modelEl.textContent = snapshot.engine === "ai" ? "当前模型：" + (model || "接口默认模型") : "";
    }
    const policyEl = $("#btModalRequestPolicy");
    if (policyEl) {
      const policy = global.BT_REQUEST_POLICY.resolve(snapshot.engine, snapshot.aiProvider, snapshot.requestPolicies || {});
      policyEl.textContent = (policy.mode === "manual" ? "手动配置" : "推荐配置") + "：每秒最多 " + policy.qps + " 次，同时最多 " + policy.maxConcurrent + " 个请求";
    }
    const requestEl = $("#btModalRequestNotice");
    if (requestEl) requestEl.textContent = snapshot.requestNotice || "";
    const errorEl = $("#btModalError");
    if (errorEl) { errorEl.textContent = snapshot.lastError ? "部分内容未完成：" + snapshot.lastError : ""; errorEl.title = errorEl.textContent; }
    const noticeEl = $("#btModalLanguageNotice");
    if (noticeEl) noticeEl.textContent = snapshot.languageNoticeCount
      ? "语言提示：" + snapshot.languageNoticeCount + " 处内容无法自动识别源语言，已跳过。请为 MyMemory 指定源语言或切换引擎。" : "";

    global.BT_SERVICES.renderSelect($("#btModalEngine"), snapshot);
    global.BT_CONST.fillLanguageSelect($("#btModalFrom"), "from", snapshot.from);
    global.BT_CONST.fillLanguageSelect($("#btModalTo"), "to", snapshot.to);
    root.querySelectorAll(".bt-modal-seg-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.mode === snapshot.mode);
    });
    $("#btModalAuto").classList.toggle("on", snapshot.autoTranslate === true);
    $("#btModalAuto").setAttribute("aria-disabled", String(snapshot.autoTranslateSaving === true));
    $("#btModalHover").classList.toggle("on", snapshot.hoverPanel !== false);
  }

  /**
   * 在面板内部展示一条操作反馈，先移除旧提示，约 2.6 秒后移除本条。
   * @param {HTMLElement} root 面板根节点。
   * @param {string} msg 以 textContent 展示的说明。
   * @param {string} type 受调用方控制的样式类型，默认 info。
   */
  function showToast(root, msg, type = "info") {
    if (!root) return;
    let toast = root.querySelector(".bt-panel-toast");
    if (toast) toast.remove();
    toast = root.ownerDocument.createElement("div");
    toast.className = `bt-panel-toast bt-panel-toast-${type}`;
    toast.textContent = msg;
    (root.querySelector(".bt-modal-panel") || root).appendChild(toast);
    setTimeout(() => toast.remove(), 2600);
  }

  const BT_PANEL_UI = { templateHtml, applyState, showToast };
  if (typeof self !== "undefined") self.BT_PANEL_UI = BT_PANEL_UI;
  if (typeof window !== "undefined") window.BT_PANEL_UI = BT_PANEL_UI;
})(typeof self !== "undefined" ? self : this);
