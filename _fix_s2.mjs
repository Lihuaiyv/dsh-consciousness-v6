import fs from 'node:fs'
const p = 'test/judge-sim.test.mjs'
let s = fs.readFileSync(p, 'utf8')
s = s.replace("    console.log('DBG', JSON.stringify(evs.map((e) => [e.verdict, e.reason])))\n", '')
s = s.split('部署计划排在下周一凌晨').join('部署计划排在下周一凌晨，等通知')
fs.writeFileSync(p, s, 'utf8')
console.log('fixed')
