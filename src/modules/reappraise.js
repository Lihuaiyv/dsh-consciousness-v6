/**
 * 反刍（R）：对一条被反复想起的旧事，再看一眼。
 *
 * 不是把记忆改掉，也不是重新评价情绪——只记「我后来怎么看」。
 * 为什么要它：记忆只有「当时」和「现在被召回」，没有「我变了」；
 * 自述和日记因此永远只能说当下，说不出「上次我觉得……现在……」。
 *
 * 三条纪律：
 *   1) 只读：不改 memory_items，不改 affect_*，只写一条 events。
 *   2) 有闸：同一条 30 天一次；负面的事连续两次没变淡，90 天不再碰（防反刍螺旋）。
 *   3) 没模型就跳过，不写半句空话。
 */
import { event } from '../kernel.js'
import { oneLine } from './pack.js'
import { hostComplete } from './host_llm.js'

const DAY = 86400000

export const REAP = Object.freeze({
  minHits: 3,
  recentHitDays: 7,
  cooldownDays: 30,
  spiralLimit: 2,
  spiralDays: 90,
  // 贴到提示词里的那一行：只播两天，而且一天只播一次。
  // 原来是 7 天 × 每一轮，一句话能连播几百次，久了就成了背景音。
  lineDays: 2,
  lineMax: 2,
})

/** 这句话本身在说「没变」。强度降了也不能算变淡——宁可漏报，不要谎报我变了。 */
const UNCHANGED_RE = /还是|依旧|仍然|照旧|老样子|没变|没淡|没怎么变/

function flagOn(db, aid, key, dflt = 'on') {
  try {
    const row = db.prepare('SELECT value FROM agent_params WHERE agent_id=? AND key=?').get(aid, key)
    if (row) {
      let v = row.value
      try { v = JSON.parse(v) } catch { /* 裸字符串也认 */ }
      return String(v) !== 'off'
    }
  } catch { /* 老库没有参数表 */ }
  return dflt === 'on'
}

function parsePayload(raw) {
  try { return JSON.parse(raw || '{}') } catch { return {} }
}

function reappraisedRecently(db, aid, memoryId, at, days) {
  try {
    return !!db.prepare("SELECT 1 FROM events WHERE agent_id=? AND type='memory.reappraise' AND created_at>=? AND payload LIKE ?")
      .get(aid, new Date(at - days * DAY).toISOString(), '%"memory_id":"' + memoryId + '"%')
  } catch { return false }
}

/** 连续「没变淡」几次：负面记忆反复回看会更沉，要停一停。 */
function spiraled(db, aid, memoryId, at) {
  try {
    const rows = db.prepare("SELECT payload FROM events WHERE agent_id=? AND type='memory.reappraise' AND created_at>=? AND payload LIKE ?")
      .all(aid, new Date(at - REAP.spiralDays * DAY).toISOString(), '%"memory_id":"' + memoryId + '"%')
    const flat = rows.map((r) => parsePayload(r.payload)).filter((p) => p.changed === false)
    return flat.length >= REAP.spiralLimit
  } catch { return false }
}

/**
 * 挑一条：被想起得够多、最近还在被想起、不是钉住的、不在一场没解决的冲突里。
 * @returns {null|{id:string,text:string,hits:number,created_at:string}}
 */
export function pickReappraiseTarget(db, aid, at = Date.now()) {
  if (!flagOn(db, aid, 'reappraise.enabled')) return null
  const since = new Date(at - REAP.recentHitDays * DAY).toISOString()
  let rows = []
  try {
    rows = db.prepare(`SELECT m.id, m.text, m.hits, m.created_at
      FROM memory_items m
      WHERE m.agent_id=? AND m.status='active' AND m.invalid_at IS NULL
        AND m.hits>=? AND m.last_hit_at IS NOT NULL AND m.last_hit_at>=?
        AND m.mark<>'locked' AND m.importance<0.7
        AND NOT EXISTS (SELECT 1 FROM conflicts c
          WHERE c.agent_id=m.agent_id AND c.state='open' AND (c.a_id=m.id OR c.b_id=m.id))
      ORDER BY m.hits DESC, m.last_hit_at DESC LIMIT 8`).all(aid, REAP.minHits, since)
  } catch { rows = [] }
  for (const r of rows) {
    if (reappraisedRecently(db, aid, r.id, at, REAP.cooldownDays)) continue
    if (spiraled(db, aid, r.id, at)) continue
    return { id: r.id, text: String(r.text || ''), hits: Number(r.hits || 0), created_at: r.created_at }
  }
  return null
}

function nearestAffect(db, aid, iso) {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return null
  try {
    // 取记忆出生前后两天的最近一条情绪采样：那才是「当时」。
    // 只查 <= created_at 会漏掉「事后才记下的情绪」。
    const row = db.prepare(`SELECT label, intensity FROM affect_samples
      WHERE agent_id=? AND at>=? AND at<=?
      ORDER BY ABS(julianday(at)-julianday(?)) LIMIT 1`)
      .get(aid, new Date(t - 2 * DAY).toISOString(), new Date(t + 2 * DAY).toISOString(), iso)
    if (row && row.intensity != null) return { label: String(row.label || ''), intensity: Number(row.intensity) }
  } catch { /* 老库没有采样 */ }
  return null
}

function currentAffect(db, aid) {
  try {
    const row = db.prepare('SELECT primary_label AS label, intensity FROM affect_state WHERE agent_id=?').get(aid)
    if (row && row.intensity != null) return { label: String(row.label || ''), intensity: Number(row.intensity) }
  } catch { /* ignore */ }
  return null
}

async function ask(db, model, text, before) {
  const sys = '你在替一个意识体回看一件旧事。用第一人称写一句现在再看的感觉，不超过 60 字，'
    + '像随口说的，不要总结、不要劝自己、不要说「我成长了」，也不要编造新事实。'
    + '只写这一句。'
  const user = '这件事：' + text.slice(0, 300)
    + (before ? '\n当时大概是「' + before.label + '」，强度 ' + before.intensity.toFixed(2) : '')
  try {
    // 2026-11-22 三块排队：事后回看属于夜间整理块，必须排队，不许裸调 model.chat
    const out = await hostComplete(db, {
      label: 'reappraise:ask', block: 'night', timeoutMs: 20000, priority: 6,
      complete: () => model.chat([
        { role: 'system', content: sys },
        { role: 'user', content: user },
      ], 140, false, 0.7),
    })
    return oneLine(String(out || '').replace(/^["'「]|["'」]$/g, '').trim(), 70)
  } catch { return '' }
}

/**
 * 一晚最多一条。
 * @returns {Promise<{ok:boolean, skipped?:string, memory_id?:string, text?:string}>}
 */
export async function reappraiseTick(db, aid, { at = Date.now(), model = null } = {}) {
  if (!flagOn(db, aid, 'reappraise.enabled')) return { ok: false, skipped: 'off' }
  const m = pickReappraiseTarget(db, aid, at)
  if (!m) return { ok: false, skipped: 'nothing' }
  if (!model || typeof model.chat !== 'function') return { ok: false, skipped: 'no_model' }

  const before = nearestAffect(db, aid, m.created_at)
  const text = await ask(db, model, m.text, before)
  if (!text) return { ok: false, skipped: 'empty' }

  const after = currentAffect(db, aid)
  // 只比强度不够：模型可能明写「还是有点烦」，强度却因为整体平了下去而算「变淡」。
  // 文本自己说没变，就以文本为准。
  const changed = before && after ? (after.intensity < before.intensity * 0.75 && !UNCHANGED_RE.test(text)) : null
  try {
    event(db, aid, 'memory.reappraise', {
      memory_id: m.id,
      before,
      after,
      text,
      changed,
      at: new Date(at).toISOString(),
    })
  } catch { /* 记不上就下次再试 */ }
  return { ok: true, memory_id: m.id, text, before, after, changed }
}

/** 这条记忆已经贴过几天了（按天去重，不是按次）。 */
function shownDays(db, aid, memoryId) {
  try {
    const rows = db.prepare("SELECT created_at FROM events WHERE agent_id=? AND type='memory.reappraise.shown' AND payload LIKE ?")
      .all(aid, '%"memory_id":"' + memoryId + '"%')
    return new Set(rows.map((r) => String(r.created_at || '').slice(0, 10))).size
  } catch { return 0 }
}

function shownToday(db, aid, memoryId, at) {
  const day = new Date(at).toISOString().slice(0, 10)
  try {
    return !!db.prepare("SELECT 1 FROM events WHERE agent_id=? AND type='memory.reappraise.shown' AND created_at>=? AND payload LIKE ?")
      .get(aid, day + 'T00:00:00.000Z', '%"memory_id":"' + memoryId + '"%')
  } catch { return false }
}

/** 记「今天已经贴过」：一天一条，不是一轮一条——不然同一句又会刷几百遍。 */
function markShown(db, aid, memoryId, at) {
  try {
    const id = 'evt_' + Date.now().toString(36) + Math.random().toString(16).slice(2, 8)
    const day = new Date(at).toISOString().slice(0, 10)
    db.prepare('INSERT INTO events VALUES(?,?,?,?,?)')
      .run(id, aid, 'memory.reappraise.shown', JSON.stringify({ memory_id: memoryId, day }), new Date(at).toISOString())
  } catch { /* 记不上就不算贴过：下次再说 */ }
}

/**
 * 注入一行：最近两天里「后来再看」、且真判过变淡的那一条。
 * 一天只贴一次，同一条最多贴两天。
 *
 * 原来是一周 × 每一轮：一句话连播几百次，就不再是「我变了」，是背景音——
 * 而且那句可能是「还是有点烦」，本来就没变。
 */
export function reappraiseLine(db, aid, at = Date.now()) {
  if (!flagOn(db, aid, 'reappraise.enabled')) return ''
  try {
    const rows = db.prepare("SELECT payload FROM events WHERE agent_id=? AND type='memory.reappraise' AND created_at>=? ORDER BY created_at DESC LIMIT 6")
      .all(aid, new Date(at - REAP.lineDays * DAY).toISOString())
    for (const r of rows) {
      const p = parsePayload(r.payload)
      if (p.changed !== true || !p.text || !p.memory_id) continue
      if (shownDays(db, aid, p.memory_id) >= REAP.lineMax) continue
      if (shownToday(db, aid, p.memory_id, at)) continue
      markShown(db, aid, p.memory_id, at)
      return '有件事我后来再看：' + oneLine(p.text, 60)
    }
  } catch { /* ignore */ }
  return ''
}

/** 供自述引用：最近 30 天变了的事。 */
export function reappraiseChanges(db, aid, at = Date.now(), limit = 3) {
  try {
    return db.prepare("SELECT payload FROM events WHERE agent_id=? AND type='memory.reappraise' AND created_at>=? ORDER BY created_at DESC LIMIT 30")
      .all(aid, new Date(at - 30 * DAY).toISOString())
      .map((r) => parsePayload(r.payload))
      .filter((p) => p.changed === true && p.text)
      .slice(0, limit)
  } catch { return [] }
}
