// 翻译单元：先划分正文/控件/混合区域，再保护行内原文；不依赖网站域名或翻译引擎。
(function(global) {
  "use strict";
  const BLOCK_TEXT="p, h1, h2, h3, h4, h5, h6, li, blockquote, td, th, figcaption, dt, dd";
  const CONTROLS="label, legend, button, summary, [role='button'], [role='tab'], [role='menuitem'], [role='option']";
  const INPUTS="input, textarea, select, [contenteditable]:not([contenteditable='false'])";
  const HIDDEN="[hidden], [aria-hidden='true']";
  const OPAQUE="code, [translate='no'], .notranslate";
  const BLOCK_DISPLAY=/^(block|flex|grid|list-item|flow-root|table($|-)|inline-flex|inline-grid)/;

  // 只识别成对包裹的内部标记。长度上限避免把整段正文当作标记候选。
  const MARKER_GAP="[\\s\\u200B-\\u200D\\u2060\\uFEFF]*";
  const MARKER_BODY=MARKER_GAP+"[YyＹｙ]"+MARKER_GAP+"[ZzＺｚ]"+MARKER_GAP+"[YyＹｙ][^⟦⟧\\[\\]【】［］]{1,80}";
  const MARKER_PATTERN=new RegExp("⟦"+MARKER_BODY+"⟧|\\[\\["+MARKER_BODY+"\\]\\]|\\["+MARKER_BODY+"\\]|【"+MARKER_BODY+"】|［"+MARKER_BODY+"］","g");

  /** 仅规范化标记内部的宽字符、空白及不可见分隔符，不改变译文正文和本地代码。 */
  function markerInfo(raw) {
    const inner=raw.startsWith("[[")?raw.slice(2,-2):raw.slice(1,-1);
    const normalized=inner.normalize("NFKC").replace(/[\s\u200B-\u200D\u2060\uFEFF]/g,"").toUpperCase();
    const match=/^YZY(\d+):(\d+)$/.exec(normalized);
    if(match)return {normalized,nonce:Number(match[1]),index:Number(match[2])};
    return /^YZY\d+:/.test(normalized)?{normalized,invalid:true}:null;
  }

  /** 保护映射仅留在页面。接口收到占位标记，不收到代码/禁译文字；原始 DOM 不参与编码。 */
  function encode(segments) {
    const plain=segments.map(item=>item.text).join("");
    // 将格式变体也计入命名空间避让，避免把原文中已有的示例标记误认成内部标记。
    const normalized=plain.normalize("NFKC").replace(/[\s\u200B-\u200D\u2060\uFEFF]/g,"").toUpperCase();
    let nonce=0;
    while(normalized.includes("YZY"+nonce+":"))nonce++;
    const values=[],prefix="⟦YZY"+nonce+":";
    const text=segments.map(item=>{
      if(!item.protected)return item.text;
      const index=values.push(item.text)-1;
      return prefix+index+"⟧";
    }).join("").trim();
    return {text,values,nonce};
  }

  /**
   * 接受可明确识别的括号/全半角/空白变化；每个保护项仍必须恰好返回一次。
   * 不按顺序猜测缺失项，不把保护文字发往接口，也不因校验失败新增自动请求。
   */
  function decode(text,protection) {
    if(!protection?.values?.length)return text;
    const counts=protection.values.map(()=>0),literals=new Map();
    // 原文可能本身包含其他命名空间的标记示例；只允许原有示例，不接受接口凭空新增的编号。
    for(const match of (protection.text||"").matchAll(MARKER_PATTERN)){
      const info=markerInfo(match[0]);
      if(info&&info.nonce!==protection.nonce)literals.set(info.normalized,(literals.get(info.normalized)||0)+1);
    }
    let invalid=0;
    const result=text.replace(MARKER_PATTERN,raw=>{
      const info=markerInfo(raw);
      if(!info)return raw;
      if(info.nonce!==protection.nonce){
        const remaining=literals.get(info.normalized)||0;
        if(remaining){literals.set(info.normalized,remaining-1);return raw;}
        invalid++;return raw;
      }
      if(info.invalid||!Number.isSafeInteger(info.index)||info.index>=counts.length){invalid++;return raw;}
      counts[info.index]++;return protection.values[info.index];
    });
    const markerDiagnostics={expected:counts.length,missing:counts.filter(n=>n===0).length,
      duplicates:counts.reduce((sum,n)=>sum+Math.max(0,n-1),0),invalid};
    if(invalid||markerDiagnostics.missing||markerDiagnostics.duplicates)throw Object.assign(
      new Error("译文未完整保留行内代码或禁译标记，请重试或更换翻译服务"),
      {code:"PROTECTED_CONTENT_CHANGED",retryable:false,markerDiagnostics});
    return result;
  }

  /** 后台分块不可切断保护标记；索引使用 UTF-16 偏移，与字符串 slice 一致。 */
  function protectedRanges(text) {
    return [...text.matchAll(/⟦YZY\d+:\d+⟧/g)].map(match=>({start:match.index,end:match.index+match[0].length}));
  }

  function nodesOf(unit){return unit.nodes||(unit.node?[unit.node]:null);}
  /** 当前快照用原始 textContent 校验，和含换行/保护标记的接口文字分别保存。 */
  function sourceOf(unit) {
    const nodes=nodesOf(unit);
    return (nodes?nodes.map(node=>node.textContent||"").join(""):unit.el.textContent||"").trim();
  }
  function isCurrent(unit) {
    if(!unit.el.isConnected)return false;
    const nodes=nodesOf(unit);
    if(nodes&&nodes.some(node=>node.parentNode!==unit.el))return false;
    if(nodes&&nodes.some((node,index)=>index&&nodes[index-1].nextSibling!==node))return false;
    return sourceOf(unit)===(unit.sourceText??unit.text);
  }

  /**
   * 采集器只返回单元，不移动节点、不请求接口。style 与行内子树分析缓存仅存活于本次扫描。
   * 整页、局部补翻和 Shift 都通过同一个入口；状态兼容判断由内容脚本回调提供。
   */
  function createCollector(options) {
    function collect(roots,scan={}) {
      const styles=new WeakMap(),inlineCache=new WeakMap(),candidates=new Set();
      const excluded=options.excluded(scan),doc=options.getDocument?options.getDocument():global.document;
      const style=el=>{if(!styles.has(el))styles.set(el,options.getStyle(el));return styles.get(el);};
      const hidden=el=>el.matches(HIDDEN)||/^(none)$/.test(style(el).display)||/^(hidden|collapse)$/.test(style(el).visibility);
      const boundary=el=>el.matches(BLOCK_TEXT)||BLOCK_DISPLAY.test(style(el).display);
      const control=el=>el.matches(CONTROLS+", "+INPUTS);
      const addRoot=root=>{
        if(!root?.isConnected||root.closest(excluded))return;
        if(root.matches(options.selector))candidates.add(root);
        root.querySelectorAll(options.selector).forEach(el=>candidates.add(el));
      };
      if(!roots)doc.querySelectorAll(options.selector).forEach(el=>candidates.add(el));
      else for(const root of roots){
        // 内联文字变动时归并到所属正文段落，避免只补翻句中一个 span。
        addRoot(root?.closest?.(BLOCK_TEXT)||root);
      }

      /** null 表示边界。保护片段不计入可翻译正文，纯代码区域不会产生请求。 */
      function inline(el,depth=0) {
        if(depth>64)return null;
        if(inlineCache.has(el))return inlineCache.get(el);
        let result=null;
        if(!hidden(el)&&!boundary(el)&&!control(el)){
          if(el.matches(OPAQUE)){
            const unsafe=el.querySelector("pre, script, style, noscript, iframe, svg, math, canvas, "+INPUTS+", "+HIDDEN);
            const descendants=[...el.querySelectorAll("*")];
            if(!unsafe&&!descendants.some(child=>hidden(child)||boundary(child)))
              result={segments:[{text:el.textContent||"",protected:true}],prose:""};
          }else if(!el.matches(excluded)){
            if(el.tagName==="BR")result={segments:[{text:"\n"}],prose:""};
            else{
              const segments=[];let prose="",safe=true;
              for(const child of el.childNodes){
                if(child.nodeType===3){segments.push({text:child.textContent});prose+=child.textContent;}
                else if(child.nodeType===1){const value=inline(child,depth+1);if(!value){safe=false;break;}segments.push(...value.segments);prose+=value.prose;}
              }
              if(safe)result={segments,prose};
            }
          }
        }
        inlineCache.set(el,result);return result;
      }

      const units=[];
      for(const el of candidates){
        if(el.closest(excluded)||options.ownedByAncestor?.(el)||!options.acceptElement(el,scan))continue;
        const runs=[];let nodes=[],segments=[],prose="",hasBoundary=false,hasControl=false;
        const flush=()=>{if(nodes.length)runs.push({nodes,segments,prose});nodes=[];segments=[];prose="";};
        for(const child of el.childNodes||[]){
          if(child.nodeType===3){nodes.push(child);segments.push({text:child.textContent});prose+=child.textContent;}
          else if(child.nodeType===8)nodes.push(child);
          else if(child.nodeType===1){
            const value=inline(child);
            if(value){nodes.push(child);segments.push(...value.segments);prose+=value.prose;}
            else{flush();hasBoundary=true;hasControl=hasControl||control(child)||!!child.querySelector(INPUTS);}
          }
        }
        flush();
        for(const run of runs){
          const text=run.segments.map(item=>item.text).join("").trim();
          if(!/\p{L}/u.test(run.prose)||!options.canTranslate(run.prose.trim()))continue;
          const whole=!hasBoundary&&runs.length===1;
          if(!whole){
            // 边缘缩进留在原位置；单个完整行内元素交给自身候选，保留其可见性与状态身份。
            while(run.nodes[0]?.nodeType===3&&!run.nodes[0].textContent.trim())run.nodes.shift();
            while(run.nodes.at(-1)?.nodeType===3&&!run.nodes.at(-1).textContent.trim())run.nodes.pop();
            if(!run.nodes.length)continue;
            if(run.nodes.length===1&&run.nodes[0].nodeType===1&&run.nodes[0].matches(options.selector))continue;
          }
          const compact=el.matches(CONTROLS)||!!el.closest("button, [role='button']");
          const navigation=!!el.closest("nav, [role='navigation'], [role='menu']")&&!el.matches(BLOCK_TEXT);
          const kind=compact||hasControl?"control":navigation?"inline":boundary(el)?"paragraph":"inline";
          const unit={el,text,kind,protection:encode(run.segments)};
          if(!whole){unit.node=run.nodes[0];if(run.nodes.length>1)unit.nodes=run.nodes;}
          unit.sourceText=sourceOf(unit);
          if(!options.skipUnit?.(unit,scan))units.push(unit);
        }
      }
      // 以实际覆盖的节点去重：混合容器的一个文字区间不会吞掉旁边的按钮或下级段落。
      const owners=new WeakMap();
      for(const unit of units)for(const node of nodesOf(unit)||[unit.el])if(!owners.has(node))owners.set(node,unit);
      return units.filter(unit=>{
        for(const root of nodesOf(unit)||[unit.el])for(let node=root;node;node=node.parentNode){
          if(owners.has(node)&&owners.get(node)!==unit)return false;
        }
        return true;
      });
    }
    return {collect};
  }
  global.BT_TRANSLATION_UNITS={createCollector,encode,decode,protectedRanges,nodesOf,sourceOf,isCurrent};
})(typeof self!=="undefined"?self:globalThis);
