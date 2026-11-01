/**
 * P5 遗忘区 · 温度状态机
 *
 * hot → warm → cold → archived，只解决一件事：**哪些记忆还值得每轮被想起来**。
 *   - 90 天没被用过 → cold：退出 S1（每轮），但 S2 回看 / S3 深查照样能捞到
 *   - 180 天没被用过 → archived：只留在归档区，只能显式翻
 *   - 30 天内被想起 ≥ 3 次 → hot
 *   - 其余 → warm
 *
 * 迟滞：目标状态要连续 **2 次**判定一致才真的迁移（hot/warm 之间、warm/cold 之间都一样），
 * 否则「今天多聊了两句」就会让整批记忆在 hot/warm 之间抖动。
 * 钉住（mark=locked）与 taboo/promise 永不下沉。
 *
 * 注意：这不是「删除」。原文与事实都还在，只是不再占每轮的注入预算。
 */

import { now } from '../db.js'

// 注意：这里不 import kernel —— kernel 会连带加载 algo 注册表，而 algo 又回头读 tiers，
// 形成 kernel → algo → tiers → temps → kernel 的环，模块初始化时会踩 TDZ。事件直接写表。
function localEvent(db, aid, type, payload) {
  try {
    const id = 'evt_' + Date.now().toString(36) + Math.random().toString(16).slice(2, 10)
    db.prepare('INSERT INTO events VALUES(?,?,?,?,?)').run(id, aid, type, JSON.stringify(payload), now())
  } catch { /* 记事件失败不影响迁移 */ }
}

export const COLD_DAYS = 90
export const ARCHIVE_DAYS = 180
export const HOT_HITS = 3
export const HOT_WINDOW_DAYS = 30
export const HYSTERESIS = 2

const DAY_MS = 86400000

function anchorOf(row) {
  const t = Date.parse(row.last_hit_at || row.created_at || '')
  return Number.isFinite(t) ? t : Date.now()
}

/** 这条记忆「现在应该是什么温度」。纯函数，方便测。 */
export function targetTemp(row, at = Date.now()) {
  if (!row) return 'warm'
  if (row.mark === 'locked') return 'hot' // 钉住的不下沉
  const age = (at - anchorOf(row)) / DAY_MS
  if (age >= ARCHIVE_DAYS) return 'archived'
  if (age >= COLD_DAYS) return 'cold'
  const recent = Date.parse(row.last_hit_at || '')
  const recentHit = Number.isFinite(recent) && (at - recent) / DAY_MS <= HOT_WINDOW_DAYS
  if (recentHit && Number(row.hits || 0) >= HOT_HITS) return 'hot'
  return 'warm'
}

const RANK = { hot: 3, warm: 2, cold: 1, archived: 0 }

/**
 * 推进一天的状态机。返回迁移清单（只有真的迁了的）。
 * @param {number} [at] 毫秒时间戳（测试用）
 */
export function tickTemps(db, aid, at = Date.now()) {
  let rows = []
  try {
    rows = db.prepare("SELECT id,text,mark,hits,last_hit_at,created_at,temp_state,state_streak FROM memory_items WHERE agent_id=? AND status='active' AND invalid_at IS NULL").all(aid)
  } catch { return [] }

  const changed = []
  const upState = db.prepare('UPDATE memory_items SET temp_state=?, state_since=?, state_streak=0 WHERE id=?')
  const upStreak = db.prepare('UPDATE memory_items SET state_streak=? WHERE id=?')

  for (const r of rows) {
    const cur = String(r.temp_state || 'warm')
    const want = targetTemp(r, at)
    if (want === cur) {
      if (Number(r.state_streak || 0) !== 0) try { upStreak.run(0, r.id) } catch { /* 忽略 */ }
      continue
    }
    const streak = Number(r.state_streak || 0) + 1
    // 往上升（变热）不用等两次：想起来了就是想起来；往下降要迟滞
    const rising = RANK[want] > RANK[cur]
    if (rising || streak >= HYSTERESIS) {
      try {
        upState.run(want, now(), r.id)
        changed.push({ id: r.id, from: cur, to: want, text: String(r.text || '').slice(0, 40) })
        localEvent(db, aid, 'memory.temp_changed', { memory_id: r.id, from: cur, to: want })
      } catch { /* 单条失败跳过 */ }
    } else {
      try { upStreak.run(streak, r.id) } catch { /* 忽略 */ }
    }
  }
  return changed
}

export function tempStats(db, aid) {
  const out = { hot: 0, warm: 0, cold: 0, archived: 0 }
  try {
    const rows = db.prepare("SELECT COALESCE(temp_state,'warm') s, COUNT(*) n FROM memory_items WHERE agent_id=? AND status='active' AND invalid_at IS NULL GROUP BY s").all(aid)
    for (const r of rows) out[r.s] = Number(r.n)
  } catch { /* 老库没有 temp_state 列 */ }
  return out
}

/** S1 每轮是否该看这条：cold / archived 不参与每轮注入。 */
