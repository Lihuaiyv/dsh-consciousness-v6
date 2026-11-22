#!/usr/bin/env node
/**
 * 帧验收 · 外部判官（材料取原话）· 2026-11-15 v2
 *
 * 材料不放摘要：帧只当索引（turn_id），原文去 fragments 取（碎片表＝原文表，逐字、带 seq）。
 * 判的只有一件事：这一轮有没有从上一轮长出来？接 / 断 / 无关。
 * 只读：不写库、不动帧。
 *
 * 用法：node scripts/judge-frame-continuity-v2.mjs [--n 8] [--model qwen3:14b]
 *
 * 2026-11-22：判官改成走插件唯一通道（scripts/lib/exp-call.mjs → /local/exp）。
 * 直连 11434 会绕过队列、挤掉常驻 14B；现在换模型由通道负责卸和热回来。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { FRAMES } from '../src/modules/frame_chain.js'
import { expCall } from './lib/exp-call.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DB = path.resolve(HERE, '..', '..', 'runtime', 'consciousness', 'app.db')

const argv = process.argv
const num = (k, d) => {
  const i = argv.indexOf(k)
  return i >= 0 ? Number(argv[i + 1]) || d : d
}
const N = num('--n', 8)
const MODEL = argv.includes('--model') ? argv[argv.indexOf('--model') + 1] : 'qwen3:14b'

const db = new DatabaseSync(DB, { readOnly: true })
const fragStmt = db.prepare('SELECT role, text, seq FROM fragments WHERE turn_id=? ORDER BY seq')

/** 一轮的原文：按 turn_id 取碎片，按 seq 拼回去，一字不改。 */
function turnText(turnId) {
  if (!turnId) return null
  const rows = fragStmt.all(turnId)
  if (!rows.length) return null
  const user = rows.filter((r) => r.role === 'user').map((r) => r.text).join('')
  const agent = rows.filter((r) => r.role !== 'user').map((r) => r.text).join('')
  return { user, agent }
}

const rows = []
for (const line of fs.readFileSync(FRAMES, 'utf8').split('\n')) {
  if (!line.trim()) continue
  try { rows.push(JSON.parse(line)) } catch { /* 坏行跳过 */ }
}

const key = (r) => (r.conv || '') + '\u0000' + (r.agent || '')
// 只挑「已经有 turn_id 指针」的链——老帧没指针，取不到原文，跳过不编。
const counts = new Map()
for (const r of rows) if (r.conv && r.turn_id) counts.set(key(r), (counts.get(key(r)) || 0) + 1)
const [best] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] || []
if (!best) { console.log('没有帧'); process.exit(1) }
const [CONV, AGENT] = best.split('\u0000')
const chain = rows.filter((r) => (r.conv || '') === CONV && (r.agent || '') === AGENT)
const ordered = chain.some((r) => typeof r.k === 'number')
  ? chain.filter((r) => typeof r.k === 'number').sort((a, b) => a.k - b.k)
  : chain

const pairs = []
for (let i = 1; i < ordered.length; i++) {
  const prev = ordered[i - 1]
  const cur = ordered[i]
  if (!prev.turn_id || !cur.turn_id) continue // 老帧没有指针，跳过（不编）
  const a = turnText(prev.turn_id)
  const b = turnText(cur.turn_id)
  if (!a || !b) continue
  pairs.push({ a, b })
}
const sample = pairs.slice(-N)

const RUBRIC = `你在判断一段对话的「因果连续」。
上一轮我（助手）最后说的是 A。
这一轮用户说 B，我回 C。
问题：这一轮是不是**因为**上一轮而成立、接着往前走？
只能回三选一开头：接 / 断 / 无关，然后一句理由（不超过 30 字）。
不要客套。`

async function judge(p) {
  const text = `A: ${p.a.agent.slice(0, 400)}\nB: ${p.b.user.slice(0, 300)}\nC: ${p.b.agent.slice(0, 400)}`
  const r = await expCall({ system: RUBRIC, text, maxTokens: 60, model: MODEL, format: '', label: 'judge:frame2' })
  return String(r.text || '').trim().replace(/\s+/g, ' ')
}

const tally = { 接: 0, 断: 0, 无关: 0, 其他: 0 }
console.log(`判官 v2（原文）：${MODEL} ／ 链 ${CONV.slice(-12)} ／ 可用对 ${pairs.length}，取 ${sample.length}`)
for (const [i, p] of sample.entries()) {
  let out = ''
  try { out = await judge(p) } catch (e) { out = '调用失败: ' + e.message }
  const head = ['接', '断', '无关'].find((w) => out.startsWith(w)) || '其他'
  tally[head]++
  console.log(`\n[${i + 1}] ${head} — ${out.slice(0, 60)}`)
  console.log(`    A(我说)：${p.a.agent.slice(0, 60).replace(/\n/g, ' ')}`)
  console.log(`    B(你说)：${p.b.user.slice(0, 60).replace(/\n/g, ' ')}`)
  console.log(`    C(我回)：${p.b.agent.slice(0, 60).replace(/\n/g, ' ')}`)
}
console.log('\n统计：', JSON.stringify(tally))
