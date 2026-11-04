/**
 * 注入预算裁剪（从 features.js 原样搬出，行为不变）。
 *
 * 这是「大脑」的第一个零件：预算不够时先丢哪行，是一条裁决。
 * 它不碰数据库、不碰宿主——给 lines 和 budget，回 text / tokens / dropped / kept / removed。
 *
 * 硬上限规则：
 * ① 先按「主动句 → 示例 → 约束 → 驱力 → 日记 → 记忆」整段丢；
 * ② 还超就从日记 / 记忆块里按行往回砍（保留标题行）；
 * ③ 最后再超才硬截断（留省略号），保证返回的 tokens ≤ budget。
 */
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
  const AFFECT_TEST = (l) => l.startsWith('此刻情绪') || l.startsWith('感觉现在大概') || l.startsWith('现在的情绪是') || l.startsWith('此刻我') || l.startsWith('我想怎么说') || l.startsWith('这一轮怎么写')
  /* 感受快照：**要么整行，要么没有**。它比别的行更怕被剪——
     剪掉尾巴就剩「（上一句落在我身上的样子：你说「…」，那一刻 慢 +0.1…」，
     一半材料读起来比没有更糟：像一句没说完的自言自语。 */
  const SNAPSHOT_TEST = (l) => l.startsWith('（上一句落在我身上') || /^（\d\d:\d\d 那会儿的读数/.test(String(l))
  const order = [
    ['proactive', (l) => l.startsWith('（你之前想主动说一句')],
    ['examples', (l) => l.startsWith('## 我说话的样子')],
    ['guard', (l) => l.startsWith('不要列点')],
    ['drive', (l) => l.startsWith('需求缺口档位')],
    ['diary', (l) => l.startsWith('最近我自己写下的')],
    ['memory', (l) => l.startsWith('关于这句话，你能想起的事')],
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
