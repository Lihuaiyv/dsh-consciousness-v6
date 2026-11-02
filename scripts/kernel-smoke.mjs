/**
 * 线上库副本的冒烟：拿真实数据跑一遍新增的读口与结算，不改线上库。
 * 用法：node scripts/kernel-smoke.mjs <dbCopy>
 */
import { openDb } from '../src/db.js'
import { scorecard, liveGate } from '../src/modules/sangguan/score.js'
import { checkDue } from '../src/modules/sangguan/practice.js'
import { candidateClaims, shadowLog } from '../src/modules/sangguan/violate.js'
import { injectView } from '../src/modules/sangguan/inject.js'

const p = process.argv[2]
if (!p) { console.error('用法：node scripts/kernel-smoke.mjs <dbCopy>'); process.exit(2) }
const db = openDb(p)
const now = new Date().toISOString()
const out = []
for (const a of db.prepare("SELECT id,name FROM agents WHERE status='active'").all()) {
  let row = { id: a.id, name: a.name }
  try { row.score = scorecard(db, a.id, { now }) } catch (e) { row.score_err = String(e.message) }
  try { row.gate = liveGate(db, a.id, { now }).reasons } catch (e) { row.gate_err = String(e.message) }
  try { row.candidates = candidateClaims(db, a.id).length } catch (e) { row.cand_err = String(e.message) }
  try { row.shadow = shadowLog(db, a.id).length } catch { row.shadow = 0 }
  try { row.inject = injectView(db, a.id, { now, cache: false }).tokens } catch (e) { row.inject_err = String(e.message) }
  out.push(row)
}
let vals = 'no-table'
try { vals = db.prepare('SELECT COUNT(*) n FROM persona_values').get().n } catch { vals = 'no-table' }
let seeds = 0
try {
  seeds = db.prepare(`SELECT COUNT(*) n FROM claim_proj_claim p JOIN persona_claims c ON c.id=p.id
    WHERE p.layer='V' AND c.origin='seed' AND p.status NOT IN ('withdrawn','superseded','falsified','sublated','demoted')`).get().n
} catch { seeds = 0 }
const due = {}
for (const a of db.prepare("SELECT id FROM agents WHERE status='active'").all()) {
  try { due[a.id] = (await checkDue(db, a.id, now, { force: true })).did.length } catch (e) { due[a.id] = String(e.message) }
}
console.log(JSON.stringify({ at: now, persona_values_rows: vals, v_seed_rows: seeds, due_settled: due, agents: out }, null, 2))
db.close()
