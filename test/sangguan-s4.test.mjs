/**
 * 三观 S4：快环 F1–F5。
 * sim / 召回（Eq.1–2）、W1–W5 分类（P11 穷尽）、J1 抽取 / J2 关系判定（假 LLM）、证据 / TRADEOFF 入账、
 * 判定降级与 PENDING_JUDGE 积压、开关关闭零调用、对话后缓冲触发、P1 重放、模糊模拟。
 * 运行：node test/sangguan-s4.test.mjs（可设 SG_SEED）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { getFlag } from '../src/kernel.js'
import { append, newId, readEvents, lastSeq } from '../src/modules/sangguan/ledger.js'
import { loadState, rebuild, snapshot, listHeads } from '../src/modules/sangguan/projection.js'
import { checkInvariants } from '../src/modules/sangguan/fold.js'
import { setSangguanConfig } from '../src/modules/sangguan/config.js'
import { recordJudge } from '../src/modules/sangguan/llm.js'
import { grams, jaccard, cosine, neighbors } from '../src/modules/sangguan/sim.js'
import { classify, fieldCheck, selfEval, CLASSES } from '../src/modules/sangguan/gates.js'
import { runFast, afterTurn, flushFast, pendingList, bufferOf } from '../src/modules/sangguan/fast.js'
import { fakeChat } from './sangguan-fake-llm.mjs'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 800)) }
}
const near = (a, b, e = 1e-9) => Math.abs(a - b) < e

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-sg4-'))
const db = openDb(path.join(dir, 'app.db'))

// ======================= sim 与召回（Eq.1–2） =======================
{
  check('二元组：去标点空白、小写', [...grams('Ab, c！')].join(',') === 'ab,bc')
  check('单字文本按单字', [...grams('好')].join(',') === '好')
  check('Jaccard：同文 1、无交 0', jaccard('努力通常会有回报', '努力通常会有回报。') === 1 && jaccard('天气', '吃饭') === 0)
  check('余弦：同向 1、正交 0、零向量 0', near(cosine([1, 0], [2, 0]), 1) && near(cosine([1, 0], [0, 1]), 0) && cosine([0, 0], [1, 0]) === 0)
  const heads = [
    { id: 'b', text: '甲', vec: [1, 0] }, { id: 'a', text: '乙', vec: [1, 0] },
    { id: 'c', text: '丙', vec: [0.6, 0.8] }, { id: 'd', text: '丁', vec: [0, 1] },
  ]
  const r = neighbors({ text: '戊', vec: [1, 0] }, heads, { theta_rel: 0.55, N_nb: 2 })
  check('召回：sim ≥ θ_rel，按 sim 降序、id 升序破平，取前 N_nb', r.mode === 'embed' && r.list.map((x) => x.id).join(',') === 'a,b', r)
  const r2 = neighbors({ text: '努力通常会有回报', vec: null }, [{ id: 'x', text: '努力通常会有回报！', vec: [1, 0] }], { theta_rel: 0.55, N_nb: 5 })
  check('召回：缺嵌入的对子走字面，整句相同为 1', r2.mode === 'lexical' && r2.list.length === 1 && r2.list[0].sim === 1 && r2.list[0].mode === 'lexical', r2)
  const r3 = neighbors(
    { text: '努力通常会有回报', vec: [1, 0] },
    [{ id: 'e', text: '另一句', vec: [1, 0] }, { id: 'l', text: '努力通常会有回报', vec: null }],
    { theta_rel: 0.55, theta_rel_lex: 0.12, N_nb: 5 },
  )
  check('召回：逐条混合，有嵌入走余弦、缺失走字面', r3.mode === 'mixed' && r3.list.find((x) => x.id === 'e').mode === 'embed' && r3.list.find((x) => x.id === 'l').mode === 'lexical', r3)
}

// ======================= W1 与分类（P11） =======================
{
  check('W1：缺种类', !!fieldCheck({ layer: 'W', text: '某句' }))
  check('W1：非法层', !!fieldCheck({ layer: 'X', kind: 'belt', text: '某句' }))
  check('W1：种类不属于该层', !!fieldCheck({ layer: 'V', kind: 'belt', text: '某句' }))
  check('W1：抽取不能直建核心', !!fieldCheck({ layer: 'W', kind: 'core', text: '某句' }))
  check('W1：过长', !!fieldCheck({ layer: 'W', kind: 'belt', text: '长'.repeat(301) }))
  check('W1：模型自评', selfEval('作为一个AI，我的回答很全面') && selfEval('我刚才的回答不够好') && !selfEval('努力通常会有回报'))
  check('W1：合法候选通过', fieldCheck({ layer: 'L', kind: 'role', text: '我想做一个靠谱的倾听者' }) === null)
}
{
  // P11：随机输入下恰好落入一类，且与按序判定的结果一致
  let s = Number(process.env.SG_SEED || 11) >>> 0
  const rnd = () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
  const pick = (a) => a[Math.floor(rnd() * a.length)]
  const KINDS = ['belt', 'obs', 'core', 'telos', 'chapter', 'norm', 'principle', undefined]
  const bad = []
  const tally = {}
  for (let i = 0; i < 4000; i++) {
    const layer = pick(['W', 'L', 'V', 'W', undefined])
    const x = { layer, kind: pick(KINDS), text: rnd() < 0.05 ? '' : rnd() < 0.03 ? '作为AI我的回答很好' : '句' + i }
    const N = []
    const nN = Math.floor(rnd() * 4)
    for (let j = 0; j < nN; j++) {
      N.push({ id: 'c' + j, sim: 0.55 + rnd() * 0.45, status: pick(['active', 'contested', 'provisional']), kind: pick(['belt', 'core', 'obs']), layer: layer || 'W' })
    }
    const mode = pick(['ok', 'ok', 'ok', 'failed', 'degraded'])
    const rel = mode === 'ok' ? Object.fromEntries(N.map((c) => [c.id, pick(['dup', 'contradict', 'compatible', 'unrelated'])])) : null
    const dec = new Set(N.filter(() => rnd() < 0.4).map((c) => c.id))
    const out = classify(x, N, rel, { theta_dup: 0.9, judge: mode, decisive: (c) => dec.has(c.id) })
    const coreOf = (c) => ({ W: 'core', L: 'telos', V: 'principle' }[c.layer] === c.kind)
    let want
    if (fieldCheck(x)) want = 'REJECT'
    else if (!N.length) want = 'EXP'
    else if (mode === 'degraded') want = N.some((c) => c.sim >= 0.9) ? 'DUP' : 'PENDING'
    else if (mode === 'failed') want = 'EXP'
    else if (N.some((c) => c.sim >= 0.9 && rel[c.id] === 'dup')) want = 'DUP'
    else if (N.some((c) => rel[c.id] === 'contradict' && c.status === 'active' && !coreOf(c) && dec.has(c.id))) want = 'REV'
    else if (N.some((c) => rel[c.id] === 'contradict')) want = 'OPEN'
    else want = 'EXP'
    tally[out.cls] = (tally[out.cls] || 0) + 1
    if (out.cls !== want || ![...CLASSES, 'PENDING'].includes(out.cls)) bad.push({ i, x, mode, want, got: out.cls })
    if ((out.cls === 'DUP' || out.cls === 'REV') && !out.target) bad.push({ i, msg: '缺 target', out })
    if (out.cls === 'OPEN' && !(out.targets && out.targets.length)) bad.push({ i, msg: '缺 targets', out })
    if (!out.report || !out.report.w) bad.push({ i, msg: '缺 gate_report', out })
  }
  check('P11 分类穷尽：4000 个随机候选各恰好落入一类且符合 W1→W5 顺序', bad.length === 0, bad.slice(0, 3))
  check('P11：五类与 PENDING 都被覆盖', ['REJECT', 'DUP', 'REV', 'OPEN', 'EXP', 'PENDING'].every((c) => tally[c] > 0), tally)
}

// ======================= 端到端（假 LLM + 假嵌入） =======================
let clock = Date.parse('2026-11-02T09:00:00.000Z')
const nextAt = (min = 10) => new Date((clock += min * 60000)).toISOString()
const VEC = {
  努力通常会有回报: [1, 0, 0, 0],
  努力一般都会有回报: [0.96, 0.28, 0, 0],
  努力多半会有回报: [0.97, 0.24, 0, 0],
  努力不一定有回报: [0.7, 0.71, 0, 0],
  努力未必有回报: [0.72, 0.69, 0, 0],
  努力常常白费: [0.66, 0.75, 0, 0],
  早起的人更有效率: [0, 0, 1, 0],
  早起并不提高效率: [0, 0.3, 0.95, 0],
  早起对效率没有普遍帮助: [0, 0.25, 0.97, 0],
  诚实比圆滑更重要: [0, 0, 0, 1],
  有时圆滑比诚实更重要: [0, 0.4, 0, 0.92],
  世界是可以被认识的: [0.3, 0, 0, 0.1],
  世界根本无法被认识: [0.31, 0.05, 0, 0.09],
}
function hashVec(text) {
  const v = new Array(32).fill(0)
  for (const g of grams(text)) { let h = 0; for (const ch of g) h = (h * 31 + ch.codePointAt(0)) >>> 0; v[h % 32] += 1 }
  return v
}
const embed = async (text) => VEC[text] || hashVec(text)
const T = (u = '随便聊聊', a = '嗯，我也这么看。') => [{ role: 'user', text: u }, { role: 'assistant', text: a }]
const J1out = (candidates = [], more = {}) => ({ candidates, evidence: [], tradeoffs: [], answers: [], ...more })
const REL = {} // 'a|b' → rel
const relOf = (x, c) => REL[x + '|' + c] || REL[c + '|' + x] || 'unrelated'
const j2 = (input) => ({ pairs: input.neighbors.map((n) => ({ c_id: n.id, rel: relOf(input.text, n.text), reason: '测' })) })

async function fast(aid, j1, j2fix = j2, extra = {}) {
  const chat = fakeChat({ J1: j1, J2: j2fix })
  const at = nextAt()
  const r = await runFast({ db, aid, at, day: at.slice(0, 10), chat, embed, ...extra }, extra.turns || T())
  return { r, chat, at }
}
const claimText = (id) => (db.prepare('SELECT text FROM persona_claims WHERE id=?').get(id) || {}).text
const evOf = (aid, type, since = 0) => readEvents(db, aid, { afterSeq: since, types: [type] })
const put = (aid, evs, expect) => append(db, aid, evs, expect)
const ev = (type, layer, payload, actor = 'sys') => ({ type, layer, actor, at: nextAt(1), payload })
const mkClaim = (aid, layer, kind, text, origin = 'extract') =>
  put(aid, [ev('CLAIM_EXP', layer, { claims: [{ layer, kind, text, origin }] })]).entities.claims[0]
function openK(aid, layer, pos, neg) {
  const at = nextAt(1)
  const q = newId('questions', at)
  return put(aid, [{
    type: 'KAPPA_OPEN', layer, actor: 'judge', at,
    payload: { questions: [{ id: q, layer, text: '这件事到底怎样' }], kappas: [{ layer, q_id: q, pos_id: pos, neg_id: neg, dep: '去掉一方另一方失去参照', excl: '同一边界下不能同真' }] },
  }]).entities.kappas[0]
}
const okInv = (aid) => checkInvariants(loadState(db, aid))

const A = 'agt_e2e'
setSangguanConfig(db, A, { enabled: true, budget: { fast: 200 } }) // 一天内跑几十次快环，默认日额不够

// —— A：空层 → EXP，零 J2；ν 随候选登记
let c1
{
  const nu = [{ expect: '认真准备的那场考试会考好', observe: '考试成绩', p: 0.7, due_days: 14 }]
  const { r, chat, at } = await fast(A, J1out([{ layer: 'W', kind: 'belt', text: '努力通常会有回报', boundary: [{ text: '在可控的任务里', testable: true }], nu }]))
  c1 = r.items[0] && r.items[0].id
  check('EXP：空层候选直接新建', r.status === 'done' && r.items.length === 1 && r.items[0].cls === 'EXP' && claimText(c1) === '努力通常会有回报', r)
  check('EXP：无邻居零 J2 调用', chat.count('J2') === 0 && r.calls.J2 === 0)
  const nus = Object.values(loadState(db, A).nus)
  check('EXP：随候选登记 ν，到期 = at + due_days', nus.length === 1 && nus[0].claim_id === c1 && nus[0].due_at === new Date(Date.parse(at) + 14 * 86400000).toISOString(), nus)
  check('EXP：命题来源 origin=extract、带边界', db.prepare('SELECT origin, boundary_json FROM persona_claims WHERE id=?').get(c1).origin === 'extract')
}
// —— B：近义 + J2 dup → DUP；再来一次命中成对缓存
REL['努力一般都会有回报|努力通常会有回报'] = 'dup'
{
  const { r, chat } = await fast(A, J1out([{ layer: 'W', kind: 'belt', text: '努力一般都会有回报' }]))
  check('DUP：sim ≥ θ_dup 且 J2 双向蕴含', r.items[0].cls === 'DUP' && r.items[0].target === c1 && chat.count('J2') === 1, r.items)
  check('DUP：只记 mention，不新建、不改 π', loadState(db, A).claims[c1].mentions === 1 && loadState(db, A).claims[c1].pi === 0 && Object.keys(loadState(db, A).claims).length === 1)
  const { r: r2, chat: chat2 } = await fast(A, J1out([{ layer: 'W', kind: 'belt', text: '努力一般都会有回报' }]))
  check('J2 成对缓存：同一对不再调用模型', r2.items[0].cls === 'DUP' && chat2.count('J2') === 0 && loadState(db, A).claims[c1].mentions === 2, r2)
}
// —— C：矛盾 → OPEN（新建 + KAPPA_CANDIDATE）
let c2
REL['努力不一定有回报|努力通常会有回报'] = 'contradict'
{
  const seq0 = lastSeq(db, A)
  const { r } = await fast(A, J1out([{ layer: 'W', kind: 'belt', text: '努力不一定有回报' }]))
  c2 = r.items[0].id
  const kc = evOf(A, 'KAPPA_CANDIDATE', seq0)
  check('OPEN：矛盾候选新建为 active', r.items[0].cls === 'OPEN' && loadState(db, A).claims[c2].status === 'active', r.items)
  check('OPEN：记 KAPPA_CANDIDATE(c, x)', kc.length === 1 && [kc[0].payload.a_id, kc[0].payload.b_id].sort().join() === [c1, c2].sort().join(), kc.map((e) => e.payload))
  check('OPEN：不在快环立案（无 KAPPA_OPEN）', evOf(A, 'KAPPA_OPEN', seq0).length === 0)
}
// —— D：用户裁决 + 矛盾 → REV；被替换者所在的挂起 κ 同事务 KAPPA_OBSOLETE
let d1, d2, kD
{
  d1 = mkClaim(A, 'W', 'belt', '早起的人更有效率')
  d2 = mkClaim(A, 'W', 'belt', '早起并不提高效率')
  kD = openK(A, 'W', d1, d2)
  put(A, [ev('DELIBERATE', 'W', { kappa_id: kD, branch: 'SUSPEND' }), ev('SUSPEND', 'W', { kappa_id: kD, missing: 'evidence' })])
  REL['早起对效率没有普遍帮助|早起的人更有效率'] = 'contradict'
  REL['早起对效率没有普遍帮助|早起并不提高效率'] = 'compatible'
  const seq0 = lastSeq(db, A)
  const { r } = await fast(A, J1out([{ layer: 'W', kind: 'belt', text: '早起对效率没有普遍帮助' }], {
    evidence: [{ target_id: d1, sign: -1, kind: 'verdict', ref_turn: 0 }],
  }), j2, { turns: T('我试过一个月早起，效率反而更低，早起更有效率这说法不对') })
  const s = loadState(db, A)
  const rev = evOf(A, 'REV', seq0)
  check('REV：W 层用户裁决 + 矛盾 → 替换', r.items[0].cls === 'REV' && rev.length === 1 && rev[0].payload.old_id === d1, r.items)
  check('REV：旧命题 superseded，新命题 pred 指回', s.claims[d1].status === 'superseded' && s.claims[r.items[0].id].pred[0] === d1)
  check('REV：旧命题所在的挂起 κ 同事务关闭', s.kappas[kD].sigma === 'resolved' && evOf(A, 'KAPPA_OBSOLETE', seq0).length === 1)
  check('REV：用户裁决先入账为证据（π 下降）', evOf(A, 'EVIDENCE', seq0).length === 1 && s.claims[d1].pi < 0)
  check('REV 后不变式成立（P21 无僵尸矛盾）', okInv(A).length === 0, okInv(A))
}
// —— E：V 层只认 ν miss，用户裁决不足以 REV（P23）
{
  const v1 = mkClaim(A, 'V', 'norm', '诚实比圆滑更重要')
  REL['有时圆滑比诚实更重要|诚实比圆滑更重要'] = 'contradict'
  const { r } = await fast(A, J1out([{ layer: 'V', kind: 'norm', text: '有时圆滑比诚实更重要' }], {
    evidence: [{ target_id: v1, sign: -1, kind: 'verdict', ref_turn: 0 }],
  }))
  check('P23：V 层用户裁决不触发 REV，落为 OPEN', r.items[0].cls === 'OPEN' && loadState(db, A).claims[v1].status === 'active', r.items)
}
// —— F：核心邻居不能被 REV（P12）
{
  const core = mkClaim(A, 'W', 'core', '世界是可以被认识的', 'seed')
  REL['世界根本无法被认识|世界是可以被认识的'] = 'contradict'
  const { r } = await fast(A, J1out([{ layer: 'W', kind: 'belt', text: '世界根本无法被认识' }], {
    evidence: [{ target_id: core, sign: -1, kind: 'verdict', ref_turn: 0 }],
  }))
  check('P12：矛盾的是核心 → 不 REV，落为 OPEN', r.items[0].cls === 'OPEN' && loadState(db, A).claims[core].status === 'active', r.items)
}
// —— G：W1 拒收
{
  const seq0 = lastSeq(db, A)
  const n0 = Object.keys(loadState(db, A).claims).length
  const { r } = await fast(A, J1out([
    { layer: 'W', text: '缺种类' }, { layer: 'W', kind: 'core', text: '抽取不能直建核心' },
    { layer: 'X', kind: 'belt', text: '坏层' }, { layer: 'L', kind: 'role', text: '作为一个AI，我的回答很全面' },
  ]))
  const rej = evOf(A, 'REJECT', seq0)
  check('W1：四个坏候选全部 REJECT 并留 gate_report', r.items.every((x) => x.cls === 'REJECT') && rej.length === 4 && rej.every((e) => e.gate_report && e.gate_report.w === 'W1'), rej.map((e) => e.gate_report))
  check('W1：不新建命题', Object.keys(loadState(db, A).claims).length === n0)
}
// —— H：证据过滤（I7：只认用户回合的外部记录；目标须存在且非终态）
{
  const nuId = Object.values(loadState(db, A).nus)[0].id
  const seq0 = lastSeq(db, A)
  const pi0 = loadState(db, A).claims[c1].pi
  const { r } = await fast(A, J1out([], {
    evidence: [
      { target_id: c1, sign: 1, kind: 'act', ref_turn: 0 },
      { target_id: nuId, sign: 1, kind: 'check', ref_turn: 0 },
      { target_id: c1, sign: 1, kind: 'verdict', ref_turn: 1 },
      { target_id: 'cl_nope', sign: 1, kind: 'act', ref_turn: 0 },
      { target_id: d1, sign: 1, kind: 'act', ref_turn: 0 },
      { target_id: c1, sign: 1, kind: 'act', ref_turn: 9 },
      { target_id: c1, sign: 1, kind: 'act', ref_turn: 0 },
    ],
  }), j2, { turns: T('我上周按计划复习，结果真的考好了') })
  const xs = evOf(A, 'EVIDENCE', seq0)
  check('证据：合法 2 条入账、5 条被滤（助手回合 / 不存在 / 终态 / 越界 / 同批重复）', r.evidence.written === 2 && r.evidence.dropped === 5 && xs.length === 2, r.evidence)
  check('证据：权重按 Θ、ref 指向外部回合', xs[0].payload.evidence[0].weight === 0.6 && /^turn:/.test(xs[0].payload.evidence[0].ref), xs[0].payload)
  check('证据：π 按 Eq.3 上升', loadState(db, A).claims[c1].pi > pi0)
  check('证据：ν 证据挂在 ν 上', xs[1].payload.evidence[0].target_type === 'nu')
}
// —— J：TRADEOFF 只绑定并存中的 κ
{
  const l1 = mkClaim(A, 'L', 'chapter', '先把事业做稳')
  const l2 = mkClaim(A, 'L', 'chapter', '先多陪伴家人')
  const kL = openK(A, 'L', l1, l2)
  put(A, [ev('DELIBERATE', 'L', { kappa_id: kL, branch: 'COEX' }), ev('COEX', 'L', { kappa_id: kL, loss: '偏家人时少了晋升机会' })])
  const seq0 = lastSeq(db, A)
  const { r } = await fast(A, J1out([], {
    tradeoffs: [
      { kappa_id: kL, lean_pole: 'neg', cost: '推掉了周末加班', ref_turn: 0 },
      { kappa_id: kD, lean_pole: 'pos', cost: '无', ref_turn: 0 },
      { kappa_id: kL, lean_pole: 'pos', cost: '加班到很晚', ref_turn: 1 },
    ],
  }), j2, { turns: T('这周末我推掉了加班，带孩子去公园了') })
  const tr = evOf(A, 'TRADEOFF', seq0)
  check('TRADEOFF：并存 κ 的取舍入账（ref 指向用户回合）', r.tradeoffs.written === 1 && tr.length === 1 && tr[0].payload.lean_pole === 'neg' && /^turn:/.test(tr[0].payload.ref), r.tradeoffs)
  check('TRADEOFF：非并存 κ / 助手回合被滤', r.tradeoffs.dropped === 2)
}
// —— K：J1 失败 / 没预算 → 整批延后，不写任何事件
{
  const seq0 = lastSeq(db, A)
  const { r } = await fast(A, ['坏', '也坏'])
  check('J1 两次不合格 → 整批延后，零写入', r.status === 'deferred' && r.reason === 'SCHEMA' && lastSeq(db, A) === seq0, r)
  const NB = 'agt_nob'
  setSangguanConfig(db, NB, { enabled: true, budget: { fast: 0 } })
  const { r: r2, chat } = await fast(NB, J1out([{ layer: 'W', kind: 'belt', text: '努力通常会有回报' }]))
  check('没预算 → 延后（不是失败），不调模型', r2.status === 'deferred' && r2.reason === 'BUDGET' && chat.count() === 0 && lastSeq(db, NB) === 0, r2)
}
// —— L：J2 答了但两次不合格 → 闸不通过，按 EXP 入账；调不通 → 推迟补判，不留重复链头
{
  const { r } = await fast(A, J1out([{ layer: 'W', kind: 'belt', text: '努力多半会有回报' }]), ['坏', '也坏'])
  check('J2 两次不合格 → EXP，gate_report 标 judge=failed', r.items[0].cls === 'EXP' && r.items[0].judge === 'failed', r.items)
  const n0 = Object.keys(loadState(db, A).claims).length
  const { r: r2 } = await fast(A, J1out([{ layer: 'W', kind: 'belt', text: '努力一般都会有回报' }]), new Error('超时'))
  check('J2 调不通 → PENDING_JUDGE（reason=judge_unavailable），不新建命题', r2.items[0].cls === 'PENDING' && r2.items[0].reason === 'judge_unavailable'
    && Object.keys(loadState(db, A).claims).length === n0 && pendingList(db, A).length === 1, r2.items)
  const { r: r3 } = await fast(A, J1out([]))
  check('下一次快环补判：成对缓存命中 → DUP，积压清空', r3.pending.drained === 1 && pendingList(db, A).length === 0 && evOf(A, 'DUP').length >= 3, r3.pending)
}
// —— M / N：判定不可用 → 降级；PENDING_JUDGE 有界；恢复后按时间补判
{
  const G = 'agt_deg'
  setSangguanConfig(db, G, { enabled: true })
  const { r: r0 } = await fast(G, J1out([{ layer: 'W', kind: 'belt', text: '努力通常会有回报' }]))
  const base = r0.items[0].id
  for (let i = 0; i < 4; i++) recordJudge(db, G, clock, false)
  const ctxCap = { pendingCap: 2 }
  const { r, chat } = await fast(G, J1out([
    { layer: 'W', kind: 'belt', text: '努力通常会有回报' },
    { layer: 'W', kind: 'belt', text: '努力不一定有回报' },
  ]), j2, ctxCap)
  check('降级：sim ≥ θ_dup 直接 DUP，不调 J2', r.items[0].cls === 'DUP' && r.items[0].target === base && chat.count('J2') === 0, r.items)
  check('降级：其余有邻居的候选记 PENDING_JUDGE', r.items[1].cls === 'PENDING' && pendingList(db, G).length === 1, r.items)
  const seq0 = lastSeq(db, G)
  await fast(G, J1out([{ layer: 'W', kind: 'belt', text: '努力未必有回报' }, { layer: 'W', kind: 'belt', text: '努力常常白费' }]), j2, ctxCap)
  const pend = pendingList(db, G)
  const over = evOf(G, 'CLAIM_EXP', seq0).filter((e) => e.refs.length)
  check('PENDING_JUDGE 有界：超过上限最旧者转 EXP', pend.length === 2 && over.length === 1 && claimText(over[0].payload.claims[0].id) === '努力不一定有回报', { pend: pend.length, over: over.length })
  clock += 25 * 3600000
  REL['努力未必有回报|努力通常会有回报'] = 'contradict'
  REL['努力常常白费|努力通常会有回报'] = 'contradict'
  const seq1 = lastSeq(db, G)
  const { r: r3 } = await fast(G, J1out([]), j2, ctxCap)
  const drained = readEvents(db, G, { afterSeq: seq1 }).filter((e) => e.refs.length)
  check('恢复后补判：积压按时间顺序重新分类，事件 refs 指回 PENDING_JUDGE', r3.pending.drained === 2 && pendingList(db, G).length === 0 && drained.length === 2, r3.pending)
  check('补判结果走正常 W 分类（此处为 OPEN）', evOf(G, 'KAPPA_CANDIDATE', seq1).length === 2)
  check('降级全程不变式成立', okInv(G).length === 0, okInv(G))
}
// —— Q：J2 没预算 → PENDING_JUDGE（推迟，不当失败）
{
  const Q = 'agt_nob2'
  setSangguanConfig(db, Q, { enabled: true, budget: { fast: 1 } })
  mkClaim(Q, 'W', 'belt', '努力通常会有回报')
  const { r } = await fast(Q, J1out([{ layer: 'W', kind: 'belt', text: '努力不一定有回报' }]))
  check('J2 没预算 → PENDING_JUDGE（reason=budget）', r.items[0].cls === 'PENDING' && r.items[0].reason === 'budget' && pendingList(db, Q).length === 1, r.items)
}
// —— O：开关关闭 → 零调用、零写入
{
  const O = 'agt_off'
  const { r, chat } = await fast(O, J1out([{ layer: 'W', kind: 'belt', text: '努力通常会有回报' }]))
  check('开关关闭：快环不跑、零模型调用、零账本写入', r.status === 'off' && chat.count() === 0 && lastSeq(db, O) === 0, r)
  const ret = afterTurn(db, O, { user: '你好', assistant: '你好呀', sid: 's1', at: nextAt() }, { schedule: false })
  check('开关关闭：挂点直接返回，不写缓冲', ret === false && getFlag(db, 'sangguan.fast.buf:' + O) == null)
}
// —— T：对话后缓冲与触发（不阻塞回复）
{
  const H = 'agt_hook'
  setSangguanConfig(db, H, { enabled: true })
  const rets = []
  for (let i = 0; i < 5; i++) rets.push(afterTurn(db, H, { user: '第' + i + '句', assistant: '回' + i, sid: 's1', at: nextAt(1) }, { schedule: false }))
  check('挂点同步返回（不是 Promise），不阻塞回复', rets.every((x) => x && typeof x.then !== 'function'))
  check('每 5 轮触发一次', rets.slice(0, 4).every((x) => !x.due) && rets[4].due === true, rets)
  check('缓冲按轮记录', bufferOf(db, H).turns.length === 10)
  const chatBad = fakeChat({ J1: '坏' })
  const r0 = await flushFast(db, H, { chat: chatBad, embed, at: nextAt() })
  check('抽取失败 → 缓冲保留，下次再试', r0.status === 'deferred' && bufferOf(db, H).turns.length === 10)
  const chat = fakeChat({ J1: (input) => J1out([{ layer: 'L', kind: 'role', text: '我想做一个靠谱的倾听者' }]), J2: j2 })
  const r = await flushFast(db, H, { chat, embed, at: nextAt() })
  check('抽取成功 → 写账本、清缓冲', r.status === 'done' && bufferOf(db, H).turns.length === 0 && listHeads(db, H, 'L').length === 1, r)
  check('J1 输入带对话与回合编号', JSON.stringify(chat.calls[0].messages).includes('第0句'))
}

// ======================= P1 重放 =======================
for (const aid of [A, 'agt_deg', 'agt_nob2', 'agt_hook']) {
  const before = JSON.stringify(snapshot(db, aid))
  rebuild(db, aid)
  check('P1 重放：' + aid + ' 清空投影后重建逐字段相等', JSON.stringify(snapshot(db, aid)) === before)
}

// ======================= 模糊模拟：随机 J1 / J2 / 嵌入 / 降级 =======================
{
  const SEED = Number(process.env.SG_SEED || 4)
  let s = SEED >>> 0
  const rnd = () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
  const pick = (a) => a[Math.floor(rnd() * a.length)]
  const F = 'agt_fuzz'
  setSangguanConfig(db, F, { enabled: true, budget: { fast: 200 } })
  const TOPICS = ['努力', '运气', '早起', '诚实', '家人', '事业', '自由', '规则', '学习', '休息']
  const KINDS = { W: ['belt', 'obs'], L: ['chapter', 'role'], V: ['norm', 'ideal'] }
  const fuzzVec = {}
  const fembed = async (text) => fuzzVec[text] || null
  const bad = []
  let items = 0
  let cands = 0
  const tally = {}
  const cov = { ev: 0, tr: 0, drained: 0 }
  for (let run = 0; run < 120; run++) {
    const st = loadState(db, F)
    const live = Object.values(st.claims).filter((c) => !['superseded', 'falsified', 'sublated', 'demoted', 'withdrawn'].includes(c.status))
    const coex = Object.values(st.kappas).filter((k) => k.sigma === 'coexist')
    const nus = Object.values(st.nus).filter((n) => n.outcome === 'pending')
    const cs = []
    const nc = Math.floor(rnd() * 4)
    for (let i = 0; i < nc; i++) {
      const layer = pick(['W', 'L', 'V'])
      const topic = pick(TOPICS)
      const text = topic + pick(['很重要', '不重要', '要看情况', '决定一切', '常被高估']) + (rnd() < 0.3 ? '' : '·' + Math.floor(rnd() * 5))
      if (!fuzzVec[text]) { const v = new Array(12).fill(0); v[TOPICS.indexOf(topic)] = 1; v[10 + Math.floor(rnd() * 2)] = rnd() * 0.8; fuzzVec[text] = v }
      const c = { layer: rnd() < 0.05 ? 'X' : layer, kind: rnd() < 0.05 ? 'core' : pick(KINDS[layer]), text }
      if (rnd() < 0.2) c.nu = [{ expect: '会发生某事', observe: '看结果', p: 0.5, due_days: 1 + Math.floor(rnd() * 30) }]
      cs.push(c)
    }
    const evidence = []
    for (let i = 0; i < Math.floor(rnd() * 3); i++) {
      const tgt = rnd() < 0.2 && nus.length ? pick(nus).id : live.length ? pick(live).id : 'cl_x'
      evidence.push({ target_id: tgt, sign: pick([1, -1]), kind: pick(['act', 'verdict', 'check']), ref_turn: pick([0, 0, 1, 2]) })
    }
    const tradeoffs = coex.length && rnd() < 0.3 ? [{ kappa_id: pick(coex).id, lean_pole: pick(['pos', 'neg']), cost: '某代价', ref_turn: 0 }] : []
    // 偶尔造一个并存 κ，让 TRADEOFF 有对象
    if (rnd() < 0.08) {
      const ls = live.filter((c) => c.layer === 'L' && c.status === 'active')
      if (ls.length >= 2) {
        const [a, b] = ls.sort((x, y) => x.born_seq - y.born_seq).slice(0, 2)
        try {
          const k = openK(F, 'L', a.id, b.id)
          put(F, [ev('DELIBERATE', 'L', { kappa_id: k, branch: 'COEX' }), ev('COEX', 'L', { kappa_id: k, loss: '某损失' })])
        } catch { /* I4 冲突时不开 */ }
      }
    }
    if (rnd() < 0.05) for (let i = 0; i < 4; i++) recordJudge(db, F, clock, false)
    const j2f = rnd() < 0.1 ? new Error('随机失败') : (input) => ({ pairs: input.neighbors.filter(() => rnd() < 0.9).map((n) => ({ c_id: n.id, rel: pick(['dup', 'contradict', 'compatible', 'unrelated']), reason: '随' })) })
    const j1f = rnd() < 0.05 ? '坏' : J1out(cs, { evidence, tradeoffs })
    let r
    try {
      r = (await fast(F, j1f, j2f, { embed: rnd() < 0.2 ? async () => null : fembed, pendingCap: 5, turns: T('用户说了些话', '助手回应') })).r
    } catch (e) {
      bad.push({ run, msg: '快环抛出异常', e: String(e && e.stack || e).slice(0, 300) })
      continue
    }
    if (rnd() < 0.1) clock += 25 * 3600000
    if (r.status === 'done') {
      cov.ev += r.evidence.written
      cov.tr += r.tradeoffs.written
      cov.drained += r.pending.drained
      cands += cs.length
      items += r.items.length
      for (const it of r.items) tally[it.cls] = (tally[it.cls] || 0) + 1
      if (r.items.length !== cs.length) bad.push({ run, msg: '候选与结果条数不一致', n: cs.length, got: r.items.length })
    }
    if (r.errors && r.errors.length) bad.push({ run, msg: '写入被拒', errors: r.errors.slice(0, 2) })
    const inv = okInv(F)
    if (inv.length) bad.push({ run, msg: '不变式', inv: inv.slice(0, 2) })
  }
  check('模糊模拟（种子 ' + SEED + '）：120 轮快环无异常、无写入被拒、不变式全程成立', bad.length === 0, bad.slice(0, 3))
  check('模糊模拟：每个候选恰好一个结果', items === cands, { items, cands })
  check('模糊模拟：覆盖多种分类', Object.keys(tally).length >= 4, tally)
  check('模糊模拟：不是空转（候选 ≥100、有证据入账）', cands >= 100 && cov.ev > 0, { cands, cov })
  console.log('  覆盖：', JSON.stringify({ tally, cands, ...cov }))
  const before = JSON.stringify(snapshot(db, F))
  rebuild(db, F)
  check('模糊模拟：P1 重放一致', JSON.stringify(snapshot(db, F)) === before)
}

// ======================= I15 / 结构约束 =======================
{
  const src = (f) => fs.readFileSync(new URL('../src/modules/sangguan/' + f, import.meta.url), 'utf8')
  check('gates.classify 是纯函数文件：不 import llm / ledger / 时钟', !/from '\.\/(llm|ledger|projection|budget)\.js'/.test(src('gates.js')) && !/Date\.now\(|new Date\(\)/.test(src('gates.js')))
  check('sim 不读时钟、不调模型', !/Date\.now\(|new Date\(\)|llm/.test(src('sim.js')))
  check('fold 仍不碰快环模块', !/from '\.\/(fast|gates|sim|templates)\.js'/.test(src('fold.js')))
}

console.log(`\n通过 ${pass} / ${pass + fail}`)
try { db.close() } catch { /* ignore */ }
try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
process.exit(fail ? 1 : 0)
