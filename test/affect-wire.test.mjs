/**
 * 情绪 v3 接线测试：证明 appraise 真的写了 affect_v3 / affect_baseline，
 * 而不是只在单元测试里跑公式。
 * 运行：node test/affect-wire.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, now } from '../src/db.js'
import { attachDb } from '../src/algo/index.js'
import { seedAffect, appraise, getAffect, baselineNow, affectTrend } from '../src/modules/affect.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)) }
}
const finite = (x) => Number.isFinite(x)

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-wire-'))
const db = openDb(path.join(dir, 'app.db'))
attachDb(db)
const aid = 'agt_wire'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid, '接线', 'daily', 'active', now())
seedAffect(db, aid)

const LABELS = ['joy', 'peaceful', 'curious', 'calm', 'confused', 'lost', 'irritated', 'frustrated']
const H = 3600000

function hintOf(label, userLabel, userScores) {
  return {
    label,
    goal_relevance: 0.8,
    goal_congruence: label === 'joy' ? 0.6 : label === 'calm' ? 0 : -0.6,
    agency: 'other',
    certainty: 0.7,
    novelty: 0.3,
    source: 'model',
    user_label: userLabel,
    user_scores: userScores,
  }
}
const NEG_USER = { joy: 0.02, peaceful: 0.03, curious: 0.05, calm: 0.1, confused: 0.1, lost: 0.2, irritated: 0.3, frustrated: 0.2 }

// ---------- 1. 种下去就有 v3 ----------
let v3 = db.prepare('SELECT * FROM affect_v3 WHERE agent_id=?').get(aid)
check('seed 后有 affect_v3', !!v3, v3)
check('seed 的 slow/total 一致', v3 && v3.slow === v3.total, v3)

// ---------- 2. 一次评价后写回 ----------
const r1 = await appraise(db, aid, '谢谢你，我很喜欢', { labels: LABELS, closeness: 0.9, hint: hintOf('joy', 'joy', undefined) })
check('评价返回 v3', !!r1.v3, r1.v3)
check('total 在范围内', r1.v3 && r1.v3.total >= -1 && r1.v3.total <= 1, r1.v3)
check('四个数都是有限值', r1.v3 && [r1.v3.baseline, r1.v3.slow, r1.v3.fast, r1.v3.total].every(finite), r1.v3)

const segs = db.prepare('SELECT * FROM affect_baseline WHERE agent_id=? ORDER BY seg_no').all(aid)
check('底色段已铺', segs.length > 0, { n: segs.length })
check('底色值来自段', Math.abs(r1.v3.baseline - baselineNow(db, aid, Date.now())) < 0.06,
  { at1: r1.v3.baseline, now: baselineNow(db, aid, Date.now()) })

const row = db.prepare('SELECT * FROM affect_v3 WHERE agent_id=?').get(aid)
check('库里写回了 total', Math.abs(row.total - r1.v3.total) < 1e-9, { row: row.total, ret: r1.v3.total })

const ep = db.prepare('SELECT appraisal FROM affect_episodes WHERE agent_id=? ORDER BY started_at DESC LIMIT 1').get(aid)
let emp = null
try { emp = JSON.parse(ep.appraisal || '{}').empathy } catch { emp = null }
check('episode 记了共情', emp && finite(emp.e_user) && finite(emp.delta), emp)

// ---------- 3. 同一小时内，慢情绪几乎不动 ----------
const r2 = await appraise(db, aid, '谢谢你，我很喜欢', { labels: LABELS, closeness: 0.9, hint: hintOf('joy', 'joy', undefined) })
check('同一小时慢情绪基本不动', Math.abs(r2.v3.slow - r1.v3.slow) < 0.05, { a: r1.v3.slow, b: r2.v3.slow })

// ---------- 4. 隔几小时，慢情绪会走 ----------
db.prepare('UPDATE affect_v3 SET slow_at=? WHERE agent_id=?')
  .run(new Date(Date.now() - 3 * H).toISOString(), aid)
const r3 = await appraise(db, aid, '谢谢你', { labels: LABELS, closeness: 0.9, hint: hintOf('joy', 'joy', undefined) })
check('隔 3 小时会步进', r3.v3.hours >= 2, { hours: r3.v3.hours })
check('步进后仍有限', [r3.v3.slow, r3.v3.total].every(finite), r3.v3)

// ---------- 5. 共情：对方难过 + 亲近 → 快情绪被拉低 ----------
db.prepare('UPDATE affect_v3 SET slow_at=? WHERE agent_id=?').run(now(), aid)
const rClose = await appraise(db, aid, '气死我了', { labels: LABELS, closeness: 0.99, hint: hintOf('irritated', 'frustrated', NEG_USER) })
const rFar = await appraise(db, aid, '气死我了', { labels: LABELS, closeness: 0.1, hint: hintOf('irritated', 'frustrated', NEG_USER) })
check('对方情绪投影为负', rClose.v3.eUser < 0, { e: rClose.v3.eUser })
// 比「共情带来的偏移」，不能比 fast 绝对值：两次评价自己的反应本来就不同（PAD 惯性）
const dClose = rClose.v3.fast - rClose.pleasure
const dFar = rFar.v3.fast - rFar.pleasure
check('亲近时共情偏移更大', dClose < dFar && dClose < 0, { dClose, dFar })
check('共情不会超过自己反应太多', rClose.v3.fast > rClose.pleasure - 0.3, { fast: rClose.v3.fast, self: rClose.pleasure })

// ---------- 6. 缺 v3 行时不崩 ----------
db.prepare('DELETE FROM affect_v3 WHERE agent_id=?').run(aid)
const r4 = await appraise(db, aid, '在吗', { labels: LABELS, closeness: 0.5, hint: hintOf('curious', 'curious', undefined) })
check('缺 v3 行时返回 null 且不崩', r4.v3 === null && !!r4.label, { v3: r4.v3 })

// ---------- 7. getAffect 带出 v3 ----------
seedAffect(db, aid)
const a = getAffect(db, aid)
check('getAffect 合并 v3', a && a.v3 && finite(a.v3.total), a && a.v3)
check('getAffect 带出累积负荷', a && a.v3 && Number.isFinite(Number(a.v3.base_off)), a && a.v3 && { off: a.v3.base_off })

// ---------- 8. 样本 / 走势里能画出水位和负荷 ----------
{
  const smp = db.prepare('SELECT slow FROM affect_samples WHERE agent_id=? ORDER BY at DESC LIMIT 1').get(aid)
  let sd = null
  try { sd = JSON.parse(smp.slow || '{}') } catch { sd = null }
  check('样本里存了累积负荷', sd && Number.isFinite(Number(sd.base_off)), sd)
}
{
  const tr = affectTrend(db, aid, 7)
  const tp = tr.points[tr.points.length - 1] || null
  check('走势有点', tr.points.length > 0, { n: tr.points.length })
  check('走势带水位 b', tp && finite(tp.b), tp && { b: tp.b })
  check('走势带累积负荷 bo', tp && (tp.bo === null || finite(tp.bo)), tp && { bo: tp.bo })
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
