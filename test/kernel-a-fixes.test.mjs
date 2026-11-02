/**
 * A1–A13 的集中回归（A8 单独一个文件）。
 * 运行：node test/kernel-a-fixes.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { append } from '../src/modules/sangguan/ledger.js'
import { loadState } from '../src/modules/sangguan/projection.js'
import { setSangguanConfig } from '../src/modules/sangguan/config.js'
import { claimUserValue } from '../src/modules/sangguan/values_intake.js'
import { registerPledges } from '../src/modules/sangguan/pledge.js'
import { checkReply } from '../src/modules/sangguan/violate.js'
import { injectView } from '../src/modules/sangguan/inject.js'
import { scorecard, liveGate, recordBlind } from '../src/modules/sangguan/score.js'
import { foldValueWeights } from '../src/modules/sangguan/vweights.js'
import { route } from '../src/modules/sangguan/api.js'
import { promptHook } from '../src/modules/sangguan/inject.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 700)) }
}
const T = '2026-11-02T03:00:00.000Z'
const day = (n) => new Date(Date.parse(T) + n * 86400000).toISOString()
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-afix-'))
const db = openDb(path.join(dir, 'app.db'))
const mk = (id) => db.prepare("INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)").run(id, id, 'daily', 'active', T)

// ---------- A1：改主意只算它自己改的 ----------
mk('agt_a1')
setSangguanConfig(db, 'agt_a1', { enabled: true })
const a1 = claimUserValue(db, 'agt_a1', { key: 'benevolence', weight: 0.9 }, T)
append(db, 'agt_a1', [{ type: 'CLAIM_RETIRE', layer: 'V', actor: 'user', at: T, payload: { claim_id: a1.claim_id, reason: '清退' } }])
const sc1 = scorecard(db, 'agt_a1', { now: T })
check('A1 清退不算改主意', sc1.changed.self === 0 && sc1.changed.owner === 1 && sc1.changed.total === 0, sc1.changed)
check('A1 内核的「改主意」不成立', sc1.kernel.revision === false)
const a1b = claimUserValue(db, 'agt_a1', { key: 'security', weight: 0.8 }, T)
append(db, 'agt_a1', [{ type: 'REV', layer: 'V', actor: 'user', at: T, payload: { claims: [{ layer: 'V', kind: 'norm', text: '我更看重稳一点', origin: 'user', pred: [a1b.claim_id] }], old_id: a1b.claim_id, cost: '少冒险' } }])
check('A1 真改一次才算', scorecard(db, 'agt_a1', { now: T }).changed.self === 1, scorecard(db, 'agt_a1', { now: T }).changed)

// ---------- A2：承诺不进价值观层 ----------
mk('agt_a2')
setSangguanConfig(db, 'agt_a2', { enabled: true, inject: 'live' })
const pr = registerPledges(db, 'agt_a2', { text: '我明天把报告发你。', at: T })
check('A2 承诺记成 commit', pr.registered.length === 1 && loadState(db, 'agt_a2').claims[pr.registered[0].claim_id].kind === 'commit', pr)
check('A2 承诺不进十维', foldValueWeights(db, 'agt_a2') === null, foldValueWeights(db, 'agt_a2'))
const iv = injectView(db, 'agt_a2', { now: day(0), cache: false })
check('A2 注入里没有「我答应」', !/我答应/.test(iv.text), iv.text)

// ---------- A3：shadow 不预支「已说」 ----------
mk('agt_a3')
setSangguanConfig(db, 'agt_a3', { enabled: true, inject: 'shadow', violate: 'live' })
const a3 = claimUserValue(db, 'agt_a3', { key: 'benevolence', weight: 0.9 }, T)
const judge3 = () => [{ claim_id: a3.claim_id, why: '说不管了' }]
await checkReply(db, 'agt_a3', { text: '我不管了。', at: T, judge: judge3 })
injectView(db, 'agt_a3', { now: T, cache: false })
setSangguanConfig(db, 'agt_a3', { inject: 'live' })
const live3 = injectView(db, 'agt_a3', { now: T, cache: false })
check('A3 shadow 期没把提醒标成已说', /刚才没做到|对不上/.test(live3.text), live3.text)

// ---------- A11b：闸门/预览不许把提醒标成已说（读口无副作用） ----------
mk('agt_a11b')
setSangguanConfig(db, 'agt_a11b', { enabled: true, inject: 'live', violate: 'live' })
const ab = claimUserValue(db, 'agt_a11b', { key: 'benevolence', weight: 0.9 }, T)
await checkReply(db, 'agt_a11b', { text: '我不管了。', at: T, judge: () => [{ claim_id: ab.claim_id, why: '说不管了' }] })
liveGate(db, 'agt_a11b', { now: T })
injectView(db, 'agt_a11b', { now: T, cache: false, mark: false })
const still11 = injectView(db, 'agt_a11b', { now: T, cache: false })
check('A11b 预览/闸门不消耗提醒', /刚才没做到|对不上/.test(still11.text), still11.text)

// ---------- A10：关着时不记承诺 ----------
mk('agt_a10')
const off10 = registerPledges(db, 'agt_a10', { text: '我明天把报告发你。', at: T })
check('A10 关着不记承诺', off10.off === true && off10.registered.length === 0 && Object.keys(loadState(db, 'agt_a10').claims).length === 0, off10)

// ---------- A11：闸门查注入内容 ----------
mk('agt_a11')
setSangguanConfig(db, 'agt_a11', { enabled: true })
const g11 = liveGate(db, 'agt_a11', { now: T })
check('A11 空注入不放行', g11.reasons.includes('no_content') && g11.content === 0, g11.reasons)

// ---------- A12：立案冷却 30 天 ----------
mk('agt_a12')
setSangguanConfig(db, 'agt_a12', { enabled: true, violate: 'live' })
const a12 = claimUserValue(db, 'agt_a12', { key: 'benevolence', weight: 0.9 }, T)
const neg = append(db, 'agt_a12', [{ type: 'CLAIM_EXP', layer: 'V', actor: 'user', at: T, payload: { claims: [{ layer: 'V', kind: 'norm', text: '其实我懒得管', origin: 'synth' }] } }])
append(db, 'agt_a12', [{
  type: 'KAPPA_OPEN', layer: 'V', actor: 'user', at: T,
  payload: {
    questions: [{ id: 'q_a12', layer: 'V', text: '我管不管' }],
    kappas: [{ layer: 'V', q_id: 'q_a12', pos_id: a12.claim_id, neg_id: neg.entities.claims[0], dep: 'x', excl: 'y' }],
  },
}])
const kId12 = Object.values(loadState(db, 'agt_a12').kappas)[0].id
append(db, 'agt_a12', [{ type: 'SUSPEND', layer: 'V', actor: 'sys', at: T, payload: { kappa_id: kId12 } }])
const judge12 = () => [{ claim_id: a12.claim_id, why: '又说不管' }]
for (const d of [1, 2, 3]) await checkReply(db, 'agt_a12', { text: '我不管了。', at: day(d), judge: judge12 })
const s12 = loadState(db, 'agt_a12')
check('A12 30 天内不重复立案', Object.values(s12.kappas).length === 1, Object.values(s12.kappas).map((k) => k.sigma))

// ---------- A13：配置能看到 violate ----------
const cfg = await route(db, 'agt_a12', 'GET', 'config')
check('A13 配置带 violate 档位', cfg.config && cfg.config.violate === 'live', cfg)

// ---------- A6：字段改名 ----------
const sc6 = scorecard(db, 'agt_a12', { now: T })
check('A6 用 v_active 而不是 core', Object.prototype.hasOwnProperty.call(sc6.claims, 'v_active') && !Object.prototype.hasOwnProperty.call(sc6.claims, 'core'), sc6.claims)

// ---------- A7：冷启动不判 ----------
mk('agt_a7')
setSangguanConfig(db, 'agt_a7', { enabled: true, violate: 'shadow' })
claimUserValue(db, 'agt_a7', { key: 'benevolence', weight: 0.9 }, T)
db.prepare("INSERT INTO chat_turns(id,agent_id,role,text,created_at) VALUES(?,?,?,?,?)").run('t1', 'agt_a7', 'user', '在吗', T)
db.prepare("INSERT INTO chat_turns(id,agent_id,role,text,created_at) VALUES(?,?,?,?,?)").run('t2', 'agt_a7', 'assistant', '在', T)
const early7 = await checkReply(db, 'agt_a7', { text: '我不管了。', at: T })
check('A7 只聊了两轮不判', early7.status === 'throttled', early7)

// A5：盲拆下限
mk('agt_a5')
setSangguanConfig(db, 'agt_a5', { enabled: true })
claimUserValue(db, 'agt_a5', { key: 'benevolence', weight: 0.9 }, T)
for (let i = 0; i < 8; i++) promptHook(db, 'agt_a5', { worldLine: '', lifeLine: '', valLine: '', extra: [] }, { now: day(i) })
recordBlind(db, 'agt_a5', { rate: 1, n: 3 })
const g5 = liveGate(db, 'agt_a5', { now: day(8) })
check('A5 样本太少不放行', g5.reasons.includes('blind_low_n'), g5.reasons)
recordBlind(db, 'agt_a5', { rate: 0.35, n: 20 })
check('A5 够了就换理由', !liveGate(db, 'agt_a5', { now: day(8) }).reasons.includes('blind_low_n'))

db.close()
console.log((fail ? '失败 ' : '通过 ') + pass + ' / ' + (pass + fail))
if (fail) process.exit(1)
