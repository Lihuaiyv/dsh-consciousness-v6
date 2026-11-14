/**
 * 向量通道的总开关（2026-11-13 默认停）。
 *
 * 为什么停：memory_vec 停在 11-01，只覆盖 13%（698/5,270）。旧向量还在参与排序，
 * 等于拿十几天前的语义给今天的检索打分。按 v2.1「今天先声明停」：默认不读、不写。
 *
 * 怎么开回来：在 flags 里插一行 `memory.vector.enabled = on`（或改现有值）。
 * 只加这一处开关，不影响 memory_vec 表本身——表还在，只是不读了。
 */
export function vectorEnabled(db) {
  try {
    const r = db.prepare("SELECT value FROM flags WHERE key='memory.vector.enabled'").get()
    return !!r && String(r.value).toLowerCase() === 'on'
  } catch {
    return false
  }
}
