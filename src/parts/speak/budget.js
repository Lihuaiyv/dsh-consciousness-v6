/**
 * 主动开口 · 今天花了多少额度（零件内）
 *
 * 一句有真事的开口算 1，纯凑数算 2；存在 flags 的 `proactive.spend:<aid>`，跨天自动归零。
 * flags 表是共享基础设施，但这两个键属于开口，只有这个文件写；锁走 kernel。
 */
import { now } from '../../db.js'
import { getFlag, setFlag } from '../../kernel.js'

export function proactiveSpend(db, aid) {
  const today = now().slice(0, 10)
  try {
    const raw = getFlag(db, 'proactive.spend:' + aid)
    if (!raw) return { day: today, n: 0 }
    const o = JSON.parse(raw)
    return { day: o.day === today ? today : '', n: o.day === today ? Number(o.n) || 0 : 0 }
  } catch { return { day: today, n: 0 } }
}

export function addProactiveSpend(db, aid, amount = 1) {
  const today = now().slice(0, 10)
  const cur = proactiveSpend(db, aid)
  const n = (cur.day === today ? cur.n : 0) + Math.max(0, Number(amount) || 0)
  setFlag(db, 'proactive.spend:' + aid, JSON.stringify({ day: today, n }))
  return n
}
