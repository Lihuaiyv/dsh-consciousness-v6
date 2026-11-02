/**
 * 否定判断的唯一口径。
 *
 * 「无误」「无疑」「无问题」里的 无 说的是「没问题」，本身就是正向结论；
 * 拿它当否定词，「确认无误后再进入下一步」和「确认完善后再进入下一步」
 * 这同一句话的两种说法就会被判成「说法相反」，弹一张根本不存在矛盾的冲突卡。
 *
 * 所以先把这些正向否定式整体涂掉，再找否定词。
 * 改这里 = 改 memory.js（整句判否定）和 gate.js（共享片段前判否定）两处口径。
 */

/** 正向否定式：整块不算否定（按长度从长到短扫，避免「无疑问」被「无疑」截断）。 */
export const POSITIVE_NEGATION = [
  '无疑问', '无问题', '无异常', '无差别', '无影响', '无冲突', '无差错', '无疑', '无误', '无碍', '无妨', '无错',
  '不仅', '不但', '不只',
].sort((a, b) => b.length - a.length)

/** 同长度占位：位置不变，也不含任何否定字。 */
const MASK = '　'

export function maskPositive(text) {
  let s = String(text || '')
  for (const w of POSITIVE_NEGATION) {
    if (s.includes(w)) s = s.split(w).join(MASK.repeat(w.length))
  }
  return s
}

/** 这段字里有没有否定词；正向否定式不算。 */
export function hasNegation(text, negatives = '不没未无别') {
  const set = new Set([...negatives])
  return [...maskPositive(text)].some((c) => set.has(c))
}

/** 位置 i 上的这个字，是不是「正向否定式」里的一员（比如 无误 的 无）。 */
export function isPositiveCompoundAt(text, i) {
  const head = String(text || '').slice(i)
  return POSITIVE_NEGATION.some((w) => head.startsWith(w))
}
