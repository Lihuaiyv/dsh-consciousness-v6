/**
 * 注入零件 · 考卷
 *
 * 管的是「这一轮到底放哪几行进上下文、挤不下先丢谁」：
 * 装箱（buffer→T1→T3→T2→T4、配额、超预算从最冷开始丢）和整段硬上限（clampInjection）。
 * 不管「谁该被想起来」（召回）、不管「这句话值不值得记」（写入闸）。
 *
 * 运行：node test/exam-inject.test.mjs
 */
import {
  TOTAL_BUDGET, QUOTA, PRIORITY, estTokens, oneLine, isSameText, dedupe, packInjection,
} from '../src/modules/pack.js'
import { clampInjection } from '../src/features.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 500)) }
}
const tok = (t) => Math.ceil(String(t).length / 2)

// ================================================================ 估算：中文按两字一个 token
{
  check('空串 0 个 token', estTokens('') === 0)
  check('四个汉字约 2 个 token', estTokens('一二三四') === 2, estTokens('一二三四'))
  check('奇数长度向上取整', estTokens('一二三') === 2, estTokens('一二三'))
  check('默认总预算 800', TOTAL_BUDGET === 800)
}

// ================================================================ 一行：裁剪与软收口
{
  check('去掉编号、加粗，取第一句', oneLine('1. **事实**：她喜欢猫。第二段不进来') === '事实：她喜欢猫', oneLine('1. **事实**：她喜欢猫。第二段不进来'))
  /* 真相：换行先被压成空格，所以「第一段没句号」时两段会并成一行。
     想只留第一段，得靠句号；这是已知的取值方式，考卷照现实考。 */
  check('第一段没句号，会和下一段并起来', oneLine('事实：她喜欢猫\n第二段不进来') === '事实：她喜欢猫 第二段不进来', oneLine('事实：她喜欢猫\n第二段不进来'))
  check('只留第一句', oneLine('第一句话。第二句话') === '第一句话')
  check('不到上限就原样给', oneLine('短短一句') === '短短一句')
  check('- 开头的列表项也去掉', oneLine('- 她今天有点累') === '她今天有点累')

  const long = '这是一条很长的记忆，' + '啊'.repeat(44) + '，' + '尾巴'.repeat(10)
  const cut = oneLine(long, 60)
  check('超长时在逗号处收口，不留省略号', Array.from(cut).length <= 60 && !cut.endsWith('…'), Array.from(cut).length)
  check('收口不会砍掉大半条（至少留六成）', Array.from(cut).length >= 36, Array.from(cut).length)

  const noPunct = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.repeat(4)
  const hard = oneLine(noPunct, 60)
  check('没有软边界才硬切，并加省略号', hard.endsWith('…') && Array.from(hard).length === 60, Array.from(hard).length)
}

// ================================================================ 去重：同一件事只留一次
{
  check('去标点后一样就算重复', isSameText('她喜欢猫。', '她喜欢猫') === true)
  check('完全不同的两条不算重复', isSameText('她喜欢猫', '今天下了很大的雨') === false)
  check('太短的两条不判重复（字数不够比）', isSameText('好', '嗯') === false)
  check('字符几乎一样的长句算重复', isSameText('她今天很开心也很安定', '她今天很开心，也很安定') === true)

  const items = [
    { partition: 'T4', text: '同一件事' },
    { partition: 'T1', text: '同一件事' },
    { partition: 'T2', text: '另一件事' },
  ]
  const d = dedupe(items)
  check('重复只留一条', d.length === 2, d.length)
  check('留优先级高的分区（T1 胜过 T4）', d[0].partition === 'T1', d[0].partition)
  check('优先级表：T0 最保、T4 最可丢', PRIORITY.T0 < PRIORITY.T1 && PRIORITY.T4 > PRIORITY.T2)
}

// ================================================================ 装箱：顺序、配额、丢弃次序
{
  const text = (s) => '正文' + s
  const out = packInjection({
    buffer: [{ role: 'user', text: '在吗' }, { role: 'agent', text: '在' }],
    items: [
      { partition: 'T2', text: text('二') },
      { partition: 'T1', text: text('一') },
      { partition: 'T4', text: text('四') },
      { partition: 'T3', text: text('三') },
    ],
  })
  const seq = out.lines.map((l) => l.section)
  check('段顺序：buffer→T1→T3→T2→T4', seq.join(',') === 'buffer,buffer,T1,T3,T2,T4', seq)
  check('buffer 带「你刚才 / 我刚说」', out.lines[0].text.startsWith('你刚才：') && out.lines[1].text.startsWith('我刚说：'), out.lines.slice(0, 2))
  check('正文前带「- 」', out.lines.find((l) => l.section === 'T1').text.startsWith('- '))
  check('返回 token 数 = 各行之和', out.tokens === out.lines.reduce((s, l) => s + l.tokens, 0))

  // 配额：T1 只有 300 token；每条被 oneLine 裁到 60 字（约 29 token），十二条合计超配额。
  // 用不同的字做头，免得被「几乎一样」的去重认成同一条。
  const heads = ['猫', '雨', '书', '茶', '路', '灯', '窗', '桌', '椅', '钟', '伞', '车']
  const many = heads.map((h) => ({ partition: 'T1', text: h + '：' + '啊'.repeat(56) }))
  const q = packInjection({ items: many })
  check('超配额的那几条被丢，理由是 quota', q.lines.length === 10 && q.dropped.length === 2 && q.dropped.every((d) => d.why === 'quota'), { lines: q.lines.length, dropped: q.dropped.length })

  // 总预算：四区各一条，总和超过预算 → 先丢 T4
  const four = ['T1', 'T2', 'T3', 'T4'].map((p) => ({ partition: p, text: p + '：' + '嗯'.repeat(56) }))
  const b = packInjection({ items: four }, { budget: 90 })
  check('挤不下时从最冷的 T4 开始丢', !b.lines.some((l) => l.section === 'T4') && b.dropped.some((d) => d.section === 'T4'), b.dropped.map((d) => d.section))
  check('丢的时候 reason 是 budget', b.dropped.every((d) => d.why === 'budget' || d.why === 'quota'))

  // 标记：旧说法 / 一直记着 / 今天刚发生
  const tags = packInjection({
    items: [
      { partition: 'T1', text: '旧版本', stale: true },
      { partition: 'T1', text: '锚点', via: 'anchor' },
    ],
  })
  check('旧说法带「已更新」标记', tags.lines[0].text.includes('（已更新，旧说法）'), tags.lines[0].text)
  check('锚点带「一直记着的」', tags.lines[1].text.includes('（一直记着的）'), tags.lines[1].text)
  const fresh = packInjection({ items: [{ partition: 'T1', text: '刚发生', via: 'fresh' }] })
  check('新鲜事说不出来源时退回「今天刚发生」', fresh.lines[0].text.includes('（今天刚发生）'), fresh.lines[0].text)
  const prov = packInjection({ items: [{ partition: 'T1', text: '刚发生', via: 'fresh' }] }, { provenanceTag: () => '手记' })
  check('给了来源就拼上（手记，今天刚发生）', prov.lines[0].text.includes('（手记，今天刚发生）'), prov.lines[0].text)

  // decode：调用方给的「多久以前」标签
  const dec = packInjection({ items: [{ partition: 'T1', text: '旧事' }] }, { decorate: () => '（三天前）' })
  check('默认标签交给调用方的 decorate', dec.lines[0].text.includes('（三天前）'), dec.lines[0].text)

  // fade：模糊档位与文本一起交出来
  const faded = packInjection({ items: [{ partition: 'T1', text: '今天在楼下买了点东西' }] }, { fade: () => ({ text: '在楼下买了东西', level: 2 }) })
  check('模糊档位记下来', faded.lines[0].fade === 2 && faded.lines[0].text.includes('在楼下买了东西'), faded.lines[0])
  const fadeBad = packInjection({ items: [{ partition: 'T1', text: '今天在楼下买了点东西' }] }, { fade: () => { throw new Error('坏') } })
  check('fade 抛错就退回原文，不炸', fadeBad.lines[0].text.includes('今天在楼下买了点东西'), fadeBad.lines[0].text)

  // 深翻提示
  const deep = packInjection({ items: [{ partition: 'T1', text: '翻出来的旧事', via: 'deep' }] })
  check('深翻时加一行提醒', deep.text.includes('别硬说记得') && deep.tokens > deep.lines.reduce((s, l) => s + l.tokens, 0), deep.text)
  const noDeep = packInjection({ items: [{ partition: 'T1', text: '翻出来的旧事', via: 'deep' }] }, { deepNote: false })
  check('关得掉那行提醒', !noDeep.text.includes('别硬说记得'))
}

// ================================================================ 整段硬上限：挤不下先丢谁
{
  const affectLine = '此刻情绪：偏暖，绷着 0.3'
  const memLine = '关于这句话，你能想起的事：\n' + '这是一条记忆。\n'.repeat(30)
  const out = clampInjection([affectLine, memLine], 60)
  check('预算紧时丢记忆、不丢情绪', out.text.includes('此刻情绪') && !out.text.includes('关于这句话'), out.text)
  check('丢记忆留痕', out.dropped.includes('memory'), out.dropped)

  const many = ['## 我说话的样子', '不要列点，说人话', '需求缺口档位：D1', '最近我自己写下的：\n' + '日记行。\n'.repeat(20)]
  const c2 = clampInjection(many, 40)
  check('挤不下先丢「我说话的样子」', c2.dropped.includes('examples'), c2.dropped)
  check('被丢弃的行不在正文里', !c2.text.includes('## 我说话的样子'), c2.text)

  const long = '关系：' + '很长的数字串。'.repeat(40)
  const c3 = clampInjection([long], 60)
  check('长行被削短并加省略号', c3.text.endsWith('…') && tok(c3.text) <= 60, { t: c3.text.length, tokens: tok(c3.text) })
  check('削短也留痕', c3.dropped.some((d) => String(d).startsWith('shrink')), c3.dropped)

  const huge = ['一条特别长的行 ' + '嗯'.repeat(2000)]
  const c4a = clampInjection(huge, 40)
  check('单条超长先被削短（不是直接截断）', c4a.dropped.includes('shrink') && tok(c4a.text) <= 40, c4a.dropped)
  const manyLong = Array.from({ length: 10 }, (_, i) => '第' + i + '条：' + '嗯'.repeat(300))
  const c4 = clampInjection(manyLong, 40)
  check('削完还超才硬截断，token 不超上限', tok(c4.text) <= 40 && c4.text.endsWith('…'), tok(c4.text))
  check('硬截断留痕 truncate', c4.dropped.includes('truncate'), c4.dropped)

  // key：只有真留下来的行才算「说过」
  const c5 = clampInjection([
    { text: '此刻情绪：平稳', key: 'aff' },
    { text: '关于这句话，你能想起的事：\n' + '记忆。\n'.repeat(40), key: 'mem' },
  ], 60)
  check('留下来的行 key 还在 kept 里', c5.kept.has('aff'), [...c5.kept])
  check('被丢的行 key 进 removed（不落账）', c5.removed.has('mem'), [...c5.removed])

  const c6 = clampInjection(['这一段不长，原样就好'], 800)
  check('不超预算就一行不丢', c6.dropped.length === 0 && c6.text === '这一段不长，原样就好', c6)

  const c7 = clampInjection([], 800)
  check('空输入不炸', c7.text === '' && c7.tokens === 0)
}

// ================================================================ 配额表与现状
{
  check('分段配额：buffer 100 / T1 300 / T3 120', QUOTA.buffer === 100 && QUOTA.T1 === 300 && QUOTA.T3 === 120, QUOTA)
}

console.log('\n通过 ' + pass + ' / ' + (pass + fail))
if (fail) process.exitCode = 1
