/**
 * 意思指纹（P1b 的零依赖版）
 *
 * 给一句话算一个定长向量：字符 1-gram + 2-gram 哈希进 256 维，按词频加权、L2 归一。
 * 两句话的余弦相似度 = 它们「用字习惯」的重合度，不受语序影响（「喝咖啡不加糖」和
 * 「不加糖喝咖啡」会很像）。
 *
 * 它**不是**神经网络语义向量：同义词（喝啥 / 咖啡）它不懂——那要靠 expand.js 把
 * 口语先扩成词。它擅长的是「字面有交集但说法不同」这一档，正好补 2-gram 覆盖率的短板：
 *   - 覆盖率只看「查询的 gram 在不在正文里」，长短不对称时会失真；
 *   - 余弦是对称的，且短句不会因为句子短就被压死。
 *
 * 零依赖、零下载、单条 <0.1ms；换成真模型时，把 vectorize 换掉即可，接口不变。
 */

export const DIM = 256

const clamp01 = (x) => Math.max(0, Math.min(1, Number(x) || 0))

/** 只留中日韩、字母、数字；标点空白一律不参与相似度。 */
function compact(text) {
  return String(text || '').replace(/[^\u4e00-\u9fffa-zA-Z0-9]/g, '')
}

/** FNV-1a → [0, DIM)。同一个 gram 永远落到同一维。 */
function bucket(gram) {
  let h = 2166136261
  for (let i = 0; i < gram.length; i++) {
    h ^= gram.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0) % DIM
}

/** 一句话的 gram 频次表：中文按字 + 相邻二字，英文数字按整段 + 二字。 */
export function gramsOf(text) {
  const s = compact(text)
  const out = new Map()
  if (!s) return out
  const add = (g) => out.set(g, (out.get(g) || 0) + 1)
  for (let i = 0; i < s.length; i++) {
    add(s[i])
    if (i + 1 < s.length) add(s.slice(i, i + 2))
  }
  return out
}

/**
 * @param {string} text
 * @returns {Float32Array} 已 L2 归一化；空文本返回全零向量
 */
export function vectorize(text) {
  const v = new Float32Array(DIM)
  for (const [g, tf] of gramsOf(text)) {
    v[bucket(g)] += 1 + Math.log(tf)
  }
  let n = 0
  for (let i = 0; i < DIM; i++) n += v[i] * v[i]
  n = Math.sqrt(n)
  if (n > 0) for (let i = 0; i < DIM; i++) v[i] /= n
  return v
}

/** 余弦（两边都已归一化，退化成点积）。范围 0~1。 */
export function cosine(a, b) {
  if (!a || !b) return 0
  let s = 0
  for (let i = 0; i < DIM; i++) s += a[i] * b[i]
  return clamp01(s)
}

/** 一句话对另一句话的指纹相似度（内部各算一次向量；批量时请自己缓存 a）。 */
export function similarity(query, text) {
  return cosine(vectorize(query), vectorize(text))
}

/** 指纹分 → 证据分的折算：完全同句 1.0 → 0.6；共享一半以上的用字 → 过 S3 门。 */
