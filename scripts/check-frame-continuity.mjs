#!/usr/bin/env node
/**
 * 帧验收（只读）：接没接上。
 *
 * 判据不进提示词（20 轮验收的教训），只在这里算给外面看。
 * 代理量：相邻两帧，上一帧的 anchor 与这一帧的 focus 的**字二元组 Jaccard 重叠**。
 *   高＝字面上接住了上一句；低＝像是另起一段。
 * 它测的是「像不像」，不是「理由通不通」——这一点必须记在结论里。
 *
 * 用法：node scripts/check-frame-continuity.mjs
 */
import fs from 'node:fs'
import { FRAMES } from '../src/modules/frame_chain.js'

function bigrams(s) {
  const t = String(s || '').replace(/[\s\p{P}\p{S}]/gu, '')
  const out = new Set()
  for (let i = 0; i + 1 < t.length; i++) out.add(t.slice(i, i + 2))
  return out
}

function jaccard(a, b) {
  if (!a.size || !b.size) return null
  let inter = 0
  for (const x of a) if (b.has(x)) inter++
  return inter / (a.size + b.size - inter)
}

function pct(xs, p) {
  if (!xs.length) return null
  const a = [...xs].sort((x, y) => x - y)
  return a[Math.min(a.length - 1, Math.floor((a.length - 1) * p))]
}

let buf = ''
try { buf = fs.readFileSync(FRAMES, 'utf8') } catch {
  console.log('没有帧文件：' + FRAMES)
  process.exit(1)
}

const groups = new Map()
for (const line of buf.split('\n')) {
  if (!line.trim()) continue
  let o
  try { o = JSON.parse(line) } catch { continue }
  if (!o.conv) continue
  const key = o.conv + '\u0000' + (o.agent || '')
  if (!groups.has(key)) groups.set(key, [])
  groups.get(key).push(o)
}

const scores = []
const worst = []
for (const rows of groups.values()) {
  // 有 k 的按 k 排；没 k 的按文件顺序（原样）
  const ordered = rows.some((r) => typeof r.k === 'number')
    ? rows.filter((r) => typeof r.k === 'number').sort((a, b) => a.k - b.k)
    : rows
  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1]
    const cur = ordered[i]
    const j = jaccard(bigrams(prev.anchor), bigrams(cur.focus))
    if (j == null) continue
    scores.push(j)
    worst.push({ j, prev: String(prev.anchor || '').slice(0, 40), cur: String(cur.focus || '').slice(0, 40) })
  }
}
worst.sort((a, b) => a.j - b.j)

console.log(`帧验收（只读）：${groups.size} 条链 / 相邻对 ${scores.length} 对`)
if (scores.length) {
  const f = (x) => (x == null ? '—' : x.toFixed(3))
  console.log(`  上一帧 anchor ↔ 这一帧 focus 的重叠：p50 ${f(pct(scores, 0.5))}  p90 ${f(pct(scores, 0.9))}  max ${f(Math.max(...scores))}`)
  console.log(`  低于 0.10 的 ${scores.filter((x) => x < 0.1).length} 对（字面上几乎没接住）`)
  console.log('')
  console.log('最没接住的 3 对（上：我上一句 / 下：这一轮在处理的）')
  for (const w of worst.slice(0, 3)) {
    console.log(`  ${w.j.toFixed(3)}  「${w.prev}」→「${w.cur}」`)
  }
}
console.log('')
console.log('注意：这是代理指标——测「字面像不像」，不测「理由通不通」。')
