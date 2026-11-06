const fs = require('fs');
const s = fs.readFileSync('client.js','utf8');
const lines = s.split('\n');
const suspects = /[銆锛鈥鈼鈻鑷灏氭湭绔嬭鎰忚璁剧鏂囧鍜杩鐨姝娓棣鈽鈻]/;
let n=0;
lines.forEach((l,i)=>{ if(suspects.test(l)){ n++; console.log((i+1)+': '+l.trim().slice(0,200)); }});
console.log('--- total', n);
