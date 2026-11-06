const fs=require("fs");
eval(fs.readFileSync(require("path").join(__dirname,"..","tab-sorter.uc.js"),"utf8"));
const h=globalThis.__tabSorterHelpers; const assert=require("assert");
assert(h.isExcluded("mail.google.com",h.DEFAULTS.exclude));
assert(h.isExcluded("online.sberbank.ru",h.DEFAULTS.exclude));
assert(!h.isExcluded("github.com",h.DEFAULTS.exclude));
assert.equal(h.cleanLabel('  "Тепловые   двигатели" <b> '),"Тепловые двигатели b");
assert.equal(h.cleanLabel("x".repeat(60)).length,32);
const ans='Here:\n```json\n{"groups":[{"name":"Cars","tabs":[0,1,1,9]},{"name":"work","tabs":[2,3,4]},{"name":"Lonely","tabs":[5]},{"name":"Dup","tabs":[0,2]},{"name":"A","tabs":[6,7]},{"name":"B","tabs":[8,9]}]}\n```';
const p=h.parseAnswer(ans,10,["Work"],2);
console.log(JSON.stringify(p));
assert.deepEqual(p.map(g=>g.name),["Cars","Work","A"]); // B over the cap (2 new max), Lonely dropped, Dup lost its tabs
assert.equal(p[1].existing,"Work");
assert.throws(()=>h.parseAnswer("no json",3,[],5));
const m=h.buildMessages([{host:"a.com",title:"T"}],["Work"],4,false);
assert(m[1].content.includes("0. T")&&!m[1].content.includes("a.com"));
console.log("all ok");
