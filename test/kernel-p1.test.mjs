/**
 * P1 仪表：三个数（违背 / 兑现 / 改主意）能出、能归零、能下钻；盲拆能算出差异率。
 * 运行：node test/kernel-p1.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { append } from '../src/modules/sangguan/ledger.js'
import { theta } from '../src/modules/sangguan/fold.js'
import { loadState } from '../src/modules/sangguan/projection.js'
import { scorecard } from '../src/modules/sangguan/score.js'
import { diffRate, textDistance } from '../src/modules/sangguan/blind.js'
import { setSangguanConfig } from '../src/modules/sangguan/config.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 600)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-kp1-'))
const db = openDb(path.join(dir, 'app.db'))
const T = '2026-11-02T03:00:00.000Z'
const A = 'agt_kp1'
db.prepare("INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)").run(A, 'k', 'daily', 'active', T)
setSangguanConfig(db, A, { enabled: true })

// 1) 空账本：三个数都是 0，兑现率没有分母
const empty = scorecard(db, A, { now: T })
check('空账本三个数都是 0', empty.violated.total === 0 && empty.changed.total === 0 && empty.nu.settled === 0, empty)
check('没有结算时兑现率是 null，不是 0', empty.nu.kept_rate === null)
check('内核四项都不成立', empty.kernel.ready === false && empty.kernel.pain === false && empty.kernel.debt === false)

// 2) 一条命题 + 一次改主意 + 一个已结算的 ν + 一次违背
const ev = append(db, A, [{ type: 'CLAIM_EXP', layer: 'V', actor: 'user', at: T, payload: { claims: [{ layer: 'V', kind: 'norm', text: '答应的事要做到', origin: 'user' }] } }])
const cid = ev.entities.claims[0]
const s = loadState(db, A)
const rev = append(db, A, [{ type: 'REV', layer: 'V', actor: 'user', at: T, payload: { claims: [{ layer: 'V', kind: 'norm', text: '答应的事要做到，但先顾好自己', origin: 'user', pred: [cid] }], old_id: cid } }])
const liveId = rev.entities.claims[0]
append(db, A, [{ type: 'NU_REGISTER', actor: 'sys', at: T, payload: { nus: [{ claim_id: liveId, expect: '周三前把答应的事做完', observe: '周三时那件事有没有做完', p: 0.6, due_at: '2026-11-05T00:00:00.000Z' }] } }])
const nuId = loadState(db, A).nus ? Object.keys(loadState(db, A).nus)[0] : null
append(db, A, [{ type: 'NU_RESOLVE', actor: 'sys', at: '2026-11-06T00:00:00.000Z', payload: { nu_id: nuId, outcome: 'miss' } }])

const sc = scorecard(db, A, { now: '2026-11-07T00:00:00.000Z' })
check('改主意数得上', sc.changed.total === 1, sc.changed)
check('兑现率有分母（这次是 0）', sc.nu.settled === 1 && sc.nu.kept_rate === 0, sc.nu)
check('进料读得出', sc.intake.offered >= 1, sc.intake)

// 3) 盲拆：一模一样 = 0，完全两样 = 1
check('同一句话距离为 0', textDistance('我不太想去。', '我不太想去') === 0)
check('两样的话距离为 1', textDistance('我不太想去。', '走吧，现在就走') === 1)
const r = diffRate([
  { id: 'a', with_inject: '我不太想去。', without_inject: '我不太想去。' },
  { id: 'b', with_inject: '我不太想去。', without_inject: '好，去。' },
], { threshold: 0.4 })
check('差异率 0.5', r.n === 2 && r.changed === 1 && r.rate === 0.5, r)

db.close()
console.log((fail ? '失败 ' : '通过 ') + pass + ' / ' + (pass + fail))
if (fail) process.exit(1)
