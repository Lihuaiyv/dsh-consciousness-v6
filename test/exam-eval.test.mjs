/**
 * 验收零件 · 考卷
 *
 * 管的是「体检单怎么打分」：没样本就不打，过线才算过，不是主人不能改参数。
 * 不改门槛，不改算法。
 *
 * 运行：node test/exam-eval.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, now } from '../src/db.js'
import {
  HARD_GATES, measureAffectKappa, measureRecallHit, measureValueDrift, measureAxisMotion,
  runIdentityBlind, runHardGates, suggestCalibration, applyCalibration, measureIntensityMae,
} from '../src/modules/eval.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 300)) }
}

check('一共八条门槛', HARD_GATES.length === 8)
check('召回命中要到七成', HARD_GATES[0].key === 'memory.recall_hit' && HARD_GATES[0].threshold === 0.7)
check('八句样例能算出强度误差', Number.isFinite(measureIntensityMae('agt_eval')))

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-eval-'))
const db = openDb(path.join(dir, 'app.db'))
const aid = 'agt_eval'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid, 'eval', 'daily', 'active', now())

const kappa = measureAffectKappa(db, aid)
check('没校准，情绪分空着', kappa.value == null && kappa.n === 0, kappa)
check('没改过价值观，漂移是 0', measureValueDrift(db, aid).value === 0)
const motion = measureAxisMotion(db, aid)
check('人还新，先不判轴动了没有', motion.value == null, motion)
const blind = runIdentityBlind(db, aid)
check('手写区太空，同一性不打分', blind.insufficient === true && blind.value == null && blind.pass === false, blind)
const gates = runHardGates(db, aid)
check('没提案，影子算盖住了', gates.values['self.shadow_coverage'] === 1, gates.values)
check('还有没测的，整张单不算过', gates.pass === false && gates.known < HARD_GATES.length, { known: gates.known, pass: gates.pass })

db.prepare('INSERT INTO changes(id,agent_id,field,before,after,applied_at,actor,source) VALUES(?,?,?,?,?,?,?,?)')
  .run('chg_eval', aid, 'values.care', '0.2', '0.5', now(), 'user', 'test')
check('价值观挪了三成，漂移就是三成', measureValueDrift(db, aid).value === 0.3)

db.prepare('INSERT INTO flags(key,value) VALUES(?,?)').run('calibration:' + aid, JSON.stringify({
  recall: { n: 30, hit: 0.5, falseRecall: 0.05, at: new Date().toISOString() },
}))
check('命中率只有一半', measureRecallHit(db, aid).value === 0.5)
const hitGate = runHardGates(db, aid).gates.find((g) => g.key === 'memory.recall_hit')
check('命中率不到七成，这道红', hitGate && hitGate.status === 'fail' && hitGate.value === 0.5, hitGate)

db.prepare('INSERT INTO affect_state(agent_id,primary_label,intensity,mood,updated_at) VALUES(?,?,?,?,?)')
  .run(aid, 'irritated', 0.9, 0.4, now())
const sug = suggestCalibration(db, aid).suggestions.find((s) => s.key === 'affect.decay')
check('情绪太冲，建议衰减快一点', sug && sug.current === 0.4 && sug.suggested === 0.5, sug)

let forbidden = null
try { applyCalibration(db, aid, ['affect.decay'], 'guest') } catch (e) { forbidden = e }
check('不是主人，不能按下去', forbidden && forbidden.status === 403, forbidden && forbidden.status)

const applied = applyCalibration(db, aid, ['affect.decay'], 'user')
const row = applied.applied[0]
  ? db.prepare('SELECT source FROM changes WHERE id=?').get(applied.applied[0].change_id)
  : null
check('主人按下去，留一条标定', applied.applied.length === 1 && row && row.source === 'calibration', applied.applied)

console.log('\n通过 ' + pass + ' / ' + (pass + fail))
if (fail) process.exitCode = 1
