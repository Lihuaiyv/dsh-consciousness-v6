/**
 * 三观注入（S12；master-plan inject.js）：链头 + 活跃矛盾 + 1 条先例 + L2 自传摘要 + 待问的一句 → 注入行。
 * 只读投影与账本，从不写账本；L7 / L8 只改排序（liveness.viewWeights），不改 status。
 * 文案零术语（F-I7）：不出现 κ / π / ν；页头只收 active 链头（F-I3，试用中的合题不上）。
 * 挂点 promptHook：开关关闭原样返回入参（提示词逐字不变）；shadow 只记录会注入什么；live 才替换旧三观行。
 */
import crypto from 'node:crypto'
import { getFlag, setFlag } from '../../kernel.js'
import { localDay } from '../../db.js'
import { isEnabled, sangguanConfig } from './config.js'
import { LAYERS, isCoreKind } from './catalog.js'
import { theta, isHollowSeed } from './fold.js'
import { loadState, listHeads } from './projection.js'
import { readEvents, lastSeq } from './ledger.js'
import { viewWeights } from './liveness.js'
import { precedentIndex, precedentFor } from './precedent.js'
import { instructionLike } from './gates.js'
import { resetSelfview } from '../selfview.js'
import { pendingViolationLine } from './violate.js'
import { pledgeMissLine } from './pledge.js'

const DAY = 86400000
export const INJECT_BUDGET = 160
export const SHADOW_DAYS = 7
export const ASK_CAP = 3
const askKey = (aid) => 'sangguan.ask:' + aid
const PER_LAYER = 3
const KAPPA_LINES = 2
const SAMPLES = 10
// 与 clampInjection 同一套估法：中文约 2 字一个 token
const est = (t) => Math.ceil(String(t).length / 2)
// 注入行只许一行纯文本：换行、控制符、角色标记、代码围栏都抹掉，免得账本里的字被读成另一段系统指令
const clean = (t) => String(t || '')
  .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ')
  .replace(/<\|[^|]*\|>|\[\/?INST\]|`+|[<>]/gi, '')
  .replace(/\s{2,}/g, ' ')
const clip = (t, n = 40) => {
  const s = clean(t).trim().replace(/[。；;.!！?？]+$/, '')
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}
const q = (t, n) => '「' + clip(t, n) + '」'

const LEAD = { W: '你对世界的基本看法：', L: '你的人生观：', V: '你更看重：' }
const BRANCH_WORD = { RESOLVE: '选定了一边', SUB: '想出了一个兼顾两边的说法', COEX: '两样都留着', SUSPEND: '先放了放' }
const logKey = (aid) => 'sangguan.inject:' + aid
const saidKey = (aid) => 'sangguan.said:' + aid
const CHANGE_TYPES = ['REV', 'SUB_CONFIRM', 'ELEV_COMMIT', 'CLAIM_WITHDRAW', 'CLAIM_RETIRE']
const CACHE = new WeakMap()

export function dropInjectCache(db, aid) {
  const m = CACHE.get(db)
  if (m) m.delete(aid)
}

function claimTexts(db, aid) {
  return new Map(db.prepare('SELECT id, text FROM persona_claims WHERE agent_id=?').all(aid).map((r) => [r.id, r.text || '']))
}

function saidOf(db, aid) {
  try {
    const v = JSON.parse(getFlag(db, saidKey(aid)) || '{}')
    return v && typeof v === 'object' ? v : {}
  } catch { return {} }
}

/** 核心改了、合题站住了、或撤回了种子：自述缓存清一次；注入里只说一轮。装不进预算就不算说过。 */
function pendingChange(db, aid, tx) {
  const evs = readEvents(db, aid, { types: CHANGE_TYPES })
  const last = evs.length ? evs[evs.length - 1] : null
  if (!last) return null
  const said = saidOf(db, aid)
  if ((said.reset || 0) < last.seq) {
    try { resetSelfview(db, aid) } catch { /* 表还没有也无所谓 */ }
    setFlag(db, saidKey(aid), JSON.stringify({ ...said, reset: last.seq }))
  }
  if ((said.said || 0) >= last.seq) return null
  const p = last.payload || {}
  const body = last.type === 'CLAIM_WITHDRAW'
    ? (tx.get(p.claim_id) || '')
    : ((p.claims && p.claims[0] && p.claims[0].text) || '')
  const line = body ? '我改了一个看法：' + clip(body, 24) + '。' : '我改了一个看法。'
  return { seq: last.seq, line }
}

function markSaid(db, aid, seq) {
  const said = saidOf(db, aid)
  setFlag(db, saidKey(aid), JSON.stringify({ ...said, said: seq, reset: Math.max(said.reset || 0, seq) }))
}

function layerLine(db, aid, layer, w) {
  // 早于 W1 防注入入账的旧命题，到这里再挡一道
  const heads = listHeads(db, aid, layer).filter((h) => h.status === 'active' && h.kind !== 'commit' && !instructionLike(h.text) && !isHollowSeed(h))
  if (!heads.length) return { line: '', ids: [] }
  const core = (h) => (isCoreKind(layer, h.kind) ? 1 : 0)
  const pick = heads
    // 底数 0.1：没证据的新命题也有名次，L7 / L8 降权才分得出先后
    .map((h) => ({ ...h, score: (0.1 + h.e) * (w[h.id] == null ? 1 : w[h.id]) }))
    .sort((a, b) => core(b) - core(a) || b.score - a.score || (a.id < b.id ? -1 : 1))
    .slice(0, PER_LAYER)
  return { line: LEAD[layer] + pick.map((h) => clip(h.text)).join('；') + '。', ids: pick.map((h) => h.id) }
}

function lastBy(evs, pred) {
  for (let i = evs.length - 1; i >= 0; i--) if (pred(evs[i])) return evs[i]
  return null
}

function kappaLines(s, tx, evs) {
  const open = Object.values(s.kappas).filter((k) => ['struggle', 'suspended', 'sub_trial', 'coexist'].includes(k.sigma))
    .sort((a, b) => b.last_seq - a.last_seq || (a.id < b.id ? -1 : 1))
    .filter((k) => ![k.pos_id, k.neg_id, k.sub_id].some((id) => id && instructionLike(tx.get(id))))
    .slice(0, KAPPA_LINES)
  return open.map((k) => {
    const a = tx.get(k.pos_id)
    const b = tx.get(k.neg_id)
    let line
    if (k.sigma === 'sub_trial') line = '你正在试一个新说法：' + q(tx.get(k.sub_id), 50) + '（还在看它站不站得住）。'
    else if (k.sigma === 'coexist') {
      const coex = lastBy(evs, (e) => e.type === 'COEX' && e.payload.kappa_id === k.id)
      const loss = coex && coex.payload.loss
      const lean = loss ? (loss.lean_pole === 'neg' ? b : a) : null
      line = '两样你都要：' + q(a, 30) + '和' + q(b, 30) + (loss ? '；平时偏向' + q(lean, 20) + '，代价是' + clip(loss.cost, 40) : '') + '。'
    } else line = '你还没想定：' + q(a, 30) + '还是' + q(b, 30) + '。'
    return { id: k.id, line }
  })
}

/** 判断条先例句：该矛盾最近一次审议引用的先例里 ω·|o| 最大者。 */
function precedentLine(db, aid, s, k, evs, now) {
  if (!k) return null
  const idx = precedentIndex(db, aid, s, now)
  const pf = precedentFor(s, s.kappas[k.id], idx)
  const d = lastBy(evs, (e) => e.type === 'DELIBERATE' && e.payload.kappa_id === k.id && (e.precedent_ids || []).length)
  const pool = d ? pf.D.filter((x) => d.precedent_ids.includes(x.id)) : pf.D
  const best = [...pool].sort((x, y) => y.omega * Math.abs(y.o) - x.omega * Math.abs(x.o))[0]
  if (!best || !best.o) return null
  const kd = s.kappas[best.kappa_id]
  const qt = kd && kd.q_id ? db.prepare('SELECT text FROM claim_questions WHERE id=?').get(kd.q_id) : null
  if (!qt) return null
  return { id: best.id, line: '（上回类似的事' + q(qt.text, 30) + '，你' + BRANCH_WORD[best.branch] + '，后来' + (best.o > 0 ? '证明还行' : '发现不太对') + '。）' }
}

export function summaryOf(ev) {
  const x = ev && (ev.payload.summaries || [])[0]
  if (!x) return null
  try { return { id: x.id, ...JSON.parse(x.text) } } catch { return null }
}

function summaryLine(evs) {
  const sm = summaryOf(lastBy(evs, (e) => e.type === 'SUMMARY_BUILD'))
  if (!sm || !sm.chapter || instructionLike(sm.chapter + ' ' + sm.at_the_time)) return null
  return { id: sm.id, line: '你给自己这一程的说法：' + clip(sm.chapter, 20) + '——' + clip(sm.at_the_time, 60) + '。' }
}

function askState(db, aid) {
  try {
    const v = JSON.parse(getFlag(db, askKey(aid)) || 'null')
    if (v && typeof v === 'object') return { id: null, question: '', shown: 0, asked: false, ...v }
  } catch { /* 坏记录当空 */ }
  return { id: null, question: '', shown: 0, asked: false }
}

function saveAsk(db, aid, st) {
  setFlag(db, askKey(aid), JSON.stringify(st))
}

/** 这问已经问出口，或已经塞进提示词 ASK_CAP 次，就不再注入。 */
function askClosed(st, id) {
  return !!(st && st.id === id && (st.asked || st.shown >= ASK_CAP))
}

/** L1 的 ask 送进对话：T_ask 日内未答、也还没问出口的最近一问。 */
function askLine(db, aid, s, evs, now) {
  const answered = new Set(evs.filter((e) => e.type === 'INQUIRY' && e.payload.answer_of).map((e) => e.payload.answer_of))
  const since = new Date(Date.parse(now) - theta(s, 'T_ask') * DAY).toISOString()
  const e = lastBy(evs, (x) => x.type === 'INQUIRY' && x.payload.mode === 'ask' && x.payload.question && !answered.has(x.id) && x.at > since && x.at <= now)
  if (!e || instructionLike(e.payload.question)) return null
  if (askClosed(askState(db, aid), e.id)) return null
  return { id: e.id, question: e.payload.question, line: '（你最近想弄清一件事，合适时可以自然地问对方：' + clip(e.payload.question, 60) + '——别生硬，也别每轮都问。）' }
}

/** 助手已经把这问说出口（字面包含或足够像）就停。 */
export function noteAskSpoken(db, aid, text) {
  const st = askState(db, aid)
  if (!st.id || st.asked || !st.question) return false
  const q = String(st.question).replace(/[\s？?。！!，,、]/g, '')
  const a = String(text || '').replace(/[\s？?。！!，,、]/g, '')
  if (!q || !a.includes(q.slice(0, Math.min(q.length, 16)))) return false
  st.asked = true
  saveAsk(db, aid, st)
  return true
}

function noteAskDelivered(db, aid, id, question) {
  const st = askState(db, aid)
  const next = st.id === id ? st : { id, question: question || '', shown: 0, asked: false }
  if (next.asked || next.shown >= ASK_CAP) return
  next.shown += 1
  if (question) next.question = question
  saveAsk(db, aid, next)
}

/**
 * 注入视图：{ mode, layers:{W,L,V:{line,ids}}, extra[], lines[], text, tokens, sources }。
 * 预算按优先级装：三层 > 待问 > 第一条矛盾 > 摘要 > 第二条矛盾 > 先例；装不下的整行跳过。
 */
export function injectView(db, aid, opt = {}) {
  const now = opt.now || new Date().toISOString()
  const budget = Number(opt.budget) > 0 ? Number(opt.budget) : INJECT_BUDGET
  const seq = lastSeq(db, aid)
  const mode = sangguanConfig(db, aid).inject
  const asked = askState(db, aid)
  const txEarly = claimTexts(db, aid)
  const pending = pendingChange(db, aid, txEarly)
  const said = saidOf(db, aid)
  const ck = [seq, String(now).slice(0, 13), budget, mode, asked.id, asked.shown, asked.asked ? 1 : 0, said.reset || 0, said.said || 0, pending ? pending.seq : 0].join('|')
  if (!CACHE.has(db)) CACHE.set(db, new Map())
  const hit = CACHE.get(db).get(aid)
  if (hit && hit.key === ck && opt.cache !== false) return hit.view
  const s = loadState(db, aid)
  const tx = txEarly
  const evs = readEvents(db, aid, { types: ['COEX', 'DELIBERATE', 'SUMMARY_BUILD', 'INQUIRY'] }).filter((e) => e.at <= now)
  const w = viewWeights(db, aid, now)
  const layers = Object.fromEntries(LAYERS.map((l) => [l, layerLine(db, aid, l, w)]))
  const ks = kappaLines(s, tx, evs)
  const vline = pendingViolationLine(db, aid, now)
  const pmiss = pledgeMissLine(db, aid, now)
  const items = [
    ...LAYERS.map((l) => ({ slot: 'layer', layer: l, line: layers[l].line, rank: 0 })),
    pending ? { slot: 'changed', line: pending.line, rank: 0, seq: pending.seq } : null,
    vline ? { slot: 'violate', line: vline.line, rank: 0, seq: vline.seq } : null,
    pmiss ? { slot: 'pmiss', line: pmiss.line, rank: 0, seq: pmiss.seq } : null,
    { slot: 'ask', ...askLine(db, aid, s, evs, now), rank: 3 },
    { slot: 'kappa', ...ks[0], rank: 1 },
    { slot: 'summary', ...summaryLine(evs), rank: 0 },
    { slot: 'kappa', ...ks[1], rank: 1 },
    { slot: 'precedent', ...precedentLine(db, aid, s, ks[0], evs, now), rank: 2 },
  ].filter((x) => x && x.line)
  let used = 0
  const keep = new Set()
  for (const x of items) {
    const t = est(x.line) + 1
    if (used + t > budget) continue
    used += t
    keep.add(x)
  }
  const changed = [...keep].find((x) => x.slot === 'changed')
  // 只有真的说进提示词才算「说过」；shadow 期只是草稿，不能预支。
  // opt.mark === false 用于「只看会注入什么」的读口（预览、闸门），不许产生副作用。
  const marking = mode === 'live' && opt.mark !== false
  if (changed && marking) markSaid(db, aid, changed.seq)
  const vk = [...keep].find((x) => x.slot === 'violate')
  if (vk && marking) setFlag(db, 'sangguan.violate.said:' + aid, String(vk.seq))
  const pk = [...keep].find((x) => x.slot === 'pmiss')
  if (pk && marking) setFlag(db, 'sangguan.pmiss.said:' + aid, String(pk.seq))
  for (const l of LAYERS) if (![...keep].some((x) => x.layer === l)) layers[l] = { line: '', ids: [] }
  // 展示顺序：摘要 → 矛盾 → 先例 → 待问
  const extra = items.filter((x) => keep.has(x) && x.slot !== 'layer').sort((a, b) => a.rank - b.rank)
  const lines = [...LAYERS.map((l) => layers[l].line).filter(Boolean), ...extra.map((x) => x.line)]
  const text = lines.join('\n')
  const view = {
    mode, at: now, seq, layers, extra: extra.map((x) => x.line), lines, text, tokens: est(text), budget,
    sources: {
      claims: LAYERS.flatMap((l) => layers[l].ids),
      kappas: extra.filter((x) => x.slot === 'kappa').map((x) => x.id),
      precedent: (extra.find((x) => x.slot === 'precedent') || {}).id || null,
      summary: (extra.find((x) => x.slot === 'summary') || {}).id || null,
      inquiry: (extra.find((x) => x.slot === 'ask') || {}).id || null,
      ask_q: (extra.find((x) => x.slot === 'ask') || {}).question || null,
    },
  }
  CACHE.get(db).set(aid, { key: ck, view })
  return view
}

/** code-guide 签名：inject.lines(db, aid, budgetTokens) → string[]。 */
export function lines(db, aid, budgetTokens = INJECT_BUDGET, now) {
  return injectView(db, aid, { budget: budgetTokens, now }).lines
}

// ---------- shadow 记录（只记在 flags，不进账本） ----------
export function injectLog(db, aid) {
  try {
    const v = JSON.parse(getFlag(db, logKey(aid)) || 'null')
    if (v && typeof v === 'object') return { since: null, days: [], shadow_days: [], changes: 0, samples: [], last: null, ...v }
  } catch { /* 坏记录当空 */ }
  return { since: null, days: [], shadow_days: [], changes: 0, samples: [], last: null }
}

function noteInject(db, aid, view, mode, now) {
  const log = injectLog(db, aid)
  const day = localDay(new Date(now))
  const hash = crypto.createHash('sha1').update(view.text).digest('hex').slice(0, 16)
  const newDay = !log.days.includes(day)
  const changed = !log.last || log.last.hash !== hash
  const newShadow = mode === 'shadow' && !log.shadow_days.includes(day)
  if (!newDay && !changed && !newShadow) return log
  if (!log.since) log.since = now
  if (newDay) log.days = [...log.days, day].slice(-60)
  if (newShadow) log.shadow_days = [...log.shadow_days, day].slice(-60)
  if (changed) {
    if (log.last) log.changes += 1
    log.samples = [...log.samples, { at: now, mode, tokens: view.tokens, text: view.text }].slice(-SAMPLES)
  }
  log.last = { at: now, hash, mode, tokens: view.tokens }
  setFlag(db, logKey(aid), JSON.stringify(log))
  return log
}

/** shadow 满 7 个不同日期才建议切 live。 */
export function liveReady(db, aid) {
  const log = injectLog(db, aid)
  return { ready: log.shadow_days.length >= SHADOW_DAYS, shadow_days: log.shadow_days.length, need: SHADOW_DAYS }
}

/**
 * 提示词挂点。legacy = { worldLine, lifeLine, valLine }（旧仪表生成的三行）。
 * 关闭：原样返回同一个对象；shadow：记录后原样返回；live：有链头的层换成三观行，其余层保留旧行兜底（F-I5），另给 extra 行。
 */
export function promptHook(db, aid, legacy, opt = {}) {
  if (!isEnabled(db, aid)) return legacy
  const now = opt.now || new Date().toISOString()
  const mode = sangguanConfig(db, aid).inject
  let view
  try { view = injectView(db, aid, { now, budget: opt.budget }) } catch { return legacy }
  try { noteInject(db, aid, view, mode, now) } catch { /* 记录失败不影响注入 */ }
  if (mode !== 'live') return legacy
  if (view.sources.inquiry && !askClosed(askState(db, aid), view.sources.inquiry)) noteAskDelivered(db, aid, view.sources.inquiry, view.sources.ask_q)
  return {
    ...legacy,
    worldLine: view.layers.W.line || legacy.worldLine,
    lifeLine: view.layers.L.line || legacy.lifeLine,
    valLine: view.layers.V.line || legacy.valLine,
    extra: view.extra,
    ask: view.sources.ask_q || '',
  }
}
