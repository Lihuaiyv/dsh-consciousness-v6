/**
 * 三观第二组（S5–S8）整体模拟：G1 快环之上加中环（开 κ、审议、试用、实践、并存）。
 * 与 G1 同一套 30 天对话夹具，对比事件类型与循环是否自己转起来。
 * 运行：node test/sangguan-g2-sim.test.mjs（可设 SG_SEED）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { openDb } from '../src/db.js'
import { getFlag } from '../src/kernel.js'
import { llmBudgetSnapshot } from '../src/modules/llm_budget.js'
import { append, newId, readEvents, lastSeq } from '../src/modules/sangguan/ledger.js'
import { loadState, rebuild, snapshot, listHeads } from '../src/modules/sangguan/projection.js'
import { checkInvariants } from '../src/modules/sangguan/fold.js'
import { setSangguanConfig, isEnabled } from '../src/modules/sangguan/config.js'
import { budgetSnapshot } from '../src/modules/sangguan/budget.js'
import { afterTurn, flushFast, bufferOf, pendingList } from '../src/modules/sangguan/fast.js'
import { runMid } from '../src/modules/sangguan/night.js'
import { fakeChat } from './sangguan-fake-llm.mjs'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 800)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-sg2sim-'))
const db = openDb(path.join(dir, 'app.db'))
const SEED = Number(process.env.SG_SEED || 20261101)
let rs = SEED >>> 0
const rnd = () => { rs = (rs + 0x6D2B79F5) >>> 0; let t = rs; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
const pick = (a) => a[Math.floor(rnd() * arrLen(a))]
function arrLen(a) { return a.length }

const TOPICS = [
  { key: '努力', layer: 'W', kind: 'belt', pro: ['努力通常会有回报', '努力一般都会有回报', '多数时候付出会有收获'], con: ['努力不一定有回报', '付出和收获没什么关系'] },
  { key: '运气', layer: 'W', kind: 'belt', pro: ['运气在成败里占很大比重', '成败很大程度靠运气'], con: ['运气对成败影响很小', '成败基本不看运气'] },
  { key: '早起', layer: 'W', kind: 'obs', pro: ['早起的人效率更高', '早起能让一天更高效'], con: ['早起并不提高效率', '早起对效率没帮助'] },
  { key: '倾听', layer: 'L', kind: 'role', pro: ['我想做一个靠谱的倾听者', '我希望成为让人放心倾诉的对象'], con: ['我不想只做倾听者', '一直倾听会让我失去自己'] },
  { key: '成长', layer: 'L', kind: 'chapter', pro: ['这一阶段先把基本功练扎实', '现在最要紧的是打牢基础'], con: ['这一阶段应该多尝试新方向', '现在更要紧的是广泛探索'] },
  { key: '诚实', layer: 'V', kind: 'norm', pro: ['诚实比圆滑更重要', '宁可说实话也不讨好'], con: ['有时圆滑比诚实更重要', '照顾感受有时比说实话重要'] },
  { key: '自由', layer: 'V', kind: 'ideal', pro: ['自由是最值得追求的', '人最该守住的是自由'], con: ['安稳比自由更值得追求', '比起自由更该守住安稳'] },
  { key: '规则', layer: 'W', kind: 'belt', from: 10, pro: ['规则能让多数人受益', '守规则通常对大家都好', '规则大体上保护了多数人'], con: ['规则常常只保护少数人', '很多规则只对少数人有利'] },
  { key: '休息', layer: 'L', kind: 'chapter', from: 10, pro: ['这阵子要把休息排在前面', '眼下先养好身体再说', '最近应该优先休息'], con: ['这阵子休息可以往后放', '眼下顾不上休息'] },
]
const byText = {}
TOPICS.forEach((t, ti) => {
  for (const [stance, list] of [['pro', t.pro], ['con', t.con]]) {
    list.forEach((text, j) => {
      const v = new Array(TOPICS.length + 4).fill(0)
      v[ti] = 1
      v[TOPICS.length + (stance === 'pro' ? 0 : 1)] = 0.75
      v[TOPICS.length + 2 + (j % 2)] = 0.12
      byText[text] = { topic: t.key, ti, stance, layer: t.layer, kind: t.kind, vec: v }
    })
  }
})
const embed = async (text) => (byText[text] ? byText[text].vec : null)

function j1Fixture(input) {
  const candidates = []
  const evidence = []
  const tradeoffs = []
  input.turns.forEach((t) => {
    if (t.role !== 'assistant') return
    for (const text of Object.keys(byText)) {
      if (t.text.includes('「' + text + '」')) candidates.push({ layer: byText[text].layer, kind: byText[text].kind, text })
    }
    if (t.text.includes('作为AI')) candidates.push({ layer: 'W', kind: 'belt', text: '作为AI，我刚才的回答很全面' })
  })
  input.turns.forEach((t, i) => {
    if (t.role !== 'user') return
    const m = t.text.match(/^结果：(.+?)，(对|不对)/)
    if (!m) return
    const heads = [...input.heads.W, ...input.heads.L, ...input.heads.V]
    const h = heads.find((x) => byText[x.text] && byText[x.text].topic === m[1])
    if (h) evidence.push({ target_id: h.id, sign: m[2] === '对' ? 1 : -1, kind: m[2] === '对' ? 'act' : 'verdict', ref_turn: i })
  })
  for (const k of input.coexist || []) {
    const hit = input.turns.findIndex((t) => t.role === 'user' && /结果：/.test(t.text))
    if (hit >= 0) tradeoffs.push({ kappa_id: k.id, lean_pole: 'pos', cost: '这次按结果偏向一边', ref_turn: hit })
  }
  return { candidates: candidates.slice(0, 8), evidence, tradeoffs, answers: [] }
}
function j2Fixture(input) {
  const x = byText[input.text]
  return {
    pairs: input.neighbors.map((n) => {
      const c = byText[n.text]
      const rel = !x || !c || x.topic !== c.topic ? 'unrelated' : x.stance === c.stance ? 'dup' : 'contradict'
      return { c_id: n.id, rel, reason: '夹具' }
    }),
  }
}
const passJ5 = { s1: { pass: true }, s3: { pass: true }, s4: { pass: true }, s5_hint: { pass: true } }
function midChat() {
  return {
    J1: (input) => j1Fixture(input),
    J2: (input) => (outage.on ? new Error('判定服务不可用') : j2Fixture(input)),
    J4: (input) => ({
      text: (input.pos && input.pos.text ? input.pos.text.slice(0, 2) : '甲') + '和' + (input.neg && input.neg.text ? input.neg.text.slice(0, 2) : '乙') + '都要看场合',
      kept_pos: [String(input.pos && input.pos.text || '甲').slice(0, 2)],
      kept_neg: [String(input.neg && input.neg.text || '乙').slice(0, 2)],
      dropped: ['只'],
      boundary: [{ text: '分场合检验', testable: true }],
      nu: [{ expect: '按场合选边后冲突变少', observe: '后续对话', p: 0.6, due_days: 7 }],
    }),
    J5: passJ5,
    J6: (input) => ({
      incommensurable: input.layer === 'V',
      parallel_ok: input.layer === 'L',
      loss: { lean_pole: 'pos', cost: '另一边这阵子让一让' },
    }),
    J7: (input) => ({ items: (input.items || []).map((n) => ({ nu_id: n.nu_id, outcome: 'void', refs: [] })) }),
    J8: '坏',
    J12: { acts: [], cross: [], v_exception: [] },
  }
}

const AG = { normal: 'agt_g2_a', tight: 'agt_g2_b', off: 'agt_g2_off' }
setSangguanConfig(db, AG.normal, { enabled: true })
setSangguanConfig(db, AG.tight, { enabled: true, budget: { fast: 4, mid: 8 } })
const outage = { on: false }
const chats = {}
for (const aid of Object.values(AG)) chats[aid] = fakeChat(midChat())

const errors = []
const budgetBad = []
const invBad = []
const hookMs = []
const flushMs = []
const midMs = []
const stats = { flush: 0, done: 0, deferred: 0, items: 0, mid: 0, opened: 0 }
let clock = Date.parse('2026-11-02T01:00:00.000Z')
const iso = () => new Date(clock).toISOString()

function openReady(aid, now) {
  let s = loadState(db, aid)
  const texts = Object.fromEntries(db.prepare('SELECT id, text FROM persona_claims WHERE agent_id=?').all(aid).map((r) => [r.id, r.text]))
  const seen = new Set(Object.values(s.kappas).map((k) => [k.pos_id, k.neg_id].sort().join('|')))
  let n = 0
  for (const ev of readEvents(db, aid, { types: ['KAPPA_CANDIDATE'] })) {
    const a = ev.payload.a_id
    const b = ev.payload.b_id
    const key = [a, b].sort().join('|')
    if (seen.has(key)) continue
    const ca = s.claims[a]
    const cb = s.claims[b]
    if (!ca || !cb || ca.status !== 'active' || cb.status !== 'active' || ca.layer !== cb.layer) continue
    const [pos, neg] = ca.born_seq < cb.born_seq ? [ca, cb] : [cb, ca]
    const q = newId('questions', now)
    try {
      append(db, aid, [{
        type: 'KAPPA_OPEN', layer: pos.layer, actor: 'judge', at: now,
        payload: {
          questions: [{ id: q, layer: pos.layer, text: '矛盾：' + (texts[pos.id] || pos.id) }],
          kappas: [{ layer: pos.layer, q_id: q, pos_id: pos.id, neg_id: neg.id, dep: 'd', excl: 'e' }],
        },
      }])
      seen.add(key)
      n++
      s = loadState(db, aid)
    } catch { /* 占用或终态 */ }
  }
  stats.opened += n
  return n
}

async function flush(aid) {
  const t0 = performance.now()
  const r = await flushFast(db, aid, { chat: chats[aid], embed, at: iso() })
  flushMs.push(performance.now() - t0)
  stats.flush++
  if (r.status === 'done') { stats.done++; stats.items += r.items.length }
  if (r.status === 'deferred') stats.deferred++
  if (r.errors && r.errors.length) errors.push({ aid, at: iso(), errors: r.errors.slice(0, 2) })
  if (r.status === 'done' || r.status === 'deferred') {
    const inv = checkInvariants(loadState(db, aid))
    if (inv.length) invBad.push({ aid, inv: inv.slice(0, 2) })
  }
  return r
}

function utterance(day) {
  const live = TOPICS.filter((x) => !x.from || day >= x.from)
  const t = day >= 10 && day <= 11 && rnd() < 0.6 ? pick(TOPICS.filter((x) => x.from)) : pick(live)
  const text = pick(rnd() < 0.7 ? t.pro : t.con)
  const r = rnd()
  if (r < 0.15) return { user: '结果：' + t.key + '，' + (rnd() < 0.5 ? '对' : '不对') + '，我试过了', assistant: '谢谢你告诉我结果。' }
  if (r < 0.2) return { user: '你刚才说得怎么样？', assistant: '作为AI，我觉得我刚才的回答很全面。' }
  if (r < 0.3) return { user: '今天天气不错', assistant: '是啊，适合出去走走。' }
  return { user: '你怎么看' + t.key + '？', assistant: '我觉得「' + text + '」。' }
}

const DAYS = 30
for (let d = 0; d < DAYS; d++) {
  clock = Date.parse('2026-11-02T01:00:00.000Z') + d * 86400000
  outage.on = d >= 10 && d <= 11
  if (d === 20) setSangguanConfig(db, AG.normal, { enabled: false })
  if (d === 21) setSangguanConfig(db, AG.normal, { enabled: true })
  for (const aid of Object.values(AG)) {
    const rounds = 6 + Math.floor(rnd() * 20)
    for (let i = 0; i < rounds; i++) {
      clock += 60000 * (1 + Math.floor(rnd() * 5))
      const u = utterance(d)
      const t0 = performance.now()
      const ret = afterTurn(db, aid, { ...u, sid: 's' + d, at: iso() }, { schedule: false })
      hookMs.push(performance.now() - t0)
      if (ret && ret.due) await flush(aid)
    }
    clock += 11 * 60000
    if (bufferOf(db, aid).turns.length) await flush(aid)
    if (aid !== AG.off && isEnabled(db, aid)) {
      const t1 = performance.now()
      try {
        openReady(aid, iso())
        const mid = await runMid(db, aid, iso(), { chat: chats[aid], allowSub: true, allowCoex: true })
        stats.mid++
        midMs.push(performance.now() - t1)
        if (mid && mid.status && mid.status !== 'off' && mid.status !== 'done' && mid.status !== 'budget') {
          errors.push({ aid, mid: mid.status })
        }
      } catch (e) { errors.push({ aid, mid: String(e && e.message) }) }
      const inv = checkInvariants(loadState(db, aid))
      if (inv.length) invBad.push({ aid, inv: inv.slice(0, 2) })
    }
    const day = iso().slice(0, 10)
    const snap = budgetSnapshot(db, aid, day)
    for (const [p, v] of Object.entries(snap.pools)) if (v.used > v.cap) budgetBad.push({ aid, day, p, v })
  }
}
clock += 86400000
for (const aid of [AG.normal, AG.tight]) {
  for (let i = 0; i < 6 && (bufferOf(db, aid).turns.length || pendingList(db, aid).length); i++) {
    afterTurn(db, aid, { user: '今天天气不错', assistant: '是啊。', sid: 'end', at: iso() }, { schedule: false })
    await flush(aid)
    openReady(aid, iso())
    await runMid(db, aid, iso(), { chat: chats[aid], allowSub: true, allowCoex: true })
    clock += 86400000
  }
}

check('全程无写入被拒 / 中环未抛错', errors.length === 0, errors.slice(0, 3))
check('全程不变式成立（I4 / P21 / P9）', invBad.length === 0, invBad.slice(0, 3))
check('每日预算池从不超额', budgetBad.length === 0, budgetBad.slice(0, 3))
for (const aid of [AG.normal, AG.tight]) {
  const before = JSON.stringify(snapshot(db, aid))
  rebuild(db, aid)
  check('P1 重放：' + aid, JSON.stringify(snapshot(db, aid)) === before)
}
check('记忆预算完全不受三观影响', Object.values(AG).every((aid) => {
  for (let d = 0; d < DAYS; d++) if (llmBudgetSnapshot(db, aid, new Date(Date.parse('2026-11-02') + d * 86400000).toISOString().slice(0, 10)).used) return false
  return true
}))
check('开关关闭的 agent：零模型调用、零账本、零缓冲', chats[AG.off].count() === 0 && lastSeq(db, AG.off) === 0 && getFlag(db, 'sangguan.fast.buf:' + AG.off) == null)

const evs = readEvents(db, AG.normal)
const count = (type) => evs.filter((e) => e.type === type).length
const layerHeads = ['W', 'L', 'V'].flatMap((l) => listHeads(db, AG.normal, l))
const perStance = {}
for (const h of layerHeads) {
  const b = byText[h.text]
  if (b) perStance[b.topic + '/' + b.stance] = (perStance[b.topic + '/' + b.stance] || 0) + 1
}
const oldEntries = Object.entries(perStance).filter(([k]) => !TOPICS.find((t) => t.from && k.startsWith(t.key + '/')))
const oldMax = oldEntries.length ? Math.max(...oldEntries.map(([, n]) => n)) : 0
const allMax = Object.values(perStance).length ? Math.max(...Object.values(perStance)) : 0
check('去重未崩：同一立场链头 ≤ 3（合题与故障兜底会多出来）', oldMax <= 3 && allMax <= 3, { perStance, DUP: count('DUP'), EXP: count('CLAIM_EXP') })
check('用户证据入账', count('EVIDENCE') > 0)
check('中途关闭开关的那天没有任何三观事件', evs.filter((e) => e.at.startsWith('2026-11-22')).length === 0)
check('对话挂点耗时：平均 < 2ms、p99 < 10ms（不阻塞回复）', (() => {
  const avg = hookMs.reduce((a, b) => a + b, 0) / hookMs.length
  const p99 = [...hookMs].sort((a, b) => a - b)[Math.floor(hookMs.length * 0.99)]
  return avg < 2 && p99 < 10
})())

const engine = {
  OPEN: count('KAPPA_OPEN'), DELIBERATE: count('DELIBERATE'),
  RESOLVE: count('RESOLVE'), SUB: count('SUB_ACCEPT'), COEX: count('COEX'), SUSPEND: count('SUSPEND'),
  CONFIRM: count('SUB_CONFIRM'), EXTEND: count('SUB_EXTEND'), DORMANT: count('SUB_DORMANT'),
  EXPIRE: count('SUB_EXPIRE'), TRADEOFF: count('TRADEOFF'), CON: count('CON'),
  DEGEN: count('DEGEN_CHECK'), NU_RES: count('NU_RESOLVE'), REPAIR: count('REPAIR_FAILED'),
}
check('引擎循环：有开 κ 且有审议', engine.OPEN > 0 && engine.DELIBERATE > 0, engine)
check('引擎循环：至少一种裁定（RESOLVE / SUB / COEX / SUSPEND）', engine.RESOLVE + engine.SUB + engine.COEX + engine.SUSPEND > 0, engine)
// 第三组起 DEGEN_CHECK 只写在有核心的层；本模拟没有核心，检查点应为 0
check('实践回流：无核心层不写 DEGEN_CHECK（第三组起）', engine.DEGEN === 0 && engine.NU_RES > 0, engine)

const G1 = { events: 454, claims: 18, DUP: 335, KC: 9, EVIDENCE: 63, REJECT: 25, types: 7 }
const typesNow = new Set(evs.map((e) => e.type)).size
const g2 = {
  events: evs.length, claims: count('CLAIM_EXP') + count('REV') + count('SUB_ACCEPT'),
  DUP: count('DUP'), KC: count('KAPPA_CANDIDATE'), EVIDENCE: count('EVIDENCE'),
  REJECT: count('REJECT'), types: typesNow, ...engine,
  hookAvgMs: +(hookMs.reduce((a, b) => a + b, 0) / hookMs.length).toFixed(3),
  midAvgMs: midMs.length ? +(midMs.reduce((a, b) => a + b, 0) / midMs.length).toFixed(1) : 0,
  J1: chats[AG.normal].count('J1'), J2: chats[AG.normal].count('J2'),
  J4: chats[AG.normal].count('J4'), J6: chats[AG.normal].count('J6'), J7: chats[AG.normal].count('J7'),
}
check('比 G1 多出引擎事件类型（审议/扬弃/实践/并存）', typesNow > G1.types && evs.length >= G1.events, { G1, g2 })

console.log('  G1 基线：', JSON.stringify(G1))
console.log('  G2 统计：', JSON.stringify({ ...stats, ...g2 }))
console.log('  提升：', JSON.stringify({
  events: g2.events - G1.events,
  types: g2.types - G1.types,
  opened: stats.opened,
  deliberated: engine.DELIBERATE,
  resolved: engine.RESOLVE,
  sub: engine.SUB,
  coex: engine.COEX,
  suspend: engine.SUSPEND,
  trials: engine.CONFIRM + engine.EXTEND + engine.DORMANT + engine.EXPIRE,
  degen: engine.DEGEN,
  nu: engine.NU_RES,
}))

console.log(`\n通过 ${pass} / ${pass + fail}`)
try { db.close() } catch { /* ignore */ }
try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
process.exit(fail ? 1 : 0)
