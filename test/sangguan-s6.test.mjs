/**
 * 三观 S6：扬弃。S1–S5、J4/J5、SUB_ACCEPT、试用结算、SUB_EXTEND / SUB_DORMANT。
 * P2、P3、P17 占用、场景①②、P1。
 * 运行：node test/sangguan-s6.test.mjs（可设 SG_SEED）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { append, newId, readEvents, lastSeq, SangguanError } from '../src/modules/sangguan/ledger.js'
import { emptyState, fold, checkInvariants } from '../src/modules/sangguan/fold.js'
import { loadState, rebuild, snapshot, stateToSnapshot, derivedCounts } from '../src/modules/sangguan/projection.js'
import { setSangguanConfig } from '../src/modules/sangguan/config.js'
import { sGates } from '../src/modules/sangguan/gates.js'
import { jaccard } from '../src/modules/sangguan/sim.js'
import { plan, commit, execute, runNight } from '../src/modules/sangguan/deliberate.js'
import { settleTrials } from '../src/modules/sangguan/trial.js'
import { fakeChat } from './sangguan-fake-llm.mjs'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 800)) }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-sg6-'))
const db = openDb(path.join(dir, 'app.db'))
const aid = 'agt_sg6'
setSangguanConfig(db, aid, { enabled: true })

let clock = Date.parse('2026-11-01T08:00:00.000Z')
const tick = (min = 1) => new Date((clock += min * 60000)).toISOString()
const DAY = 86400000
const W8 = { act: 0.6, verdict: 1, check: 1 }
const put = (evs) => append(db, aid, evs)
const mk = (layer, kind, text) => put([{
  type: 'CLAIM_EXP', layer, actor: 'sys', at: tick(),
  payload: { claims: [{ layer, kind, text, origin: 'extract' }] },
}]).entities.claims[0]
const evid = (id, sign, kind = 'act', actor = 'user') => ({
  type: 'EVIDENCE', actor, at: tick(),
  payload: { evidence: [{ kind, target_type: 'claim', target_id: id, sign, weight: W8[kind], ref: 't:' + clock }] },
})
function openK(layer, pos, neg, qtext) {
  const at = tick()
  const q = newId('questions', at)
  return put([{
    type: 'KAPPA_OPEN', layer, actor: 'judge', at,
    payload: { questions: [{ id: q, layer, text: qtext }], kappas: [{ layer, q_id: q, pos_id: pos, neg_id: neg, dep: 'd', excl: 'e' }] },
  }]).entities.kappas[0]
}

const passJ5 = { s1: { pass: true }, s3: { pass: true }, s4: { pass: true }, s5_hint: { pass: true } }
function goodJ4(input) {
  return {
    text: '努力决定下限，运气决定上限',
    kept_pos: [input.pos.text.slice(0, 2)],
    kept_neg: [input.neg.text.slice(0, 2)],
    dropped: ['片面'],
    boundary: [{ text: '在可重复的练习情境下', testable: true }],
    nu: [{ expect: '持续练习的人很少跌出平均线', observe: '练习记录', p: 0.7, due_days: 10 }],
  }
}

// ======================= S 闸纯函数 =======================
{
  const poles = {
    pos: { text: '努力通常会有回报', boundary: [] },
    neg: { text: '结果主要靠运气', boundary: [] },
    q_id: 'q1',
  }
  const okp = {
    text: '努力决定下限，运气决定上限', q_id: 'q1',
    kept_pos: ['努力'], kept_neg: ['运气'], dropped: ['主要'],
    boundary: [{ text: '可重复练习', testable: true }], nu: [],
  }
  const j5 = [passJ5, passJ5]
  const g = sGates(okp, poles, j5, { sim: jaccard, theta_dup: 0.9 })
  check('S 闸：合法合题全过', g.ok && g.failed.length === 0, g)
  check('S1：缺一边 kept 失败', !sGates({ ...okp, kept_neg: [] }, poles, j5, { sim: jaccard, theta_dup: 0.9 }).ok)
  check('S1：引用不在原文里失败', !sGates({ ...okp, kept_pos: ['这段没有'] }, poles, j5, { sim: jaccard, theta_dup: 0.9 }).ok)
  check('S2：dropped 与 kept 相交失败', !sGates({ ...okp, dropped: ['努力'] }, poles, j5, { sim: jaccard, theta_dup: 0.9 }).ok)
  check('S2：dropped 空失败', !sGates({ ...okp, dropped: [] }, poles, j5, { sim: jaccard, theta_dup: 0.9 }).ok)
  check('S3：没有新边界也没有 ν 失败', !sGates({ ...okp, boundary: [], nu: [] }, poles, j5, { sim: jaccard, theta_dup: 0.9 }).ok)
  check('S3：退化时只认 ν', !sGates({ ...okp, nu: [] }, poles, j5, { sim: jaccard, theta_dup: 0.9, degen: true }).ok)
  check('S4：问题不同失败', !sGates({ ...okp, q_id: 'q2' }, poles, j5, { sim: jaccard, theta_dup: 0.9 }).ok)
  check('S5：换说法站边（sim 高）失败', !sGates({ ...okp, text: '努力通常会有回报' }, poles, j5, { sim: jaccard, theta_dup: 0.9 }).ok)
  check('S1 [J]：审查不通过', !sGates(okp, poles, [{ ...passJ5, s1: { pass: false } }, passJ5], { sim: jaccard, theta_dup: 0.9 }).ok)
}

// ======================= fold：EXTEND / DORMANT / EXPIRE 守卫 =======================
{
  const a = mk('W', 'belt', '努力通常会有回报')
  const b = mk('W', 'belt', '结果主要靠运气')
  const kid = openK('W', a, b, '成败由什么决定')
  const st0 = loadState(db, aid)
  const qid = st0.kappas[kid].q_id
  const at = tick()
  const cid = newId('claims', at)
  put([{
    type: 'SUB_ACCEPT', layer: 'W', actor: 'judge', at,
    payload: { kappa_id: kid, claims: [{ id: cid, layer: 'W', kind: 'belt', text: '努力决定下限，运气决定上限', origin: 'synth', pred: [a, b], q_id: qid }] },
  }])
  try {
    put([{ type: 'SUB_EXTEND', layer: 'W', actor: 'judge', at: tick(), payload: { kappa_id: kid } }])
    check('SUB_EXTEND 非 sys 拒绝', false)
  } catch (e) {
    check('SUB_EXTEND 非 sys 拒绝', e instanceof SangguanError && /sys/.test(e.message), e.message)
  }
  put([{ type: 'SUB_EXTEND', layer: 'W', actor: 'sys', at: tick(), payload: { kappa_id: kid } }])
  const k1 = loadState(db, aid).kappas[kid]
  check('SUB_EXTEND：extended=1，trial_until +7 日', k1.extended === 1 && k1.sigma === 'sub_trial', k1)
  try {
    put([{ type: 'SUB_EXTEND', layer: 'W', actor: 'sys', at: tick(), payload: { kappa_id: kid } }])
    check('每个 κ 只能延长一次', false)
  } catch (e) {
    check('每个 κ 只能延长一次', /一次/.test(e.message), e.message)
  }
  try {
    put([{ type: 'SUB_EXPIRE', layer: 'W', actor: 'sys', at: tick(), payload: { kappa_id: kid } }])
    check('未休眠不能 EXPIRE', false)
  } catch (e) {
    check('未休眠不能 EXPIRE', /休眠/.test(e.message), e.message)
  }
  put([{ type: 'SUB_DORMANT', layer: 'W', actor: 'sys', at: tick(), payload: { kappa_id: kid } }])
  check('SUB_DORMANT 写下 dormant_since', !!loadState(db, aid).kappas[kid].dormant_since)
  put([evid(cid, 1, 'act')])
  check('绑定 c* 的证据清空 dormant_since', loadState(db, aid).kappas[kid].dormant_since == null)
  // 再休眠后才能过期
  put([{ type: 'SUB_DORMANT', layer: 'W', actor: 'sys', at: tick(), payload: { kappa_id: kid } }])
  put([{ type: 'SUB_EXPIRE', layer: 'W', actor: 'sys', at: tick(), payload: { kappa_id: kid } }])
  const kx = loadState(db, aid)
  check('EXPIRE：合题 withdrawn、两极回 active、κ 挂起', kx.claims[cid].status === 'withdrawn' && kx.claims[a].status === 'active' && kx.kappas[kid].sigma === 'suspended', kx.kappas[kid])
}

// ======================= 场景①：对峙 → 挂起 → 证据 → 合题 → 试用通过 =======================
const a1 = mk('W', 'belt', '努力通常会有回报')
const b1 = mk('W', 'belt', '结果主要靠运气')
const k1 = openK('W', a1, b1, '成败主要由什么决定')
{
  const chat = fakeChat({ J4: goodJ4, J5: passJ5 })
  const p0 = plan(db, aid, k1, tick(), { allowSub: true })
  check('刚开即可试 SUB（J4 在 calls 里）', p0.try_sub && p0.calls.some((c) => c.id === 'J4'), p0)
  const r0 = await execute(db, aid, p0, tick(), { chat })
  check('场景①：首次审议写出合题', r0.ok && r0.branch === 'SUB', r0)
  const st = loadState(db, aid)
  const subId = st.kappas[k1].sub_id
  const acc = readEvents(db, aid).filter((e) => e.type === 'SUB_ACCEPT' && e.payload.kappa_id === k1).pop()
  check('P3：SUB_ACCEPT 的 S1–S5 全 pass', acc && acc.gate_report && ['S1', 'S2', 'S3', 'S4', 'S5'].every((g) => acc.gate_report[g] && acc.gate_report[g].pass), acc && acc.gate_report)
  check('合题 provisional，κ 试用中', st.claims[subId].status === 'provisional' && st.kappas[k1].sigma === 'sub_trial')
  const g0 = derivedCounts(db, aid).g_turn.W
  put([evid(subId, 1, 'verdict')])
  clock += 8 * DAY
  const set = settleTrials(db, aid, new Date(clock).toISOString())
  check('场景①：试用通过 → SUB_CONFIRM', set.did.some((d) => d.id === k1 && d.type === 'SUB_CONFIRM'), set)
  const st2 = loadState(db, aid)
  check('合题转 active，两极 sublated', st2.claims[subId].status === 'active' && st2.claims[a1].status === 'sublated' && st2.claims[b1].status === 'sublated')
  check('P2：g_turn 只在 SUB_CONFIRM 时 +1', derivedCounts(db, aid).g_turn.W === g0 + 1, derivedCounts(db, aid))
}

// ======================= 场景②：零证据 → 延长 → 休眠 → 到期释放 =======================
const a2 = mk('L', 'chapter', '这个月先把身体养好')
const b2 = mk('L', 'chapter', '这个月先把项目做完')
const k2 = openK('L', a2, b2, '这阵子该怎么过')
{
  const chat = fakeChat({
    J4: (input) => ({
      text: '在不透支的前提下把事情做完',
      kept_pos: [input.pos.text.slice(0, 2)], kept_neg: [input.neg.text.slice(0, 2)],
      dropped: ['只要'],
      boundary: [{ text: '连续两周睡眠不低于六小时', testable: true }],
      nu: [],
    }),
    J5: passJ5,
  })
  const r = await execute(db, aid, plan(db, aid, k2, tick(), { allowSub: true }), tick(), { chat })
  check('场景②：合题入试用', r.ok && r.branch === 'SUB', r)
  const g0 = derivedCounts(db, aid).g_turn.L
  clock += 8 * DAY
  const e1 = settleTrials(db, aid, new Date(clock).toISOString())
  check('零证据到期 → SUB_EXTEND', e1.did.some((d) => d.id === k2 && d.type === 'SUB_EXTEND'), e1)
  check('延长后仍在试用、g_turn 不变', loadState(db, aid).kappas[k2].sigma === 'sub_trial' && loadState(db, aid).kappas[k2].extended === 1 && derivedCounts(db, aid).g_turn.L === g0)
  clock += 8 * DAY
  const e2 = settleTrials(db, aid, new Date(clock).toISOString())
  check('再到期仍无证据 → SUB_DORMANT', e2.did.some((d) => d.id === k2 && d.type === 'SUB_DORMANT'), e2)
  check('休眠保持 provisional', loadState(db, aid).claims[loadState(db, aid).kappas[k2].sub_id].status === 'provisional')
  clock += 61 * DAY
  const e3 = settleTrials(db, aid, new Date(clock).toISOString())
  check('休眠期满 → SUB_EXPIRE', e3.did.some((d) => d.id === k2 && d.type === 'SUB_EXPIRE'), e3)
  const st = loadState(db, aid)
  check('场景②：两极释放、g_turn 仍不变', st.kappas[k2].sigma === 'suspended' && st.claims[a2].status === 'active' && st.claims[b2].status === 'active' && derivedCounts(db, aid).g_turn.L === g0, derivedCounts(db, aid))
}

// 闸失败 → SUB_REJECTED，仍写 SUSPEND
{
  const a = mk('W', 'obs', '城市夜里很安静')
  const b = mk('W', 'obs', '城市夜里很吵')
  const k = openK('W', a, b, '夜里到底怎样')
  const chat = fakeChat({
    J4: (input) => ({
      text: input.pos.text, // 换说法站边，S5 应失败
      kept_pos: [input.pos.text.slice(0, 2)], kept_neg: [input.neg.text.slice(0, 2)],
      dropped: ['xyz'],
      boundary: [{ text: '新条件', testable: true }],
      nu: [],
    }),
    J5: passJ5,
  })
  const before = lastSeq(db, aid)
  const r = await execute(db, aid, plan(db, aid, k, tick(), { allowSub: true }), tick(), { chat })
  const types = readEvents(db, aid).filter((e) => e.seq > before).map((e) => e.type)
  check('S 闸失败：SUB_REJECTED + SUSPEND，无 SUB_ACCEPT', r.ok && r.branch === 'SUSPEND' && types.includes('SUB_REJECTED') && types.includes('SUSPEND') && !types.includes('SUB_ACCEPT'), types)
}

// J4 失败：无提案，只挂起
{
  const a = mk('W', 'belt', '规则通常会被遵守')
  const b = mk('W', 'belt', '规则常常被绕开')
  const k = openK('W', a, b, '规则靠得住吗')
  const chat = fakeChat({ J4: '坏' })
  const before = lastSeq(db, aid)
  const r = await execute(db, aid, plan(db, aid, k, tick(), { allowSub: true }), tick(), { chat })
  const types = readEvents(db, aid).filter((e) => e.seq > before).map((e) => e.type)
  check('J4 不合格：不写合题，只 SUSPEND', r.ok && r.branch === 'SUSPEND' && types.includes('SUSPEND') && !types.includes('SUB_ACCEPT') && !types.includes('SUB_REJECTED'), types)
}

// P17：试用占用 ≤ 2·T_trial + T_dormant
{
  const p17 = 'agt_p17s6'
  setSangguanConfig(db, p17, { enabled: true })
  const at0 = tick()
  const pa = append(db, p17, [{ type: 'CLAIM_EXP', layer: 'W', actor: 'sys', at: at0, payload: { claims: [{ layer: 'W', kind: 'belt', text: '甲说', origin: 'extract' }] } }]).entities.claims[0]
  const pb = append(db, p17, [{ type: 'CLAIM_EXP', layer: 'W', actor: 'sys', at: tick(), payload: { claims: [{ layer: 'W', kind: 'obs', text: '乙说', origin: 'extract' }] } }]).entities.claims[0]
  const openAt = tick()
  const q = newId('questions', openAt)
  const kid = append(db, p17, [{
    type: 'KAPPA_OPEN', layer: 'W', actor: 'judge', at: openAt,
    payload: { questions: [{ id: q, layer: 'W', text: 'q' }], kappas: [{ layer: 'W', q_id: q, pos_id: pa, neg_id: pb, dep: 'd', excl: 'e' }] },
  }]).entities.kappas[0]
  const chat = fakeChat({
    J4: (input) => ({
      text: '两边都有道理但要看场合',
      kept_pos: [input.pos.text.slice(0, 1)], kept_neg: [input.neg.text.slice(0, 1)],
      dropped: ['只'],
      boundary: [{ text: '分场合检验', testable: true }],
      nu: [],
    }),
    J5: passJ5,
  })
  await execute(db, p17, plan(db, p17, kid, tick(), { allowSub: true }), tick(), { chat })
  const accAt = loadState(db, p17).kappas[kid].accepted_at
  clock = Date.parse(accAt) + 7 * DAY + 60000
  settleTrials(db, p17, new Date(clock).toISOString())
  clock += 7 * DAY + 60000
  settleTrials(db, p17, new Date(clock).toISOString())
  clock += 60 * DAY + 60000
  settleTrials(db, p17, new Date(clock).toISOString())
  const k = loadState(db, p17).kappas[kid]
  const days = (Date.parse(k.closed_at || new Date(clock).toISOString()) - Date.parse(accAt)) / DAY
  const bound = 2 * 7 + 60
  check('P17：试用占用 ≤ 2·T_trial + T_dormant', k.sigma === 'suspended' && days <= bound + 1, { days, bound, sigma: k.sigma, accepted_at: accAt, closed_at: k.closed_at })
}

// runNight 会先结算再用 allowSub
{
  const nAid = 'agt_s6n'
  setSangguanConfig(db, nAid, { enabled: true })
  const a = append(db, nAid, [{ type: 'CLAIM_EXP', layer: 'W', actor: 'sys', at: tick(), payload: { claims: [{ layer: 'W', kind: 'belt', text: '白天更长', origin: 'extract' }] } }]).entities.claims[0]
  const b = append(db, nAid, [{ type: 'CLAIM_EXP', layer: 'W', actor: 'sys', at: tick(), payload: { claims: [{ layer: 'W', kind: 'obs', text: '黑夜更长', origin: 'extract' }] } }]).entities.claims[0]
  const at = tick()
  const q = newId('questions', at)
  append(db, nAid, [{
    type: 'KAPPA_OPEN', layer: 'W', actor: 'judge', at,
    payload: { questions: [{ id: q, layer: 'W', text: '昼夜' }], kappas: [{ layer: 'W', q_id: q, pos_id: a, neg_id: b, dep: 'd', excl: 'e' }] },
  }])
  const chat = fakeChat({
    J4: (input) => ({
      text: '昼夜长短随纬度与季节变',
      kept_pos: [input.pos.text.slice(0, 2)], kept_neg: [input.neg.text.slice(0, 2)],
      dropped: ['更'],
      boundary: [{ text: '给定纬度', testable: true }],
      nu: [],
    }),
    J5: passJ5,
  })
  const r = await runNight(db, nAid, tick(), { chat, allowSub: true })
  check('夜间 allowSub：能写出合题或挂起', r.status === 'done' && (r.did.length + r.settled.length) >= 1, r)
  check('夜间后不变式成立', checkInvariants(loadState(db, nAid)).length === 0)
}

// P1
{
  const live = snapshot(db, aid)
  check('P1 纯折叠 = 增量投影', same(stateToSnapshot(fold(emptyState(), readEvents(db, aid)), aid), live))
  rebuild(db, aid)
  check('P1 rebuild 后相等', same(snapshot(db, aid), live))
}

// 模糊
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
  const F = 'agt_fuzz6'
  setSangguanConfig(db, F, { enabled: true })
  const chat = fakeChat({
    J4: (input) => (rnd() < 0.15 ? '坏' : {
      text: '合题' + Math.floor(rnd() * 1e6),
      kept_pos: [String(input.pos.text || '甲').slice(0, 1) || '甲'],
      kept_neg: [String(input.neg.text || '乙').slice(0, 1) || '乙'],
      dropped: ['弃'],
      boundary: [{ text: '界' + Math.floor(rnd() * 99), testable: true }],
      nu: rnd() < 0.4 ? [{ expect: 'e', observe: 'o', p: 0.5, due_days: 5 }] : [],
    }),
    J5: () => (rnd() < 0.1 ? { s1: { pass: false }, s3: { pass: true }, s4: { pass: true }, s5_hint: { pass: true } } : passJ5),
  })
  const bugs = []
  const tally = { night: 0, sub: 0, ext: 0, dorm: 0, exp: 0, rej: {} }
  for (let i = 0; i < 60; i++) {
    const s = loadState(db, F)
    const live = Object.values(s.claims).filter((c) => c.layer === 'W' && c.status === 'active')
    const at = tick(20)
    try {
      if (rnd() < 0.4 || live.length < 2) {
        append(db, F, [{ type: 'CLAIM_EXP', layer: 'W', actor: 'sys', at, payload: { claims: [{ layer: 'W', kind: pick(['belt', 'obs']), text: 'fz6-' + i, origin: 'extract' }] } }])
      } else if (rnd() < 0.55) {
        const [x, y] = [pick(live), pick(live)].sort((p, q) => p.born_seq - q.born_seq)
        if (x.id === y.id) continue
        const q = newId('questions', at)
        append(db, F, [{ type: 'KAPPA_OPEN', layer: 'W', actor: 'judge', at, payload: { questions: [{ id: q, layer: 'W', text: 'q' + i }], kappas: [{ layer: 'W', q_id: q, pos_id: x.id, neg_id: y.id, dep: 'd', excl: 'e' }] } }])
      } else if (live.length) {
        append(db, F, [{ type: 'EVIDENCE', actor: 'user', at, payload: { evidence: [{ kind: 'act', target_type: 'claim', target_id: pick(live).id, sign: pick([1, -1]), weight: 0.6, ref: 'f' + i }] } }])
      }
    } catch (e) {
      tally.rej[(e.code || 'X') + ' ' + e.message] = (tally.rej[(e.code || 'X') + ' ' + e.message] || 0) + 1
    }
    if (rnd() < 0.4) {
      clock += (rnd() < 0.3 ? 8 : 1) * DAY
      try {
        const r = await runNight(db, F, new Date(clock).toISOString(), { chat, allowSub: true })
        tally.night++
        tally.sub += r.did.filter((d) => d.branch === 'SUB').length
        tally.ext += r.settled.filter((d) => d.type === 'SUB_EXTEND').length
        tally.dorm += r.settled.filter((d) => d.type === 'SUB_DORMANT').length
        tally.exp += r.settled.filter((d) => d.type === 'SUB_EXPIRE').length
      } catch (e) { bugs.push({ i, msg: String(e && e.message) }) }
    }
    const inv = checkInvariants(loadState(db, F))
    if (inv.length) bugs.push({ i, inv: inv.slice(0, 2) })
  }
  check('模糊（种子 ' + SEED + '）：无非预期异常、不变式成立', bugs.length === 0, bugs.slice(0, 3))
  check('模糊：夜间跑过', tally.night > 3, tally)
  const before = JSON.stringify(snapshot(db, F))
  rebuild(db, F)
  check('模糊：P1 重放一致', JSON.stringify(snapshot(db, F)) === before)
  console.log('  模糊覆盖：', JSON.stringify(tally))
}

{
  const src = (f) => fs.readFileSync(new URL('../src/modules/sangguan/' + f, import.meta.url), 'utf8')
  check('I15 gates.sGates 仍不读时钟', !/Date\.now\(|new Date\(\)/.test(src('gates.js')))
  check('I15 fold 不依赖 trial / deliberate', !/from '\.\/(trial|deliberate|templates)\.js'/.test(src('fold.js')))
}

console.log(`\n通过 ${pass} / ${pass + fail}`)
try { db.close() } catch { /* ignore */ }
try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
process.exit(fail ? 1 : 0)
