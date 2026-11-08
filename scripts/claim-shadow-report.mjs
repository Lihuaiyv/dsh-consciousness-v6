#!/usr/bin/env node
/**
 * claim / 窄门 shadow 报告（只读，v3）。
 *
 * 看三样：
 *   1) memory_claims 分布（pending / done / stale）；
 *   2) loop 关闭联动事件（loop.closed_memory）；
 *   3) 最近 done/stale 的样本与证据，人工抽查；
 *   4) 判定耗时（memory.judge.pick / memory.judge.gate）。
 *
 * 用法：node scripts/claim-shadow-report.mjs [--db <path>] [--agent 小汐] [--sample 10]
 */
import { DatabaseSync } from 'node:sqlite'
import { dbPath as defaultDbPath } from '../src/paths.js'

function arg(name, def) { const i = process.argv.indexOf('--' + name); return i >= 0 ? process.argv[i + 1] : def }
const dbPath = arg('db', defaultDbPath())
const agentName = arg('agent', '小汐')
const sampleN = Number(arg('sample', '10')) || 10

const db = new DatabaseSync(dbPath, { readOnly: true })
const aid = db.prepare('SELECT id FROM agents WHERE name=?').get(agentName).id
const cnt = (sql, ...a) => { try { return Number(db.prepare(sql).get(...a).n || 0) } catch { return 0 } }

const claims = (() => { try { return db.prepare('SELECT state, COUNT(*) n FROM memory_claims WHERE agent_id=? GROUP BY state').all(aid) } catch { return [] } })()
const claimMap = {}
for (const r of claims) claimMap[r.state] = Number(r.n)

const loopLinks = cnt("SELECT COUNT(*) n FROM events WHERE agent_id=? AND type='loop.closed_memory'", aid)
const picks = cnt("SELECT COUNT(*) n FROM events WHERE agent_id=? AND type='memory.judge.pick'", aid)

// 耗时
const evs = (() => { try { return db.prepare("SELECT type, payload FROM events WHERE agent_id=? AND type IN ('memory.judge.pick','memory.judge.gate') ORDER BY created_at DESC LIMIT 200").all(aid) } catch { return [] } })()
const msBy = { pick: [], gate: [] }
for (const e of evs) {
  try { const p = JSON.parse(e.payload); const n = Number(p.ms); if (Number.isFinite(n) && n > 0) msBy[e.type === 'memory.judge.pick' ? 'pick' : 'gate'].push(n) } catch { /* ignore */ }
}
const stat = (arr) => {
  if (!arr.length) return 'n=0'
  const s = [...arr].sort((a, b) => a - b)
  const avg = Math.round(s.reduce((a, b) => a + b, 0) / s.length)
  return 'n=' + s.length + ' avg=' + avg + ' p50=' + s[Math.floor(s.length / 2)] + ' max=' + s[s.length - 1]
}

console.log('== v3 claim / 窄门 shadow 报告 ==')
console.log('意识体:', agentName, '| 库:', dbPath)
console.log('')
console.log('-- claim 分布 --')
console.log('  pending:', claimMap.pending || 0, '| done:', claimMap.done || 0, '| stale:', claimMap.stale || 0)
console.log('')
console.log('-- 联动与判定 --')
console.log('  loop.closed_memory:', loopLinks)
console.log('  memory.judge.pick:', picks)
console.log('  耗时 pick:', stat(msBy.pick))
console.log('  耗时 gate:', stat(msBy.gate))
console.log('')
console.log('-- 最近 done / stale 样本 --')
let rows = []
try {
  rows = db.prepare(`SELECT c.state, c.checked_at, c.evidence_id, c.via, m.text
    FROM memory_claims c JOIN memory_items m ON m.id=c.memory_id
    WHERE c.agent_id=? AND c.state IN ('done','stale')
    ORDER BY c.checked_at DESC LIMIT ?`).all(aid, sampleN)
} catch { rows = [] }
for (const r of rows) {
  console.log(' ', r.state, '|', String(r.checked_at || '').slice(0, 16), '|', r.via, '|', String(r.text).replace(/\s+/g, ' ').slice(0, 70))
}
if (!rows.length) console.log('  （还没有 done/stale：claim.enable 还是 off，或夜巡还没跑）')

console.log('')
console.log('-- 参数 --')
try {
  for (const r of db.prepare("SELECT key, value FROM agent_params WHERE agent_id=? AND (key LIKE 'memory.claim%' OR key LIKE 'memory.judge%') ORDER BY key").all(aid)) {
    console.log(' ', r.key, '=', r.value)
  }
} catch { /* ignore */ }
db.close()
