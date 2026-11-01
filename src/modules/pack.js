/**
 * P1b 装箱与仲裁：去重 → 分配配额 → 超预算按优先级丢
 *
 * 检索负责「谁该被想起」，装箱负责「真的塞得进上下文吗」。
 * 两件事分开：召回区里的 top-k 不等于注入区里的 top-k。
 *
 * 顺序：buffer（固定注入）→ T1 → T3 → T2 → T4。
 * 超预算时的丢弃顺序：T4 → T2 → T3 → T1 → buffer（越冷越先丢）。
 */

export const TOTAL_BUDGET = 800

/** 分段配额（token）。T3 的 120 是给 P4 预留的：P4 前这段永远是空的。 */
export const QUOTA = { buffer: 100, T1: 300, T3: 120 }

/** 分区优先级：数字越小越保。同一件事在多区出现时留这个。 */
export const PRIORITY = { T0: 0, T1: 1, T3: 2, T2: 3, T4: 4 }

const SECTION_ORDER = ['buffer', 'T1', 'T3', 'T2', 'T4']
const DROP_ORDER = ['T4', 'T2', 'T3', 'T1', 'buffer']

/** 中文按 2 字符 ≈ 1 token（与 clampInjection 同一套估法）。 */
export function estTokens(text) {
  return Math.ceil(String(text || '').length / 2)
}

function norm(text) {
  return String(text || '').replace(/[\s\p{P}]/gu, '')
}

/**
 * 注入用的「一条」：去掉编号、加粗、换行，只留第一句，最多 max 字。
 * 结构化条目（「1. 事实：… 2. 偏好：…」）只取第一段——注入要的是线索，
 * 细节留给抽屉，别让一段 200 字的长文挤掉别人。
 */
export function oneLine(text, max = 60) {
  let s = String(text || '')
    .replace(/\*\*/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[-•]\s*/, '')
    .replace(/^\d+\s*[.、)]\s*/, '')
  const end = s.search(/[。！？!?]/)
  if (end >= 0) s = s.slice(0, end)
  s = s.trim()
  const chars = Array.from(s)
  return chars.length > max ? chars.slice(0, max).join('') + '…' : s
}

function charSet(text) {
  return new Set(String(text || '').match(/[\u4e00-\u9fff]|[a-zA-Z0-9]/g) || [])
}

/** 近似重复：去标点后字面相同，或字符集 Jaccard ≥ 0.92 且两边都不短。 */
export function isSameText(a, b) {
  const x = norm(a)
  const y = norm(b)
  if (!x || !y) return false
  if (x === y) return true
  if (x.length < 8 || y.length < 8) return false
  const A = charSet(x)
  const B = charSet(y)
  let inter = 0
  for (const c of A) if (B.has(c)) inter++
  const union = A.size + B.size - inter
  return union > 0 && inter / union >= 0.92
}

/**
 * 跨分区去重：同一件事在 T1 和 T4 各出现一次，只留优先级高的那个分区。
 * 次序沿用融合排名；被顶掉的位置由更高优先分区的版本接管。
 */
export function dedupe(items = []) {
  const kept = []
  for (const it of items) {
    const idx = kept.findIndex((k) => isSameText(k.text, it.text))
    if (idx < 0) { kept.push(it); continue }
    const a = PRIORITY[it.partition] ?? 9
    const b = PRIORITY[kept[idx].partition] ?? 9
    if (a < b) kept[idx] = it
  }
  return kept
}

/**
 * 装箱：把固定注入区（buffer）和召回区（items）按配额切成要进上下文的行。
 * @param {{buffer?:Array, items?:Array}} input
 * @param {{budget?:number, quota?:object}} [opt]
 * @returns {{text:string, tokens:number, lines:Array, dropped:Array}}
 */
export function packInjection(input = {}, opt = {}) {
  const budget = Math.max(60, Number(opt.budget) || TOTAL_BUDGET)
  const quota = { ...QUOTA, ...(opt.quota || {}) }
  const items = dedupe(input.items || [])

  const buckets = new Map()
  const push = (key, text) => {
    if (!text) return
    const arr = buckets.get(key) || []
    arr.push(text)
    buckets.set(key, arr)
  }
  for (const b of input.buffer || []) {
    push('buffer', (b.role === 'user' ? '你刚才：' : '我刚说：') + b.text)
  }
  // 被新说法取代的旧记忆（只在回看/深查里出现）：标出来，免得它拿旧版本当现状讲。
  // 「那时」行（G1 as-of）：调用方已裁好长度，且整句带标签，不能再按句号截。
  for (const it of items) {
    if (it.asof) { push(it.partition, '- ' + Array.from(String(it.text)).slice(0, 160).join('')); continue }
    push(it.partition, (it.stale ? '- （已更新，旧说法）' : '- ') + oneLine(it.text, 60))
  }

  const lines = []
  const dropped = []
  for (const key of SECTION_ORDER) {
    const arr = buckets.get(key) || []
    const cap = quota[key] != null ? quota[key] : budget
    let used = 0
    for (const text of arr) {
      const n = estTokens(text)
      if (used + n > cap) { dropped.push({ section: key, text, why: 'quota' }); continue }
      used += n
      lines.push({ section: key, text, tokens: n })
    }
  }

  let total = lines.reduce((s, l) => s + l.tokens, 0)
  for (const key of DROP_ORDER) {
    if (total <= budget) break
    for (let i = lines.length - 1; i >= 0 && total > budget; i--) {
      if (lines[i].section !== key) continue
      total -= lines[i].tokens
      dropped.push({ ...lines[i], why: 'budget' })
      lines.splice(i, 1)
    }
  }

  return { text: lines.map((l) => l.text).join('\n'), tokens: total, lines, dropped }
}
