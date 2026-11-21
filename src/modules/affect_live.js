/**
 * 「现在的情绪」读口（2026-11-18）：v4 的当场投影优先，旧 v3.fast 只在 v4 没有或过时时兜底。
 *
 * 为什么单开一格：旧 fast 的读者散在自读、表达档、feel、汇流好几处，
 * 谁都不该自己知道「affect.v4.valence 这个 key」。都从这里拿，换实现只改一处。
 */
import { getFlag } from '../kernel.js'
import { valenceOf } from '../algo/affect_v4.js'

/** v4 当场投影：旗标由 affect_v4_shadow 每轮写；超过 maxAgeMin 分钟视为过时。 */
export function v4ValenceOf(db, aid, { maxAgeMin = 120, conv = '' } = {}) {
  try {
    // 有会话号就先读这一段自己的当场；没有/没写过再退全局（给「现在」和旧数据用）。
    const key = 'affect.v4.valence' + (conv ? '|' + String(conv) : '')
    const raw = getFlag(db, key) || (conv ? getFlag(db, 'affect.v4.valence') : null)
    if (!raw) return null
    const v = JSON.parse(raw) || {}
    if (!Number.isFinite(Number(v.v)) || !Number.isFinite(Date.parse(v.at))) return null
    if ((Date.now() - Date.parse(v.at)) / 60000 > maxAgeMin) return null
    return {
      v: Math.max(-1, Math.min(1, Number(v.v))),
      s: Number(v.s), n: Number(v.n), d: Number(v.d),
      label: v.label ? String(v.label) : null, at: v.at,
    }
  } catch { return null }
}

/** 一维：v4 有就用它，没有返回 null（调用方自己退回旧 fast）。 */
export function liveValenceOf(db, aid, opt) {
  const v = v4ValenceOf(db, aid, opt)
  return v ? v.v : null
}

/** 三轴位置（给要显示 S/N/D 的地方）；没有返回 null。 */
export function liveTriadOf(db, aid, opt) {
  const v = v4ValenceOf(db, aid, opt)
  return v ? { s: v.s, n: v.n, d: v.d, label: v.label, v: v.v, at: v.at } : null
}

export { valenceOf }
