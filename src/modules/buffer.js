/**
 * 会话缓冲（P1a · 补丁①）
 *
 * 这一轮的话还没写进 T4 之前，先挂在这里：注入只取「最近 2 轮」，
 * 保留上限 20 条只是为了重启 / 重连时能重放「刚才说到哪」。
 *
 * 只在内存里，进程没了就没了——真正的账在 raw_turns（T4）；
 * hydrateFromRaw() 负责把最近一个会话的尾巴从 T4 捞回来。
 */

const MAX_TURNS = 20

/** @type {Map<string, Array<{role:string,text:string,at:string,sessionId:string|null}>>} */
const BUFFERS = new Map()

/** 追加一条（user / assistant 都算），超出上限丢最老的。 */
export function pushTurn(aid, turn = {}) {
  const text = String(turn.text || '')
  if (!aid || !text.trim()) return 0
  const list = BUFFERS.get(aid) || []
  list.push({
    role: String(turn.role || 'user'),
    text,
    at: String(turn.at || new Date().toISOString()),
    sessionId: turn.sessionId ? String(turn.sessionId) : null,
  })
  while (list.length > MAX_TURNS) list.shift()
  BUFFERS.set(aid, list)
  return list.length
}

/** 全部（最多 20 条），旧 → 新。 */
export function replay(aid) {
  return [...(BUFFERS.get(aid) || [])]
}

/** 最近 rounds 轮；一轮 = 你一句 + 我一句，默认 2 轮 → 最多 4 条。 */
export function recentRounds(aid, rounds = 2) {
  const all = BUFFERS.get(aid) || []
  const n = Math.max(1, Number(rounds) || 2) * 2
  return all.slice(-n)
}

export function clearBuffer(aid) {
  BUFFERS.delete(aid)
}

/** 当前缓冲条数（面板 / 测试看用）。 */
export function bufferSize(aid) {
  return (BUFFERS.get(aid) || []).length
}

/** 重启后从 T4 重放最近一个会话的尾巴，保住「刚才说到哪」。 */
export function hydrateFromRaw(db, aid) {
  let last = null
  try {
    last = db.prepare('SELECT session_id FROM raw_turns WHERE agent_id=? ORDER BY created_at DESC LIMIT 1').get(aid)
  } catch { return 0 }
  if (!last) return 0
  const rows = db.prepare(`SELECT role,text,created_at FROM raw_turns
    WHERE agent_id=? AND session_id=? ORDER BY created_at DESC, seq DESC LIMIT ?`).all(aid, last.session_id, MAX_TURNS)
  BUFFERS.set(aid, rows.reverse().map((r) => ({
    role: r.role, text: r.text, at: r.created_at, sessionId: last.session_id,
  })))
  return rows.length
}
