import fs from 'node:fs'
const p = 'scripts/judge-shadow-report.mjs'
let lines = fs.readFileSync(p, 'utf8').split('\n')
// 先插靠后的，行号不漂移
const out1 = "  console.log('  判定耗时(ms): avg=' + msAvg + ' p50=' + msP50 + ' max=' + msMax + ' | 超时=' + timeoutHits + ' 次')"
lines.splice(62, 0, out1)
const block = [
  '',
  '// 真模型耗时：只有门控事件里带 ms（缓存命中是 0，不计入）。',
  '// 没有这组数，到时候没法判断「是不是 3s 超时边缘」。',
  "const gateEvents = events.filter((e) => e.type === 'memory.judge.gate')",
  'const msList = []',
  'let timeoutHits = 0',
  'for (const e of gateEvents) {',
  '  try {',
  '    const p = JSON.parse(e.payload)',
  '    const n = Number(p.ms)',
  '    if (Number.isFinite(n) && n > 0) msList.push(n)',
  "    if (String(p.reason || '').includes('timeout')) timeoutHits++",
  '  } catch { /* 坏 payload 跳过 */ }',
  '}',
  'msList.sort((a, b) => a - b)',
  'const msAvg = msList.length ? Math.round(msList.reduce((a, b) => a + b, 0) / msList.length) : 0',
  'const msP50 = msList.length ? msList[Math.floor(msList.length / 2)] : 0',
  'const msMax = msList.length ? msList[msList.length - 1] : 0',
]
lines.splice(48, 0, ...block)
fs.writeFileSync(p, lines.join('\n'), 'utf8')
console.log('patched')
