/**
 * 属性冲突：不靠否定词的那种矛盾。
 *
 * 「昨天喝的咖啡是热的」vs「…是冰的」——整句里一个否定词都没有，
 * 可它们明明对不上。否定词判据（不/没/未/无/别）在这里全失效。
 *
 * 做法：把已知的互斥取值（热/冰、喜欢/讨厌…）换成占位符再比「骨架」。
 *   骨架几乎一样（咖啡是〇的）＋ 取值不同 ⇒ 同一件事的两种说法。
 * 只比一句一句的骨架，不拿整段摘要互相比——摘要里三段话主题不同，
 * 整段比会把「温度」跟「口味」搅在一起。
 */

/** 互斥取值组：同一组里的两个值不能同时成立。只收语义明确、不容易混进别处的词。 */
export const VALUE_GROUPS = [
  ['热', '冰', '冷', '凉', '烫'],
  ['喜欢', '讨厌'],
  ['好吃', '难吃'],
  ['开心', '难过'],
]

const ALL_VALUES = VALUE_GROUPS.flat().sort((a, b) => b.length - a.length)
const SLOT = '〇'

function chars(text) {
  return new Set(String(text || '').match(/[\u4e00-\u9fff]|[a-zA-Z0-9]/g) || [])
}

function jaccard(a, b) {
  const A = chars(a)
  const B = chars(b)
  if (!A.size || !B.size) return 0
  let inter = 0
  for (const c of A) if (B.has(c)) inter++
  return inter / (A.size + B.size - inter)
}

/** 只把这一组的取值换成占位符：别的组留着，免得「热咖啡」和「喜欢咖啡」也撞成一样。 */
export function maskValues(text, group = ALL_VALUES) {
  let s = String(text || '')
  for (const v of group) s = s.split(v).join(SLOT)
  return s
}

/** 一句话里属于这一组的取值（去重，按出现顺序）。 */
export function valuesIn(sentence, group) {
  const out = []
  let s = String(sentence || '')
  for (const v of [...group].sort((a, b) => b.length - a.length)) {
    if (s.includes(v)) {
      out.push(v)
      s = s.split(v).join('')
    }
  }
  return out
}

/** 拆句：句号/问号/分号/换行都断，顺手去掉摘要的「1. 」编号。 */
export function sentences(text) {
  return String(text || '')
    .split(/[。！？!?；;\n]+/)
    .map((s) => s.replace(/^\s*\d+[.、)]\s*/, '').trim())
    .filter((s) => s.length >= 4)
}

/**
 * 两段文字里有没有「同一骨架、不同取值」。
 * @param {string} aText
 * @param {string} bText
 * @returns {null|{group:string, a:string, b:string, score:number, sentence_a:string, sentence_b:string}}
 */
export function attrConflict(aText, bText) {
  const A = sentences(aText)
  const B = sentences(bText)
  if (!A.length || !B.length) return null
  for (const sa of A) {
    for (const sb of B) {
      for (const group of VALUE_GROUPS) {
        const va = valuesIn(sa, group)
        const vb = valuesIn(sb, group)
        // 一句里同时出现「冰/热」这种并列说法（比如摘要里的「对冰/热咖啡的偏好」）就不判
        if (va.length !== 1 || vb.length !== 1 || va[0] === vb[0]) continue
        const ka = maskValues(sa, group)
        const kb = maskValues(sb, group)
        if (ka.length < 5 || kb.length < 5) continue
        const score = jaccard(ka, kb)
        if (score >= 0.85) {
          return {
            group: group.join('/'),
            a: va[0],
            b: vb[0],
            score: +score.toFixed(3),
            sentence_a: sa.slice(0, 100),
            sentence_b: sb.slice(0, 100),
          }
        }
      }
    }
  }
  return null
}
