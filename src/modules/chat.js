/**
 * 对话轮次查询（表 chat_turns，归属 ops/host 数据面）。
 * 单独文件避免 selfmod ↔ ops 环依赖。
 */
export function listRecentUserTexts(db, aid, limit = 20) {
  try {
    return db.prepare("SELECT text FROM chat_turns WHERE agent_id=? AND role='user' ORDER BY rowid DESC LIMIT ?")
      .all(aid, limit).map((x) => x.text)
  } catch { return [] }
}
