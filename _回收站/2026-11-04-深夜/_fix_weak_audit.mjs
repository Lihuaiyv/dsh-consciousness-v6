import fs from 'node:fs'
const p = 'scripts/audit-weak-stale.mjs'
let s = fs.readFileSync(p, 'utf8')
const a = "    const s = stampRow(db, aid, list[i])\n    if (s.source === 'topic_weak') weak.push({ topic, old: list[i], newer })"
const b = "    const s = stampRow(db, aid, list[i])\n    // 弱标候选＝只有 weakLater、没被判成确定更新；旧写法查 s.source==='topic_weak'，\n    // 但 stampRow 从不产生那个值，所以这个脚本一直导出 0 对。\n    if (s.weakLater) weak.push({ topic, old: list[i], newer })"
if (!s.includes(a)) { console.error('needle not found'); process.exit(1) }
fs.writeFileSync(p, s.replace(a, b), 'utf8')
console.log('audit-weak-stale fixed')
