/**
 * 大脑盒 · 第一个零件：注入预算裁剪。
 *
 * 这条测试的意义不是「再测一遍预算」，是证明它**脱离了宿主和数据库也能跑**：
 * 只 import 一个纯函数，不建库、不起 HTTP、不挂插件。
 *
 * 运行：node test/brain-inject.test.mjs
 */
import { clampInjection } from '../src/brain/inject.js'

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

const lines = (over = {}) => [
  '## 意识体：小汐',
  '你现在就是「小汐」。用第一人称说话。',
  '语气：可爱粘人。',
  over.examples ?? EXAMPLES,
  '关系：主人（亲近 0.92 / 信任 0.72 / 依赖 0.24）。',
  over.affect ?? AFFECT,
  '我想怎么说：就正常说，不用特意收着。',
  over.proactive ?? '（你之前想主动说一句：早点睡 —— 如果时机合适，自然提起。）',
  '需求缺口档位：D2。',
  over.diary ?? DIARY,
  over.memory ?? MEMORY,
].filter(Boolean)

// 宽松：什么都不丢
{
  const out = clampInjection(lines(), 800)
  check('宽松预算不丢东西', out.dropped.length === 0, out.dropped)
  check('宽松预算保住情绪', out.text.includes('感觉现在大概'))
}

// 紧：先丢主动句，情绪不动
{
  const out = clampInjection(lines(), 150)
  check('紧预算先丢主动句', out.dropped.includes('proactive'), out.dropped)
  check('紧预算保住情绪', out.text.includes('感觉现在大概'), out.dropped)
  check('紧预算不超上限', out.tokens <= 150, out.tokens)
}

// 带 key 的行：丢了的不能算说过，留下的要能落账
{
  const big = '关于这句话，你能想起的事：\n- ' + '很长的记忆'.repeat(60)
  const out = clampInjection([
    { text: '## 意识体：小汐', key: 'head' },
    { text: '（你之前想主动说一句：早点睡 —— 如果时机合适，自然提起。）', key: 'proactive-line' },
    { text: AFFECT, key: 'affect-line' },
    { text: big, key: 'memory-line' },
  ], 60)
  check('被丢的 key 不在 kept 里', !out.kept.has('proactive-line'), [...out.kept])
  check('被丢的 key 在 removed 里', out.removed.has('proactive-line'), [...out.removed])
}

// 任何预算下都不超
{
  let bad = null
  for (const b of [40, 60, 80, 100, 150, 300, 800]) {
    const out = clampInjection(lines(), b)
    if (out.tokens > b) { bad = { b, tokens: out.tokens }; break }
  }
  check('所有预算都不超上限', !bad, bad)
}

// 空输入不炸
{
  const out = clampInjection([], 100)
  check('空输入返回空文本', out.text === '' && out.tokens === 0, out)
  const out2 = clampInjection(null, 0)
  check('null 输入不抛错', typeof out2.text === 'string', out2)
}

console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exitCode = 1
