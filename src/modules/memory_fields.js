/**
 * 记忆字段的低层写入单点：温度、热度、命中、检索字段。
 *
 * 为什么单独一层：memory → tiers → temps，而 tiers / temps 又要写这些字段；
 * 直接 import memory 会成环（ESM 会死在 bootstrapped 未初始化）。
 * 这一层只依赖 db.js，memory / tiers / temps / gate 都从这里写，写权仍归记忆零件。
 */
import { now } from '../db.js'

/**
 * 温度（冷 / 温 / 热）：只改 temp_state / state_since。
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

/** 热度 / 档位：刷新或强化时写。 */
export function setMemoryHeat(db, id, heat, band) {
  db.prepare('UPDATE memory_items SET heat=?, band=? WHERE id=?').run(heat, band, id)
}

/** 被想起一次：命中 +1、稳定性上调、锚点拨回现在、热度重算。 */
export function bumpMemoryHit(db, id, { at = null, stability, heat, band } = {}) {
  const stamp = at == null ? now() : (typeof at === 'number' ? new Date(at).toISOString() : at)
  db.prepare('UPDATE memory_items SET hits=hits+1, last_hit_at=?, last_decay_at=?, stability=?, heat=?, band=? WHERE id=?')
    .run(stamp, stamp, stability, heat, band, id)
}

/** 合并进旧条时的强化：命中 +1、权重加一点（封顶 1）、版本 +1。 */
export function strengthenMemory(db, id, { at = null, delta = 0.02 } = {}) {
  const stamp = at || now()
  db.prepare('UPDATE memory_items SET hits=hits+1, last_hit_at=?, weight=MIN(1, COALESCE(weight,0.5)+?), version=version+1 WHERE id=?')
    .run(stamp, Number(delta) || 0, id)
}

/** 只改检索字段（gate 改写那条）：不动 terms / version，跟 enrich 的卡片写区分开。 */
export function setMemorySearchOnly(db, id, { key = null, searchText = null } = {}) {
  db.prepare('UPDATE memory_items SET search_text=?, fact_key=COALESCE(?, fact_key) WHERE id=?')
    .run(searchText, key, id)
}
