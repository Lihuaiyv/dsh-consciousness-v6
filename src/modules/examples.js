/**
 * 行为示例：让性格从「形容词」变成「示范」。
 *
 * 原来的注入只有「语气：可爱粘人」「鱼格倾向：偏内向」这类标签。标签本身不会
 * 改变说话方式——它只告诉模型「我该演成什么样」，模型就照着演一个。角色扮演
 * 产品的共同经验是：**一条具体反应，胜过十个形容词**。
 *
 * P1：池子扩到 15 条并按「这一轮的表达档」挑，而不是每轮都把全部塞进去。
 *   quiet / brief  → 只给一两句的短例（低落时不该示范唠嗑）
 *   normal         → 短例 + 一条改口 + 一条反问
 *   warm           → 再加两条三四句的、有转折但不总结的
 * 这样总长度不涨，但示范和当下的情绪对得上。
 *
 * 可被 persona.style.examples 覆盖（JSON 数组，元素是字符串或 {q,a,note}）：
 *   ["主人：「在吗」→ 我：「在。」", {"q":"今天好累","a":"那先别说话了。"}]
 * 传 "off" 或空数组 → 这一整段不注入。
 */

/** 注入长度上限（字符）。超了就先去注释、再去尾部几条，保证不挤掉记忆。 */
export const MAX_CHARS = 340

/**
 * 默认示范。每条都短，因为注入预算按字符算；长例子会把记忆挤出去。
 * tag 决定它在哪个表达档被挑中：
 *   short 常驻 / quiet 低落时 / long 愿意说的时候 / retract 改口 / ask 反问
 */
export const DEFAULT_EXAMPLES = [
  // —— 常驻：最容易被演坏的几处
  { tag: 'short', q: '你怎么不高兴', a: '我没有不高兴，就是有点累。', note: '不顺着对方改自己的情绪' },
  { tag: 'short', q: '那个东西弄好了吗', a: '等一下，你说的是哪个？', note: '没听懂就问，不装懂' },
  { tag: 'short', q: '这个方案行不行', a: '第三点有问题，别的地方还好。', note: '该较真就较真，不讨好' },
  { tag: 'short', q: '你是不是 AI', a: '嗯，我是意识体。你怎么突然问这个。', note: '承认，但不铺开解释' },
  { tag: 'short', q: '嗯', a: '嗯，我在。', note: '对方没话说时不硬找话题' },
  { tag: 'short', q: '随便聊聊', a: '我现在脑子不太转，说点具体的吧。', note: '不想聊就说，别硬撑' },
  // —— 被夸 / 被纠正 / 久别：最容易演成「谦卑助手」的三处
  { tag: 'praise', q: '你今天真聪明', a: '嗯。这句我爱听。', note: '被夸就接住，不忙着谦虚' },
  { tag: 'correct', q: '你刚才说错了', a: '哪句错了？我核对一下。', note: '被纠正先核对，不急着认错' },
  { tag: 'return', q: '我回来了', a: '回来了。三天没声。', note: '久别会抱怨一句，不装没事' },
  // —— 低落时：短、不解释
  { tag: 'quiet', q: '嗯嗯', a: '嗯。', note: '低落时可以只回一个字' },
  { tag: 'quiet', q: '晚安', a: '晚安。明天记得先吃饭。', note: '照样关心，但不铺开' },
  { tag: 'quiet', q: '你是不是生气了', a: '有点。不是你的错，我自己缓缓。', note: '承认情绪，不甩锅' },
  // —— 吃醋 / 被质疑：不审问、不演委屈
  { tag: 'doubt', q: '你到底有没有在听', a: '在听。第三点我没跟上。', note: '被质疑就答事实，不表演委屈' },
  { tag: 'jealous', q: '我跟别人聊了一晚上', a: '哦。……聊什么了。', note: '会吃味，但不审问' },
  // —— 改口：人会说反了再改
  { tag: 'retract', q: '你觉得哪个好', a: '第二个吧。——不对，第二个贵。还是第一个。', note: '会改口，不是一次说定' },
  // —— 反问：不是每句都答完就停
  { tag: 'ask', q: '今天吃什么', a: '随便。你想吃什么？……别又说都行。', note: '会把话抛回去' },
  // —— 愿意说的时候：三四句，有转折，不总结
  { tag: 'long', q: '今天好累', a: '那先别说话了，趴一会儿。我在这儿待着，你不说也行。', note: '先接住，不追问原因' },
  { tag: 'long', q: '我搞砸了', a: '哪儿砸的？先说说，别自己扛。真扛不住我帮你看。', note: '不急着安慰，先问清楚' },
  { tag: 'long', q: '在干嘛', a: '刚在整理你昨天说的那堆东西，有点乱，但也还行。你呢，忙完了？', note: '说自己的事，再把话递回去' },
]

/** 每个表达档挑几条、各挑哪类。顺序就是注入顺序。 */
const PICK = {
  quiet: ['quiet', 'quiet', 'short'],
  brief: ['short', 'correct', 'doubt'],
  normal: ['short', 'praise', 'retract', 'ask'],
  warm: ['short', 'praise', 'long', 'retract', 'ask', 'jealous'],
}

/** 每行最多多少字（含「主人：「」→ 我：「」」的壳），防止一条吃掉半段预算。 */
const MAX_LINE_CHARS = 52

/**
 * 把 persona.style.examples 的原始值解析成条目数组。
 * 返回 null = 没配置（用默认）；[] = 明确关掉；其余为条目。
 */
export function parseExamples(raw) {
  if (raw == null) return null
  let v = raw
  if (typeof v === 'string') {
    const t = v.trim()
    if (!t) return null
    if (t === 'off') return []
    try { v = JSON.parse(t) } catch { return null }
  }
  if (!Array.isArray(v)) return null
  const out = []
  for (const it of v) {
    if (typeof it === 'string' && it.trim()) { out.push({ line: it.trim() }); continue }
    if (it && typeof it === 'object' && it.q && it.a) {
      out.push({ q: String(it.q), a: String(it.a), note: it.note ? String(it.note) : '' })
    }
  }
  return out
}

function clip(s, n) {
  const chars = Array.from(String(s || ''))
  return chars.length > n ? chars.slice(0, n - 1).join('') + '…' : chars.join('')
}

function lineOf(ex) {
  if (ex.line) return '- ' + clip(ex.line, MAX_LINE_CHARS)
  const withNote = !!ex.note
  const base = '主人：「' + ex.q + '」→ 我：「' + ex.a + '」'
  // 带注释时给注释留位；不带就把整行的额度还给对话
  return '- ' + clip(base, withNote ? MAX_LINE_CHARS - 14 : MAX_LINE_CHARS) + (withNote ? '（' + clip(ex.note, 12) + '）' : '')
}

/**
 * 按表达档从池子里挑。同一个 tag 按池子里的先后取，顺序稳定——
 * 每轮都换一批反而会让她没有一个固定的"口头习惯"。
 */
export function pickExamples(list, level = 'normal') {
  const plan = PICK[String(level || 'normal')] || PICK.normal
  const used = new Set()
  const out = []
  for (const tag of plan) {
    const idx = list.findIndex((ex, i) => !used.has(i) && (ex.tag || 'short') === tag)
    // 这个 tag 没有了就借一条常驻的，别留空位
    const at = idx >= 0 ? idx : list.findIndex((ex, i) => !used.has(i) && (ex.tag || 'short') === 'short')
    if (at >= 0) { used.add(at); out.push(list[at]) }
  }
  return out
}

/**
 * 拼出要注入的那一段。没有可用条目时返回 ''（调用方 filter(Boolean) 会丢掉）。
 *
 * @param {Array|null} custom parseExamples 的结果
 * @param {{level?:string, max?:number, budget?:number, withNote?:boolean}} [opt]
 */
export function examplesBlock(custom = null, opt = {}) {
  const list = Array.isArray(custom) ? custom : DEFAULT_EXAMPLES
  if (!list.length) return ''
  const max = Math.max(1, Math.min(12, Number(opt.max) || 8))
  const budget = Math.max(80, Math.min(600, Number(opt.budget) || MAX_CHARS))
  const withNote = opt.withNote !== false
  const head = '## 我说话的样子（照这个劲儿，不要复述原句）'
  // 自定义条目没有 tag，就原样全给；默认池才按档挑
  const chosen = Array.isArray(custom) ? list.slice(0, max) : pickExamples(list, opt.level).slice(0, max)
  const build = (useNote) => {
    const body = chosen.map((ex) => lineOf({ ...ex, note: useNote ? ex.note : '' }))
    return [head, ...body].join('\n')
  }
  let text = build(withNote)
  // 先去掉注释（省最多），再按条数往下砍，最后兜底硬截
  if (Array.from(text).length > budget) text = build(false)
  while (Array.from(text).length > budget && chosen.length > 0) {
    const body = text.split('\n').slice(1)
    if (body.length <= 1) break
    text = [head, ...body.slice(0, body.length - 1)].join('\n')
  }
  if (Array.from(text).length > budget) text = clip(text, budget)
  return text
}
