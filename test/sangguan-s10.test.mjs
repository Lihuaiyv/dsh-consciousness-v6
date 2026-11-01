/**
 * 三观 S10：升维（logic-gates §9.2）。E1 触发 → 辩证会（J20×2 + J10 + J11×2，慢环 8 单位）→ E2 / E3 → E4。
 * W 自动提交；L / V 需用户批准；拒绝冷却指数退避；T_approve 超时；Frozen；失败后无新输入不重试；
 * 没预算推迟；降级暂停；两核相撞触发；P12 核心保护；场景③后半；P1。
 * 运行：node test/sangguan-s10.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { append, newId, readEvents } from '../src/modules/sangguan/ledger.js'
import { emptyState, fold, checkInvariants } from '../src/modules/sangguan/fold.js'
import { loadState, rebuild, snapshot, stateToSnapshot } from '../src/modules/sangguan/projection.js'
import { setSangguanConfig } from '../src/modules/sangguan/config.js'
import { degenCheck, e1Ready, mOf, revOf } from '../src/modules/sangguan/practice.js'
import { runElev, approveElev, rejectElev, pendingElev, elevTimeouts, elevStatus, elevOpenOf } from '../src/modules/sangguan/elev.js'
import { plan } from '../src/modules/sangguan/deliberate.js'
import { budgetSnapshot } from '../src/modules/sangguan/budget.js'
import { recordJudge } from '../src/modules/sangguan/llm.js'
import { CORE_KIND } from '../src/modules/sangguan/catalog.js'
import { fakeChat } from './sangguan-fake-llm.mjs'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 800)) }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-sg10-'))
const db = openDb(path.join(dir, 'app.db'))
const DAY = 86400000
let clock = Date.parse('2026-11-02T08:00:00.000Z')
const tick = (min = 1) => new Date((clock += min * 60000)).toISOString()
const agents = []
function agent(name, extra = {}) {
  const aid = 'agt_s10_' + name
  setSangguanConfig(db, aid, { enabled: true, ...extra })
  agents.push(aid)
  return aid
}
const put = (aid, evs, expect) => append(db, aid, evs, expect)
const BELT = { W: 'belt', L: 'chapter', V: 'norm' }
const mk = (aid, layer, kind, text, origin = 'extract') => put(aid, [{
  type: 'CLAIM_EXP', layer, actor: 'sys', at: tick(), payload: { claims: [{ layer, kind, text, origin }] },
}]).entities.claims[0]
const neg = (aid, target, i) => put(aid, [{ type: 'EVIDENCE', actor: 'user', at: tick(), payload: { evidence: [{ kind: 'act', target_type: 'claim', target_id: target, sign: -1, weight: 0.6, ref: 'miss' + i + ':' + clock }] } }])
const count = (aid, t) => readEvents(db, aid, { types: [t] }).length

/** 核心持续受挫：一条命中过的 ν、M_core 条负证据、K 条 REPAIR_FAILED、W_deg 个退化检查点。 */
function degenLayer(aid, layer, text = '努力一定会有回报') {
  const core = mk(aid, layer, CORE_KIND[layer], text, 'seed')
  const belt = mk(aid, layer, BELT[layer], text + '，只要方法对')
  put(aid, [{ type: 'EDGE_ADD', actor: 'sys', at: tick(), payload: { edges: [{ type: 'DEPENDS', from_id: belt, to_id: core }] } }])
  const reg = tick()
  put(aid, [{ type: 'NU_REGISTER', actor: 'judge', at: reg, payload: { nus: [{ claim_id: core, expect: '坚持练习一个月后成绩提高', observe: '对话', p: 0.7, due_at: new Date(Date.parse(reg) + DAY).toISOString() }] } }])
  const nu = Object.values(loadState(db, aid).nus).find((n) => n.claim_id === core)
  clock += 2 * DAY
  put(aid, [{ type: 'NU_RESOLVE', actor: 'judge', at: tick(), payload: { nu_id: nu.id, outcome: 'hit', refs: ['r1'] } }])
  for (let i = 0; i < 5; i++) neg(aid, core, i)
  for (let i = 0; i < 3; i++) put(aid, [{ type: 'REPAIR_FAILED', layer, actor: 'sys', at: tick(), payload: { core_id: core } }])
  for (let i = 0; i < 14; i++) { clock += DAY; degenCheck(db, aid, tick()) }
  return { core, belt, hit: nu.id }
}
const NU = { expect: '换个方向后三周内有起色', observe: '对话', p: 0.6, due_days: 21 }
const J20 = (input) => ({ best_case: input.side === 'keep' ? '旧核解释过一次命中' : '近期五次落空', evidence_ids: [], weakest_point: '样本少' })
const J10 = (input) => ({
  meta: '「' + input.old_core.text + '」只在任务有明确反馈时成立',
  old_core_id: input.old_core.id, scope: '有明确反馈、可重复练习的任务',
  new_core: '回报取决于反馈质量与方向选择，而非单纯投入',
  mapping: input.hits.map((h) => ({ nu_id: h.id, by: 'scope' })), nu: [NU],
})
const J11 = { e2: { pass: true }, e3a: { pass: true }, e3c: { pass: true } }
const dial = (over = {}) => fakeChat({ J20, J10, J11, ...over })

// E1 未就绪：零调用
{
  const aid = agent('idle')
  mk(aid, 'W', 'core', '世界大体有规律', 'seed')
  const chat = dial()
  const r = await runElev(db, aid, tick(), { chat })
  check('E1 未就绪：零模型调用、零事件', chat.count() === 0 && count(aid, 'ELEV_COMMIT') + count(aid, 'ELEV_PROPOSE') + count(aid, 'ELEV_FAILED') === 0, r.skipped)
}

// 场景③后半：W 层核心持续受挫 → 自动换代
{
  const aid = agent('w')
  const f = degenLayer(aid, 'W')
  // 一个挂着旧核的挂起 κ
  const other = mk(aid, 'W', 'belt', '努力常常白费')
  const q = newId('questions', tick())
  const k = put(aid, [{ type: 'KAPPA_OPEN', layer: 'W', actor: 'judge', at: tick(), payload: { questions: [{ id: q, layer: 'W', text: '努力有没有用' }], kappas: [{ layer: 'W', q_id: q, pos_id: f.core, neg_id: other, dep: 'd', excl: 'e' }] } }]).entities.kappas[0]
  put(aid, [{ type: 'DELIBERATE', layer: 'W', actor: 'sys', at: tick(), payload: { kappa_id: k, branch: 'SUSPEND' } }, { type: 'SUSPEND', layer: 'W', actor: 'sys', at: tick(), payload: { kappa_id: k } }])
  let s = loadState(db, aid)
  const e1 = e1Ready(s, readEvents(db, aid), 'W', tick())
  check('E1 就绪：14 个退化检查点 + m ≥ M_core', e1.ready && e1.byDegen && e1.m >= 5, e1)
  const chat = dial()
  const day = tick().slice(0, 10)
  const before = budgetSnapshot(db, aid, day).pools.slow.used
  const r = await runElev(db, aid, tick(), { chat })
  s = loadState(db, aid)
  const nc = r.did[0] && r.did[0].committed
  check('W 层不需用户：直接 ELEV_COMMIT', !!nc && count(aid, 'ELEV_PROPOSE') === 0 && count(aid, 'ELEV_COMMIT') === 1, r)
  check('辩证会：J20×2 + J10 + J11×2，慢环 8 单位', chat.count('J20') === 2 && chat.count('J10') === 1 && chat.count('J11') === 2 && budgetSnapshot(db, aid, day).pools.slow.used - before === 8,
    { used: budgetSnapshot(db, aid, day).pools.slow.used - before })
  const j11 = chat.calls.filter((c) => c.id === 'J11').map((c) => c.input)
  check('J11 第二位把命中预见倒序', j11.length === 2 && j11[1].reversed === true && same(j11[1].hits, [...j11[0].hits].reverse()))
  const commit = readEvents(db, aid, { types: ['ELEV_COMMIT'] })[0]
  check('旧核 demoted（带 scope），新核 active、origin=elev、pred=[旧核]', s.claims[f.core].status === 'demoted' && commit.payload.scope && s.claims[nc].status === 'active' && s.claims[nc].kind === 'core' && s.claims[nc].origin === 'elev' && same(s.claims[nc].pred, [f.core]),
    { old: s.claims[f.core].status, nc: s.claims[nc] })
  check('纪元 +1（派生）', s.epoch.W === 1, s.epoch)
  check('依赖旧核的保护带写 REVIEW_FLAG；挂着旧核的 κ 同事务 KAPPA_OBSOLETE', readEvents(db, aid, { types: ['REVIEW_FLAG'] }).some((e) => e.payload.claim_id === f.belt) && s.kappas[k].sigma === 'resolved')
  check('新核登记了新 ν', Object.values(s.nus).some((n) => n.claim_id === nc && n.outcome === 'pending'))
  check('闸门报告留档：E2 / E3a / E3b / E3c 全 pass', ['E2', 'E3a', 'E3b', 'E3c'].every((x) => commit.gate_report[x] && commit.gate_report[x].pass), commit.gate_report)
  const all = readEvents(db, aid)
  check('新纪元：修订序列与 m 归零，E1 不再就绪', revOf(s, all, 'W').length === 0 && mOf(s, 'W', all) === 0 && !e1Ready(s, all, 'W', tick()).ready)
  const n0 = chat.count()
  clock += 7 * DAY
  degenCheck(db, aid, tick())
  await runElev(db, aid, tick(), { chat })
  check('换代后下一周：零调用', chat.count() === n0)
  const p12 = readEvents(db, aid).filter((e) => (e.type === 'RESOLVE' && s.claims[e.payload.loser_id].kind === 'core') || (e.type === 'CON' && s.claims[e.payload.claim_id].kind === 'core'))
  check('P12：没有 RESOLVE / CON 证伪核心', p12.length === 0)
}

// L 层：需用户批准；挂起期间 Frozen；批准后提交
{
  const aid = agent('l')
  const f = degenLayer(aid, 'L', '我要成为可靠的人')
  const r = await runElev(db, aid, tick(), { chat: dial() })
  const pend = pendingElev(db, aid, tick())
  check('L 层：写 ELEV_PROPOSE，不提交', !!(r.did[0] && r.did[0].proposed) && count(aid, 'ELEV_COMMIT') === 0 && pend.length === 1 && pend[0].old_core_id === f.core, r)
  // Frozen：κ 一极是核心 → 不试合题
  const other = mk(aid, 'L', 'chapter', '我想先照顾好自己')
  const q = newId('questions', tick())
  const k = put(aid, [{ type: 'KAPPA_OPEN', layer: 'L', actor: 'judge', at: tick(), payload: { questions: [{ id: q, layer: 'L', text: '先顾谁' }], kappas: [{ layer: 'L', q_id: q, pos_id: f.core, neg_id: other, dep: 'd', excl: 'e' }] } }]).entities.kappas[0]
  const p = plan(db, aid, k, tick(), { allowSub: true })
  check('Frozen(ℓ)：未结提案 + 一极是核心 → 不试 SUB', p.try_sub === false && !(p.calls || []).some((c) => c.id === 'J4'), p.calls)
  const chat = dial()
  await runElev(db, aid, tick(), { chat })
  check('提案未结：下周零调用', chat.count() === 0)
  const lock = approveElev(db, aid, pend[0].id, tick())
  check('旧核正在交锋：批准返回 locked，不写入', !lock.ok && lock.reason === 'locked' && count(aid, 'ELEV_COMMIT') === 0, lock)
  put(aid, [{ type: 'DELIBERATE', layer: 'L', actor: 'sys', at: tick(), payload: { kappa_id: k, branch: 'SUSPEND' } }, { type: 'SUSPEND', layer: 'L', actor: 'sys', at: tick(), payload: { kappa_id: k } }])
  const ok = approveElev(db, aid, pend[0].id, tick())
  const s = loadState(db, aid)
  const c = readEvents(db, aid, { types: ['ELEV_COMMIT'] })[0]
  check('用户批准 → ELEV_COMMIT（actor=user）、旧核 demoted、纪元 L=1', ok.ok && c.actor === 'user' && c.payload.proposal_id === pend[0].id && s.claims[f.core].status === 'demoted' && s.epoch.L === 1, ok)
  check('批准后 Frozen 解除、提案列表清空；挂着旧核的 κ 已关闭', pendingElev(db, aid, tick()).length === 0 && !elevOpenOf(db, aid, 'L') && s.kappas[k].sigma === 'resolved')
  check('重复批准：closed', approveElev(db, aid, pend[0].id, tick()).reason === 'closed')
}

// V 层：用户拒绝 → 冷却 14 日 → 再提 → 再拒 → 冷却 28 日
{
  const aid = agent('v')
  degenLayer(aid, 'V', '诚实高于一切')
  const chat = dial()
  await runElev(db, aid, tick(), { chat })
  const p1 = pendingElev(db, aid, tick())[0]
  check('V 层提案', !!p1)
  check('用户拒绝 → ELEV_REJECTED', rejectElev(db, aid, p1.id, tick(), '还不想换').ok && count(aid, 'ELEV_REJECTED') === 1)
  let st = elevStatus(loadState(db, aid), readEvents(db, aid), 'V', tick())
  check('冷却 T_cool = 14 日', st.cooling && Math.round((Date.parse(st.coolUntil) - clock) / DAY) === 14, st)
  const n0 = chat.count()
  clock += 7 * DAY
  degenCheck(db, aid, tick())
  await runElev(db, aid, tick(), { chat })
  check('冷却期内不重提、零调用', chat.count() === n0 && pendingElev(db, aid, tick()).length === 0)
  clock += 8 * DAY
  degenCheck(db, aid, tick())
  await runElev(db, aid, tick(), { chat })
  const p2 = pendingElev(db, aid, tick())[0]
  check('冷却过后可再提', !!p2 && p2.id !== p1.id)
  rejectElev(db, aid, p2.id, tick())
  st = elevStatus(loadState(db, aid), readEvents(db, aid), 'V', tick())
  check('第二次被拒：冷却翻倍到 28 日', Math.round((Date.parse(st.coolUntil) - clock) / DAY) === 28, st)
}

// T_approve 超时视为拒绝（夜间零模型）
{
  const aid = agent('timeout')
  degenLayer(aid, 'L', '我要一直陪着朋友')
  await runElev(db, aid, tick(), { chat: dial() })
  const p = pendingElev(db, aid, tick())[0]
  clock += 6 * DAY
  check('未到 T_approve：不超时', elevTimeouts(db, aid, tick()).did.length === 0)
  clock += 2 * DAY
  const r = elevTimeouts(db, aid, tick())
  const rej = readEvents(db, aid, { types: ['ELEV_REJECTED'] })[0]
  check('超过 T_approve=7 日：sys 写 ELEV_REJECTED(why=timeout)，提案关闭', r.did.length === 1 && rej.actor === 'sys' && rej.payload.why === 'timeout' && rej.payload.proposal_id === p.id && pendingElev(db, aid, tick()).length === 0, rej)
  check('超时后批准无效', approveElev(db, aid, p.id, tick()).reason === 'closed')
}

// E 闸失败：保持退化；无新输入不重试；有新负证据才重开
{
  const aid = agent('egate')
  const f = degenLayer(aid, 'W')
  const chat = dial({ J10: (input) => ({ ...J10(input), mapping: [] }) })
  await runElev(db, aid, tick(), { chat })
  const fe = readEvents(db, aid, { types: ['ELEV_FAILED'] })[0]
  check('E3a：命中过的 ν 没有映射 → ELEV_FAILED，不提交', !!fe && /E3a/.test(fe.payload.why) && fe.gate_report.E3a.missing.includes(f.hit) && count(aid, 'ELEV_COMMIT') === 0, fe)
  const n0 = chat.count()
  clock += 7 * DAY
  degenCheck(db, aid, tick())
  await runElev(db, aid, tick(), { chat })
  check('无新输入：不重开辩证会', chat.count() === n0)
  neg(aid, f.core, 99)
  degenCheck(db, aid, tick())
  await runElev(db, aid, tick(), { chat: dial() })
  check('有新负证据（m 增加）：重开并通过', count(aid, 'ELEV_COMMIT') === 1)
}
{
  const aid = agent('e3c')
  degenLayer(aid, 'W', '规律总会重复')
  await runElev(db, aid, tick(), { chat: dial({ J10: (input) => ({ ...J10(input), new_core: input.old_core.text }) }) })
  const fe = readEvents(db, aid, { types: ['ELEV_FAILED'] })[0]
  check('E3c：新核与旧核同文 → 不通过', !!fe && /E3c/.test(fe.payload.why), fe && fe.payload)
  const aid2 = agent('j11')
  degenLayer(aid2, 'W', '规律总会重复')
  await runElev(db, aid2, tick(), { chat: dial({ J11: [J11, { ...J11, e2: { pass: false, reason: '没有对象化' } }] }) })
  const fe2 = readEvents(db, aid2, { types: ['ELEV_FAILED'] })[0]
  check('两位判官须一致：一位否决 E2 → 不通过', !!fe2 && /E2/.test(fe2.payload.why), fe2 && fe2.payload)
  const aid3 = agent('nonu')
  degenLayer(aid3, 'W', '规律总会重复')
  await runElev(db, aid3, tick(), { chat: dial({ J10: (input) => ({ ...J10(input), nu: [] }) }) })
  const fe3 = readEvents(db, aid3, { types: ['ELEV_FAILED'] })[0]
  check('E3b：新核没登记 ν → 不通过', !!fe3 && /E3b/.test(fe3.payload.why), fe3 && fe3.payload)
  const aid4 = agent('j20')
  degenLayer(aid4, 'W', '规律总会重复')
  const c4 = dial({ J20: new Error('超时') })
  await runElev(db, aid4, tick(), { chat: c4 })
  check('J20 调不通：退回不带辩论起草，仍可提交', count(aid4, 'ELEV_COMMIT') === 1 && c4.count('J10') === 1)
}

// 没预算推迟（不花部分额度）、降级暂停
{
  const aid = agent('poor', { budget: { slow_week: 6 } })
  degenLayer(aid, 'W')
  const chat = dial()
  const r = await runElev(db, aid, tick(), { chat })
  check('慢环不足 8 单位：推迟，零调用、零事件', chat.count() === 0 && r.skipped.some((x) => x.reason === 'budget') && count(aid, 'ELEV_FAILED') === 0)
  const aid2 = agent('deg')
  degenLayer(aid2, 'W')
  const c2 = dial()
  const r2 = await runElev(db, aid2, tick(), { chat: c2, degraded: true })
  check('降级模式：暂停 E', c2.count() === 0 && r2.skipped[0].reason === 'degraded')
}

// 两核相撞超过 T_clash → E1，取 π 较低的核
{
  const aid = agent('clash')
  const a = mk(aid, 'V', 'principle', '自由最重要', 'seed')
  const b = mk(aid, 'V', 'principle', '安稳最重要', 'seed')
  put(aid, [{ type: 'EVIDENCE', actor: 'user', at: tick(), payload: { evidence: [{ kind: 'act', target_type: 'claim', target_id: b, sign: -1, weight: 0.6, ref: 'x' }] } }])
  const q = newId('questions', tick())
  const k = put(aid, [{ type: 'KAPPA_OPEN', layer: 'V', actor: 'judge', at: tick(), payload: { questions: [{ id: q, layer: 'V', text: '更该守住什么' }], kappas: [{ layer: 'V', q_id: q, pos_id: a, neg_id: b, dep: 'd', excl: 'e' }] } }]).entities.kappas[0]
  put(aid, [{ type: 'DELIBERATE', layer: 'V', actor: 'sys', at: tick(), payload: { kappa_id: k, branch: 'SUSPEND' } },
    { type: 'CORE_CLASH', layer: 'V', actor: 'sys', at: tick(), payload: { kappa_id: k } },
    { type: 'SUSPEND', layer: 'V', actor: 'sys', at: tick(), payload: { kappa_id: k } }])
  const chat = dial()
  await runElev(db, aid, tick(), { chat })
  check('相撞未满 T_clash：不触发', chat.count() === 0)
  clock += 8 * DAY
  await runElev(db, aid, tick(), { chat })
  const p = pendingElev(db, aid, tick())[0]
  check('相撞满 T_clash → 辩证会，对象化 π 较低的核', !!p && p.old_core_id === b && p.trigger === 'core_clash', p)
}

for (const aid of agents) {
  const inv = checkInvariants(loadState(db, aid))
  if (inv.length) check('不变式：' + aid, false, inv.slice(0, 2))
  const live = snapshot(db, aid)
  const pure = stateToSnapshot(fold(emptyState(), readEvents(db, aid)), aid)
  rebuild(db, aid)
  if (!same(pure, live) || !same(snapshot(db, aid), live)) check('P1 重放：' + aid, false)
}
check('不变式与 P1 重放：全部 agent 一致', true)

console.log(`\n通过 ${pass} / ${pass + fail}`)
try { db.close() } catch { /* ignore */ }
try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
process.exit(fail ? 1 : 0)
