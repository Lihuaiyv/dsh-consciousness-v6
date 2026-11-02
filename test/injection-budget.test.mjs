/**
 * 注入预算与丢弃顺序（A2）。
 *
 * 要紧的一条：超预算时**先丢得起的东西先丢，情绪留到最后**。
 * 以前顺序是 proactive → affect → drive → …，一挤先把「感觉现在大概的情绪」扔掉，
 * 等于最难的时候先把她的人格扔掉。现在反过来。
 *
 * 运行：node test/injection-budget.test.mjs
 */
import { clampInjection } from '../src/features.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)) }
}

const EXAMPLES = '## 我说话的样子（照这个劲儿，不要复述原句）\n'
  + '- 主人：「你今天好可爱」→ 我：「……你怎么突然说这个。」\n'
  + '- 主人：「你怎么不高兴」→ 我：「我没有不高兴，就是有点累。」\n'
  + '- 主人：「那个东西弄好了吗」→ 我：「等一下，你说的是哪个？」'
const DIARY = '最近我自己写下的（日记，不是用户说的）：\n- ' + '今天把取数补上界，空值不再当零。'.repeat(3)
const MEMORY = '关于这句话，你能想起的事（只引用相关的，不要编造）：\n- 主人喜欢先给结论再解释\n- 主人说过想去看海\n- 主人今天在改情绪和记忆的接线'
const AFFECT = '感觉现在大概的情绪是：挺高兴；整体心情偏正面。'
const WISH = '我想怎么说：就正常说，不用特意收着。'

const lines = (over = {}) => [
  '## 意识体：小汐',
  '你现在就是「小汐」。用第一人称说话。',
  '语气：可爱粘人。',
  over.examples ?? EXAMPLES,
  '关系：主人（亲近 0.92 / 信任 0.72 / 依赖 0.24）。',
  over.affect ?? AFFECT,
  over.wish ?? WISH,
  over.proactive ?? '（你之前想主动说一句：早点睡 —— 如果时机合适，自然提起。）',
  '需求缺口档位：D2。',
  over.diary ?? DIARY,
  over.memory ?? MEMORY,
].filter(Boolean)

const has = (text, s) => text.includes(s)
const tokensOf = (t) => Math.ceil(String(t).length / 2)

// ---- 宽松预算：什么都别丢
{
  const out = clampInjection(lines(), 800)
  check('宽松预算不丢东西', out.dropped.length === 0, out.dropped)
  check('宽松预算保留情绪', has(out.text, '感觉现在大概'))
  check('宽松预算保留示例', has(out.text, '我说话的样子'))
}

// ---- 收紧：先丢主动句
{
  const out = clampInjection(lines(), 150)
  check('紧预算先丢主动句', out.dropped.includes('proactive'), out.dropped)
  check('紧预算保住情绪', has(out.text, '感觉现在大概'), out.dropped)
  check('紧预算不超上限', out.tokens <= 150, out.tokens)
}

// ---- 再收紧：示例要比记忆先走（记忆是内容，示例是风格）
{
  const out = clampInjection(lines(), 100)
  const iEx = out.dropped.indexOf('examples')
  const iMem = out.dropped.indexOf('memory')
  check('示例先于记忆被丢', iEx >= 0 && (iMem < 0 || iEx < iMem), out.dropped)
  check('示例走了情绪还在', !has(out.text, '我说话的样子') && has(out.text, '感觉现在大概'), out.dropped)
  check('不超上限', out.tokens <= 100, out.tokens)
}

// ---- 极紧：情绪是最后一个被丢的
{
  const out = clampInjection(lines(), 40)
  check('极紧预算仍保情绪', has(out.text, '感觉现在大概'), { dropped: out.dropped, text: out.text })
  check('affect 不在丢弃名单里', !out.dropped.includes('affect'), out.dropped)
}

// ---- 情绪与愿望都算「情绪档」：只留一条时不该先砍它
{
  const out = clampInjection(lines({ memory: MEMORY, diary: DIARY }), 60)
  check('情绪档被视为不可先丢', !out.dropped.includes('affect'), out.dropped)
}

// ---- 任何预算下 tokens 都不超
{
  let bad = null
  for (const b of [40, 60, 80, 100, 120, 150, 200, 300, 500, 800]) {
    const out = clampInjection(lines(), b)
    if (out.tokens > b) { bad = { b, tokens: out.tokens }; break }
  }
  check('所有预算都不超上限', !bad, bad)
}

// ---- 单行超长的兜底：不至于把整段吞掉
{
  const huge = '关于这句话，你能想起的事：\n- ' + '很长的记忆'.repeat(200)
  const out = clampInjection(lines({ memory: huge }), 120)
  check('超长记忆被裁但没清空', out.tokens <= 120 && out.text.length > 0, out.tokens)
}

console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exitCode = 1
