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

/** 软边界：中文小停顿。在这些地方收口，读起来还是一句话，不像被剪断的。 */
const SOFT_BOUNDARY = /[，、；：,;:]/

/**
 * 注入用的「一条」：去掉编号、加粗、换行，只留第一句，最多 max 字。
 * 结构化条目（「1. 事实：… 2. 偏好：…」）只取第一段——注入要的是线索，
 * 细节留给抽屉，别让一段 200 字的长文挤掉别人。
 *
 * 超长时不再硬切在第 max 个字上：
 *   1) 先在**后 40% 的窗口**里找最后一个软边界（，、；：），在那儿收口；
 *      这样既不会为了一个逗号丢掉大半条，也不会停在半个词上。
 *   2) 收口后剩下的尾巴 ≤ 8 字 → 干脆整句给完，别留一个孤零零的「…」。
 *   3) 一个软边界都没有（英文长串 / 没标点）才硬切，并明确加「…」。
 * 软收口不带省略号：省略号是「话说一半」的语气，放在记忆线索里会被念成叹气。
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
  const cap = Math.max(8, Number(max) || 60)
  if (chars.length <= cap) return s
  const limit = Math.min(chars.length, cap)
  const floor = Math.max(1, Math.floor(cap * 0.6))
  let cut = -1
  // 从 limit 本身开始找：正好切在第 max 个字的逗号上也算合格，不必往外多切一个字
  for (let i = Math.min(limit, chars.length - 1); i >= floor; i--) {
    if (SOFT_BOUNDARY.test(chars[i])) { cut = i; break }
  }
  if (cut > 0) {
    // 尾巴太短（比如只剩「的呢」）：整句保留，别为省两个字造一个断句
    if (chars.length - (cut + 1) <= 8) return s
    return chars.slice(0, cut).join('').trimEnd()
  }
  // 硬切时把「…」算进上限：宁可少留一个字，也不要让注入行超长
  return chars.slice(0, cap - 1).join('') + '…'
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
  // 每一格除了正文还带一个 fade 档位：0 = 原样，1~3 = 被模糊了几档。
  // 观测要用它（「这一轮注入的记忆里，有几条是糊的」），不影响预算。
  const push = (key, text, fade = 0) => {
    if (!text) return
    const arr = buckets.get(key) || []
    arr.push({ text, fade: Number(fade) || 0 })
    buckets.set(key, arr)
  }
  for (const b of input.buffer || []) {
    push('buffer', (b.role === 'user' ? '你刚才：' : '我刚说：') + b.text)
  }
  // 被新说法取代的旧记忆（只在回看/深查里出现）：标出来，免得它拿旧版本当现状讲。
  // 配额补位的两条带来源：锚点=一直记着的，新近=今天才发生的。
  // 标记只影响模型怎么用（「这是你自己先想起来的」），不影响预算。
  // 其余条目交给 decorate：调用方按 created_at 给「多久以前 + 记不记得清」（B1/B2）。
  // fade 再往里一层：按年龄把括号 / 数字 / 原话删掉（只删不改）。没有就按原文。
  const decorate = typeof opt.decorate === 'function' ? opt.decorate : null
  // 配额位的来源徽章（不带年龄）：fresh 行原本固定写「今天刚发生」，
  // 会把她自己刚写下的事也写成看不出是谁的。给了这个函数就拼在一起。
  const provTag = typeof opt.provenanceTag === 'function' ? opt.provenanceTag : null
  const freshTag = (it) => {
    if (!provTag) return '（今天刚发生）'
    let p = ''
    try { p = String(provTag(it) || '') } catch { p = '' }
    const inner = p.replace(/^（\s*|）$/g, '')
    return inner ? '（' + inner + '，今天刚发生）' : '（今天刚发生）'
  }

  const fade = typeof opt.fade === 'function' ? opt.fade : null
  for (const it of items) {
    const tag = it.stale ? '（已更新，旧说法）'
      : it.via === 'anchor' ? '（一直记着的）'
        : it.via === 'fresh' ? freshTag(it)
          : decorate ? (decorate(it) || '') : ''
    // 先裁到一行，再往里删。
    // 顺序反了会「白糊」：记忆正文中位 120 字，oneLine 只留前 60 字，
    // 被删的括号 / 数字大多落在 60 字之后 —— 档位记成 1~3，注入的文本却一个字没变。
    let body = oneLine(it.text, 60)
    let level = 0
    if (fade) {
      try {
        // 把裁剪后的正文交给 fade：所见即所删，level>0 就一定真的变了。
        const r = fade({ ...it, text: body })
        if (typeof r === 'string') body = r || body
        else if (r && typeof r === 'object') {
          body = r.text || body
          level = Number(r.level) || 0
        }
      } catch { body = oneLine(it.text, 60); level = 0 }
    }
    push(it.partition, '- ' + tag + body, level)
  }

  const lines = []
  const dropped = []
  for (const key of SECTION_ORDER) {
    const arr = buckets.get(key) || []
    const cap = quota[key] != null ? quota[key] : budget
    let used = 0
    for (const cell of arr) {
      const n = estTokens(cell.text)
      if (used + n > cap) { dropped.push({ section: key, text: cell.text, fade: cell.fade, why: 'quota' }); continue }
      used += n
      lines.push({ section: key, text: cell.text, tokens: n, fade: cell.fade })
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

  const body = lines.map((l) => l.text)
  // 深翻（P2）：这几条是刚翻旧账翻出来的，标注一下，免得她当成「一直记着」讲。
  const deepLine = (opt.deepNote !== false && items.some((x) => x.via === 'deep'))
    ? '（下面这几条是我刚翻旧账翻出来的，记不真切就说不真切，别硬说记得）'
    : ''
  if (deepLine) body.push(deepLine)
  return {
    text: body.join('\n'),
    tokens: total + (deepLine ? estTokens(deepLine) : 0),
    lines,
    dropped,
  }
}
