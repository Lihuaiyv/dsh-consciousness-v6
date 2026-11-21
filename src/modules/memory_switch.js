/**
 * 记忆写入的开关（P2 收写用）。
 *
 * `memory.episode.write`：停「每轮原话」这一类 episode（source='manual'，由 commitTurn / chatReply 写的那条）。
 * 2026-11-22 主人定：这条旧路径已经停了——两个写点（`index.js` 的 commitTurn、`features.js` 的 chatReply）
 * 连同 `episodeWriteEnabled` 一起删掉。原话只留碎片，事实库 memory_items 不再收每轮原话。
 * 要回旧路：从 git 历史取回函数与两个写点，并把 `memory.legacy.fact` 设成 on。
 *
 * 注意它当年就不是「停所有 episode」：self（自我经历）/ life（生活流）/ work-digest / extract
 * 不走这两个写点，开关碰不到它们。
 *
 * `memory.workdigest.write`：停「工作段摘记」（source='work-digest'，也写在 memory_items）。
 *
 * 它和上面的 episode 是同一类东西——把工作段的一两句原话再给事实库记一遍。
 * `记忆库.xmind` 上没有这一格：图里往事实库写原话的只有「每轮原话 episode」，
 * 而且已经标了「待删，未来将替换为事件」。所以这一类是不该有的第二种原话。
 *
 * 默认 **on**（旧行为），显式 `off` 才停；回滚就是删掉那行 flag。
 */
export function workDigestEnabled(db) {
  try {
    const r = db.prepare("SELECT value FROM flags WHERE key='memory.workdigest.write'").get()
    return !r || String(r.value).toLowerCase() !== 'off'
  } catch {
    return true
  }
}
