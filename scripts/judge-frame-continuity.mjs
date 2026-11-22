#!/usr/bin/env node
/**
 * 帧验收 · 外部判官（本地 ollama，只读）
 *
 * 判的东西：这一轮是不是接着上一轮在推进（因果连续），还是硬拐/无关。
 * 判官不是我——是本地另一个模型，避免自评。
 * 只回三个词：接 / 断 / 无关，加一句理由。
 *
 * 用法：node scripts/judge-frame-continuity.mjs [--n 8] [--model '']
 *
 * 2026-11-22：判官调用改成走插件唯一通道（scripts/lib/exp-call.mjs → /local/exp），
 * 不再直连 11434。不传 --model 就用常驻 14B，不换模型、不重载。
 */
import fs from 'node:fs'
import { FRAMES } from '../src/modules/frame_chain.js'
import { expCall } from './lib/exp-call.mjs'

const argv = process.argv
const num = (k, d) => {
  const i = argv.indexOf(k)
  return i >= 0 ? Number(argv[i + 1]) || d : d
}
const N = num('--n', 8)
const MODEL = argv.includes('--model') ? (argv[argv.indexOf('--model') + 1] || '') : ''

const buf = fs.readFileSync(FRAMES, 'utf8')
const rows = []
for (const line of buf.split('\n')) {
  if (!line.trim()) continue
  try { rows.push(JSON.parse(line)) } catch { /* 跳过坏行 */ }
}

// 采样只取「最近那条主链」：最后一个有 conv 的帧所在的会话 + 同一个 agent。
// 不按 agent 过滤会把子代理的提示词混进来（实测过），所以两层都要卡。
// 采样取「最长的链」（同 conv + 同 agent）：子代理、零散会话都会被自然排除。
const chainKey = (r) => (r.conv || '') + '\u0000' + (r.agent || '')
const counts = new Map()
for (const r of rows) {
  if (!r.conv) continue
  counts.set(chainKey(r), (counts.get(chainKey(r)) || 0) + 1)
}
if (!counts.size) { console.log('没有帧'); process.exit(1) }
const [bestKey] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]
const [CONV, AGENT] = bestKey.split('\u0000')
const agentKey = AGENT || null
const chainRows = rows.filter((r) => (r.conv || null) === CONV && (r.agent || null) === agentKey)
const ordered = chainRows.some((r) => typeof r.k === 'number')
  ? chainRows.filter((r) => typeof r.k === 'number').sort((a, b) => a.k - b.k)
  : chainRows
const pairs = []
for (let i = 1; i < ordered.length; i++) {
  const cur = ordered[i]
  if (!cur.in && !cur.focus) continue
  pairs.push({ prev: ordered[i - 1], cur })
}
console.log(`采样链：${CONV.slice(-12)} ／ agent ${AGENT} ／ ${pairs.length} 对`)
const sample = pairs.slice(-N)

const RUBRIC = `你在判断一段对话的「因果连续」。
上一轮我（助手）最后说的是 A。
这一轮用户说 B，我回 C。
问题：这一轮是不是**因为**上一轮而成立、接着往前走？
只能回三选一开头：接 / 断 / 无关，然后一句理由（不超过 30 字）。
不要客套，不要解释规则。`

async function judge(p) {
  const text = `A: ${String(p.prev.anchor || '').slice(0, 120)}\nB: ${String(p.cur.in || p.cur.focus || '').slice(0, 120)}\nC: ${String(p.cur.anchor || '').slice(0, 120)}`
  const r = await expCall({ system: RUBRIC, text, maxTokens: 60, model: MODEL, format: '', label: 'judge:frame' })
  return String(r.text || '').trim().replace(/\s+/g, ' ')
}

const tally = { 接: 0, 断: 0, 无关: 0, 其他: 0 }
console.log(`判官：${MODEL || '常驻 14B（不换模型）'} ／ 样本 ${sample.length} 对（最近）`)
for (const [i, p] of sample.entries()) {
  let out = ''
  try { out = await judge(p) } catch (e) { out = '调用失败: ' + e.message }
  const head = ['接', '断', '无关'].find((w) => out.startsWith(w)) || '其他'
  tally[head]++
  console.log(`\n[${i + 1}] ${head}  ${out.slice(0, 60)}`)
  console.log(`    上一轮我说：${String(p.prev.anchor || '').slice(0, 50)}`)
  console.log(`    这轮用户说：${String(p.cur.in || p.cur.focus || '').slice(0, 50)}`)
}
console.log('\n统计：', JSON.stringify(tally))
console.log('提醒：14B 判别力有限，结论只当粗筛；抽 2 对人工复核。')
