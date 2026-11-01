/**
 * 相似度与邻居召回（code-guide Eq.1–2，logic-gates §4）。纯函数：不读时钟、不调模型，向量由调用方备好。
 * 有嵌入的对子用余弦；缺嵌入的对子单独走字面分，不把同批有嵌入的对子一起拖下水。
 */

const norm = (t) => String(t == null ? '' : t).toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')

export function grams(text) {
  const s = [...norm(text)]
  if (s.length < 2) return new Set(s)
  const out = new Set()
  for (let i = 0; i < s.length - 1; i++) out.add(s[i] + s[i + 1])
  return out
}

export function jaccard(a, b) {
  const A = grams(a)
  const B = grams(b)
  if (!A.size || !B.size) return 0
  let inter = 0
  for (const g of A) if (B.has(g)) inter++
  return inter / (A.size + B.size - inter)
}

function charSet(text) {
  return new Set([...norm(text)])
}

function overlap(A, B, how) {
  if (!A.size || !B.size) return 0
  let inter = 0
  for (const g of A) if (B.has(g)) inter++
  return how === 'dice' ? (2 * inter) / (A.size + B.size) : inter / (A.size + B.size - inter)
}

/** 字面分：单字 Jaccard 与二元组 Dice 的平均。整句复制为 1；近义改写靠共享用字，量纲低于余弦。 */
export function lexicalSim(a, b) {
  return (overlap(charSet(a), charSet(b), 'jaccard') + overlap(grams(a), grams(b), 'dice')) / 2
}

export function cosine(u, v) {
  if (!u || !v || u.length !== v.length) return 0
  let dot = 0
  let nu = 0
  let nv = 0
  for (let i = 0; i < u.length; i++) {
    dot += u[i] * v[i]
    nu += u[i] * u[i]
    nv += v[i] * v[i]
  }
  return nu > 0 && nv > 0 ? dot / Math.sqrt(nu * nv) : 0
}

/**
 * Eq.2：N(x) = 同层链头中过线的前 N_nb 个（sim 降序，id 升序破平）。
 * 这一对两边都有同维嵌入 → 余弦，线是 theta_rel；否则字面分，线是 theta_rel_lex。
 * x = { text, vec }；heads = [{ id, text, vec }]。返回 { list:[{ id, sim, mode }], mode }，mode 为 embed | lexical | mixed。
 */
export function neighbors(x, heads, { theta_rel, theta_rel_lex, N_nb }) {
  const relLex = theta_rel_lex == null ? 0.12 : theta_rel_lex
  const qVec = x.vec && x.vec.length ? x.vec : null
  const scored = heads.map((h) => {
    const hVec = h.vec && h.vec.length ? h.vec : null
    const embed = !!(qVec && hVec && hVec.length === qVec.length)
    return { id: h.id, sim: embed ? cosine(qVec, hVec) : lexicalSim(x.text, h.text), mode: embed ? 'embed' : 'lexical' }
  })
  const list = scored
    .filter((r) => r.sim >= (r.mode === 'lexical' ? relLex : theta_rel))
    .sort((a, b) => b.sim - a.sim || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, N_nb)
  const usedLex = scored.some((r) => r.mode === 'lexical')
  const usedEmb = scored.some((r) => r.mode === 'embed')
  const mode = !heads.length ? (qVec ? 'embed' : 'lexical') : usedLex && usedEmb ? 'mixed' : usedEmb ? 'embed' : 'lexical'
  return { list, mode }
}
