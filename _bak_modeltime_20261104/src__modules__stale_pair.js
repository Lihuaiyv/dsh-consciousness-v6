/**
 * S4 状态词：判断一对冲突说法是不是「没做完 → 做好了」的时间顺序更新。
 *
 * 只用在写入门控（gate 已判 conflict 之后）：
 *   旧条还在「没做完 / 待办 / 等…之后」，新条说「完成 / 做好 / 上线」→ 这是过时，不是争议。
 * 默认关（memory.write.stale_supersede=off）：只记一条观测事件，不改写入行为。
 */
const PENDING = /(还没|尚未|没有做完|没做完|待完成|待办|还在等|在等|等.{0,6}之后|挂着|未完成|没弄|没修|没做)/
// 「完成」单独一个词不算：中文里「等其完成 / 等待完成」很常见，那是目标不是结果。
const DONE = /(做好了|做好|弄好了|弄好|搞定|修好了|修好|上线了|上线|落地了|落地|可以了|完成了|已经完成|已完成|已经做好)/

export function hasPendingState(text) {
  return PENDING.test(String(text || ''))
}

export function hasDoneState(text) {
  return DONE.test(String(text || ''))
}

/** 旧的在等、新的说成了 → 时间顺序明确的更新。 */
export function isStalePair(oldText, newText) {
  const oldS = String(oldText || '')
  const newS = String(newText || '')
  return hasPendingState(oldS) && !hasDoneState(oldS) && hasDoneState(newS)
}
