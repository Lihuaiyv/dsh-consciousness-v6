import fs from 'node:fs'
const p = 'test/pair-judge.test.mjs'
let s = fs.readFileSync(p, 'utf8')
const a = "const r7 = await judgePair({ db: w.db, aid: w.aid, oldRow: e.newer, newerRow: e.old, complete: null, via: 'test' })"
const b = "const r7 = await judgePair({ db: w.db, aid: w.aid, oldRow: e.newer, newerRow: e.old, complete: async () => '取代', via: 'test' })"
if (!s.includes(a)) { console.error('anchor missing'); process.exit(1) }
fs.writeFileSync(p, s.replace(a, b), 'utf8')
console.log('patched')
