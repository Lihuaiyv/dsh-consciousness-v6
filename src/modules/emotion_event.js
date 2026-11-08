/**
 * 事件级情绪：一次「被砸中」现在的样子。
 *
 * 为什么单独拎出来（2026-11-07，回查之后）：
 *   回查发现强度其实留得住——强事件之后两小时，`affect_state.intensity` 几乎不掉。
 *   真正的问题不是「衰减太快」，是「留住的东西没接到说话上」。
 *   而且原来情绪和心情挤在一张 `affect_v3` 里：slow 是六小时的心情，fast 是二十分钟的抖动，
 *   两个都不是「那件事」。所以这里把「那件事」单独读出来：一条还没结束的 episode。
 *
 * 只读：不写任何表、不改 intensity、不触发衰减。它只是把已经存在的 episode 整理成一份能用的视图。
 */

import { event } from '../kernel.js'

const MIN = 60000

function parseJson(s) {
  try {
    const v = JSON.parse(String(s || 'null'))
    return v && typeof v === 'object' ? v : null
  } catch {
    return null
  }
}

function num(x) {
  const n = Number(x)
  return Number.isFinite(n) ? n : null
}

/**
 * 一条 episode 走到哪一段了。
 * - rising：还在往上抬（rise_at 在将来）
 * - holding：抬完了，还没打算散（默认 60 分钟内）
 * - fading：已经过了那个窗口，但还没 ended
 */
export function phaseOf(ep, at = Date.now()) {
  const riseAt = Date.parse(ep && ep.rise_at ? ep.rise_at : '')
  const startedAt = Date.parse(ep && ep.started_at ? ep.started_at : '')
  const base = Number.isFinite(riseAt) ? riseAt : startedAt
  if (!Number.isFinite(base)) return 'holding'
  if (at < base) return 'rising'
  if (at - base < 60 * MIN) return 'holding'
  return 'fading'
}

/**
 * 现在有没有「一件事」挂在我身上。
 *
 * @returns {null | {
 *   id: string, label: string|null, intensity: number,
 *   cause: string|null, startedAt: string, ageMin: number,
 *   phase: 'rising'|'holding'|'fading', renewals: number,
 *   riseFrom: number|null, resolution: string|null
 * }}
 */
export function openEmotion(db, aid, { at = Date.now() } = {}) {
  let row = null
  try {
    row = db.prepare(`SELECT id, cause, label, intensity, resolution, started_at, ended_at, renewals, rise_from, rise_at
      FROM affect_episodes WHERE agent_id=? AND ended_at IS NULL AND COALESCE(intensity,0) > 0
      ORDER BY started_at DESC LIMIT 1`).get(aid)
  } catch {
    return null
  }
  if (!row) return null
  const t = Date.parse(row.started_at)
  if (!Number.isFinite(t)) return null
  const intensity = num(row.intensity)
  if (intensity == null || intensity <= 0) return null
  return {
    id: row.id,
    label: row.label || null,
    intensity: Math.round(intensity * 1000) / 1000,
    cause: row.cause ? String(row.cause) : null,
    startedAt: row.started_at,
    ageMin: Math.max(0, Math.round((at - t) / MIN)),
    phase: phaseOf(row, at),
    renewals: Number(row.renewals) || 0,
    riseFrom: num(row.rise_from),
    resolution: row.resolution || null,
  }
}

/**
 * 一条 episode 的强度轨迹：给回放和面板用，不参与任何判断。
 * 从 affect_samples 里取这段时间的 sample，返回 [{ at, intensity, slow, fast }]。
 */
export function traceOf(db, aid, ep, { at = Date.now(), limit = 60 } = {}) {
  if (!ep || !ep.startedAt) return []
  const t0 = Date.parse(ep.startedAt)
  const t1 = Math.min(at, t0 + 6 * 3600000)
  if (!Number.isFinite(t0)) return []
  let rows = []
  try {
    rows = db.prepare(`SELECT at, intensity, slow, fast FROM affect_samples
      WHERE agent_id=? AND at>=? AND at<=? ORDER BY at LIMIT ?`).all(aid, new Date(t0).toISOString(), new Date(t1).toISOString(), Math.max(1, Math.min(200, limit)))
  } catch {
    return []
  }
  return rows.map((r) => {
    const j = parseJson(r.slow) || {}
    return {
      at: r.at,
      intensity: num(r.intensity),
      slow: num(j.slow),
      fast: num(j.fast),
    }
  })
}

/* ───────── 放下（settle）─────────
   三条防作弊，写死在这里：
   1) 只降不升：只动 episode.intensity，绝不碰 slow / fast。
   2) 收益递减：第一次减半，第二次去掉剩下的三分之一，第三次起不再减。
   3) 内容要贴着那件事：note 太短（<8 字）或只是「好吧 / 算了」这种空话，不生效。
   系统不许替她放下：只有这条显式调用会动 intensity；夜里自动的 reappraise 不调它。
*/
const SETTLE_FACTOR = [0.5, 0.667, 1]
/* 空话清单：这些词剥掉之后剩下不足 4 个字，就当这句话没贴着那件事。
   不是关键词黑名单——是「除了这些套话，你什么都没说」。 */
const FILLER = /(好吧|算了|没事|还行|随便|不知道|就这样|过去了|放下了|放下吧|嗯|哦|唉|啊|呀|了|的|吧|呢|嘛)/gu

/** 剥掉套话和标点之后，还剩几个字。 */
function contentLength(text) {
  const left = String(text || '').replace(FILLER, '').replace(/[\s\p{P}\p{S}]/gu, '')
  return Array.from(left).length
}

function prevSettleCount(db, aid, episodeId) {
  try {
    const rows = db.prepare("SELECT payload FROM events WHERE agent_id=? AND type='affect.settle'").all(aid)
    let n = 0
    for (const r of rows) {
      try { if (String(JSON.parse(r.payload || '{}').episode_id || '') === episodeId) n++ } catch { /* ignore */ }
    }
    return n
  } catch { return 0 }
}

/**
 * 把那件事放下一档。只降不升、收益递减、内容得贴着那件事。
 * @returns {{ok:boolean, reason?:string, id?:string, label?:string|null, from?:number, to?:number, times?:number}}
 */
export function settleEmotion(db, aid, { episodeId = null, note = '', at = Date.now() } = {}) {
  const text = String(note || '').trim()
  if (text.length < 8) return { ok: false, reason: 'note_too_short' }
  if (contentLength(text) < 4) return { ok: false, reason: 'generic' }

  let row = null
  try {
    const sel = `SELECT id, label, intensity, resolution, started_at FROM affect_episodes
      WHERE agent_id=? AND ended_at IS NULL AND COALESCE(intensity,0) > 0`
    row = episodeId
      ? db.prepare(sel + ' AND id=? LIMIT 1').get(aid, String(episodeId))
      : db.prepare(sel + ' ORDER BY started_at DESC LIMIT 1').get(aid)
  } catch { return { ok: false, reason: 'db' } }
  if (!row) return { ok: false, reason: 'no_open' }

  const times = prevSettleCount(db, aid, row.id) + 1
  const factor = SETTLE_FACTOR[Math.min(times - 1, SETTLE_FACTOR.length - 1)]
  const from = Number(row.intensity) || 0
  const to = Math.round(from * factor * 1000) / 1000
  if (to >= from) return { ok: false, reason: 'already_flat', id: row.id, from, to, times }

  try {
    db.prepare('UPDATE affect_episodes SET intensity=?, resolution=? WHERE id=?').run(to, 'folded', row.id)
    /* 演练时抓到的坑（2026-11-07）：只降 episode 不够。
       说话用的是 affect_state.intensity，不跟着降的话，我口头说「放下了」、句子还是短的。
       所以只在「当前主情绪就是这条 episode 的标签，而且现在的强度比新值高」时才往下带——
       不新建写入点，也不许往上抬。 */
    if (row.label) {
      try {
        const st = db.prepare('SELECT primary_label, intensity FROM affect_state WHERE agent_id=?').get(aid)
        const cur = st ? Number(st.intensity) : null
        if (st && String(st.primary_label) === String(row.label) && Number.isFinite(cur) && cur > to) {
          db.prepare('UPDATE affect_state SET intensity=?, updated_at=? WHERE agent_id=?').run(to, new Date(at).toISOString(), aid)
        }
      } catch { /* 没有 affect_state 这一行就不管，别为它把主流程挂了 */ }
    }
    event(db, aid, 'affect.settle', { episode_id: row.id, from, to, times })
  } catch { return { ok: false, reason: 'write_failed' } }
  return { ok: true, id: row.id, label: row.label || null, from, to, times }
}
