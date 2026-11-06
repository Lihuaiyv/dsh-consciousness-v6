const fs = require('fs');
for (const f of ['index.js','src/catalog.json','src/host/dsh.js','src/modules/affect.js','src/modules/actions/index.js']) {
  const s = fs.readFileSync(f,'utf8').split('\n');
  const re = /[銆锛鈥鈼鈻鑷灏氭湭绔嬭鎰忚璁剧鏂囧鍜杩鐨姝娓棣]/;
  s.forEach((l,i)=>{ if(re.test(l)) console.log(f+':'+(i+1)+': '+l.trim().slice(0,160)); });
}
