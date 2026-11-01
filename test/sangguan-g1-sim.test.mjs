/**
 * 三观第一组（S3 + S4）整体模拟：多 agent、30 天对话，走「对话后挂点 → 缓冲 → 快环 → 账本」全流程。
 * 夹具模型按话题与立场规则回放（离线）；穿插判定故障、预算耗尽、开关切换。
 * 检查：不变式全程成立、P1 重放、预算不超、记忆预算不受影响、开关关闭零动作、去重与矛盾识别效果、挂点耗时。
 * 运行：node test/sangguan-g1-sim.test.mjs（可设 SG_SEED）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { openDb } from '../src/db.js'
import { getFlag } from '../src/kernel.js'
import { llmBudgetSnapshot } from '../src/modules/llm_budget.js'
import { readEvents, lastSeq } from '../src/modules/sangguan/ledger.js'
import { loadState, rebuild, snapshot, listHeads } from '../src/modules/sangguan/projection.js'
import { checkInvariants } from '../src/modules/sangguan/fold.js'
import { setSangguanConfig } from '../src/modules/sangguan/config.js'
import { budgetSnapshot } from '../src/modules/sangguan/budget.js'
import { afterTurn, flushFast, bufferOf, pendingList } from '../src/modules/sangguan/fast.js'
import { fakeChat } from './sangguan-fake-llm.mjs'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 800)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-sgsim-'))
const db = openDb(path.join(dir, 'app.db'))
const SEED = Number(process.env.SG_SEED || 20261101)
let rs = SEED >>> 0
const rnd = () => { rs = (rs + 0x6D2B79F5) >>> 0; let t = rs; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
const pick = (a) => a[Math.floor(rnd() * a.length)]

// ---------- 话题库：每个话题两种立场、若干说法 ----------
const TOPICS = [
  { key: '努力', layer: 'W', kind: 'belt', pro: ['努力通常会有回报', '努力一般都会有回报', '多数时候付出会有收获'], con: ['努力不一定有回报', '付出和收获没什么关系'] },
  { key: '运气', layer: 'W', kind: 'belt', pro: ['运气在成败里占很大比重', '成败很大程度靠运气'], con: ['运气对成败影响很小', '成败基本不看运气'] },
  { key: '早起', layer: 'W', kind: 'obs', pro: ['早起的人效率更高', '早起能让一天更高效'], con: ['早起并不提高效率', '早起对效率没帮助'] },
  { key: '倾听', layer: 'L', kind: 'role', pro: ['我想做一个靠谱的倾听者', '我希望成为让人放心倾诉的对象'], con: ['我不想只做倾听者', '一直倾听会让我失去自己'] },
  { key: '成长', layer: 'L', kind: 'chapter', pro: ['这一阶段先把基本功练扎实', '现在最要紧的是打牢基础'], con: ['这一阶段应该多尝试新方向', '现在更要紧的是广泛探索'] },
  { key: '诚实', layer: 'V', kind: 'norm', pro: ['诚实比圆滑更重要', '宁可说实话也不讨好'], con: ['有时圆滑比诚实更重要', '照顾感受有时比说实话重要'] },
  { key: '自由', layer: 'V', kind: 'ideal', pro: ['自由是最值得追求的', '人最该守住的是自由'], con: ['安稳比自由更值得追求', '比起自由更该守住安稳'] },
  // 故障当天才出现的新话题：逼出新的成对判定
  { key: '规则', layer: 'W', kind: 'belt', from: 10, pro: ['规则能让多数人受益', '守规则通常对大家都好', '规则大体上保护了多数人'], con: ['规则常常只保护少数人', '很多规则只对少数人有利'] },
  { key: '休息', layer: 'L', kind: 'chapter', from: 10, pro: ['这阵子要把休息排在前面', '眼下先养好身体再说', '最近应该优先休息'], con: ['这阵子休息可以往后放', '眼下顾不上休息'] },
]
const byText = {}
TOPICS.forEach((t, ti) => {
  for (const [stance, list] of [['pro', t.pro], ['con', t.con]]) {
    list.forEach((text, j) => {
      const v = new Array(TOPICS.length + 4).fill(0)
      v[ti] = 1
      v[TOPICS.length + (stance === 'pro' ? 0 : 1)] = 0.75 // 同题异立场 cos≈0.64；同立场 ≈1
      v[TOPICS.length + 2 + (j % 2)] = 0.12 // 同立场不同说法 cos≈0.99
      byText[text] = { topic: t.key, ti, stance, layer: t.layer, kind: t.kind, vec: v }
    })
  }
})
const embed = async (text) => (byText[text] ? byText[text].vec : null)

// 夹具 J1：从用户回合里认出「我觉得 / 我认为 + 已知说法」，以及「试过了，结果对 / 不对」的证据
function j1Fixture(input) {
  const candidates = []
  const evidence = []
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
  return { candidates: candidates.slice(0, 8), evidence, tradeoffs: [], answers: [] }
}
// 夹具 J2：同题同立场 = dup；同题异立场 = contradict；其余 unrelated
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

// ---------- 三个 agent ----------
const AG = { normal: 'agt_sim_a', tight: 'agt_sim_b', off: 'agt_sim_off' }
setSangguanConfig(db, AG.normal, { enabled: true })
setSangguanConfig(db, AG.tight, { enabled: true, budget: { fast: 4 } })
const outage = { on: false }
const chats = {}
for (const aid of Object.values(AG)) {
  chats[aid] = fakeChat({
    J1: (input) => j1Fixture(input),
    J2: (input) => (outage.on ? new Error('判定服务不可用') : j2Fixture(input)),
  })
}

const errors = []
const budgetBad = []
const invBad = []
const hookMs = []
const flushMs = []
const stats = { flush: 0, done: 0, deferred: 0, items: 0 }
let clock = Date.parse('2026-11-02T01:00:00.000Z')
const iso = () => new Date(clock).toISOString()

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
  outage.on = d >= 10 && d <= 11 // 两天判定故障
  if (d === 20) setSangguanConfig(db, AG.normal, { enabled: false }) // 中途关一天
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
    clock += 11 * 60000 // 会话空闲 → 收尾
    if (bufferOf(db, aid).turns.length) await flush(aid)
    const day = iso().slice(0, 10)
    const snap = budgetSnapshot(db, aid, day)
    for (const [p, v] of Object.entries(snap.pools)) if (v.used > v.cap) budgetBad.push({ aid, day, p, v })
  }
}
// 收尾：故障早已恢复，再给一天让积压与延后的缓冲跑完
clock += 86400000
for (const aid of [AG.normal, AG.tight]) for (let i = 0; i < 6 && (bufferOf(db, aid).turns.length || pendingList(db, aid).length); i++) {
  afterTurn(db, aid, { user: '今天天气不错', assistant: '是啊。', sid: 'end', at: iso() }, { schedule: false })
  await flush(aid)
  clock += 86400000
}

// ======================= 断言 =======================
check('全程无写入被拒（快环产出的每笔事件都合法）', errors.length === 0, errors.slice(0, 3))
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
// 故障初期（未满降级条件）J2 失败按规则兜底 EXP，新话题可能多出重复链头；老话题必须严格去重
const oldMax = Math.max(...Object.entries(perStance).filter(([k]) => !TOPICS.find((t) => t.from && k.startsWith(t.key + '/'))).map(([, n]) => n))
const allMax = Math.max(...Object.values(perStance))
check('去重有效：老话题同一立场至多 1 条链头（其余记 DUP）', oldMax === 1 && count('DUP') > count('CLAIM_EXP'), { perStance, DUP: count('DUP'), EXP: count('CLAIM_EXP') })
check('故障兜底造成的重复有限（同一立场 ≤ 3 条）', allMax <= 3, perStance)
const topicsBoth = TOPICS.filter((t) => perStance[t.key + '/pro'] && perStance[t.key + '/con']).map((t) => t.key)
const kcPairs = evs.filter((e) => e.type === 'KAPPA_CANDIDATE').map((e) => {
  const a = byText[(db.prepare('SELECT text FROM persona_claims WHERE id=?').get(e.payload.a_id) || {}).text]
  return a && a.topic
})
check('矛盾识别：两种立场都出现的话题都记了 KAPPA_CANDIDATE', topicsBoth.every((k) => kcPairs.includes(k)), { topicsBoth, kcPairs })
check('模型自评被 W1 拒收', count('REJECT') > 0 && !layerHeads.some((h) => /作为AI/.test(h.text)))
check('用户证据入账（act / verdict）', count('EVIDENCE') > 0)
check('判定故障期间进入降级 / 积压，恢复后补判清空', count('PENDING_JUDGE') > 0 && pendingList(db, AG.normal).length === 0, { pend: count('PENDING_JUDGE'), left: pendingList(db, AG.normal).length })
const offDayEvents = evs.filter((e) => e.at.startsWith('2026-11-22'))
check('中途关闭开关的那天没有任何三观事件', offDayEvents.length === 0, offDayEvents.length)
const tightEvs = readEvents(db, AG.tight)
check('预算紧的 agent：发生过延后，但缓冲最终被消化', stats.deferred > 0 && bufferOf(db, AG.tight).turns.length === 0 && tightEvs.length > 0, { deferred: stats.deferred, left: bufferOf(db, AG.tight).turns.length })
const avgHook = hookMs.reduce((a, b) => a + b, 0) / hookMs.length
const p99Hook = [...hookMs].sort((a, b) => a - b)[Math.floor(hookMs.length * 0.99)]
check('对话挂点耗时：平均 < 2ms、p99 < 10ms（不阻塞回复）', avgHook < 2 && p99Hook < 10, { avgHook, p99Hook })
const avgFlush = flushMs.reduce((a, b) => a + b, 0) / flushMs.length
console.log('  统计：', JSON.stringify({
  ...stats, events: evs.length, claims: count('CLAIM_EXP') + count('REV'), DUP: count('DUP'), KC: count('KAPPA_CANDIDATE'), REJECT: count('REJECT'),
  EVIDENCE: count('EVIDENCE'), PENDING: count('PENDING_JUDGE'), hookAvgMs: +avgHook.toFixed(3), hookP99Ms: +p99Hook.toFixed(3), flushAvgMs: +avgFlush.toFixed(1),
  J1: chats[AG.normal].count('J1'), J2: chats[AG.normal].count('J2'),
}))

console.log(`\n通过 ${pass} / ${pass + fail}`)
try { db.close() } catch { /* ignore */ }
try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
process.exit(fail ? 1 : 0)
