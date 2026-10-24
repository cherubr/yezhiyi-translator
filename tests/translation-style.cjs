/**
 * 测试模块：译文样式配置与安全映射。
 * 隔离方式：独立 VM 和仅记录 CSS 变量的模拟节点。
 * 验收范围：非法配置回退、数值边界、本地字体白名单及恢复默认，不测实际字体渲染。
 * 执行：node tests/translation-style.cjs
 */
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path'),assert=require('node:assert/strict');
const context={};context.self=context;vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(__dirname,'../core/translation-style.js'),'utf8'),context);
const S=context.BT_TRANSLATION_STYLE,plain=value=>JSON.parse(JSON.stringify(value));
for(const value of [undefined,null,[],"bad",false])assert.deepEqual(plain(S.normalize(value)),plain(S.DEFAULTS));
const invalid=S.normalize({fontFamily:'url(https://invalid.test)',color:'red;background:url(x)',fontWeight:'900;display:none',fontSize:Infinity,lineHeight:NaN,paragraphSpacing:'2'});
assert.deepEqual(plain(invalid),plain(S.DEFAULTS));
assert.equal(S.normalize({fontFamily:'__proto__'}).fontFamily,'inherit');
assert.equal(S.normalize({fontSize:1}).fontSize,80);assert.equal(S.normalize({fontSize:900}).fontSize,200);
assert.equal(S.normalize({lineHeight:99}).lineHeight,2.4);assert.equal(S.normalize({paragraphSpacing:-1}).paragraphSpacing,0);
assert.equal(S.normalize({color:'#AaBBcc'}).color,'#aabbcc');assert.equal(S.normalize({lineHeight:0}).lineHeight,0);
const properties=new Map(),element={style:{setProperty:(key,value)=>properties.set(key,value)}};
S.apply(element,{fontFamily:'serif',fontSize:120,color:'#cc3300',fontWeight:'bold',lineHeight:1.8,paragraphSpacing:.6});
assert.equal(properties.get('--bt-translation-scale'),'1.2');assert.equal(properties.get('--bt-translation-color'),'#cc3300');
assert.equal(properties.get('--bt-translation-line-height'),'1.8');assert.equal(properties.get('--bt-translation-bottom-gap'),'0.9em');
assert.equal(properties.size,7);
S.apply(element,{});assert.equal(properties.get('--bt-translation-color'),'inherit');assert.equal(properties.get('--bt-translation-scale'),'1');
assert.equal(properties.get('--bt-translation-line-height'),'inherit');assert.equal(properties.get('--bt-translation-top-gap'),'0.4em');
assert.equal(Object.isFrozen(S.DEFAULTS),true);
console.log('PASS: 译文样式安全白名单、非法配置、范围限制、局部变量与恢复默认');
