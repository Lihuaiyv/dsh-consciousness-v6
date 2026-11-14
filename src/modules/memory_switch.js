/**
 * 记忆写入的开关（P2 收写用）。
 *
 * `memory.episode.write`：停「每轮原话」这一类 episode（source='manual'，由 commitTurn / chatReply 写的那条）。
 * 默认 **on**（旧行为），只有显式设成 `off` 才停——翻默认要等切事在真库稳定跑一晚、
 * 事件能盖住当天，见 docs/计划-记忆统一-v2 §P2 与问题登记 D10。
 *
 * 注意它不是「停所有 episode」：self（自我经历）/ life（生活流）/ work-digest / extract 这些
 * 不走这两个写点，开关碰不到它们。
 *
 * 为什么用 flags 而不是 getParam：flags 全局一行就能切，不用改 PARAMS 目录；
 * 回滚也是插一行，哪怕代码还在也能立刻恢复旧路。
 */
export function episodeWriteEnabled(db) {
  try {
    const r = db.prepare("SELECT value FROM flags WHERE key='memory.episode.write'").get()
    return !r || String(r.value).toLowerCase() !== 'off'
  } catch {
    return true
  }
}
