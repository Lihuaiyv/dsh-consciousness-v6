import fs from 'node:fs'
const p = 'scripts/judge-shadow-report.mjs'
let s = fs.readFileSync(p, 'utf8')
const anchor = "const alreadyApplied = rows.filter((r) => Number(r.applied)).length"
const add = anchor + `

// 真模型耗时：只有门控事件里带 ms（缓存命中是 0，不计入）。
// 没有这组数，到时候没法判断「是不是 3s 超时边缘」。
const gateEvents = events.filter((e) => e.type === 'memory.judge.gate')
const msList = []
let timeoutHits = 0
for (const e of gateEvents) {
  try {
    const p = JSON.parse(e.payload)
    const n = Number(p.ms)
    if (Number.isFinite(n) && n > 0) msList.push(n)
    if (String(p.reason || '').includes('timeout')) timeoutHits++
  } catch { /* 坏 payload 跳过 */ }
}
msList.sort((a, b) => a - b)
const msAvg = msList.length ? Math.round(msList.reduce((a, b) => a + b, 0) / msList.length) : 0
const msP50 = msList.length ? msList[Math.floor(msList.length / 2)] : 0
const msMax = msList.length ? msList[msList.length - 1] : 0`
if (!s.includes(anchor)) { console.error('anchor1 not found'); process.exit(1) }
s = s.replace(anchor, add)
const outAnchor = "  console.log('  memory.judge.superseded:', one(\"SELECT COUNT(*) n FROM events WHERE agent_id=? AND type='memory.judge.superseded'\", aid))"
const outAdd = outAnchor + "\n  console.log('  判定耗时(ms): avg=' + msAvg + ' p50=' + msP50 + ' max=' + msMax + ' | 超时=' + timeoutHits + ' 次')"
if (!s.includes(outAnchor)) { console.error('anchor2 not found'); process.exit(1) }
s = s.replace(outAnchor, outAdd)
fs.writeFileSync(p, s, 'utf8')
console.log('report patched')
