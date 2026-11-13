(function(global) {
  "use strict";
  /**
   * P3-C 译文显示层：像素证据采样、布局 Plan 消费、遮罩与译文 DOM 绘制。
   * 原始 canvas 像素永不修改；遮罩与译文全部在独立 Overlay 内，可整体关闭恢复原文。
   * 采样与绘制绑定渲染代次/模型版本/页码三元身份，任何不匹配的迟到结果整体丢弃。
   * 遮罩在 DOM 溢出验证通过前不可见（整组 visibility 门控），失败整组移除并按字号降级重规划。
   */
  const K = global.BT_PDF_LAYOUT_PLANNER.constants;
  const EV = global.BT_PDF_PIXEL_EVIDENCE; // 采样判定与 P5 导出共用（pdf/pixel-evidence.js）
  const SAMPLE_BLOCKS_PER_FRAME = 3;      // 每帧采样块预算，避免长任务阻塞交互

  function multiply(a, b) {
    return [a[0]*b[0]+a[2]*b[1], a[1]*b[0]+a[3]*b[1], a[0]*b[2]+a[2]*b[3], a[1]*b[2]+a[3]*b[3],
      a[0]*b[4]+a[2]*b[5]+a[4], a[1]*b[4]+a[3]*b[5]+a[5]];
  }
  function invert(m) {
    const det = m[0]*m[3] - m[1]*m[2];
    if (!Number.isFinite(det) || det === 0) return null;
    return [m[3]/det, -m[1]/det, -m[2]/det, m[0]/det,
      (m[2]*m[5]-m[3]*m[4])/det, (m[1]*m[4]-m[0]*m[5])/det];
  }
  function apply(m, x, y) {
    return [x*m[0] + y*m[2] + m[4], x*m[1] + y*m[3] + m[5]];
  }

  function create({isDebug, onMarkerClick, onPlanSummary}) {
    let overlay = null, layer = null, draftLayer=null, draft=null, draftNodes=null, debugLayer = null, markerLayer = null, flashLayer = null, canvas = null;
    let view = null, model = null, frame = 0;
    let generation = 0, modelToken = 0, visible = true;
    let evidence = new Map(), queue = [], plan = null, planDirty = true, domFailures = new Map(), groups = new Map();
    let sampledText = new Map();
    // P3-D 回退编号只增不复用；仅换文档/翻页重置，缩放、取消、继续保持编号一致。
    let markerNumbers = new Map(), nextMarkerNumber = 1, markerPage = null, markerSig = "", flashTimer = 0;

    /** 显示矩阵 M = V2.transform × V1.transform⁻¹；两侧任一缺失时不绘制。 */
    function matrix() {
      if (!view || !model || !Array.isArray(view.viewportTransform) || !Array.isArray(model.geometry.transform)) return null;
      const base = invert(model.geometry.transform);
      if (!base) return null;
      return multiply(view.viewportTransform, base);
    }
    function schedule() {
      if (frame) return;
      frame = requestAnimationFrame(() => { frame = 0; pipeline(); });
    }
    function resetPlanState() {
      generation++;
      draftLayer?.replaceChildren();
      draftNodes=null;
      evidence = new Map();sampledText=new Map(); queue = []; plan = null; planDirty = true; domFailures = new Map();
      if (layer) layer.replaceChildren();
      if (markerLayer) markerLayer.replaceChildren();
      if (flashTimer) { clearTimeout(flashTimer); flashTimer = 0; }
      if (flashLayer) flashLayer.replaceChildren();
      markerSig = "";
      groups = new Map();
    }
    /** 包裹新画布并返回挂载节点；旧 Overlay 随上一次 replaceChildren 一并丢弃。 */
    function mount(nextCanvas) {
      resetPlanState();
      markerNumbers = new Map(); nextMarkerNumber = 1; markerPage = null;
      const wrap = document.createElement("div");
      wrap.className = "page-layer";
      overlay = document.createElement("div");
      overlay.className = "page-overlay";
      overlay.setAttribute("aria-hidden", "true");
      layer = document.createElement("div");
      layer.className = "placement-layer";
      draftLayer=document.createElement("div");draftLayer.className="placement-layer draft-placement-layer";
      markerLayer = document.createElement("div");
      markerLayer.className = "marker-layer";
      debugLayer = document.createElement("div");
      debugLayer.className = "debug-layer";
      overlay.append(layer, draftLayer, markerLayer, debugLayer);
      // P3-E F2：联动闪光层与 Overlay 平级，不受显示模式隐藏影响。
      flashLayer = document.createElement("div");
      flashLayer.className = "flash-layer";
      wrap.append(nextCanvas, overlay, flashLayer);
      canvas = nextCanvas;
      view = null;
      applyVisibility();
      schedule();
      return wrap;
    }
    function setView(info) {
      view = info || null;
      resetPlanState();
      schedule();
    }
    function setModel(rows, geometry) {
      modelToken++;
      model = rows && rows.length && geometry && Number.isFinite(geometry.pageNumber) ? {rows, geometry, token: modelToken} : null;
      if (geometry && Number.isFinite(geometry.pageNumber) && geometry.pageNumber !== markerPage) {
        markerPage = geometry.pageNumber;
        markerNumbers = new Map(); nextMarkerNumber = 1;
      }
      domFailures = new Map();
      planDirty = true;
      schedule();
    }
    /** P3-E F1：display:none 下 DOM 溢出验证空过（测量恒为 0）；转可见时弃组与 Plan 重走真实实测，evidence、降级档位与编号保留。 */
    function setVisible(value) {
      const next = !!value;
      if (next === visible) return;
      visible = next;
      applyVisibility();
      if (visible) invalidateLayout();
    }
    function invalidateLayout() {
      if (layer) layer.replaceChildren();
      groups = new Map();
      plan = null; planDirty = true;
      schedule();
    }
    function applyVisibility() {
      if (overlay) { overlay.hidden = !visible; overlay.setAttribute("aria-hidden", String(!visible)); }
    }
    function clear() {
      if (frame) { cancelAnimationFrame(frame); frame = 0; }
      if (flashTimer) { clearTimeout(flashTimer); flashTimer = 0; }
      overlay = null; layer = null; draftLayer=null;draft=null;draftNodes=null; debugLayer = null; markerLayer = null; flashLayer = null; canvas = null;
      view = null; model = null; plan = null; markerSig = "";
      evidence = new Map();sampledText=new Map(); queue = []; domFailures = new Map(); groups = new Map();
      markerNumbers = new Map(); nextMarkerNumber = 1; markerPage = null;
    }
    function refresh() { schedule(); }
    function getPlanSummary() {
      return plan ? {...plan.stats, visible, generation} : null;
    }

    // ---------- C1：像素证据采样（同步，绑定当前渲染代次；判定口径与 P5 导出共用 pdf/pixel-evidence.js） ----------

    function sampleBlock(block, result, m) {
      if (!canvas || !canvas.width || !view || !view.width) return EV.fail();
      return EV.sample({canvas, block, result,geometry:model.geometry,rows:model.rows,matrix: m, pxPerCss: canvas.width / view.width});
    }

    // ---------- C3：Plan 消费与绘制 ----------

    function setRectStyle(style, rect) {
      style.left = rect.x + "px"; style.top = rect.y + "px";
      style.width = Math.max(0, rect.right - rect.x) + "px";
      style.height = Math.max(0, rect.bottom - rect.y) + "px";
    }
    function renderDraft(){
      if(!draftLayer)return;
      const m=matrix(),valid=!!draft&&!!m&&draft.pageNumber===model?.geometry.pageNumber&&draft.pageNumber===view?.pageNumber;
      const hiddenIds=new Set(valid?draft.suppressIds:[]);
      for(const [id,entry] of groups){const hidden=hiddenIds.has(id);if(entry.group.hidden!==hidden)entry.group.hidden=hidden;}
      for(const marker of markerLayer?.querySelectorAll(".pdf-marker")||[])marker.hidden=hiddenIds.has(marker.dataset.blockId);
      if(!valid){draftLayer.replaceChildren();draftNodes=null;return;}
      draftLayer.style.transform="matrix("+m.join(",")+")";
      if(!draftNodes){const text=document.createElement("div");text.className="pdf-place-text";draftLayer.append(text);draftNodes={text,masks:[],signature:null};}
      const {text,masks}=draftNodes,style=draft.textStyle;
      while(masks.length>draft.maskRects.length)masks.pop().remove();
      for(const [index,rect] of draft.maskRects.entries()){
        if(!masks[index]){const mask=document.createElement("div");mask.className="pdf-place-mask";mask.style.background="white";draftLayer.insertBefore(mask,text);masks.push(mask);}
        setRectStyle(masks[index].style,rect);
      }
      setRectStyle(text.style,draft.rect);
      const signature=JSON.stringify([draft.fontFamily,draft.fontSize,draft.lineHeight,style,draft.align,draft.direction,draft.lines]);
      if(signature!==draftNodes.signature){
        Object.assign(text.style,{fontFamily:global.BT_PDF_LAYOUT_PLANNER.fontStack(draft.fontFamily),fontSize:draft.fontSize+"px",lineHeight:draft.lineHeight+"px",
          fontWeight:style.bold?"700":"400",fontStyle:style.italic?"italic":"normal",color:style.color,textAlign:style.align||draft.align,direction:draft.direction,overflow:"hidden"});
        text.replaceChildren();
        for(const line of draft.lines){const child=document.createElement("div");child.className="pdf-place-line";child.textContent=line;text.append(child);}
        draftNodes.signature=signature;
      }
    }
    function setDraftPreview(value){draft=value||null;renderDraft();}
    /**
     * 构建单块「遮罩+译文」组：先以 visibility:hidden 插入完成 DOM 实测验证，
     * 通过后才可见——遮罩绝不在验证前对用户显示；失败整组移除并记录降级重规划。
     */
    // 译文墨色按遮罩亮度选择，与 export-worker 同一口径（阈值 0.55）；
    // 不能继承主题 --text：暗色模式的浅色主题字落在白色遮罩上几乎不可见。
    const INK_DARK = "rgb(36,50,71)", INK_LIGHT = "rgb(224,231,240)";
    const maskInk = color => {
      const c = Array.isArray(color) && color.length === 3 ? color : [255, 255, 255];
      return (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255 < 0.55 ? INK_LIGHT : INK_DARK;
    };
    function buildGroup(id, placement, signature) {
      const group = document.createElement("div");
      group.className = "pdf-place";
      group.dataset.blockId = id;
      group.style.visibility = "hidden";
      for(const rect of placement.maskRects||[placement.maskRect]){
        const mask=document.createElement("div");mask.className="pdf-place-mask";setRectStyle(mask.style,rect);
        mask.style.background="rgb("+placement.maskColor.join(",")+")";group.append(mask);
      }
      const text = document.createElement("div");
      text.className = "pdf-place-text";
      setRectStyle(text.style, placement.textRect);
      text.style.color = placement.textStyle?.color||maskInk(placement.maskColor);
      text.style.fontWeight = placement.textStyle?.bold?"700":"400";
      text.style.fontStyle = placement.textStyle?.italic?"italic":"normal";
      text.style.fontSize = placement.fontSize + "px";
      text.style.fontFamily = global.BT_PDF_LAYOUT_PLANNER.fontStack(placement.fontFamily);
      text.style.lineHeight = placement.lineHeight + "px";
      text.style.direction = placement.direction;
      text.style.textAlign = placement.align;
      for (const line of placement.lines) {
        const element = document.createElement("div");
        element.className = "pdf-place-line";
        element.textContent = line;
        text.append(element);
      }
      group.append(text);
      layer.append(group);
      // scroll/client 尺寸是整数，人工框已通过浮点度量；允许至多 1px 的取整差。
      // 自动译文保留原有严格门限，不放宽自动覆盖范围。
      const rounding=placement.manual?1:0.5;
      let ok = text.scrollHeight <= text.clientHeight + rounding;
      if (ok) for (const element of text.children) {
        if (element.scrollWidth > element.clientWidth + rounding) { ok = false; break; }
      }
      if (!ok) {
        group.remove();
        const tier = domFailures.get(id) || 0;
        if (tier < K.MAX_DOM_TIERS) {
          domFailures.set(id, tier + 1);
          planDirty = true;
          schedule();
        }
        return;
      }
      group.style.visibility = "";
      groups.set(id, {group, signature});
    }
    function applyPlan(next) {
      const keep = new Set();
      for (const [id, placement] of next.placements) {
        keep.add(id);
        const signature = JSON.stringify([placement.maskRect, placement.maskRects, placement.textRect, placement.fontSize, placement.lineHeight,
          placement.lines, placement.maskColor, placement.direction, placement.align, placement.fontFamily, placement.textStyle]);
        const existing = groups.get(id);
        if (existing && existing.signature === signature) continue;
        if (existing) { existing.group.remove(); groups.delete(id); }
        buildGroup(id, placement, signature);
      }
      for (const [id, entry] of groups) {
        if (!keep.has(id)) { entry.group.remove(); groups.delete(id); }
      }
      // 更新旧修订时 DOM 可能被复用；重新排列以保持与规划器、PDF 导出相同的覆盖顺序。
      for(const id of next.placements.keys()){
        const entry=groups.get(id);if(entry)layer.append(entry.group);
      }
      renderDraft();
      const changed = !plan || plan.stats.overlay !== next.stats.overlay || plan.stats.fallback !== next.stats.fallback;
      plan = next;
      assignMarkerNumbers(next);
      if (onPlanSummary) onPlanSummary({stats: next.stats, numbers: new Map(markerNumbers), fallbacks: next.fallbacks});
      if (changed && isDebug()) {
        const reasons = {};
        for (const item of next.fallbacks) reasons[item.reason] = (reasons[item.reason] || 0) + 1;
        console.info("[页知译 PDF] 原位译文规划：", {...next.stats, 回退原因: reasons});
      }
    }
    function drawDebugBoxes(m) {
      if (!debugLayer) return;
      debugLayer.replaceChildren();
      if (!isDebug() || !m || !model) return;
      const fragment = document.createDocumentFragment();
      const box = (rect, className, title) => {
        const corners = [[rect.x, rect.y], [rect.right, rect.y], [rect.right, rect.bottom], [rect.x, rect.bottom]]
          .map(([x, y]) => apply(m, x, y));
        const xs = corners.map(p => p[0]), ys = corners.map(p => p[1]);
        const left = Math.min(...xs), top = Math.min(...ys);
        const element = document.createElement("div");
        element.className = className;
        if (title) element.title = title;
        element.style.left = left + "px"; element.style.top = top + "px";
        element.style.width = Math.max(0, Math.max(...xs) - left) + "px";
        element.style.height = Math.max(0, Math.max(...ys) - top) + "px";
        fragment.append(element);
      };
      for (const {block, result} of model.rows) {
        if (!block.rect) continue;
        if (plan) {
          if (plan.placements.has(block.id)) continue;
          const fallback = plan.fallbacks.find(item => item.blockId === block.id);
          if (fallback) box(block.rect, "pdf-debug-box pdf-debug-fallback", "回退：" + fallback.reason);
          else if (result && result.status === "translated") box(block.rect, "pdf-debug-box pdf-debug-pending", "等待像素证据采样");
        } else if (result && result.text) box(block.rect, "pdf-debug-box pdf-debug-box-done");
      }
      debugLayer.append(fragment);
    }

    // ---------- P3-D：回退编号、标记与双向联动 ----------

    /** 编号按阅读顺序首次出现取号，只增不复用；新回退追加新号，既有编号不移位。 */
    function assignMarkerNumbers(next) {
      if (!model) return;
      const orderOf = new Map(model.rows.map(row => [row.block.id, row.block.order]));
      const sorted = [...next.fallbacks].sort((a, b) => (orderOf.get(a.blockId) || 0) - (orderOf.get(b.blockId) || 0));
      for (const item of sorted) if (!markerNumbers.has(item.blockId)) markerNumbers.set(item.blockId, nextMarkerNumber++);
    }
    /** 固定坐标 rect → 显示空间 css 像素包围盒；身份不匹配或块不在当前页返回 null，调用方必须 no-op。 */
    function getDisplayRect(blockId) {
      const m = matrix();
      if (!m || !model || !view) return null;
      if (view.pageNumber !== model.geometry.pageNumber) return null;
      const row = model.rows.find(item => item.block.id === blockId);
      if (!row || !row.block.rect) return null;
      const rect=row.result?.userEdited&&row.result?.manualPlacement?.rect||row.block.rect;
      const corners = [[rect.x, rect.y], [rect.right, rect.y],
        [rect.right, rect.bottom], [rect.x, rect.bottom]]
        .map(([x, y]) => apply(m, x, y));
      const xs = corners.map(p => p[0]), ys = corners.map(p => p[1]);
      return {x: Math.min(...xs), y: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys)};
    }
    const MARKER_SIZE = 16, MARKER_GAP = 2;
    /**
     * 显示空间绘制编号标记：左外→右外→上外三个候选位，须避开页面边界、所有块 rect 与已放置标记；
     * 无安全位置时该块仅保留右侧面板编号，不强行覆盖。签名门控避免每帧重建 DOM。
     */
    function drawMarkers(m) {
      if (!markerLayer) return;
      const fallbacks = plan ? plan.fallbacks : [];
      const sig = m ? JSON.stringify([fallbacks.map(f => f.blockId + ":" + markerNumbers.get(f.blockId)),
        m.map(v => Math.round(v * 1000) / 1000), view.width, view.height]) : "empty";
      if (sig === markerSig) return;
      markerSig = sig;
      markerLayer.replaceChildren();
      if (!m || !model || !fallbacks.length) return;
      const displayRect = rect => {
        const corners = [[rect.x, rect.y], [rect.right, rect.y], [rect.right, rect.bottom], [rect.x, rect.bottom]]
          .map(([x, y]) => apply(m, x, y));
        const xs = corners.map(p => p[0]), ys = corners.map(p => p[1]);
        return {x: Math.min(...xs), y: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys)};
      };
      const rowRects = model.rows.filter(row => row.block.rect).map(row => displayRect(row.block.rect));
      const placed = [];
      const hits = (box, list) => list.some(o => box.x < o.right && o.x < box.right && box.y < o.bottom && o.y < box.bottom);
      const fragment = document.createDocumentFragment();
      const sorted = [...fallbacks].sort((a, b) => (markerNumbers.get(a.blockId) || 0) - (markerNumbers.get(b.blockId) || 0));
      for (const item of sorted) {
        const row = model.rows.find(r => r.block.id === item.blockId);
        if (!row || !row.block.rect) continue;
        const d = displayRect(row.block.rect);
        const candidates = [{x: d.x - MARKER_SIZE - MARKER_GAP, y: d.y},
          {x: d.right + MARKER_GAP, y: d.y}, {x: d.x, y: d.y - MARKER_SIZE - MARKER_GAP}];
        let chip = null;
        for (const c of candidates) {
          const box = {x: c.x, y: c.y, right: c.x + MARKER_SIZE, bottom: c.y + MARKER_SIZE};
          if (box.x < 0 || box.y < 0 || box.right > view.width || box.bottom > view.height) continue;
          if (hits(box, rowRects) || hits(box, placed)) continue;
          chip = box; break;
        }
        if (!chip) continue;
        placed.push(chip);
        const number = markerNumbers.get(item.blockId);
        const el = document.createElement("div");
        el.className = "pdf-marker";
        el.textContent = String(number);
        el.title = "回退 " + number + "：" + item.reason;
        el.tabIndex = 0;
        el.setAttribute("role", "button");
        el.setAttribute("aria-label", el.title + "，查看对应译文");
        el.dataset.blockId = item.blockId;
        el.style.left = chip.x + "px"; el.style.top = chip.y + "px";
        el.addEventListener("click", () => { if (onMarkerClick) onMarkerClick(item.blockId); });
        el.addEventListener("keydown", event => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault(); el.click();
        });
        fragment.append(el);
      }
      markerLayer.append(fragment);
    }
    /** P3-E F2：高亮环挂在不受 Overlay 开关影响的 flash-layer，双语模式定位也有反馈；身份不匹配 no-op，翻页/缩放随 resetPlanState 清空。 */
    function flashHighlight(blockId) {
      flashDisplayRect(getDisplayRect(blockId));
    }
    function flashDisplayRect(rect) {
      if (!flashLayer||!rect||![rect.x,rect.y,rect.right,rect.bottom].every(Number.isFinite)) return;
      if (flashTimer) { clearTimeout(flashTimer); flashTimer = 0; }
      for (const old of flashLayer.querySelectorAll(".pdf-marker-flash")) old.remove();
      const el = document.createElement("div");
      el.className = "pdf-marker-flash";
      el.style.left = rect.x - 2 + "px"; el.style.top = rect.y - 2 + "px";
      el.style.width = rect.right - rect.x + 4 + "px"; el.style.height = rect.bottom - rect.y + 4 + "px";
      flashLayer.append(el);
      flashTimer = setTimeout(() => { el.remove(); flashTimer = 0; }, 1600);
    }

    // ---------- 主管线 ----------

    function pipeline() {
      if (!overlay || !overlay.isConnected) return;
      const m = matrix();
      if (!m || !model || !view) { drawDebugBoxes(m); drawMarkers(null); return; }
      // 三元身份校验：页码一致 + 画布在位；不匹配时不采样、不规划、不绘制，防止跨页残留。
      if (view.pageNumber !== model.geometry.pageNumber || !canvas || !canvas.isConnected) return;
      layer.style.transform = "matrix(" + m.join(",") + ")";
      renderDraft();
      const rowsById = new Map(model.rows.map(row => [row.block.id, row]));
      const queued = new Set(queue);
      for (const {block, result} of model.rows) {
        if (result && !result.manualPlacement && result.status === "translated" && result.text && result.text.trim() &&
            (!evidence.has(block.id)||sampledText.get(block.id)!==JSON.stringify([result.text,result.fontFamily])) && !queued.has(block.id)) {
          queue.push(block.id); queued.add(block.id);
        }
      }
      queue = queue.filter(id => rowsById.has(id));
      let sampled = 0;
      while (queue.length && sampled < SAMPLE_BLOCKS_PER_FRAME) {
        const row = rowsById.get(queue.shift());
        if (!row) continue;
        evidence.set(row.block.id, sampleBlock(row.block,row.result, m));sampledText.set(row.block.id,JSON.stringify([row.result?.text,row.result?.fontFamily]));
        sampled++;
      }
      if (sampled) planDirty = true;
      if (queue.length) schedule();
      if (planDirty || !plan) {
        planDirty = false;
        applyPlan(global.BT_PDF_LAYOUT_PLANNER.plan({geometry: model.geometry, rows: model.rows, evidence, domFailures}));
      }
      drawDebugBoxes(m);
      drawMarkers(m);
      renderDraft();
    }

    return {mount, setView, setModel, setVisible, clear, refresh, getPlanSummary, getDisplayRect,
      getPlacement:id=>plan?.placements.get(id)||null,setDraftPreview,flashHighlight,flashDisplayRect};
  }
  global.BT_PDF_TRANSLATION_RENDERER = {create};
})(window);
