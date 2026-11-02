/**
 * P4 会改主意：改要付代价，改完看得见。
 *   1. 没写代价 → 拒
 *   2. 有代价 → 旧命题 superseded，新命题 active，注入说一轮「我改了一个看法」
 *   3. 30 天额度：保护带 3 次，第 4 次拒
 *   4. 核心不能直接改（只能升维）
 * 运行：node test/kernel-p4.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { claimUserValue } from '../src/modules/sangguan/values_intake.js'
import { reviseClaim, revisionBudget } from '../src/modules/sangguan/revision.js'
import { loadState } from '../src/modules/sangguan/projection.js'
import { injectView } from '../src/modules/sangguan/inject.js'
import { setSangguanConfig } from '../src/modules/sangguan/config.js'
import { append } from '../src/modules/sangguan/ledger.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 600)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-kp4-'))
const db = openDb(path.join(dir, 'app.db'))
const A = 'agt_kp4'
const T = '2026-11-02T03:00:00.000Z'
db.prepare("INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)").run(A, 'k', 'daily', 'active', T)
setSangguanConfig(db, A, { enabled: true, inject: 'live' })

const made = claimUserValue(db, A, { key: 'benevolence', weight: 0.9 }, T)
const oldId = made.claim_id

let threw = ''
try { reviseClaim(db, A, { id: oldId, text: '我更看重先把自己顾好' }, T) } catch (e) { threw = e.message }
check('没写代价就拒', /代价|放弃|付出/.test(threw), threw)

const rev = reviseClaim(db, A, { id: oldId, text: '我更看重先把自己顾好', cost: '少陪他一次' }, T)
const st = loadState(db, A)
check('改完旧命题退场、新命题在场', st.claims[oldId].status === 'superseded' && st.claims[rev.id].status === 'active', { old: st.claims[oldId].status, new: st.claims[rev.id].status })
check('新命题指回旧命题', (st.claims[rev.id].pred || []).includes(oldId))

const v = injectView(db, A, { now: '2026-11-02T04:00:00.000Z', cache: false })
check('注入说一轮「我改了一个看法」', /我改了一个看法/.test(v.text), v.text)
const v2 = injectView(db, A, { now: '2026-11-02T05:00:00.000Z', cache: false })
check('只说一轮', !/我改了一个看法/.test(v2.text), v2.text)

// 额度：保护带 30 天 3 次
const b = revisionBudget(db, A, 'V', T)
check('额度扣了一次', b.belt_left === 2 && b.belt_ok === true, b)
for (let i = 0; i < 2; i++) {
  const cur = Object.values(loadState(db, A).claims).find((c) => c.status === 'active' && c.layer === 'V')
  reviseClaim(db, A, { id: cur.id, text: '我更看重先把自己顾好' + (i + 2), cost: '又少陪一次' }, new Date(Date.parse(T) + (i + 1) * 3600e3).toISOString())
}
const cur2 = Object.values(loadState(db, A).claims).find((c) => c.status === 'active' && c.layer === 'V')
let blocked = ''
try { reviseClaim(db, A, { id: cur2.id, text: '第四次改', cost: '再少陪一次' }, '2026-11-03T03:00:00.000Z') } catch (e) { blocked = e.message }
check('第四次被额度挡住', /30 天已经改了/.test(blocked), blocked)

// 核心不能直接改
const core = append(db, A, [{ type: 'CLAIM_EXP', layer: 'V', actor: 'user', at: '2026-11-04T03:00:00.000Z', payload: { claims: [{ layer: 'V', kind: 'principle', text: '先把自己顾好', origin: 'seed' }] } }])
let coreErr = ''
try { reviseClaim(db, A, { id: core.entities.claims[0], text: '换核心', cost: '代价' }, '2026-11-05T03:00:00.000Z') } catch (e) { coreErr = e.message }
check('核心只能升维，不能直接改', /升维/.test(coreErr), coreErr)

db.close()
console.log((fail ? '失败 ' : '通过 ') + pass + ' / ' + (pass + fail))
if (fail) process.exit(1)
