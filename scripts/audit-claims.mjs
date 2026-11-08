#!/usr/bin/env node
/**
 * claim 规则标注的只读体检：跑 classifyClaim，看会标出多少 pending/done。
 * 只读，不写 memory_claims。
 * 用法：node scripts/audit-claims.mjs [--db <path>] [--agent 小汐] [--limit 5000] [--show 15]
 */
import { DatabaseSync } from 'node:sqlite'
import { classifyClaim } from '../src/modules/claim_state.js'
import { dbPath as defaultDbPath } from '../src/paths.js'

function arg(name, def) { const i = process.argv.indexOf('--' + name); return i >= 0 ? process.argv[i + 1] : def }
const dbPath = arg('db', defaultDbPath())
const agentName = arg('agent', '小汐')
const limit = Number(arg('limit', '5000')) || 5000
const show = Number(arg('show', '15')) || 15

const db = new DatabaseSync(dbPath, { readOnly: true })
const aid = db.prepare('SELECT id FROM agents WHERE name=?').get(agentName).id
const rows = db.prepare(`SELECT id, type, text, created_at FROM memory_items
  WHERE agent_id=? AND status='active' AND invalid_at IS NULL
  ORDER BY created_at DESC LIMIT ?`).all(aid, limit)

const tally = { pending: 0, done: 0, na: 0 }
const pending = []
const done = []
for (const r of rows) {
  const c = classifyClaim(r.text)
  tally[c.state]++
  if (c.state === 'pending') pending.push(r)
  else if (c.state === 'done') done.push(r)
}

const pct = (n) => (rows.length ? Math.round((n / rows.length) * 1000) / 10 : 0)
console.log('== claim 规则标注（只读）==')
console.log('意识体:', agentName, '| 库:', dbPath)
console.log('活跃记忆:', rows.length)
console.log('  pending:', tally.pending, '(' + pct(tally.pending) + '%)')
console.log('  done   :', tally.done, '(' + pct(tally.done) + '%)')
console.log('  na     :', tally.na, '(' + pct(tally.na) + '%)')
console.log('')
console.log('-- pending 样本（' + Math.min(show, pending.length) + ' 条，人工看准不准）--')
for (const r of pending.slice(0, show)) {
  console.log(' ', String(r.created_at).slice(0, 16), r.type, '|', String(r.text).replace(/\s+/g, ' ').slice(0, 80))
}
console.log('')
console.log('-- done 样本（' + Math.min(show, done.length) + ' 条）--')
for (const r of done.slice(0, Math.min(show, done.length))) {
  console.log(' ', String(r.created_at).slice(0, 16), r.type, '|', String(r.text).replace(/\s+/g, ' ').slice(0, 80))
}
db.close()
