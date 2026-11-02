(function(global){
  "use strict";
  const DEFAULTS=Object.freeze({version:1,enabled:true,builtins:true,entries:[]});
  const BUILTINS=["Linux","RHCE","OpenShift","Kubernetes","Red Hat"].map(source=>({source,target:source,language:"*",enabled:true,caseSensitive:false}));
  const MAX_ENTRIES=500,MAX_IMPORT_BYTES=256*1024;
  /** 只接受可编辑文字字段，拒绝重复/超限规则，不把导入对象直接写入配置。 */
  function normalize(value={}){
    if(!value||typeof value!=="object"||Array.isArray(value))throw Error("术语表必须是 JSON 对象");
    const entries=value.entries??[];
    if(!Array.isArray(entries)||entries.length>MAX_ENTRIES)throw Error("术语表最多支持 500 条自定义规则");
    const seen=new Set();
    return {version:1,enabled:value.enabled!==false,builtins:value.builtins!==false,entries:entries.map(entry=>{
      if(!entry||typeof entry.source!=="string"||typeof entry.target!=="string")throw Error("每条术语需要原词和固定译法，译法留空表示保留原词");
      const source=entry.source.trim(),target=entry.target.trim(),language=entry.language||"zh-CN";
      if(!source||source.length>120||target.length>200||/[\r\n\u0000-\u001f]/u.test(source+target))throw Error("原词需为 1～120 字符，译法最多 200 字符，且不能包含换行或控制字符");
      if(!/^(\*|[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*)$/.test(language))throw Error("术语目标语言无效");
      const key=source.toLowerCase()+"\n"+language.toLowerCase();if(seen.has(key))throw Error("相同原词和目标语言不能重复");seen.add(key);
      return {source,target,language,enabled:entry.enabled!==false,caseSensitive:entry.caseSensitive===true};
    })};
  }
  const escape=value=>value.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
  /** 长词优先、ASCII 单词边界；避开网页已有保护标记，所有引擎使用同一编码。 */
  function prepare(text,value,to){
    const config=normalize(value),unchanged={text,protection:null};if(!config.enabled)return unchanged;
    const custom=config.entries.filter(entry=>entry.enabled&&(entry.language==="*"||entry.language.toLowerCase()===to.toLowerCase()));
    const overrides=new Set(custom.map(entry=>entry.source.toLowerCase()));
    const rules=[...custom,...(config.builtins?BUILTINS.filter(entry=>!overrides.has(entry.source.toLowerCase())):[])].sort((a,b)=>b.source.length-a.source.length||Number(a.language==="*")-Number(b.language==="*"));
    if(!rules.length)return unchanged;
    const pattern=new RegExp(rules.map(entry=>escape(entry.source)).join("|"),"giu"),ranges=global.BT_TRANSLATION_UNITS.protectedRanges(text),values=[];
    // 字典内容参与标记命名空间，因此修改固定译法后不会复用旧字典的缓存结果。
    let nonce=parseInt(global.md5(JSON.stringify(rules)).slice(0,12),16)+1;
    const normalizedText=text.normalize("NFKC").replace(/[\s\u200B-\u200D\u2060\uFEFF]/g,"").toUpperCase();
    while(normalizedText.includes("YZY"+nonce+":"))nonce++;
    const encoded=text.replace(pattern,(match,offset)=>{
      if(ranges.some(range=>offset<range.end&&offset+match.length>range.start))return match;
      const rule=rules.find(entry=>entry.caseSensitive?entry.source===match:entry.source.toLowerCase()===match.toLowerCase());
      if(!rule)return match;
      if(/^[a-z0-9_]/i.test(match)&&/[a-z0-9_]/i.test(text[offset-1]||""))return match;
      if(/[a-z0-9_]$/i.test(match)&&/[a-z0-9_]/i.test(text[offset+match.length]||""))return match;
      return "⟦YZY"+nonce+":"+(values.push(rule.target||match)-1)+"⟧";
    });
    return values.length?{text:encoded,protection:{text:encoded,nonce,values}}:unchanged;
  }
  function restore(text,prepared){return prepared.protection?global.BT_TRANSLATION_UNITS.decode(text,prepared.protection):text;}
  global.BT_GLOSSARY={DEFAULTS,BUILTINS,MAX_ENTRIES,MAX_IMPORT_BYTES,normalize,prepare,restore};
})(typeof self!=="undefined"?self:globalThis);
