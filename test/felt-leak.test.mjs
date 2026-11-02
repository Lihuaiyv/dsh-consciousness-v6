/**
 * 情绪措辞测试：不再报情绪名，改成行为倾向；两个权重分支都覆盖。
 * 运行：node test/felt-leak.test.mjs
 */
import { feltLine } from '../src/modules/expression_state.js'
import { clampInjection } from '../src/features.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name + '  ' + JSON.stringify(detail === undefined ? '' : detail).slice(0, 300)) }
}

const OLD = ['有点高兴', '挺高兴', '很高兴', '挺安稳', '很安稳', '特别松',
  '有点好奇', '挺好奇', '特别好奇', '挺平静', '很平静', '静得很',
  '有点糊涂', '有点空', '有点找不着底', '有点挫败', '挺挫败']

const WANT = {
  joy: '松', peaceful: '赶', curious: '追问', calm: '起伏',
  confused: '绕', lost: '发虚', irritated: '顿', frustrated: '提不起劲',
}

for (const [label, word] of Object.entries(WANT)) {
  const felt = feltLine({ label, intensity: 0.5, slow: 0, mood: 0.2 })
  check(label + '：不报旧情绪名', !OLD.some((w) => felt.includes(w)), felt)
  check(label + '：带行为倾向', felt.includes(word), felt)
  check(label + '：保留整体心情', felt.includes('整体心情偏正面'), felt)
}

const low = feltLine({ label: 'frustrated', intensity: 0.5, slow: -0.4, mood: -0.3 })
check('默认分支仍是推测口吻', low.startsWith('感觉现在大概'), low)
check('低落补「不太想多说」', low.includes('不太想多说'), low)

const strong = feltLine({ label: 'frustrated', intensity: 0.5, slow: -0.4, mood: -0.3, weight: 0.7 })
check('权重大时仍是陈述口吻', strong.startsWith('现在：'), strong)
check('权重大时也带行为倾向', strong.includes('提不起劲'), strong)

const unknown = feltLine({ label: 'nope', intensity: 0.4, slow: 0, mood: 0 })
check('未知标签降级到 calm 且不抛', unknown.includes('没什么起伏'), unknown)

// ---- 权重高的情绪行也受 shrink 保护（AFFECT_TEST 补了「现在的情绪是」） ----
{
  const lines = [
    '## 意识体：X',
    '关系：' + '亲近 0.90 / 信任 0.80；'.repeat(8),
    '现在的情绪是：提不起劲，句子会自己断掉；整体心情偏负面。',
  ]
  const out = clampInjection(lines, 40)
  check('权重高的情绪行不被削', out.text.includes('提不起劲，句子会自己断掉'), out.text)
}

console.log('\n通过 ' + pass + ' / ' + (pass + fail))
if (fail) { console.log('失败:', fail); process.exit(1) }
