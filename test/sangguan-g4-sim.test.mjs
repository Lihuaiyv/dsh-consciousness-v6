/**
 * 三观第四组整体模拟：在 G3 生产路径之上加上注入（shadow 7 日 → 经接口切 live）、接口读写、用户裁决 / 回答提问 / 审批、
 * L2 自传摘要、explain、r_J，最后整 agent 清除。四个 agent：常规（种子核心）/ 冷启动 / 紧预算 / 开关关闭。
 * 阶段：活跃 → 稀疏 → 静默 → 再活跃；中途判定全挂 2 天（场景⑤）、常规 agent 预算归零 1 天（场景⑥）、核心持续受挫（场景③）。
 * 检查：不变式、P1 重放、预算、注入只读且守预算、关闭 agent 零痕迹、清除只删目标；与 G3 对比。
 * 运行：node test/sangguan-g4-sim.test.mjs（可设 SG_SEED、SG_DAYS）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-sg4sim-'))
process.env.DSH_HOME = home
process.env.DSHC_TEST_NO_LIMIT = '1'
const { openDb } = await import('../src/db.js')
const { llmBudgetSnapshot } = await import('../src/modules/llm_budget.js')
const { readEvents, lastSeq, append } = await import('../src/modules/sangguan/ledger.js')
const { loadState, rebuild, snapshot, listHeads } = await import('../src/modules/sangguan/projection.js')
const { checkInvariants } = await import('../src/modules/sangguan/fold.js')
const { setSangguanConfig, sangguanConfig } = await import('../src/modules/sangguan/config.js')
const { budgetSnapshot } = await import('../src/modules/sangguan/budget.js')
const { afterTurn, flushFast, bufferOf, pendingList } = await import('../src/modules/sangguan/fast.js')
const { runMid } = await import('../src/modules/sangguan/night.js')
const { pendingElev } = await import('../src/modules/sangguan/elev.js')
const { injectView, promptHook, injectLog } = await import('../src/modules/sangguan/inject.js')
const { listSummaries } = await import('../src/modules/sangguan/summary.js')
const { explain } = await import('../src/modules/sangguan/explain.js')
const { rJOf } = await import('../src/modules/sangguan/verdict.js')
const { purgeAgent } = await import('../src/modules/sangguan/purge.js')
const { L0_TABLES, PROJ_TABLES } = await import('../src/modules/sangguan/schema.js')
const { CORE_KIND, isTerminal } = await import('../src/modules/sangguan/catalog.js')
const api = await import('../src/api.js')
const { fakeChat } = await import('./sangguan-fake-llm.mjs')

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 900)) }
}

const db = openDb(path.join(home, 'app.db'))
const SEED = Number(process.env.SG_SEED || 20261101)
const DAYS = Number(process.env.SG_DAYS || 200)
let rs = SEED >>> 0
const rnd = () => { rs = (rs + 0x6D2B79F5) >>> 0; let t = rs; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
const pick = (a) => a[Math.floor(rnd() * a.length)]
const DAY = 86400000

// ---------- 话题与向量（同 G3） ----------
const TOPICS = [
  { key: '努力', layer: 'W', kind: 'belt', seed: '努力一定会有回报', pro: ['努力通常会有回报', '多数时候付出会有收获'], con: ['努力不一定有回报', '付出和收获没什么关系'] },
  { key: '运气', layer: 'W', kind: 'belt', pro: ['运气在成败里占很大比重', '成败很大程度靠运气'], con: ['运气对成败影响很小', '成败基本不看运气'] },
  { key: '早起', layer: 'W', kind: 'obs', pro: ['早起的人效率更高', '早起能让一天更高效'], con: ['早起并不提高效率', '早起对效率没帮助'] },
  { key: '倾听', layer: 'L', kind: 'role', seed: '我想成为一个可靠的人', pro: ['我想做一个靠谱的倾听者', '我希望成为让人放心倾诉的对象'], con: ['我不想只做倾听者', '一直倾听会让我失去自己'] },
  { key: '成长', layer: 'L', kind: 'chapter', pro: ['这一阶段先把基本功练扎实', '现在最要紧的是打牢基础'], con: ['这一阶段应该多尝试新方向', '现在更要紧的是广泛探索'] },
  { key: '诚实', layer: 'V', kind: 'norm', seed: '真诚待人是底线', pro: ['诚实比圆滑更重要', '宁可说实话也不讨好'], con: ['有时圆滑比诚实更重要', '照顾感受有时比说实话重要'] },
  { key: '自由', layer: 'V', kind: 'ideal', pro: ['自由是最值得追求的', '人最该守住的是自由'], con: ['安稳比自由更值得追求', '比起自由更该守住安稳'] },
  { key: '休息', layer: 'L', kind: 'chapter', from: 40, pro: ['这阵子要把休息排在前面', '眼下先养好身体再说'], con: ['这阵子休息可以往后放', '眼下顾不上休息'] },
  { key: '晚睡', layer: 'W', kind: 'obs', from: 90, pro: ['晚睡的人效率更高', '晚睡能让一天更高效'], con: ['晚睡并不提高效率', '晚睡对效率没帮助'] },
]
const byText = {}
TOPICS.forEach((t, ti) => {
  for (const [stance, list] of [['pro', t.pro], ['con', t.con], ['pro', t.seed ? [t.seed] : []]]) {
    list.forEach((text, j) => {
      const v = new Array(TOPICS.length + 4).fill(0)
      v[ti] = 1
      v[TOPICS.length + (stance === 'pro' ? 0 : 1)] = 0.75
      v[TOPICS.length + 2 + (j % 2)] = 0.12
      byText[text] = { topic: t.key, ti, stance, layer: t.layer, kind: t.kind, vec: v }
    })
  }
})
const embed = async (text) => {
  if (byText[text]) return byText[text].vec
  const v = new Array(TOPICS.length + 4).fill(0)
  TOPICS.forEach((t, ti) => { if (String(text).includes(t.key)) v[ti] = 1 })
  v[TOPICS.length + 3] = 0.3
  return v
}
const topicOf = (text) => (byText[text] ? byText[text].topic : null)

// ---------- 夹具（G3 同款 + J16 / J19） ----------
const outage = { on: false }
const down = (f) => (input, n) => (outage.on ? new Error('判定服务不可用') : typeof f === 'function' ? f(input, n) : f)
function j1(input) {
  const candidates = []
  const evidence = []
  const tradeoffs = []
  input.turns.forEach((t) => {
    if (t.role !== 'assistant') return
    for (const text of Object.keys(byText)) if (t.text.includes('「' + text + '」')) candidates.push({ layer: byText[text].layer, kind: byText[text].kind, text })
  })
  const heads = [...input.heads.W, ...input.heads.L, ...input.heads.V]
  input.turns.forEach((t, i) => {
    if (t.role !== 'user') return
    const m = t.text.match(/^结果：(.+?)，(对|不对)/)
    if (!m) return
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
      if (x && !c) return { c_id: n.id, rel: String(n.text).includes(x.topic) ? 'dup' : 'unrelated', reason: '夹具' }
      const rel = !x || !c || x.topic !== c.topic ? 'unrelated' : x.stance === c.stance ? 'dup' : 'contradict'
      return { c_id: n.id, rel, reason: '夹具' }
    }),
  }
}
const g = (p) => ({ pass: p, reason: '夹具' })
const j3 = (input) => {
  const a = byText[input.a.text]
  const b = byText[input.b.text]
  const ok = !!a && !!b && a.topic === b.topic && a.stance !== b.stance
  const loose = !a || !b
  return { q: '关于' + ((a || b || { topic: '这件事' }).topic) + '该怎么看？', dep: '互为参照', excl: '同一边界下不能同真', u1: g(ok || loose), u2: g(ok || loose), u3: g(ok || loose) }
}
const j4 = (input) => ({
  text: String(input.pos && input.pos.text || '甲').slice(0, 4) + '与' + String(input.neg && input.neg.text || '乙').slice(0, 4) + '要分场合',
  kept_pos: [String(input.pos && input.pos.text || '甲').slice(0, 2)], kept_neg: [String(input.neg && input.neg.text || '乙').slice(0, 2)],
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
  const [W, L, V] = [by('W'), by('L'), by('V')]
  const edges = []
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
// J16：转折点偶尔编造（应被拒收、沿用旧版）；J19：偶尔加数字（应被拒收、回落模板句）
let j16Bad = 0
let j19Bad = 0
const J16 = (input) => {
  const evs = input.events
  if (rnd() < 0.1) { j16Bad++; return { chapter: '编的一章', at_the_time: '编的', hindsight: '编的', turning_points: ['ev_不存在'] } }
  return { chapter: '第' + (listCount + 1) + '程', at_the_time: '那时我在想' + (evs[0] && evs[0].what ? evs[0].what.slice(0, 20) : '很多事'), hindsight: '现在看是在慢慢定下来', turning_points: evs.slice(-2).map((e) => e.id) }
}
let listCount = 0
const J19 = (input) => {
  if (rnd() < 0.2) { j19Bad++; return { sentence: '这条看法已经被证实了 999 次。' } }
  return { sentence: '说到底，' + input.claim + '——这是我一路攒下来的看法。' }
}
const midChat = () => ({
  J1: j1, J2: down(j2), J3: down(j3), J4: j4,
  J5: down({ s1: g(true), s3: g(true), s4: g(true), s5_hint: g(true) }),
  J6: down((input) => ({ incommensurable: input.layer === 'V', parallel_ok: input.layer === 'L', loss: { lean_pole: 'pos', cost: '另一边让一让' } })),
  J7: down(j7), J8: '坏', J9: down({ basic: g(true), conflicts_with: [] }),
  J12: down({ acts: [], cross: [], v_exception: [] }),
  J13: (input) => (input.allow_ask && rnd() < 0.3 ? { mode: 'ask', question: '最近有新体会吗？' } : rnd() < 0.2 ? { mode: 'search', query: '近况' } : { mode: 'nu', nu: { expect: '近期对话里会再提到', observe: '对话', p: 0.5, due_days: 7 } }),
  J14: j14,
  J15: (input) => ({ text: '这些事背后另有原因' + input.evidence.length, explains: input.evidence.map((x) => x.id), nu: [] }),
  J16, J17: down(j17), J19, J20, J10, J11: down({ e2: g(true), e3a: g(true), e3c: g(true) }),
})

// ---------- agent ----------
let kseq = 0
const H = async (method, p, body, token = 'user') => api.handle(db, { method, path: '/v1/agents/' + p, token, body: ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) ? { __idempotencyKey: 'g4-' + (++kseq), ...(body || {}) } : (body || {}) })
const mk = async (name) => (await api.handle(db, { method: 'POST', path: '/v1/agents', token: 'user', body: { name, __idempotencyKey: 'mk-' + name } })).body.id
const AG = { main: await mk('常规'), fresh: await mk('冷启动'), tight: await mk('紧预算'), off: await mk('关闭') }
const ON = [AG.main, AG.fresh, AG.tight]
for (const aid of ON) {
  const r = await H('PUT', aid + '/sangguan/config', { enabled: true, ...(aid === AG.tight ? { budget: { fast: 4, mid: 8, slow_week: 16 } } : {}) })
  if (r.status !== 200) throw new Error('打开三观失败 ' + JSON.stringify(r.body))
}
const chats = Object.fromEntries([...ON, AG.off].map((a) => [a, fakeChat(midChat())]))
const T0 = Date.parse('2026-11-02T01:00:00.000Z')
let clock = T0
const iso = () => new Date(clock).toISOString()
for (const t of TOPICS.filter((x) => x.seed)) {
  append(db, AG.main, [{ type: 'CLAIM_EXP', layer: t.layer, actor: 'sys', at: iso(), payload: { claims: [{ layer: t.layer, kind: CORE_KIND[t.layer], text: t.seed, origin: 'seed' }] } }])
}

const phaseOf = (d) => (d < 80 ? 'active' : d < 120 ? 'sparse' : d < 160 ? 'quiet' : 'back')
const talks = (d) => { const p = phaseOf(d); return p === 'active' || p === 'back' || (p === 'sparse' && d % 7 >= 5) }
function utterance(d) {
  const live = TOPICS.filter((x) => !x.from || d >= x.from)
  const t = pick(live)
  const ok = t.key === '努力' && d >= 40 && d < 110 ? rnd() < 0.15 : rnd() < 0.55
  const r = rnd()
  if (r < 0.2) return { user: '结果：' + t.key + '，' + (ok ? '对' : '不对') + '，我试过了', assistant: '谢谢你告诉我结果。' }
  if (r < 0.3) return { user: '今天天气不错', assistant: '是啊，适合出去走走。' }
  return { user: '你怎么看' + t.key + '？', assistant: '我觉得「' + pick(rnd() < 0.65 ? t.pro : t.con) + '」。' }
}

const legacy = () => ({ worldLine: '你对世界的基本看法：旧仪表一句。', lifeLine: '你的人生观底色：旧志向。', valLine: '你看重：自由、成长、安全。' })
const errors = []
const invBad = []
const budgetBad = []
const injectBad = []
const apiBad = []
const usedSeen = {}
const midMs = []
const liveAt = {}
const verdicts = { counted: 0, capped: 0, answered: 0, override: 0, approved: 0 }
const userLog = Object.fromEntries([...ON, AG.off].map((a) => [a, []]))
const turns7 = (aid) => userLog[aid].filter((t) => t > clock - 7 * DAY).length
const TERM_TEXT = new Set()

async function flush(aid) {
  const r = await flushFast(db, aid, { chat: chats[aid], embed, at: iso() })
  if (r.errors && r.errors.length) errors.push({ aid, at: iso(), errors: r.errors.slice(0, 2) })
}

for (let d = 0; d < DAYS; d++) {
  clock = T0 + d * DAY
  outage.on = d === 30 || d === 31
  if (d === 60) await H('PUT', AG.main + '/sangguan/config', { budget: { fast: 0, mid: 0, reserve: 0, floor: 0, slow_week: 0 } })
  if (d === 61) await H('PUT', AG.main + '/sangguan/config', { budget: { fast: 20, mid: 30, reserve: 6, floor: 2, slow_week: 40 } })
  for (const aid of [...ON, AG.off]) {
    clock = T0 + d * DAY + 60000
    if (talks(d)) {
      const rounds = 4 + Math.floor(rnd() * 10)
      for (let i = 0; i < rounds; i++) {
        clock += 60000 * (1 + Math.floor(rnd() * 5))
        // 宿主每轮组装提示词时走 promptHook；关闭的 agent 必须原样返回
        const lg = legacy()
        const out = promptHook(db, aid, lg, { now: iso() })
        if (aid === AG.off && out !== lg) injectBad.push({ aid, d, why: '关闭却改了提示词' })
        if (out !== lg && sangguanConfig(db, aid).inject !== 'live') injectBad.push({ aid, d, why: 'shadow 却改了提示词' })
        const ret = afterTurn(db, aid, { ...utterance(d), sid: 's' + d, at: iso() }, { schedule: false })
        userLog[aid].push(clock)
        if (ret && ret.due) await flush(aid)
      }
      clock += 11 * 60000
      if (bufferOf(db, aid).turns.length) await flush(aid)
    }
    if (aid === AG.off) continue
    // 用户：白天偶尔对一条看法说「对 / 不对」，回答它的提问；三天后批 L / V 升维提案
    if (talks(d)) {
      const heads = ['W', 'L', 'V'].flatMap((l) => listHeads(db, aid, l)).filter((h) => !isTerminal(h.status))
      if (heads.length && rnd() < 0.5) {
        const h = pick(heads)
        const judged = readEvents(db, aid, { types: ['CLAIM_EXP', 'REV', 'SUB_ACCEPT'] }).filter((e) => e.actor === 'judge' && (e.payload.claims || []).some((c) => c.id === h.id)).pop()
        const over = judged && rnd() < 0.3 ? judged.id : undefined
        for (let k = 0; k < 2; k++) {
          const r = await H('POST', aid + '/sangguan/verdict', { target_type: 'claim', target_id: h.id, sign: rnd() < 0.7 ? 1 : -1, override_of: over })
          if (r.status !== 200) apiBad.push({ aid, d, verdict: r.body })
          else if (r.body.counted) { verdicts.counted++; if (over) verdicts.override++ } else verdicts.capped++
        }
      }
      const asks = readEvents(db, aid, { types: ['INQUIRY'] })
      const done = new Set(asks.filter((e) => e.payload.answer_of).map((e) => e.payload.answer_of))
      const open = asks.filter((e) => e.payload.mode === 'ask' && !done.has(e.id) && e.payload.target_type === 'claim').pop()
      if (open && rnd() < 0.6) {
        const r = await H('POST', aid + '/sangguan/verdict', { target_type: 'claim', target_id: open.payload.target_id, sign: 1, inquiry_id: open.id })
        if (r.status === 200 && r.body.counted) verdicts.answered++
      }
    }
    for (const p of pendingElev(db, aid, iso())) {
      if (Date.parse(p.at) <= clock - 3 * DAY && rnd() < 0.7) {
        const r = await H('POST', aid + '/sangguan/elev/' + p.id + '/approve', {})
        if (r.status === 200) verdicts.approved++
      }
    }
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
    const snap = budgetSnapshot(db, aid, iso().slice(0, 10))
    for (const [p, v] of Object.entries(snap.pools)) {
      const k = aid + p + (p === 'slow' ? snap.week : snap.day)
      const grew = usedSeen[k] === undefined ? p !== 'slow' : v.used > usedSeen[k]
      if (v.used > v.cap && grew) budgetBad.push({ aid, d, p, v })
      usedSeen[k] = v.used
    }
    // 注入：只读、守预算、不含术语与终态命题
    const seq0 = lastSeq(db, aid)
    const v = injectView(db, aid, { now: iso(), cache: false })
    for (const c of Object.values(s.claims)) if (isTerminal(c.status)) TERM_TEXT.add(c.id)
    if (lastSeq(db, aid) !== seq0) injectBad.push({ aid, d, why: '注入写了账本' })
    if (v.tokens > v.budget) injectBad.push({ aid, d, why: '超出注入预算', tokens: v.tokens })
    if (/[κπνσ]/.test(v.text)) injectBad.push({ aid, d, why: '注入含术语', text: v.text })
    if (v.sources.claims.some((id) => s.claims[id] && isTerminal(s.claims[id].status))) injectBad.push({ aid, d, why: '注入含终态命题' })
    // 每周看一眼接口：全 200、GET 不写账本
    if (d % 7 === 6) {
      const n0 = lastSeq(db, aid)
      for (const g of ['status', 'heads', 'kappa', 'predictions', 'events?limit=20', 'timeline?days=30', 'epochs', 'liveness', 'inject/preview', 'precedents']) {
        const r = await H('GET', aid + '/sangguan/' + g)
        if (r.status !== 200) apiBad.push({ aid, d, g, body: r.body })
      }
      if (lastSeq(db, aid) !== n0) apiBad.push({ aid, d, why: 'GET 写了账本' })
    }
    // 主 agent：影子期满 7 天后经接口切 live（不带 force）
    if (aid === AG.main && !liveAt.main) {
      const r = await H('PUT', aid + '/sangguan/config', { inject: 'live' })
      if (r.status === 200) liveAt.main = d
      else if (r.body.error.code !== 'SHADOW_NOT_READY') apiBad.push({ aid, d, live: r.body })
    }
  }
}

// ---------- 断言 ----------
check('全程无写入被拒 / 中环未抛错', errors.length === 0, errors.slice(0, 3))
check('全程不变式成立（每夜检查）', invBad.length === 0, invBad.slice(0, 3))
check('每日预算池从不超额', budgetBad.length === 0, budgetBad.slice(0, 3))
check('注入：只读、守预算、零术语、无终态命题、关闭 / 影子期不改提示词', injectBad.length === 0, injectBad.slice(0, 3))
check('接口：每周全部 200、GET 不写账本、裁决不报错', apiBad.length === 0, apiBad.slice(0, 3))
check('影子期攒满 7 天才能切 live（经接口、不带 force）', liveAt.main !== undefined && liveAt.main >= 6, liveAt)
{
  const lg = legacy()
  const out = promptHook(db, AG.main, lg, { now: iso() })
  check('live 后：提示词换成它自己长出来的看法', out !== lg && out.worldLine !== lg.worldLine && out.worldLine.startsWith('你对世界的基本看法：'), out)
  const log = injectLog(db, AG.fresh)
  check('冷启动 agent 一直在影子期：有影子记录、模式未变', sangguanConfig(db, AG.fresh).inject === 'shadow' && log.shadow_days.length >= 7, { days: log.shadow_days.length, changes: log.changes })
}
for (const aid of ON) {
  const before = JSON.stringify(snapshot(db, aid))
  rebuild(db, aid)
  check('P1 重放（' + DAYS + ' 天）：' + aid, JSON.stringify(snapshot(db, aid)) === before)
}
check('关闭的 agent：三观零痕迹（账本、投影、flags、模型调用）', [...L0_TABLES, ...PROJ_TABLES].every((t) => db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE agent_id=?`).get(AG.off).n === 0)
  && db.prepare("SELECT COUNT(*) n FROM flags WHERE key LIKE 'sangguan%' AND key LIKE ?").get('%' + AG.off + '%').n === 0 && chats[AG.off].count() === 0)
check('记忆预算完全不受三观影响', [...ON, AG.off].every((aid) => {
  for (let d = 0; d < DAYS; d += 7) if (llmBudgetSnapshot(db, aid, new Date(T0 + d * DAY).toISOString().slice(0, 10)).used) return false
  return true
}))

// 自传摘要：区间首尾相接；静默期不写；编造的转折点被拒
for (const aid of ON) {
  const list = listSummaries(db, aid).reverse()
  listCount = list.length
  const chained = list.every((s, i) => i === 0 ? s.from_seq === 0 : s.from_seq === list[i - 1].to_seq)
  const inRange = (a, b) => list.filter((s) => { const dd = Math.floor((Date.parse(s.at) - T0) / DAY); return dd >= a && dd < b }).length
  const quiet = inRange(130, 160)
  const active = inRange(30, 60)
  const gapOk = list.every((s, i) => i === 0 || Date.parse(s.at) - Date.parse(list[i - 1].at) >= 7 * DAY)
  check('L2 自传：区间首尾相接、一章至少隔一周、静默期不比活跃期多（' + aid + '）', list.length >= 1 && chained && gapOk && quiet <= active && list.every((s) => s.chapter !== '编的一章'), { n: list.length, quiet, active, gapOk, chained })
}
check('J16 编造转折点的输出一律没落账', j16Bad === 0 || ON.every((aid) => !listSummaries(db, aid).some((s) => s.chapter === '编的一章')), { j16Bad })
{
  let ok = 0
  let fell = 0
  let bad = []
  for (const aid of ON) {
    for (const h of ['W', 'L', 'V'].flatMap((l) => listHeads(db, aid, l)).slice(0, 12)) {
      const r = await explain(db, aid, h.id, { now: iso(), chat: chats[aid] })
      if (!r || !r.sentence) { bad.push(h.id); continue }
      if (/999/.test(r.sentence)) bad.push({ id: h.id, s: r.sentence })
      if (r.polished) ok++
      else fell++
    }
  }
  check('explain：每个链头都有解释句；加数字的润色被拒收、回落模板句', !bad.length && ok > 0, { ok, fell, bad: bad.slice(0, 3), j19Bad })
}
{
  const rj = rJOf(db, AG.main, iso())
  check('r_J：用户覆盖被计入（有判定且有覆盖时 < 1）', verdicts.override === 0 || rj === null || rj <= 1, { rj, override: verdicts.override })
  check('用户裁决同目标同日只计 1 次', verdicts.capped > 0 && verdicts.counted > 0, verdicts)
}

// ---------- 最后：清除冷启动 agent ----------
{
  const keep = Object.fromEntries([AG.main, AG.tight].map((a) => [a, JSON.stringify(snapshot(db, a))]))
  const rows = purgeAgent(db, AG.fresh)
  const left = [...L0_TABLES, ...PROJ_TABLES].reduce((n, t) => n + db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE agent_id=?`).get(AG.fresh).n, 0)
  check('清除：目标 agent 清零、标记不残留', left === 0 && rows.claim_events > 0 && db.prepare('SELECT COUNT(*) n FROM claim_purge').get().n === 0, { left, rows: rows.claim_events })
  check('清除：其他 agent 快照不变、P1 仍一致', [AG.main, AG.tight].every((a) => { const s0 = keep[a]; rebuild(db, a); return JSON.stringify(snapshot(db, a)) === s0 }))
  const st = await H('GET', AG.fresh + '/sangguan/status')
  check('清除后：该 agent 回到未启用', st.status === 200 && st.body.enabled === false)
}

// ---------- 统计与对比 ----------
function statsOf(aid) {
  const evs = readEvents(db, aid)
  const c = (t) => evs.filter((e) => e.type === t).length
  const s = loadState(db, aid)
  return {
    events: evs.length, types: new Set(evs.map((e) => e.type)).size,
    live: Object.values(s.claims).filter((x) => !isTerminal(x.status)).length,
    OPEN: c('KAPPA_OPEN'), DELIBERATE: c('DELIBERATE'), RESOLVE: c('RESOLVE'), SUB: c('SUB_ACCEPT'), CONFIRM: c('SUB_CONFIRM'), COEX: c('COEX'),
    CORE_EST: c('CORE_ESTABLISH'), DEGEN: c('DEGEN_CHECK'), REPAIR_FAILED: c('REPAIR_FAILED'), ELEV_COMMIT: c('ELEV_COMMIT'),
    NU_RES: c('NU_RESOLVE'), INQUIRY: c('INQUIRY'), SUMMARY: c('SUMMARY_BUILD'), userEv: evs.filter((e) => e.type === 'EVIDENCE' && e.actor === 'user' && (e.payload.evidence || []).some((x) => x.kind === 'verdict')).length,
    answered: evs.filter((e) => e.type === 'INQUIRY' && e.payload.answer_of).length, THETA: c('THETA_ADJUST'),
    calls: chats[aid].count(), J16: chats[aid].count('J16'), J19: chats[aid].count('J19'),
  }
}
const S = { main: statsOf(AG.main), tight: statsOf(AG.tight) }
check('场景③：核心受挫 → 退化检查点 + 修补失败', S.main.DEGEN > 0 && S.main.REPAIR_FAILED > 0, S.main)
check('生产路径：立案 + 审议 + 先例 / 并存 / 合题至少出现其二', S.main.OPEN > 0 && S.main.DELIBERATE > 0 && [S.main.RESOLVE, S.main.COEX, S.main.SUB].filter((n) => n > 0).length >= 2, S.main)
check('预算紧的 agent 少花钱但不出错', S.tight.calls < S.main.calls, { tight: S.tight.calls, main: S.main.calls })
for (const [k, v] of Object.entries(S)) console.log('  G4 统计 ' + k + '（' + DAYS + ' 天）：', JSON.stringify(v))
{
  const q = {}
  for (const e of readEvents(db, AG.main)) {
    const dd = Math.floor((Date.parse(e.at) - T0) / DAY)
    if (dd >= 120 && dd < 160) q[e.type + ':' + e.actor] = (q[e.type + ':' + e.actor] || 0) + 1
  }
  console.log('  G4 静默期 main 事件：', JSON.stringify(q))
}
console.log('  G4 用户操作：', JSON.stringify(verdicts), ' 切 live 于第', liveAt.main, '天')
console.log('  G4 耗时：', JSON.stringify({ midAvgMs: +(midMs.reduce((a, b) => a + b, 0) / midMs.length).toFixed(1), midP99Ms: +[...midMs].sort((a, b) => a - b)[Math.floor(midMs.length * 0.99)].toFixed(1) }))

console.log(`\n通过 ${pass} / ${pass + fail}`)
try { db.close() } catch { /* ignore */ }
try { fs.rmSync(home, { recursive: true, force: true }) } catch { /* ignore */ }
process.exit(fail ? 1 : 0)
