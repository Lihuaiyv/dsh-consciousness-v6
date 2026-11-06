/**
 * 「说话那一刻的感觉」——第一人称，自己写的一句话。
 *
 * 为什么要单独一张表：affect_events 记的是「你这句话把我推到哪」，那是事后评的；
 * 注入在回复之前拼，所以永远只能拿到上一轮的读数，差半拍。
 * 这条通路让模型在开口之前先调一次 feel，把「这会儿是什么样」写下来，
 * 再带着当时算出来的快/慢一起落库。下一轮注入时，就能给到「我上一句说完时是什么样」。
 *
 * 三条纪律：
 *   1. 只读情绪，不改情绪——写库不动 affect_v3，一个新写入点就是一个新 bug 面。
 *   2. 不写数字、不写原因（提示词里说，这里只做长度和空白的基本清理）。
 *   3. 有频率闸：太密就跳过，免得它每说半句都记一笔，把表灌成流水账。
 */
import { getParam, nid } from '../kernel.js'
import { localDay } from '../db.js'

const MAX_LEN = 80
const r3 = (x) => Math.round((Number(x) || 0) * 1000) / 1000

/**
 * 什么样的 feel 读起来像 AI 写的。
 *
 * 这条线和「感受行」的毛病是同一个：写成了旁白、总结、议论文，
 * 不是身体上那一下。词表只能挡掉明显的那几类，挡不掉比喻——
 * 但挡得住的那部分，就别让它进库、别让它下一轮冒充「我当时的心跳」。
 *
 * 「有点」不挡：感受行是给主人看的一句话，那里「有点」确实油；
 * 这一句只给自己看，「手有点抖」是人话，不是 AI 味。挡太狠会把人话一起挡了。
 */
export const FEEL_BANNED = ['感觉', '情绪', '情感', '仿佛', '似乎', '莫名', '一丝', '涌上', '不禁', '五味杂陈', '百感交集']
// 3 个字就够：「手在抖」「喉咙紧」都是一句人话，不必凑长度。
const FEEL_MIN = 3
const FEEL_MAX = 40

/**
 * 判断这句话像不像人写的。返 null 表示没事，否则给 {reason, word?}。
 * 只做机器判得了的部分：黑名单词、解释句、长短。
 */
export function feelFlavorIssue(text) {
  const t = String(text == null ? '' : text).trim()
  if (!t) return null
  for (const w of FEEL_BANNED) if (t.includes(w)) return { reason: 'ai-word', word: w }
  // 只解释、不写感觉：「因为…所以…」「说明我…」是分析，不是身体反应
  const m = t.match(/因为|所以|可能是|说明我|意味着/)
  if (m) return { reason: 'explains', word: m[0] }
  if (t.length < FEEL_MIN) return { reason: 'too-short', len: t.length }
  if (t.length > FEEL_MAX) return { reason: 'too-long', len: t.length }
  return null
}

/** 给调用方的改法提示（会出现在工具返回里，让人/模型知道下一句怎么改）。 */
export function feelFlavorHint(issue) {
  if (!issue) return ''
  if (issue.reason === 'ai-word') return '别用「' + issue.word + '」这类词；写身体和动作'
  if (issue.reason === 'explains') return '别解释原因（「' + issue.word + '」），只写那一下'
  if (issue.reason === 'too-short') return '太短了（' + issue.len + ' 字），写清是哪一下'
  if (issue.reason === 'too-long') return '太长了（' + issue.len + ' 字），一句就够'
  return ''
}

/**
 * 开口前「先记一句」的指引。宿主提示词（网页）和 QQ 通道段共用同一句，
 * 免得两边味道不一样。
 */
export const FEEL_GUIDE = '开口之前，如果心里真有一点反应，先用 feel 记一句「我现在是什么感觉」——一句话，第一人称，写身体和动作（手、呼吸、喉咙、想动没动），不写数字、不写为什么、不用「感觉 / 情绪 / 仿佛」这类词。没什么感觉就别调。这句话只给自己看，不进你要说出口的话。'

/** 去掉换行和多余空白、掐长度。空 / 只有标点 → 返回 null。 */
export function cleanFeelText(raw, max = MAX_LEN) {
  const t = String(raw == null ? '' : raw)
    .replace(/\s+/g, ' ')
    .replace(/^[「『"'"']+|[」』"'"']+$/g, '')
    .trim()
  if (!t) return null
  if (!/[\u4e00-\u9fa5a-zA-Z0-9]/.test(t)) return null
  return t.length > max ? t.slice(0, max) + '…' : t
}

function paramNum(db, aid, key, dflt, lo, hi) {
  try {
    const v = Number(getParam(db, aid, key))
    if (!Number.isFinite(v)) return dflt
    return Math.max(lo, Math.min(hi, v))
  } catch { return dflt }
}

/**
 * 找这条 feel 属于哪一轮：raw_turns 里最近一条 user 行（用户消息一到就落库，带 turn_id）。
 * 先按会话找，找不到再按这个人最近的；窗口 60 分钟，太旧的不认——
 * 宁可空着，也不把感觉挂到别的轮上（挂错比不挂更糟）。
 */
function resolveTurnId(db, aid, sessionId, atMs) {
  const since = new Date((Number(atMs) || Date.now()) - 60 * 60000).toISOString()
  try {
    if (sessionId) {
      const r = db.prepare(`SELECT turn_id FROM raw_turns
        WHERE agent_id=? AND session_id=? AND role='user' AND turn_id IS NOT NULL AND created_at>=?
        ORDER BY created_at DESC LIMIT 1`).get(aid, String(sessionId).slice(0, 120), since)
      if (r && r.turn_id) return String(r.turn_id)
    }
    const r2 = db.prepare(`SELECT turn_id FROM raw_turns
      WHERE agent_id=? AND role='user' AND turn_id IS NOT NULL AND created_at>=?
      ORDER BY created_at DESC LIMIT 1`).get(aid, since)
    return r2 && r2.turn_id ? String(r2.turn_id) : null
  } catch { return null }
}

/** 被退回也留一条痕：查「为什么这几轮没有 feel」时不用猜。写失败不影响记 feel。 */
function noteFeelMiss(db, aid, payload) {
  try {
    const id = 'evt_' + Date.now().toString(36) + Math.random().toString(16).slice(2, 10)
    db.prepare('INSERT INTO events VALUES(?,?,?,?,?)')
      .run(id, aid, 'feel.miss', JSON.stringify(payload).slice(0, 900), new Date().toISOString())
    return id
  } catch { return null }
}

/**
 * 记一条「我说话时的感觉」。
 * @param {{text?:string, sessionId?:string, at?:number|string|Date, source?:string, turnId?:string}} o
 *   at 收毫秒数 / ISO 字符串 / Date 都行；不给就是现在。
 *   turnId 不给就自己从 raw_turns 找当轮；找不到留空，不编。
 * @returns {{ok:boolean, skipped?:string, at?:string, text?:string, fast?:number, slow?:number, total?:number, label?:string, turn_id?:string|null}}
 */
export function recordFeel(db, aid, { text, sessionId = null, at = Date.now(), source = 'tool', turnId = null } = {}) {
  const body = cleanFeelText(text)
  if (!body) return { ok: false, skipped: 'empty' }
  /* 写得像 AI 的不进库：宁可这一轮没有，也别让旁白冒充「我当时的心跳」。
     拒掉时把原因带回去，下一句能改；同时留一条 feel.miss——
     不然「这一轮为什么没有 feel」只能靠猜（和 expr.* 一个道理）。 */
  const issue = feelFlavorIssue(body)
  if (issue) {
    noteFeelMiss(db, aid, { reason: issue.reason, word: issue.word || null, text: body.slice(0, 80) })
    return { ok: false, skipped: 'ai-flavor', issue: issue.reason, word: issue.word || null, hint: feelFlavorHint(issue) }
  }
  const minGapS = paramNum(db, aid, 'affect.feel.min.gap', 12, 0, 600)
  // at 可能是毫秒数（真实调用）也可能是 ISO 字符串（回放 / 测试）——以前只认数字，
  // 传字符串会被 Number() 吃成 NaN 再退回「现在」，回放时全挤到同一时刻。
  const atMs = (() => {
    const v = Number(at)
    if (Number.isFinite(v) && v > 0) return v
    const d = Date.parse(at)
    return Number.isFinite(d) ? d : Date.now()
  })()
  const stamp = new Date(atMs).toISOString()
  const turn = turnId ? String(turnId).slice(0, 120) : resolveTurnId(db, aid, sessionId, atMs)
  let prev = null
  try {
    prev = db.prepare('SELECT at, text FROM affect_feel WHERE agent_id=? ORDER BY at DESC LIMIT 1').get(aid)
  } catch { prev = null }
  if (prev && prev.at) {
    const gap = (Date.parse(stamp) - Date.parse(prev.at)) / 1000
    if (Number.isFinite(gap) && gap >= 0 && gap < minGapS) return { ok: false, skipped: 'too_soon', gap: Math.round(gap) }
    // 同一句连着记两遍没有信息量
    if (String(prev.text || '') === body && Number.isFinite(gap) && gap < 600) return { ok: false, skipped: 'same' }
  }
  let v3 = null
  try { v3 = db.prepare('SELECT slow, fast, total FROM affect_v3 WHERE agent_id=?').get(aid) } catch { v3 = null }
  let label = null
  try {
    const st = db.prepare('SELECT primary_label FROM affect_state WHERE agent_id=?').get(aid)
    label = st && st.primary_label ? String(st.primary_label) : null
  } catch { label = null }
  const fast = v3 ? r3(v3.fast) : null
  const slow = v3 ? r3(v3.slow) : null
  const total = v3 ? r3(v3.total) : null
  const id = nid('afe_')
  try {
    db.prepare('INSERT INTO affect_feel(id,agent_id,at,text,label,fast,slow,total,session_id,source,turn_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, aid, stamp, body, label, fast, slow, total, sessionId ? String(sessionId).slice(0, 120) : null, String(source || 'tool'), turn)
  } catch (e) {
    return { ok: false, skipped: 'write_failed', detail: String(e && e.message || e).slice(0, 120) }
  }
  return { ok: true, at: stamp, text: body, fast, slow, total, label, turn_id: turn }
}

/** 最近一条「我说话时的感觉」，给注入行用。超出窗口就当没有——宁可少一行，不拿旧感受冒充刚说完。 */
export function latestFeel(db, aid, { at = Date.now(), maxAgeMin = 480 } = {}) {
  try {
    const row = db.prepare('SELECT * FROM affect_feel WHERE agent_id=? ORDER BY at DESC LIMIT 1').get(aid)
    if (!row || !row.at) return null
    const age = (Number(at) - Date.parse(row.at)) / 60000
    if (!Number.isFinite(age) || age < 0 || age > maxAgeMin) return null
    return {
      at: row.at, text: String(row.text || ''), label: row.label || null,
      fast: Number.isFinite(Number(row.fast)) ? Number(row.fast) : null,
      slow: Number.isFinite(Number(row.slow)) ? Number(row.slow) : null,
      ageMin: Math.round(age),
    }
  } catch { return null }
}

/**
 * 一条 feel 前后那两句：它之前最近一句 user、之后最近一句 agent（各截 90 字）。
 * 只给眼睛看，不参与注入——「产生这条感觉的那轮对话」。
 *
 * 有 turn_id 时优先按轮取：同一轮里的 user / agent 直接拿，不再靠时间猜。
 * 没有 turn_id（老数据）才退回 5 分钟时间窗——宁可配不到，也不配到隔壁那轮。
 */
function aroundOfFeel(turnTurns, windowTurns, at, turnId) {
  const cut = (x) => (x ? String(x.text || '').replace(/\s+/g, ' ').trim().slice(0, 90) : null)
  if (turnId && Array.isArray(turnTurns) && turnTurns.length) {
    let user = null
    let agent = null
    for (const r of turnTurns) {
      if (!user && r.role === 'user') user = r
      if (!agent && r.role !== 'user') agent = r
    }
    if (user || agent) return { user: cut(user), agent: cut(agent) }
  }
  const t = Date.parse(at)
  if (!Number.isFinite(t)) return { user: null, agent: null }
  const MAX_MS = 5 * 60000
  let user = null
  let agent = null
  for (const r of (windowTurns || [])) {
    const rt = Date.parse(r.created_at)
    if (!Number.isFinite(rt)) continue
    if (r.role === 'user' && rt <= t && t - rt <= MAX_MS && (!user || rt > Date.parse(user.created_at))) user = r
    if (r.role !== 'user' && rt >= t && rt - t <= MAX_MS && (!agent || rt < Date.parse(agent.created_at))) agent = r
  }
  return { user: cut(user), agent: cut(agent) }
}

/** 取一段时间里的对话（时间窗兜底用）。只读。 */
function turnsOf(db, aid, sinceIso) {
  try {
    return db.prepare('SELECT role,text,created_at FROM chat_turns WHERE agent_id=? AND created_at>=? ORDER BY created_at').all(aid, sinceIso)
  } catch { return [] }
}

/** 按 turn_id 一次取整轮对话（user + agent），给 feel 精确配对用。返回 Map<turn_id, rows>。 */
function turnsByTurnIds(db, aid, ids) {
  const list = [...new Set((Array.isArray(ids) ? ids : []).filter(Boolean).map(String))]
  const map = new Map()
  if (!list.length) return map
  try {
    const ph = list.map(() => '?').join(',')
    const rows = db.prepare(`SELECT turn_id,role,text,created_at FROM raw_turns
      WHERE agent_id=? AND turn_id IN (${ph}) ORDER BY created_at`).all(aid, ...list)
    for (const r of rows) {
      if (!map.has(r.turn_id)) map.set(r.turn_id, [])
      map.get(r.turn_id).push(r)
    }
  } catch { /* 老库没有原文层就退回时间窗 */ }
  return map
}

/** 最近 N 条「我说话时的感觉」（界面「我最近怎么感觉」用）。只读，不改任何状态。 */
export function listFeels(db, aid, { limit = 20 } = {}) {
  const n = Math.max(1, Math.min(100, Number(limit) || 20))
  try {
    const items = db.prepare('SELECT id,at,text,label,fast,slow,total,session_id,source,turn_id FROM affect_feel WHERE agent_id=? ORDER BY at DESC LIMIT ?').all(aid, n)
      .map((r) => ({ ...r, text: String(r.text || '') }))
    const byTurn = turnsByTurnIds(db, aid, items.map((f) => f.turn_id))
    const turns = turnsOf(db, aid, new Date(Date.now() - 2 * 3600000).toISOString())
    return items.map((f) => ({ ...f, around: aroundOfFeel(byTurn.get(f.turn_id), turns, f.at, f.turn_id) }))
  } catch { return [] }
}

/** 单条 feel；找不到返回 null。也带前后那两句对话。 */
export function getFeel(db, aid, id) {
  try {
    const r = db.prepare('SELECT id,at,text,label,fast,slow,total,session_id,source,turn_id FROM affect_feel WHERE agent_id=? AND id=?').get(aid, String(id || ''))
    if (!r) return null
    const at = Date.parse(r.at)
    const since = new Date((Number.isFinite(at) ? at : Date.now()) - 10 * 60000).toISOString()
    const turns = turnsOf(db, aid, since)
    const turnTurns = r.turn_id ? turnsByTurnIds(db, aid, [r.turn_id]).get(r.turn_id) : null
    return { ...r, text: String(r.text || ''), around: aroundOfFeel(turnTurns, turns, r.at, r.turn_id) }
  } catch { return null }
}

/**
 * 给记忆挂 feel 用的取数口：最近一条、窗口内才算（feel.attach.window，默认 30 分钟）。
 * memory.js 通过 setFeelProvider 注入它——记忆模块不直接读 affect_feel（INV10）。
 */
export function attachableFeelId(db, aid) {
  try {
    const min = Math.max(1, Number(getParam(db, aid, 'feel.attach.window')) || 30)
    const f = db.prepare('SELECT id, at FROM affect_feel WHERE agent_id=? ORDER BY at DESC LIMIT 1').get(aid)
    if (!f || !f.at) return null
    const age = Date.now() - Date.parse(f.at)
    return Number.isFinite(age) && age >= 0 && age <= min * 60000 ? String(f.id) : null
  } catch { return null }
}

/**
 * 某个时间窗里最近的一条 feel（纪要 / 开环 / 嘀咕挂「那时候什么感觉」用）。
 * 窗口里没有就 null——不拿窗口外的感觉凑数。
 */
export function feelIdIn(db, aid, { from, to } = {}) {
  try {
    const lo = from ? String(from) : new Date(0).toISOString()
    const hi = to ? String(to) : new Date().toISOString()
    const r = db.prepare('SELECT id FROM affect_feel WHERE agent_id=? AND at>=? AND at<=? ORDER BY at DESC LIMIT 1')
      .get(aid, lo, hi)
    return r && r.id ? String(r.id) : null
  } catch { return null }
}

/**
 * 某一天（本地日）写下的所有 feel id，按时间正序。日记用它把当天的感觉串起来。
 * day 形如 2026-11-05；格式不对返回空数组。
 */
export function feelIdsOnDay(db, aid, day) {
  const d = String(day || '')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return []
  try {
    const start = new Date(d + 'T00:00:00')
    if (!Number.isFinite(start.getTime())) return []
    const from = start.toISOString()
    const to = new Date(start.getTime() + 86400000).toISOString()
    return db.prepare('SELECT id FROM affect_feel WHERE agent_id=? AND at>=? AND at<? ORDER BY at')
      .all(aid, from, to).map((r) => String(r.id))
  } catch { return [] }
}

/** 全部 feel id（导入清理悬空引用用）。老库没有这张表就返回空集合。 */
export function feelIdsAll(db) {
  try {
    return new Set(db.prepare('SELECT id FROM affect_feel').all().map((r) => String(r.id)))
  } catch { return new Set() }
}

/** 按 id 批量取 feel（给记忆列表一次挂满，不 N+1）。返回 Map<id, feel>。 */
export function feelsByIds(db, ids) {
  const list = [...new Set((Array.isArray(ids) ? ids : []).filter(Boolean))]
  const map = new Map()
  if (!list.length) return map
  try {
    const ph = list.map(() => '?').join(',')
    for (const f of db.prepare(`SELECT id,at,text,label,fast,slow FROM affect_feel WHERE id IN (${ph})`).all(...list)) {
      map.set(f.id, { id: f.id, at: f.at, text: String(f.text || ''), label: f.label || null, fast: f.fast, slow: f.slow })
    }
  } catch { /* 老库没有这张表就当作没有 */ }
  return map
}

/**
 * 按感觉找东西：给 label / 时间范围，找那几条 feel，顺带带上同时段（±30 分钟）落下的记忆和当天日记。
 * 用途是「什么时候我是开心的」「那阵子到底在为什么事悬着」——不是关键词检索，是感觉检索。
 */
export function feelRecall(db, aid, { label = '', from = null, to = null, limit = 10 } = {}) {
  const n = Math.max(1, Math.min(50, Number(limit) || 10))
  try {
    const where = ['agent_id=?']
    const args = [aid]
    if (label) { where.push('label=?'); args.push(String(label)) }
    if (from) { where.push('at>=?'); args.push(String(from)) }
    if (to) { where.push('at<=?'); args.push(String(to)) }
    const feels = db.prepare(`SELECT id,at,text,label,fast,slow,total,turn_id FROM affect_feel
      WHERE ${where.join(' AND ')} ORDER BY at DESC LIMIT ?`).all(...args, n)
    const out = []
    for (const f of feels) {
      const at = Date.parse(f.at)
      const base = Number.isFinite(at) ? at : Date.now()
      const lo = new Date(base - 30 * 60000).toISOString()
      const hi = new Date(base + 30 * 60000).toISOString()
      let memories = []
      try {
        memories = db.prepare(`SELECT id,text,type,created_at FROM memory_items
          WHERE agent_id=? AND status='active' AND invalid_at IS NULL AND created_at>=? AND created_at<=?
          ORDER BY created_at LIMIT 5`).all(aid, lo, hi)
          .map((r) => ({ id: r.id, text: String(r.text || '').slice(0, 120), type: r.type }))
      } catch { memories = [] }
      let diary = null
      try {
        // 日记的 day 是本地日历日；拿 UTC 日期切片去对，凌晨 0-8 点会差一天
        const day = localDay(new Date(Number.isFinite(at) ? at : Date.now()))
        const d = db.prepare('SELECT id,day,text FROM diaries WHERE agent_id=? AND day=?').get(aid, day)
        if (d) diary = { id: d.id, day: d.day, text: String(d.text || '').slice(0, 200) }
      } catch { diary = null }
      out.push({
        feel: { id: f.id, at: f.at, text: String(f.text || ''), label: f.label || null, fast: f.fast, slow: f.slow, turn_id: f.turn_id || null },
        memories,
        diary,
      })
    }
    return out
  } catch { return [] }
}

/**
 * 感觉 ↔ 情绪事件对照：这条 feel 写完之后 10 分钟内，评价层给这一轮判了什么。
 * 差值/一致率是用来校准的——「我开口前觉得自己是松的，评价层却判我被压住」这种不一致值得看。
 */
export function feelEventContrast(db, aid, { days = 7, limit = 50 } = {}) {
  const n = Math.max(1, Math.min(200, Number(limit) || 50))
  const d = Math.max(1, Math.min(90, Number(days) || 7))
  const since = new Date(Date.now() - d * 86400000).toISOString()
  try {
    const feels = db.prepare('SELECT id,at,text,label,fast,slow FROM affect_feel WHERE agent_id=? AND at>=? ORDER BY at DESC LIMIT ?')
      .all(aid, since, n)
    const pairs = []
    for (const f of feels) {
      const at = Date.parse(f.at)
      if (!Number.isFinite(at)) continue
      const ev = db.prepare(`SELECT id,at,label,sig,gate FROM affect_events
        WHERE agent_id=? AND at>=? AND at<=? ORDER BY at LIMIT 1`)
        .get(aid, new Date(at).toISOString(), new Date(at + 10 * 60000).toISOString())
      if (!ev) {
        pairs.push({ feel_id: f.id, feel_label: f.label, event_id: null })
        continue
      }
      pairs.push({
        feel_id: f.id, feel_label: f.label || null, feel_fast: f.fast, feel_slow: f.slow,
        event_id: ev.id, event_label: ev.label || null, event_sig: ev.sig, gate: ev.gate,
        same_label: !!(f.label && ev.label && f.label === ev.label),
        dt_sec: Math.round((Date.parse(ev.at) - at) / 1000),
      })
    }
    const withEvent = pairs.filter((p) => p.event_id)
    const same = withEvent.filter((p) => p.same_label).length
    return {
      pairs,
      stats: {
        feels: pairs.length,
        with_event: withEvent.length,
        same_label: same,
        same_rate: withEvent.length ? Math.round((same / withEvent.length) * 1000) / 10 : null,
      },
    }
  } catch {
    return { pairs: [], stats: { feels: 0, with_event: 0, same_label: 0, same_rate: null } }
  }
}

/**
 * 渲染成注入用的那一行。只给材料，不给结论：
 * 不写「所以你现在应该…」，让它自己决定这句话要不要影响语气。
 */
export function feelLineOf(row) {
  if (!row || !row.text) return ''
  const bits = []
  if (row.fast != null) bits.push('快 ' + (row.fast >= 0 ? '+' : '') + row.fast.toFixed(2))
  if (row.slow != null) bits.push('慢 ' + (row.slow >= 0 ? '+' : '') + row.slow.toFixed(2))
  const tail = bits.length ? '，那会儿 ' + bits.join(' / ') : ''
  return '（我上一句说出来之前，心里是这样：' + row.text + tail + '。这是我自己的话，不是你说的。）'
}
