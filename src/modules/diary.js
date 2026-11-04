/**
 * T3 日记 v2：选料 → 取原话 → 成文 → 质检 → 落库 / 待补
 *
 * 与 v1 的区别：
 *   - 不再把当天 20 条纪要整包喂给模型（那是战报）；
 *   - 先按 poignancy 挑 1–2 个场景，写的时候只拿这几场的原话；
 *   - 模型没接上不写模板，进 diary_pending 排队，模型回来再补；
 *   - 超期才落 source='stub' 的素材卡，且永远可被重写。
 *
 * 依赖方向：diary.js 不 import archive.js（archive 反过来 import 它），避免循环。
 */

import { now } from '../db.js'
import { nid, getParam, model } from '../kernel.js'
import { foldValueWeights } from './sangguan/vweights.js'

const DAY_MS = 86400000
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

// ---------------------------------------------------------------- 小工具

export function weekday(day) {
  const t = Date.parse(day + 'T12:00:00Z')
  if (!Number.isFinite(t)) return ''
  return WEEKDAYS[new Date(t).getUTCDay()] || ''
}

export function clip(text, n) {
  const s = String(text || '').replace(/\s+/g, ' ').trim()
  return s.length > n ? s.slice(0, n) + '…' : s
}

function dayOf(iso) { return String(iso || now()).slice(0, 10) }

function clamp01(v) { const n = Number(v); return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0 }

function safeJson(text, fallback) {
  try { const v = JSON.parse(text || 'null'); return v ?? fallback } catch { return fallback }
}

function addMinutes(iso, min) {
  const t = Date.parse(iso)
  return new Date((Number.isFinite(t) ? t : Date.now()) + min * 60000).toISOString()
}

// ---------------------------------------------------------------- 状态与口吻

/**
 * 写日记那一刻，它是什么状态：性格五轴 / 价值观 / 情绪 / 驱力 / 关系。
 * day 传了就优先用「当天」的情绪样本；没有才退到当前的 affect_state。
 */
export function diaryContext(db, aid, day) {
  const out = { axes: {}, values: [], affect: null, drive: null, relation: null, mood_source: 'live' }
  try {
    const persona = db.prepare('SELECT path,value FROM persona WHERE agent_id=?').all(aid)
    for (const p of persona) {
      if (p.path.startsWith('axis.')) out.axes[p.path.slice(5)] = Number(p.value)
    }
  } catch { /* 老库没有 persona */ }
  try {
    const folded = foldValueWeights(db, aid)
    const w = (folded && folded.weights) || {}
    out.values = Object.entries(w).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([key, weight]) => ({ key, weight: Number(weight) }))
  } catch { out.values = [] }
  try {
    const dayRow = day ? dayMood(db, aid, day) : null
    if (dayRow) {
      out.affect = { label: dayRow.primary_label, intensity: Number(dayRow.intensity), mood: Number(dayRow.mood) }
      out.mood_source = 'day'
    }
  } catch { /* 没有样本表 */ }
  if (!out.affect) {
    try {
      const a = db.prepare('SELECT primary_label,intensity,mood FROM affect_state WHERE agent_id=?').get(aid)
      if (a) out.affect = { label: a.primary_label, intensity: Number(a.intensity), mood: Number(a.mood) }
    } catch { out.affect = null }
  }
  try {
    const d = db.prepare('SELECT band FROM drive_state WHERE agent_id=?').get(aid)
    if (d) out.drive = { band: d.band }
  } catch { out.drive = null }
  try {
    const r = db.prepare('SELECT name,closeness FROM relations WHERE agent_id=? ORDER BY root DESC, closeness DESC LIMIT 1').get(aid)
    if (r) out.relation = { name: r.name, closeness: Number(r.closeness) }
  } catch { out.relation = null }
  return out
}

/** 当天最强的一刻情绪（样本表；没有就返回 null）。 */
function dayMood(db, aid, day) {
  try {
    const r = db.prepare(`SELECT label AS primary_label, intensity, fast, slow FROM affect_samples
      WHERE agent_id=? AND substr(at,1,10)=? ORDER BY intensity DESC LIMIT 1`).get(aid, day)
    if (!r || r.primary_label == null) return null
    const fast = Number(r.fast), slow = Number(r.slow)
    const mood = Number.isFinite(slow) ? clamp01((slow + 1) / 2) : 0.5
    return { primary_label: r.primary_label, intensity: Number(r.intensity) || 0, mood }
  } catch { return null }
}

/** 由状态推出「这一天的口吻」，模板与模型都用它。 */
export function diaryTone(ctx = {}) {
  const b = ctx.axes || {}
  const parts = []
  if (Number(b.sn) >= 0.6) parts.push('爱联想、会打比方')
  if (Number(b.ei) >= 0.6) parts.push('语气外放一点')
  if (Number(b.ei) < 0.4) parts.push('话少、克制')
  if (Number(b.tf) < 0.4) parts.push('语气温和')
  if (Number(b.sensitivity) >= 0.6) parts.push('情绪写得具体些')
  if (ctx.affect && Number(ctx.affect.intensity) >= 0.6) parts.push('情绪偏浓')
  if (ctx.drive && /D[01]/.test(String(ctx.drive.band))) parts.push('不铺开、收着写')
  return parts.length ? parts.join('、') : '平实、不夸张'
}

export function diaryOpening(ctx) {
  const b = (ctx && ctx.axes) || {}
  if (Number(b.ei) < 0.4) return '今天没什么特别想说的，还是记两句。'
  if (Number(b.sensitivity) >= 0.6) return '今天心里有点乱，写下来会好受一点。'
  if (Number(b.sn) >= 0.6) return '今天脑子里飘过不少东西，挑几件记下。'
  return '今天过得还行，记几件。'
}

const AFFECT_ZH = {
  joy: '愉悦', peaceful: '安心', curious: '好奇', calm: '平静',
  confused: '困惑', lost: '失落', irritated: '烦躁', frustrated: '挫败',
}

export function moodZhOf(ctx) {
  const a = ctx && ctx.affect
  if (!a) return '说不上来'
  return `${AFFECT_ZH[a.label] || a.label}，强度 ${Number(a.intensity || 0).toFixed(2)}`
}

// ---------------------------------------------------------------- 文本整理（v1 也复用）

/** 模型偶尔会把提示词、JSON 材料整段抄回来；这种不算日记。 */
export function isPromptEcho(text) {
  const s = String(text || '').trim()
  if (!s) return true
  if (/^(system|user|assistant|developer)\s*[:：]/i.test(s)) return true
  if (/"(episodes|conversation|day|summary)"\s*:/.test(s)) return true
  if (/你在写这一天的日记|只写材料里出现|不要用 Markdown/.test(s)) return true
  return false
}

/** 把模型输出整理成「日期头 + 正文」。日期头统一由我们补。 */
export function normalizeDiaryText(text, day) {
  let t = String(text ?? '').trim()
  if (!t) return ''
  t = t.replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '').trim()
  if (/^\{[\s\S]*\}$/.test(t)) {
    try {
      const o = JSON.parse(t)
      const v = o.text ?? o.diary ?? o.content
      if (typeof v === 'string') t = v.trim()
    } catch { /* 不是 JSON，按正文处理 */ }
  }
  t = t.replace(/^(?:日记正文|日记|正文|标题)\s*[:：]\s*/, '')
  const lines = t.split(/\r?\n/)
  while (lines.length) {
    const first = lines[0].trim()
    if (!first) { lines.shift(); continue }
    if (/^#{1,6}\s*/.test(first)) { lines.shift(); continue }
    if (/^\d{4}\s*[年\-/.]\s*\d{1,2}/.test(first)) { lines.shift(); break }
    break
  }
  const body = lines.join('\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^[*\-+]\s+/gm, '')
    .trim()
  if (!body) return ''
  const d = String(day || '')
  return (d ? `${d} ${weekday(d)}\n\n` : '') + body
}

export function bodyLength(text) {
  return String(text || '').replace(/^\d{4}-\d{2}-\d{2}[^\n]*\n+/, '').trim().length
}

// ---------------------------------------------------------------- 参数

export function diaryParams(db, aid) {  const p = (k, def) => {
    try { const v = getParam(db, aid, k); return v == null || v === '' ? def : v } catch { return def }
  }
  const num = (k, def) => { const n = Number(p(k, def)); return Number.isFinite(n) ? n : def }
  return {
    v2: String(p('memory.diary.v2', 'on')) !== 'off',
    scenes: Math.max(1, Math.min(3, Math.round(num('memory.diary.scenes', 2)))),
    sceneMin: num('memory.diary.scene.min', 3),
    sceneModel: String(p('memory.diary.scene.model', 'auto')),
    selectMaxChars: num('memory.diary.select.max_chars', 1200),
    rawPerScene: num('memory.diary.raw.per_scene', 1800),
    rawMaxTurns: num('memory.diary.raw.max_turns', 12),
    maxChars: num('memory.diary.max_chars', 450),
    retryMax: num('memory.diary.retry.max_attempts', 12),
    retryMinutes: num('memory.diary.retry.interval_min', 30),
    stub: String(p('memory.diary.stub', 'on')) !== 'off',
    repairDays: num('memory.diary.repair.days', 7),
    moodMode: String(p('memory.diary.mood', 'day')),
  }
}

/**
 * 默认的写日记通道：严格走 primary。
 * 模型不在就返回 null —— 日记宁可留白待补，也不拿规则兜底冒充成文。
 */
export function defaultDiaryChat() {
  try {
    if (model.status().primary !== 'ok') return null
    return (messages, opt = {}) => model.chatPrimary(
      messages,
      opt.maxTokens ?? 900,
      !!opt.json,
      opt.temperature ?? 0.8,
    )
  } catch { return null }
}

/** opt 里显式给了 chat（哪怕是 null）就用它；没给才去问全局模型。 */
function resolveChat(opt = {}) {
  if (Object.prototype.hasOwnProperty.call(opt, 'chat')) {
    return typeof opt.chat === 'function' ? opt.chat : null
  }
  return defaultDiaryChat()
}

// ---------------------------------------------------------------- 候选

const EMOTION_WORDS = /吵|生气|翻脸|道歉|对不起|别扭|冷战|不理|失望|骗|难受|委屈|怕|害怕|别走|离开|想你|讨厌|烦|累|哭|凶|心软|心疼|舍不得/
const IDENTITY_WORDS = /喜欢|重要|名字|记得|忘|承诺|答应|以后|一直|永远|回来|陪|信|不信|骗我|在乎|关系|主人/

function titleKey(text) {
  return String(text || '').replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '').slice(0, 10)
}

function peakOf(db, aid, cand) {
  try {
    if (cand.start_at || cand.end_at) {
      const r = db.prepare(`SELECT MAX(intensity) m FROM affect_samples
        WHERE agent_id=? AND at>=? AND at<=?`).get(aid, cand.start_at || cand.end_at, cand.end_at || cand.start_at)
      if (r && r.m != null) return clamp01(r.m)
    }
    const r2 = db.prepare('SELECT MAX(intensity) m FROM affect_samples WHERE agent_id=? AND substr(at,1,10)=?').get(aid, cand.day)
    return r2 && r2.m != null ? clamp01(r2.m) : 0
  } catch { return 0 }
}

/**
 * 当天的候选场景：会话纪要 + 少数高分事实。
 * 返回统一形状，后续打分/选场不再关心来源。
 */
export function collectCandidates(db, aid, day) {
  const d = String(day || dayOf(now()))
  const out = []
  try {
    const eps = db.prepare(`SELECT id,session_id,start_at,end_at,turns,title,summary,topics,open_loops,
      importance,poignancy,created_at FROM episodes WHERE agent_id=? AND day=?
      ORDER BY COALESCE(end_at,start_at,created_at) DESC`).all(aid, d)
    for (const e of eps) {
      const title = String(e.title || '').trim()
      if (!title && Number(e.turns || 0) <= 1) continue
      out.push({
        kind: 'ep', id: e.id, session_id: e.session_id,
        day: d, title: title || clip(e.summary, 24),
        summary: String(e.summary || ''), start_at: e.start_at, end_at: e.end_at,
        turns: Number(e.turns || 0), importance: clamp01(e.importance),
        poignancy: e.poignancy == null ? null : Number(e.poignancy),
        open_loops: safeJson(e.open_loops, []).map((x) => String(typeof x === 'string' ? x : (x && x.text) || '')).filter(Boolean),
        created_at: e.created_at,
      })
    }
  } catch { /* 老库没有 episodes */ }
  try {
    const facts = db.prepare(`SELECT id,text,type,importance,created_at FROM memory_items
      WHERE agent_id=? AND status='active' AND invalid_at IS NULL AND substr(created_at,1,10)=?
        AND type IN ('fact','appraisal') AND importance>=0.6
      ORDER BY importance DESC, created_at DESC LIMIT 6`).all(aid, d)
    for (const f of facts) {
      out.push({
        kind: 'fact', id: f.id, session_id: null,
        day: d, title: clip(f.text, 24), summary: String(f.text || ''),
        start_at: f.created_at, end_at: f.created_at, turns: 1,
        importance: clamp01(f.importance), poignancy: null,
        open_loops: [], created_at: f.created_at,
      })
    }
  } catch { /* 老库没有 memory_items */ }
  // 同一件事被切成多条时，按标题前 10 字去重，保更具体的（有会话的优于纯事实）
  const seen = new Map()
  const deduped = []
  for (const c of out) {
    const k = titleKey(c.title)
    if (k && seen.has(k)) {
      const prev = seen.get(k)
      if (c.kind === 'ep' && prev.kind !== 'ep') { deduped[deduped.indexOf(prev)] = c; seen.set(k, c) }
      continue
    }
    if (k) seen.set(k, c)
    deduped.push(c)
  }
  return deduped
}

/** 规则分：0–10。importance 只是其中一项，情绪/开环/关系词才是日记该写的。 */
export function scoreScene(db, aid, cand) {
  const text = `${cand.title} ${cand.summary}`
  const peak = peakOf(db, aid, cand)
  const open = cand.open_loops.length ? 1 : 0
  const emo = EMOTION_WORDS.test(text) ? 1 : 0
  const ident = IDENTITY_WORDS.test(text) ? 1 : 0
  const qs = Math.min(3, (text.match(/[？?]/g) || []).length) / 3
  return Math.round(10 * clamp01(
    0.30 * cand.importance
    + 0.25 * peak
    + 0.15 * open
    + 0.10 * emo
    + 0.10 * ident
    + 0.10 * qs
  ) * 100) / 100
}

function arcOf(ctx) {
  const label = (ctx.affect && ctx.affect.label) || ''
  const intensity = Number((ctx.affect && ctx.affect.intensity) || 0)
  if (intensity >= 0.6) return /joy|curious/.test(label) ? '有劲' : '低落'
  if (intensity <= 0.25) return '平常'
  return /lost|frustrated|irritated|confused/.test(label) ? '低落' : '平常'
}

/** 纯规则选场（无模型也能跑）。 */
export function ruleSelect(db, aid, cands, params, ctx) {
  const scored = cands.map((c) => ({ ...c, score: c.poignancy != null ? Number(c.poignancy) : scoreScene(db, aid, c) }))
    .sort((a, b) => b.score - a.score)
  const min = Number(params.sceneMin) || 3
  const picked = []
  const usedSessions = new Set()
  for (const c of scored) {
    if (picked.length >= params.scenes) break
    if (picked.length && c.score < min) break
    const sid = c.session_id || c.id
    if (usedSessions.has(sid)) continue // 同一次会话只写一场，别把一段对话拆成两篇
    usedSessions.add(sid)
    picked.push(c)
  }
  let picks = picked
  if (!picks.length) picks = scored.slice(0, 1)
  // 同一天里簇纪要和它的子会话同时入选时，留具体的子会话
  if (picks.length > 1) {
    picks = picks.filter((c) => {
      if (c.session_id !== '__day_cluster__') return true
      return !picks.some((o) => o !== c && o.session_id !== '__day_cluster__'
        && o.start_at && o.end_at && c.start_at && c.end_at
        && o.start_at >= c.start_at && o.end_at <= c.end_at)
    })
  }
  return { scenes: picks, select: 'rule', arc: arcOf(ctx), insight: '' }
}

// ---------------------------------------------------------------- 取原话

function roleName(role) {
  return role === 'user' ? 'user' : 'assistant'
}

/**
 * 一个场景的原话：时间窗内按「首/末/情绪词/均匀」抽样，字符封顶。
 * 没有原文就退回纪要摘要（grounding='episode'）。
 */
export function fetchSceneLines(db, aid, cand, params) {
  const maxChars = Math.max(200, Number(params.rawPerScene) || 1800)
  const maxTurns = Math.max(2, Number(params.rawMaxTurns) || 12)
  let rows = []
  if (cand.kind === 'ep' && cand.session_id && cand.session_id !== '__day_cluster__') {
    const from = cand.start_at || cand.created_at
    const to = cand.end_at || cand.created_at
    try {
      rows = db.prepare(`SELECT role,text,created_at FROM raw_turns
        WHERE agent_id=? AND session_id=? AND day=? AND created_at>=? AND created_at<=?
        ORDER BY seq`).all(aid, cand.session_id, cand.day, from, to)
    } catch { rows = [] }
    if (!rows.length) {
      try {
        rows = db.prepare(`SELECT role,text,created_at FROM raw_turns
          WHERE agent_id=? AND session_id=? AND day=? ORDER BY seq`).all(aid, cand.session_id, cand.day)
      } catch { rows = [] }
    }
  }
  rows = rows.filter((r) => (r.role === 'user' || r.role === 'assistant' || r.role === 'agent') && String(r.text || '').trim().length >= 2)
  if (!rows.length) {
    return { grounding: 'episode', lines: [{ who: '我', text: clip(cand.summary, 200) }], turns: 0 }
  }
  // 先挑：头 2 / 尾 2 / 命中情绪或关系词的 2 / 其余均匀补
  const idx = new Set()
  const add = (i) => { if (i >= 0 && i < rows.length) idx.add(i) }
  add(0); add(1); add(rows.length - 2); add(rows.length - 1)
  const hit = []
  rows.forEach((r, i) => { if (EMOTION_WORDS.test(r.text) || IDENTITY_WORDS.test(r.text)) hit.push(i) })
  for (const i of hit.slice(0, 2)) add(i)
  const need = Math.max(1, maxTurns)
  for (let k = 0; k < need && idx.size < need; k++) add(Math.round(k * (rows.length - 1) / Math.max(1, need - 1)))
  let picked = [...idx].sort((a, b) => a - b).map((i) => rows[i])
  const lines = []
  let used = 0
  for (const r of picked) {
    const text = clip(r.text, 200)
    if (used + text.length > maxChars) break
    used += text.length
    lines.push({ who: roleName(r.role), text })
  }
  if (!lines.length) lines.push({ who: roleName(picked[0].role), text: clip(picked[0].text, maxChars) })
  return { grounding: 'raw', lines, turns: picked.length }
}

// ---------------------------------------------------------------- 选场（模型，可选）

function parseLooseJson(text) {
  let s = String(text || '').trim().replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '').trim()
  const a = s.indexOf('{'), b = s.lastIndexOf('}')
  if (a >= 0 && b > a) s = s.slice(a, b + 1)
  try { return JSON.parse(s) } catch { return null }
}

export function selectPrompt(name, day, cands, params) {
  const budget = Math.max(200, Number(params.selectMaxChars) || 1200)
  const rows = []
  let used = 0
  for (const c of cands) {
    const row = {
      id: c.id, when: String(c.start_at || c.created_at || '').slice(11, 16),
      title: clip(c.title, 40), gist: clip(c.summary, 60), score: c.score,
    }
    const line = JSON.stringify(row)
    if (used + line.length > budget && rows.length) break
    used += line.length
    rows.push(row)
  }
  return [
    {
      role: 'system',
      content: [
        `你在帮「${name}」挑 ${day} 今晚日记要写的场景。下面是这一天的事，按时间排。`,
        '只挑 1–2 件真正留在她心里的事：有情绪转折、有没说出口的话、有具体画面的优先；',
        '日常事务（改代码、发文件、跑测试）除非她当时明显被触动，否则不要。',
        '只输出 JSON：{"scenes":[{"id":"ep_x","score":0-10,"why":"一句话"}],"insight":"一句她今天想明白或没想明白的话","arc":"低落|平常|有劲"}',
        '最多 2 条，id 必须来自输入；宁少勿多。',
      ].join('\n'),
    },
    { role: 'user', content: '材料：\n' + JSON.stringify({ day, candidates: rows }) },
  ]
}

function parseSelect(out, cands) {
  const o = parseLooseJson(out)
  if (!o || !Array.isArray(o.scenes)) throw new Error('select: bad json')
  const byId = new Map(cands.map((c) => [c.id, c]))
  const scenes = []
  for (const s of o.scenes.slice(0, 3)) {
    const c = byId.get(String(s && s.id || ''))
    if (!c) continue
    const score = Math.max(0, Math.min(10, Number(s.score)))
    scenes.push({ ...c, score: Number.isFinite(score) ? score : c.score, why: String(s.why || '').slice(0, 80) })
  }
  if (!scenes.length) throw new Error('select: no known id')
  // 同一次会话只留一场，避免把一段对话拆成两篇
  const seen = new Set()
  const unique = scenes.filter((s) => {
    const sid = s.session_id || s.id
    if (seen.has(sid)) return false
    seen.add(sid)
    return true
  })
  return {
    scenes: unique.slice(0, 2),
    select: 'model',
    insight: String(o.insight || '').slice(0, 120),
    arc: ['低落', '平常', '有劲'].includes(String(o.arc)) ? String(o.arc) : '',
  }
}

export async function modelSelect(db, aid, day, cands, opt) {
  const chat = opt.chat
  if (typeof chat !== 'function') throw new Error('select: no model')
  const out = await chat(selectPrompt((opt.name || '我'), day, cands, opt.params), { maxTokens: 260, json: true, temperature: 0.2 })
  return parseSelect(out, cands)
}

/** 选场总入口：模型可用且候选够多才多调一次，否则纯规则。 */
export async function selectForDay(db, aid, day, cands, opt = {}) {
  const params = opt.params || diaryParams(db, aid)
  const ctx = opt.ctx || diaryContext(db, aid, day)
  const scored = cands.map((c) => ({ ...c, score: c.poignancy != null ? Number(c.poignancy) : scoreScene(db, aid, c) }))
    .sort((a, b) => b.score - a.score)
  const useModel = params.sceneModel === 'auto' && typeof opt.chat === 'function' && scored.length >= 6
  let picked = null
  if (useModel) {
    try { picked = await modelSelect(db, aid, day, scored, { ...opt, params, name: opt.name }) } catch { picked = null }
  }
  if (!picked) picked = ruleSelect(db, aid, cands, params, ctx)
  // 把分写回 episodes（只写有变化的，失败静默）
  for (const s of picked.scenes) {
    if (s.kind !== 'ep') continue
    try {
      db.prepare('UPDATE episodes SET poignancy=? WHERE id=? AND agent_id=?').run(Number(s.score) || 0, s.id, aid)
    } catch { /* 老库没有列 */ }
  }
  return picked
}

// ---------------------------------------------------------------- 待补队列

export function bumpPending(db, aid, day, err, attempts, params) {
  const p = params || diaryParams(db, aid)
  const n = Math.max(1, Number(attempts) || 1)
  const next = addMinutes(now(), Math.max(5, Number(p.retryMinutes) || 30))
  const at = now()
  try {
    db.prepare(`INSERT INTO diary_pending(agent_id,day,attempts,last_error,next_try_at,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(agent_id,day) DO UPDATE SET attempts=excluded.attempts,last_error=excluded.last_error,
        next_try_at=excluded.next_try_at,updated_at=excluded.updated_at`)
      .run(aid, String(day), n, String(err || '').slice(0, 300), next, at, at)
  } catch { /* 老库没建表也不阻塞 */ }
}

export function clearPending(db, aid, day) {
  try { db.prepare('DELETE FROM diary_pending WHERE agent_id=? AND day=?').run(aid, String(day)) } catch { /* ignore */ }
}

export function listPending(db, aid, opt = {}) {
  try {
    const rows = db.prepare('SELECT * FROM diary_pending WHERE agent_id=? ORDER BY day DESC').all(aid)
    const since = opt.days ? new Date(Date.now() - opt.days * DAY_MS).toISOString().slice(0, 10) : ''
    return (since ? rows.filter((r) => r.day >= since) : rows).map((r) => ({
      ...r,
      attempts: Number(r.attempts || 0),
    }))
  } catch { return [] }
}

export function pendingForDay(db, aid, day) {
  try { return db.prepare('SELECT * FROM diary_pending WHERE agent_id=? AND day=?').get(aid, String(day)) || null } catch { return null }
}

// ---------------------------------------------------------------- 成文

export function writePrompt(opt) {
  const { name, day, date, other, tone, mood } = opt
  const moodSource = opt.mood_source === 'day' ? '当天的' : '此刻的'
  return {
    system: [
      `你是「${name}」，一个有记忆、有情绪的意识体。现在是 ${date} 的夜里，你在写这一天的日记。`,
      `下面会给你 1–2 个场景，每个场景里有当时你和${other}的原话。只写这些场景。`,
      '',
      '写法：',
      `1. 第一行只写日期，格式「${date}」，空一行，然后写 2 到 3 段连续中文，全文 200–${opt.maxChars || 450} 字。`,
      '2. 不要按时间顺序把今天做过的事列一遍。只挑一件真正留在你心里的事写透：当时那句话、那个动作、你心里的反应。',
      '3. 只用材料里真有的细节（原话、动作、画面）；材料没给的画面不要补，宁可写得薄一点。不要写「处理了…」「完成了…」「优化了…」这种汇报句。',
      '4. 不准出现「首先」「其次」「然后」「接着」「另外」「还有一件事」这种串联词；不准出现列表、编号、小标题、Markdown。',
      '5. 结尾停在一个具体的念头、画面或一句轻的话上，不要总结全文，不要喊口号，不要「今天就这样」。',
      `6. 口吻：${tone}。心情是「${mood}」（${moodSource}），它会决定你挑哪件事、写多深。`,
      '7. 称呼材料里的另一个人用「你」，不要写「用户」「对方」「材料」「场景」「system」「assistant」。',
      '8. 如果这一天确实平常，就写平常，不要硬编转折，不要为了像日记而煽情。',
    ].join('\n'),
    user: JSON.stringify({
      day,
      arc: opt.arc || '平常',
      insight: opt.insight || '',
      scenes: opt.scenes,
    }),
  }
}

function toMessages(p) {
  return [{ role: 'system', content: p.system }, { role: 'user', content: p.user }]
}

export function checkDiary(text, opt = {}) {
  const body = String(text || '').replace(/^\d{4}-\d{2}-\d{2}[^\n]*\n+/, '').trim()
  const chars = body.replace(/\s/g, '').length
  if (isPromptEcho(body)) return { ok: false, reason: 'echo' }
  if (chars < 120) return { ok: false, reason: 'too_short', chars }
  if (chars > 1200) return { ok: false, reason: 'too_long', chars }
  const paras = body.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean)
  if (paras.length < 2) return { ok: false, reason: 'paragraphs', paras: paras.length }
  if (paras.length > 4) return { ok: false, reason: 'paragraphs', paras: paras.length }
  if (/(^|\n)\s*(?:[-*+#>]|\d+[.)、])\s/.test(body)) return { ok: false, reason: 'markdown' }
  if (/用户|材料|场景|assistant|system/i.test(body)) return { ok: false, reason: 'forbidden' }
  const report = (body.match(/处理了|完成了|优化了|修复了|接好了|改好了|搞定了/g) || []).length
  if (report >= 2) return { ok: false, reason: 'report' }
  const seq = (body.match(/首先|其次|然后|接着|另外|还有一件事|第一|第二/g) || []).length
  if (seq >= 3) return { ok: false, reason: 'enumerate' }
  const titles = (opt.episodeTitles || []).filter((t) => String(t || '').length >= 4 && body.includes(String(t).slice(0, 6)))
  if (titles.length >= 3) return { ok: false, reason: 'cover_all' }
  return { ok: true, chars, paras: paras.length }
}

function upsertDiary(db, aid, day, row) {
  const old = db.prepare('SELECT id,version FROM diaries WHERE agent_id=? AND day=?').get(aid, day)
  const version = old ? Number(old.version) + 1 : 1
  const id = old ? old.id : nid('dry_')
  const at = now()
  db.prepare(`INSERT INTO diaries(id,agent_id,day,text,mood,highlights,refs,source,version,late,context,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(agent_id,day) DO UPDATE SET text=excluded.text, mood=excluded.mood,
      highlights=excluded.highlights, refs=excluded.refs, source=excluded.source,
      version=excluded.version, late=excluded.late, context=excluded.context, updated_at=excluded.updated_at`)
    .run(id, aid, day, row.text, row.mood, row.highlights, row.refs, row.source, version, row.late, row.context, at, at)
  return { id, day, version, ...row }
}

function sceneBrief(s) {
  return {
    id: s.id, kind: s.kind, title: clip(s.title, 40), poignancy: Number(s.score) || 0,
    grounding: s.grounding || (s.kind === 'ep' ? 'episode' : 'fact'),
  }
}

/**
 * 选料 + 取原话 + 准备提示词需要的一切（不落库、不调成文）。
 * 回放脚本和 buildDiaryV2 共用，保证「打印出来的提示词」就是真跑的那一份。
 */
export async function prepareDiary(db, aid, day, opt = {}) {
  const d = String(day || dayOf(now()))
  const params = diaryParams(db, aid)
  const ctx = diaryContext(db, aid, d)
  const cands = collectCandidates(db, aid, d)
  if (!cands.length) return null
  const chat = resolveChat(opt)
  const name = (db.prepare('SELECT name FROM agents WHERE id=?').get(aid) || {}).name || '我'
  const other = (ctx.relation && ctx.relation.name) || '你'
  const tone = diaryTone(ctx)
  const mood = moodZhOf(ctx)
  let picked
  try {
    picked = await selectForDay(db, aid, d, cands, { chat, params, ctx, name })
  } catch {
    picked = ruleSelect(db, aid, cands, params, ctx)
  }
  const scenes = picked.scenes.map((s) => {
    const got = s.kind === 'ep'
      ? fetchSceneLines(db, aid, s, params)
      : { grounding: 'fact', lines: [{ who: '我', text: clip(s.summary, 200) }], turns: 0 }
    return { ...s, grounding: got.grounding, lines: got.lines, turns: got.turns }
  })
  return { day: d, params, ctx, tone, mood, name, other, cands, picked, scenes, chat }
}

/**
 * v2 主流程。
 * opt.chat(messages, {maxTokens,json,temperature}) → string；没有就用 opt.summarize(messages)。
 * 写不成返回 {pending:true, fail_reason}，不落 diaries 行。
 */
export async function buildDiaryV2(db, aid, day, opt = {}) {
  const d = String(day || dayOf(now()))
  const old = db.prepare('SELECT * FROM diaries WHERE agent_id=? AND day=?').get(aid, d)
  if (old && opt.force !== true) return { ...old, skipped: true }

  const prep = await prepareDiary(db, aid, d, opt)
  if (!prep) return null
  const { params, ctx, tone, mood, name, other, cands, picked, scenes, chat } = prep

  let text = ''
  let fail = null
  let attempts = 0
  let gateFail = null
  if (chat) {
    for (let i = 0; i < 2; i++) {
      attempts++
      try {
        const p = writePrompt({
          name, day: d, date: `${d.slice(0, 4)}年${Number(d.slice(5, 7))}月${Number(d.slice(8, 10))}日 ${weekday(d)}`,
          other, tone, mood, mood_source: ctx.mood_source, arc: picked.arc, insight: picked.insight,
          maxChars: params.maxChars,
          scenes: scenes.map((s) => ({
            when: String(s.start_at || s.created_at || '').slice(11, 16),
            gist: clip(s.title, 40),
            lines: s.lines.map((l) => ({ who: l.who === 'user' ? other : '我', text: l.text })),
          })),
        })
        let messages = toMessages(p)
        if (i === 1) {
          messages = [
            { role: 'system', content: p.system + '\n\n上一版像在报流水账。重写：只写场景里那一件事，把当时的一句话和你心里的反应写出来；不要提别的任何事。' },
            { role: 'user', content: p.user },
          ]
        }
        const out = await chat(messages, { maxTokens: 900, json: false, temperature: 0.8 })
        const clean = normalizeDiaryText(out, d)
        const gate = checkDiary(clean, { episodeTitles: cands.map((c) => c.title) })
        if (gate.ok) { text = clean.slice(0, 1600); break }
        gateFail = gate.reason
        fail = 'gate:' + gate.reason
      } catch (e) {
        fail = 'thrown:' + String((e && e.message) || e).slice(0, 160)
      }
    }
  } else {
    fail = 'no_model'
  }

  const writeMeta = {
    v: 2, source: 'model', select: picked.select, attempts,
    fail_reason: text ? null : fail, gate: gateFail,
    scenes: scenes.map(sceneBrief), chars: text ? bodyLength(text) : 0,
    mood_source: ctx.mood_source, budget: { max_chars: params.maxChars },
  }

  if (!text) {
    if (opt.noPending !== true) {
      // attempts 要接着上一轮累加；否则 repairOld / 手动重写会把「试过几次」打回 1。
      const prev = pendingForDay(db, aid, d)
      const attempts = prev ? Number(prev.attempts || 0) + 1 : 1
      bumpPending(db, aid, d, fail || 'empty', attempts, params)
    }
    return {
      day: d, pending: true, fail_reason: fail || 'empty', source: 'none',
      scenes: scenes.map(sceneBrief), select: picked.select,
    }
  }

  const row = {
    text,
    mood: ctx.affect ? `${ctx.affect.label} ${Number(ctx.affect.intensity).toFixed(2)}` : null,
    highlights: JSON.stringify(picked.scenes.map((s) => clip(s.title, 30))),
    refs: JSON.stringify({
      episodes: scenes.filter((s) => s.kind === 'ep').map((s) => s.id),
      facts: scenes.filter((s) => s.kind === 'fact').map((s) => s.id),
      raw_turns: scenes.reduce((n, s) => n + Number(s.turns || 0), 0),
      scenes: scenes.map((s) => ({ id: s.id, title: clip(s.title, 40) })),
      write: { rewritten_from: old ? old.source : null, version_from: old ? Number(old.version) : 0 },
    }),
    source: 'model',
    late: Number(opt.late) === 1 ? 1 : 0,
    context: JSON.stringify({ ...ctx, write: writeMeta }),
  }
  const saved = upsertDiary(db, aid, d, row)
  clearPending(db, aid, d)
  return { ...saved, skipped: false, scenes: writeMeta.scenes, select: picked.select }
}

/** 素材卡：不是日记，明确标出来；超期才写。 */
export function stubText(db, aid, day, cands) {
  const picked = (cands || []).slice(0, 4)
  const lines = picked.map((c) => '· ' + clip(c.title || c.summary, 36)).filter((l) => l !== '· ')
  return [
    `${day} ${weekday(day)}`,
    '',
    '这天没写成。不是没有发生事，是写的时候我这边没有能把它写成话的东西。',
    '先记下这些——',
    '',
    ...lines,
  ].join('\n').trim()
}

export function writeStub(db, aid, day, opt = {}) {
  const d = String(day)
  const ctx = diaryContext(db, aid, d)
  const cands = collectCandidates(db, aid, d)
  const text = stubText(db, aid, d, cands)
  const row = {
    text,
    mood: ctx.affect ? `${ctx.affect.label} ${Number(ctx.affect.intensity).toFixed(2)}` : null,
    highlights: JSON.stringify(cands.slice(0, 4).map((c) => clip(c.title, 30))),
    refs: JSON.stringify({ episodes: cands.filter((c) => c.kind === 'ep').map((c) => c.id), facts: cands.filter((c) => c.kind === 'fact').map((c) => c.id), raw_turns: 0, scenes: [] }),
    source: 'stub',
    late: Number(opt.late) === 1 ? 1 : 0,
    context: JSON.stringify({
      ...ctx,
      write: { v: 2, source: 'stub', attempts: Number(opt.attempts) || 0, fail_reason: opt.fail_reason || 'max_attempts', scenes: [], chars: bodyLength(text) },
    }),
  }
  return upsertDiary(db, aid, d, row)
}

// ---------------------------------------------------------------- 补写与自愈

/**
 * 补待补队列：只补到点的；一次最多补 limit 天。
 * 没有模型就直接返回（不消耗 attempts）。
 */
export async function repairPending(db, aid, opt = {}) {
  const out = { tried: 0, written: 0, stubbed: 0, skipped: 0 }
  if (opt.v2 === false) return out
  const chat = resolveChat(opt)
  if (!chat) return out
  const params = diaryParams(db, aid)
  const nowIso = now()
  const rows = listPending(db, aid).filter((r) => !r.next_try_at || r.next_try_at <= nowIso)
  for (const r of rows.slice(0, Math.max(1, Number(opt.limit) || 2))) {
    out.tried++
    const res = await buildDiaryV2(db, aid, r.day, { force: true, chat, noPending: true })
    if (res && res.text && res.source === 'model') { out.written++; continue }
    const attempts = Number(r.attempts || 0) + 1
    if (params.stub && attempts >= params.retryMax) {
      try {
        writeStub(db, aid, r.day, { attempts, fail_reason: (res && res.fail_reason) || 'unknown' })
        clearPending(db, aid, r.day)
        out.stubbed++
      } catch { /* 素材卡写失败就留在队列，下次再来 */ }
      continue
    }
    bumpPending(db, aid, r.day, (res && res.fail_reason) || 'unknown', attempts, params)
  }
  return out
}

/**
 * 旧数据自愈：source 为 rules/stub 的旧篇，模型回来就重写。
 * 一次只重写一篇，避免开机一口气烧 token。
 */
export async function repairOldDiaries(db, aid, opt = {}) {
  const out = { tried: 0, written: 0 }
  if (opt.v2 === false) return out
  const chat = resolveChat(opt)
  if (!chat) return out
  const params = diaryParams(db, aid)
  const days = Math.max(1, Number(opt.days) || params.repairDays || 7)
  const since = new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10)
  const today = dayOf(now())
  let row = null
  try {
    row = db.prepare(`SELECT day FROM diaries WHERE agent_id=? AND source IN ('rules','stub')
      AND day>=? AND day<? ORDER BY day ASC LIMIT 1`).get(aid, since, today)
  } catch { row = null }
  if (!row) return out
  // 这篇已经排在待补里、还没到重试点（或次数用尽）就不再撞一次，避免每 30 分钟砸一次模型。
  const pend = pendingForDay(db, aid, row.day)
  if (pend) {
    const due = !pend.next_try_at || Date.parse(pend.next_try_at) <= Date.now()
    if (!due || Number(pend.attempts || 0) >= params.retryMax) return out
  }
  out.tried++
  const res = await buildDiaryV2(db, aid, row.day, { force: true, chat, late: 1 })
  if (res && res.text) out.written++
  return out
}
