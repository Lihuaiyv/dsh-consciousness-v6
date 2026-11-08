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
  input = input || {}
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

// 注入预算：估算 token（中文按 2 字符≈1 token）。这是**硬上限**：
// ① 先按「主动句 → 情绪 → 驱力 → 日记 → 记忆」整段丢；
// ② 还超就从日记 / 记忆块里按行往回砍（保留标题行）；
// ③ 最后再超才硬截断（留省略号），保证返回的 tokens ≤ budget。
export function clampInjection(lines, budget = 800) {
  const est = (t) => Math.ceil(String(t).length / 2)
  const cap = Math.max(40, Number(budget) || 800)
  // 行可以是字符串，也可以是 { text, key }。带 key 的行用于「先拼装、后落账」：
  // 只有真的留在最终文本里的 key 才算说过；被整行丢掉、被削断的都不算。
  const parts = []
  const keys = []
  const src = Array.isArray(lines) ? lines : []
  for (let i = 0; i < src.length; i++) {
    const l = src[i]
    parts.push(typeof l === 'string' ? l : String((l && l.text) || ''))
    keys.push(typeof l === 'string' ? '#' + i : String(l && l.key != null ? l.key : '#' + i))
  }
  const dropped = []
  const removed = new Set()
  const total = () => est(parts.join('\n'))
  const dropAt = (idx, label) => {
    if (idx < 0 || idx >= parts.length) return false
    removed.add(keys[idx])
    parts.splice(idx, 1)
    keys.splice(idx, 1)
    if (label) dropped.push(label)
    return true
  }
  // 丢的顺序 = 丢得起的顺序。改过一次（A2）：情绪原来排第 2，一挤就先没了。
  // 现在情绪根本不进丢弃名单——它只有两行，却是人格的锚：
  // 丢一条记忆伤准确度，丢情绪伤的是「她是谁」。真到极限，宁可削短别的行。
  // 情绪抬头现在是「这会儿大概：」/「现在：」（expression_state.feltLine）；旧名「感觉现在大概」保留兼容。
  // 「现在：」和时间行同前缀，这里不按它匹配，免得误保护时间行。
  const AFFECT_TEST = (l) => l.startsWith('此刻情绪') || l.startsWith('感觉现在大概') || l.startsWith('这会儿大概') || l.startsWith('现在的情绪是') || l.startsWith('此刻我') || l.startsWith('我想怎么说') || l.startsWith('这一轮怎么写')
  /* 感受快照：**要么整行，要么没有**。它比别的行更怕被剪——
     剪掉尾巴就剩「（上一句落在我身上的样子：你说「…」，那一刻 慢 +0.1…」，
     一半材料读起来比没有更糟：像一句没说完的自言自语。 */
  const SNAPSHOT_TEST = (l) => l.startsWith('（上一句落在我身上') || /^（\d\d:\d\d 那会儿的读数/.test(String(l))
  const order = [
    ['examples', (l) => l.startsWith('## 我说话的样子')],
    ['guard', (l) => l.startsWith('不要列点')],
    ['drive', (l) => l.startsWith('需求缺口档位')],
    ['diary', (l) => l.startsWith('最近我自己写下的')],
    ['memory', (l) => l.startsWith('关于这句话，你能想起的事')],
    // 主动句排在记忆之后才丢：它是「已经决定要说的话」，又只有一行。
    // 以前排第一个丢，结果每轮都被预算先吃掉，commit_after_pack 下永远落不了账，
    // 队列里的消息只能等 ops 七天过期，等于这个功能静默死了（见 2026-11-05 的账）。
    ['proactive', (l) => l.startsWith('（你之前想主动说一句')],
    // 开环 / 续接 / 自发浮现排在记忆之后丢：它们是「自己先想起来的」，比一条泛记忆更该被说出来
    ['loop', (l) => l.startsWith('（你自己心里还挂着的事')],
    ['bridge', (l) => l.startsWith('（上次（')],
    // 收尾念头和潜台词都比「自己想起的事」更可丢：丢了只是正常聊
    ['closing', (l) => l.startsWith('（你有点想收尾了')],
    ['subtext', (l) => l.startsWith('（心里其实')],
    // 关系余量：比潜台词更可丢；丢了只是下一轮少一句「上一句有点硬」。
    ['residue', (l) => l.startsWith('（上一句你说得') || l.startsWith('（上一句你比平时')],
    // 情绪的方向：一行，丢了只是少个「这两天」的层次，不影响这一轮聊下去
    ['trend', (l) => l.startsWith('（这两天')],
    ['spontaneous', (l) => l.startsWith('（你心里忽然浮上来')],
    // 感受快照：比上面都晚丢（它是「刚才那一刻」的事实，不是装饰），
    // 但预算真紧的时候还是让位——而且只允许整行丢，不许剪半句（见 SNAPSHOT_TEST）。
    ['snapshot', (l) => SNAPSHOT_TEST(l)],
  ]
  for (const [name, test] of order) {
    if (total() <= cap) break
    const idx = parts.findIndex((l) => test(l))
    if (idx >= 0) dropAt(idx, name)
  }
  // 段级丢完还超：先砍日记（叙事，隔天还能补），再砍记忆；记忆留 2 条兜底。
  const trimBlock = (test, label, keep = 1) => {
    const idx = parts.findIndex((l) => test(l))
    if (idx < 0) return false
    const sub = String(parts[idx]).split('\n')
    if (sub.length <= 1) { dropAt(idx, label); return true }
    if (sub.length <= keep) return false
    let touched = false
    while (sub.length > keep && total() > cap) { sub.pop(); parts[idx] = sub.join('\n'); touched = true }
    // 一段被砍过就不再是完整注入；带 key 的行（落账用）不能算说过。
    if (touched && !removed.has(keys[idx])) removed.add(keys[idx])
    if (touched) dropped.push(label + '-lines')
    return touched
  }
  if (total() > cap) trimBlock((l) => l.startsWith('最近我自己写下的'), 'diary', 1)
  trimBlock((l) => l.startsWith('关于这句话，你能想起的事'), 'memory', 3)
  /* 快照：要么完整，要么没有。在 shrink 之前就整行拿掉——
     它是那种「剪一半就变味」的行（剩下「…那一刻 慢 +0.1…」，读起来像自言自语没说完）。 */
  if (total() > cap) {
    const si = parts.findIndex((l) => SNAPSHOT_TEST(l))
    if (si >= 0) dropAt(si, 'snapshot-full')
  }
  // 还超：不删情绪那一行，改削别的长行（关系数字、约束这类）。
  // 以前这里直接硬截，谁站得靠后就先烂；削长行等于把预算从「最占地方又不最要紧」的地方拿回来。
  // 第一轮只削非情绪行；真到极限才动情绪行，而且留 20 字底线——宁可说得短，不能没得说。
  if (total() > cap) {
    const shrink = (allowAffect) => {
      const list = parts
        .map((l, i) => ({ l, i }))
        .filter((x) => !x.l.startsWith('## ')
          && !SNAPSHOT_TEST(x.l)
          && x.l.length > (allowAffect ? 20 : 16)
          && (allowAffect || !AFFECT_TEST(x.l)))
        .sort((a, b) => b.l.length - a.l.length)
      for (const { i } of list) {
        if (total() <= cap) break
        const cur = parts[i]
        const needChars = Math.max(4, (total() - cap) * 2 + 2)
        const floor = allowAffect ? 20 : 12
        const keep = Math.max(floor, cur.length - needChars)
        if (keep >= cur.length) continue
        parts[i] = cur.slice(0, keep).replace(/\s+$/, '') + '…'
        // 削断了就不算完整说过：下一轮宁可重来，也别把半句记成落账。
        if (!removed.has(keys[i])) removed.add(keys[i])
        const tag = allowAffect ? 'shrink-affect' : 'shrink'
        if (!dropped.includes(tag)) dropped.push(tag)
      }
    }
    shrink(false)
    shrink(true)
  }
  let text = parts.join('\n')
  if (est(text) > cap) {
    text = text.slice(0, Math.max(0, cap * 2 - 1)).replace(/\s+$/, '') + '…'
    // 硬截断后整段都不可信，所有带 key 的行都不落账。
    for (const k of keys) removed.add(k)
    dropped.push('truncate')
  }
  const kept = new Set(keys.filter((k) => !removed.has(k)))
  return { text, tokens: est(text), dropped, kept, removed }
}
