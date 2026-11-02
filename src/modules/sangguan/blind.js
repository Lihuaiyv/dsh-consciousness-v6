/**
 * 盲拆对照（P1）：同一句话，带注入 / 不带注入各答一次，看行为有没有真的不一样。
 *
 * 只做度量，不调模型：模型调用在脚本里，这里只回答「两次回答算不算不同」。
 * 判定用字面 bigram Jaccard，不是语义——语义判定要再上一个模型，会把「像」当成「是」。
 */

function norm(s) {
  return String(s || '').replace(/\s+/g, '').replace(/[，。！？、；：""''（）()《》【】]/g, '')
}

function grams(s) {
  const t = norm(s)
  const out = new Set()
  if (t.length < 2) { if (t) out.add(t); return out }
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2))
  return out
}

/** 0 = 两个回答一模一样；1 = 毫无重叠 */
export function textDistance(a, b) {
  const A = grams(a)
  const B = grams(b)
  if (!A.size && !B.size) return 0
  if (!A.size || !B.size) return 1
  let inter = 0
  for (const x of A) if (B.has(x)) inter++
  const union = A.size + B.size - inter
  return +(1 - inter / Math.max(1, union)).toFixed(4)
}

/**
 * pairs: [{ id, with_inject, without_inject, threshold? }]
 * @returns {{ n, changed, rate, items }} rate = 行为真的变了的比例
 */
export function diffRate(pairs, opt = {}) {
  const def = Number(opt.threshold) > 0 ? Number(opt.threshold) : 0.4
  const rows = (Array.isArray(pairs) ? pairs : []).map((p) => {
    const d = textDistance(p.with_inject, p.without_inject)
    const th = Number(p.threshold) > 0 ? Number(p.threshold) : def
    return { id: p.id, distance: d, changed: d >= th, threshold: th }
  })
  const changed = rows.filter((r) => r.changed).length
  return { n: rows.length, changed, rate: rows.length ? +(changed / rows.length).toFixed(3) : 0, threshold: def, items: rows }
}
