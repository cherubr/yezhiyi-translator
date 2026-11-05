(function(){
  "use strict";
  const $=id=>document.getElementById(id),api=window.BT_GLOSSARY;let revision=0,savedRevision=0,writing=false;
  const notice=(text,error=false)=>{$("glossaryStatus").textContent=text;$("glossaryStatus").style.color=error?"#b53c30":"";};
  function addRow(entry={source:"",target:"",language:"zh-CN",enabled:true,caseSensitive:false}){
    const row=document.createElement("div");row.className="glossary-row";
    const source=document.createElement("input"),target=document.createElement("input"),language=document.createElement("select"),enabled=document.createElement("input"),exact=document.createElement("input"),remove=document.createElement("button");
    source.value=entry.source;source.placeholder="原词，例如 kernel";source.maxLength=120;source.setAttribute("aria-label","术语原词");
    target.value=entry.target;target.placeholder="固定译法，例如 内核（留空保留原词）";target.maxLength=200;target.setAttribute("aria-label","术语译法");
    BT_CONST.fillLanguageSelect(language,"to",entry.language==="*"?"zh-CN":entry.language);
    for(const option of [...language.options])if(["browser","auto"].includes(option.value))option.remove();
    language.prepend(new Option("所有语言","*"));language.value=entry.language;language.setAttribute("aria-label","术语目标语言");
    enabled.type=exact.type="checkbox";enabled.checked=entry.enabled!==false;exact.checked=entry.caseSensitive===true;
    const enabledLabel=document.createElement("label"),exactLabel=document.createElement("label");enabledLabel.append(enabled,"启用");exactLabel.append(exact,"区分大小写");
    remove.type="button";remove.className="settings-action settings-action--danger";remove.textContent="删除";remove.addEventListener("click",()=>{row.remove();revision++;});
    row.append(source,target,language,enabledLabel,exactLabel,remove);row._fields={source,target,language,enabled,exact};$("glossaryRows").append(row);
    row.addEventListener("input",()=>revision++);row.addEventListener("change",()=>revision++);
  }
  function read(){return api.normalize({enabled:$("glossaryEnabled").checked,builtins:$("glossaryBuiltins").checked,entries:[...$("glossaryRows").children].map(row=>{
    const f=row._fields;return {source:f.source.value,target:f.target.value,language:f.language.value,enabled:f.enabled.checked,caseSensitive:f.exact.checked};
  })});}
  function render(value){const config=api.normalize(value);$("glossaryEnabled").checked=config.enabled;$("glossaryBuiltins").checked=config.builtins;$("glossaryRows").replaceChildren();config.entries.forEach(addRow);revision++;savedRevision=revision;}
  async function save(){
    if(writing)return;writing=true;$("saveGlossary").disabled=true;
    try{const config=read(),version=revision;await BT_STORAGE.set({glossary:config});savedRevision=version;notice("术语表已保存，旧译文将清理；已开始翻译的网页会按新规则补翻。");}
    catch(error){notice(error.message||"保存失败",true);}finally{writing=false;$("saveGlossary").disabled=false;}
  }
  $("addGlossary").addEventListener("click",()=>{if($("glossaryRows").children.length>=api.MAX_ENTRIES){notice("最多 500 条自定义术语",true);return;}addRow();revision++;});
  $("saveGlossary").addEventListener("click",save);
  for(const id of ["glossaryEnabled","glossaryBuiltins"])$(id).addEventListener("change",()=>revision++);
  $("exportGlossary").addEventListener("click",()=>{try{
    const url=URL.createObjectURL(new Blob([JSON.stringify(read(),null,2)],{type:"application/json"})),link=document.createElement("a");link.href=url;link.download="yezhiyi-glossary.json";link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }catch(error){notice(error.message,true);}});
  $("importGlossary").addEventListener("change",async()=>{try{
    const file=$("importGlossary").files[0];if(!file)return;if(file.size>api.MAX_IMPORT_BYTES)throw Error("导入文件超过 256 KB");
    const imported=api.normalize(JSON.parse(await file.text()));render(imported);revision++;notice("已载入导入内容；点击保存后生效。导入会替换当前列表。");
  }catch(error){notice(error.message||"导入失败",true);}finally{$("importGlossary").value="";}});
  chrome.storage.onChanged.addListener((changes,area)=>{if(area!=="local"||!changes.glossary||writing)return;
    if(revision!==savedRevision){notice("其他窗口更新了术语表；当前未保存的编辑保留，保存将覆盖其他窗口的更改。",true);return;}
    try{render(changes.glossary.newValue||{});}catch(error){notice(error.message,true);}
  });
  BT_STORAGE.get(["glossary"]).then(value=>render(value.glossary||{})).catch(()=>notice("术语表读取失败，请重新打开设置页",true));
})();
