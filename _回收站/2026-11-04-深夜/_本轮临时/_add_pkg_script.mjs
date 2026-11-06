import fs from 'node:fs'
const p = 'package.json'
let s = fs.readFileSync(p, 'utf8')
if (s.includes('"test:judge"')) { console.log('already there'); process.exit(0) }
const re = /(\r?\n)(\s*)("test:speaker"\s*:\s*"[^"]*",)(\r?\n)/
if (!re.test(s)) { console.error('speaker line not found'); process.exit(1) }
s = s.replace(re, (m, nl1, indent, line, nl2) => nl1 + indent + line + nl2 + indent + '"test:judge": "node test/pair-judge.test.mjs && node test/stale-judge-nightly.test.mjs && node test/write-gate-judge.test.mjs && node test/judge-sim.test.mjs && node test/time-awareness.test.mjs",' + nl2)
fs.writeFileSync(p, s, 'utf8')
console.log('added test:judge')
