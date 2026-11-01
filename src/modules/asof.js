/**
 * G1-5 「某天当时」查询：时效索引定位 + 冷库出证。
 *
 *   时间 → 那段时间哪些记忆、哪个版本算数（memory_timeline 投影）
 *        → 版本原句（fact_archive）+ 当时原话（raw_turns）
 *        → 带标签回答：当时有效 / 期间改过 / 当时有争议 / 历史陈述（+「现在：…」）
 *
 * 硬规则：只读。绝不 touch（不加 hits、不拨 last_hit_at、不改热度/温度）——
 * 翻一次旧账就把作废的旧事实重新加热，比答不上来更糟。
 * 不改 S1/S2/S3：这是旁路。
 */
import { now } from '../db.js'
import { getParam } from '../kernel.js'
import { searchFacts, evidenceOf } from './retrieve.js'
import { searchFactArchive, searchRaw } from './archive.js'
import { hasLexOverlap } from './recall_tool.js'
import { parseTimeRange } from './timeparse.js'
import { projectMany, overlaps, versionRefAt, asofEnabled, asofAxis, eventsOf, projectTimeline } from './timeline.js'
import { logRetrieval } from './retrieval_log.js'

const GATE = 0.20        // 与 S3 证据门同档
const SOFT_FLOOR = 0.45  // 无字面重合时的软匹配门槛（与检索工具同规则）
const TYPES = new Set(['fact', 'appraisal'])
const HIST = ':hist:'

const baseId = (mid) => { const s = String(mid || ''); const i = s.indexOf(HIST); return i < 0 ? s : s.slice(0, i) }
const iso = (v) => { const t = Date.parse(String(v || '')); return Number.isFinite(t) ? new Date(t).toISOString() : null }
const minus1 = (t) => new Date(Date.parse(t) - 1).toISOString()
const later = (a, b) => (a > b ? a : b)

/** 去掉时间短语和问句套话，剩下的才是「查什么」。 */
export function topicOf(query, phrase) {
  let s = String(query || '')
  if (phrase) s = s.replace(phrase, ' ')
  s = s.replace(/(那时候?|当时|的时候|那会儿?|那阵子|那天|期间|时候)/g, ' ')
    .replace(/(我|你)(还)?(记得|说过|讲过|提过)/g, ' ')
    .replace(/[？?。！!，,、]/g, ' ')
    .replace(/(是什么|是啥|什么|啥|吗|呢|吧|嘛|呀|啊)\s*$/g, ' ')
    .replace(/\s+/g, ' ').trim()
  return s || String(query || '').trim()
}

function archiveText(db, aid, ref) {
  if (!ref) return null
  try { return db.prepare('SELECT text FROM fact_archive WHERE agent_id=? AND id=?').get(aid, ref)?.text || null } catch { return null }
}

function relevance(q, texts) {
  let best = 0
  let lex = false
  const whole = String(q || '').replace(/\s+/g, '')
  for (const t of texts) {
    if (!t) continue
    best = Math.max(best, evidenceOf({ text: t }, q))
    if (hasLexOverlap(q, t)) lex = true
    // 话题整个出现在正文里（「狗」→「以前养过一只狗」）：单字话题 n-gram 分很低，但这是实打实的字面证据
    if (whole && String(t).includes(whole)) best = Math.max(best, 0.6)
  }
  return { e: Math.round(best * 1e4) / 1e4, lex }
}

/** 某段时间内的那一版正文（取窗口内最后时刻的版本）+ 窗口内改过的版本链。 */
function versionsIn(db, aid, row, proj, from, to) {
  const tEnd = minus1(to)
  const textAt = (t) => {
    const v = versionRefAt(proj.revisions, t)
    if (!v.revised) return { text: row.text, approx: false }
    const txt = archiveText(db, aid, v.text_ref)
    return txt ? { text: txt, approx: false } : { text: archiveText(db, aid, firstAddRef(proj)) || row.text, approx: true }
  }
  const inWin = proj.revisions.filter((r) => r.eff > from && r.eff < to)
  const startT = from > proj.born ? from : proj.born
  const first = textAt(startT)
  const last = textAt(tEnd)
  return { text: last.text, first: first.text, revised: inWin.length > 0 && first.text !== last.text, approx: first.approx || last.approx, revisedAt: inWin.length ? inWin[inWin.length - 1].eff : null }
}

function firstAddRef(proj) {
  const add = proj.events.find((e) => e.op_eff === 'ADD')
  return add ? add.text_ref : null
}

/** 现在的说法：当时的版本和现状不同才给（防「把三个月前的话当现状讲」）。 */
function nowNote(db, aid, row, proj, thenText) {
  if (!proj.nowActive) {
    let by = null
    if (row.superseded_by) {
      try { by = db.prepare("SELECT text,status,invalid_at FROM memory_items WHERE id=? AND status='active'").get(row.superseded_by) } catch { by = null }
    }
    if (!by) {
      // 冲突取代：找冲突里的另一方
      try {
        const c = db.prepare(`SELECT a_id,b_id FROM conflicts WHERE agent_id=? AND (a_id=? OR b_id=?) ORDER BY rowid DESC LIMIT 1`).get(aid, row.id, row.id)
        const other = c ? (c.a_id === row.id ? c.b_id : c.a_id) : null
        if (other) by = db.prepare("SELECT text FROM memory_items WHERE id=? AND status='active' AND invalid_at IS NULL").get(other)
      } catch { by = null }
    }
    return by && by.text ? '已改口为「' + by.text + '」' : '现在已不作数'
  }
  return row.text !== thenText ? '现在是「' + row.text + '」' : null
}

/** 那段时间里的原话：优先来源轮次，其次按话题在窗口内搜原文。 */
function quotesFor(db, aid, row, q, from, to) {
  const out = []
  if (row.source_turn_id) {
    try {
      const rs = db.prepare("SELECT text,created_at,role FROM raw_turns WHERE agent_id=? AND turn_id=? AND role='user' ORDER BY seq LIMIT 2").all(aid, row.source_turn_id)
      for (const r of rs) out.push({ at: r.created_at, text: String(r.text).slice(0, 160), inWindow: r.created_at >= from && r.created_at < to })
    } catch { /* 老库 */ }
  }
  return out
}

function windowQuotes(db, aid, q, from, to, k = 3) {
  let rows = []
  try { rows = searchRaw(db, aid, q, 40) || [] } catch { rows = [] }
  return rows
    .filter((r) => r.role === 'user' && r.created_at >= from && r.created_at < to && hasLexOverlap(q, r.text))
    .sort((a, b) => (a.created_at < b.created_at ? -1 : 1))
    .slice(0, k)
    .map((r) => ({ at: r.created_at, text: String(r.text).slice(0, 160) }))
}

/**
 * @param {object} db
 * @param {string} aid
 * @param {string} query 问句（可带「去年三月」这类时间）
 * @param {{at?:string, from?:string, to?:string, axis?:'said'|'recorded', k?:number, now?:Date|string, log?:boolean}} [opt]
 */
export function retrieveAsOf(db, aid, query, opt = {}) {
  const t0 = Date.now()
  if (!asofEnabled(db, aid)) return { ok: false, reason: 'off', items: [] }
  const nowD = opt.now != null ? new Date(opt.now) : new Date()
  const nowIso = nowD.toISOString()
  const axis = opt.axis === 'recorded' || opt.axis === 'said' ? opt.axis : asofAxis(db, aid)
  const k = Math.max(1, Math.min(12, Number(opt.k) || 6))

  let range = null
  if (opt.at) {
    const at = iso(opt.at)
    if (at) range = { from: at, to: new Date(Date.parse(at) + 1).toISOString(), granularity: 'point', phrase: '' }
  } else if (opt.from || opt.to) {
    const f = iso(opt.from)
    const t = iso(opt.to) || nowIso
    if (f && t > f) range = { from: f, to: t, granularity: 'range', phrase: '' }
  } else {
    const p = parseTimeRange(query, { now: nowD })
    if (p) range = { from: p.from, to: p.to, granularity: p.granularity, phrase: p.phrase }
  }
  if (!range) return { ok: false, reason: 'no_time', items: [] }
  if (range.from > nowIso) return { ok: false, reason: 'future', items: [] }
  if (range.to > nowIso) range.to = nowIso
  if (range.to <= range.from) range.to = new Date(Date.parse(range.from) + 1).toISOString()
  range.axis = axis

  const q = topicOf(query, range.phrase)

  // 候选：现行正文 ∪ 冷库里的出生句 / 改写旧句（映射回主 id）
  const cand = new Map()
  const archHit = new Map()
  try {
    for (const r of searchFacts(db, aid, q, { includeCold: true, includeSuperseded: true })) cand.set(r.id, true)
  } catch { /* 少一路 */ }
  try {
    for (const f of searchFactArchive(db, aid, q, 40)) {
      const id = baseId(f.memory_id)
      cand.set(id, true)
      const list = archHit.get(id) || []
      list.push(f.text)
      archHit.set(id, list)
    }
  } catch { /* 少一路 */ }
  const ids = [...cand.keys()]
  let rows = []
  for (let i = 0; i < ids.length; i += 200) {
    const part = ids.slice(i, i + 200)
    try {
      rows.push(...db.prepare(`SELECT * FROM memory_items WHERE agent_id=? AND status='active' AND id IN (${part.map(() => '?').join(',')})`).all(aid, ...part))
    } catch { /* ignore */ }
  }
  rows = rows.filter((r) => TYPES.has(String(r.type)))
  const projs = projectMany(db, aid, rows.map((r) => r.id), { axis })

  const items = []
  const dropped = { no_history: 0, hidden: 0, out_of_range: 0, weak: 0 }
  for (const row of rows) {
    const p = projs.get(row.id)
    if (!p || !p.born) { dropped.no_history++; continue }
    if (p.hidden || p.deleted) { dropped.hidden++; continue }
    const act = p.active.filter((iv) => overlaps(iv, range.from, range.to))
    const dis = p.disputes.filter((iv) => overlaps(iv, range.from, range.to))
    const real = act.filter((iv) => iv[1] == null || iv[1] > iv[0])
    const zero = act.filter((iv) => iv[1] != null && iv[1] === iv[0])
    // 过去事实（「以前养过狗」）：说出口之后任何时候问，都是一句「历史陈述」，不是「当时有效」
    const pastFact = p.events.some((e) => e.op_eff === 'INVALIDATE' && e.reason === 'past_fact')
    let label = null
    let win = null
    if (pastFact) {
      if (p.born < range.to) { label = 'historical'; win = [p.born, p.born] }
    } else if (real.length) { label = 'valid'; win = real[real.length - 1] }
    else if (dis.length) { label = 'disputed'; win = dis[dis.length - 1] }
    else if (zero.length) { label = 'historical'; win = zero[zero.length - 1] }
    if (!label) { dropped.out_of_range++; continue }

    // 有效窗与查询窗的交集，用来取版本 / 算覆盖
    const wFrom = later(win[0], range.from)
    const wToRaw = win[1] == null ? range.to : (win[1] < range.to ? win[1] : range.to)
    const wTo = wToRaw > wFrom ? wToRaw : new Date(Date.parse(wFrom) + 1).toISOString()
    const ver = versionsIn(db, aid, row, p, wFrom, wTo)
    const rel = relevance(q, [ver.text, ver.first, row.text, ...(archHit.get(row.id) || [])])
    if (rel.e < GATE || (!rel.lex && rel.e < SOFT_FLOOR)) { dropped.weak++; continue }

    const span = Math.max(1, Date.parse(range.to) - Date.parse(range.from))
    const cover = Math.min(1, Math.max(0, (Date.parse(wTo) - Date.parse(wFrom)) / span))
    items.push({
      id: row.id,
      label: ver.revised && label === 'valid' ? 'revised' : label,
      disputed: dis.length > 0,
      text: ver.text,
      from_text: ver.revised ? ver.first : null,
      revised_at: ver.revised ? ver.revisedAt : null,
      since: win[0],
      until: win[1],
      now: label === 'historical' ? null : nowNote(db, aid, row, p, ver.text),
      approx: !!(p.approx || ver.approx),
      quotes: quotesFor(db, aid, row, q, range.from, range.to),
      e: rel.e,
      cover: Math.round(cover * 1000) / 1000,
      importance: Number(row.importance || 0.5),
    })
  }
  items.sort((a, b) => b.e - a.e || b.cover - a.cover || b.importance - a.importance)
  const picked = items.slice(0, k)
  const quotes = windowQuotes(db, aid, q, range.from, range.to)

  let beforeBirth = false
  if (!picked.length) {
    try {
      const first = db.prepare("SELECT MIN(COALESCE(valid_from, at)) t FROM memory_timeline WHERE agent_id=? AND op='ADD'").get(aid)?.t
      beforeBirth = !first || first >= range.to
    } catch { beforeBirth = false }
  }

  const out = { ok: true, query: String(query || ''), topic: q, range, items: picked, quotes, before_birth: beforeBirth, more: Math.max(0, items.length - k), ms: Date.now() - t0 }
  if (opt.log !== false) {
    logRetrieval(db, aid, {
      scene: 'ASOF', query: String(query || ''), why: { range, topic: q },
      counts: { cand: ids.length, rows: rows.length, kept: items.length }, dropped,
      kept: picked.map((x) => x.id), items: picked.length, tokens: 0, ms: out.ms,
    })
  }
  return out
}

/**
 * 工具口：as_of 是日期或「去年三月」这类说法；话题仍是 query。
 * 解析不出时间 → ok:false（工具渲染会提示怎么填），不退回普通检索冒充「当时」。
 */
export function asOfSearch(db, aid, query, asOf, axis, k) {
  const s = String(asOf || '').trim()
  const p = parseTimeRange(s)
  const o = { axis: axis === 'recorded' || axis === 'said' ? axis : undefined, k }
  if (p) {
    const v = retrieveAsOf(db, aid, query, { ...o, from: p.from, to: p.to })
    if (v.range) { v.range.phrase = p.phrase; v.range.granularity = p.granularity }
    return v
  }
  const t = Date.parse(s)
  if (Number.isFinite(t)) return retrieveAsOf(db, aid, query, { ...o, at: new Date(t).toISOString() })
  return { ok: false, reason: 'no_time', items: [] }
}

// ---------------------------------------------------------------- 渲染

const LABEL = { valid: '当时有效', revised: '期间改过', disputed: '当时有争议', historical: '历史陈述' }

const clip = (s, n) => { const a = Array.from(String(s || '').replace(/\s+/g, ' ').trim()); return a.length > n ? a.slice(0, n).join('') + '…' : a.join('') }

/**
 * 每轮注入的「那时」段（memory.asof.auto=on 才有）：问句带过去时间时，补几条 T1 行。
 * 返回的条目带 asof:true——调用方不能拿它们去 touch（只读口径）。
 * @returns {{items: Array<{id:string, partition:'T1', asof:true, text:string}>, view: object|null}}
 */
export function asofInjectItems(db, aid, query, opt = {}) {
  let auto = 'off'
  try { auto = String(getParam(db, aid, 'memory.asof.auto') || 'off') } catch { auto = 'off' }
  if (auto !== 'on' || !asofEnabled(db, aid)) return { items: [], view: null }
  const p = parseTimeRange(query, { now: opt.now != null ? new Date(opt.now) : new Date() })
  if (!p) return { items: [], view: null }
  const v = retrieveAsOf(db, aid, query, { now: opt.now, k: Math.max(1, Math.min(4, Number(opt.k) || 3)) })
  if (!v.ok || !v.items.length) return { items: [], view: v }
  const title = rangeTitle(v.range)
  const items = v.items.map((it) => {
    const body = it.label === 'revised' && it.from_text ? clip(it.from_text, 40) + ' → ' + clip(it.text, 40) : clip(it.text, 60)
    const tag = (LABEL[it.label] || it.label) + (it.disputed && it.label !== 'disputed' ? '·有争议' : '')
    return {
      id: it.id, partition: 'T1', asof: true,
      text: '（' + title + '那时·' + tag + '）' + body + (it.now ? '（现在：' + clip(it.now, 40) + '）' : ''),
    }
  })
  return { items, view: v }
}

function md(t) {
  const s = String(t || '')
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!m) return ''
  const d = new Date(s)
  return String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
}

function rangeTitle(r) {
  if (!r) return ''
  if (r.phrase) return r.phrase.replace(/＿/g, '')
  const f = md(r.from)
  const t = md(minus1(r.to))
  return f === t ? f : f + ' ~ ' + t
}

/** 给模型 / 人看的文本。 */
export function renderAsOf(v) {
  if (!v) return ''
  if (!v.ok) {
    if (v.reason === 'no_time') return '问句里没有能定位的过去时间（如「去年三月」「上周」「2026-03-15」）。'
    if (v.reason === 'future') return '那段时间还没到，按现在的记忆回答。'
    if (v.reason === 'off') return '「当时」查询已关闭（memory.asof=off）。'
    return '查不了当时的记忆。'
  }
  const head = '以下是「' + rangeTitle(v.range) + '」那时的记忆，不代表现在'
    + (v.range.axis === 'recorded' ? '（按入库时间）' : '') + '：'
  if (!v.items.length) {
    return v.before_birth ? head + '\n（那时还没有任何记录）' : head + '\n（那段时间没有和「' + v.topic + '」对得上的记忆）'
  }
  const lines = [head]
  for (const it of v.items) {
    let tag = LABEL[it.label] || it.label
    if (it.label === 'valid' && it.since) tag += ' ' + md(it.since) + ' 起'
    if (it.label === 'revised' && it.revised_at) tag += ' ' + md(it.revised_at)
    if (it.disputed && it.label !== 'disputed') tag += '·有争议'
    if (it.approx) tag += '·早期记录，时间为近似'
    const body = it.label === 'revised' && it.from_text ? it.from_text + ' → ' + it.text : it.text
    lines.push('- [' + tag + '] ' + body + (it.now ? '   （现在：' + it.now + '）' : ''))
    for (const qt of it.quotes || []) {
      lines.push('    原话 ' + md(qt.at) + (qt.inWindow ? '' : '（不在这段时间内）') + '：「' + qt.text + '」')
    }
  }
  for (const qt of v.quotes || []) lines.push('  · 那段时间你说过 ' + md(qt.at) + '：「' + qt.text + '」')
  if (v.more) lines.push('（还有 ' + v.more + ' 条没列出）')
  return lines.join('\n')
}

// ---------------------------------------------------------------- 单条历史（Mem0 式）

/**
 * 一条记忆的版本时间线：每版原句 + 每个事件。软删 / 删除的不给（遗忘优先）。
 * @returns {null | {id, current, nowActive, approx, versions: Array<{from,to,text}>, events: Array}}
 */
export function memoryHistory(db, aid, mid, opt = {}) {
  const row = db.prepare('SELECT * FROM memory_items WHERE id=? AND agent_id=?').get(mid, aid)
  if (!row || row.status !== 'active') return null
  const axis = opt.axis === 'recorded' ? 'recorded' : 'said'
  const evs = eventsOf(db, aid, mid)
  const p = projectMany(db, aid, [mid], { axis }).get(mid) || projectTimeline(evs, { axis })
  if (!p.born) return { id: mid, current: row.text, nowActive: row.invalid_at == null, approx: true, versions: [{ from: row.created_at, to: null, text: row.text }], events: [] }
  const versions = []
  let from = p.born
  for (const r of p.revisions) {
    versions.push({ from, to: r.eff, text: archiveText(db, aid, r.text_ref) || '（旧版本原句缺失）' })
    from = r.eff
  }
  versions.push({ from, to: null, text: row.text })
  return {
    id: mid, current: row.text, nowActive: p.nowActive, approx: p.approx,
    active: p.active, disputes: p.disputes, versions,
    events: p.events.map((e) => ({ seq: e.seq, op: e.op, as: e.op_eff, at: e.at, eff: e.eff, reason: e.reason, cause_id: e.cause_id, approx: !!e.approx })),
    at: now(),
  }
}
