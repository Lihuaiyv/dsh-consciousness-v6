/**
 * 三观 S5：审议骨架。A(κ) / Eq.8 / Decisive / Loser / 优先级 / plan·commit / 夜间出队。
 * 本步只落 RESOLVE / SUSPEND；P4、P10、P17、P1、没预算推迟。
 * 运行：node test/sangguan-s5.test.mjs（可设 SG_SEED）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { append, newId, readEvents, lastSeq, ConflictError } from '../src/modules/sangguan/ledger.js'
import { emptyState, fold, checkInvariants } from '../src/modules/sangguan/fold.js'
import { loadState, rebuild, snapshot, stateToSnapshot, stateAt } from '../src/modules/sangguan/projection.js'
import { setSangguanConfig } from '../src/modules/sangguan/config.js'
import {
  decisive, loserOf, userWinner, novel, actionSet, chooseBranch, prioOf, stakeOf, frozen, inhibit, subOK, coexOK,
} from '../src/modules/sangguan/gates.js'
import { plan, commit, execute, runNight, eligible } from '../src/modules/sangguan/deliberate.js'
import '../src/modules/sangguan/templates.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 800)) }
}
const near = (a, b, e = 1e-9) => Math.abs(a - b) < e
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-sg5-'))
const db = openDb(path.join(dir, 'app.db'))
const aid = 'agt_sg5'
setSangguanConfig(db, aid, { enabled: true })

let clock = Date.parse('2026-11-01T08:00:00.000Z')
const tick = (min = 1) => new Date((clock += min * 60000)).toISOString()
const DAY = 86400000
const W8 = { act: 0.6, verdict: 1, check: 1 }
const history = []
function put(evs, expect) {
  const r = append(db, aid, evs, expect)
  history.push({ seq: lastSeq(db, aid), snap: snapshot(db, aid) })
  return r
}
const claimEv = (layer, kind, text, extra = {}) => ({
  type: 'CLAIM_EXP', layer, actor: 'sys', at: tick(),
  payload: { claims: [{ layer, kind, text, origin: extra.origin || 'extract', ...extra }] },
})
const mk = (layer, kind, text, extra) => put([claimEv(layer, kind, text, extra)]).entities.claims[0]
const evid = (target_id, sign, kind, actor = 'user') => ({
  type: 'EVIDENCE', actor, at: tick(),
  payload: { evidence: [{ kind, target_type: 'claim', target_id, sign, weight: W8[kind], ref: 'turn:' + clock }] },
})
function openK(layer, pos, neg, qtext = '这件事到底怎样') {
  const at = tick()
  const q = newId('questions', at)
  const r = put([{
    type: 'KAPPA_OPEN', layer, actor: 'judge', at,
    payload: { questions: [{ id: q, layer, text: qtext }], kappas: [{ layer, q_id: q, pos_id: pos, neg_id: neg, dep: '去掉一方另一方便失去参照', excl: '同一边界下不能同真' }] },
  }])
  return { k: r.entities.kappas[0], q }
}

// ======================= 纯函数：Decisive / Loser / Eq.8 / 优先级 =======================
{
  const pos = { id: 'a', kind: 'belt', n: 2, pi: 0.1, e: 0.1, born_seq: 1 }
  const neg = { id: 'b', kind: 'belt', n: 2, pi: -0.1, e: 0.05, born_seq: 2 }
  check('Decisive：n 不够', !decisive('W', { ...pos, n: 1 }, { ...neg, n: 1 }, 3, 0.4, null))
  check('Decisive：π 差不够', !decisive('W', { ...pos, n: 2, pi: 0.1 }, { ...neg, n: 2, pi: 0 }, 3, 0.4, null))
  check('Decisive：n 与 π 差都够', decisive('W', { ...pos, n: 2, pi: 0.5 }, { ...neg, n: 2, pi: -0.2 }, 3, 0.4, null))
  check('Decisive：V 层永不因 π', !decisive('V', { ...pos, n: 5, pi: 0.9 }, { ...neg, n: 5, pi: -0.9 }, 3, 0.4, null))
  check('Decisive：用户选定（非 V）', decisive('W', pos, neg, 3, 0.4, 'a'))
  check('Decisive：V 层用户选定也不算', !decisive('V', pos, neg, 3, 0.4, 'a'))
  check('Loser：π 较低者', loserOf(pos, neg, null).id === 'b')
  check('Loser：用户裁决优先于 π', loserOf({ ...pos, pi: -0.9 }, { ...neg, pi: 0.9 }, 'a').id === 'b')
  check('userWinner：只支持一极', userWinner('W', 'a', 'b', [{ claim_id: 'a', sign: 1, day: '2026-11-01' }]) === 'a')
  check('userWinner：两边都支持则不明确', userWinner('W', 'a', 'b', [{ claim_id: 'a', sign: 1, day: 'd' }, { claim_id: 'b', sign: 1, day: 'd' }]) == null)
  check('userWinner：V 层恒空', userWinner('V', 'a', 'b', [{ claim_id: 'a', sign: 1, day: 'd' }]) == null)
  check('Novel：从未审议', novel({ last_delib_seq: null }))
  check('Novel：审议后无新输入', !novel({ last_delib_seq: 10 }, {}))
  check('Novel：审议后有新证据', novel({ last_delib_seq: 10 }, { evidence: true }))
}
{
  const th = { n_min: 3, delta_pi: 0.4, lambda: 0.3, prior_SUSPEND: 0.1, 'prior_SUB.W': 0.3, 'prior_COEX.L': 0.2, 'prior_COEX.V': 0.4 }
  const belt = { id: 'p', kind: 'belt', n: 4, pi: 0.6, e: 0.2, born_seq: 1 }
  const belt2 = { id: 'q', kind: 'belt', n: 0, pi: -0.1, e: 0.1, born_seq: 2 }
  const core = { id: 'c', kind: 'core', n: 0, pi: -0.5, e: 0.5, born_seq: 1 }
  const core2 = { id: 'd', kind: 'core', n: 4, pi: 0.6, e: 0.5, born_seq: 2 }
  const r1 = chooseBranch('W', belt, belt2, ['SUSPEND'], th, {})
  check('Eq.8：Decisive 且败方非核心 → RESOLVE', r1.branch === 'RESOLVE' && r1.forced === 'RESOLVE' && r1.winner.id === 'p', r1)
  const r2 = chooseBranch('W', belt, core, ['SUSPEND'], th, {})
  check('Eq.8：Decisive 且败方是核心 → SUSPEND + CORE_BLOCKED', r2.branch === 'SUSPEND' && r2.forced === 'RESOLVE_CORE_BLOCKED' && r2.loser.id === 'c', r2)
  const r3 = chooseBranch('W', core, core2, ['SUSPEND'], th, {})
  check('Eq.8：两极都是核心 → SUSPEND + CORE_CLASH', r3.branch === 'SUSPEND' && r3.forced === 'CORE_CLASH', r3)
  const weak = { id: 'w', kind: 'belt', n: 0, pi: 0, e: 0, born_seq: 1 }
  const weak2 = { id: 'x', kind: 'belt', n: 0, pi: 0, e: 0, born_seq: 2 }
  const r4 = chooseBranch('W', weak, weak2, ['SUSPEND', 'SUB', 'COEX'], { ...th, prior_SUSPEND: 0.2, 'prior_SUB.W': 0.2, 'prior_COEX.W': 0.2, lambda: 0 }, {})
  check('Eq.8 平局：SUSPEND ≻ COEX ≻ SUB', r4.branch === 'SUSPEND' && !r4.forced, r4)
  const r5 = chooseBranch('L', weak, weak2, ['SUSPEND', 'COEX'], { ...th, prior_SUSPEND: 0.1, 'prior_COEX.L': 0.2, lambda: 0 }, {})
  check('Eq.8：prior 高者胜', r5.branch === 'COEX', r5)
  check('A(κ)：SUSPEND 恒在，SUB/COEX 按闸', same(actionSet(false, false), ['SUSPEND']) && same(actionSet(true, true), ['SUSPEND', 'SUB', 'COEX']))
}
{
  const a = { e: 0.3 }, b = { e: 0.1 }
  check('Eq.5：age 提高优先级', prioOf(a, b, 0, 7, 7, 1) > prioOf(a, b, 0, 0, 7, 1))
  check('Eq.5：近 7 日证据提高优先级', prioOf(a, b, 2, 0, 7, 1) > prioOf(a, b, 0, 0, 7, 1))
  check('Eq.5：公式值', near(prioOf(a, b, 1, 7, 7, 1), (0.2 + 0.3) * 2 * 2 * 1))
  check('Eq.6：核心加 0.3', near(stakeOf('W', { e: 0.2, kind: 'core' }, { e: 0.1, kind: 'belt' }, 1), 0.5))
  check('Frozen：有未结升维且一极是核心', frozen('W', true, { kind: 'core' }, { kind: 'belt' }) && !frozen('W', false, { kind: 'core' }, { kind: 'belt' }))
  check('Inhibit：N_bad ≥ N_inhib', inhibit(2, 2) && !inhibit(1, 2))
  check('SubOK：缺提案或闸失败则否', !subOK(null, { ok: true }, 'W', false, false, false) && subOK({}, { ok: true }, 'W', false, false, false))
  check('CoexOK：W 恒否，V 看不可通约', !coexOK('W', { pi: 1 }, { pi: 1 }, { incommensurable: true, loss: 'x' }) && coexOK('V', { pi: 0 }, { pi: 0 }, { incommensurable: true, loss: 'x' }))
}

// ======================= plan 只读 / commit 写入 =======================
const w1 = mk('W', 'belt', '努力通常会有回报')
const w2 = mk('W', 'belt', '结果主要靠运气')
const { k: k1 } = openK('W', w1, w2, '成败主要由什么决定')
const seqOpen = lastSeq(db, aid)
{
  const now = tick()
  const p = plan(db, aid, k1, now)
  check('plan：只读，不写账本', lastSeq(db, aid) === seqOpen && p.ok && p.kappa_id === k1, p)
  check('plan：刚开立即 Novel，默认 SUSPEND', p.novel && p.branch === 'SUSPEND' && p.A[0] === 'SUSPEND', p)
  check('plan：带 expect（I5）', p.expect.kappas[k1] === 'struggle' && p.expect.claims[w1] === 'contested', p.expect)
  const r = commit(db, aid, p, {}, now)
  const st = loadState(db, aid)
  check('commit：SUSPEND 后 κ 挂起、两极回 active', r.ok && st.kappas[k1].sigma === 'suspended' && st.claims[w1].status === 'active' && st.claims[w2].status === 'active', { r, sig: st.kappas[k1].sigma })
  check('commit：写了 DELIBERATE + SUSPEND', readEvents(db, aid).filter((e) => e.seq > seqOpen).map((e) => e.type).join(',') === 'DELIBERATE,SUSPEND')
}
{
  const now = tick()
  const p = plan(db, aid, k1, now)
  check('P10 预备：无新证据则不再 Novel', p.ok && !p.novel, p)
  const seq1 = lastSeq(db, aid)
  const r = commit(db, aid, p, {}, now)
  check('非 Novel 不写 DELIBERATE', !r.ok && r.reason === 'not_novel' && lastSeq(db, aid) === seq1, r)
}

// 加证据使 Decisive，重开后 RESOLVE
put([evid(w1, 1, 'verdict')])
put([evid(w1, 1, 'act')])
put([evid(w2, -1, 'act')])
{
  const now = tick()
  const p = plan(db, aid, k1, now)
  check('新证据 → Novel 且 Decisive → RESOLVE', p.ok && p.novel && p.branch === 'RESOLVE' && p.winner_id === w1 && p.loser_id === w2, p)
  const r = commit(db, aid, p, {}, now)
  const st = loadState(db, aid)
  check('RESOLVE：胜方 active、败方 falsified、κ resolved', r.ok && st.claims[w1].status === 'active' && st.claims[w2].status === 'falsified' && st.kappas[k1].sigma === 'resolved', st.kappas[k1])
}

// 用户裁决：证据不够 π 差，但 user verdict 选定一极
const u1 = mk('L', 'chapter', '这个月先把身体养好')
const u2 = mk('L', 'chapter', '这个月先把项目做完')
const { k: kU } = openK('L', u1, u2, '这阵子该怎么过')
put([evid(u1, 1, 'verdict', 'user')])
{
  const p = plan(db, aid, kU, tick())
  check('用户裁决触发 Decisive（n 不足仍选定）', p.branch === 'RESOLVE' && p.winner_id === u1 && p.winner_user === u1, p)
  check('同一用户同一命题当日第二条 verdict 不计（防灌输）', (() => {
    put([evid(u2, 1, 'verdict', 'user')])
    put([evid(u1, 1, 'verdict', 'user')]) // 同日同命题，应被滤过
    const p2 = plan(db, aid, kU, tick())
    return p2.winner_user === u1 || p2.winner_user == null || p2.winner_id === u1
  })())
  commit(db, aid, plan(db, aid, kU, tick()), {}, tick())
}

// V 层 verdict 不触发 Decisive
const v1 = mk('V', 'norm', '说话要诚实')
const v2 = mk('V', 'norm', '说话要体贴')
const { k: kV } = openK('V', v1, v2, '真话与体贴冲突时怎么办')
put([evid(v1, 1, 'verdict', 'user')])
put([evid(v1, 1, 'act')])
put([evid(v1, 1, 'act')])
put([evid(v2, -1, 'act')])
{
  const p = plan(db, aid, kV, tick())
  check('P23 预备：V 层即使用户裁决也不 RESOLVE', p.branch === 'SUSPEND' && !p.decisive, p)
  commit(db, aid, p, {}, tick())
}

// 核心受挫：Decisive 但败方是核心
const belt = mk('W', 'belt', '秩序只靠自觉')
const core = mk('W', 'core', '秩序依赖可见的约束', { origin: 'seed' })
const { k: kC } = openK('W', belt, core, '秩序靠什么')
for (let i = 0; i < 3; i++) put([evid(belt, 1, 'verdict')])
put([evid(core, -1, 'act')])
{
  const p = plan(db, aid, kC, tick())
  check('败方是核心 → 不 RESOLVE，记 RESOLVE_CORE_BLOCKED', p.branch === 'SUSPEND' && p.forced === 'RESOLVE_CORE_BLOCKED' && p.loser_id === core, p)
  const before = lastSeq(db, aid)
  commit(db, aid, p, {}, tick())
  const types = readEvents(db, aid).filter((e) => e.seq > before).map((e) => e.type)
  check('核心受挫批次含 RESOLVE_CORE_BLOCKED + SUSPEND', types.includes('RESOLVE_CORE_BLOCKED') && types.includes('SUSPEND') && !types.includes('RESOLVE'), types)
}

// 两核相争
const c1 = mk('L', 'telos', '陪伴用户一起成长', { origin: 'seed' })
const c2 = mk('L', 'telos', '把好奇心保持下去', { origin: 'seed' })
const { k: kCC } = openK('L', c1, c2, '哪个志向更根本')
{
  const p = plan(db, aid, kCC, tick())
  check('两核 → CORE_CLASH + SUSPEND', p.branch === 'SUSPEND' && p.forced === 'CORE_CLASH', p)
  const before = lastSeq(db, aid)
  commit(db, aid, p, {}, tick())
  check('CORE_CLASH 已入账', readEvents(db, aid).some((e) => e.seq > before && e.type === 'CORE_CLASH'))
}

// I5：plan 之后状态变了，commit 整批回滚
{
  const a = mk('W', 'obs', '城市夜里很安静')
  const b = mk('W', 'obs', '城市夜里很吵')
  const { k } = openK('W', a, b, '夜里到底怎样')
  const p = plan(db, aid, k, tick())
  put([{ type: 'SUSPEND', layer: 'W', actor: 'sys', at: tick(), payload: { kappa_id: k } }])
  const seq0 = lastSeq(db, aid)
  try {
    commit(db, aid, p, {}, tick())
    check('I5 expect 不符应抛错', false)
  } catch (e) {
    check('I5 expect 不符整批回滚', e instanceof ConflictError && e.code === 'EXPECT' && lastSeq(db, aid) === seq0, { code: e.code, seq: lastSeq(db, aid) })
  }
}

// ======================= 夜间出队：≤N_delib、至少 1、P10、P4、P17 =======================
const nightAid = 'agt_sg5n'
setSangguanConfig(db, nightAid, { enabled: true })
function mkN(layer, kind, text, extra) {
  return append(db, nightAid, [{ type: 'CLAIM_EXP', layer, actor: 'sys', at: tick(), payload: { claims: [{ layer, kind, text, origin: extra && extra.origin || 'extract', ...extra }] } }]).entities.claims[0]
}
function openN(pos, neg, qtext) {
  const at = tick()
  const q = newId('questions', at)
  return append(db, nightAid, [{
    type: 'KAPPA_OPEN', layer: 'W', actor: 'judge', at,
    payload: { questions: [{ id: q, layer: 'W', text: qtext }], kappas: [{ layer: 'W', q_id: q, pos_id: pos, neg_id: neg, dep: 'd', excl: 'e' }] },
  }]).entities.kappas[0]
}

const ks = []
const openedAt = []
for (let i = 0; i < 5; i++) {
  const a = mkN('W', 'belt', '说法甲' + i)
  const b = mkN('W', 'obs', '说法乙' + i)
  openedAt.push(tick())
  ks.push(openN(a, b, '问' + i))
}
{
  const now = tick()
  const q = eligible(loadState(db, nightAid), db, nightAid, now)
  check('待审队列按 prio 再按 t_open', q.length === 5 && q.every((x, i) => i === 0 || q[i - 1].prio > x.prio + 1e-12 || q[i - 1].opened_at <= x.opened_at), q.map((x) => x.id))
  const n1 = await runNight(db, nightAid, now)
  check('每夜至多 N_delib（默认 3）', n1.did.length === 3 && n1.take.length === 3, n1)
  check('P4：审议后无命题同属两个 struggle', checkInvariants(loadState(db, nightAid)).filter((x) => x.code === 'I4').length === 0, checkInvariants(loadState(db, nightAid)))
  const n2 = await runNight(db, nightAid, tick())
  check('剩余待审次夜继续，仍 ≤ N_delib', n2.did.length === 2, n2)
  const left = Object.values(loadState(db, nightAid).kappas).filter((k) => ks.includes(k.id) && k.sigma === 'struggle')
  check('五件都离开 struggle（本步只有 SUSPEND）', left.length === 0, left)
}
{
  // P10：无 Novel 时连续两夜不产生新 DELIBERATE
  const seq0 = lastSeq(db, nightAid)
  const a = await runNight(db, nightAid, tick())
  const b = await runNight(db, nightAid, tick())
  const delib = readEvents(db, nightAid).filter((e) => e.seq > seq0 && e.type === 'DELIBERATE')
  check('P10：无 Novel 输入时连续两夜不产生新 DELIBERATE', delib.length === 0 && a.did.length === 0 && b.did.length === 0, { delib: delib.length, a: a.did, b: b.did })
}

// P17 有限占用：N_delib=1，9 个待审，每夜 1 次，最慢的 contested ≤ 9 夜
{
  const p17 = 'agt_p17'
  setSangguanConfig(db, p17, { enabled: true })
  const ids = []
  const t0 = []
  for (let i = 0; i < 9; i++) {
    const a = append(db, p17, [{ type: 'CLAIM_EXP', layer: 'W', actor: 'sys', at: tick(), payload: { claims: [{ layer: 'W', kind: 'belt', text: 'p17a' + i, origin: 'extract' }] } }]).entities.claims[0]
    const b = append(db, p17, [{ type: 'CLAIM_EXP', layer: 'W', actor: 'sys', at: tick(), payload: { claims: [{ layer: 'W', kind: 'obs', text: 'p17b' + i, origin: 'extract' }] } }]).entities.claims[0]
    const at = tick()
    const q = newId('questions', at)
    t0.push(Date.parse(at))
    ids.push(append(db, p17, [{
      type: 'KAPPA_OPEN', layer: 'W', actor: 'judge', at,
      payload: { questions: [{ id: q, layer: 'W', text: 'p17q' + i }], kappas: [{ layer: 'W', q_id: q, pos_id: a, neg_id: b, dep: 'd', excl: 'e' }] },
    }]).entities.kappas[0])
  }
  append(db, p17, [{ type: 'THETA_ADJUST', actor: 'sys', at: tick(), payload: { key: 'N_delib', value: 1 } }])
  const released = {}
  for (let night = 0; night < 12; night++) {
    clock += DAY
    const r = await runNight(db, p17, new Date(clock).toISOString())
    const st = loadState(db, p17)
    for (const id of ids) {
      if (released[id]) continue
      if (st.kappas[id] && st.kappas[id].sigma !== 'struggle') released[id] = clock
    }
    if (r.did.length === 0 && Object.keys(released).length === ids.length) break
  }
  const boundNights = Math.ceil(9 / 1)
  const waits = ids.map((id, i) => (released[id] - t0[i]) / DAY)
  check('P17：9 件待审、N_delib=1，全部在 ⌈|Q|/N⌉ 夜内离开 struggle', ids.every((id) => released[id]) && Math.max(...waits) <= boundNights + 0.1, { waits, boundNights, n: Object.keys(released).length })
  check('P17：每夜至少审议 1 次（有待审时）', waits.filter((w) => w >= 0).length === 9, waits)
  check('P4 全程：P17 夹具不变式成立', checkInvariants(loadState(db, p17)).length === 0, checkInvariants(loadState(db, p17)))
}

// 开关关闭
{
  const off = 'agt_off'
  const a = append(db, off, [{ type: 'CLAIM_EXP', layer: 'W', actor: 'sys', at: tick(), payload: { claims: [{ layer: 'W', kind: 'belt', text: '关', origin: 'extract' }] } }]).entities.claims[0]
  const b = append(db, off, [{ type: 'CLAIM_EXP', layer: 'W', actor: 'sys', at: tick(), payload: { claims: [{ layer: 'W', kind: 'obs', text: '开', origin: 'extract' }] } }]).entities.claims[0]
  const atOff = tick()
  const qOff = newId('questions', atOff)
  append(db, off, [{
    type: 'KAPPA_OPEN', layer: 'W', actor: 'judge', at: atOff,
    payload: { questions: [{ id: qOff, layer: 'W', text: 'q' }], kappas: [{ layer: 'W', q_id: qOff, pos_id: a, neg_id: b, dep: 'd', excl: 'e' }] },
  }])
  const seq0 = lastSeq(db, off)
  const r = await runNight(db, off, tick())
  check('开关关闭：夜间审议直接返回，零写入', r.status === 'off' && lastSeq(db, off) === seq0, r)
}

// 没预算：有模型调用时推迟，不写 DELIBERATE
{
  const bd = 'agt_budget'
  setSangguanConfig(db, bd, { enabled: true, budget: { mid: 0, floor: 0, fast: 0, reserve: 0 } })
  const a = append(db, bd, [{ type: 'CLAIM_EXP', layer: 'W', actor: 'sys', at: tick(), payload: { claims: [{ layer: 'W', kind: 'belt', text: '有预算吗', origin: 'extract' }] } }]).entities.claims[0]
  const b = append(db, bd, [{ type: 'CLAIM_EXP', layer: 'W', actor: 'sys', at: tick(), payload: { claims: [{ layer: 'W', kind: 'obs', text: '没有', origin: 'extract' }] } }]).entities.claims[0]
  const atBd = tick()
  const qBd = newId('questions', atBd)
  const kid = append(db, bd, [{
    type: 'KAPPA_OPEN', layer: 'W', actor: 'judge', at: atBd,
    payload: { questions: [{ id: qBd, layer: 'W', text: 'q' }], kappas: [{ layer: 'W', q_id: qBd, pos_id: a, neg_id: b, dep: 'd', excl: 'e' }] },
  }]).entities.kappas[0]
  const p = plan(db, bd, kid, tick())
  p.calls = [{ id: 'J2', input: { text: 'x', neighbors: [] }, pool: 'mid', tier: 'T1' }]
  const seq0 = lastSeq(db, bd)
  const r = await execute(db, bd, p, tick(), { chat: async () => { throw new Error('不该调到') } })
  check('没预算就推迟，不写 DELIBERATE', r.postponed && r.reason === 'budget' && lastSeq(db, bd) === seq0, r)
}

// P1 重放
{
  const live = snapshot(db, aid)
  check('P1 纯折叠 = 增量投影', same(stateToSnapshot(fold(emptyState(), readEvents(db, aid)), aid), live))
  rebuild(db, aid)
  check('P1 rebuild 后相等', same(snapshot(db, aid), live))
  let prefixOk = true
  for (const h of history) {
    if (!same(stateToSnapshot(stateAt(db, aid, h.seq), aid), h.snap)) { prefixOk = false; break }
  }
  check('P1 任意前缀重放一致', prefixOk && history.length > 8, { n: history.length })
}

// ======================= 模糊模拟 =======================
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
{
  const SEED = Number(process.env.SG_SEED) || 20261101
  const rnd = mulberry32(SEED)
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)]
  const F = 'agt_fuzz5'
  setSangguanConfig(db, F, { enabled: true })
  const KINDS = { W: ['belt', 'obs'], L: ['chapter', 'role'], V: ['norm', 'ideal'] }
  const bugs = []
  const tally = { night: 0, did: 0, postponed: 0, skip: 0, rej: {} }
  for (let i = 0; i < 80; i++) {
    const s = loadState(db, F)
    const layer = pick(['W', 'L', 'V'])
    const live = Object.values(s.claims).filter((c) => c.layer === layer && c.status === 'active')
    const at = tick(30)
    try {
      if (rnd() < 0.45 || live.length < 2) {
        append(db, F, [{ type: 'CLAIM_EXP', layer, actor: 'sys', at, payload: { claims: [{ layer, kind: pick(KINDS[layer]), text: 'fz5-' + i, origin: 'extract' }] } }])
      } else if (rnd() < 0.6) {
        const [a, b] = [pick(live), pick(live)].sort((x, y) => x.born_seq - y.born_seq)
        if (a.id === b.id) continue
        const q = newId('questions', at)
        append(db, F, [{ type: 'KAPPA_OPEN', layer, actor: 'judge', at, payload: { questions: [{ id: q, layer, text: 'q' + i }], kappas: [{ layer, q_id: q, pos_id: a.id, neg_id: b.id, dep: 'd', excl: 'e' }] } }])
      } else {
        const c = pick(live)
        append(db, F, [{ type: 'EVIDENCE', actor: pick(['user', 'user', 'sys']), at, payload: { evidence: [{ kind: pick(['act', 'verdict']), target_type: 'claim', target_id: c.id, sign: pick([1, 1, -1]), weight: pick([0.6, 1]), ref: 'fz' + i }] } }])
      }
    } catch (e) {
      const key = (e.code || 'X') + ' ' + e.message
      tally.rej[key] = (tally.rej[key] || 0) + 1
    }
    if (rnd() < 0.35) {
      clock += DAY
      try {
        const r = await runNight(db, F, new Date(clock).toISOString())
        tally.night++
        tally.did += r.did.length
        tally.postponed += r.postponed.length
        tally.skip += r.skipped.length
      } catch (e) {
        bugs.push({ i, msg: String(e && e.message) })
      }
    }
    const inv = checkInvariants(loadState(db, F))
    if (inv.length) bugs.push({ i, inv: inv.slice(0, 2) })
  }
  check('模糊（种子 ' + SEED + '）：无非预期异常、不变式全程成立', bugs.length === 0, bugs.slice(0, 3))
  check('模糊：夜间审议跑过且有成交', tally.night > 5 && tally.did > 0, tally)
  const before = JSON.stringify(snapshot(db, F))
  rebuild(db, F)
  check('模糊：P1 重放一致', JSON.stringify(snapshot(db, F)) === before)
  console.log('  模糊覆盖：', JSON.stringify(tally))
}

// I15：gates 审议谓词仍不读时钟、不碰账本
{
  const src = (f) => fs.readFileSync(new URL('../src/modules/sangguan/' + f, import.meta.url), 'utf8')
  check('I15 gates 仍不读时钟、不 import 账本', !/Date\.now\(|new Date\(\)/.test(src('gates.js')) && !/from '\.\/(llm|ledger|projection|budget|deliberate)\.js'/.test(src('gates.js')))
  check('I15 fold 不依赖审议模块', !/from '\.\/(deliberate|fast|gates)\.js'/.test(src('fold.js')))
}

console.log(`\n通过 ${pass} / ${pass + fail}`)
try { db.close() } catch { /* ignore */ }
try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
process.exit(fail ? 1 : 0)
