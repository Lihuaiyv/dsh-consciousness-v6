/**
 * 三观 S9：先例助判（logic-gates §11）。结局表 o_d、Pool（同层 / 别的 κ / 每 κ 最新 / 已成熟）、
 * sim 与 ω、P(b)、N_bad 与 Inhibit、b*_noprec、precedent_ids、新成熟先例触发 Novel；P7 / I10、P10、P1。
 * 运行：node test/sangguan-s9.test.mjs（可设 SG_SEED）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { append, newId, readEvents } from '../src/modules/sangguan/ledger.js'
import { emptyState, fold, checkInvariants } from '../src/modules/sangguan/fold.js'
import { loadState, rebuild, snapshot, stateToSnapshot } from '../src/modules/sangguan/projection.js'
import { setSangguanConfig } from '../src/modules/sangguan/config.js'
import { plan, execute, runNight } from '../src/modules/sangguan/deliberate.js'
import { outcomes, precedentIndex, precedentFor } from '../src/modules/sangguan/precedent.js'
import { fakeChat } from './sangguan-fake-llm.mjs'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 800)) }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-sg9-'))
const db = openDb(path.join(dir, 'app.db'))
const DAY = 86400000
let clock = Date.parse('2026-11-01T08:00:00.000Z')
const tick = (min = 1) => new Date((clock += min * 60000)).toISOString()
const agents = []
function agent(name) {
  const aid = 'agt_s9_' + name
  setSangguanConfig(db, aid, { enabled: true })
  agents.push(aid)
  return aid
}
const put = (aid, evs, expect) => append(db, aid, evs, expect)
const mk = (aid, layer, kind, text) => put(aid, [{
  type: 'CLAIM_EXP', layer, actor: 'sys', at: tick(), payload: { claims: [{ layer, kind, text, origin: 'extract' }] },
}]).entities.claims[0]
function openK(aid, layer, pos, neg, qtext) {
  const at = tick()
  const q = newId('questions', at)
  return put(aid, [{
    type: 'KAPPA_OPEN', layer, actor: 'judge', at,
    payload: { questions: [{ id: q, layer, text: qtext }], kappas: [{ layer, q_id: q, pos_id: pos, neg_id: neg, dep: 'd', excl: 'e' }] },
  }]).entities.kappas[0]
}
const KIND = { W: 'belt', L: 'chapter', V: 'norm' }
function pair(aid, layer, i, topic = '工作和休息') {
  const a = mk(aid, layer, KIND[layer], topic + '里应该先顾工作' + i)
  const b = mk(aid, layer, KIND[layer], topic + '里应该先顾休息' + i)
  return { a, b, k: openK(aid, layer, a, b, topic + '先顾哪个') }
}
const dl = (layer, k, branch, at = tick()) => ({ type: 'DELIBERATE', layer, actor: 'sys', at, payload: { kappa_id: k, branch } })
const ev = (type, layer, payload) => ({ type, layer, actor: 'sys', at: tick(), payload })
function subTrial(aid, layer, x, end) {
  const kq = loadState(db, aid).kappas[x.k].q_id
  const at = tick()
  const cid = newId('claims', at)
  put(aid, [dl(layer, x.k, 'SUB', at), {
    type: 'SUB_ACCEPT', layer, actor: 'judge', at,
    payload: { kappa_id: x.k, claims: [{ id: cid, layer, kind: KIND[layer], text: '合题' + x.k, origin: 'synth', pred: [x.a, x.b], q_id: kq, boundary: [] }] },
  }])
  if (end) put(aid, [ev(end, layer, { kappa_id: x.k })])
  return cid
}
const resolve = (aid, layer, x) => put(aid, [dl(layer, x.k, 'RESOLVE'), ev('RESOLVE', layer, { kappa_id: x.k, winner_id: x.a, loser_id: x.b })])
const suspend = (aid, layer, x) => put(aid, [dl(layer, x.k, 'SUSPEND'), ev('SUSPEND', layer, { kappa_id: x.k })])
const passJ5 = { s1: { pass: true }, s3: { pass: true }, s4: { pass: true }, s5_hint: { pass: true } }
const j4 = (input) => ({
  text: '看场合在工作与休息之间切换', kept_pos: [input.pos.text.slice(0, 2)], kept_neg: [input.neg.text.slice(0, 2)], dropped: ['只'],
  boundary: [{ text: '连续三天睡够七小时', testable: true }], nu: [{ expect: '效率不降', observe: '对话', p: 0.6, due_days: 7 }],
})
const j6 = { incommensurable: false, parallel_ok: true, loss: { lean_pole: 'pos', cost: '休息少一点' } }
const coex = (aid, layer, x, trade) => {
  put(aid, [dl(layer, x.k, 'COEX'), ev('COEX', layer, { kappa_id: x.k, loss: j6.loss })])
  if (trade) put(aid, [ev('TRADEOFF', layer, { kappa_id: x.k, lean_pole: 'pos', cost: 'c', ref: 'r' })])
}
const lastDelib = (aid, k) => readEvents(db, aid, { types: ['DELIBERATE'] }).filter((e) => e.payload.kappa_id === k).pop()

// 冷启动：池空 → P ≡ 0
{
  const aid = agent('cold')
  const x = pair(aid, 'L', 1)
  const r = await execute(db, aid, plan(db, aid, x.k, tick(), { allowSub: true, allowCoex: true }), tick(), { chat: fakeChat({ J4: j4, J5: passJ5, J6: j6 }) })
  const d = lastDelib(aid, x.k)
  check('冷启动：P ≡ 0、precedent_ids 为空', r.ok && same(d.payload.P, {}) && d.precedent_ids.length === 0, d && d.payload)
  check('冷启动：b*_noprec = b*（L 层 prior：SUB 0.30 > COEX 0.20）', d.payload.b_noprec === d.payload.branch && d.payload.branch === 'SUB', d.payload)
}

// 结局表
{
  const aid = agent('outcome')
  const sub1 = pair(aid, 'L', 1); subTrial(aid, 'L', sub1, 'SUB_CONFIRM')
  const sub2 = pair(aid, 'L', 2); subTrial(aid, 'L', sub2, 'SUB_ROLLBACK')
  const sub3 = pair(aid, 'L', 3); subTrial(aid, 'L', sub3, null)
  put(aid, [ev('SUB_DORMANT', 'L', { kappa_id: sub3.k })])
  put(aid, [ev('SUB_EXPIRE', 'L', { kappa_id: sub3.k })])
  const rOk = pair(aid, 'W', 1); resolve(aid, 'W', rOk)
  const rFal = pair(aid, 'W', 2); resolve(aid, 'W', rFal)
  put(aid, [ev('CON', 'W', { claim_id: rFal.a })])
  const rBack = pair(aid, 'W', 3); resolve(aid, 'W', rBack)
  mk(aid, 'W', 'belt', '工作和休息里应该先顾休息3')
  const cOk = pair(aid, 'L', 4); coex(aid, 'L', cOk, true)
  const cRe = pair(aid, 'L', 5); coex(aid, 'L', cRe, false)
  put(aid, [ev('REOPEN', 'L', { kappa_id: cRe.k })])
  const cNo = pair(aid, 'L', 6); coex(aid, 'L', cNo, false)
  const sEnd = pair(aid, 'W', 4); suspend(aid, 'W', sEnd)
  put(aid, [ev('REOPEN', 'W', { kappa_id: sEnd.k }), dl('W', sEnd.k, 'RESOLVE'), ev('RESOLVE', 'W', { kappa_id: sEnd.k, winner_id: sEnd.a, loser_id: sEnd.b })])
  const sMiss = pair(aid, 'W', 5)
  const regAt = tick()
  put(aid, [{ type: 'NU_REGISTER', actor: 'judge', at: regAt, payload: { nus: [{ claim_id: sMiss.a, expect: 'e', observe: 'o', p: 0.7, due_at: new Date(Date.parse(regAt) + DAY).toISOString() }] } }])
  suspend(aid, 'W', sMiss)
  const nu = Object.values(loadState(db, aid).nus).find((n) => n.claim_id === sMiss.a)
  clock += 2 * DAY
  put(aid, [{ type: 'NU_RESOLVE', actor: 'judge', at: tick(), payload: { nu_id: nu.id, outcome: 'miss', refs: ['r'] } }])
  const sNone = pair(aid, 'W', 6); suspend(aid, 'W', sNone)

  const s = loadState(db, aid)
  const early = outcomes(db, aid, s, tick())
  const o = (x, list = early) => list.filter((d) => d.kappa_id === x.k).map((d) => d.o)
  check('SUB：CONFIRM +1 / ROLLBACK −1 / EXPIRE 0', same(o(sub1), [1]) && same(o(sub2), [-1]) && same(o(sub3), [0]), { a: o(sub1), b: o(sub2), c: o(sub3) })
  check('RESOLVE 未满 T_mature：平安者尚无结局；胜方被证伪 / 败方复活 → −1', same(o(rOk), [0]) && same(o(rFal), [-1]) && same(o(rBack), [-1]), { ok: o(rOk), fal: o(rFal), back: o(rBack) })
  check('COEX 未满 T_mature：重开 → −1，其余尚无结局', same(o(cRe), [-1]) && same(o(cOk), [0]) && same(o(cNo), [0]))
  check('SUSPEND：之后 RESOLVE 收场 +1 / 挂起中 ν 落空 −1 / 无事 0', same(o(sEnd), [1, 0]) && same(o(sMiss), [-1]) && same(o(sNone), [0]), { end: o(sEnd), miss: o(sMiss), none: o(sNone) })
  clock += 15 * DAY
  const late = outcomes(db, aid, s, tick())
  check('满 T_mature：RESOLVE 平安 +1；COEX 有取舍 +1、没取舍 0', same(o(rOk, late), [1]) && same(o(cOk, late), [1]) && same(o(cNo, late), [0]), { r: o(rOk, late), c: o(cOk, late), n: o(cNo, late) })
  const past = outcomes(db, aid, s, new Date(Date.parse(early[0].at) - 1000).toISOString())
  check('只看 at ≤ now 的事件：倒回过去没有任何决策', past.length === 0, past.length)
}

// Pool 规则 + P(b) + ω + 先例改变选择
{
  const aid = agent('pool')
  const old = pair(aid, 'L', 1); coex(aid, 'L', old, true)
  const otherLayer = pair(aid, 'W', 1); suspend(aid, 'W', otherLayer)
  put(aid, [ev('REOPEN', 'W', { kappa_id: otherLayer.k }), dl('W', otherLayer.k, 'RESOLVE'), ev('RESOLVE', 'W', { kappa_id: otherLayer.k, winner_id: otherLayer.a, loser_id: otherLayer.b })])
  const far = { a: mk(aid, 'L', 'chapter', '猫喜欢晒太阳'), b: mk(aid, 'L', 'chapter', '狗喜欢追球') }
  far.k = openK(aid, 'L', far.a, far.b, '宠物爱玩什么')
  coex(aid, 'L', far, true)
  clock += 15 * DAY
  const now = pair(aid, 'L', 2)
  let s = loadState(db, aid)
  const pr = precedentFor(s, s.kappas[now.k], precedentIndex(db, aid, s, tick()))
  check('Pool：只取同层、相似（sim ≥ θ_sim）、已成熟的先例', pr.ids.length === 1 && pr.D[0].kappa_id === old.k && pr.D[0].o === 1, pr.D)
  check('P(COEX) = Σω·o / Σω = 1（单条 +1）', Math.abs((pr.P.COEX || 0) - 1) < 1e-9 && pr.D[0].omega < pr.D[0].sim, pr)
  const chat = fakeChat({ J4: j4, J5: passJ5, J6: j6 })
  const r = await execute(db, aid, plan(db, aid, now.k, tick(), { allowSub: true, allowCoex: true }), tick(), { chat })
  const d = lastDelib(aid, now.k)
  check('先例改变选择：b* = COEX，b*_noprec = SUB，precedent_ids 指向旧决策', r.branch === 'COEX' && d.payload.b_noprec === 'SUB' && same(d.precedent_ids, pr.ids), d.payload)
  put(aid, [ev('REOPEN', 'L', { kappa_id: old.k }), dl('L', old.k, 'SUSPEND'), ev('SUSPEND', 'L', { kappa_id: old.k })])
  const n3 = pair(aid, 'L', 3)
  s = loadState(db, aid)
  const pr2 = precedentFor(s, s.kappas[n3.k], precedentIndex(db, aid, s, tick()))
  const mine = pr2.D.filter((x) => x.kappa_id === old.k)
  check('每个 κ_d 只计一次；T_mature 之后才重开不算 COEX 失败，新 SUSPEND 无结局不入池', mine.length === 1 && mine[0].o === 1 && mine[0].branch === 'COEX', pr2.D)
  const later = new Date(Date.parse(tick()) + 60 * DAY).toISOString()
  const pr3 = precedentFor(s, s.kappas[n3.k], precedentIndex(db, aid, s, later))
  const w1 = pr2.D.find((x) => x.kappa_id === old.k)
  const w2 = pr3.D.find((x) => x.kappa_id === old.k)
  check('ω = sim·exp(−Δt/τ)：60 日后权重约降到 e^−2', !!(w1 && w2) && Math.abs(w2.omega / w1.omega - Math.exp(-2)) < 0.01, { w1, w2 })
}

// Inhibit + I10
{
  const aid = agent('inhibit')
  subTrial(aid, 'W', pair(aid, 'W', 1), 'SUB_ROLLBACK')
  const one = pair(aid, 'W', 9)
  let s = loadState(db, aid)
  check('N_bad(SUB)=1 < N_inhib：不抑制', precedentFor(s, s.kappas[one.k], precedentIndex(db, aid, s, tick())).nBadSub === 1)
  subTrial(aid, 'W', pair(aid, 'W', 2), 'SUB_ROLLBACK')
  const x = pair(aid, 'W', 3)
  const at = tick()
  const withP = plan(db, aid, x.k, at, { allowSub: true })
  const noP = plan(db, aid, x.k, at, { allowSub: true, precedent: false })
  check('Inhibit：N_bad(SUB)≥2 → 不调 J4', withP.inhibit === true && withP.try_sub === false && noP.try_sub === true, { w: withP.try_sub, n: noP.try_sub })
  const prop = { proposal: { text: 't' }, sGates: { ok: true } }
  const Aw = plan(db, aid, x.k, at, { allowSub: true, ...prop }).A
  const An = plan(db, aid, x.k, at, { allowSub: true, precedent: false, ...prop }).A
  check('I10 / P7：A_有先例 ⊆ A_无先例，且只少了 SUB', Aw.every((b) => An.includes(b)) && !Aw.includes('SUB') && An.includes('SUB'), { Aw, An })
  const chat = fakeChat({ J4: j4, J5: passJ5 })
  const r = await execute(db, aid, withP, tick(), { chat })
  const d = lastDelib(aid, x.k)
  check('被抑制的审议：SUSPEND、零 J4、记 inhibit 与先例 id', r.branch === 'SUSPEND' && chat.count('J4') === 0 && d.payload.inhibit === true && d.precedent_ids.length >= 2, d.payload)
}

// 新成熟先例 → Novel 一次；P10
{
  const aid = agent('novel')
  const waiting = pair(aid, 'W', 1); suspend(aid, 'W', waiting)
  const r0 = await runNight(db, aid, tick(), {})
  check('挂起且无新输入：不审议', r0.did.length === 0 && r0.queue.length === 0, r0.queue)
  const ref = pair(aid, 'W', 2); resolve(aid, 'W', ref)
  const r1 = await runNight(db, aid, tick(), {})
  check('相似决策尚未成熟：仍不审议', r1.did.length === 0, r1.did)
  clock += 15 * DAY
  const r2 = await runNight(db, aid, tick(), {})
  check('先例成熟 → 挂起的相似 κ 当夜被审议一次', r2.did.length === 1 && r2.did[0].id === waiting.k, r2.did)
  const r3 = await runNight(db, aid, tick(60), {})
  const r4 = await runNight(db, aid, tick(60), {})
  check('P10：之后两夜无新输入，不再产生 DELIBERATE', r3.did.length === 0 && r4.did.length === 0, [r3.did, r4.did])
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
  const aid = agent('fuzz')
  const bad = []
  let changed = 0
  let withPrec = 0
  for (let i = 0; i < 40; i++) {
    const layer = pick(['W', 'L', 'V'])
    const x = pair(aid, layer, i, pick(['工作和休息', '工作和家庭', '学习和娱乐']))
    const end = pick(['SUB_CONFIRM', 'SUB_ROLLBACK', 'COEX', 'SUSPEND', 'RESOLVE'])
    try {
      if (end.startsWith('SUB')) subTrial(aid, layer, x, end)
      else if (end === 'COEX' && layer !== 'W') coex(aid, layer, x, rnd() < 0.7)
      else if (end === 'RESOLVE' && layer !== 'V') resolve(aid, layer, x)
      else suspend(aid, layer, x)
    } catch (e) { bad.push({ i, w: String(e.message).slice(0, 80) }) }
    clock += Math.floor(rnd() * 4) * DAY
    if (i % 4 === 3) {
      const probe = pair(aid, pick(['W', 'L', 'V']), 100 + i, pick(['工作和休息', '学习和娱乐']))
      const at = tick()
      const prop = rnd() < 0.5 ? { proposal: { text: 't' }, sGates: { ok: true } } : {}
      const common = { allowSub: true, allowCoex: true, j6, vException: { ok: true, ids: ['v'] }, ...prop }
      const w = plan(db, aid, probe.k, at, common)
      const n = plan(db, aid, probe.k, at, { ...common, precedent: false })
      if (!w.A.every((b) => n.A.includes(b))) bad.push({ i, A: [w.A, n.A] })
      if (n.A.filter((b) => !w.A.includes(b)).some((b) => b !== 'SUB')) bad.push({ i, removed: n.A })
      if (!w.A.includes(w.branch) && !w.forced) bad.push({ i, outside: w.branch })
      if (w.precedent_ids.length) withPrec++
      if (w.branch !== w.b_noprec) changed++
    }
    const inv = checkInvariants(loadState(db, aid))
    if (inv.length) bad.push({ i, inv: inv.slice(0, 2) })
  }
  check('模糊（种子 ' + SEED + '）：I10 恒成立、Inhibit 只删 SUB、b* ∈ A', bad.length === 0, bad.slice(0, 3))
  check('模糊：确有带先例的审议', withPrec > 0, { withPrec, changed })
  console.log('  先例覆盖：', JSON.stringify({ withPrec, changed }))
}

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
