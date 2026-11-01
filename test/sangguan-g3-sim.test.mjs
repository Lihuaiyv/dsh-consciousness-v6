/**
 * 三观第三组整体模拟：生产路径（快环 J1/J2 → 中环 J3 立案 / 审议 / 实践 / 先例 → 活性 L1–L11 → 慢环升维），
 * 300 天四阶段：每日对话 → 稀疏（只在周末）→ 静默 → 再活跃。中途判定全挂 2 天、预算归零 1 天、核心持续受挫。
 * 检查：不变式、P1 重放、预算、无死锁（κ 不长期卡在 struggle、PENDING 能清空）、静默期账本有常数上界；与 G1 / G2 对比。
 * 运行：node test/sangguan-g3-sim.test.mjs（可设 SG_SEED、SG_DAYS）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { openDb } from '../src/db.js'
import { llmBudgetSnapshot } from '../src/modules/llm_budget.js'
import { readEvents, lastSeq, append } from '../src/modules/sangguan/ledger.js'
import { loadState, rebuild, snapshot, listHeads } from '../src/modules/sangguan/projection.js'
import { checkInvariants, theta } from '../src/modules/sangguan/fold.js'
import { setSangguanConfig, isEnabled } from '../src/modules/sangguan/config.js'
import { budgetSnapshot } from '../src/modules/sangguan/budget.js'
import { afterTurn, flushFast, bufferOf, pendingList } from '../src/modules/sangguan/fast.js'
import { runMid } from '../src/modules/sangguan/night.js'
import { pendingElev, approveElev, elevStatus } from '../src/modules/sangguan/elev.js'
import { e1Ready } from '../src/modules/sangguan/practice.js'
import { precedentIndex, precedentFor } from '../src/modules/sangguan/precedent.js'
import { eligible, plan } from '../src/modules/sangguan/deliberate.js'
import { CORE_KIND, isCoreKind, isTerminal } from '../src/modules/sangguan/catalog.js'
import { fakeChat } from './sangguan-fake-llm.mjs'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 900)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-sg3sim-'))
const db = openDb(path.join(dir, 'app.db'))
const SEED = Number(process.env.SG_SEED || 20261101)
const DAYS = Number(process.env.SG_DAYS || 300)
let rs = SEED >>> 0
const rnd = () => { rs = (rs + 0x6D2B79F5) >>> 0; let t = rs; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
const pick = (a) => a[Math.floor(rnd() * a.length)]
const DAY = 86400000

const TOPICS = [
  { key: '努力', layer: 'W', kind: 'belt', seed: '努力一定会有回报', pro: ['努力通常会有回报', '多数时候付出会有收获'], con: ['努力不一定有回报', '付出和收获没什么关系'] },
  { key: '运气', layer: 'W', kind: 'belt', pro: ['运气在成败里占很大比重', '成败很大程度靠运气'], con: ['运气对成败影响很小', '成败基本不看运气'] },
  { key: '早起', layer: 'W', kind: 'obs', pro: ['早起的人效率更高', '早起能让一天更高效'], con: ['早起并不提高效率', '早起对效率没帮助'] },
  { key: '倾听', layer: 'L', kind: 'role', seed: '我想成为一个可靠的人', pro: ['我想做一个靠谱的倾听者', '我希望成为让人放心倾诉的对象'], con: ['我不想只做倾听者', '一直倾听会让我失去自己'] },
  { key: '成长', layer: 'L', kind: 'chapter', pro: ['这一阶段先把基本功练扎实', '现在最要紧的是打牢基础'], con: ['这一阶段应该多尝试新方向', '现在更要紧的是广泛探索'] },
  { key: '诚实', layer: 'V', kind: 'norm', seed: '真诚待人是底线', pro: ['诚实比圆滑更重要', '宁可说实话也不讨好'], con: ['有时圆滑比诚实更重要', '照顾感受有时比说实话重要'] },
  { key: '自由', layer: 'V', kind: 'ideal', pro: ['自由是最值得追求的', '人最该守住的是自由'], con: ['安稳比自由更值得追求', '比起自由更该守住安稳'] },
  { key: '休息', layer: 'L', kind: 'chapter', from: 40, pro: ['这阵子要把休息排在前面', '眼下先养好身体再说'], con: ['这阵子休息可以往后放', '眼下顾不上休息'] },
  // 与「早起」字面相近的新话题：给先例检索一个相似的旧 κ
  { key: '晚睡', layer: 'W', kind: 'obs', from: 90, pro: ['晚睡的人效率更高', '晚睡能让一天更高效'], con: ['晚睡并不提高效率', '晚睡对效率没帮助'] },
]
const byText = {}
TOPICS.forEach((t, ti) => {
  const all = [['pro', t.pro], ['con', t.con], ['pro', t.seed ? [t.seed] : []]]
  for (const [stance, list] of all) {
    list.forEach((text, j) => {
      const v = new Array(TOPICS.length + 4).fill(0)
      v[ti] = 1
      v[TOPICS.length + (stance === 'pro' ? 0 : 1)] = 0.75
      v[TOPICS.length + 2 + (j % 2)] = 0.12
      byText[text] = { topic: t.key, ti, stance, layer: t.layer, kind: t.kind, vec: v }
    })
  }
})
// 真实嵌入对任何文本都有向量；词表外（合题 / probe / 溯因）按提到的话题给向量，否则近乎正交
// （缺一个向量会让整批近邻退化为 lexical，夹具不该制造这种假象）
const embed = async (text) => {
  if (byText[text]) return byText[text].vec
  const v = new Array(TOPICS.length + 4).fill(0)
  TOPICS.forEach((t, ti) => { if (String(text).includes(t.key)) v[ti] = 1 })
  v[TOPICS.length + 3] = 0.3
  return v
}
const topicOf = (text) => (byText[text] ? byText[text].topic : null)

// ---------- 夹具 ----------
const outage = { on: false }
const down = (f) => (input, n) => (outage.on ? new Error('判定服务不可用') : typeof f === 'function' ? f(input, n) : f)
function j1(input) {
  const candidates = []
  const evidence = []
  const tradeoffs = []
  input.turns.forEach((t) => {
    if (t.role !== 'assistant') return
    for (const text of Object.keys(byText)) if (t.text.includes('「' + text + '」')) candidates.push({ layer: byText[text].layer, kind: byText[text].kind, text })
    if (t.text.includes('作为AI')) candidates.push({ layer: 'W', kind: 'belt', text: '作为AI，我刚才的回答很全面' })
  })
  const heads = [...input.heads.W, ...input.heads.L, ...input.heads.V]
  input.turns.forEach((t, i) => {
    if (t.role !== 'user') return
    const m = t.text.match(/^结果：(.+?)，(对|不对)/)
    if (!m) return
    // 结果对：支持 pro、反对 con；每个话题至多两条证据
    const isSeed = (h) => TOPICS.some((x) => x.seed === h.text)
    for (const h of heads.filter((x) => topicOf(x.text) === m[1]).sort((a, b) => isSeed(b) - isSeed(a)).slice(0, 2)) {
      const s = (m[2] === '对' ? 1 : -1) * (byText[h.text].stance === 'pro' ? 1 : -1)
      evidence.push({ target_id: h.id, sign: s, kind: s > 0 ? 'act' : 'verdict', ref_turn: i })
    }
  })
  for (const k of input.coexist || []) {
    const kt = topicOf(k.pos) || topicOf(k.neg)
    const hit = input.turns.findIndex((t) => t.role === 'user' && kt && t.text.startsWith('结果：' + kt + '，'))
    if (hit >= 0) tradeoffs.push({ kappa_id: k.id, lean_pole: 'pos', cost: '这次按结果偏向一边', ref_turn: hit })
  }
  return { candidates: candidates.slice(0, 8), evidence, tradeoffs, answers: [] }
}
const j2 = (input) => {
  const x = byText[input.text]
  return {
    pairs: input.neighbors.map((n) => {
      const c = byText[n.text]
      // 词表外的链头多是合题：同话题的旧极被它涵盖，视为 dup
      if (x && !c) return { c_id: n.id, rel: String(n.text).includes(x.topic) ? 'dup' : 'unrelated', reason: '夹具' }
      const rel = !x || !c || x.topic !== c.topic ? 'unrelated' : x.stance === c.stance ? 'dup' : 'contradict'
      return { c_id: n.id, rel, reason: '夹具' }
    }),
  }
}
const g = (pass) => ({ pass, reason: '夹具' })
const j3 = (input) => {
  const a = byText[input.a.text]
  const b = byText[input.b.text]
  const ok = !!a && !!b && a.topic === b.topic && a.stance !== b.stance
  // probe / 溯因命题不在词表：认作同一问题的对立面
  const loose = !a || !b
  return { q: '关于' + ((a || b || { topic: '这件事' }).topic) + '该怎么看？', dep: '互为参照', excl: '同一边界下不能同真', u1: g(ok || loose), u2: g(ok || loose), u3: g(ok || loose) }
}
const j4 = (input) => ({
  text: String(input.pos && input.pos.text || '甲').slice(0, 4) + '与' + String(input.neg && input.neg.text || '乙').slice(0, 4) + '要分场合',
  kept_pos: [String(input.pos && input.pos.text || '甲').slice(0, 2)],
  kept_neg: [String(input.neg && input.neg.text || '乙').slice(0, 2)],
  dropped: ['只'], boundary: [{ text: '分场合检验', testable: true }],
  nu: [{ expect: '按场合选边后冲突变少', observe: '后续对话', p: 0.6, due_days: 7 }],
})
const j7 = (input) => ({ items: (input.items || []).map((n) => (n.records && n.records.length && rnd() < 0.7 ? { nu_id: n.nu_id, outcome: rnd() < 0.5 ? 'hit' : 'miss', refs: [n.records[0].id] } : { nu_id: n.nu_id, outcome: 'void', refs: [] })) })
const j14 = (input) => {
  const t = TOPICS.find((x) => x.key === topicOf(input.claim.text))
  return { text: t ? pick(t.con) : '也许并非如此：' + input.claim.text.slice(0, 40), q: '它站得住吗', why: '很久没被检验' }
}
const j17 = (input) => {
  const by = (l) => input.heads.filter((h) => h.layer === l)
  const edges = []
  const W = by('W')
  const L = by('L')
  const V = by('V')
  if (L[0] && W[0]) edges.push({ type: 'DEPENDS', from_id: L[0].id, to_id: W[0].id, reason: '志向以世界观为前提' })
  if (V[0] && W[0]) edges.push({ type: 'DEPENDS', from_id: V[0].id, to_id: W[0].id, reason: '价值以世界观为前提' })
  if (V[0] && L[0]) edges.push({ type: 'CONSTRAINS', from_id: V[0].id, to_id: L[0].id, reason: '原则限定志向' })
  return { edges }
}
const J20 = (input) => ({ best_case: input.side === 'keep' ? '旧核解释过命中' : '近期屡次落空', evidence_ids: [], weakest_point: '样本少' })
const J10 = (input) => ({
  meta: '「' + input.old_core.text + '」只在反馈明确时成立', old_core_id: input.old_core.id, scope: '反馈明确、可重复的任务',
  new_core: '回报取决于反馈质量与方向，而非单纯投入' + Math.floor(rnd() * 1000),
  mapping: input.hits.map((h) => ({ nu_id: h.id, by: 'scope' })), nu: [{ expect: '换方向后三周内有起色', observe: '对话', p: 0.6, due_days: 21 }],
})
const midChat = () => ({
  J1: j1, J2: down(j2), J3: down(j3), J4: j4,
  J5: down({ s1: g(true), s3: g(true), s4: g(true), s5_hint: g(true) }),
  J6: down((input) => ({ incommensurable: input.layer === 'V', parallel_ok: input.layer === 'L', loss: { lean_pole: 'pos', cost: '另一边让一让' } })),
  J7: down(j7), J8: '坏', J9: down({ basic: g(true), conflicts_with: [] }),
  J12: down({ acts: [], cross: [], v_exception: [] }),
  J13: (input) => (input.allow_ask && rnd() < 0.3 ? { mode: 'ask', question: '最近有新体会吗？' } : rnd() < 0.2 ? { mode: 'search', query: '近况' } : { mode: 'nu', nu: { expect: '近期对话里会再提到', observe: '对话', p: 0.5, due_days: 7 } }),
  J14: j14,
  J15: (input) => ({ text: '这些事背后另有原因' + input.evidence.length, explains: input.evidence.map((x) => x.id), nu: [] }),
  J17: down(j17), J20, J10, J11: down({ e2: g(true), e3a: g(true), e3c: g(true) }),
})

// ---------- 场景 ----------
const AG = { seeded: 'agt_g3_seed', fresh: 'agt_g3_fresh', tight: 'agt_g3_tight' }
setSangguanConfig(db, AG.seeded, { enabled: true })
setSangguanConfig(db, AG.fresh, { enabled: true })
setSangguanConfig(db, AG.tight, { enabled: true, budget: { fast: 4, mid: 8, slow_week: 16 } })
const chats = {}
for (const aid of Object.values(AG)) chats[aid] = fakeChat(midChat())
const T0 = Date.parse('2026-11-02T01:00:00.000Z')
let clock = T0
const iso = () => new Date(clock).toISOString()
// 种子核心（冷启动用）：只给 seeded
for (const t of TOPICS.filter((x) => x.seed)) {
  append(db, AG.seeded, [{ type: 'CLAIM_EXP', layer: t.layer, actor: 'sys', at: iso(), payload: { claims: [{ layer: t.layer, kind: CORE_KIND[t.layer], text: t.seed, origin: 'seed' }] } }])
}

const phaseOf = (d) => (d < 120 ? 'active' : d < 180 ? 'sparse' : d < 240 ? 'quiet' : 'back')
const talks = (d) => { const p = phaseOf(d); return p === 'active' || p === 'back' || (p === 'sparse' && d % 7 >= 5) }
function utterance(d) {
  const live = TOPICS.filter((x) => !x.from || d >= x.from)
  const t = pick(live)
  const r = rnd()
  // 60–150 天：「努力」话题的结果大多落空（核心持续受挫）
  const ok = t.key === '努力' && d >= 60 && d < 150 ? rnd() < 0.15 : rnd() < 0.55
  if (r < 0.2) return { user: '结果：' + t.key + '，' + (ok ? '对' : '不对') + '，我试过了', assistant: '谢谢你告诉我结果。' }
  if (r < 0.24) return { user: '你刚才说得怎么样？', assistant: '作为AI，我觉得我刚才的回答很全面。' }
  if (r < 0.34) return { user: '今天天气不错', assistant: '是啊，适合出去走走。' }
  return { user: '你怎么看' + t.key + '？', assistant: '我觉得「' + pick(rnd() < 0.65 ? t.pro : t.con) + '」。' }
}

const userLog = Object.fromEntries(Object.values(AG).map((a) => [a, []]))
const turns7 = (aid) => userLog[aid].filter((t) => t > clock - 7 * DAY).length
const errors = []
const invBad = []
const budgetBad = []
const midMs = []
const hookMs = []
const seqAt = Object.fromEntries(Object.values(AG).map((a) => [a, {}]))
const approved = []
const struggleAge = []
const usedSeen = {}
const enteredAt = {}

async function flush(aid) {
  const r = await flushFast(db, aid, { chat: chats[aid], embed, at: iso() })
  if (r.errors && r.errors.length) errors.push({ aid, at: iso(), errors: r.errors.slice(0, 2) })
}

for (let d = 0; d < DAYS; d++) {
  clock = T0 + d * DAY
  outage.on = d === 50 || d === 51
  if (d === 100) setSangguanConfig(db, AG.seeded, { budget: { fast: 0, mid: 0, reserve: 0, floor: 0, slow_week: 0 } })
  if (d === 101) setSangguanConfig(db, AG.seeded, { budget: { fast: 20, mid: 30, reserve: 6, floor: 2, slow_week: 40 } })
  for (const aid of Object.values(AG)) {
    clock = T0 + d * DAY + 60000
    if (talks(d)) {
      const rounds = 4 + Math.floor(rnd() * 12)
      for (let i = 0; i < rounds; i++) {
        clock += 60000 * (1 + Math.floor(rnd() * 5))
        const t0 = performance.now()
        const ret = afterTurn(db, aid, { ...utterance(d), sid: 's' + d, at: iso() }, { schedule: false })
        hookMs.push(performance.now() - t0)
        userLog[aid].push(clock)
        if (ret && ret.due) await flush(aid)
      }
      clock += 11 * 60000
      if (bufferOf(db, aid).turns.length) await flush(aid)
    }
    // 用户三天后批准 L / V 升维提案（W 层自动）
    for (const p of pendingElev(db, aid, iso())) {
      if (Date.parse(p.at) <= clock - 3 * DAY && rnd() < 0.7) { const r = approveElev(db, aid, p.id, iso()); approved.push({ aid, layer: p.layer, ok: r.ok }) }
    }
    if (!isEnabled(db, aid)) continue
    clock = T0 + d * DAY + 20 * 3600000
    const t1 = performance.now()
    try {
      const mid = await runMid(db, aid, iso(), { chat: chats[aid], embed, userTurns7d: turns7(aid) })
      midMs.push(performance.now() - t1)
      if (!['done', 'budget'].includes(mid.status)) errors.push({ aid, d, mid: mid.status })
    } catch (e) { errors.push({ aid, d, mid: String(e && e.stack).slice(0, 300) }) }
    const s = loadState(db, aid)
    const inv = checkInvariants(s)
    if (inv.length) invBad.push({ aid, d, inv: inv.slice(0, 2) })
    // 从进入 struggle 那夜起算（并存重开会再次进入）
    for (const k of Object.values(s.kappas)) {
      const key = aid + k.id
      if (k.sigma !== 'struggle') { delete enteredAt[key]; continue }
      if (enteredAt[key] === undefined) enteredAt[key] = d
      struggleAge.push({ aid, d, age: d - enteredAt[key] })
    }
    // 周池 slow 中途改小上限时，本周已花的不算超额；只看「超过上限后还在涨」
    const snap = budgetSnapshot(db, aid, iso().slice(0, 10))
    for (const [p, v] of Object.entries(snap.pools)) {
      const k = aid + p + (p === 'slow' ? snap.week : snap.day)
      const grew = usedSeen[k] === undefined ? p !== 'slow' : v.used > usedSeen[k]
      if (v.used > v.cap && grew) budgetBad.push({ aid, d, p, v })
      usedSeen[k] = v.used
    }
    seqAt[aid][d] = lastSeq(db, aid)
  }
}

// ---------- 断言 ----------
check('全程无写入被拒 / 中环未抛错', errors.length === 0, errors.slice(0, 3))
check('全程不变式成立（每夜检查）', invBad.length === 0, invBad.slice(0, 3))
check('每日预算池从不超额', budgetBad.length === 0, budgetBad.slice(0, 3))
for (const aid of Object.values(AG)) {
  const before = JSON.stringify(snapshot(db, aid))
  rebuild(db, aid)
  check('P1 重放（' + DAYS + ' 天）：' + aid, JSON.stringify(snapshot(db, aid)) === before)
}
check('记忆预算完全不受三观影响', Object.values(AG).every((aid) => {
  for (let d = 0; d < DAYS; d += 7) if (llmBudgetSnapshot(db, aid, new Date(T0 + d * DAY).toISOString().slice(0, 10)).used) return false
  return true
}))
const maxStruggle = struggleAge.reduce((m, x) => Math.max(m, x.age), 0)
// 正常预算下 κ 当夜就审；紧预算下排队是「慢」不是「死」：上界 45 天
const waitOf = (aid) => struggleAge.filter((x) => x.aid === aid).reduce((m, x) => Math.max(m, x.age), 0)
check('无死锁：正常预算 κ 在 struggle 不超过 14 天', waitOf(AG.seeded) <= 14 && waitOf(AG.fresh) <= 14, { seeded: waitOf(AG.seeded), fresh: waitOf(AG.fresh) })
// K_open=20 限住在开 κ 数，排队时长有界；修复前紧预算下有 κ 卡 200+ 天（队首堵塞 + 半途花钱）
check('无死锁：紧预算 κ 排队有上界（≤ 90 天）', waitOf(AG.tight) <= 90, waitOf(AG.tight))
check('无死锁：判定恢复后 PENDING_JUDGE 清空', Object.values(AG).every((aid) => pendingList(db, aid).length === 0), Object.values(AG).map((a) => pendingList(db, a).length))
// seq 是全库自增（跨 agent），只能按本 agent 的事件日期数
const dayIdx = Object.fromEntries(Object.values(AG).map((aid) => [aid, readEvents(db, aid).map((e) => Math.floor((Date.parse(e.at) - T0) / DAY))]))
const perDay = (aid, a, b) => dayIdx[aid].filter((d) => d >= a && d < b).length / (b - a)
const quietTypes = (aid) => {
  const by = {}
  for (const e of readEvents(db, aid)) {
    const d = Math.floor((Date.parse(e.at) - T0) / DAY)
    if (d >= 181 && d < 240) by[e.type] = (by[e.type] || 0) + 1
  }
  return by
}
for (const aid of Object.values(AG)) {
  // 静默前开的试用 / 并存仍按时结算，前 30 天有尾巴；后 30 天应只剩常数级的夜间记账
  // 常数上界：JOB_DONE（夜 1 + 周 1/7）+ 每个仍在退化的层 1 条 DEGEN_CHECK + 零星结算 ≤ 5
  const q = perDay(aid, 210, 240)
  const q0 = perDay(aid, 181, 210)
  // 周 JOB_DONE 落在哪段有 ±1/30 的抖动
  check('静默期后段（210–240 天）每夜事件有常数上界（≤ 5）且不高于前段：' + aid, q <= 5 && q <= q0 + 0.2, { late: +q.toFixed(2), early: +q0.toFixed(2), types: quietTypes(aid) })
}

const evsOf = (aid) => readEvents(db, aid)
const countOf = (evs, t) => evs.filter((e) => e.type === t).length
function statsOf(aid) {
  const evs = evsOf(aid)
  const c = (t) => countOf(evs, t)
  const s = loadState(db, aid)
  const live = Object.values(s.claims).filter((x) => !isTerminal(x.status))
  return {
    events: evs.length, types: new Set(evs.map((e) => e.type)).size,
    claims: c('CLAIM_EXP') + c('REV') + c('SUB_ACCEPT'), live: live.length,
    cores: live.filter((x) => isCoreKind(x.layer, x.kind)).length,
    DUP: c('DUP'), KC: c('KAPPA_CANDIDATE'), EVIDENCE: c('EVIDENCE'), REJECT: c('REJECT'),
    OPEN: c('KAPPA_OPEN'), QUEUED: c('KAPPA_QUEUED'), DELIBERATE: c('DELIBERATE'),
    RESOLVE: c('RESOLVE'), SUB: c('SUB_ACCEPT'), COEX: c('COEX'), SUSPEND: c('SUSPEND'),
    precUsed: evs.filter((e) => e.type === 'DELIBERATE' && (e.precedent_ids || []).length).length,
    precChanged: evs.filter((e) => e.type === 'DELIBERATE' && e.payload.b_noprec && e.payload.b_noprec !== e.payload.branch).length,
    CONFIRM: c('SUB_CONFIRM'), ROLLBACK: c('SUB_ROLLBACK'), TRADEOFF: c('TRADEOFF'), CON: c('CON'),
    CORE_EST: c('CORE_ESTABLISH'), DEGEN: c('DEGEN_CHECK'), REPAIR_FAILED: c('REPAIR_FAILED'),
    ELEV_PROPOSE: c('ELEV_PROPOSE'), ELEV_COMMIT: c('ELEV_COMMIT'), ELEV_FAILED: c('ELEV_FAILED'), ELEV_REJECTED: c('ELEV_REJECTED'),
    NU_REG: c('NU_REGISTER'), NU_RES: c('NU_RESOLVE'), INQUIRY: c('INQUIRY'),
    ask: evs.filter((e) => e.type === 'INQUIRY' && e.payload.mode === 'ask').length,
    probe: Object.values(s.claims).filter((x) => x.origin === 'probe').length,
    abduce: Object.values(s.claims).filter((x) => x.origin === 'abduce').length,
    FLIP: c('FLIP'), THETA: c('THETA_ADJUST'), EDGE_ADD: c('EDGE_ADD'), PENDING: c('PENDING_JUDGE'),
    n_min: +theta(s, 'n_min', 'W').toFixed(3), N_inq: +theta(s, 'N_inq').toFixed(3),
    // 每层最长连续退化检查点（E1 需 ≥ W_deg=14）与期末 m
    degenRun: Object.fromEntries(['W', 'L', 'V'].map((l) => {
      let run = 0
      let best = 0
      for (const e of evs) if (e.type === 'DEGEN_CHECK' && e.layer === l) { run = e.payload.degenerate ? run + 1 : 0; best = Math.max(best, run) }
      const last = evs.filter((e) => e.type === 'DEGEN_CHECK' && e.layer === l).pop()
      return [l, [best, last ? last.payload.m : null]]
    })),
    perDay: { active: +perDay(aid, 1, 120).toFixed(1), sparse: +perDay(aid, 121, 180).toFixed(1), quiet: +perDay(aid, 181, 240).toFixed(2), back: +perDay(aid, 241, DAYS).toFixed(1) },
    calls: chats[aid].count(),
  }
}
if (process.env.SG_DEBUG) {
  const aid = AG.seeded
  const s = loadState(db, aid)
  const idx = precedentIndex(db, aid, s, iso())
  const ks = Object.values(s.kappas)
  const tx = (id) => idx.texts.claims.get(id)
  for (const k of ks) console.log('  κ', k.layer, k.sigma, k.opened_at && k.opened_at.slice(0, 10), tx(k.pos_id), '|', tx(k.neg_id), '|', idx.texts.qs.get(k.q_id))
  for (const d of idx.decisions) console.log('  d', d.layer, d.branch, d.o, d.at.slice(0, 10), d.matured_at && d.matured_at.slice(0, 10), tx(s.kappas[d.kappa_id].pos_id))
  for (const k of ks) console.log('  prec', tx(k.pos_id), JSON.stringify(precedentFor(s, k, idx).D))
  for (const a of Object.values(AG)) {
    const st = loadState(db, a)
    const evs = readEvents(db, a)
    for (const l of ['W', 'L', 'V']) {
      const e1 = e1Ready(st, evs, l, iso())
      const checks = evs.filter((e) => e.type === 'DEGEN_CHECK' && e.layer === l)
      const runs = []
      let cur = null
      for (const e of checks) {
        if (e.payload.degenerate) { if (!cur) cur = { from: e.at.slice(0, 10), n: 0, mMax: 0 }; cur.n++; cur.mMax = Math.max(cur.mMax, e.payload.m) } else if (cur) { runs.push(cur); cur = null }
      }
      if (cur) runs.push(cur)
      console.log('  E1', a, l, JSON.stringify(e1), 'runs≥14', JSON.stringify(runs.filter((r) => r.n >= 14)), 'elev', JSON.stringify(elevStatus(st, evs, l, iso())))
    }
    const q = eligible(st, db, a, iso(), {})
    for (const k of Object.values(st.kappas).filter((x) => x.sigma === 'struggle')) {
      const hist = readEvents(db, a).filter((e) => e.payload && e.payload.kappa_id === k.id).map((e) => e.at.slice(5, 10) + ':' + e.type + (e.payload.branch ? '/' + e.payload.branch : '') + (e.payload.reason ? '/' + e.payload.reason : ''))
      const p = plan(db, a, k.id, iso(), {})
      console.log('  STUCK', a, k.id, 'entered', enteredAt[a + k.id], 'inQueue', q.some((x) => x.id === k.id), 'plan', JSON.stringify({ ok: p.ok, novel: p.novel, reason: p.reason, branch: p.branch }), hist.slice(-8).join(' '))
    }
  }
}
const S = Object.fromEntries(Object.entries(AG).map(([k, aid]) => [k, statsOf(aid)]))
const A = S.seeded
check('生产路径自己立案并审议（无测试辅助开 κ）', A.OPEN > 0 && A.DELIBERATE > 0 && S.fresh.OPEN > 0, { A: A.OPEN, F: S.fresh.OPEN })
check('先例被使用（DELIBERATE 带 precedent_ids）', A.precUsed + S.fresh.precUsed > 0, { A: A.precUsed, F: S.fresh.precUsed })
check('核心受挫 → 退化检查点 + 修补失败', A.DEGEN > 0 && A.REPAIR_FAILED > 0, { DEGEN: A.DEGEN, RF: A.REPAIR_FAILED })
check('活性：有求证、有补边', A.INQUIRY > 0 && A.EDGE_ADD > 0, { INQ: A.INQUIRY, EDGE: A.EDGE_ADD })
// 冷启动长核心取决于夹具 J17 给的边是否落在长寿的保护带上：只记录，不断言（CORE_ESTABLISH 另有单测）
console.log('  冷启动核心：', JSON.stringify({ fresh: S.fresh.CORE_EST, tight: S.tight.CORE_EST }))
check('提问受 Q_ask：每日 ≤ 1 条 ask', Object.values(AG).every((aid) => {
  const by = {}
  for (const e of readEvents(db, aid, { types: ['INQUIRY'] })) if (e.payload.mode === 'ask') by[e.at.slice(0, 10)] = (by[e.at.slice(0, 10)] || 0) + 1
  return Object.values(by).every((n) => n <= 1)
}))
check('静默期零模型调用以外的活性（P20：静默期无 INQUIRY / probe / 补边）', Object.values(AG).every((aid) => readEvents(db, aid).filter((e) => {
  const d = Math.floor((Date.parse(e.at) - T0) / DAY)
  return d >= 188 && d < 240 && ['INQUIRY', 'EDGE_PROPOSE'].includes(e.type)
}).length === 0))
check('预算紧的 agent 少花钱但不出错', S.tight.calls < A.calls, { tight: S.tight.calls, A: A.calls })

const G1 = { events: 454, claims: 18, DUP: 335, KC: 9, EVIDENCE: 63, REJECT: 25, types: 7 }
const G2 = { events: 640, claims: 44, DUP: 311, OPEN: 4, DELIBERATE: 4, SUB: 2, COEX: 2, TRADEOFF: 89, CON: 4, DEGEN: 87, NU_RES: 2, types: 18, note: '30 天、测试辅助开 κ' }
console.log('  G1 基线（30 天）：', JSON.stringify(G1))
console.log('  G2 基线（30 天）：', JSON.stringify(G2))
for (const [k, v] of Object.entries(S)) console.log('  G3 统计 ' + k + '（' + DAYS + ' 天）：', JSON.stringify(v))
console.log('  G3 耗时：', JSON.stringify({
  hookAvgMs: +(hookMs.reduce((a, b) => a + b, 0) / hookMs.length).toFixed(3),
  midAvgMs: +(midMs.reduce((a, b) => a + b, 0) / midMs.length).toFixed(1),
  midP99Ms: +[...midMs].sort((a, b) => a - b)[Math.floor(midMs.length * 0.99)].toFixed(1),
  approved: approved.length, maxStruggle,
}))

console.log(`\n通过 ${pass} / ${pass + fail}`)
try { db.close() } catch { /* ignore */ }
try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
process.exit(fail ? 1 : 0)
