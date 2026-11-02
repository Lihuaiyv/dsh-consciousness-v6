/**
 * A8：卡死的 κ 会被夜巡挂起，不让一句话被永久下架。
 *   1. 21 天内不动
 *   2. 21 天后自动 SUSPEND，两极回到 active
 *   3. 审议过的 κ 不挂起
 *   4. 挂起后那句重新进注入
 * 运行：node test/kernel-a8.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { append } from '../src/modules/sangguan/ledger.js'
import { loadState } from '../src/modules/sangguan/projection.js'
import { suspendStaleKappas } from '../src/modules/sangguan/practice.js'
import { setSangguanConfig } from '../src/modules/sangguan/config.js'
import { injectView } from '../src/modules/sangguan/inject.js'
import { claimUserValue } from '../src/modules/sangguan/values_intake.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 600)) }
}
const day = (n) => new Date(Date.parse('2026-11-02T03:00:00.000Z') + n * 86400000).toISOString()

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-a8-'))
const db = openDb(path.join(dir, 'app.db'))
const A = 'agt_a8'
db.prepare("INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)").run(A, 'a', 'daily', 'active', day(0))
setSangguanConfig(db, A, { enabled: true, inject: 'live' })

const made = claimUserValue(db, A, { key: 'benevolence', weight: 0.9 }, day(0))
const posId = made.claim_id
const neg = append(db, A, [{ type: 'CLAIM_EXP', layer: 'V', actor: 'user', at: day(1), payload: { claims: [{ layer: 'V', kind: 'norm', text: '其实我懒得管别人', origin: 'synth' }] } }])
const k = append(db, A, [{
  type: 'KAPPA_OPEN', layer: 'V', actor: 'user', at: day(1),
  payload: {
    questions: [{ id: 'q_a8', layer: 'V', text: '我到底管不管别人' }],
    kappas: [{ layer: 'V', qId: 'q_a8', q_id: 'q_a8', pos_id: posId, neg_id: neg.entities.claims[0], dep: '没有反话就没有参照', excl: '同一情境不能既管又不管' }],
  },
}])
const kId = k.entities.kappas[0]
check('先立起一场没打完的矛盾', loadState(db, A).kappas[kId].sigma === 'struggle')

const early = suspendStaleKappas(db, A, day(10), { force: true })
check('21 天内不挂起', early.did.length === 0 && loadState(db, A).kappas[kId].sigma === 'struggle', early)

const late = suspendStaleKappas(db, A, day(22), { force: true })
const s2 = loadState(db, A)
check('21 天后自动挂起', late.did.length === 1 && s2.kappas[kId].sigma === 'suspended', late)
check('两极回到 active', s2.claims[posId].status === 'active' && s2.claims[neg.entities.claims[0]].status === 'active', { pos: s2.claims[posId].status })

const view = injectView(db, A, { now: day(22), cache: false })
check('那句话重新进注入', /照顾身边的人/.test(view.text), view.text)

// 审议过的 κ 不挂起
const b = claimUserValue(db, A, { key: 'security', weight: 0.9 }, day(23))
const bneg = append(db, A, [{ type: 'CLAIM_EXP', layer: 'V', actor: 'user', at: day(23), payload: { claims: [{ layer: 'V', kind: 'norm', text: '其实我不在乎稳不稳定', origin: 'synth' }] } }])
const k2 = append(db, A, [{
  type: 'KAPPA_OPEN', layer: 'V', actor: 'user', at: day(23),
  payload: {
    questions: [{ id: 'q_a8b', layer: 'V', text: '我在不在乎稳定' }],
    kappas: [{ layer: 'V', qId: 'q_a8b', q_id: 'q_a8b', pos_id: b.claim_id, neg_id: bneg.entities.claims[0], dep: 'x', excl: 'y' }],
  },
}])
append(db, A, [{ type: 'DELIBERATE', layer: 'V', actor: 'sys', at: day(24), payload: { kappa_id: k2.entities.kappas[0], branch: 'SUSPEND' } }])
const later = suspendStaleKappas(db, A, day(60), { force: true })
check('审议过的 κ 不再动', !later.did.some((x) => x.id === k2.entities.kappas[0]), later)

db.close()
console.log((fail ? '失败 ' : '通过 ') + pass + ' / ' + (pass + fail))
if (fail) process.exit(1)
