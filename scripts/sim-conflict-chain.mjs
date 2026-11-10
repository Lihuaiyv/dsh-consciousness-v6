/**
 * 整体模拟：拿 2026-11-09 那批「真冲突」（40 对，人工标过）当输入，
 * 走一遍完整链路（写入 → 判定 → 开卡/取代/挂起），对比改造前后。
 *
 * 判官用「人工标准答案」代替模型输出，这样比较的是**流程**，不是模型今天的心情。
 * 两轮：
 *   旧链路 = memory.conflict.judge=off（直接开卡 + 作废旧条 + 排问句）
 *   新链路 = 默认（先落 pending → 判官 → 取代/补充/无关/挂起）
 *
 * 用法：node scripts/sim-conflict-chain.mjs
 */
import fs from 'node:fs'
import { makeWorld } from '../test/eval-persona/setup.mjs'
import { addMemory, flushConflictJudges, rejudgePendingConflicts } from '../src/modules/memory.js'
import { applyWrite, flushJudges } from '../src/modules/gate.js'
import { writeParam } from '../src/kernel.js'

const GOLD = 'docs/冲突回放-2026-11-09-标注.json'
const gold = JSON.parse(fs.readFileSync(GOLD, 'utf8')).pairs
const MAP = { 改口: '取代', 补充: '补充', 无关: '无关', 重复: '补充', 矛盾: '取代' }

const tally = (o, k) => { o[k] = (o[k] || 0) + 1 }

async function runOne(pair, { judgeOff }) {
  if (!pair.a || !pair.b || !pair.a.text || !pair.b.text) return null
  const w = makeWorld()
  try {
    if (judgeOff) writeParam(w.db, w.aid, 'memory.conflict.judge', 'off')
    const verdict = MAP[pair.label] || null
    const old = addMemory(w.db, w.aid, { text: pair.a.text, type: 'fact', source: 'sim', skipConflict: true })
    w.db.prepare('UPDATE memory_items SET created_at=? WHERE id=?').run(pair.a.at || new Date(Date.now() - 600000).toISOString(), old.id)
    const write = (cand) => addMemory(w.db, w.aid, {
      text: cand.text, type: 'fact', source: 'sim', skipConflict: true,
      complete: verdict ? (async () => verdict) : undefined,
    })
    const out = applyWrite(w.db, w.aid, { text: pair.b.text }, write, {
      complete: verdict ? (async () => verdict) : undefined,
    })
    await flushJudges()
    await flushConflictJudges()
    // 白天没结论的，模拟夜里再问一遍（还是给同一个标准答案）
    await rejudgePendingConflicts(w.db, w.aid, { complete: verdict ? (async () => verdict) : null })
    const rows = w.db.prepare('SELECT * FROM conflicts WHERE agent_id=?').all(w.aid)
    const asks = w.db.prepare("SELECT * FROM proactive WHERE agent_id=? AND reason LIKE 'conflict:%'").all(w.aid)
    const inv = w.db.prepare('SELECT invalid_at FROM memory_items WHERE id=?').get(old.id).invalid_at
    return {
      action: out.action,
      open: rows.filter((r) => r.state === 'open').length,
      pending: rows.filter((r) => r.state === 'pending').length,
      resolved: rows.filter((r) => r.state === 'resolved').length,
      superseded: rows.filter((r) => r.resolution === 'supersede').length,
      asks: asks.length,
      invalidated: !!inv,
      cards: rows.length,
    }
  } finally { w.close() }
}

async function runCycle(judgeOff) {
  const acc = { cards: 0, open: 0, pending: 0, resolved: 0, superseded: 0, asks: 0, invalidated: 0, detected: 0 }
  const byLabel = {}
  for (const p of gold) {
    const r = await runOne(p, { judgeOff })
    if (!r) continue
    if (r.action === 'conflict') acc.detected++
    for (const k of Object.keys(acc)) if (k !== 'detected' && r[k]) acc[k] += r[k]
    tally(byLabel, p.label)
  }
  return { acc, byLabel }
}

const before = await runCycle(true)
const after = await runCycle(false)

const line = (name, a, b) => `${name.padEnd(14)} ${String(a).padStart(6)} → ${String(b).padStart(6)}`
console.log('\n== 40 对真冲突 · 全链路模拟 ==')
console.log(line('字面判成冲突', before.acc.detected, after.acc.detected))
console.log(line('产生的卡', before.acc.cards, after.acc.cards))
console.log(line('其中 open', before.acc.open, after.acc.open))
console.log(line('其中 pending', before.acc.pending, after.acc.pending))
console.log(line('自动结案', before.acc.resolved, after.acc.resolved))
console.log(line('判成取代', before.acc.superseded, after.acc.superseded))
console.log(line('作废旧条', before.acc.invalidated, after.acc.invalidated))
console.log(line('排出的问句', before.acc.asks, after.acc.asks))
