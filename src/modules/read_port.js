/**
 * 读口 · 统一出口（P3 第一步）：四路候选挑一条，一轮最多一条。
 *
 * 开关 `read.port.unified` 默认 off（旧路：事件行自己拼）。翻 on 才用这个口；
 * 删掉 flag 就回旧路。预算：单条 ≤60 字（约 30 token），远小于读口的 800。
 *
 * 还没做（见问题登记 D30）：同分时「主一条 + 副一句」；写链/读口预算分开；
 * 各路小配额。现在就是一个口、一条。
 */
import { collectCandidates, pickOne } from './candidate_pool.js'

export function unifiedReadOn(db, aid) {
  // 用 flags 一行切，跟 memory.episode.write 同一套：删掉即回旧路。
  try {
    const r = db.prepare("SELECT value FROM flags WHERE key='read.port.unified'").get()
    return !!r && String(r.value).toLowerCase() === 'on'
  } catch {
    return false
  }
}

const TAG = { event: '想起', loop: '还挂着', memory: '记忆', pulse: '念头' }

/** 挑一条，返回 { source, id, text, line }；没有就 null。 */
export function pickReadLine(db, aid, { query = '', memories = [] } = {}) {
  try {
    const cands = collectCandidates(db, aid, { query, memories, limit: 3 })
    const one = pickOne(cands)
    if (!one) return null
    const text = String(one.text || '').replace(/\s+/g, ' ').trim().slice(0, 60)
    if (!text) return null
    return { source: one.source, id: one.id, text, line: `〔${TAG[one.source] || '想起'}〕${text}` }
  } catch {
    return null
  }
}
