/**
 * 三观第二组复查：审查 S5–S8 时发现的问题，每条一个回归测试。
 * 运行：node test/sangguan-g2-review.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { append, newId, readEvents } from '../src/modules/sangguan/ledger.js'
import { emptyState, fold, checkInvariants } from '../src/modules/sangguan/fold.js'
import { loadState, rebuild, snapshot, stateToSnapshot } from '../src/modules/sangguan/projection.js'
import { setSangguanConfig } from '../src/modules/sangguan/config.js'
import { settleTrials } from '../src/modules/sangguan/trial.js'
import { eligible, runNight } from '../src/modules/sangguan/deliberate.js'
import { repairHurt, checkDue, revOf, badOf } from '../src/modules/sangguan/practice.js'
import { establishCores } from '../src/modules/sangguan/core.js'
import { runMid } from '../src/modules/sangguan/night.js'
import { runFast } from '../src/modules/sangguan/fast.js'
import { fakeChat } from './sangguan-fake-llm.mjs'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 800)) }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-sg2r-'))
const db = openDb(path.join(dir, 'app.db'))
const DAY = 86400000
let clock = Date.parse('2026-11-01T08:00:00.000Z')
const tick = (min = 1) => new Date((clock += min * 60000)).toISOString()
const agents = []
function agent(name) {
  const aid = 'agt_r_' + name
  setSangguanConfig(db, aid, { enabled: true })
  agents.push(aid)
  return aid
}
const mk = (aid, layer, kind, text, origin = 'extract') => append(db, aid, [{
  type: 'CLAIM_EXP', layer, actor: 'sys', at: tick(), payload: { claims: [{ layer, kind, text, origin }] },
}]).entities.claims[0]
const W = { act: 0.6, verdict: 1, check: 1 }
const evid = (aid, id, sign, kind = 'act', at = tick()) => append(db, aid, [{
  type: 'EVIDENCE', actor: kind === 'verdict' ? 'user' : 'sys', at,
  payload: { evidence: [{ kind, target_type: 'claim', target_id: id, sign, weight: W[kind], ref: 'r:' + at + ':' + Math.random() }] },
}])
function openK(aid, layer, pos, neg, qText = '问题') {
  const at = tick()
  const q = newId('questions', at)
  return append(db, aid, [{
    type: 'KAPPA_OPEN', layer, actor: 'judge', at,
    payload: { questions: [{ id: q, layer, text: qText }], kappas: [{ layer, q_id: q, pos_id: pos, neg_id: neg, dep: 'd', excl: 'e' }] },
  }]).entities.kappas[0]
}
const suspend = (aid, layer, k) => append(db, aid, [
  { type: 'DELIBERATE', layer, actor: 'sys', at: tick(), payload: { kappa_id: k, branch: 'SUSPEND' } },
  { type: 'SUSPEND', layer, actor: 'sys', at: tick(), payload: { kappa_id: k } },
])

// ① SUB_CONFIRM 让一极进入终态时，挂着它的其他未结 κ 必须同事务关掉（P21），否则结算永远卡住
{
  const aid = agent('subconfirm')
  const A = mk(aid, 'W', 'belt', '甲说')
  const B = mk(aid, 'W', 'belt', '乙说')
  const C = mk(aid, 'W', 'belt', '丙说')
  const k1 = openK(aid, 'W', A, B)
  suspend(aid, 'W', k1)
  const k2 = openK(aid, 'W', A, C)
  const at = tick()
  const sub = newId('claims', at)
  const q2 = loadState(db, aid).kappas[k2].q_id
  append(db, aid, [
    { type: 'DELIBERATE', layer: 'W', actor: 'sys', at, payload: { kappa_id: k2, branch: 'SUB' } },
    { type: 'SUB_ACCEPT', layer: 'W', actor: 'judge', at, payload: { kappa_id: k2, claims: [{ id: sub, layer: 'W', kind: 'belt', text: '甲丙合题', origin: 'synth', pred: [A, C], q_id: q2 }] } },
  ])
  evid(aid, sub, 1, 'check')
  clock += 8 * DAY
  const r = settleTrials(db, aid, tick())
  const s = loadState(db, aid)
  check('① SUB_CONFIRM 结算成功', r.did.some((d) => d.type === 'SUB_CONFIRM') && s.kappas[k2].sigma === 'sublated', r)
  check('① 挂着已扬弃极的挂起 κ 同事务 KAPPA_OBSOLETE', s.kappas[k1].sigma === 'resolved' && s.claims[B].status === 'active', s.kappas[k1])
  check('① 不变式成立', checkInvariants(s).length === 0, checkInvariants(s))
}

// ② 并存 κ 只在 VException 或新的 Decisive 证据下重开（§2.2），普通新证据不重开
{
  const aid = agent('coex')
  const P = mk(aid, 'L', 'chapter', '先打牢基础')
  const N = mk(aid, 'L', 'chapter', '先广泛探索')
  const k = openK(aid, 'L', P, N)
  append(db, aid, [
    { type: 'DELIBERATE', layer: 'L', actor: 'sys', at: tick(), payload: { kappa_id: k, branch: 'COEX' } },
    { type: 'COEX', layer: 'L', actor: 'sys', at: tick(), payload: { kappa_id: k, loss: { lean_pole: 'pos', cost: '探索慢一点' } } },
  ])
  evid(aid, P, 1, 'act')
  const q1 = eligible(loadState(db, aid), db, aid, tick())
  check('② 并存 κ 遇普通新证据不进审议队列', !q1.some((x) => x.id === k), q1)
  for (let i = 0; i < 3; i++) evid(aid, P, 1, 'check')
  const q2 = eligible(loadState(db, aid), db, aid, tick())
  check('② 新证据使 Decisive 成立后可重开', q2.some((x) => x.id === k), { q2, s: loadState(db, aid).claims[P] })
}

// ③ 修补只针对新的核心受挫：同一批负证据不能每夜反复调 J8（否则账本每夜涨、Rev 被灌满）
{
  const aid = agent('repair')
  const core = mk(aid, 'W', 'core', '世界可以被认识', 'seed')
  evid(aid, core, -1, 'verdict')
  const chat = fakeChat({ J8: '坏' })
  const tries = () => readEvents(db, aid, { types: ['REPAIR_FAILED'] }).length
  await repairHurt(db, aid, tick(), { chat })
  clock += DAY
  await repairHurt(db, aid, tick(), { chat })
  check('③ 没有新负证据：第二夜不再修补', tries() === 1, tries())
  clock += DAY
  evid(aid, core, -1, 'check')
  await repairHurt(db, aid, tick(), { chat })
  check('③ 来了新负证据：再修补一次', tries() === 2, tries())
}

// ③b RESOLVE_CORE_BLOCKED 必须在同一审议里起草保护带修补（§6.2）
{
  const aid = agent('blocked')
  const T = mk(aid, 'L', 'telos', '做一个可靠的人', 'seed')
  const B = mk(aid, 'L', 'chapter', '这阶段先顾自己')
  const k = openK(aid, 'L', T, B)
  evid(aid, B, 1, 'verdict')
  const chat = fakeChat({
    J8: (input) => ({ text: '可靠也包括先照顾好自己', depends_core_id: input.core.id, nu: [{ expect: '两周后更从容', observe: '对话', p: 0.6, due_days: 14 }] }),
  })
  const r = await runNight(db, aid, tick(), { chat, force: true })
  const evs = readEvents(db, aid)
  check('③b 核心败方 → RESOLVE_CORE_BLOCKED', evs.some((e) => e.type === 'RESOLVE_CORE_BLOCKED' && e.payload.kappa_id === k), r)
  check('③b 同一审议内调 J8 修补保护带', chat.count('J8') === 1 && Object.values(loadState(db, aid).edges).some((e) => e.type === 'DEPENDS' && e.to_id === T), chat.count('J8'))
}

// ④ J12 调用失败 = 闸不通过：不派生跨层证据（元规则 1）
{
  const aid = agent('j12')
  const v = mk(aid, 'V', 'norm', '说实话')
  const l = mk(aid, 'L', 'chapter', '这阶段多帮朋友')
  append(db, aid, [{ type: 'EDGE_ADD', actor: 'sys', at: tick(), payload: { edges: [{ type: 'CONSTRAINS', from_id: v, to_id: l }] } }])
  evid(aid, l, -1, 'act')
  const bad = fakeChat({ J12: new Error('超时') })
  await runMid(db, aid, tick(), { chat: bad, deliberate: false, repair: false })
  const derived = () => db.prepare('SELECT COUNT(*) n FROM claim_evidence WHERE agent_id=? AND derived_from IS NOT NULL').get(aid).n
  check('④ J12 失败：零派生', derived() === 0, derived())
  const ok = fakeChat({ J12: (input) => ({ acts: [], cross: input.evidence.map((x) => ({ x_id: x.id, a_id: v })), v_exception: [] }) })
  clock += DAY
  await runMid(db, aid, tick(), { chat: ok, deliberate: false, repair: false })
  check('④ J12 归因成功：派生 1 条半权证据', derived() === 1, derived())
}

// ⑤ J5 审查要看到问题原文和合题的边界 / 预见，否则 S3「升高」无从判
{
  const aid = agent('j5')
  const P = mk(aid, 'W', 'belt', '努力通常有回报')
  const N = mk(aid, 'W', 'belt', '努力不一定有回报')
  openK(aid, 'W', P, N, '努力和回报是什么关系')
  const chat = fakeChat({
    J4: { text: '在反馈及时的领域努力更可能有回报', kept_pos: ['努力'], kept_neg: ['不一定'], dropped: ['通常'], boundary: [{ text: '反馈周期短于一月', testable: true }], nu: [{ expect: '练字一月见效', observe: '作品', p: 0.6, due_days: 20 }] },
    J5: { s1: { pass: true }, s3: { pass: true }, s4: { pass: true }, s5_hint: { pass: true } },
  })
  await runNight(db, aid, tick(), { chat, force: true, allowSub: true })
  const j5 = chat.calls.filter((c) => c.id === 'J5')
  const inp = j5[0] && j5[0].input
  check('⑤ J5 输入含问题原文', !!inp && inp.q === '努力和回报是什么关系', inp)
  check('⑤ J5 输入含新边界与预见', !!inp && (inp.boundary || []).length === 1 && (inp.nu || []).length === 1, inp)
  check('⑤ 常规档只请 1 位判官（stake < 0.8）', j5.length === 1, j5.length)
}

// ⑥ 修订的「同事务 ν」不能靠 seq+3 猜：REV 同批关了多个 κ 时 ν 仍要算进去
{
  const aid = agent('rev')
  const X = mk(aid, 'W', 'belt', '旧看法')
  for (const t of ['对手一', '对手二', '对手三']) {
    const y = mk(aid, 'W', 'belt', t)
    suspend(aid, 'W', openK(aid, 'W', X, y))
  }
  const s = loadState(db, aid)
  const at = tick()
  const nc = newId('claims', at)
  const ks = Object.values(s.kappas).filter((k) => k.sigma === 'suspended').map((k) => k.id)
  append(db, aid, [
    { type: 'REV', layer: 'W', actor: 'sys', at, payload: { old_id: X, claims: [{ id: nc, layer: 'W', kind: 'belt', text: '新看法', origin: 'extract', pred: [X] }] } },
    ...ks.map((id) => ({ type: 'KAPPA_OBSOLETE', layer: 'W', actor: 'sys', at, payload: { kappa_id: id } })),
    { type: 'NU_REGISTER', actor: 'sys', at, payload: { nus: [{ claim_id: nc, expect: '会应验', observe: '对话', p: 0.5, due_at: new Date(Date.parse(at) + 5 * DAY).toISOString() }] } },
  ])
  const st = loadState(db, aid)
  const evs = readEvents(db, aid)
  const r = revOf(st, evs, 'W').find((x) => x.claim_id === nc)
  check('⑥ REV 同批登记的 ν 被认出（pending → 不算 Bad）', !!r && badOf(r, st, evs) === false, r && { seq: r.seq })
}

// ⑦ 到期 ν 没有任何外部记录 → 直接 void，不花 J7
{
  const aid = agent('void')
  const c = mk(aid, 'W', 'obs', '明天会下雨')
  const at = tick()
  append(db, aid, [{ type: 'NU_REGISTER', actor: 'sys', at, payload: { nus: [{ claim_id: c, expect: '下雨', observe: '天气', p: 0.5, due_at: new Date(Date.parse(at) + DAY).toISOString() }] } }])
  clock += 2 * DAY
  const chat = fakeChat({ J7: { items: [] } })
  const r = await checkDue(db, aid, tick(), { chat, force: true })
  check('⑦ 无记录 → void 且零 J7', r.did.length === 1 && r.did[0].outcome === 'void' && chat.count('J7') === 0, { r, j7: chat.count('J7') })
}

// ⑧ 防灌输：同一用户对同一命题每日至多 1 条 verdict 计入（§8.1）
{
  const aid = agent('verdict')
  const c = mk(aid, 'W', 'belt', '规则保护多数人')
  const chat = fakeChat({
    J1: () => ({ candidates: [], evidence: [{ target_id: c, sign: 1, kind: 'verdict', ref_turn: 0 }], tradeoffs: [], answers: [] }),
  })
  const day = '2026-11-20'
  const run = (h) => runFast({ db, aid, at: day + 'T0' + h + ':00:00.000Z', chat, embed: async () => null }, [{ role: 'user', text: '你说得对' + h }, { role: 'assistant', text: '好' }])
  await run(1)
  await run(2)
  check('⑧ 同日两次 verdict 只计 1 条', loadState(db, aid).claims[c].n === 1, loadState(db, aid).claims[c].n)
  await runFast({ db, aid, at: '2026-11-21T01:00:00.000Z', chat, embed: async () => null }, [{ role: 'user', text: '还是对' }, { role: 'assistant', text: '好' }])
  check('⑧ 次日再计 1 条', loadState(db, aid).claims[c].n === 2, loadState(db, aid).claims[c].n)
}

// ⑨ 核心确立（§4.1）：带长成核心，DEPENDS 边改指新核
{
  const grow = (aid) => {
    const b = mk(aid, 'W', 'belt', '事情大多有原因')
    const a1 = mk(aid, 'W', 'obs', '迟到常因堵车')
    const a2 = mk(aid, 'W', 'obs', '失眠常因焦虑')
    append(db, aid, [{ type: 'EDGE_ADD', actor: 'sys', at: tick(), payload: { edges: [{ type: 'DEPENDS', from_id: a1, to_id: b }, { type: 'DEPENDS', from_id: a2, to_id: b }] } }])
    for (let i = 0; i < 4; i++) evid(aid, b, 1, 'check')
    return b
  }
  const noAid = agent('core_no')
  grow(noAid)
  const no = fakeChat({ J9: { basic: { pass: false, reason: '太具体' }, conflicts_with: [] } })
  await establishCores(db, noAid, tick(), { chat: no })
  await establishCores(db, noAid, tick(), { chat: no })
  check('⑨ J9 不通过：不确立，且判定缓存后不再花钱', !readEvents(db, noAid).some((e) => e.type === 'CORE_ESTABLISH') && no.count('J9') === 1, no.count('J9'))
  const aid = agent('core')
  const b = grow(aid)
  const yes = fakeChat({ J9: { basic: { pass: true, reason: '基本立场' }, conflicts_with: [] } })
  const r = await establishCores(db, aid, tick(), { chat: yes })
  const s = loadState(db, aid)
  const core = Object.values(s.claims).find((c) => c.kind === 'core')
  check('⑨ 满足 π/n/n_dep 且 J9 通过 → CORE_ESTABLISH', !!core && s.claims[b].status === 'superseded' && core.pred[0] === b, r)
  const deps = Object.values(s.edges).filter((e) => e.type === 'DEPENDS' && e.active)
  check('⑨ 原指向 b 的 DEPENDS 改指新核（边只增：旧边退役）', !!core && deps.length === 2 && deps.every((e) => e.to_id === core.id) && core.n_dep === 2, deps)
  const again = await establishCores(db, aid, tick(), { chat: yes })
  check('⑨ 无新候选时零调用', again.did.length === 0 && yes.count('J9') === 1, again)
}

// P1：所有 agent 重放一致
for (const aid of agents) {
  const live = snapshot(db, aid)
  const pure = stateToSnapshot(fold(emptyState(), readEvents(db, aid)), aid)
  rebuild(db, aid)
  if (!same(pure, live) || !same(snapshot(db, aid), live)) check('P1 重放：' + aid, false)
}
check('P1 重放：全部 agent 一致', true)

console.log(`\n通过 ${pass} / ${pass + fail}`)
try { db.close() } catch { /* ignore */ }
try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
process.exit(fail ? 1 : 0)
