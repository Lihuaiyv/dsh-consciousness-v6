/**
 * 三观 S2：projection.apply / rebuild（状态机表驱动）。
 * P1 重放（含任意时刻前缀）、P8 终态、结构守卫（I4 / I9 / P12 / P21 / P9）、I5 expect、I15 纯函数、模糊模拟。
 * 运行：node test/sangguan-s2.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { append, newId, readEvents, lastSeq, SangguanError, ConflictError } from '../src/modules/sangguan/ledger.js'
import { emptyState, apply, fold, checkInvariants } from '../src/modules/sangguan/fold.js'
import { loadState, rebuild, snapshot, stateToSnapshot, stateAt, listHeads, derivedCounts } from '../src/modules/sangguan/projection.js'
import { isTerminal, TERMINAL } from '../src/modules/sangguan/catalog.js'
import { THETA } from '../src/modules/sangguan/theta.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 600)) }
}
const near = (a, b) => Math.abs(a - b) < 1e-12
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-sg2-'))
const db = openDb(path.join(dir, 'app.db'))
const aid = 'agt_sg2'

let clock = Date.parse('2026-11-01T08:00:00.000Z')
const tick = (min = 1) => new Date((clock += min * 60000)).toISOString()
const DAY = 86400000
const W8 = { act: 0.6, verdict: 1, check: 1 }

const history = [] // 每次成功写入后的 { seq, snap }，用于前缀重放
function put(evs, expect) {
  const r = append(db, aid, evs, expect)
  history.push({ seq: lastSeq(db, aid), snap: snapshot(db, aid) })
  return r
}
const claimEv = (layer, kind, text, extra = {}) => ({
  type: 'CLAIM_EXP', layer, actor: 'sys', at: tick(),
  payload: { claims: [{ layer, kind, text, origin: 'extract', ...extra }] },
})
const mk = (layer, kind, text, extra) => put([claimEv(layer, kind, text, extra)]).entities.claims[0]
const evid = (target_id, sign, kind, target_type = 'claim', actor = 'user') => ({
  type: 'EVIDENCE', actor, at: tick(),
  payload: { evidence: [{ kind, target_type, target_id, sign, weight: W8[kind], ref: 'turn:' + clock }] },
})
const ev = (type, layer, payload, actor = 'sys') => ({ type, layer, actor, at: tick(), payload })
function openK(layer, pos, neg, qtext = '这件事到底怎样') {
  const at = tick()
  const q = newId('questions', at)
  const r = put([{
    type: 'KAPPA_OPEN', layer, actor: 'judge', at,
    payload: { questions: [{ id: q, layer, text: qtext }], kappas: [{ layer, q_id: q, pos_id: pos, neg_id: neg, dep: '去掉一方另一方失去参照', excl: '同一边界下不能同真' }] },
  }])
  return { k: r.entities.kappas[0], q }
}
function rejects(name, evs, code, expect) {
  const seq0 = lastSeq(db, aid)
  const snap0 = JSON.stringify(snapshot(db, aid))
  try {
    append(db, aid, evs, expect)
    check(name, false, '没有抛错')
  } catch (e) {
    const cls = code === 'EXPECT' ? ConflictError : SangguanError
    const ok = e instanceof cls && e.code === code
    check(name, ok && lastSeq(db, aid) === seq0 && JSON.stringify(snapshot(db, aid)) === snap0, { code: e.code, msg: e.message })
  }
}

// ======================= 夹具：三层事件流 =======================
// —— W：两说对峙 → 挂起 → 重开 → 合题试用 → 预见命中 → 确认
const w1 = mk('W', 'belt', '努力通常会有回报')
const w2 = mk('W', 'belt', '结果主要靠运气')
const { k: k1, q: q1 } = openK('W', w1, w2, '成败主要由什么决定')
put([evid(w1, 1, 'verdict')])
put([evid(w1, 1, 'act')])
put([evid(w2, -1, 'act')])
put([ev('DELIBERATE', 'W', { kappa_id: k1, branch: 'SUSPEND' }), ev('SUSPEND', 'W', { kappa_id: k1, missing: 'evidence' })])
const subAt = tick()
const w3 = newId('claims', subAt)
const nu1 = newId('nus', subAt)
put([
  ev('REOPEN', 'W', { kappa_id: k1 }),
  ev('DELIBERATE', 'W', { kappa_id: k1, branch: 'SUB' }),
  { type: 'SUB_ACCEPT', layer: 'W', actor: 'judge', at: subAt, payload: { kappa_id: k1, claims: [{ id: w3, layer: 'W', kind: 'belt', text: '努力决定下限，运气决定上限', origin: 'synth', pred: [w1, w2], q_id: q1 }] } },
  { type: 'NU_REGISTER', actor: 'judge', at: subAt, payload: { nus: [{ id: nu1, claim_id: w3, expect: '持续练习的人很少跌出平均线', observe: '用户的练习记录', p: 0.7, due_at: new Date(Date.parse(subAt) + 10 * DAY).toISOString() }] } },
])
put([evid(nu1, 1, 'check', 'nu', 'judge')])
put([ev('NU_RESOLVE', null, { nu_id: nu1, outcome: 'hit' }, 'judge')])
put([ev('SUB_CONFIRM', 'W', { kappa_id: k1 })])
// —— W：证伪、改写、核心确立、升维换代
const w4 = mk('W', 'obs', '城市夜里很安静')
put([ev('CON', 'W', { claim_id: w4, by: 'verdict' }, 'user')])
const w5 = mk('W', 'belt', '规则通常会被遵守')
const w6 = put([{ type: 'REV', layer: 'W', actor: 'sys', at: tick(), payload: { old_id: w5, claims: [{ layer: 'W', kind: 'belt', text: '规则在有人监督时会被遵守', origin: 'extract', pred: [w5] }] } }]).entities.claims[0]
const wc1 = put([{ type: 'CORE_ESTABLISH', layer: 'W', actor: 'judge', at: tick(), payload: { from_id: w6, claims: [{ layer: 'W', kind: 'core', text: '秩序依赖可见的约束', origin: 'extract', pred: [w6] }] } }]).entities.claims[0]
const e1 = put([{ type: 'EDGE_ADD', actor: 'sys', at: tick(), payload: { edges: [{ type: 'DEPENDS', from_id: w3, to_id: wc1 }] } }]).entities.edges[0]
const elevAt = tick()
const wc2 = newId('claims', elevAt)
put([
  { type: 'ELEV_COMMIT', layer: 'W', actor: 'user', at: elevAt, payload: { old_core_id: wc1, scope: '小群体、低匿名度的场合', claims: [{ id: wc2, layer: 'W', kind: 'core', text: '秩序来自激励与可见约束的合力', origin: 'elev', pred: [wc1] }] } },
  { type: 'EDGE_RETIRE', actor: 'sys', at: elevAt, payload: { edge_id: e1 } },
  { type: 'EDGE_ADD', actor: 'sys', at: elevAt, payload: { edges: [{ type: 'DEPENDS', from_id: w3, to_id: wc2 }] } },
  { type: 'REVIEW_FLAG', actor: 'sys', at: elevAt, payload: { claim_id: w3 } },
])
// —— L：seed 志向作核心、章节依存、重复提及
const l1 = mk('L', 'telos', '陪伴用户一起成长', { origin: 'seed' })
const l2 = mk('L', 'chapter', '这个月专注把项目做完')
put([{ type: 'EDGE_ADD', actor: 'sys', at: tick(), payload: { edges: [{ type: 'DEPENDS', from_id: l2, to_id: l1 }] } }])
put([ev('DUP', 'L', { claim_id: l2 })])
// —— L：合题试用失败 → 回滚（withdrawn）
const l3 = mk('L', 'chapter', '先把身体养好')
const l4 = mk('L', 'role', '做团队里最拼的人')
const { k: k4, q: q4 } = openK('L', l3, l4, '这阵子该怎么过')
const lc = put([{ type: 'SUB_ACCEPT', layer: 'L', actor: 'judge', at: tick(), payload: { kappa_id: k4, claims: [{ layer: 'L', kind: 'chapter', text: '在不透支的前提下全力以赴', origin: 'synth', pred: [l3, l4], q_id: q4 }] } }]).entities.claims[0]
put([ev('SUB_ROLLBACK', 'L', { kappa_id: k4, why: 'π ≤ 0' })])
// —— V：价值冲突 → 并存 + 损失 → 取舍
const v1 = mk('V', 'norm', '说话要诚实')
const v2 = mk('V', 'norm', '说话要体贴')
const { k: k2, q: q2 } = openK('V', v1, v2, '真话与体贴冲突时怎么办')
put([ev('DELIBERATE', 'V', { kappa_id: k2, branch: 'COEX' }), ev('COEX', 'V', { kappa_id: k2, loss: '这次偏向诚实，付出了对方的难堪' })])
put([ev('TRADEOFF', 'V', { kappa_id: k2, lean_pole: 'pos', cost: '对方沉默了一会儿', ref: 'turn:42' })])
// —— Θ 与运维
put([ev('THETA_ADJUST', null, { key: 'n_min', value: 3.3, old: 3, metric: 'churn', window: '30d' })])
put([ev('THETA_ADJUST', null, { key: 'delta_pi', value: 0.5, scope: 'q:' + q2, old: 0.4 })])
put([{ type: 'JOB_DONE', actor: 'sys', at: tick(), job_key: 'sg:night:2026-11-01', payload: {} }])

// ======================= 夹具结果 =======================
let st = loadState(db, aid)
const C = (id) => st.claims[id]
const pi1 = 0.2 + 0.2 * 0.6 * (1 - 0.2)
check('π：verdict 后 act 叠加', near(C(w1).pi, pi1) && C(w1).n === 2, C(w1))
check('π：反证下降', near(C(w2).pi, -0.25 * 0.6) && C(w2).n === 1, C(w2))
check('π：ν 上的证据计入命题', near(C(w3).pi, 0.2) && C(w3).n === 1 && C(w3).last_ev_at != null, C(w3))
check('SUB_CONFIRM：两极 sublated', C(w1).status === 'sublated' && C(w2).status === 'sublated')
check('SUB_CONFIRM：合题转 active', C(w3).status === 'active' && C(w3).review === 1)
check('κ1 sublated 且已结', st.kappas[k1].sigma === 'sublated' && st.kappas[k1].closed_at != null && st.kappas[k1].sub_id === w3, st.kappas[k1])
check('κ1 试用期 = SUB_ACCEPT + 7 日', st.kappas[k1].trial_until === new Date(Date.parse(subAt) + 7 * DAY).toISOString())
check('κ1 记录最近审议', st.kappas[k1].last_delib_seq > 0)
check('ν 命中', st.nus[nu1].outcome === 'hit' && st.nus[nu1].resolved_at != null)
check('CON → falsified', C(w4).status === 'falsified')
check('REV → 旧 superseded，新 active', C(w5).status === 'superseded' && C(w6).status === 'superseded' && C(wc1).status === 'demoted')
check('ELEV：旧核 demoted、新核 active', C(wc1).status === 'demoted' && C(wc2).status === 'active' && C(wc2).kind === 'core')
check('纪元：新核属于新纪元', C(wc1).epoch === 0 && C(wc2).epoch === 1 && st.epoch.W === 1 && st.epoch.L === 0)
check('n_dep / e：边退役后归零', C(wc1).n_dep === 0 && near(C(wc1).e, 0.5))
check('n_dep / e：新核被依存', C(wc2).n_dep === 1 && near(C(wc2).e, 0.5 + 0.2 * Math.tanh(1 / 3)), C(wc2))
check('L：seed 志向即核心', C(l1).status === 'active' && C(l1).kind === 'telos' && near(C(l1).e, 0.5 + 0.2 * Math.tanh(1 / 3)))
check('DUP 只记提及不改 π', C(l2).mentions === 1 && C(l2).pi === 0 && C(l2).n === 0)
check('SUB_ROLLBACK：合题 withdrawn、两极回 active、κ 挂起', C(lc).status === 'withdrawn' && C(l3).status === 'active' && C(l4).status === 'active' && st.kappas[k4].sigma === 'suspended' && st.kappas[k4].closed_at == null)
check('V：并存后两极回 active', st.kappas[k2].sigma === 'coexist' && C(v1).status === 'active' && C(v2).status === 'active')
check('Θ 全局调整', st.theta['n_min@*'].value === 3.3)
check('Θ 按问题调整', st.theta['delta_pi@q:' + q2].value === 0.5)
const heads = Object.fromEntries(['W', 'L', 'V'].map((l) => [l, listHeads(db, aid, l).map((h) => h.id).sort()]))
check('链头 W = 合题 + 新核', same(heads.W, [w3, wc2].sort()), heads.W)
check('链头 L / V（回滚后两极重回链头）', same(heads.L, [l1, l2, l3, l4].sort()) && same(heads.V, [v1, v2].sort()), heads)
check('链头带正文', listHeads(db, aid, 'W').every((h) => typeof h.text === 'string' && h.text.length > 0))
const cnt = derivedCounts(db, aid)
check('I3 计数从事件派生：g_turn / g_prog', cnt.g_turn.W === 1 && cnt.g_prog.W === 1 && cnt.g_turn.V === 0 && cnt.epoch.W === 1, cnt)
check('不变式成立', checkInvariants(st).length === 0, checkInvariants(st))

// ======================= P8 终态 / 结构守卫 =======================
rejects('P8 已证伪不能再 CON', [ev('CON', 'W', { claim_id: w4 })], 'TRANSITION')
rejects('P8 已 sublated 不能被 REV', [{ type: 'REV', layer: 'W', actor: 'sys', at: tick(), payload: { old_id: w1, claims: [{ layer: 'W', kind: 'belt', text: '复活旧说', origin: 'extract', pred: [w1] }] } }], 'TRANSITION')
rejects('P8 终态命题不能入 κ', [(() => { const at = tick(); const q = newId('questions', at); return { type: 'KAPPA_OPEN', layer: 'W', actor: 'judge', at, payload: { questions: [{ id: q, layer: 'W', text: 'x' }], kappas: [{ layer: 'W', q_id: q, pos_id: w5, neg_id: w3, dep: 'd', excl: 'e' }] } } })()], 'TRANSITION')
rejects('P8 已结 κ 不能再挂起', [ev('SUSPEND', 'W', { kappa_id: k1 })], 'TRANSITION')
rejects('P8 ν 不能二次解决', [ev('NU_RESOLVE', null, { nu_id: nu1, outcome: 'miss' })], 'TRANSITION')
rejects('P8 demoted 旧核不能再升维', [{ type: 'ELEV_COMMIT', layer: 'W', actor: 'user', at: tick(), payload: { old_core_id: wc1, scope: 's', claims: [{ layer: 'W', kind: 'core', text: '再来一次', origin: 'elev' }] } }], 'TRANSITION')
rejects('P12 核心不能被 CON', [ev('CON', 'W', { claim_id: wc2 })], 'TRANSITION')
rejects('I9 跨层不能改状态', [ev('CON', 'L', { claim_id: w3 })], 'TRANSITION')
const w7 = mk('W', 'belt', '制度比个人更可靠')
const { k: k3 } = openK('W', wc2, w7, '秩序靠什么')
check('κ3 开立：两极 contested', loadState(db, aid).claims[w7].status === 'contested' && loadState(db, aid).claims[wc2].status === 'contested')
rejects('I4 已在交锋中的命题不能再开 κ', [(() => { const at = tick(); const q = newId('questions', at); return { type: 'KAPPA_OPEN', layer: 'W', actor: 'judge', at, payload: { questions: [{ id: q, layer: 'W', text: 'x' }], kappas: [{ layer: 'W', q_id: q, pos_id: w3, neg_id: w7, dep: 'd', excl: 'e' }] } } })()], 'TRANSITION')
rejects('P12 RESOLVE 不能证伪核心', [ev('RESOLVE', 'W', { kappa_id: k3, winner_id: w7, loser_id: wc2 })], 'TRANSITION')
rejects('RESOLVE 胜败须是两极', [ev('RESOLVE', 'W', { kappa_id: k3, winner_id: w7, loser_id: w3 })], 'TRANSITION')
rejects('合题须指回两极', [{ type: 'SUB_ACCEPT', layer: 'W', actor: 'judge', at: tick(), payload: { kappa_id: k3, claims: [{ layer: 'W', kind: 'belt', text: '只留一边', origin: 'synth', pred: [w7], q_id: 'q_x' }] } }], 'TRANSITION')
put([ev('SUSPEND', 'W', { kappa_id: k3 })])
rejects('P21 改写挂起 κ 的一极须同事务关 κ', [{ type: 'REV', layer: 'W', actor: 'sys', at: tick(), payload: { old_id: w7, claims: [{ layer: 'W', kind: 'belt', text: '制度在透明时比个人可靠', origin: 'extract', pred: [w7] }] } }], 'INVARIANT')
const revAt = tick()
put([
  { type: 'REV', layer: 'W', actor: 'sys', at: revAt, payload: { old_id: w7, claims: [{ layer: 'W', kind: 'belt', text: '制度在透明时比个人可靠', origin: 'extract', pred: [w7] }] } },
  { type: 'KAPPA_OBSOLETE', layer: 'W', actor: 'sys', at: revAt, payload: { kappa_id: k3, why: 'pole_superseded' } },
])
st = loadState(db, aid)
check('P21 同事务关闭：κ3 resolved，另一极不受影响', st.kappas[k3].sigma === 'resolved' && st.claims[w7].status === 'superseded' && st.claims[wc2].status === 'active')
{
  // 回归（模糊模拟发现）：挂起 κ 的一极正在别的 κ 里交锋，关闭挂起 κ 时不能把它放回 active
  const x = mk('V', 'ideal', '人应当活得体面')
  const y = mk('V', 'ideal', '人应当活得自由')
  const z = mk('V', 'ideal', '人应当活得安稳')
  const { k: ka } = openK('V', x, y, '人该怎么活')
  put([ev('SUSPEND', 'V', { kappa_id: ka })])
  const { k: kb } = openK('V', x, z, '体面与安稳')
  const at = tick()
  put([
    { type: 'REV', layer: 'V', actor: 'sys', at, payload: { old_id: y, claims: [{ layer: 'V', kind: 'ideal', text: '人应当在责任内活得自由', origin: 'extract', pred: [y] }] } },
    { type: 'KAPPA_OBSOLETE', layer: 'V', actor: 'sys', at, payload: { kappa_id: ka } },
  ])
  const s2 = loadState(db, aid)
  check('KAPPA_OBSOLETE 不释放别的 κ 占着的极', s2.kappas[ka].sigma === 'resolved' && s2.kappas[kb].sigma === 'struggle' && s2.claims[x].status === 'contested', { x: s2.claims[x].status })
  put([ev('SUSPEND', 'V', { kappa_id: kb })])
}
rejects('KAPPA_OBSOLETE 须有一极已终态', [ev('KAPPA_OBSOLETE', 'V', { kappa_id: k2 })], 'TRANSITION')
rejects('P9 DEPENDS 不能成环', [{ type: 'EDGE_ADD', actor: 'sys', at: tick(), payload: { edges: [{ type: 'DEPENDS', from_id: l1, to_id: l2 }] } }], 'TRANSITION')
rejects('P13 Θ 不可调参数', [ev('THETA_ADJUST', null, { key: 'alpha', value: 0.3 })], 'TRANSITION')
rejects('P13 Θ 越界', [ev('THETA_ADJUST', null, { key: 'n_min', value: 9 })], 'TRANSITION')
rejects('证据目标不存在', [evid('cl_nope', 1, 'act')], 'TRANSITION')
rejects('证据权重须按种类', [{ type: 'EVIDENCE', actor: 'user', at: tick(), payload: { evidence: [{ kind: 'act', target_type: 'claim', target_id: w3, sign: 1, weight: 1, ref: 'turn:1' }] } }], 'TRANSITION')
rejects('κ 两极定向：较早者为正', [(() => { const at = tick(); const q = newId('questions', at); return { type: 'KAPPA_OPEN', layer: 'V', actor: 'judge', at, payload: { questions: [{ id: q, layer: 'V', text: 'x' }], kappas: [{ layer: 'V', q_id: q, pos_id: v2, neg_id: v1, dep: 'd', excl: 'e' }] } } })()], 'TRANSITION')
rejects('核心只能 seed 直建', [claimEv('W', 'core', '世界是物质的')], 'TRANSITION')
rejects('ν 期限不超过 T_ν', [{ type: 'NU_REGISTER', actor: 'judge', at: tick(), payload: { nus: [{ claim_id: w3, expect: 'x', observe: 'y', p: 0.5, due_at: new Date(clock + 40 * DAY).toISOString() } ] } }], 'TRANSITION')
rejects('TRADEOFF 只给并存 κ', [ev('TRADEOFF', 'W', { kappa_id: k3, lean_pole: 'pos' })], 'TRANSITION')
mk('L', 'telos', '把好奇心保持下去', { origin: 'seed' })
mk('L', 'telos', '做一个可靠的伙伴', { origin: 'seed' })
rejects('C_max：核心已满不能再建', [claimEv('L', 'telos', '第四个志向', { origin: 'seed' })], 'TRANSITION')

// ======================= I5 expect =======================
rejects('I5 expect 不符整批回滚', [ev('REVIEW_FLAG', null, { claim_id: w3 })], 'EXPECT', { claims: { [w3]: 'contested' } })
const okExp = append(db, aid, [ev('REVIEW_FLAG', null, { claim_id: w3 })], { claims: { [w3]: 'active' }, kappas: { [k2]: 'coexist' }, nus: { [nu1]: 'hit' } })
check('I5 expect 相符正常写入', okExp.ids.length === 1 && loadState(db, aid).claims[w3].review === 2)
rejects('I5 事件级 expect 也校验', [{ ...ev('REVIEW_FLAG', null, { claim_id: w3 }), expect: { kappas: { [k2]: 'struggle' } } }], 'EXPECT')

// ======================= P1 重放 =======================
const live = snapshot(db, aid)
const pure = stateToSnapshot(fold(emptyState(), readEvents(db, aid)), aid)
check('P1 纯折叠 = 增量投影（逐字段）', same(pure, live), { pure: pure.claims.length, live: live.claims.length })
rebuild(db, aid)
check('P1 rebuild 后逐字段相等', same(snapshot(db, aid), live))
for (const t of ['claim_proj_claim', 'claim_proj_kappa', 'claim_proj_nu', 'claim_proj_edge', 'claim_proj_theta', 'claim_proj_meta']) {
  db.prepare(`DELETE FROM ${t} WHERE agent_id=?`).run(aid)
}
check('P1 清空投影后读取自动重建', same(stateToSnapshot(loadState(db, aid), aid), live) && same(snapshot(db, aid), live))
db.prepare('UPDATE claim_proj_claim SET pi=0.99 WHERE id=?').run(w3)
rebuild(db, aid)
check('P1 投影被弄脏后 rebuild 复原', same(snapshot(db, aid), live))
let prefixOk = true
let prefixBad = null
for (const h of history) {
  const s = stateToSnapshot(stateAt(db, aid, h.seq), aid)
  if (!same(s, h.snap)) { prefixOk = false; prefixBad = h.seq; break }
}
check('P1 任意时刻：投影(t) = fold(事件 ≤ t)', prefixOk && history.length > 30, { prefixBad, n: history.length })
db.prepare('DELETE FROM claim_proj_meta WHERE agent_id=?').run(aid)
append(db, aid, [ev('REVIEW_FLAG', null, { claim_id: wc2 })])
check('P1 断点丢失时 append 先自愈再增量', same(snapshot(db, aid), stateToSnapshot(fold(emptyState(), readEvents(db, aid)), aid)))

// ======================= P8 全流审计 =======================
function auditTerminal(events) {
  let s = emptyState()
  const bad = []
  for (const e of events) {
    const next = apply(s, e)
    for (const [id, c] of Object.entries(s.claims)) {
      if (isTerminal(c.status) && next.claims[id].status !== c.status) bad.push({ id, seq: e.seq })
    }
    for (const [id, k] of Object.entries(s.kappas)) {
      if (['resolved', 'sublated'].includes(k.sigma) && next.kappas[id].sigma !== k.sigma) bad.push({ id, seq: e.seq })
    }
    for (const [id, n] of Object.entries(s.nus)) {
      if (n.outcome !== 'pending' && next.nus[id].outcome !== n.outcome) bad.push({ id, seq: e.seq })
    }
    s = next
  }
  return bad
}
check('P8 全流审计：终态之后无迁移', auditTerminal(readEvents(db, aid)).length === 0)
check('P8 夹具确实覆盖了全部 5 种终态', TERMINAL.every((t) => Object.values(loadState(db, aid).claims).some((c) => c.status === t)))

// ======================= I15 纯函数 =======================
const src = (f) => fs.readFileSync(new URL('../src/modules/sangguan/' + f, import.meta.url), 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
for (const f of ['fold.js', 'machine.js']) {
  const code = src(f)
  check('I15 ' + f + ' 不读时钟', !/Date\.now|new Date\(\s*\)|performance\.now/.test(code))
  check('I15 ' + f + ' 无随机', !/Math\.random|randomBytes|ulid/.test(code))
  const imports = [...code.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1])
  check('I15 ' + f + ' 只依赖纯模块', imports.every((m) => ['./catalog.js', './theta.js', './errors.js', './machine.js'].includes(m)), imports)
}
const deepFreeze = (o) => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v) } return o }
const allEv = readEvents(db, aid)
const frozen = deepFreeze(fold(emptyState(), allEv.slice(0, 20)))
let mutated = false
try { apply(frozen, allEv[20]) } catch (e) { mutated = e instanceof TypeError }
check('I15 apply 不改输入状态', !mutated)
check('I15 同输入同输出', same(fold(emptyState(), allEv), fold(emptyState(), allEv)))

// ======================= 模糊模拟 =======================
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
// SG_SEED / SG_FUZZ_N 可换种子、加长序列做压力回归
const rnd = mulberry32(Number(process.env.SG_SEED) || 20261101)
const FUZZ_N = Number(process.env.SG_FUZZ_N) || 800
const pick = (arr) => arr[Math.floor(rnd() * arr.length)]
const fz = 'agt_fuzz'
const KINDS = { W: ['core', 'belt', 'obs'], L: ['telos', 'chapter', 'role'], V: ['principle', 'norm', 'ideal'] }
let okN = 0
let rejN = 0
const bugs = []
const tally = {}
const rejWhy = {}
for (let i = 0; i < FUZZ_N; i++) {
  const s = loadState(db, fz)
  const claims = Object.values(s.claims)
  const kappas = Object.values(s.kappas)
  const nus = Object.values(s.nus)
  const edges = Object.values(s.edges)
  const at = tick(5)
  const layer = pick(['W', 'L', 'V'])
  const inLayer = claims.filter((c) => c.layer === layer)
  const any = () => (claims.length ? pick(claims).id : 'cl_none')
  const op = pick(['claim', 'claim', 'claim', 'kappa', 'kappa', 'branch', 'branch', 'branch', 'evidence', 'evidence', 'con', 'rev', 'nu', 'nures', 'edge', 'retire', 'theta', 'core', 'elev', 'dup'])
  let evs = []
  try {
    switch (op) {
      case 'claim': {
        const kind = pick(KINDS[layer])
        evs = [{ type: 'CLAIM_EXP', layer, actor: 'sys', at, payload: { claims: [{ layer, kind, text: 'fz' + i, origin: rnd() < 0.5 ? 'seed' : 'extract' }] } }]
        break
      }
      case 'kappa': {
        if (inLayer.length < 2) continue
        const [a, b] = [pick(inLayer), pick(inLayer)].sort((x, y) => x.born_seq - y.born_seq)
        const q = newId('questions', at)
        evs = [{ type: 'KAPPA_OPEN', layer, actor: 'judge', at, payload: { questions: [{ id: q, layer, text: 'q' + i }], kappas: [{ layer, q_id: q, pos_id: a.id, neg_id: b.id, dep: 'd', excl: 'e' }] } }]
        break
      }
      case 'branch': {
        if (!kappas.length) continue
        const k = pick(kappas)
        const t = pick(['SUSPEND', 'COEX', 'RESOLVE', 'SUB_ACCEPT', 'SUB_CONFIRM', 'SUB_ROLLBACK', 'SUB_EXPIRE', 'REOPEN', 'KAPPA_OBSOLETE', 'TRADEOFF', 'DELIBERATE'])
        const base = { kappa_id: k.id }
        const pole = rnd() < 0.5 ? [k.pos_id, k.neg_id] : [k.neg_id, k.pos_id]
        const payload = t === 'RESOLVE' ? { ...base, winner_id: pole[0], loser_id: pole[1] }
          : t === 'COEX' ? { ...base, loss: 'l' } : t === 'TRADEOFF' ? { ...base, lean_pole: 'neg' }
          : t === 'DELIBERATE' ? { ...base, branch: 'SUSPEND' }
          : t === 'SUB_ACCEPT' ? { ...base, claims: [{ layer: k.layer, kind: KINDS[k.layer][1], text: 'syn' + i, origin: 'synth', pred: [k.pos_id, k.neg_id], q_id: k.q_id }] } : base
        evs = [{ type: t, layer: rnd() < 0.95 ? k.layer : layer, actor: 'judge', at, payload }]
        break
      }
      case 'evidence': {
        const kind = pick(['act', 'verdict', 'check'])
        const toNu = nus.length && rnd() < 0.3
        evs = [{ type: 'EVIDENCE', actor: 'user', at, payload: { evidence: [{ kind, target_type: toNu ? 'nu' : 'claim', target_id: toNu ? pick(nus).id : any(), sign: rnd() < 0.5 ? 1 : -1, weight: W8[kind], ref: 'r' + i }] } }]
        break
      }
      case 'con': {
        const c = claims.length ? pick(claims) : null
        if (!c) continue
        evs = [{ type: 'CON', layer: c.layer, actor: 'user', at, payload: { claim_id: c.id } }]
        break
      }
      case 'rev': {
        const c = claims.length ? pick(claims) : null
        if (!c) continue
        evs = [{ type: 'REV', layer: c.layer, actor: 'sys', at, payload: { old_id: c.id, claims: [{ layer: c.layer, kind: KINDS[c.layer][2], text: 'rev' + i, origin: 'extract', pred: [c.id] }] } }]
        // 一半概率带上同事务的 KAPPA_OBSOLETE，覆盖 P21 的两条路径
        if (rnd() < 0.5) for (const k of kappas.filter((k) => ['struggle', 'suspended', 'coexist', 'sub_trial'].includes(k.sigma) && (k.pos_id === c.id || k.neg_id === c.id))) {
          evs.push({ type: 'KAPPA_OBSOLETE', layer: k.layer, actor: 'sys', at, payload: { kappa_id: k.id } })
        }
        break
      }
      case 'nu':
        evs = [{ type: 'NU_REGISTER', actor: 'judge', at, payload: { nus: [{ claim_id: any(), expect: 'e', observe: 'o', p: 0.5, due_at: new Date(Date.parse(at) + 5 * DAY).toISOString() }] } }]
        break
      case 'nures':
        if (!nus.length) continue
        evs = [{ type: 'NU_RESOLVE', actor: 'judge', at, payload: { nu_id: pick(nus).id, outcome: pick(['hit', 'miss', 'void']) } }]
        break
      case 'edge':
        evs = [{ type: 'EDGE_ADD', actor: 'sys', at, payload: { edges: [{ type: pick(['DEPENDS', 'DEPENDS', 'CONSTRAINS', 'CITES']), from_id: any(), to_id: any() }] } }]
        break
      case 'retire':
        if (!edges.length) continue
        evs = [{ type: 'EDGE_RETIRE', actor: 'sys', at, payload: { edge_id: pick(edges).id } }]
        break
      case 'theta': {
        const key = pick(Object.keys(THETA))
        evs = [{ type: 'THETA_ADJUST', actor: 'sys', at, payload: { key, value: Math.round(rnd() * 100) / 10 } }]
        break
      }
      case 'core': {
        const b = inLayer.length ? pick(inLayer) : null
        if (!b) continue
        evs = [{ type: 'CORE_ESTABLISH', layer, actor: 'judge', at, payload: { from_id: b.id, claims: [{ layer, kind: KINDS[layer][0], text: 'core' + i, origin: 'extract', pred: [b.id] }] } }]
        break
      }
      case 'elev': {
        const c = inLayer.length ? pick(inLayer) : null
        if (!c) continue
        evs = [{ type: 'ELEV_COMMIT', layer, actor: 'user', at, payload: { old_core_id: c.id, scope: 's', claims: [{ layer, kind: KINDS[layer][0], text: 'elev' + i, origin: 'elev', pred: [c.id] }] } }]
        break
      }
      case 'dup':
        evs = [{ type: 'DUP', layer, actor: 'sys', at, payload: { claim_id: any() } }]
        break
    }
    append(db, fz, evs)
    okN++
    tally[op] = (tally[op] || 0) + 1
  } catch (e) {
    if (e instanceof SangguanError) {
      rejN++
      const key = e.code + ' ' + e.message
      rejWhy[key] = (rejWhy[key] || 0) + 1
    } else bugs.push({ op, msg: e.message, stack: String(e.stack).split('\n').slice(0, 3).join(' | ') })
  }
}
const fst = loadState(db, fz)
console.log('  模糊模拟：成功', okN, '拒绝', rejN, '分布', JSON.stringify(tally))
console.log('  拒绝原因：', JSON.stringify(rejWhy))
// 模糊用例只故意造了两种坏形状：自环边、合题与事件不同层；其余拒绝都应来自状态机
check('模糊：拒绝来自状态机而非形状误杀', Object.keys(rejWhy).every((k) => !k.startsWith('INVALID') || k.includes('自环') || k.includes('I9')), rejWhy)
check('模糊：没有非预期异常', bugs.length === 0, bugs.slice(0, 3))
check('模糊：成功与拒绝都有', okN > FUZZ_N / 4 && rejN > FUZZ_N / 16, { okN, rejN })
check('模糊：不变式始终成立', checkInvariants(fst).length === 0, checkInvariants(fst).slice(0, 3))
check('模糊：P1 纯折叠 = 增量投影', same(stateToSnapshot(fold(emptyState(), readEvents(db, fz)), fz), snapshot(db, fz)))
rebuild(db, fz)
check('模糊：P1 rebuild 一致', same(stateToSnapshot(fst, fz), snapshot(db, fz)))
check('模糊：P8 终态之后无迁移', auditTerminal(readEvents(db, fz)).length === 0)
const entRows = ['persona_claims', 'claim_questions', 'claim_kappa', 'claim_predictions', 'claim_evidence', 'claim_edges']
  .reduce((n, t) => n + db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE agent_id=?`).get(fz).n, 0)
const entEv = readEvents(db, fz).reduce((n, e) => n + ['claims', 'questions', 'kappas', 'nus', 'evidence', 'edges'].reduce((m, s) => m + (e.payload[s] || []).length, 0), 0)
check('模糊：被拒的批次没留下半截实体', entRows === entEv, { entRows, entEv })
check('模糊：覆盖到多种终态', new Set(Object.values(fst.claims).map((c) => c.status)).size >= 5, [...new Set(Object.values(fst.claims).map((c) => c.status))])
check('模糊：覆盖到多种 σ', new Set(Object.values(fst.kappas).map((k) => k.sigma)).size >= 4, [...new Set(Object.values(fst.kappas).map((k) => k.sigma))])

db.close()
fs.rmSync(dir, { recursive: true, force: true })
console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exitCode = 1
