/**
 * work 模式（面板「日常 / 工作」按钮）的统一判定。
 *
 * 只认 agents.mode：显式点了「工作」才算 work，其余（daily、读不到、库出错）
 * 一律按日常处理——降载的方向永远宁可少省，不能因为一次读库失败把记忆写粗。
 *
 * 2026-11-13：工作模式下只降「后台理解型」模型调用（抽取/判定/增强/夜间加工），
 * 不碰回复、检索、原文、情绪、关系规则——所以干活时照样接得住人，也照样记得住。
 */

export function isWorkMode(db, aid) {
  try {
    const r = db.prepare('SELECT mode FROM agents WHERE id=?').get(aid)
    return !!(r && String(r.mode) === 'work')
  } catch { return false }
}
