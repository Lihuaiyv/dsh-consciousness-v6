import fs from 'node:fs'
const p = 'test/pair-judge.test.mjs'
let s = fs.readFileSync(p, 'utf8')
const a = "    const w2 = makeWorld()\n    try {\n      const g = makePair(w2, { oldText: '用户喜欢猫'"
const b = "    const w2 = makeWorld()\n    // P2 之后新库一建就带表；这里手动删掉，模拟「老库还没升级 / 表被删」的容错路径。\n    w2.db.exec('DROP TABLE IF EXISTS memory_pair_judge')\n    try {\n      const g = makePair(w2, { oldText: '用户喜欢猫'"
if (!s.includes(a)) { console.error('anchor not found'); process.exit(1) }
fs.writeFileSync(p, s.replace(a, b), 'utf8')
console.log('patched')
