const assert = require("node:assert/strict");
const fs = require("node:fs"), vm = require("node:vm");
const scope = {window: {}};
vm.runInNewContext(fs.readFileSync("pdf/translation-edits.js", "utf8"), scope);
const records = new Map();
const storage = {all: async () => [...records.values()], write: async (row, key) => {
  if (row) records.set(key, structuredClone(row)); else records.delete(key);
}};
(async () => {
  const edits = scope.window.BT_PDF_EDITS.create(storage), block = {id:"1:0",text:"Original"};
  await edits.setDocument("content-sha-A");
  await edits.save("zh",1,block,"人工修改\n第二行",{status:"translated",text:"Machine"});
  assert.equal(edits.get("zh",1,block).text,"人工修改\n第二行");
  assert.equal(edits.get("en",1,block),null);
  assert.equal(edits.get("zh",2,block),null);
  assert.equal(edits.get("zh",1,{...block,text:"Different source"}),null);
  await assert.rejects(edits.save("zh",1,block,"  ",null),/不能为空/);
  await edits.setDocument("content-sha-B");assert.equal(edits.get("zh",1,block),null);
  await edits.setDocument("content-sha-A");assert.match(edits.get("zh",1,block).text,/人工修改/);
  const reopened=scope.window.BT_PDF_EDITS.create(storage);await reopened.setDocument("content-sha-A");
  assert.match(reopened.get("zh",1,block).text,/第二行/);
  assert.equal(reopened.unmatched("zh",1,[block]),0);
  assert.equal(reopened.unmatched("zh",1,[{id:'new-heading',text:'Split heading'}]),1,'incompatible old edit must be reported, not rebound by order');
  assert.equal(reopened.unmatched("en",1,[]),0);assert.equal(reopened.unmatched("zh",2,[]),0);
  const machine=await reopened.remove("zh",1,block);assert.equal(machine.text,"Machine");assert.equal(reopened.get("zh",1,block),null);
  let finish;
  const delayed=scope.window.BT_PDF_EDITS.create({all:()=>new Promise(resolve=>{finish=resolve;}),write:storage.write});
  const first=delayed.setDocument("old"), save=delayed.save("zh",1,block,"Stale",null);
  await delayed.setDocument(null);finish([]);await first;
  await assert.rejects(save,/文件已切换/);
  const failed=scope.window.BT_PDF_EDITS.create({all:async()=>[],write:async()=>{throw new Error("Quota transaction failed");}});
  await failed.setDocument("content-sha-A");
  await assert.rejects(failed.save("zh",1,block,"Not saved",null),/Quota/);
  assert.equal(failed.get("zh",1,block),null,"failed storage transaction must not publish saved text");
  const M={self:{}};vm.runInNewContext(fs.readFileSync("pdf/structured-reader.js","utf8"),M);
  const rows=[{block:{...block,eligible:true,reliable:true,role:"text",height:12,order:1},result:{status:"translated",text:"Body"}},
    {block:{...block,id:"1:1",eligible:true,reliable:true,role:"text",height:26,order:0},result:{status:"translated",text:"Title"}},
    {block:{...block,id:"1:2",eligible:true,reliable:true,role:"text",height:12,order:2,text:"- Source list"},result:{status:"failed",reason:"Failure"}}];
  const model=M.self.BT_PDF_STRUCTURED.items(rows);
  assert.equal(model[0].kind,"heading");assert.equal(model[1].text,"Body");assert.equal(model[2].kind,"list");assert.equal(model[2].success,false);
  assert.ok(model.every(item=>item.kind!=="table"),"no cell evidence must not fabricate a table");
  console.log("PASS PDF edits: persistence, document/language/source isolation, empty rejection, restore and late loading");
})().catch(error=>{console.error(error);process.exitCode=1;});
