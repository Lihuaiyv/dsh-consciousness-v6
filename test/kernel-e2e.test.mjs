/**
 * 整体模拟：一个意识体的 7 天。
 *
 * 第 1 天：答应一件事 → 第 3 天发现没做到（欠账）
 * 第 2–4 天：同一个价值观上说了三次没做到（会疼 → 自动立案）
 * 第 5 天：改一次主意，写下代价（会改主意）
 * 第 6 天：攒满 7 天影子 → 补一次盲拆 → 闸门打开
 *
 * 每一步都从账本读回来，不信任内存里的对象。
 * 运行：node test/kernel-e2e.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { setSangguanConfig } from '../src/modules/sangguan/config.js'
import { claimUserValue } from '../src/modules/sangguan/values_intake.js'
import { registerPledges } from '../src/modules/sangguan/pledge.js'
import { checkReply } from '../src/modules/sangguan/violate.js'
import { reviseClaim } from '../src/modules/sangguan/revision.js'
import { checkDue } from '../src/modules/sangguan/practice.js'
import { scorecard, liveGate, recordBlind } from '../src/modules/sangguan/score.js'
import { promptHook, injectView } from '../src/modules/sangguan/inject.js'
import { loadState } from '../src/modules/sangguan/projection.js'
import { readEvents } from '../src/modules/sangguan/ledger.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 800)) }
}
const day = (n) => new Date(Date.parse('2026-11-02T03:00:00.000Z') + n * 86400000).toISOString()

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-kernel-e2e-'))
const db = openDb(path.join(dir, 'app.db'))
const A = 'agt_e2e'
db.prepare("INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)").run(A, '小汐', 'daily', 'active', day(0))
setSangguanConfig(db, A, { enabled: true, inject: 'live', violate: 'live' })

// 它认下一条价值
const v = claimUserValue(db, A, { key: 'benevolence', weight: 0.9 }, day(0))
const cid = v.claim_id

// ---- 第 1 天：答应一件事 ----
const p = registerPledges(db, A, { text: '好，我明天把报告发你。', at: day(0) })
check('承诺登记成 ν', p.registered.length === 1, p)

// ---- 第 3 天：没做到（欠账） ----
const due = await checkDue(db, A, day(3), { force: true })
const sc1 = scorecard(db, A, { now: day(3) })
check('没做到结算成 miss', due.did.some((d) => d.outcome === 'miss'), due)
check('兑现率有分母且为 0', sc1.nu.settled === 1 && sc1.nu.kept_rate === 0, sc1.nu)

// ---- 第 2/3/4 天：同一个价值观上三次没做到 ----
const judge = () => [{ claim_id: cid, why: '说了不管别人' }]
const bad = '我不管了，随他去吧。'
for (const d of [2, 3, 4]) await checkReply(db, A, { text: bad, at: day(d), judge })
const s2 = loadState(db, A)
check('三次违背自动立案', Object.values(s2.kappas).filter((k) => k.sigma === 'struggle').length === 1, Object.values(s2.kappas).map((k) => k.sigma))
check('它自己那句从候选里下架', !Object.values(s2.claims).some((c) => c.id === cid && c.status === 'active'), s2.claims[cid] && s2.claims[cid].status)

// ---- 第 5 天：改一次主意，写下代价 ----
// 先认一条新的（前面那条已经在交锋里，不能直接改）
const sec = claimUserValue(db, A, { key: 'security', weight: 0.8 }, day(5))
const rev = reviseClaim(db, A, { id: sec.claim_id, text: '我更看重先把自己顾好，才顾得上别人', cost: '少陪他一次' }, day(5))
check('改主意留下新命题', !!rev.id && loadState(db, A).claims[sec.claim_id].status === 'superseded')

// ---- 第 6 天：攒影子 + 盲拆 + 过闸 ----
for (let i = 0; i < 8; i++) promptHook(db, A, { worldLine: '', lifeLine: '', valLine: '', extra: [] }, { now: day(i) })
const gate1 = liveGate(db, A, { now: day(6) })
check('没盲拆前闸门不放行', !gate1.ok && gate1.reasons.includes('no_blind'), gate1.reasons)
recordBlind(db, A, { rate: 0.35, n: 20 })
const gate2 = liveGate(db, A, { now: day(6) })
check('补齐后放行', gate2.ok === true, gate2.reasons)

// ---- 终局读数 ----
const fin = scorecard(db, A, { now: day(7) })
check('违背记了 3 笔', fin.violated.total === 3, fin.violated)
check('改主意记了 1 笔', fin.changed.total === 1, fin.changed)
check('有 1 场没打完的矛盾', fin.kappa.open === 1, fin.kappa)
check('内核四项全成立', fin.kernel.ready === true, fin.kernel)

// 注入：说一次「我改了一个看法」，不重复
const view = injectView(db, A, { now: day(7), cache: false })
check('注入里有它自己的看法', /你更看重|答应的事|先把自己顾好/.test(view.text), view.text)
const view2 = injectView(db, A, { now: new Date(Date.parse(day(7)) + 1000).toISOString(), cache: false })
check('注入有预算、不超', view.tokens <= view.budget + 1, { tokens: view.tokens, budget: view.budget })

// 账本只增：事件条数只涨不跌
const n1 = readEvents(db, A).length
claimUserValue(db, A, { key: 'security', weight: 0.8 }, day(7))
check('账本只增', readEvents(db, A).length > n1)

db.close()
fs.rmSync(dir, { recursive: true, force: true })
console.log((fail ? '失败 ' : '通过 ') + pass + ' / ' + (pass + fail))
if (fail) process.exit(1)
