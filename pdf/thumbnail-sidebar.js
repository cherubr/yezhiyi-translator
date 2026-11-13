(function(global) {
  "use strict";
  const ROW_HEIGHT = 212, CACHE_LIMIT = 16;
  /** 原文缩略图独立排队；仅挂载可见页附近的节点，不提取文字或发起翻译。 */
  function create({onNavigate, onToggle}) {
    const $ = id => document.getElementById(id);
    const sidebar = $("thumbnailSidebar"), viewport = $("thumbnailViewport"), list = $("thumbnailList"), toggle = $("toggleThumbnails");
    const nodes = new Map(), cache = new Map(), failed = new Set();
    let source = null, page = 1, rotation = 0, enabled = false, open = true, disposed = false, generation = 0, running = null, frame = null;
    try { open = localStorage.getItem("bt-pdf-thumbnails-open") !== "false"; } catch (_) {}
    function release(canvas) { canvas.width = canvas.height = 0; }
    function clearWork() {
      generation++; running?.controller.abort(); running?.handle?.cancel();
      for (const canvas of cache.values()) release(canvas);
      cache.clear(); failed.clear(); nodes.clear(); list.replaceChildren();
    }
    function setOpen(value, restoreFocus = false) {
      open = value;
      if (!open && sidebar.contains(document.activeElement)) restoreFocus = true;
      sidebar.hidden = !open;
      document.body.dataset.thumbnailsOpen = String(open);
      toggle.setAttribute("aria-expanded", String(open));
      toggle.title = open ? "收起页面缩略图" : "展开页面缩略图";
      toggle.setAttribute("aria-label", toggle.title);
      try { localStorage.setItem("bt-pdf-thumbnails-open", String(open)); } catch (_) {}
      if (open) reveal(page); else clearWork();
      if (restoreFocus) toggle.focus({preventScroll:true});
      onToggle();
    }
    function reveal(value) {
      if (!open || !source) return;
      const top = (value - 1) * ROW_HEIGHT, bottom = top + ROW_HEIGHT;
      if (top < viewport.scrollTop) viewport.scrollTop = top;
      else if (bottom > viewport.scrollTop + viewport.clientHeight) viewport.scrollTop = Math.max(0, bottom - viewport.clientHeight);
      schedule();
    }
    function paint(value, item) {
      const button = item.firstElementChild, slot = button.firstElementChild, canvas = cache.get(value);
      button.disabled = !enabled;
      button.setAttribute("aria-current", value === page ? "page" : "false");
      button.title = "第 " + value + " 页" + (failed.has(value) ? "，预览失败，点击重试" : "");
      if (canvas) {
        if (slot.firstChild !== canvas) slot.replaceChildren(canvas);
        cache.delete(value); cache.set(value, canvas);
      } else slot.textContent = failed.has(value) ? "预览失败 · 点击重试" : "正在加载…";
    }
    function layout() {
      frame = null;
      if (!open || !source) return;
      const first = Math.max(1, Math.floor(viewport.scrollTop / ROW_HEIGHT) - 1);
      const last = Math.min(source.numPages, Math.ceil((viewport.scrollTop + viewport.clientHeight) / ROW_HEIGHT) + 2);
      for (const [value, item] of nodes) if (value < first || value > last) { item.remove(); nodes.delete(value); }
      for (let value = first; value <= last; value++) {
        let item = nodes.get(value);
        if (!item) {
          item = document.createElement("li"); item.style.top = (value - 1) * ROW_HEIGHT + "px";
          const button = document.createElement("button"); button.type = "button"; button.dataset.page = String(value);
          button.setAttribute("aria-label", "转到第 " + value + " 页");
          const slot = document.createElement("span"); slot.className = "thumbnail-image"; slot.setAttribute("aria-hidden", "true");
          const label = document.createElement("span"); label.className = "thumbnail-number"; label.textContent = String(value);
          button.append(slot, label); item.append(button);
          // 按页码插入，保持键盘 Tab 顺序与视觉顺序一致。
          const next = [...list.children].find(child => Number(child.firstElementChild.dataset.page) > value);
          list.insertBefore(item, next || null); nodes.set(value, item);
        }
        paint(value, item);
      }
      pump();
    }
    function schedule() { if (!disposed && frame === null) frame = requestAnimationFrame(layout); }
    function pump() {
      if (disposed || running || !open || !source || !enabled) return;
      const center = (viewport.scrollTop + viewport.clientHeight / 2) / ROW_HEIGHT + .5;
      const value = [...nodes.keys()].filter(value => !cache.has(value) && !failed.has(value))
        .sort((a,b) => Math.abs(a - center) - Math.abs(b - center))[0];
      if (!value) return;
      const job = {generation, source, controller:new AbortController(), handle:null, canvas:document.createElement("canvas")};
      running = job;
      void (async () => {
        try {
          job.handle = job.source.renderThumbnail({pageNumber:value, viewRotation:rotation, canvas:job.canvas}, {signal:job.controller.signal});
          await job.handle.promise;
          if (job.generation !== generation || source !== job.source || !open) return;
          cache.set(value, job.canvas); job.canvas = null;
          const item = nodes.get(value); if (item) paint(value, item);
          while (cache.size > CACHE_LIMIT) {
            const oldest = [...cache.keys()].find(key => !nodes.has(key));
            if (oldest === undefined) break;
            release(cache.get(oldest)); cache.delete(oldest);
          }
        } catch (_) {
          if (job.generation === generation && !job.controller.signal.aborted) {
            failed.add(value); const item = nodes.get(value); if (item) paint(value, item);
          }
        } finally {
          job.handle?.dispose(); if (job.canvas) release(job.canvas);
          if (running === job) running = null;
          pump();
        }
      })();
    }
    function setDocument(value) {
      if (disposed) return;
      clearWork(); source = value; page = 1; rotation = 0; enabled = !!value;
      viewport.scrollTop = 0; list.style.height = (value?.numPages || 0) * ROW_HEIGHT + "px";
      viewport.hidden = !value; $("thumbnailEmpty").hidden = !!value;
      schedule();
    }
    function setPage(value, viewRotation, ready) {
      if (disposed) return;
      const changed = page !== value;
      if (rotation !== viewRotation) { rotation = viewRotation; clearWork(); }
      page = value; enabled = ready;
      if (changed) reveal(page);
      schedule();
    }
    list.onclick = event => {
      const button = event.target.closest("button[data-page]");
      if (!button || !enabled) return;
      const value = Number(button.dataset.page);
      failed.delete(value); schedule(); onNavigate(value);
    };
    list.onkeydown = event => {
      const button = event.target.closest("button[data-page]");
      if (!button || !enabled || !source) return;
      const value = Number(button.dataset.page);
      const target = {ArrowUp:value-1, ArrowDown:value+1, Home:1, End:source.numPages,
        PageUp:value-5, PageDown:value+5}[event.key];
      if (target === undefined) return;
      event.preventDefault(); const next = Math.max(1, Math.min(source.numPages, target));
      reveal(next); layout(); nodes.get(next)?.firstElementChild.focus({preventScroll:true}); onNavigate(next);
    };
    viewport.addEventListener("scroll", schedule, {passive:true});
    const observer = new ResizeObserver(schedule); observer.observe(viewport);
    toggle.onclick = () => setOpen(!open);
    $("closeThumbnails").onclick = () => setOpen(false, true);
    setOpen(open);
    function dispose() {
      disposed = true; source = null; enabled = false; clearWork(); observer.disconnect();
      if (frame !== null) cancelAnimationFrame(frame); frame = null;
    }
    return {setDocument, setPage, dispose};
  }
  global.BT_PDF_THUMBNAILS = {create};
})(window);
