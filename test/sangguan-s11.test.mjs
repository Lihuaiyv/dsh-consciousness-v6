/**
 * 三观 S11：活性 L1–L11（logic-gates §13）、幂等键、决定 3（整数 Θ 存小数、用时取整）。
 * P13 宪法、P14 活性只提案、P15 情绪隔离、P16 probe 不自证、P19 幂等、P20 动静；场景⑤ 判定全挂、⑥ 预算为 0；
 * 长时段空转：账本不随时间白涨。
 * 运行：node test/sangguan-s11.test.mjs（可设 SG_SEED）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { append, newId, readEvents, lastSeq } from '../src/modules/sangguan/ledger.js'
import { emptyState, fold, checkInvariants, theta } from '../src/modules/sangguan/fold.js'
import { loadState, rebuild, snapshot, stateToSnapshot, listHeads } from '../src/modules/sangguan/projection.js'
import { setSangguanConfig } from '../src/modules/sangguan/config.js'
import { THETA, isTunable, inRange } from '../src/modules/sangguan/theta.js'
import { runMid, runWeek } from '../src/modules/sangguan/night.js'
import { plan, execute, eligible, runNight } from '../src/modules/sangguan/deliberate.js'
import { surpriseOf } from '../src/modules/sangguan/practice.js'
import { homeostasis, inquire, abduce, flipCheck, selfDoubt, balance, qiOf, moveOf, viewWeights, surpriseBoost, dogmatic } from '../src/modules/sangguan/liveness.js'
import { runFast, pendingList } from '../src/modules/sangguan/fast.js'
import { recordJudge } from '../src/modules/sangguan/llm.js'
import { fakeChat } from './sangguan-fake-llm.mjs'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 800)) }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-sg11-'))
const db = openDb(path.join(dir, 'app.db'))
const DAY = 86400000
let clock = Date.parse('2026-11-02T20:00:00.000Z')
const tick = (min = 1) => new Date((clock += min * 60000)).toISOString()
const agents = []
function agent(name, extra = {}) {
  const aid = 'agt_s11_' + name
  setSangguanConfig(db, aid, { enabled: true, ...extra })
  agents.push(aid)
  return aid
}
const put = (aid, evs, expect) => append(db, aid, evs, expect)
const KIND = { W: 'belt', L: 'chapter', V: 'norm' }
const CORE = { W: 'core', L: 'telos', V: 'principle' }
const mk = (aid, layer, text, kind = KIND[layer], origin = 'extract', extra = {}) => put(aid, [{
  type: 'CLAIM_EXP', layer, actor: 'sys', at: tick(), payload: { claims: [{ layer, kind, text, origin, ...extra }] },
}]).entities.claims[0]
const ev = (aid, target, sign, kind = 'act', w = 0.6) => put(aid, [{ type: 'EVIDENCE', actor: 'user', at: tick(), payload: { evidence: [{ kind, target_type: 'claim', target_id: target, sign, weight: w, ref: 'r' + clock }] } }])
function openK(aid, layer, pos, neg, qtext = '问题') {
  const at = tick()
  const q = newId('questions', at)
  return put(aid, [{ type: 'KAPPA_OPEN', layer, actor: 'judge', at, payload: { questions: [{ id: q, layer, text: qtext }], kappas: [{ layer, q_id: q, pos_id: pos, neg_id: neg, dep: 'd', excl: 'e' }] } }]).entities.kappas[0]
}
const count = (aid, t) => readEvents(db, aid, { types: [t] }).length
const quiet = { userActive: false }
const active = { userActive: true }
const EMB = async () => null

// ---------- P19 幂等 ----------
{
  const aid = agent('idem')
  mk(aid, 'W', '水往低处流')
  const chat = fakeChat({ J7: { items: [] } })
  const r1 = await runMid(db, aid, tick(), { chat, ...quiet })
  const n1 = lastSeq(db, aid)
  const r2 = await runMid(db, aid, tick(60), { chat, ...quiet })
  check('P19：同一夜跑两次，第二次 dup、零新事件', r1.status === 'done' && r2.status === 'dup' && lastSeq(db, aid) === n1, r2)
  check('同夜顺带跑了本周慢环（sg:week 幂等键）', r1.week && r1.week.status === 'done' && readEvents(db, aid, { types: ['JOB_DONE'] }).some((e) => e.job_key.startsWith('sg:week:')))
  clock += DAY
  const r3 = await runMid(db, aid, tick(), { chat, ...quiet })
  check('次夜：新 sg:night，同周不再跑慢环', r3.status === 'done' && r3.week.status === 'dup', r3.week)
  const w = await runWeek(db, aid, tick(), quiet)
  check('同周单独再跑 runWeek：dup', w.status === 'dup')
  clock += 7 * DAY
  const r4 = await runMid(db, aid, tick(), { chat, ...quiet })
  check('下一周：慢环再跑一次', r4.week.status === 'done')
}

// ---------- P13 + 决定 3：L5 每周 ≤10%，整数 Θ 存小数、用时取整 ----------
{
  const aid = agent('l5')
  const ids = []
  for (let i = 0; i < 14; i++) ids.push(mk(aid, 'W', '世界观命题' + i))
  for (let i = 0; i < 4; i++) put(aid, [{ type: 'CON', layer: 'W', actor: 'sys', at: tick(), payload: { claim_id: ids[i] } }])
  const seen = []
  for (let w = 0; w < 3; w++) {
    const r = homeostasis(db, aid, tick())
    seen.push(r.adjust.find((a) => a.key === 'n_min'))
    clock += 7 * DAY
    for (let i = 0; i < 4; i++) put(aid, [{ type: 'CON', layer: 'W', actor: 'sys', at: tick(), payload: { claim_id: mk(aid, 'W', '补' + w + i) } }])
  }
  const vals = seen.map((a) => a && a.value)
  const s = loadState(db, aid)
  check('churn > c_hi：n_min 3 → 3.3 → 3.63 → 3.993（每周 +10%）', same(vals.map((v) => +v.toFixed(3)), [3.3, 3.63, 3.993]), vals)
  check('决定 3：存储值 3.993，生效值 Math.round = 4', Math.round(theta(s, 'n_min', 'W')) === 4 && Math.abs(theta(s, 'n_min', 'W') - 3.993) < 1e-6)
  const adj = readEvents(db, aid, { types: ['THETA_ADJUST'] })
  const badP13 = adj.filter((e) => !isTunable(e.payload.key) || !inRange(e.payload.key, e.payload.value) || (e.payload.rule !== 'flip' && Math.abs(e.payload.value - e.payload.old) > 0.1 * Math.abs(e.payload.old) + 1e-9))
  check('P13：所有 THETA_ADJUST 只涉及带 * 参数、在范围内、单周 ≤10%', adj.length >= 9 && badP13.length === 0, badP13.slice(0, 2))
  check('同时 δ_π ↑、prior_SUB.W ↓', theta(s, 'delta_pi', 'W') > 0.4 && theta(s, 'prior_SUB.W', 'W') < 0.3)
  check('每条记录旧值 / 新值 / 指标 / 窗口', adj.every((e) => e.payload.old != null && e.payload.metric && e.payload.window))
  const few = agent('l5few')
  for (let i = 0; i < 5; i++) put(few, [{ type: 'CON', layer: 'W', actor: 'sys', at: tick(), payload: { claim_id: mk(few, 'W', '少' + i) } }])
  check('样本不足（链头 < 10）：不调', homeostasis(db, few, tick()).adjust.length === 0)
  let fbad = null
  try { put(aid, [{ type: 'THETA_ADJUST', actor: 'sys', at: tick(), payload: { key: 'alpha', value: 0.3 } }]) } catch (e) { fbad = e.message }
  check('宪法（I13）：fold 拒绝调不带 * 的参数', !!fbad && /带 \*/.test(fbad), fbad)
  // 回滚率 > 0.5 → prior_SUB ↓、N_trial ↑（N_trial 3 → 3.3，生效仍为 3）
  const rb = agent('rollback')
  for (let i = 0; i < 10; i++) {
    const a = mk(rb, 'L', '甲' + i)
    const b = mk(rb, 'L', '乙' + i)
    const k = openK(rb, 'L', a, b)
    const q = loadState(db, rb).kappas[k].q_id
    const at = tick()
    put(rb, [{ type: 'DELIBERATE', layer: 'L', actor: 'sys', at, payload: { kappa_id: k, branch: 'SUB' } },
      { type: 'SUB_ACCEPT', layer: 'L', actor: 'judge', at, payload: { kappa_id: k, claims: [{ layer: 'L', kind: 'chapter', text: '合' + i, origin: 'synth', pred: [a, b], q_id: q }] } }])
    put(rb, [{ type: i < 6 ? 'SUB_ROLLBACK' : 'SUB_CONFIRM', layer: 'L', actor: 'sys', at: tick(), payload: { kappa_id: k } }])
  }
  const r = homeostasis(db, rb, tick())
  const st = loadState(db, rb)
  check('近 90 日 SUB 回滚率 0.6 > 0.5 → prior_SUB.L ↓、N_trial ↑（存 3.3、生效 3）', r.adjust.some((a) => a.key === 'prior_SUB.L' && a.value < 0.3) && Math.abs(theta(st, 'N_trial') - 3.3) < 1e-9 && Math.round(theta(st, 'N_trial')) === 3, r.adjust)
}

// ---------- L2 自我质疑 / P14 / P20 ----------
const j14 = (input) => ({ text: '也许' + input.claim.text.replace('一定', '未必'), q: '努力和回报的关系', why: '很久没被检验' })
async function dogmaticAgent(name) {
  const aid = agent(name)
  const core = mk(aid, 'W', '努力一定有回报', 'core', 'seed')
  for (let i = 0; i < 10; i++) mk(aid, 'W', '无关的世界观' + i)
  clock += 31 * DAY
  return { aid, core }
}
{
  const { aid, core } = await dogmaticAgent('dog')
  const s = loadState(db, aid)
  check('Dogmatic(W)：有核心、最老核心 ≥ T_dog、无相关 κ、m=0、无新 ν', dogmatic(s, readEvents(db, aid), 'W', tick()))
  const qchat = fakeChat({ J14: j14, J2: { pairs: [] } })
  const rq = await runWeek(db, aid, tick(), { chat: qchat, embed: EMB, ...quiet, job: false })
  check('P20：用户 7 日无对话 → 不 probe、零 J14', rq.doubt.length === 0 && qchat.count('J14') === 0)
  const chat = fakeChat({ J14: j14, J2: (input) => ({ pairs: input.neighbors.map((n) => ({ c_id: n.id, rel: n.id === core ? 'contradict' : 'unrelated' })) }) })
  const r = await runWeek(db, aid, tick(), { chat, embed: EMB, ...active })
  const probe = Object.values(loadState(db, aid).claims).find((c) => c.origin === 'probe')
  check('churn < c_lo ∧ Dogmatic → L5 开 L2：生成 1 条 probe 候选', r.doubt.length === 1 && r.doubt[0].why === 'dogmatic' && !!probe, r.doubt)
  // 前面那次 job:false 的静默调用也跑了 L5（稳态不看活跃），所以这里是第二步
  const nInq = readEvents(db, aid, { types: ['THETA_ADJUST'] }).filter((e) => e.payload.key === 'N_inq' && e.payload.rule === 'churn_low')
  check('L5 同时 N_inq ↑（每次 +10%：3 → 3.3 → 3.63）', nInq.length === 2 && Math.abs(theta(loadState(db, aid), 'N_inq') - 3.63) < 1e-9, nInq.map((e) => e.payload.value))
  const ex = readEvents(db, aid, { types: ['CLAIM_EXP'] }).find((e) => e.payload.claims[0].id === probe.id)
  check('P14：probe 命题有 W 分类事件（gate_report.w），且与核心记为矛盾候选', ex && ['W4', 'W5'].includes(ex.gate_report.w) && readEvents(db, aid, { types: ['KAPPA_CANDIDATE'] }).some((e) => [e.payload.a_id, e.payload.b_id].includes(probe.id)), ex && ex.gate_report)
  const r2 = await runWeek(db, aid, tick(), { chat, embed: EMB, ...active })
  check('同周第二次：dup，不再出 probe', r2.status === 'dup' && chat.count('J14') === 1)
}

// ---------- P16 probe 不自证 ----------
{
  const aid = agent('p16')
  const a = mk(aid, 'W', '早起效率高')
  const p = mk(aid, 'W', '早起效率不高', 'belt', 'probe')
  const k = openK(aid, 'W', a, p)
  for (let i = 0; i < 3; i++) ev(aid, a, 1, 'verdict', 1)
  const s = loadState(db, aid)
  check('夹具：π 差 ≥ δ_π、n ≥ n_min', Math.abs(s.claims[a].pi - s.claims[p].pi) >= 0.4 && s.claims[a].n >= 3)
  const pl = plan(db, aid, k, tick(), {})
  check('P16：probe 极没有外部证据 → 不 Decisive、不 RESOLVE', pl.decisive === false && pl.branch !== 'RESOLVE', { d: pl.decisive, b: pl.branch })
  ev(aid, p, -1, 'act')
  const pl2 = plan(db, aid, k, tick(), {})
  check('probe 极有了外部证据后才可 RESOLVE', pl2.decisive === true && pl2.branch === 'RESOLVE' && pl2.loser_id === p, pl2.branch)
  const r = await execute(db, aid, pl2, tick(), {})
  check('RESOLVE 写入', r.ok && r.branch === 'RESOLVE')
}

// ---------- L1 求证 ----------
{
  const aid = agent('inq')
  const hollow = mk(aid, 'L', '我想每周读一本书')
  mk(aid, 'L', '我要学会拒绝')
  const a = mk(aid, 'W', '运动让人开心')
  const b = mk(aid, 'W', '运动让人疲惫')
  const k = openK(aid, 'W', a, b)
  put(aid, [{ type: 'DELIBERATE', layer: 'W', actor: 'sys', at: tick(), payload: { kappa_id: k, branch: 'SUSPEND' } }, { type: 'SUSPEND', layer: 'W', actor: 'sys', at: tick(), payload: { kappa_id: k } }])
  clock += 31 * DAY
  const before = JSON.stringify(Object.values(loadState(db, aid).claims).map((c) => [c.id, c.status]))
  const q0 = fakeChat({ J13: { mode: 'nu', nu: { expect: 'e', observe: 'o', p: 0.6, due_days: 7 } } })
  const rq = await inquire(db, aid, tick(), { chat: q0, ...quiet })
  check('P20：用户不活跃 → 不求证、零 J13', rq.did.length === 0 && q0.count('J13') === 0)
  const chat = fakeChat({
    J13: (input) => (input.allow_ask ? { mode: 'ask', question: '最近还读书吗？' } : { mode: 'nu', nu: { expect: '这周读完一本', observe: '对话', p: 0.6, due_days: 7 } }),
  })
  const r = await inquire(db, aid, tick(), { chat, ...active })
  const inq = readEvents(db, aid, { types: ['INQUIRY'] })
  check('L1：取 VOI 前 N_inq=3 条', r.did.length === 3 && chat.count('J13') === 3, r.did)
  check('提问受 Q_ask=1/日：只有一条 ask，其余登记 ν', inq.filter((e) => e.payload.mode === 'ask').length === 1 && inq.filter((e) => e.payload.mode === 'nu').length === 2)
  check('涉及 κ 的求证也在内（挂起 κ 的 VOI）', inq.some((e) => e.payload.target_id === k))
  check('Hollow 命题（30 日无证据、无 ν）优先被求证', inq.some((e) => e.payload.target_id === hollow), inq.map((e) => e.payload.target_id))
  const nuEv = readEvents(db, aid, { types: ['NU_REGISTER'] }).filter((e) => e.payload.inquiry_id)
  check('求证登记的 ν 带 inquiry_id（不算修订自带 ν）', nuEv.length === 2)
  const after = JSON.stringify(Object.values(loadState(db, aid).claims).map((c) => [c.id, c.status]))
  check('P14：INQUIRY 不迁移任何 status', before === after)
  const r2 = await inquire(db, aid, tick(60), { chat, ...active })
  check('同目标 T_ask=7 日内不重复求证', !r2.did.some((d) => r.did.map((x) => x.target).includes(d.target)), r2.did)
}

// ---------- L3 惊奇桥 / P15 情绪隔离 ----------
{
  const aid = agent('surp')
  const core = mk(aid, 'W', '世界有规律', 'core', 'seed')
  const x = mk(aid, 'W', '世界没规律')
  const y = mk(aid, 'W', '天气难预测')
  const z = mk(aid, 'W', '天气可预测')
  const k1 = openK(aid, 'W', core, x)
  const k2 = openK(aid, 'W', y, z)
  const reg = tick()
  put(aid, [{ type: 'NU_REGISTER', actor: 'judge', at: reg, payload: { nus: [{ claim_id: core, expect: '明天还按规律', observe: 'o', p: 0.9, due_at: new Date(Date.parse(reg) + DAY).toISOString() }] } }])
  const nu = Object.values(loadState(db, aid).nus)[0]
  clock += 2 * DAY
  put(aid, [{ type: 'NU_RESOLVE', actor: 'judge', at: tick(), payload: { nu_id: nu.id, outcome: 'miss', refs: ['r'], surprise: surpriseOf(0.9, 'miss') } }])
  const s = loadState(db, aid)
  const boost = surpriseBoost(db, aid, s, tick())
  check('L3：p=0.9 落空（surprise≈2.3 ≥ θ_surp）落在核心 → 相关 κ ×2，无关 κ 不变', boost[k1] === 2 && !boost[k2], boost)
  const at = tick()
  const q1 = eligible(s, db, aid, at, {}).find((q) => q.id === k1).prio
  const q2 = eligible(s, db, aid, at, { sBoostMap: boost }).find((q) => q.id === k1).prio
  check('优先级翻倍', Math.abs(q2 / q1 - 2) < 1e-9, { q1, q2 })
  const pure = fold(emptyState(), readEvents(db, aid))
  check('P15：惊奇 / 优先级不进 π（重放 π 与在线一致）', Object.values(pure.claims).every((c) => c.pi === s.claims[c.id].pi))
}

// ---------- L6 溯因 ----------
{
  const aid = agent('abd')
  const ids = ['下雨天心情差', '下雨天心情很差', '下雨天心情变差'].map((t) => mk(aid, 'L', t))
  for (const id of ids) { ev(aid, id, -1); put(aid, [{ type: 'CON', layer: 'L', actor: 'sys', at: tick(), payload: { claim_id: id } }]) }
  const chat = fakeChat({ J15: (input) => ({ text: '心情受睡眠影响多于天气', explains: input.evidence.map((x) => x.id), nu: [] }), J2: { pairs: [] } })
  const r = await abduce(db, aid, tick(), { chat, embed: EMB, ...active })
  const abd = Object.values(loadState(db, aid).claims).find((c) => c.origin === 'abduce')
  check('L6：终态命题上的 ≥ n_abd 条证据成簇 → J15 溯因候选（origin=abduce）走 W1–W5', r.did.length === 1 && !!abd && chat.count('J15') === 1, r)
  const r2 = await abduce(db, aid, tick(), { chat, embed: EMB, ...active })
  check('已被溯因解释的证据不再成簇', r2.did.length === 0 && chat.count('J15') === 1)
}

// ---------- §12 FLIP ----------
{
  const aid = agent('flip')
  const rev = (old, text, q) => put(aid, [{ type: 'REV', layer: 'W', actor: 'sys', at: tick(), payload: { old_id: old, claims: [{ layer: 'W', kind: 'belt', text, origin: 'extract', pred: [old], q_id: q }] } }]).entities.claims[0]
  const q = 'q_flip_test'
  const a = mk(aid, 'W', '远程办公效率更高', 'belt', 'extract', { q_id: q })
  const b = rev(a, '远程办公效率更低', q)
  const c = rev(b, '远程办公效率更高', q)
  const r = flipCheck(db, aid, tick(), 0)
  check('FLIP：新命题与 2 步前的终态祖先同文 → 标 FLIP', r.did.length === 1 && r.did[0].claim_id === c && r.did[0].ancestor_id === a, r.did)
  check('只回溯 2–4 步：直接前驱（正常修订）不算', !r.did.some((d) => d.claim_id === b))
  check('一次 FLIP 不调参', count(aid, 'THETA_ADJUST') === 0)
  const d = rev(c, '远程办公效率更低', q)
  const r2 = flipCheck(db, aid, tick(), 0)
  const s = loadState(db, aid)
  check('同一 q 90 日内 2 次 FLIP → 局部 n_min+2、δ_π+0.1（scope=q）', r2.did.some((x) => x.claim_id === d) && theta(s, 'n_min', 'W', 'q:' + q) === 5 && Math.abs(theta(s, 'delta_pi', 'W', 'q:' + q) - 0.5) < 1e-9 && theta(s, 'n_min', 'W') === 3)
  check('FLIP 不重复标记', flipCheck(db, aid, tick(), 0).did.length === 0)
}

// ---------- L10 相生相克 ----------
{
  const aid = agent('bal')
  const w = mk(aid, 'W', '人会互相影响')
  const l = mk(aid, 'L', '我想做一个靠谱的朋友')
  const v = mk(aid, 'V', '真诚比圆滑重要', 'norm')
  clock += 31 * DAY
  const chat = fakeChat({ J17: { edges: [{ type: 'CONSTRAINS', from_id: v, to_id: l, reason: '原则限定志向' }, { type: 'DEPENDS', from_id: l, to_id: w, reason: '以世界观为前提' }] } })
  const rq = await balance(db, aid, tick(), { chat, ...quiet })
  check('P20：不活跃不补边', rq.did.length === 0 && chat.count('J17') === 0)
  const r = await balance(db, aid, tick(), { chat, ...active })
  check('L10：生 / 克为 0 持续 T_bal → J17 补边，EDGE_PROPOSE + EDGE_ADD', r.did.length === 2 && count(aid, 'EDGE_PROPOSE') === 2 && count(aid, 'EDGE_ADD') >= 1, r)
  const r2 = await balance(db, aid, tick(), { chat, ...active })
  check('刚补过边的层不再重复', chat.count('J17') <= 2, chat.count('J17'))
}

// ---------- L11 气 / 动静 ----------
{
  const aid = agent('qi')
  mk(aid, 'W', '孤零零的一条')
  const q = qiOf(db, aid, tick())
  check('Qi = (flow·open·learn·bal)^¼，各因子 ∈ [0,1]', q.qi > 0 && q.qi <= 1 && ['flow', 'open', 'learn', 'bal'].every((k) => q[k] >= 0 && q[k] <= 1), q)
  // 求证本身会抬高 open：前 7 夜让 J13 调不通，Qi 才能持续偏低
  const up = { on: false }
  const chat = fakeChat({ J7: { items: [] }, J13: () => (up.on ? { mode: 'nu', nu: { expect: 'e', observe: 'o', p: 0.5, due_days: 5 } } : new Error('不可用')) })
  let last = null
  for (let i = 0; i < 7; i++) { clock += DAY; last = await runMid(db, aid, tick(), { chat, ...active }) }
  up.on = true
  clock += DAY
  const r8 = await runMid(db, aid, tick(), { chat, ...active })
  const series = readEvents(db, aid, { types: ['JOB_DONE'] }).filter((e) => e.job_key.startsWith('sg:night:')).map((e) => [e.at.slice(5, 16), e.payload.qi && e.payload.qi.qi, e.payload.move])
  check('Qi < Qi_lo 连续 7 夜且用户活跃 → 动', last.move === true && last.qi.qi < 0.3, { move: last.move, qi: last.qi, series })
  check('动：求证条数取 N_inq 上限（INQUIRY 带 boost）', r8.move === true && readEvents(db, aid, { types: ['INQUIRY'] }).some((e) => e.payload.boost === true), r8.move)
  const aid2 = agent('qiquiet')
  mk(aid2, 'W', '孤零零的一条')
  const c2 = fakeChat({ J7: { items: [] }, J13: { mode: 'nu', nu: { expect: 'e', observe: 'o', p: 0.5, due_days: 5 } } })
  let last2 = null
  for (let i = 0; i < 8; i++) { clock += DAY; last2 = await runMid(db, aid2, tick(), { chat: c2, ...quiet }) }
  check('静：用户不活跃时 Qi 再低也不动、不求证（P20）', last2.move === false && c2.count('J13') === 0 && count(aid2, 'INQUIRY') === 0)
}

// ---------- L7 / L8 注入权重 ----------
{
  const aid = agent('view')
  const core = mk(aid, 'W', '世界有序', 'core', 'seed')
  const belt = mk(aid, 'W', '多数事有因果')
  const fresh = mk(aid, 'W', '今天有新发现')
  clock += 31 * DAY
  ev(aid, fresh, 1)
  const n0 = lastSeq(db, aid)
  const w = viewWeights(db, aid, tick())
  check('L7 / L8：stale 且无依赖的保护带 ×0.5，Hollow 再 ×0.5；核心不降权；不写事件', w[belt] === 0.25 && w[core] === 0.5 && w[fresh] === 1 && lastSeq(db, aid) === n0, w)
}

// ---------- 场景⑤ 判定模型全挂 24 小时 → 降级 → 恢复后补判 ----------
{
  const aid = agent('down')
  mk(aid, 'W', '猫喜欢晒太阳')
  const down = { on: true }
  const chat = fakeChat({
    J1: (input) => ({ candidates: [{ layer: 'W', kind: 'belt', text: '猫喜欢晒太阳' + (input.turns.length % 3) }], evidence: [], tradeoffs: [], answers: [] }),
    J2: (input) => (down.on ? new Error('判定挂了') : { pairs: input.neighbors.map((n) => ({ c_id: n.id, rel: 'compatible' })) }),
    J7: { items: [] },
  })
  const turns = (i) => [{ role: 'user', text: '聊聊猫' + i }, { role: 'assistant', text: '猫喜欢晒太阳。'.repeat(1 + (i % 2)) }]
  for (let i = 0; i < 6; i++) await runFast({ db, aid, at: tick(30), chat, embed: EMB }, turns(i))
  const pend = pendingList(db, aid).length
  const r = await runMid(db, aid, tick(), { chat, ...quiet })
  check('⑤ 判定全挂：候选进 PENDING_JUDGE，夜间降级（暂停 SUB / 立案）', pend > 0 && r.degraded === true && r.open.length === 0, { pend, deg: r.degraded })
  const claims0 = Object.keys(loadState(db, aid).claims).length
  down.on = false
  clock += 2 * DAY
  for (let i = 0; i < 6 && pendingList(db, aid).length; i++) await runFast({ db, aid, at: tick(30), chat, embed: EMB }, turns(10 + i))
  const pe = readEvents(db, aid, { types: ['PENDING_JUDGE'] })
  const refd = new Set(readEvents(db, aid).flatMap((e) => e.refs || []))
  check('⑤ 恢复后按时间补判：所有 PENDING_JUDGE 都有去处，无事件丢失', pendingList(db, aid).length === 0 && pe.every((e) => refd.has(e.id)) && Object.keys(loadState(db, aid).claims).length >= claims0, { left: pendingList(db, aid).length })
}

// ---------- 场景⑥ 预算为 0 一整天 → 无失败事件；次日继续 ----------
{
  const aid = agent('broke', { budget: { fast: 0, mid: 0, reserve: 0, floor: 0, slow_week: 0 } })
  const a = mk(aid, 'L', '这阵子先养身体')
  const b = mk(aid, 'L', '这阵子先把项目做完')
  put(aid, [{ type: 'KAPPA_CANDIDATE', layer: 'L', actor: 'sys', at: tick(), payload: { a_id: a, b_id: b } }])
  const reg = tick()
  put(aid, [{ type: 'NU_REGISTER', actor: 'judge', at: reg, payload: { nus: [{ claim_id: a, expect: '睡够', observe: 'o', p: 0.6, due_at: new Date(Date.parse(reg) + DAY).toISOString() }] } }])
  ev(aid, a, 1)
  clock += 2 * DAY
  const chat = fakeChat({
    J3: { q: '这阵子先顾什么', dep: '互为参照', excl: '时间只够一边', u1: { pass: true }, u2: { pass: true }, u3: { pass: true } },
    J4: '坏', J5: '坏', J6: { incommensurable: false, parallel_ok: true, loss: { lean_pole: 'pos', cost: '项目慢' } },
    J7: (input) => ({ items: input.items.map((n) => ({ nu_id: n.nu_id, outcome: 'hit', refs: [n.records[0].id] })) }),
    J12: { cross: [] }, J13: { mode: 'nu', nu: { expect: 'e', observe: 'o', p: 0.5, due_days: 5 } },
  })
  const seq0 = lastSeq(db, aid)
  const r = await runMid(db, aid, tick(), { chat, ...active })
  const evs = readEvents(db, aid).filter((e) => e.seq > seq0)
  const failTypes = ['REPAIR_FAILED', 'SUB_REJECTED', 'ELEV_FAILED', 'REJECT', 'KAPPA_QUEUED', 'DELIBERATE', 'NU_RESOLVE', 'INQUIRY']
  check('⑥ 预算 0：零模型调用、无失败 / 裁定事件', chat.count() === 0 && !evs.some((e) => failTypes.includes(e.type)), evs.map((e) => e.type))
  check('⑥ 当夜照样记 JOB_DONE（没钱 ≠ 失败）', evs.some((e) => e.type === 'JOB_DONE' && e.job_key.startsWith('sg:night:')), r.status)
  setSangguanConfig(db, aid, { budget: { fast: 20, mid: 30, reserve: 6, floor: 2, slow_week: 40 } })
  clock += DAY
  const r2 = await runMid(db, aid, tick(), { chat, ...active })
  check('⑥ 次日有预算：按优先级继续（ν 检验、立案、审议）', r2.n1.did.length === 1 && r2.open.length === 1 && r2.night.did.length === 1, { n1: r2.n1.did, open: r2.open, night: r2.night && r2.night.did })
}

// ---------- 紧预算无饥饿：贵的 κ 在队首推迟时一分不花，也不挡住后面不需要模型的审议 ----------
{
  const aid = agent('hol', { budget: { fast: 4, mid: 3, reserve: 0, floor: 0, slow_week: 0 } })
  const ex = []
  for (let i = 0; i < 3; i++) ex.push(openK(aid, 'L', mk(aid, 'L', '先做甲方案' + i), mk(aid, 'L', '先做乙方案' + i)))
  clock += 60 * DAY
  const a = mk(aid, 'W', '早起效率高')
  const b = mk(aid, 'W', '早起效率低')
  const cheap = openK(aid, 'W', a, b)
  for (let i = 0; i < 3; i++) ev(aid, a, 1, 'verdict', 1)
  const chat = fakeChat({
    J4: { text: '看场合', kept_pos: ['甲'], kept_neg: ['乙'], dropped: [], boundary: [{ text: 'b', testable: true }], nu: [{ expect: 'e', observe: 'o', p: 0.6, due_days: 7 }] },
    J5: { s1: { pass: true }, s3: { pass: true }, s4: { pass: true }, s5_hint: { pass: true } },
    J6: { incommensurable: false, parallel_ok: true, loss: { lean_pole: 'pos', cost: 'c' } },
  })
  const r = await runNight(db, aid, tick(), { chat, allowSub: true, allowCoex: true, sBoostMap: Object.fromEntries(ex.map((k) => [k, 2])), settle: false })
  check('夹具：3 个要 SUB 的 κ 排在队首', same(r.queue.slice(0, 3).map((x) => x.id).sort(), [...ex].sort()), r.queue.map((x) => x.id))
  // 第一个推迟后，后面要花钱的不再尝试
  check('整条链放不下：推迟、零模型调用（不会花了 J4 卡在 J5、次夜重来白烧）', r.postponed.length === 1 && chat.count() === 0 && !r.did.some((d) => ex.includes(d.id)), { p: r.postponed, n: chat.count() })
  check('队首推迟不挡队尾：不需要模型的 κ 当夜 RESOLVE', r.did.some((d) => d.id === cheap && d.branch === 'RESOLVE'), r.did)
}

// ---------- 长时段空转：账本不随时间白涨 ----------
{
  const aid = agent('idle')
  mk(aid, 'W', '世界有规律', 'core', 'seed')
  mk(aid, 'L', '我想做靠谱的人')
  const chat = fakeChat({ J7: { items: [] } })
  const seq0 = lastSeq(db, aid)
  const days = 400
  for (let i = 0; i < days; i++) { clock += DAY; await runMid(db, aid, tick(), { chat, ...quiet }) }
  const grown = lastSeq(db, aid) - seq0
  const byType = {}
  for (const e of readEvents(db, aid).filter((x) => x.seq > seq0)) byType[e.type] = (byType[e.type] || 0) + 1
  // 每夜 1 条 JOB_DONE + 有核心的层 1 条 DEGEN_CHECK；每周 1 条 JOB_DONE
  check('空转 400 夜：每夜事件数有常数上界（≤ 3），零模型调用', grown <= days * 3 && chat.count() === 0, { grown, byType })
  check('空转不产生 INQUIRY / probe / THETA_ADJUST', !byType.INQUIRY && !byType.THETA_ADJUST && !Object.values(loadState(db, aid).claims).some((c) => c.origin === 'probe'), byType)
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
