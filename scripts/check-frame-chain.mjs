#!/usr/bin/env node
/**
 * 帧链体检（只读）：每一条 (会话, agent) 链上，「不知道从哪来」的地方有多少。
 * 判据不看时间（夯实：时刻来自逻辑，不来自时间）；时间戳只用来排序和附注。
 * 用法：node scripts/check-frame-chain.mjs
 */
import fs from 'node:fs'
import { breaks, reasonText, FRAMES } from '../src/modules/frame_chain.js'

let buf = ''
try { buf = fs.readFileSync(FRAMES, 'utf8') } catch {
  console.log('没有帧文件：' + FRAMES)
  process.exit(1)
}

const keys = new Set()
for (const line of buf.split('\n')) {
  if (!line.trim()) continue
  let o
  try { o = JSON.parse(line) } catch { continue }
  if (!o.conv) continue
  keys.add(o.conv + '\u0000' + (o.agent || ''))
}

let totalFrames = 0
let totalLegacy = 0
const tally = { 'no-parent': 0, 'lost-parent': 0, 'no-in': 0 }
const rows = []
for (const k of keys) {
  const [conv, agent] = k.split('\u0000')
  const r = breaks({ conv, agent: agent || null })
  totalFrames += r.frames
  totalLegacy += r.legacy
  for (const b of r.broken) tally[b.reason] = (tally[b.reason] || 0) + 1
  rows.push({ conv, frames: r.frames, broken: r.broken.length, reasons: r.broken })
}

rows.sort((a, b) => b.broken - a.broken || b.frames - a.frames)
const totalBroken = rows.reduce((n, r) => n + r.broken, 0)
console.log(`帧链体检：${rows.length} 条链 / ${totalFrames} 帧 / 接不上 ${totalBroken} 处（其中 ${totalLegacy} 帧是老帧、in 键还没回填，不算断）`)
console.log(`  没接上上一格 ${tally['no-parent']}｜上一格找不到 ${tally['lost-parent']}｜没记喂了什么 ${tally['no-in']}`)
console.log('')
console.log('会话(尾号)  帧   接不上   因为')
for (const r of rows.slice(0, 12)) {
  const why = [...new Set(r.reasons.map((b) => reasonText(b.reason)))].join('、') || '—'
  console.log(String(r.conv.slice(-12)).padEnd(12), String(r.frames).padStart(4), String(r.broken).padStart(6), '  ' + why)
}
