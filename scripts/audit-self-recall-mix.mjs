/**
 * 读口来源体检（只读，2026-11-15）
 *
 * 拿最近的真实碎片当「这一句」，看候选池三路谁在场、谁赢、多少轮会出。
 * 只读真库：pickOne 不写库；开环走 pendingLoops（只读），pulse 受 surface.direct 控制。
 *
 *   node scripts/audit-self-recall-mix.mjs
 */
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { collectCandidates, pickOne } from '../src/modules/candidate_pool.js'

const DB = process.argv[2] || path.resolve('..', 'runtime', 'consciousness', 'app.db')
const N = Number(process.argv[3]) || 50
const db = new DatabaseSync(DB, { readOnly: true })
const AID = 'agt_3977d80f17'

const rows = db.prepare(`SELECT text FROM fragments
  WHERE agent_id=? AND role='user' AND length(text) BETWEEN 8 AND 50
  ORDER BY created_at DESC LIMIT 200`).all(AID)
const qs = []
for (const r of rows) {
  const t = String(r.text || '').trim()
  if (t && !qs.includes(t)) qs.push(t)
  if (qs.length >= N) break
}

const has = {}
const wins = {}
const winLines = []
for (const q of qs) {
  const pool = collectCandidates(db, AID, { query: q, limit: 3 })
  for (const s of new Set(pool.map((c) => c.source))) has[s] = (has[s] || 0) + 1
  const one = pickOne(pool)
  const s = one ? one.source : 'none'
  wins[s] = (wins[s] || 0) + 1
  if (one && winLines.length < 8) winLines.push({ q: q.slice(0, 16), src: one.source, text: String(one.text || '').slice(0, 24) })
}
console.log(JSON.stringify({ queries: qs.length, has, wins }, null, 0))
console.log(JSON.stringify(winLines))
db.close()
