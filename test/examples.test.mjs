/**
 * 行为示例（A1）：解析 / 生成 / 预算。
 * 运行：node test/examples.test.mjs
 */
import { DEFAULT_EXAMPLES, MAX_CHARS, parseExamples, examplesBlock, pickExamples } from '../src/modules/examples.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 300)) }
}
const len = (s) => Array.from(String(s)).length

// ---- 解析
{
  check('没配置 → null（用默认）', parseExamples(null) === null && parseExamples('') === null)
  check('写成 off → 明确关掉', Array.isArray(parseExamples('off')) && parseExamples('off').length === 0)
  check('空数组 → 关掉', parseExamples('[]').length === 0)
  check('坏 JSON 不死、退回默认', parseExamples('{不是数组') === null)
  check('对象不是数组 → null', parseExamples('{"q":"a"}') === null)

  const arr = parseExamples(JSON.stringify([{ q: '在吗', a: '在。' }, { q: '吃了吗', a: '还没。', note: '别反客为主' }]))
  check('{q,a} 解析', arr.length === 2 && arr[0].q === '在吗' && arr[1].note === '别反客为主')
  const strs = parseExamples(JSON.stringify(['主人：「在吗」→ 我：「在。」']))
  check('字符串条目解析', strs.length === 1 && typeof strs[0].line === 'string')
  const junk = parseExamples(JSON.stringify([{ q: 'x' }, 42, null, { q: 'y', a: 'z' }]))
  check('坏条目被跳过', junk.length === 1 && junk[0].q === 'y')
}

// ---- 生成
{
  const block = examplesBlock(null)
  const lines = block.split('\n')
  check('带标题', lines[0].startsWith('## 我说话的样子'))
  check('normal 档给 4 条', lines.length === 1 + 4, { lines: lines.length })
  check('整体不超预算', len(block) <= MAX_CHARS, { len: len(block), cap: MAX_CHARS })
  check('没有空行', lines.every((l) => l.trim()))
  check('每条都短', lines.slice(1).every((l) => len(l) <= 60), lines.slice(1).map(len))
  check('明确要求不要复述', block.includes('不要复述'))

  check('明确关掉就整段不注入', examplesBlock([]) === '')
  check('自定义覆盖默认', examplesBlock(parseExamples(JSON.stringify([{ q: 'a', a: 'b' }]))).split('\n').length === 2)

  const many = Array.from({ length: 30 }, (_, i) => ({ q: 'q' + i, a: 'a' + i }))
  check('条数有上限', examplesBlock(many).split('\n').length <= 1 + 8, examplesBlock(many).split('\n').length)

  const tight = examplesBlock(null, { budget: 100 })
  check('紧预算仍带标题', tight.split('\n')[0].startsWith('## 我说话的样子'), tight)
  check('紧预算不超', len(tight) <= 100, len(tight))
  check('紧预算仍有多条', tight.split('\n').length >= 3, tight.split('\n').length)
}

// ---- 按表达档挑（P1）
{
  const lines = (lv) => examplesBlock(null, { level: lv }).split('\n').slice(1)
  const q = (lv) => lines(lv).map((l) => l.match(/主人：「(.*)」/)[1])

  check('quiet 最短', lines('quiet').length <= lines('brief').length, { quiet: lines('quiet').length, brief: lines('brief').length })
  check('warm 最长', lines('warm').length >= lines('normal').length, { warm: lines('warm').length, normal: lines('normal').length })
  check('warm 里有改口', q('warm').some((x) => x.includes('哪个好')), q('warm'))
  check('quiet 里有低落样本', q('quiet').some((x) => x.includes('晚安') || x === '嗯嗯'), q('quiet'))
  check('normal 有改口', q('normal').some((x) => x.includes('哪个好')), q('normal'))
  check('不出现重复条目', new Set(q('warm')).size === q('warm').length, q('warm'))
  check('未知档位退回 normal', q('不知道').join() === q('normal').join(), { unknown: q('不知道'), normal: q('normal') })

  const pool = pickExamples(DEFAULT_EXAMPLES, 'warm')
  check('挑出来的都在池子里', pool.every((ex) => DEFAULT_EXAMPLES.includes(ex)))
  check('warm 里至少一条长例', pool.some((ex) => ex.tag === 'long'), pool.map((e) => e.tag))
}

console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exitCode = 1
