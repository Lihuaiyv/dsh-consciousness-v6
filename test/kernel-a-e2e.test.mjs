/**
 * 修复后的 30 天整体模拟：把这次补的洞串成一条时间线。
 *
 *   第 0 天：认下一条价值 + 许一个愿
 *   第 1 天：确认做到 → 第 3 天结算成 hit（不再冤判 miss）
 *   第 3–5 天：三次违背 → 立案
 *   第 26 天：立案超过 21 天没人审 → 自动挂起，那句话回来
 *   第 27–29 天：再三次违背 → 冷却期内不重复立案
 *
 * 运行：node test/kernel-a-e2e.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { setSangguanConfig } from '../src/modules/sangguan/config.js'
import { claimUserValue } from '../src/modules/sangguan/values_intake.js'
import { registerPledges, confirmNu } from '../src/modules/sangguan/pledge.js'
import { checkReply } from '../src/modules/sangguan/violate.js'
import { checkDue, suspendStaleKappas } from '../src/modules/sangguan/practice.js'
import { scorecard } from '../src/modules/sangguan/score.js'
import { injectView } from '../src/modules/sangguan/inject.js'
import { loadState } from '../src/modules/sangguan/projection.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 700)) }
}
const T0 = '2026-11-02T03:00:00.000Z'
const day = (n) => new Date(Date.parse(T0) + n * 86400000).toISOString()

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-a-e2e-'))
const db = openDb(path.join(dir, 'app.db'))
const A = 'agt_a_e2e'
db.prepare("INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)").run(A, '小汐', 'daily', 'active', day(0))
setSangguanConfig(db, A, { enabled: true, inject: 'live', violate: 'live' })

// 第 0 天
const v = claimUserValue(db, A, { key: 'benevolence', weight: 0.9 }, day(0))
const cid = v.claim_id
const p = registerPledges(db, A, { text: '我后天把东西修好。', at: day(0) })
check('承诺登记', p.registered.length === 1, p)

// 第 1 天：确认做到
confirmNu(db, A, { nu_id: p.registered[0].nu_id, outcome: 'hit', note: '拍了照片' }, day(1))
const due = await checkDue(db, A, day(3), { force: true })
check('确认过的承诺结算成 hit，不再冤判', due.did.some((d) => d.outcome === 'hit'), due)

// 第 3–5 天：三次违背
const judge = () => [{ claim_id: cid, why: '说不管了' }]
for (const d of [3, 4, 5]) await checkReply(db, A, { text: '我不管了。', at: day(d), judge })
const s1 = loadState(db, A)
const k1 = Object.values(s1.kappas)[0]
check('三次违背立案', !!k1 && k1.sigma === 'struggle', Object.values(s1.kappas).map((k) => k.sigma))
check('立案后那句话下架', !Object.values(s1.claims).some((c) => c.id === cid && c.status === 'active'))
check('注入里那句不再作为「你更看重」出现', !/你更看重：.*照顾身边的人/.test(injectView(db, A, { now: day(6), cache: false }).text))

// 第 26 天：卡死的 κ 挂起
const stale = suspendStaleKappas(db, A, day(26), { force: true })
check('21 天后自动挂起', stale.did.length === 1 && loadState(db, A).kappas[k1.id].sigma === 'suspended', stale)
check('那句话回来', /照顾身边的人/.test(injectView(db, A, { now: day(26), cache: false }).text))

// 第 27–29 天：再三次违背，冷却挡住建新案
for (const d of [27, 28, 29]) await checkReply(db, A, { text: '我不管了。', at: day(d), judge })
check('30 天内不重复立案', Object.values(loadState(db, A).kappas).length === 1, Object.values(loadState(db, A).kappas).map((k) => k.sigma))

// 终局读数
const fin = scorecard(db, A, { now: day(30) })
check('兑现率 100%（1 次 hit，0 miss）', fin.nu.settled === 1 && fin.nu.kept_rate === 1, fin.nu)
check('违背记了 6 笔', fin.violated.total === 6, fin.violated)
check('改主意 0（没人改过）', fin.changed.self === 0 && fin.changed.owner === 0, fin.changed)
check('卡死的 κ 已经不在开着的列表里', fin.kappa.open === 0 && fin.kappa.total === 1, fin.kappa)

db.close()
fs.rmSync(dir, { recursive: true, force: true })
console.log((fail ? '失败 ' : '通过 ') + pass + ' / ' + (pass + fail))
if (fail) process.exit(1)
