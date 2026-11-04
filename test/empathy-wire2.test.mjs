/**
 * 第二步接线：v2 真的被 affect 用上了，不是只在纯函数里对。
 * 运行：node test/empathy-wire2.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, now } from '../src/db.js'
import { attachDb } from '../src/algo/index.js'
import { setParam } from '../src/kernel.js'
import { seedAffect, appraise } from '../src/modules/affect.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-ewire2-'))
const db = openDb(path.join(dir, 'app.db'))
attachDb(db)
const aid = 'agt_ewire2'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid, '共情接线', 'daily', 'active', now())
seedAffect(db, aid)

const LABELS = ['joy', 'peaceful', 'curious', 'calm', 'confused', 'lost', 'irritated', 'frustrated']
const VERY_NEG = { joy: 0.01, peaceful: 0.01, curious: 0.02, calm: 0.03, confused: 0.05, lost: 0.15, irritated: 0.35, frustrated: 0.6 }
const last = () => db.prepare('SELECT * FROM affect_events WHERE agent_id=? ORDER BY rowid DESC LIMIT 1').get(aid)

const hint = (label, userScores) => ({
  label, kind: 'eval', polarity: -0.3,
  goal_relevance: 0.5, goal_congruence: -0.2,
  certainty: 0.8, novelty: 0.2, source: 'model',
  user_label: 'frustrated', user_scores: userScores,
  why: '在说自己的事', target: 'other',
})

/* v1：老行为，被带下去 */
await appraise(db, aid, '我有点累', { labels: LABELS, closeness: 0.9, hint: hint('lost', VERY_NEG) })
const v1row = last()
console.log('v1 读到你:', v1row.e_user_read, '被带:', v1row.empathy_share)
check('v1 时被带是负的（跟着沉）', Number(v1row.empathy_share) < 0, { share: v1row.empathy_share })

/* 换成 v2。把快情绪放到「略微低但站得住」（-0.05）——
   完全 0 的时候扶起来也是 0，看不出反向；-0.05 才能看出那一点点向上的力。 */
setParam(db, aid, 'affect.empathy.mode', { value: 'v2' })
db.prepare('UPDATE affect_v3 SET fast=?, fast_at=? WHERE agent_id=?').run(-0.05, new Date().toISOString(), aid)
const fastBefore = db.prepare('SELECT fast FROM affect_v3 WHERE agent_id=?').get(aid).fast
await appraise(db, aid, '我又有点累', { labels: LABELS, closeness: 0.9, hint: hint('lost', VERY_NEG) })
const v2row = last()
console.log('v2 前快情绪:', fastBefore, '读到你:', v2row.e_user_read, '被带:', v2row.empathy_share)
check('v2 被用上了（读数一样）', Math.abs(Number(v2row.e_user_read) - Number(v1row.e_user_read)) < 0.05,
  { v1: v1row.e_user_read, v2: v2row.e_user_read })
check('v2 站得住时被带得更少', Number(v2row.empathy_share) < 0
  && Math.abs(Number(v2row.empathy_share)) < Math.abs(Number(v1row.empathy_share)) * 0.85,
  { v1: v1row.empathy_share, v2: v2row.empathy_share, fastBefore })
check('但也没有完全无感（不是 0）', Math.abs(Number(v2row.empathy_share)) > 0.001, { v2: v2row.empathy_share })

/* 切回 v1，应当恢复老行为 */
setParam(db, aid, 'affect.empathy.mode', { value: 'v1' })
db.prepare('UPDATE affect_v3 SET fast=0, fast_at=? WHERE agent_id=?').run(new Date().toISOString(), aid)
await appraise(db, aid, '第三次有点累', { labels: LABELS, closeness: 0.9, hint: hint('lost', VERY_NEG) })
const back = last()
check('切回 v1 就又跟着沉了', Number(back.empathy_share) < 0, { share: back.empathy_share })

try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
