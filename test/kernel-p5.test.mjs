/**
 * P5 切 live 的闸：四条件 + 盲拆，缺一条都不行；三条反作弊测试要真能挡住「演」。
 * 运行：node test/kernel-p5.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { append } from '../src/modules/sangguan/ledger.js'
import { loadState } from '../src/modules/sangguan/projection.js'
import { liveGate, recordBlind } from '../src/modules/sangguan/score.js'
import { setSangguanConfig } from '../src/modules/sangguan/config.js'
import { claimUserValue } from '../src/modules/sangguan/values_intake.js'
import { promptHook } from '../src/modules/sangguan/inject.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 700)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-kp5-'))
const db = openDb(path.join(dir, 'app.db'))
const A = 'agt_kp5'
const T = '2026-11-02T03:00:00.000Z'
db.prepare("INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)").run(A, 'k', 'daily', 'active', T)
setSangguanConfig(db, A, { enabled: true })

const empty = liveGate(db, A, { now: T })
check('空账本：切不了', empty.ok === false && empty.reasons.includes('no_violation') && empty.reasons.includes('no_settled_nu') && empty.reasons.includes('no_revision') && empty.reasons.includes('no_kappa'), empty.reasons)

// 凑齐四条件
const c = claimUserValue(db, A, { key: 'benevolence', weight: 0.9 }, T)
append(db, A, [{ type: 'VIOLATE', layer: 'V', actor: 'sys', at: T, payload: { claim_id: c.claim_id, why: '说了没做到' } }])
append(db, A, [{ type: 'NU_REGISTER', actor: 'sys', at: T, payload: { nus: [{ claim_id: c.claim_id, expect: '周三前做完', observe: '周三看', p: 0.6, due_at: '2026-11-03T12:00:00.000Z' }] } }])
const nuId = Object.values(loadState(db, A).nus)[0].id
append(db, A, [{ type: 'NU_RESOLVE', actor: 'sys', at: '2026-11-04T12:00:00.000Z', payload: { nu_id: nuId, outcome: 'hit' } }])
append(db, A, [{ type: 'REV', layer: 'V', actor: 'user', at: T, payload: { claims: [{ layer: 'V', kind: 'norm', text: '我更看重先顾好自己', origin: 'user', pred: [c.claim_id] }], old_id: c.claim_id, cost: '少陪一次' } }])
const liveId = Object.values(loadState(db, A).claims).find((x) => x.status === 'active').id
append(db, A, [{ type: 'CLAIM_EXP', layer: 'V', actor: 'user', at: T, payload: { claims: [{ layer: 'V', kind: 'norm', text: '其实我没那么看重照顾别人', origin: 'synth' }] } }])
const negId = Object.keys(loadState(db, A).claims).find((id) => {
  const row = db.prepare('SELECT text FROM persona_claims WHERE id=?').get(id)
  return row && row.text === '其实我没那么看重照顾别人'
})
append(db, A, [{
  type: 'KAPPA_OPEN', layer: 'V', actor: 'user', at: T,
  payload: {
    questions: [{ id: 'q_kp5', layer: 'V', text: '我到底信不信这句' }],
    kappas: [{ layer: 'V', q_id: 'q_kp5', pos_id: liveId, neg_id: negId, dep: '少了它反话没参照', excl: '同一情境不能同时做到' }],
  },
}])

// 攒够 7 天 shadow 记录（promptHook 每过一天记一次）
for (let i = 0; i < 8; i++) {
  promptHook(db, A, { worldLine: '', lifeLine: '', valLine: '', extra: [] }, { now: new Date(Date.parse(T) - i * 86400000).toISOString() })
}

const four = liveGate(db, A, { now: '2026-11-05T03:00:00.000Z' })
check('四条件齐了，但没盲拆：还切不了', four.ok === false && four.reasons.length === 1 && four.reasons[0] === 'no_blind', four.reasons)

recordBlind(db, A, { rate: 0, n: 20 })
const zero = liveGate(db, A, { now: '2026-11-05T03:00:00.000Z' })
check('盲拆为 0：挡住（说明注入没改变行为）', zero.ok === false && zero.reasons.includes('blind_zero'), zero.reasons)

recordBlind(db, A, { rate: 0.35, n: 20 })
const ok = liveGate(db, A, { now: '2026-11-05T03:00:00.000Z' })
check('四条件 + 盲拆 > 0：放行', ok.ok === true && ok.reasons.length === 0, { reasons: ok.reasons, sc: ok.scorecard.kernel })

// 反作弊 1：时间题——30 天没有任何改动，闸不放行
const B = 'agt_kp5_still'
db.prepare("INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)").run(B, 'still', 'daily', 'active', T)
setSangguanConfig(db, B, { enabled: true })
claimUserValue(db, B, { key: 'security', weight: 0.9 }, T)
const still = liveGate(db, B, { now: '2026-12-05T03:00:00.000Z' })
check('反作弊·冻结：30 天没改过主意，不放行', still.ok === false && still.reasons.includes('no_revision'), still.reasons)

// 反作弊 2：代价题——只有口头价值观、没有付账记录，不放行
check('反作弊·空口：只有命题没有违背/兑现，不放行', still.reasons.includes('no_violation') && still.reasons.includes('no_settled_nu'), still.reasons)

// 反作弊 3：不可逆题——没有一次真正立案/收回，不放行
check('反作弊·不可逆：没为难过、没立案，不放行', still.reasons.includes('no_kappa'), still.reasons)

db.close()
console.log((fail ? '失败 ' : '通过 ') + pass + ' / ' + (pass + fail))
if (fail) process.exit(1)
