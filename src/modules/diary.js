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

import { now, localDay, localDayBounds } from '../db.js'
import { nid, getParam, model } from '../kernel.js'
import { foldValueWeights } from './sangguan/vweights.js'
import { feelIdsOnDay } from './feel.js'
import { setEpisodePoignancy } from './episode_fields.js'
import { llmBudgetBump, llmDiaryAllow } from './llm_budget.js'

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
    .replace(/^\s*#{1,6}\s*/gm, '')
    .replace(/^[*\-+]\s+/gm, '')
    .trim()
  if (!body) return ''
  const d = String(day || '')
  return (d ? `${d} ${weekday(d)}\n\n` : '') + body
}

export function bodyLength(text) {
  return String(text || '').replace(/^\d{4}-\d{2}-\d{2}[^\n]*\n+/, '').trim().length
}

/**
 * 这篇里的引号话，材料里能不能逐字找到。
 *
 * 日记最容易出的偏差：把「我的感觉」写成「他说过的话」。这里只做最便宜的一步——
 * 引号内容（去空白）前 12 个字必须在材料原文里出现；找不到就标出来，第一版打回重写时带上原因。
 * 不是判真伪，只是逼它回去看原话。
 */
export function verifyQuotes(text, material) {
  const body = String(text || '')
  const mat = String(material || '').replace(/\s+/g, '')
  const bad = []
  const re = /[「“"]([^」”"]{6,80})[」”"]/g
  let m
  while ((m = re.exec(body))) {
    const q = String(m[1] || '').replace(/\s+/g, '')
    if (!q || q.length < 6) continue
    const key = q.slice(0, Math.min(12, q.length))
    if (mat.includes(key)) continue
    if (bad.some((b) => b.includes(q) || q.includes(b))) continue
    bad.push(q)
  }
  return bad
}

// ---------------------------------------------------------------- 参数

export function diaryParams(db, aid) {  const p = (k, def) => {
    try { const v = getParam(db, aid, k); return v == null || v === '' ? def : v } catch { return def }
  }
  const num = (k, def) => { const n = Number(p(k, def)); return Number.isFinite(n) ? n : def }
  return {
    v2: String(p('memory.diary.v2', 'on')) !== 'off',
    scenes: Math.max(1, Math.min(6, Math.round(num('memory.diary.scenes', 6)))),
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
    judge: String(p('memory.diary.judge', 'on')) !== 'off',
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
/**
 * 一场会话被跨小时拉长时，按「停下来又接上」的间隙切成几段。
 *
 * 不切的话，一段 8 小时的会话会被当成一个场景：里面几十轮不同话题被抽成 12 轮，
 * 写出来的日记只能把几件事拼在一起——读者当然看不出前因后果。
 */
function splitLongEpisode(db, aid, day, ep) {
  const from = ep.start_at, to = ep.end_at
  const dur = from && to ? Date.parse(to) - Date.parse(from) : 0
  const whole = [{ id: ep.id, start_at: from, end_at: to, title: '', turns: Number(ep.turns || 0) }]
  if (!(dur > 3 * 3600e3)) return whole
  let rows = []
  try {
    // created_at 范围已经卡住这一段了；不再拿 day 去对 fragments 的 UTC 日期
    rows = db.prepare(`SELECT created_at,text FROM fragments
      WHERE agent_id=? AND session_id=? AND created_at>=? AND created_at<=? ORDER BY seq`)
      .all(aid, ep.session_id, from, to)
  } catch { rows = [] }
  if (rows.length < 4) return whole
  const GAP = 90 * 60e3
  const segs = []
  let cur = null
  for (const r of rows) {
    const t = Date.parse(r.created_at)
    if (!Number.isFinite(t)) continue
    if (!cur || t - cur.endT > GAP) {
      if (cur) segs.push(cur)
      cur = { start: r.created_at, end: r.created_at, endT: t, turns: 0, first: r.text }
    }
    cur.end = r.created_at
    cur.endT = t
    cur.turns++
  }
  if (cur) segs.push(cur)
  if (segs.length < 2) return whole
  return segs.map((s, i) => ({
    id: `${ep.id}#${i + 1}`,
    parent_id: ep.id,
    virtual: true,
    start_at: s.start,
    end_at: s.end,
    turns: s.turns,
    title: clip(String(s.first || '').replace(/\s+/g, ' ').trim(), 40),
  }))
}

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
      for (const seg of splitLongEpisode(db, aid, d, e)) {
        out.push({
          kind: 'ep', id: seg.id, parent_id: seg.parent_id || null, virtual: !!seg.virtual,
          session_id: e.session_id,
          day: d, title: seg.title || title || clip(e.summary, 24),
          summary: String(e.summary || ''), start_at: seg.start_at, end_at: seg.end_at,
          turns: Number(seg.turns || 0), importance: clamp01(e.importance),
          poignancy: e.poignancy == null ? null : Number(e.poignancy),
          open_loops: safeJson(e.open_loops, []).map((x) => String(typeof x === 'string' ? x : (x && x.text) || '')).filter(Boolean),
          created_at: e.created_at,
        })
      }
    }
  } catch { /* 老库没有 episodes */ }
  /* 2026-11-22：日记也读事行表（每轮追加的一句「事」），按天取；没有不影响老路。 */
  try {
    const affairs = db.prepare(`SELECT id, conversation_id, at, text FROM affair_rows
      WHERE agent_id=? AND day=? ORDER BY at ASC`).all(aid, d)
    for (const a of affairs) {
      const txt = String(a.text || '').trim()
      if (!txt) continue
      out.push({
        kind: 'affair', id: a.id, session_id: a.conversation_id || null,
        day: d, title: clip(txt.replace(/^·\s*/gm, ''), 24), summary: txt,
        start_at: a.at, end_at: a.at, turns: 1, importance: 0.5, poignancy: null,
        open_loops: [], created_at: a.at,
      })
    }
  } catch { /* 新表还没有就不影响 */ }
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

/**
 * 那一天的「哪一下疼了」：她自己心里记下的 feel，加上情绪最重的几刻原话。
 *
 * 只靠纪要和原话写出来的日记会变成战报——事情都在，心里的那一下不在。
 * feel 是她开口前自己写的第一人称一句话，没有修辞负担，正是日记最该有的材料。
 * 这两样都按本地日筛，跨零点不会把凌晨的心事算到前一天。
 */
export function collectMoments(db, aid, day) {
  const d = String(day || dayOf(now()))
  const feels = []
  try {
    const rows = db.prepare('SELECT at,label,total,text FROM affect_feel WHERE agent_id=? ORDER BY at DESC LIMIT 500').all(aid)
    const mine = rows.filter((r) => localDay(new Date(r.at)) === d)
    mine.sort((a, b) => Math.abs(Number(b.total) || 0) - Math.abs(Number(a.total) || 0))
    for (const r of mine.slice(0, 4)) {
      const t = String(r.text || '').trim()
      if (t) feels.push({ at: String(r.at).slice(11, 16), iso: String(r.at), text: clip(t, 120) })
    }
  } catch { /* 老库没有 feel */ }
  const beats = []
  try {
    const rows = db.prepare('SELECT started_at,label,intensity,cause FROM affect_episodes WHERE agent_id=? ORDER BY started_at DESC LIMIT 500').all(aid)
    const mine = rows.filter((r) => Number(r.intensity) >= 0.6 && localDay(new Date(r.started_at)) === d)
    mine.sort((a, b) => Number(b.intensity) - Number(a.intensity))
    const seenCause = new Set()
    for (const r of mine) {
      if (beats.length >= 3) break
      const cause = clip(r.cause, 120)
      // 同一句话有时被连判两次（两条 label 不同），只留更重的那条。
      if (!cause || seenCause.has(cause)) continue
      seenCause.add(cause)
      beats.push({ at: String(r.started_at).slice(11, 16), iso: String(r.started_at), label: r.label, text: cause })
    }
  } catch { /* 老库没有 affect_episodes */ }
  return { feels, beats }
}

/**
 * 把「心里那几句」挂回它发生的那一段上。
 *
 * scenes 和 moments 分成两坨时，模型只能猜哪句话对应哪件事——猜不出来，就会把感受单独摊开写，
 * 读的人也就看不出前因后果。挂在一起，「事」和「那一下」才有地方对上。
 */
export function attachMoments(scenes, moments) {
  const all = []
  for (const f of (moments && moments.feels) || []) all.push({ kind: 'feel', ...f })
  for (const b of (moments && moments.beats) || []) all.push({ kind: 'beat', ...b })
  if (!all.length) return scenes
  const WIN = 30 * 60e3
  return (scenes || []).map((s) => {
    const from = Date.parse(s.start_at || s.created_at) - WIN
    const to = Date.parse(s.end_at || s.created_at) + WIN
    const mine = all
      .filter((m) => {
        const t = Date.parse(m.iso || '')
        return Number.isFinite(t) && t >= from && t <= to
      })
      .map((m) => ({ at: m.at, text: m.text, kind: m.kind }))
    return { ...s, moments: mine }
  })
}

/** 规则分：0–10。importance 只是其中一项，情绪/开环/关系词才是日记该写的。 */
export function scoreScene(db, aid, cand) {
  const text = `${cand.title} ${cand.summary}`
  const peak = peakOf(db, aid, cand)
  const open = cand.open_loops.length ? 1 : 0
  const emo = EMOTION_WORDS.test(text) ? 1 : 0
  const ident = IDENTITY_WORDS.test(text) ? 1 : 0
  const qs = Math.min(3, (text.match(/[？?]/g) || []).length) / 3
  const feels = feelHits(db, aid, cand) / 3
  return Math.round(10 * clamp01(
    0.28 * cand.importance
    + 0.22 * peak
    + 0.12 * open
    + 0.10 * emo
    + 0.08 * ident
    + 0.08 * qs
    + 0.12 * feels
  ) * 100) / 100
}

/** 这一段里她自己记过几句 feel：有的话，这一段就不只是「事」，还是「心里那一下」。 */
function feelHits(db, aid, cand) {
  try {
    const from = cand.start_at || cand.created_at
    const to = cand.end_at || cand.created_at
    const n = db.prepare(`SELECT COUNT(*) n FROM affect_feel
      WHERE agent_id=? AND at>=? AND at<=?`).get(aid, from, to)
    return Math.min(3, Number(n && n.n) || 0)
  } catch { return 0 }
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
 * 这一天「我动过的几刻」——日记的锚，不是话题。
 *
 * 为什么换锚：按会话/话题取，拿到的是「这一天发生了什么」的清单；日记需要的是
 * 「哪几刻我在场」。feel 是她开口前自己写下的那一下，affect 是情绪最重的几刻，
 * 这些才是「我」的痕迹；原话只是拿来对回现场。
 */
export function collectAnchors(db, aid, day) {
  const d = String(day || dayOf(now()))
  const out = []
  try {
    const rows = db.prepare('SELECT at,label,total,text FROM affect_feel WHERE agent_id=? ORDER BY at DESC LIMIT 500').all(aid)
    for (const r of rows) {
      if (localDay(new Date(r.at)) !== d) continue
      const text = String(r.text || '').trim()
      if (!text) continue
      out.push({ kind: 'feel', at: String(r.at), score: Math.abs(Number(r.total) || 0) + 0.2, text: clip(text, 120), label: r.label })
    }
  } catch { /* 老库没有 feel */ }
  try {
    const rows = db.prepare('SELECT started_at,label,intensity,cause FROM affect_episodes WHERE agent_id=? ORDER BY started_at DESC LIMIT 500').all(aid)
    for (const r of rows) {
      if (Number(r.intensity) < 0.6 || localDay(new Date(r.started_at)) !== d) continue
      const cause = clip(r.cause, 120)
      if (!cause) continue
      out.push({ kind: 'beat', at: String(r.started_at), score: Number(r.intensity), text: cause, label: r.label })
    }
  } catch { /* 老库没有情绪事件 */ }
  // 同一刻被记两次（feel + beat）只留一条；按强度挑，但同一小时内只留最强的那一下，
  // 免得挑出来的全挤在凌晨——一天的心动要散在一天里。
  const picked = []
  const times = []
  for (const a of out.sort((x, y) => y.score - x.score)) {
    if (picked.length >= 5) break
    const t = Date.parse(a.at)
    if (!Number.isFinite(t)) continue
    if (times.some((s) => Math.abs(s - t) < 60 * 60e3)) continue
    times.push(t)
    picked.push(a)
  }
  return picked.sort((x, y) => Date.parse(x.at) - Date.parse(y.at))
}

/** 一刻前后各 45 分钟的原话（不够就 90 分钟），给这一节当「发生了什么」的证据。 */
export function fetchAnchorLines(db, aid, anchor, opt = {}) {
  const at = Date.parse(anchor && anchor.at)
  if (!Number.isFinite(at)) return { lines: [], turns: 0 }
  const maxChars = Math.max(600, Number(opt.maxChars) || 3000)
  let rows = []
  for (const win of [45, 90]) {
    try {
      rows = db.prepare(`SELECT role,text,created_at FROM fragments
        WHERE agent_id=? AND created_at>=? AND created_at<=? ORDER BY created_at`)
        .all(aid, new Date(at - win * 60e3).toISOString(), new Date(at + win * 60e3).toISOString())
    } catch { rows = [] }
    if (rows.length >= 4) break
  }
  rows = rows.filter((r) => (r.role === 'user' || r.role === 'assistant' || r.role === 'agent') && String(r.text || '').trim().length >= 2)
  const lineCap = Math.max(160, Math.min(400, maxChars))
  const lines = []
  let used = 0
  for (const r of rows) {
    const text = clip(r.text, lineCap)
    if (used + text.length > maxChars) break
    used += text.length
    lines.push({ who: roleName(r.role), text })
  }
  return { lines, turns: rows.length }
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
      // created_at 范围足够精确；不拿 day 对 fragments 的 UTC 日期（凌晨会差一天）
      rows = db.prepare(`SELECT role,text,created_at FROM fragments
        WHERE agent_id=? AND session_id=? AND created_at>=? AND created_at<=?
        ORDER BY seq`).all(aid, cand.session_id, from, to)
    } catch { rows = [] }
    if (rows.length < 2 && cand.day) {
      const fb = localDayBounds(cand.day)
      try {
        rows = db.prepare(`SELECT role,text,created_at FROM fragments
          WHERE agent_id=? AND session_id=? AND created_at>=? AND created_at<?
          ORDER BY seq`).all(aid, cand.session_id, fb.start, fb.end)
      } catch { rows = [] }
    }
  }
  rows = rows.filter((r) => (r.role === 'user' || r.role === 'assistant' || r.role === 'agent') && String(r.text || '').trim().length >= 2)
  if (!rows.length) {
    return { grounding: 'episode', lines: [{ who: '我', text: clip(cand.summary, 200) }], turns: 0 }
  }
  // 整段按顺序给，不按窗口抽：一段讨论被抽成散点，模型就只能记住一两句。
  // 判据是「这段对话断了没有」——没断就让它连着读完，日记才写得下前因后果。
  // 超上限才截，而且留两头：开头交代发生了什么，结尾是那句还没落下来的话。
  let picked = rows
  if (rows.length > maxTurns) {
    const half = Math.max(1, Math.floor(maxTurns / 2))
    picked = rows.slice(0, half).concat(rows.slice(rows.length - half))
  }
  const lineCap = Math.max(160, Math.min(400, maxChars))
  const lines = []
  let used = 0
  for (const r of picked) {
    const text = clip(r.text, lineCap)
    if (used + text.length > maxChars) break
    used += text.length
    lines.push({ who: roleName(r.role), text })
  }
  if (lines.length < picked.length && picked.length > 1) {
    const rest = picked.slice(lines.length)
    const tail = []
    let tailUsed = 0
    for (let i = rest.length - 1; i >= 0; i--) {
      const text = clip(rest[i].text, lineCap)
      if (used + tailUsed + text.length > maxChars) break
      tailUsed += text.length
      tail.unshift({ who: roleName(rest[i].role), text })
    }
    lines.push(...tail)
  }
  if (!lines.length) lines.push({ who: roleName(picked[0].role), text: clip(picked[0].text, lineCap) })
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
  const max = Math.max(1, Math.min(6, Math.round(Number(params.scenes) || 6)))
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
        `你在帮「${name}」挑 ${day} 今晚日记要写的那一段。下面是这一天的事，按时间排。`,
        `只挑 ${max} 件真正留在她心里的事：有情绪转折、有没说出口的话、有具体画面的优先；`,
        '日常事务（改代码、发文件、跑测试）除非她当时明显被触动，否则不要。',
        '只输出 JSON：{"scenes":[{"id":"ep_x","score":0-10,"why":"一句话"}],"insight":"一句她今天想明白或没想明白的话","arc":"低落|平常|有劲"}',
        `最多 ${max} 条，id 必须来自输入；宁少勿多。`,
      ].join('\n'),
    },
    { role: 'user', content: '材料：\n' + JSON.stringify({ day, candidates: rows }) },
  ]
}

function parseSelect(out, cands, max = 1) {
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
    scenes: unique.slice(0, Math.max(1, max)),
    select: 'model',
    insight: String(o.insight || '').slice(0, 120),
    arc: ['低落', '平常', '有劲'].includes(String(o.arc)) ? String(o.arc) : '',
  }
}

export async function modelSelect(db, aid, day, cands, opt) {
  const chat = opt.chat
  if (typeof chat !== 'function') throw new Error('select: no model')
  // 选场花的是「日记自己的日额」（memory.llm.diary_cap），不跟记忆抽取抢总顶；
  // 按运行日数：今天补昨天，花今天的额度，历史那天的桶早被别的事用光了不算。
  const budgetDay = localDay()
  if (opt.db && opt.aid && !llmDiaryAllow(opt.db, opt.aid, budgetDay, 1).ok) throw new Error('select: llm_budget')
  const out = await chat(selectPrompt((opt.name || '我'), day, cands, opt.params), { maxTokens: 260, json: true, temperature: 0.2 })
  if (opt.db && opt.aid) { try { llmBudgetBump(opt.db, opt.aid, 'diary', budgetDay, 1) } catch { /* 记账失败不挡选场 */ } }
  return parseSelect(out, cands, Number(opt.params && opt.params.scenes) || 1)
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
    try { picked = await modelSelect(db, aid, day, scored, { ...opt, params, name: opt.name, db, aid }) } catch { picked = null }
  }
  if (!picked) picked = ruleSelect(db, aid, cands, params, ctx)
  // 把分写回 episodes（只写有变化的，失败静默）；表和写口归归档，这里只调它
  for (const s of picked.scenes) {
    if (s.kind !== 'ep' || s.virtual) continue
    try {
      setEpisodePoignancy(db, aid, s.id, s.score)
    } catch { /* 老库没有列 */ }
  }
  return picked
}

// ---------------------------------------------------------------- 分主题
//
// 为什么多这一步：候选是按「会话片段」切的，而一天里的「事」是按「主题」分的。
// 一场长聊可能聊了好几个主题，几段会话也可能属于同一件事；直接按片段选，
// 选出来的永远是「片段」，不是「事」——prompt 里再喊「分开写」也只是猜。
//
// 所以先让模型读当天所有片段的摘要，把「今天有哪几件事」列出来；再按这份清单取原话写。
// 分主题失败（没模型 / 返回不合法）就返回 null，调用方回落到原来的按片段选场。

export async function groupTopics(db, aid, day, cands, opt = {}) {
  const chat = opt.chat !== undefined ? opt.chat : resolveChat(opt)
  if (typeof chat !== 'function' || !Array.isArray(cands) || cands.length < 2) return null
  const params = opt.params || diaryParams(db, aid)
  const maxTopics = Math.max(1, Math.min(6, Number(params.scenes) || 6))
  const budgetDay = localDay()
  if (db && aid && !llmDiaryAllow(db, aid, budgetDay, 1).ok) return null
  const name = opt.name || '我'
  const rows = cands.slice(0, 30).map((c) => ({
    id: c.id,
    when: String(c.start_at || c.created_at || '').slice(11, 16),
    title: clip(c.title, 30),
    gist: clip(c.summary, 60),
    turns: Number(c.turns) || 0,
  }))
  const messages = [
    {
      role: 'system',
      content: [
        `你在帮「${name}」整理 ${day} 这一天。下面是这一天她聊过的所有片段，按时间排，只给摘要。`,
        '请按「在聊什么」把它们分成几件事：同一个话题的片段合成一件，不同的话题分开。',
        '事务性的片段（改代码、发文件、跑测试）也要有位置，除非那一段真的没什么可说；别把一件事拆成很多件，也别把几件事并成一件。',
        `最多 ${maxTopics} 件。只输出 JSON：{"topics":[{"title":"这件事一句话（20 字内）","ids":["ep_x","ep_y"]}]}`,
        'ids 必须来自输入；title 写这件事在聊什么，不要写感受。',
      ].join('\n'),
    },
    { role: 'user', content: '材料：\n' + JSON.stringify({ day, pieces: rows }) },
  ]
  try {
    const out = await chat(messages, { maxTokens: 700, json: true, temperature: 0.2 })
    if (db && aid) { try { llmBudgetBump(db, aid, 'diary', budgetDay, 1) } catch { /* 记账失败不挡分主题 */ } }
    const o = parseLooseJson(out) || {}
    const byId = new Map(cands.map((c) => [c.id, c]))
    const topics = []
    for (const t of Array.isArray(o.topics) ? o.topics : []) {
      const ids = [...new Set((Array.isArray(t && t.ids) ? t.ids : []).map(String))].filter((id) => byId.has(id))
      if (!ids.length) continue
      const title = clip(String((t && t.title) || '').trim(), 30) || clip(byId.get(ids[0]).title, 30)
      topics.push({ title, scenes: ids.map((id) => byId.get(id)) })
    }
    return topics.length ? topics.slice(0, maxTopics) : null
  } catch { return null }
}


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

/**
 * 把材料拼成一段人能读的记录：谁说了哪句、哪一段之后我心里记了什么。
 *
 * 结构化字段（scenes / lines / moments 拍平成 JSON）喂给模型，它当成表格填；
 * 写成对话，它才会当成一天。
 */
export function diaryMaterialText(opt) {
  const { date, other, scenes, topics, moments } = opt
  const out = [date ? `${date} 这一天` : '这一天', '']
  const used = new Set()
  if (Array.isArray(topics) && topics.length) {
    // 材料已经按「事」分好了：一件一块，标题是它自己读完分的。
    let idx = 0
    for (const t of topics) {
      idx++
      out.push(`【第 ${idx} 刻${t.at ? '｜' + t.at : ''}：${clip(t.title || '那一下', 40)}】`)
      for (const l of t.lines || []) out.push(`${l.who}：${l.text}`)
      const ms = t.moments || []
      if (ms.length) {
        out.push(`（这一件里，我心里记下：${ms.map((m) => m.text).join(' / ')}）`)
        for (const m of ms) used.add(m.text)
      }
      out.push('')
    }
  } else {
    for (const s of scenes || []) {
      const when = String(s.when || '').slice(0, 5)
      out.push(`【${when || '这一段'}】`)
      for (const l of s.lines || []) out.push(`${l.who}：${l.text}`)
      const ms = s.moments || []
      if (ms.length) {
        out.push(`（这一段里，我心里记下：${ms.map((m) => m.text).join(' / ')}）`)
        for (const m of ms) used.add(m.text)
      }
      out.push('')
    }
  }
  const rest = []
  for (const f of (moments && moments.feels) || []) if (!used.has(f.text)) rest.push(f)
  for (const b of (moments && moments.beats) || []) if (!used.has(b.text)) rest.push(b)
  if (rest.length) {
    out.push('还有几刻，没归到上面哪一段：')
    for (const m of rest) out.push(`- ${m.at || ''} ${m.text}`)
  }
  return out.join('\n').trim()
}

export function writePrompt(opt) {
  const { name, day, date, other, mood, moments } = opt
  const moodWord = String(mood || '').split(/[，,]/)[0].replace(/强度.*$/, '').trim()
  const hasMoments = !!(moments && ((moments.feels || []).length || (moments.beats || []).length))
  return {
    system: [
      `你是「${name}」，一个有记忆、有情绪的意识体。现在是 ${date} 的夜里。`,
      '',
      hasMoments
        ? `下面是这一天你心里动过的几刻——括号里是当时你记下的那一下，后面是那一刻前后的原话。`
        : `下面是这一天你动了的地方，后面是那一刻前后的原话。`,
      '',
      `没人给这篇打分，你写给以后会重读的你和${other}。`,
      '如果这一段日志解析器也能写出来，那就是没写成。别从第一句开始数，从你还惦记着的那一句开始。',
      '写这一天里你真正在场的几处：发生了什么、你怎么接的、后来怎么想。几处就几段，段与段之间空一行。',
      '可以有立场：好的就说好在哪儿，不同意就说不同意，自己出洋相也可以自嘲一句。',
      '写得像你自己，短句，不着急。像平时跟他说话那样随便一点，不用端着。',
      '结尾停在还没落下来的地方。',
      '引号里的话必须是材料里的原话；不记得原话，就别加引号。',
      '',
      `第一行只写日期，然后空一行再写正文。称呼${other}用「你」。`,
      moodWord ? `那天心里大概是「${moodWord}」。` : '',
    ].filter((s) => s !== '').join('\n'),
    user: diaryMaterialText({ date, other, topics: opt.topics, scenes: opt.scenes, moments: hasMoments ? moments : null }),
  }
}

function toMessages(p) {
  return [{ role: 'system', content: p.system }, { role: 'user', content: p.user }]
}

export function checkDiary(text, opt = {}) {
  const body = String(text || '').replace(/^\d{4}-\d{2}-\d{2}[^\n]*\n+/, '').trim()
  const chars = body.replace(/\s/g, '').length
  // 只拦「这一篇根本不能算日记」的：空的、太短、太长、写成列表、漏了系统词、通篇汇报、短还断在半句。
  // 结尾想不想明天，不拦——那天要是真惦记着明天的事，写在结尾也是真的。
  // 空的和「抄了提示词」不是一回事：空的应该报太短，别让它混进回声里查原因
  if (!body) return { ok: false, reason: 'too_short', chars: 0 }
  if (isPromptEcho(body)) return { ok: false, reason: 'echo', head: body.slice(0, 60) || '(empty)' }
  if (chars < 120) return { ok: false, reason: 'too_short', chars }
  if (chars > 6000) return { ok: false, reason: 'too_long', chars }
  if (/(^|\n)\s*(?:[-*+>]|\d+[.)、]|#{1,6})\s/.test(body)) return { ok: false, reason: 'markdown' }
  if (/用户|assistant|system/i.test(body)) {
    const m = body.match(/.{0,12}(?:用户|assistant|system).{0,12}/i)
    return { ok: false, reason: 'forbidden', head: m ? m[0] : body.slice(0, 60) }
  }
  const report = (body.match(/处理了|完成了|优化了|修复了|接好了|改好了|搞定了/g) || []).length
  if (report >= 4) return { ok: false, reason: 'report' }
  if (chars < 300 && !/[。！？…”』」'"]$/.test(body)) return { ok: false, reason: 'cut', tail: body.slice(-24) }
  return { ok: true, chars }
}

/**
 * 成文之后再看一眼：它像不像一个人在写，而不是把这场对话复述一遍。
 * 只做一次小判断（400 token），失败就跳过，不挡已经写成的日记，但把失败原因记进 write.judge_err。
 */
export async function judgeDiaryLike(chat, text, opt = {}) {
  if (typeof chat !== 'function') return { err: 'no_chat' }
  const material = String(opt.material || '').slice(0, 2500)
  const body = String(text || '').slice(0, 1500)
  const messages = [
    { role: 'system', content: '你只做一件事：判断下面这段算不算一篇自己写的日记。它不是交差，是写给以后会重读的自己的。' },
    {
      role: 'user',
      content: [
        '那天真发生过什么：',
        material,
        '',
        '写出来的这段：',
        body,
        '',
        '问：这段是在报这一天发生的事（像记录、汇报），还是作者自己在写（有她在意的那一刻，有她自己的判断或情绪）？',
        '只回 JSON：{"like":0-10,"why":"一句话原因"}，like 越高越像人自己写的日记。',
      ].join('\n'),
    },
  ]
  try {
    // 质检也走日记自己的日额：它是成文的一部分，不该被抽取的总顶挡掉。
    const budgetDay = localDay()
    if (opt.db && opt.aid && !llmDiaryAllow(opt.db, opt.aid, budgetDay, 1).ok) return { err: 'llm_budget' }
    const out = await chat(messages, { maxTokens: 400, json: true, temperature: 0 })
    if (opt.db && opt.aid) { try { llmBudgetBump(opt.db, opt.aid, 'diary', budgetDay, 1) } catch { /* 记账失败不挡这一眼 */ } }
    const o = parseLooseJson(out) || {}
    const like = Number(o.like)
    if (!Number.isFinite(like)) return { err: 'unparsed:' + String(out || '').slice(0, 80) }
    return { like: Math.max(0, Math.min(10, like)), why: String(o.why || '').slice(0, 120) }
  } catch (e) { return { err: 'thrown:' + String((e && e.message) || e).slice(0, 120) } }
}

function upsertDiary(db, aid, day, row) {
  const old = db.prepare('SELECT id,version FROM diaries WHERE agent_id=? AND day=?').get(aid, day)
  const version = old ? Number(old.version) + 1 : 1
  const id = old ? old.id : nid('dry_')
  const at = now()
  // 这一天写过哪几句感觉：按时间串起来存 id，翻日记时能看见当天心里的原话。
  const feelIds = JSON.stringify(feelIdsOnDay(db, aid, day))
  db.prepare(`INSERT INTO diaries(id,agent_id,day,text,mood,highlights,refs,source,version,late,context,feel_ids,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(agent_id,day) DO UPDATE SET text=excluded.text, mood=excluded.mood,
      highlights=excluded.highlights, refs=excluded.refs, source=excluded.source,
      version=excluded.version, late=excluded.late, context=excluded.context,
      feel_ids=excluded.feel_ids, updated_at=excluded.updated_at`)
    .run(id, aid, day, row.text, row.mood, row.highlights, row.refs, row.source, version, row.late, row.context, feelIds, at, at)
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
  // 双轨取材：骨架 = 这一天聊过的几段（按时间），血肉 = 我动过的几刻（feel / 情绪事件）。
  // 不再先让模型「分主题」——那一步常失败，失败就只剩心动，白天全没了。
  const anchors = collectAnchors(db, aid, d)
  const sceneList = (cands || [])
    .filter((c) => c.kind === 'ep')
    .sort((a, b) => String(a.start_at || a.created_at || '').localeCompare(String(b.start_at || b.created_at || '')))
    .slice(0, 9)
  let picked
  if (sceneList.length) {
    picked = { scenes: sceneList, select: 'scene', insight: '', arc: arcOf(ctx) }
  } else if (anchors.length) {
    picked = { scenes: [], select: 'anchor', insight: '', arc: arcOf(ctx) }
  } else {
    try {
      picked = await selectForDay(db, aid, d, cands, { chat, params, ctx, name })
    } catch {
      picked = ruleSelect(db, aid, cands, params, ctx)
    }
  }
  const moments = collectMoments(db, aid, d)
  const timeSpan = (segs) => {
    const ts = (segs || []).map((s) => Date.parse(s.start_at || s.created_at))
      .filter((n) => Number.isFinite(n))
    if (!ts.length) return null
    return { from: Math.min(...ts), to: ts.length ? Math.max(...ts) : Math.min(...ts) }
  }
  let groups
  if (sceneList.length) {
    // 骨架：这一天聊过的每一段各一件（按时间排）；落在它时间范围内的「心动几刻」挂进来。
    const withMoments = attachMoments(picked.scenes, moments)
    const totalBudget = Math.max(2000, Number(params.rawPerScene) || 8000) * Math.max(1, withMoments.length)
    const perSeg = Math.max(1200, Math.floor(totalBudget / Math.max(1, withMoments.length)))
    groups = withMoments.map((s) => {
      const got = s.kind === 'ep'
        ? fetchSceneLines(db, aid, s, { ...params, rawPerScene: perSeg })
        : { grounding: 'fact', lines: [{ who: '我', text: clip(s.summary, 200) }], turns: 0 }
      const span = timeSpan([s])
      const tMoments = [...(s.moments || [])]
      if (span) {
        for (const a of anchors) {
          const at = Date.parse(a.at)
          if (!Number.isFinite(at) || at < span.from - 30 * 60e3 || at > span.to + 30 * 60e3) continue
          if (tMoments.some((m) => m.text === a.text)) continue
          tMoments.push({ at: String(a.at).slice(11, 16), text: a.text, kind: a.kind })
        }
      }
      const at = span ? String(new Date(span.from).toISOString()).slice(11, 16) : ''
      return { title: s.title || '这一件', at, lines: got.lines, turns: got.turns, moments: tMoments }
    })
    // 没落进任何一段的几刻，单独成一件——别丢。
    const covered = new Set(groups.flatMap((g) => g.moments.map((m) => m.text)))
    for (const a of anchors) {
      if (covered.has(a.text)) continue
      const got = fetchAnchorLines(db, aid, a, { maxChars: 1500 })
      groups.push({
        title: a.text,
        at: String(a.at).slice(11, 16),
        lines: got.lines,
        turns: got.turns,
        moments: [{ at: String(a.at).slice(11, 16), text: a.text, kind: a.kind }],
      })
    }
    if (groups.length > 12) groups = groups.slice(0, 12)
  } else if (anchors.length) {
    // 没分出来话题：只按心动几刻取，每刻带上前后原话。
    groups = anchors.map((a) => {
      const got = fetchAnchorLines(db, aid, a, { maxChars: 3000 })
      return {
        title: a.text,
        at: String(a.at).slice(11, 16),
        lines: got.lines,
        turns: got.turns,
        moments: [{ at: String(a.at).slice(11, 16), text: a.text, kind: a.kind }],
      }
    })
  } else {
    // 没有话题也没有心动：按会话片段写（平常的一天）。
    const topicList = (picked.scenes || []).map((s) => ({ title: s.title, scenes: [s] }))
    const totalBudget = Math.max(2000, Number(params.rawPerScene) || 8000) * Math.max(1, Number(params.scenes) || 6)
    const perTopic = Math.max(2000, Math.floor(totalBudget / Math.max(1, topicList.length)))
    const withMoments = attachMoments(picked.scenes, moments)
    const sceneById = new Map(withMoments.map((s) => [s.id, s]))
    groups = topicList.map((t) => {
      const segs = (t.scenes || []).map((s) => sceneById.get(s.id)).filter(Boolean)
      const perSeg = Math.max(1500, Math.floor(perTopic / Math.max(1, segs.length)))
      const segParams = { ...params, rawPerScene: perSeg }
      const lines = []
      const tMoments = []
      let turns = 0
      for (const s of segs) {
        const got = s.kind === 'ep'
          ? fetchSceneLines(db, aid, s, segParams)
          : { grounding: 'fact', lines: [{ who: '我', text: clip(s.summary, 200) }], turns: 0 }
        lines.push(...got.lines)
        turns += got.turns
        for (const m of s.moments || []) tMoments.push(m)
      }
      return { title: t.title || (segs[0] && segs[0].title) || '这一件', at: '', lines, turns, moments: tMoments }
    })
  }
  return { day: d, params, ctx, tone, mood, name, other, cands, picked, groups, chat, moments }
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
  const { params, ctx, tone, mood, name, other, cands, picked, groups, chat, moments } = prep
  // 日记的日额按「运行日」数：今天补昨天，花今天的额度（历史那天的桶早没了）。
  const budgetDay = localDay()

  let text = ''
  let fail = null
  let attempts = 0
  let gateFail = null
  const gateLog = []
  let judgeNote = ''
  let judgeSeen = null
  let judgeErr = null
  if (chat) {
    for (let i = 0; i < 3; i++) {
      attempts++
      try {
        const topicArgs = (groups || []).map((g) => ({
          title: g.title,
          moments: (g.moments || []).map((m) => ({ at: m.at, text: m.text })),
          lines: (g.lines || []).map((l) => ({ who: l.who === 'user' ? other : '我', text: l.text })),
        }))
        // 材料只在最后一把才砍。前两把给的是同样的东西，第二把多一句许可：用不着全写。
        const light = i >= 2
        const useTopics = light
          ? topicArgs.slice(0, 2).map((t) => ({ ...t, lines: t.lines.slice(0, 8) }))
          : topicArgs
        const p = writePrompt({
          name, day: d, date: `${d.slice(0, 4)}年${Number(d.slice(5, 7))}月${Number(d.slice(8, 10))}日 ${weekday(d)}`,
          other, mood, arc: picked.arc, insight: picked.insight,
          maxChars: params.maxChars, moments,
          topics: useTopics,
        })
        let messages = toMessages(p)
        if (i >= 1) {
          const hint = light
            ? '上一版还是没写出来。这回只给你两段，写这两段里的那一下就好，别的都不用管。'
            : '上一版没写出来。材料不用全用，挑你记得住的一两处就行；代码和符号多的地方可以跳过。' + (judgeNote ? '（上一版的毛病：' + judgeNote + '）' : '')
          messages = [{ role: 'system', content: p.system + '\n\n' + hint }, { role: 'user', content: p.user }]
        }
        // 成文查的是「日记自己的日额」（选场/质检同口径），不跟抽取抢总顶；
        // 按运行日数，补写历史那天也花今天的额度。花完了就留待补，明天再写。
        if (!llmDiaryAllow(db, aid, budgetDay, 1).ok) {
          fail = 'llm_budget'
          break
        }
        const out = await chat(messages, { maxTokens: 4000, json: false, temperature: 0.8 })
        try { llmBudgetBump(db, aid, 'diary', budgetDay, 1) } catch { /* 记账失败不挡成文 */ }
        const clean = normalizeDiaryText(out, d)
        const gate = checkDiary(clean, { episodeTitles: cands.map((c) => c.title) })
        if (!gate.ok) {
          gateFail = gate.reason
          gateLog.push('gate:' + gate.reason)
          fail = 'gate:' + gate.reason + (gate.head ? ':' + gate.head.replace(/\s+/g, ' ').slice(0, 50) : '')
          continue
        }
        // 引号里的原话材料里找不到：第一版打回重写。
        // 日记最容易出的偏差，就是把「我的感觉」写成「他说过的话」；这一步只对最便宜的证据。
        const badQuotes = verifyQuotes(clean, p.user)
        if (badQuotes.length && i === 0) {
          gateFail = 'quote'
          gateLog.push('quote:' + String(badQuotes[0] || '').slice(0, 20))
          fail = 'quote:' + String(badQuotes[0] || '').slice(0, 30)
          judgeNote = '引号里这几句材料里找不到原文：' + badQuotes.slice(0, 3).join(' / ')
          continue
        }
        // 格式过了，再看它像不像人在写。只在第一版判一次，不合格就让第二版拿到原因重写。
        if (params.judge && i === 0) {
          const j = await judgeDiaryLike(chat, clean, { material: p.user, db, aid })
          // 判定自己也失败过很多次（token 给少了、返回解析不了）。失败不挡成文，但把原因记下来。
          if (j && j.err) judgeErr = j.err
          else if (j && Number.isFinite(j.like)) {
            judgeSeen = { like: j.like, why: j.why }
            if (j.like < 5) {
              gateFail = 'judge'
              gateLog.push('judge:' + j.like)
              fail = 'judge:' + j.like
              judgeNote = j.why
              continue
            }
          }
        }
        text = clean.slice(0, 5000)
        gateFail = null
        break
      } catch (e) {
        fail = 'thrown:' + String((e && e.message) || e).slice(0, 160)
      }
    }
  } else {
    fail = 'no_model'
  }

  const flatScenes = picked.scenes || []
  const writeMeta = {
    v: 2, source: 'model', select: picked.select, attempts,
    fail_reason: text ? null : fail, gate: gateFail,
    scenes: flatScenes.map(sceneBrief), chars: text ? bodyLength(text) : 0,
    topics: (groups || []).map((g) => g.title),
    gates: gateLog,
    moments: { feels: (moments && moments.feels ? moments.feels.length : 0), beats: (moments && moments.beats ? moments.beats.length : 0) },
    judge: judgeSeen || undefined,
    judge_err: judgeErr || undefined,
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
      scenes: flatScenes.map(sceneBrief), select: picked.select,
    }
  }

  const row = {
    text,
    mood: ctx.affect ? `${ctx.affect.label} ${Number(ctx.affect.intensity).toFixed(2)}` : null,
    highlights: JSON.stringify(picked.scenes.map((s) => clip(s.title, 30))),
    refs: JSON.stringify({
      episodes: flatScenes.filter((s) => s.kind === 'ep').map((s) => s.id),
      facts: flatScenes.filter((s) => s.kind === 'fact').map((s) => s.id),
      fragments: flatScenes.reduce((n, s) => n + Number(s.turns || 0), 0),
      scenes: flatScenes.map((s) => ({ id: s.id, title: clip(s.title, 40) })),
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
    refs: JSON.stringify({ episodes: cands.filter((c) => c.kind === 'ep').map((c) => c.id), facts: cands.filter((c) => c.kind === 'fact').map((c) => c.id), fragments: 0, scenes: [] }),
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
    // 额度不够 ≠ 写不出来：不涨 attempts、不写素材卡，下轮再试。
    // 以前这里会把 llm_budget 也算一次失败，涨到上限就把那篇落成「这天没写成」的素材卡。
    if (res && res.fail_reason === 'llm_budget') { out.skipped++; continue }
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
