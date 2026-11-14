/**
 * 候选池（P3 的地基）：把各路「想起」收成一种形状，**只出候选，不直接进提示词**。
 *
 * 2026-11-13：现在五条通道各拼各的（检索 / 事件 / pulse / 情绪 / 引语 / 开环），
 * 互不知道、抢同一个 800。这里先把「形状」统一：
 *   { source, id, text, detail, score, confidence, meta }
 * 排序与预算由调用方（将来的 planner）决定，本模块不写库、不碰提示词。
 *
 * 注意：这是**未接线**的底座——现在没有任何注入路径调用它；
 * 接线放 P3，等真库重启、事件链验过之后再做。
 */
import { recallEvents } from './event_recall.js'

/**
 * 收集候选。
 * @param {object} opt
 *  - query: 这句话（用于事件撞抓手）
 *  - memories: 已召回的记忆（调用方从 retrieve 拿，形状 {id,text,score,type,band,confidence}）
 *  - limit: 每路最多取几条
 */
export function collectCandidates(db, aid, opt = {}) {
  const out = []
  const query = String(opt.query || '').trim()
  const limit = Math.max(1, Math.min(20, Number(opt.limit) || 3))

  // 1) 事件：撞抓手（只收「待联想」，recallEvents 自己管）
  if (query) {
    try {
      const r = recallEventsSafe(db, aid, query, { limit })
      for (const it of r.items || []) {
        out.push({
          source: 'event', id: it.id, text: it.title, detail: it.story,
          score: Number(it.score) || 0, confidence: 0.8,
          meta: { want: it.want, weight: it.weight, status: it.status },
        })
      }
    } catch { /* 事件库没有也不影响别的路 */ }
  }

  // 2) 记忆：不在这里重跑检索，由调用方传进来
  for (const m of Array.isArray(opt.memories) ? opt.memories : []) {
    if (!m || !m.id) continue
    out.push({
      source: 'memory', id: m.id, text: String(m.text || ''),
      score: Number(m.score != null ? m.score : (m.heat || m.weight || 0.5)),
      confidence: Number(m.confidence != null ? m.confidence : 0.6),
      meta: { type: m.type, band: m.band },
    })
  }

  // 3) pulse：队列里的候选（直塞关着时只排不消费）
  try {
    const rows = db.prepare(`SELECT id, memory_id, reason, created_at FROM surface_queue
      WHERE agent_id=? AND state='pending' ORDER BY created_at DESC LIMIT ?`).all(aid, limit)
    for (const r of rows) {
      out.push({ source: 'pulse', id: r.memory_id || r.id, text: '', score: 0.45, confidence: 0.4, meta: { reason: r.reason } })
    }
  } catch { /* 老库没有队列 */ }

  // 4) 开环：答应过 / 到点的事
  try {
    const rows = db.prepare(`SELECT id, text, memory_id, due_at FROM open_loops
      WHERE agent_id=? AND state='open' ORDER BY COALESCE(due_at,'9999') LIMIT ?`).all(aid, Math.min(2, limit))
    for (const r of rows) {
      out.push({ source: 'loop', id: r.memory_id || r.id, text: String(r.text || ''), score: 0.5, confidence: 0.5, meta: { due_at: r.due_at } })
    }
  } catch { /* 老库没有开环 */ }

  return out
}

/** 排序 + 去重（同一件事只留一条）。不丢弃，只排队。 */
export function rankCandidates(list, { limit = 3 } = {}) {
  const seen = new Set()
  const out = []
  const sorted = [...(list || [])].sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0))
  for (const c of sorted) {
    if (!c) continue
    // 事件按 id 去重；其余按正文前 80 字（同一句话别占两个名额）
    const key = c.source === 'event' ? 'event:' + c.id : 'text:' + String(c.text || c.id || '').slice(0, 80)
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(c)
    if (out.length >= Math.max(1, limit)) break
  }
  return out
}

/** 一轮只留一条「自己想起」。 */
export function pickOne(list) {
  return rankCandidates(list, { limit: 1 })[0] || null
}

/** 事件撞手抓的薄封装：没表/没模型都不该让候选池整段挂掉。 */
function recallEventsSafe(db, aid, query, opt) {
  try {
    return recallEvents(db, aid, query, opt)
  } catch {
    return { items: [] }
  }
}
