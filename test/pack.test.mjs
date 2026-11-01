/**
 * P1b 装箱与仲裁测试：去重 / 配额 / 超预算丢弃顺序。
 * 运行：node test/pack.test.mjs
 */
import { estTokens, isSameText, dedupe, packInjection, QUOTA } from '../src/modules/pack.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)) }
}

// ---- token 估算
{
  check('中文 2 字符 ≈ 1 token', estTokens('你好') === 1 && estTokens('你好世界') === 2)
  check('空文本 0', estTokens('') === 0 && estTokens(null) === 0)
}

// ---- 同文判定
{
  check('去标点后相同算同一句', isSameText('用户喜欢喝美式咖啡。', '用户喜欢喝美式咖啡'))
  check('短句不做模糊匹配', isSameText('咖啡', '咖啡豆') === false)
  check('不同事不合并', isSameText('用户喜欢喝美式咖啡不加糖', '用户养了一只叫团子的猫') === false)
}

// ---- 跨分区去重：T1 与 T4 说同一句话，只留 T1
{
  const items = [
    { partition: 'T4', id: 'r1', text: '用户喜欢喝美式咖啡，不加糖。', rrf: 0.02 },
    { partition: 'T1', id: 'm1', text: '用户喜欢喝美式咖啡不加糖', rrf: 0.01 },
    { partition: 'T1', id: 'm2', text: '用户养了一只叫团子的猫', rrf: 0.009 },
  ]
  const kept = dedupe(items)
  check('重复只留一条', kept.length === 2, kept.map((x) => x.id))
  check('留下的是高优先分区的版本', kept.some((x) => x.id === 'm1') && !kept.some((x) => x.id === 'r1'), kept.map((x) => x.id))
  check('不相关的不会误合并', kept.some((x) => x.id === 'm2'))
}

// ---- 配额：单段超了按配额丢，且丢的是排名靠后的
{
  const items = []
  for (let i = 0; i < 40; i++) {
    items.push({ partition: 'T1', id: 'm' + i, text: '记忆' + i + '：' + String.fromCharCode(0x4e00 + i).repeat(12), rrf: 1 - i / 100 })
  }
  const out = packInjection({ items })
  check('超配额有丢弃', out.dropped.length > 0, { dropped: out.dropped.length, lines: out.lines.length })
  check('丢弃原因是配额', out.dropped.every((d) => d.why === 'quota'), out.dropped.map((d) => d.why))
  check('保留的 T1 不超过配额', out.lines.filter((l) => l.section === 'T1').reduce((s, l) => s + l.tokens, 0) <= QUOTA.T1, out.tokens)
  check('先保排名靠前的', out.lines[0].text.includes('记忆0'), out.lines[0].text)
}

// ---- 超总预算：先丢 T4，再丢 T2，buffer 留到最后
{
  const mk = (tag) => '这段话属于' + tag + '分区，故意写长一点，用来把总预算占满，好看看丢弃顺序对不对'
  const out = packInjection({
    buffer: [{ role: 'assistant', text: mk('缓冲') }],
    items: [
      { partition: 'T1', id: 'a', text: mk('事实'), rrf: 0.03 },
      { partition: 'T2', id: 'b', text: mk('纪要'), rrf: 0.02 },
      { partition: 'T4', id: 'c', text: mk('原文'), rrf: 0.01 },
    ],
  }, { budget: 60, quota: { buffer: 1000, T1: 1000 } })
  const droppedSections = out.dropped.filter((d) => d.why === 'budget').map((d) => d.section)
  check('超预算先丢 T4', droppedSections[0] === 'T4', { droppedSections, tokens: out.tokens })
  check('buffer 最后才丢', !droppedSections.includes('buffer'), droppedSections)
  check('总量不超预算', out.tokens <= 60, out.tokens)
}

// ---- 正常情况：全留下，行格式带前缀
{
  const out = packInjection({
    buffer: [{ role: 'user', text: '我刚才说的话' }],
    items: [{ partition: 'T1', id: 'a', text: '用户喜欢咖啡', rrf: 0.02 }],
  })
  check('缓冲行带「你刚才：」', out.lines[0].text.startsWith('你刚才：'), out.lines[0].text)
  check('记忆行带「- 」', out.lines[1].text.startsWith('- '), out.lines[1].text)
  check('没东西可丢', out.dropped.length === 0, out.dropped.length)
  check('text 是可注入的整段', out.text.split('\n').length === 2, out.text)
}

console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exitCode = 1
