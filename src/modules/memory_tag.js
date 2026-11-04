/**
 * 记忆的时间与清晰度标签（B1/B2）。
 *
 * 原来注入的每一条记忆都没有时间：三个月前的一句原话和昨天的一句，在提示里长得
 * 一模一样。人不是这样——人会先想起「那是很早以前的事了」，再想起内容。
 *
 * 这里只做两件事：给年龄、给清晰度，都按 **created_at** 算。
 *
 * 为什么不用 R（可提取性）：tiers.touch() 每次召回都把 last_decay_at 拨回现在，
 * 于是「经常被想起的旧事」R 永远≈1。用 R 当清晰度，等于永远说「我记得清清楚楚」，
 * 恰好是反效果。年龄是客观的，不由复习抹平。
 *
 * 已知的不一致（有意保留）：标签用**真实年龄**，正文模糊用**有效年龄**（复习过的更清楚）。
 * 一条被反复想起的旧事，标签会说「半年前，只记得大概」，正文却可能一个字没删。
 * 这是对的——时间是真的过去了，某段原话我还记得清也是真的。两件事不必统一。
 *
 * 输出很短，因为它是每行记忆的前缀，不是正文：
 *   （3 天前）（2 周前）（3 个月前，有点糊）（一年多前，记不太清）
 */

const DAY_MS = 86400000

/** 这条记忆多少天了。拿不到创建时间就返回 null（调用方不贴标签）。 */
export function ageDays(row, at = Date.now()) {
  const t = Date.parse((row && (row.created_at || row.createdAt)) || '')
  if (!Number.isFinite(t)) return null
  return Math.max(0, (at - t) / DAY_MS)
}

/** 年龄 → 人话。一周内精确到天，之后模糊到周 / 月 / 年。 */
export function agePhrase(days) {
  if (days == null) return ''
  if (days < 1) return ''
  if (days < 7) return Math.floor(days) + ' 天前'
  if (days < 30) return Math.max(1, Math.floor(days / 7)) + ' 周前'
  if (days < 365) return Math.max(1, Math.floor(days / 30)) + ' 个月前'
  return '一年多前'
}

/** 年龄 → 记得到多清楚。不说「忘了」——忘了的就不该被召回。 */
export function clarityPhrase(days) {
  if (days == null) return ''
  if (days < 30) return ''
  if (days < 90) return '有点糊'
  if (days < 365) return '只记得大概'
  return '记不太清'
}

/** 来源 → 徽章。默认（manual / chat / ui / remember）不贴：那本来就是「你说的」。 */
const PROVENANCE = {
  life: '我自己看到的',
  self: '我自己记得的',
  browse: '我自己看到的',
  tool: '我自己看到的',
  extract: '从聊天里记下的',
  episode: '从聊天里记下的',
  summary: '从聊天里记下的',
  consolidate: '我自己想的',
  reflect: '我自己想的',
  subtext: '我自己想的',
}

export function provenanceOf(row) {
  return PROVENANCE[String((row && row.source) || '')] || ''
}

/** 低置信来源：只有「不是原话」的那几类才值得标「不一定对」。 */
const INFERRED = new Set(['extract', 'episode', 'summary', 'consolidate', 'reflect', 'subtext', 'self'])

/**
 * 一整条前缀，含括号。空字符串 = 不贴。
 * 今天发生的由 via='fresh' 单独标「今天刚发生」，这里不重复。
 *
 * opt.provenance=true 时才贴来源徽章；默认 false 保持旧行为（只有 life 带「我自己看到的」），
 * 老测试与老调用逐字不变。低置信只在来源本身是推断/转述时标「不一定对」。
 */
export function memoryTag(row, at = Date.now(), opt = {}) {
  const showAge = !(opt && opt.age === false)
  const d = showAge ? ageDays(row, at) : null
  const source = String((row && row.source) || '')
  const withProv = !!(opt && opt.provenance)
  const own = withProv
    ? provenanceOf(row)
    : (source === 'life' ? '我自己看到的' : '')
  const rawConf = row && row.confidence
  const conf = rawConf == null || rawConf === '' ? NaN : Number(rawConf)
  const low = withProv && INFERRED.has(source) && Number.isFinite(conf) && conf < 0.55
  if (d == null) {
    const parts0 = [own].filter(Boolean)
    if (low) parts0.push('不一定对')
    return parts0.length ? '（' + parts0.join('，') + '）' : ''
  }
  const age = agePhrase(d)
  const clarity = clarityPhrase(d)
  if (!age && !clarity && !own && !low) return ''
  const parts = [own, age, clarity].filter(Boolean)
  if (low) parts.push('不一定对')
  return '（' + parts.join('，') + '）'
}
