/**
 * 记忆温度的低层写入单点：冷 / 温 / 热，只动 temp_state / state_since / state_streak。
 *
 * 为什么单独一层：memory → tiers → temps，而 temps 又要写温度；
 * 直接 import memory 会成环（ESM 会死在 bootstrapped 未初始化）。
 * 这一层只依赖 db.js，memory / temps / features 都从这里写，写权仍归记忆零件。
 */
import { now } from '../db.js'

/**
 * - resetStreak：状态机真的迁了，连击归零；
 * - onlyIfChanged：已经是这个温度就不动，保住原来的 state_since。
 */
export function setMemoryTemp(db, id, state, at = null, opt = {}) {
  const stamp = at || now()
  if (opt.onlyIfChanged) {
    return db.prepare("UPDATE memory_items SET temp_state=?, state_since=? WHERE id=? AND (temp_state IS NULL OR temp_state<>?)")
      .run(state, stamp, id, state).changes || 0
  }
  if (opt.resetStreak) {
    return db.prepare('UPDATE memory_items SET temp_state=?, state_since=?, state_streak=0 WHERE id=?')
      .run(state, stamp, id).changes || 0
  }
  return db.prepare('UPDATE memory_items SET temp_state=?, state_since=? WHERE id=?')
    .run(state, stamp, id).changes || 0
}

/** 温度没迁时的连击计数：只给状态机用。 */
export function setMemoryStateStreak(db, id, streak) {
  db.prepare('UPDATE memory_items SET state_streak=? WHERE id=?').run(Number(streak) || 0, id)
}
