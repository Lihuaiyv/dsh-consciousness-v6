import fs from 'node:fs'
const p = 'test/judge-sim.test.mjs'
let s = fs.readFileSync(p, 'utf8')
const a = "    const evs = events(w)\n"
if (!s.includes(a)) { console.error('anchor missing'); process.exit(1) }
s = s.replace(a, a + "    console.log('DBG', JSON.stringify(evs.map((e) => [e.verdict, e.reason])))\n")
fs.writeFileSync(p, s, 'utf8')
console.log('debug added')
