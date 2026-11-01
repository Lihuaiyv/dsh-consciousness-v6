/**
 * 三观第二组升级：中环 N4 立案（J3 + U1–U4 + 问题去重 + K_open + KAPPA_QUEUED + 候选去重 / 过期），
 * 以及生产路径 runMid 默认开 SUB / COEX、降级时暂停 SUB 与立案。
 * 运行：node test/sangguan-g2-open.test.mjs（可设 SG_SEED）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { append, readEvents } from '../src/modules/sangguan/ledger.js'
import { emptyState, fold, checkInvariants } from '../src/modules/sangguan/fold.js'
import { loadState, rebuild, snapshot, stateToSnapshot } from '../src/modules/sangguan/projection.js'
import { setSangguanConfig } from '../src/modules/sangguan/config.js'
import { openCandidates, pendingOpen, uGates } from '../src/modules/sangguan/open.js'
import { runMid } from '../src/modules/sangguan/night.js'
import { recordJudge } from '../src/modules/sangguan/llm.js'
import { fakeChat } from './sangguan-fake-llm.mjs'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 800)) }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-sg2o-'))
const db = openDb(path.join(dir, 'app.db'))
const DAY = 86400000
let clock = Date.parse('2026-11-01T08:00:00.000Z')
const tick = (min = 1) => new Date((clock += min * 60000)).toISOString()
const agents = []
function agent(name, extra = {}) {
  const aid = 'agt_o_' + name
  setSangguanConfig(db, aid, { enabled: true, ...extra })
  agents.push(aid)
  return aid
}
const mk = (aid, layer, kind, text) => append(db, aid, [{
  type: 'CLAIM_EXP', layer, actor: 'sys', at: tick(), payload: { claims: [{ layer, kind, text, origin: 'extract' }] },
}]).entities.claims[0]
const cand = (aid, layer, a, b, at = tick()) => append(db, aid, [{ type: 'KAPPA_CANDIDATE', layer, actor: 'sys', at, payload: { a_id: a, b_id: b } }])
const pass3 = (q) => ({ q, dep: '没有对方就说不清自己的范围', excl: '同一情境下不能同时为真', u1: { pass: true }, u2: { pass: true }, u3: { pass: true } })
const count = (aid, t) => readEvents(db, aid, { types: [t] }).length

// 基本立案：J3 通过 → KAPPA_OPEN，gate_report 留 U1–U4
{
  const aid = agent('basic')
  const a = mk(aid, 'W', 'belt', '努力通常有回报')
  const b = mk(aid, 'W', 'belt', '努力不一定有回报')
  cand(aid, 'W', a, b)
  cand(aid, 'W', b, a)
  const chat = fakeChat({ J3: pass3('努力和回报是什么关系') })
  const r = await openCandidates(db, aid, tick(), { chat })
  const s = loadState(db, aid)
  const k = Object.values(s.kappas)[0]
  check('J3 通过 → KAPPA_OPEN，两极按创建先后定向', r.did.length === 1 && k && k.pos_id === a && k.neg_id === b && k.sigma === 'struggle', r)
  check('同一无序对的重复候选只判一次', chat.count('J3') === 1, chat.count('J3'))
  const ev = readEvents(db, aid, { types: ['KAPPA_OPEN'] })[0]
  check('立案 gate_report 含 U1–U4 全 pass', ['U1', 'U2', 'U3', 'U4'].every((u) => ev.gate_report[u] && ev.gate_report[u].pass), ev.gate_report)
  const r2 = await openCandidates(db, aid, tick(), { chat })
  check('已立案的对：下夜零调用、零事件', r2.did.length === 0 && chat.count('J3') === 1 && count(aid, 'KAPPA_OPEN') === 1)
}

// U 闸不通过 → REJECT（引用候选），之后不再判
{
  const aid = agent('ufail')
  const a = mk(aid, 'W', 'belt', '猫喜欢鱼')
  const b = mk(aid, 'W', 'belt', '狗喜欢骨头')
  cand(aid, 'W', a, b)
  const chat = fakeChat({ J3: { ...pass3('宠物喜欢什么'), u3: { pass: false, reason: '两者相容' } } })
  await openCandidates(db, aid, tick(), { chat })
  const rej = readEvents(db, aid, { types: ['REJECT'] })
  check('U3 不通过：不开 κ，记 REJECT 指回候选', count(aid, 'KAPPA_OPEN') === 0 && rej.length === 1 && rej[0].payload.failed.includes('U3') && rej[0].refs.length === 1, rej)
  await openCandidates(db, aid, tick(), { chat })
  check('U 闸已判过的候选不再调用', chat.count('J3') === 1)
  const g = uGates('W', { layer: 'W' }, { layer: 'L' }, pass3('q'))
  check('U4 [D]：跨层直接不通过', !g.ok && g.failed.includes('U4'), g)
  const g2 = uGates('W', { layer: 'W' }, { layer: 'W' }, { ...pass3('q'), dep: '  ' })
  check('U2 [D]：dep 为空不通过（即便 J 说过）', !g2.ok && g2.failed.includes('U2'), g2)
}

// J3 调不通：不落账，下夜重试；没预算：整次推迟
{
  const aid = agent('callfail')
  const a = mk(aid, 'L', 'chapter', '先打牢基础')
  const b = mk(aid, 'L', 'chapter', '先广泛探索')
  cand(aid, 'L', a, b)
  const seq0 = readEvents(db, aid).length
  await openCandidates(db, aid, tick(), { chat: fakeChat({ J3: new Error('超时') }) })
  check('J3 调不通：零事件', readEvents(db, aid).length === seq0)
  const ok = fakeChat({ J3: pass3('这阶段先做什么') })
  await openCandidates(db, aid, tick(), { chat: ok })
  check('下夜重试成功立案', count(aid, 'KAPPA_OPEN') === 1)
  const poor = agent('poor', { budget: { mid: 0, floor: 0 } })
  const x = mk(poor, 'W', 'belt', '甲')
  const y = mk(poor, 'W', 'belt', '乙')
  cand(poor, 'W', x, y)
  const before = readEvents(db, poor).length
  const r = await openCandidates(db, poor, tick(), { chat: fakeChat({ J3: pass3('q') }) })
  check('没预算：推迟，不写任何事件', r.postponed === true && readEvents(db, poor).length === before, r)
}

// 过期与终态：现算丢弃，零调用
{
  const aid = agent('expire')
  const a = mk(aid, 'W', 'belt', '旧甲')
  const b = mk(aid, 'W', 'belt', '旧乙')
  cand(aid, 'W', a, b, tick())
  clock += 31 * DAY
  const c = mk(aid, 'W', 'belt', '丙')
  const d = mk(aid, 'W', 'belt', '丁')
  cand(aid, 'W', c, d)
  append(db, aid, [{ type: 'CON', layer: 'W', actor: 'sys', at: tick(), payload: { claim_id: d } }].map((e) => e), null)
  const chat = fakeChat({ J3: pass3('q') })
  const p = pendingOpen(db, aid, loadState(db, aid), tick())
  await openCandidates(db, aid, tick(), { chat })
  check('超过 30 日的候选、一方已终态的候选：都不判', p.fresh.length === 0 && chat.count('J3') === 0, p)
}

// I4：一极正在别的 κ 里交锋 → KAPPA_QUEUED；占用解除后零调用开立
{
  const aid = agent('queue')
  const a = mk(aid, 'W', 'belt', '规则保护多数人')
  const b = mk(aid, 'W', 'belt', '规则只护少数人')
  const c = mk(aid, 'W', 'belt', '规则大体公平')
  cand(aid, 'W', a, b)
  const chat = fakeChat({ J3: (input) => pass3(input.a.text.slice(0, 2) + '的问题') })
  await openCandidates(db, aid, tick(), { chat })
  cand(aid, 'W', b, c)
  await openCandidates(db, aid, tick(), { chat })
  check('一极被占：记 KAPPA_QUEUED，不开 κ', count(aid, 'KAPPA_QUEUED') === 1 && count(aid, 'KAPPA_OPEN') === 1)
  const k1 = Object.values(loadState(db, aid).kappas)[0].id
  append(db, aid, [
    { type: 'DELIBERATE', layer: 'W', actor: 'sys', at: tick(), payload: { kappa_id: k1, branch: 'SUSPEND' } },
    { type: 'SUSPEND', layer: 'W', actor: 'sys', at: tick(), payload: { kappa_id: k1 } },
  ])
  const n3 = chat.count('J3')
  const r = await openCandidates(db, aid, tick(), { chat })
  check('占用解除：排队者按时间开立，零 J3', r.did.length === 1 && count(aid, 'KAPPA_OPEN') === 2 && chat.count('J3') === n3, r)
  const qs = db.prepare('SELECT COUNT(*) n FROM claim_questions WHERE agent_id=?').get(aid).n
  check('问题去重：同文 q 复用旧问题', qs === 1, qs)
}

// K_open：某层 struggle 数满 → 排队
{
  const aid = agent('kopen', { budget: { mid: 200 } })
  const chat = fakeChat({ J3: (input) => pass3('问题' + input.a.id) })
  for (let i = 0; i < 20; i++) {
    const a = mk(aid, 'V', 'norm', '甲' + i)
    const b = mk(aid, 'V', 'norm', '乙' + i)
    cand(aid, 'V', a, b)
  }
  for (let i = 0; i < 6; i++) await openCandidates(db, aid, tick(), { chat })
  const a = mk(aid, 'V', 'norm', '甲x')
  const b = mk(aid, 'V', 'norm', '乙x')
  cand(aid, 'V', a, b)
  await openCandidates(db, aid, tick(), { chat })
  const s = loadState(db, aid)
  const st = Object.values(s.kappas).filter((k) => k.sigma === 'struggle').length
  check('每夜至多 4 次 J3', chat.calls.filter((c) => c.id === 'J3').length <= 4 * 7)
  check('struggle 数到 K_open=20 后新矛盾排队', st === 20 && count(aid, 'KAPPA_QUEUED') === 1, { st, q: count(aid, 'KAPPA_QUEUED') })
}

// 生产路径：runMid 一夜内 立案 → 审议；默认允许 SUB
{
  const aid = agent('prod')
  const a = mk(aid, 'W', 'belt', '早起让人更高效')
  const b = mk(aid, 'W', 'belt', '早起并不提高效率')
  cand(aid, 'W', a, b)
  const chat = fakeChat({
    J3: pass3('早起和效率是什么关系'),
    J4: { text: '作息与工作类型匹配时效率最高', kept_pos: ['早起'], kept_neg: ['不提高'], dropped: ['让人更'], boundary: [{ text: '工作需晨间专注', testable: true }], nu: [] },
    J5: { s1: { pass: true }, s3: { pass: true }, s4: { pass: true }, s5_hint: { pass: true } },
    J7: { items: [] }, J12: { cross: [] },
  })
  const r = await runMid(db, aid, tick(), { chat })
  check('runMid 生产路径：立案并当夜审议', r.open.length === 1 && r.night.did.length === 1, { open: r.open, night: r.night && r.night.did })
  check('生产路径默认尝试合题（SUB_ACCEPT）', count(aid, 'SUB_ACCEPT') === 1 && chat.count('J4') === 1, { j4: chat.count('J4') })
}

// 降级（近 24h 判定失败率 > 50%）：暂停立案与 SUB
{
  const aid = agent('degraded')
  const a = mk(aid, 'W', 'belt', '读书越多越明理')
  const b = mk(aid, 'W', 'belt', '读书多未必明理')
  cand(aid, 'W', a, b)
  const at = tick()
  for (let i = 0; i < 5; i++) recordJudge(db, aid, Date.parse(at) - i * 1000, false)
  const chat = fakeChat({ J3: pass3('q'), J7: { items: [] } })
  const r = await runMid(db, aid, at, { chat })
  check('降级：不立案、不调 J3', r.degraded === true && r.open.length === 0 && chat.count('J3') === 0, r.open)
}

// 模糊：随机候选 + 随机 J3 结论，多夜运行后不变式与 P1 成立
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
  const bugs = []
  const tally = { open: 0, queued: 0, rej: 0, call: 0 }
  const chat = fakeChat({
    J3: () => {
      const r = rnd()
      if (r < 0.1) return new Error('网络')
      if (r < 0.15) return '坏'
      return { ...pass3('问' + Math.floor(rnd() * 6)), u3: { pass: rnd() < 0.8 } }
    },
    J7: { items: [] }, J12: { cross: [] },
    J4: '坏', J6: '坏',
  })
  for (let i = 0; i < 60; i++) {
    const layer = pick(['W', 'L', 'V'])
    const kinds = { W: ['belt', 'obs'], L: ['chapter', 'role'], V: ['norm', 'ideal'] }[layer]
    try {
      const s = loadState(db, aid)
      const live = Object.values(s.claims).filter((c) => c.layer === layer && c.status !== 'falsified')
      if (live.length < 2 || rnd() < 0.4) mk(aid, layer, pick(kinds), layer + i)
      else {
        const a = pick(live)
        const b = pick(live)
        if (a.id !== b.id) cand(aid, layer, a.id, b.id)
      }
      if (rnd() < 0.15 && live.length) {
        const c = pick(live)
        if (c.status === 'active') append(db, aid, [{ type: 'CON', layer, actor: 'sys', at: tick(), payload: { claim_id: c.id } }])
      }
    } catch (e) { if (!/status|闸|迁移|KAPPA|已终态/.test(String(e.message))) bugs.push({ i, w: String(e.message).slice(0, 80) }) }
    if (rnd() < 0.3) {
      clock += DAY
      try {
        const r = await runMid(db, aid, tick(), { chat })
        tally.open += r.open.length
      } catch (e) { bugs.push({ i, mid: String(e.message).slice(0, 120) }) }
    }
    const inv = checkInvariants(loadState(db, aid))
    if (inv.length) bugs.push({ i, inv: inv.slice(0, 2) })
  }
  tally.queued = count(aid, 'KAPPA_QUEUED')
  tally.rej = readEvents(db, aid, { types: ['REJECT'] }).length
  tally.call = chat.count('J3')
  check('模糊（种子 ' + SEED + '）：中环无异常、不变式成立', bugs.length === 0, bugs.slice(0, 3))
  check('模糊：确有立案', tally.open > 0, tally)
  console.log('  模糊覆盖：', JSON.stringify(tally))
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
