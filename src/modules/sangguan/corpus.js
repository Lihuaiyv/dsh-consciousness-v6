/**
 * 环的开头：语料。
 *
 * 读的是这一周的事实，一句是一句，不把纪要和日记再压短：
 *   - fragments 里的原话（真相）
 *   - episodes 里「你对我说 / 我对你说」那两半原话、以及没合上的问句（不是那条概括摘要）
 *   - 已写好的日记里能落到具体事上的句子（纯态度句不要）
 * 压过的句子是散的。这里要的是事实撑得住的那一句道理。
 * 复述原话、把一天写成流水的，丢掉。
 */
import { call } from './llm.js'
import './templates.js'
import { lexicalSim } from './sim.js'
import { kindOfForegone, gatesOf } from './draft.js'
import { createDraft } from './draftstore.js'

const DAY = 86400000
const NOISE = /^(好的|收到|嗯+|明白|谢谢|好，|在干活|我这就)$/
const CODE = /```|\bfunction\b|\bSELECT\b|\bconst\b/
const NARRATIVE = /^(今天|昨晚|凌晨|\d{4}-\d{2}-\d{2})/

/** 事件的日期以它被归到的那一天为准：补写的老纪要，created_at 可能是几天以后。 */
function atOf(day, createdAt, time = 'T12:00:00.000Z') {
  const c = String(createdAt || '')
  if (c && c.slice(0, 10) === String(day)) return c
  return day ? String(day) + time : c
}

/** 一句原话。长段不掐成摘要，留不住一整句就不要。 */
export function factLine(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim()
  if (!t || NOISE.test(t) || CODE.test(t)) return ''
  const sent = t.split(/[。！？\n]/).map((s) => s.trim()).find((s) => s.length >= 8)
  if (!sent || sent.length > 120) return ''
  return sent
}

export function collectFacts(db, aid, now, days = 7) {
  const from = new Date(Date.parse(now) - days * DAY).toISOString().slice(0, 10)
  let rows = []
  try {
    rows = db.prepare(`SELECT id, role, text, created_at FROM fragments
      WHERE agent_id=? AND day>=? AND text IS NOT NULL AND length(trim(text))>0
      ORDER BY created_at ASC LIMIT 800`).all(aid, from)
  } catch { rows = [] }
  const out = []
  for (const r of rows) {
    const text = factLine(r.text)
    if (!text) continue
    out.push({ ref: r.id, at: r.created_at, role: r.role, text, source: 'raw' })
  }
  return out
}

const CUE = /(不对|不是这样|别这样|别急|重来|重新|再想|想想|错了|停一下|不要这样|不行|换个|换一种)/
const ASK = /[？?]\s*$|(吗|呢|吧)\s*$/

/** 弧里的原话留整句，只截长度，不掐成「第一句」。 */
function arcLine(text, max = 160) {
  const t = String(text || '').replace(/\s+/g, ' ').trim()
  if (!t || NOISE.test(t) || CODE.test(t)) return ''
  return t.length > max ? t.slice(0, max) + '…' : t
}

/**
 * 事件弧：一件事顺着几轮怎么走下来——她先说、主人顶一句、她改成。
 * 只认「纠正」的那种顶：疑问句（是不是/要不要）不算；她下一轮得真的换了说法。
 */
export function collectArcs(db, aid, now, days = 7, max = 12) {
  const from = new Date(Date.parse(now) - days * DAY).toISOString().slice(0, 10)
  let rows = []
  try {
    rows = db.prepare(`SELECT id, session_id, seq, role, text, created_at FROM fragments
      WHERE agent_id=? AND day>=? AND text IS NOT NULL AND length(trim(text))>0
      ORDER BY session_id ASC, seq ASC LIMIT 4000`).all(aid, from)
  } catch { rows = [] }
  const by = new Map()
  for (const r of rows) {
    if (!by.has(r.session_id)) by.set(r.session_id, [])
    by.get(r.session_id).push(r)
  }
  const out = []
  for (const [, turns] of by) {
    const used = new Set()
    for (let i = 1; i < turns.length - 1; i++) {
      const cue = turns[i]
      const raw = String(cue.text || '').trim()
      if (cue.role !== 'user' || !CUE.test(raw) || ASK.test(raw) || raw.length < 4) continue
      const before = turns[i - 1]
      const after = turns[i + 1]
      if (before.role !== 'assistant' || after.role !== 'assistant') continue
      if (used.has(before.id) || used.has(after.id) || used.has(cue.id)) continue
      const a = arcLine(before.text)
      const b = arcLine(raw, 120)
      const c = arcLine(after.text)
      if (!a || !b || !c || a === c) continue
      const gap = Date.parse(after.created_at) - Date.parse(before.created_at)
      if (!(gap >= 0) || gap > 30 * 60 * 1000) continue
      const changed = a.slice(0, 16) !== c.slice(0, 16) || Math.abs(a.length - c.length) >= Math.max(8, a.length * 0.3)
      if (!changed) continue
      used.add(before.id)
      used.add(cue.id)
      used.add(after.id)
      out.push({
        ref: 'arc:' + cue.id, at: cue.created_at, role: 'self', source: 'arc',
        text: `她先说：${a}\n主人顶：${b}\n她改成：${c}`,
        lines: [
          { role: 'assistant', text: a },
          { role: 'user', text: b },
          { role: 'assistant', text: c },
        ],
      })
    }
  }
  out.sort((x, y) => String(y.at || '').localeCompare(String(x.at || '')))
  return spreadFacts(out, max)
}

/**
 * 事件里的事实：只取当时真正说出口的原话，不要那条「你对我说…我对你说…」的概括。
 * 纪要的 summary 是两层东西缝起来的，引号后面那半才是原文；摘要本体（谁压过一遍）整段丢掉。
 * open_loops 本来就是没回答的原句，可以当事实用。
 */
export function collectEpisodeFacts(db, aid, now, days = 7) {
  const from = new Date(Date.parse(now) - days * DAY).toISOString().slice(0, 10)
  let rows = []
  try {
    rows = db.prepare(`SELECT id, day, summary, open_loops, created_at FROM episodes
      WHERE agent_id=? AND day>=? ORDER BY day ASC LIMIT 200`).all(aid, from)
  } catch { rows = [] }
  const out = []
  for (const r of rows) {
    const at = atOf(r.day, r.created_at)
    const summary = String(r.summary || '')
    const theirs = (summary.match(/你对我说：([\s\S]*?)(?=\s*我对你说：|$)/) || [])[1] || ''
    const mine = (summary.match(/我对你说：([\s\S]*)$/) || [])[1] || ''
    theirs.split(/[；;]/).forEach((part, i) => {
      const text = factLine(part)
      if (text) out.push({ ref: `ep:${r.id}:u${i}`, at, role: 'user', text, source: 'episode' })
    })
    const my = factLine(mine)
    if (my) out.push({ ref: `ep:${r.id}:a`, at, role: 'assistant', text: my, source: 'episode' })
    let loops = []
    try { loops = JSON.parse(r.open_loops || '[]') } catch { loops = [] }
    ;(Array.isArray(loops) ? loops : []).forEach((x, i) => {
      const text = factLine(typeof x === 'string' ? x : (x && (x.text || x.q)))
      if (text) out.push({ ref: `ep:${r.id}:q${i}`, at, role: 'user', text, source: 'episode' })
    })
  }
  return out
}

const DIARY_TIME = /(今天|昨天|昨晚|夜里|凌晨|早上|上午|下午|傍晚|晚上|刚才|后来|那天|当时|这次|周末|\d{1,2}[点时]|\d{4}-\d{2}-\d{2})/
const DIARY_ACT = /(说|问|回|给|做|跑|写|看|听|拿|放|吃|睡|坐|走|停|聊|陪|等|改|修|查|开|关|找|洗|抱|笑|哭|答应|拒绝|告诉|发|收|打开|合上)/
const DIARY_STANCE_ONLY = /^(我|她)?(好像|其实|可能|也许|就是|一直)?(更)?(想|要|喜欢|愿意|宁愿|宁可|看重|相信|希望|觉得)/

/** 日记里的句子是不是在说一件具体发生过的事，而不是一句态度。 */
export function looksLikeDiaryFact(text) {
  const t = String(text || '').trim()
  if (t.length < 8 || t.length > 120) return false
  if (!DIARY_ACT.test(t)) return false
  // 「我好像更想做一个…的人」这类是结论，不是事实；没有时间、没有引号就丢掉。
  if (DIARY_STANCE_ONLY.test(t) && !DIARY_TIME.test(t) && !/[「」“”]/.test(t)) return false
  return true
}

/** 日记里的事实句：剥掉日期行，按句号取；只留能对回具体动作的那几句。 */
export function collectDiaryFacts(db, aid, now, days = 7) {
  const from = new Date(Date.parse(now) - days * DAY).toISOString().slice(0, 10)
  let rows = []
  try {
    rows = db.prepare(`SELECT day, text, created_at FROM diaries
      WHERE agent_id=? AND day>=? ORDER BY day ASC LIMIT 30`).all(aid, from)
  } catch { rows = [] }
  const out = []
  for (const r of rows) {
    const at = atOf(r.day, r.created_at, 'T23:00:00.000Z')
    const body = String(r.text || '').replace(/^\s*\d{4}-\d{2}-\d{2}[^\n]*\n+/, '')
    const pieces = body.split(/[。！？!?…\n]+/).map((s) => s.trim()).filter(Boolean)
    pieces.forEach((s, i) => {
      if (!looksLikeDiaryFact(s)) return
      const text = factLine(s)
      if (text) out.push({ ref: `dry:${r.day}:${i}`, at, role: 'self', text, source: 'diary' })
    })
  }
  return out
}

const normFact = (t) => String(t || '').replace(/[\s\p{P}\p{S}]+/gu, '')

/** 三路事实合在一起（按时间排）：同一句只留一次，先收到的那一路留下。 */
export function mergeFacts(list) {
  const out = []
  const seen = []
  for (const f of list || []) {
    const p = normFact(f && f.text)
    if (!p) continue
    if (seen.some((s) => s === p || lexicalSim(p, s) >= 0.8)) continue
    seen.push(p)
    out.push(f)
  }
  out.sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')))
  return out
}

/**
 * 夜里归纳的取料入口：原话 + 事件原话 + 日记事实句。没有摘要也能跑。
 * 原话里她自己那些工程进展别把整周占满——先取对方说的；事件和日记各留固定几格，
 * 三列才不会都只剩一种料。
 */
export function collectAllFacts(db, aid, now, days) {
  const d = Number(days) > 0 ? Number(days) : 7
  // 弧优先：一件事怎么走下来的，比一句原话更能撑住一句道理。
  const arcs = collectArcs(db, aid, now, d, 12)
  const room = arcs.length > 0
  const rawAll = collectFacts(db, aid, now, d)
  const raw = spreadFacts([...rawAll.filter((f) => f.role === 'user'), ...rawAll.filter((f) => f.role !== 'user')], room ? 12 : 18)
  const ep = spreadFacts(collectEpisodeFacts(db, aid, now, d), room ? 8 : 10)
  const dry = spreadFacts(collectDiaryFacts(db, aid, now, d), room ? 6 : 8)
  return spreadFacts(mergeFacts([...arcs, ...raw, ...ep, ...dry]), 40)
}

/** 按天轮流取，免得忙的那一天把窗口占满。不合并句子。 */
export function spreadFacts(facts, max = 36) {
  const by = new Map()
  for (const f of facts) {
    const d = String(f.at || '').slice(0, 10)
    if (!by.has(d)) by.set(d, [])
    by.get(d).push(f)
  }
  const days = [...by.keys()].sort()
  const out = []
  let i = 0
  while (out.length < max) {
    let moved = false
    for (const d of days) {
      const bucket = by.get(d)
      if (bucket[i]) {
        out.push(bucket[i])
        moved = true
        if (out.length >= max) break
      }
    }
    if (!moved) break
    i++
  }
  return out
}

/** 这句话是不是把事实又说了一遍。像，就不是道理。 */
export function isRetelling(principle, facts) {
  const raw = String(principle || '').trim()
  const p = raw.replace(/\s+/g, '')
  if (!p || p.length > 80) return true
  if (NARRATIVE.test(raw)) return true
  for (const f of facts || []) {
    const lines = Array.isArray(f && f.lines) ? f.lines.map((x) => String((x && x.text) || '')) : []
    const texts = [...lines, String((f && f.text) || f || '')]
    for (const t of texts) {
      if (t && lexicalSim(p, t.replace(/\s+/g, '')) >= 0.62) return true
    }
  }
  return false
}

export function acceptPrinciples(items, facts) {
  const kept = []
  const dropped = []
  const seen = new Set()
  for (const it of items || []) {
    const principle = String((it && it.principle) || '').trim()
    const layer = it && ['W', 'L', 'V'].includes(it.layer) ? it.layer : ''
    const idxs = [...new Set((it && it.facts || []).map((n) => Number(n)))].filter((i) => facts[i])
    const cited = idxs.map((i) => facts[i])
    const days = new Set(cited.map((f) => String(f.at).slice(0, 10)))
    const drop = (reason) => dropped.push({ principle: principle.slice(0, 80), layer, reason })
    if (!layer || !principle) continue
    if (idxs.length < 2 || days.size < 2) { drop('facts_too_few'); continue }
    if (isRetelling(principle, cited)) { drop('retelling'); continue }
    if (seen.has(principle)) continue
    seen.add(principle)
    kept.push({
      principle, layer, facts: cited,
      expectation: it.expectation ? String(it.expectation).trim() : '',
      observe: it.observe ? String(it.observe).trim() : '',
      falsifier: it.falsifier ? String(it.falsifier).trim() : '',
      direction: it.direction ? String(it.direction).trim() : '',
      alt: it.alt ? String(it.alt).trim() : '',
      foregone: it.foregone ? String(it.foregone).trim() : '',
      exclusion: it.exclusion ? String(it.exclusion).trim() : '',
      cost_to: it.cost_to ? String(it.cost_to).trim() : '',
    })
  }
  return { items: kept, dropped }
}

/**
 * 一轮语料。opt.ask 可注入。两天里凑不出两条事实就不叫模型。
 * 返回 { facts, items, dropped, skipped }。skipped 为空表示模型跑过了，可以一条都没有。
 */
export async function buildCorpus(db, aid, now, opt = {}) {
  // 不再先读一条纪要/日记摘要再往下压：事实本身够两天的，就直接拿事实问。
  const facts = collectAllFacts(db, aid, now, opt.days)
  if (facts.length < 2) return { facts, items: [], dropped: [], skipped: 'no_material' }
  const day = String(opt.day || now).slice(0, 10)
  const ask = opt.ask || ((input) => call({ db, aid, day, at: now, chat: opt.chat }, 'J34', input))
  const r = await ask({ facts: facts.map((f, i) => ({ i, at: f.at, role: f.role, text: f.text })) })
  if (!r || !r.ok) {
    const why = r
      ? String(r.code || 'MODEL') + ':' + String(r.error || (r.errors ? JSON.stringify(r.errors) : '')).slice(0, 160)
        + (r.raw ? ' | raw=' + String(r.raw).replace(/\s+/g, ' ').slice(0, 160) : '')
      : 'NO_RESULT'
    return { facts, items: [], dropped: [], skipped: r && r.code === 'BUDGET' ? 'budget' : 'model', reason: why }
  }
  const acc = acceptPrinciples(r.out && r.out.items, facts)
  return { facts, ...acc, skipped: null, reason: null }
}

/** 价值观那几条道理进草稿，不进账。五闸不过的不落。 */
export function fileValuePrinciples(db, aid, now, corpus) {
  let created = 0
  let held = 0
  for (const c of (corpus && corpus.items || []).filter((x) => x.layer === 'V')) {
    const evidence = c.facts.map((f) => ({ at: String(f.at).slice(0, 10), quote: f.text, ref: f.ref }))
    const cluster = {
      kind: kindOfForegone(c.foregone),
      items: c.facts.map((f) => ({ at: f.at, ref: f.ref, trigger: f.text, foregone: c.foregone, alt: c.alt })),
    }
    const gates = gatesOf({
      text: c.principle, alt: c.alt, foregone: c.foregone, exclusion: c.exclusion, evidence,
    }, cluster, { source: 'llm' })
    if (!gates.pass) { held++; continue }
    const row = createDraft(db, aid, {
      text: c.principle, alt: c.alt, foregone: c.foregone, exclusion: c.exclusion, cost_to: c.cost_to,
      evidence, cluster, source: 'llm', batch_key: 'sg:corpus:' + String(now).slice(0, 10),
    }, { at: now })
    if (!row.duplicate) created++
  }
  return { created, held, episodes: (corpus && corpus.facts || []).length, errors: [], from: 'corpus' }
}
