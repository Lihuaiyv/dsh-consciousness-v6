/**
 * 记忆内容级模糊（保守版）单测。
 * 核心不变量：**只删不改**——输出必须是输入的子序列。
 * 运行：node test/memory-fade.test.mjs
 */
import {
  fadeLevel, fadeText, shouldFade, rehearseAdjustedAge, stillReadable,
} from '../src/modules/memory_fade.js'
import { packInjection } from '../src/modules/pack.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)) }
}

/** 输出是不是输入的子序列（只删不改的铁证）。 */
function isSubsequence(a, b) {
  let i = 0
  for (const ch of String(a)) {
    while (i < b.length && b[i] !== ch) i++
    if (i >= b.length) return false
    i++
  }
  return true
}

// ---- 档位
{
  check('29 天不糊', fadeLevel(29) === 0)
  check('30 天第一档', fadeLevel(30) === 1)
  check('90 天第二档', fadeLevel(90) === 2)
  check('180 天第三档', fadeLevel(180) === 3)
  check('拿不到年龄 = 不糊', fadeLevel(null) === 0 && fadeLevel(undefined) === 0 && fadeLevel(NaN) === 0)
}

// ---- 三档各删什么
{
  const paren = '主人今天在改接线（那部分一直没弄完），说要先跑一遍。'
  const r1 = fadeText(paren, 45)
  check('第一档删括号', !r1.text.includes('那部分') && r1.level === 1, r1)
  check('第一档不改其他', r1.text.includes('改接线') && r1.text.includes('先跑一遍'), r1)

  const num = '主人说三周后要把那版发出去，先写文档，再找人看一遍。'
  const r2 = fadeText(num, 100)
  check('第二档删数字', !r2.text.includes('三周'), r2)
  check('第二档保住主干', r2.text.includes('发出去'), r2)

  const quote = '主人当时说「这版先放着」，后来又说随便。'
  const r3 = fadeText(quote, 200)
  check('第三档删原话', !r3.text.includes('这版先放着'), r3)
  check('第三档保住后半句', r3.text.includes('后来又说随便'), r3)
}

// ---- 保守规则：这几种一个字都不许少
{
  const promise = '答应过周末把脚本修好，修完先跑一遍不出假数据。'
  const r = fadeText(promise, 400)
  check('带承诺词的数字不删', r.text === promise, r)

  const reason = '主人不想去那家店（因为上次吵过），说下次换一家。'
  const r2 = fadeText(reason, 45)
  check('括号里是原因就不删', r2.text.includes('因为上次吵过'), r2)

  const boundary = '晚上十点以后别吵，主人怕吵。'
  const r3 = fadeText(boundary, 300)
  check('带「别」和「怕」的整句不动', r3.text === boundary, r3)

  const kind = '主人喜欢（特别）酸的咖啡。'
  const r4 = fadeText(kind, 45)
  check('括号里是保护词也不删', r4.text.includes('特别'), r4)
}

// ---- 下限：不许削成废话
{
  const short = '主人喜欢咖啡（不加糖）。'
  const r = fadeText(short, 400)
  check('不到 12 字不动', r.text === short && r.level === 0, r)

  const long = '主人今天说了一件事（很长的一大段补充说明，占了半句还多），最后下了个结论在这里。'
  const r2 = fadeText(long, 400)
  check('删完不低于一半', Array.from(r2.text).length >= Math.ceil(Array.from(long).length * 0.5), { before: long.length, after: Array.from(r2.text).length, r: r2 })
  check('括号注释确实被删掉了', !r2.text.includes('补充说明'), r2.text)
}

// ---- 铁律：只删不改
{
  const samples = [
    '主人今天在改接线（那部分一直没弄完），说要先跑一遍。',
    '主人说三周后要把那版发出去，先写文档。',
    '主人当时说「这版先放着」，后来又说随便。',
    '主人今天说了一件事（很长的一大段补充说明，占了半句还多），最后下了个结论在这里。',
    '',
    '短。',
  ]
  const bad = samples.filter((s) => !isSubsequence(fadeText(s, 400).text, s))
  check('输出永远是输入的子序列', bad.length === 0, bad)

  const longer = samples.filter((s) => fadeText(s, 400).text.length > s.length)
  check('永远不会变长', longer.length === 0, longer)
}

// ---- 别把「一起 / 一定 / 一下」当数字删（真实库 1117 条上实测，旧写法误伤 14 条）
{
  const KEEP = ['一起', '一定', '一样', '一点', '一下', '一直', '两个人', '十分']
  const broke = []
  for (const w of KEEP) {
    const s = '主人说今天' + w + '要去楼下那家店里坐坐，顺便聊聊最近的事'
    const out = fadeText(s, 400, { maxLevel: 3 }).text
    if (!out.includes(w)) broke.push({ w, out })
  }
  check('中文的「一 / 两 / 十」不当数字删', broke.length === 0, broke)

  const TRIM = ['三天', '3 个月', '2024 年', '十分钟']
  const missed = TRIM.filter((w) => {
    const s = '主人' + w + '前说过这件事，后来一直没再提'
    return fadeText(s, 400, { maxLevel: 3 }).text.includes(w)
  })
  check('时间表达照样删', missed.length === 0, missed)

  // 行号 / 个数 / 金额不是「记糊了」该糊的东西，删了会改意思
  const keepNum = '主人让把第 3 行改一下，买 2 个螺丝，剩 50 块钱'
  check('行号个数金额不动', fadeText(keepNum, 400, { maxLevel: 3 }).text.includes('第 3 行'), fadeText(keepNum, 400, { maxLevel: 3 }).text)
}

// ---- 该不该糊
{
  check('钉住的永远不糊', shouldFade({ mark: 'locked', importance: 0.2, type: 'fact' }, 400) === false)
  check('事实类：重要度 ≥0.7 不糊', shouldFade({ importance: 0.7, type: 'fact' }, 400) === false)
  check('冲突类不糊', shouldFade({ type: 'conflict', importance: 0.3 }, 400) === false)
  check('立场 / 边界 / 承诺一个字不删',
    ['value', 'boundary', 'taboo', 'promise', 'identity'].every((t) => shouldFade({ type: t, importance: 0 }, 400) === false))
  check('普通旧记忆可以糊', shouldFade({ importance: 0.4, type: 'fact' }, 100) === true)
  check('见闻 / 评价可以糊',
    shouldFade({ importance: 0.4, type: 'episode' }, 400) && shouldFade({ importance: 0.4, type: 'appraisal' }, 400))
  check('反思低分的可以糊', shouldFade({ importance: 0.5, type: 'reflection' }, 400) === true)
  check('反思最高那一档留全', shouldFade({ importance: 0.95, type: 'reflection' }, 400) === false)
  check('没有类型不糊', shouldFade({ importance: 0.1 }, 400) === false)
  check('不认识的新类型不糊', shouldFade({ importance: 0.1, type: 'note' }, 400) === false)
  check('不到 30 天不糊', shouldFade({ importance: 0.4, type: 'fact' }, 10) === false)
}

// ---- 复习抵年龄（第 1 步）
{
  const NOW = Date.parse('2026-11-02T12:00:00+08:00')
  const recent = new Date(NOW - 86400000).toISOString()
  const old = new Date(NOW - 200 * 86400000).toISOString()

  check('拿不到年龄就原样返回', rehearseAdjustedAge(null, 5, recent, NOW) === null)
  check('没被想起过 = 不变', rehearseAdjustedAge(200, 0, old, NOW) === 200)
  check('想起过就变年轻', rehearseAdjustedAge(200, 5, old, NOW) < 200, rehearseAdjustedAge(200, 5, old, NOW))
  check('想得越多越年轻', rehearseAdjustedAge(200, 20, old, NOW) < rehearseAdjustedAge(200, 5, old, NOW))
  check('hits 封顶 30', rehearseAdjustedAge(200, 30, old, NOW) === rehearseAdjustedAge(200, 300, old, NOW))
  check('最近想起过再打折', rehearseAdjustedAge(200, 5, recent, NOW) < rehearseAdjustedAge(200, 5, old, NOW))
  check('永远不超过真实年龄', rehearseAdjustedAge(200, 0, recent, NOW) <= 200)
  check('永远不低于真实的一半', rehearseAdjustedAge(200, 300, recent, NOW) >= 100)
  check('极短年龄也守下限', rehearseAdjustedAge(10, 30, recent, NOW) >= 5)

  const sample = '主人说三周后把「那版」发出去，然后再说别的。'
  const plain = fadeText(sample, 200)
  const reh = fadeText(sample, rehearseAdjustedAge(200, 40, old, NOW))
  check('复习让旧事少糊一档', reh.level < plain.level, { plain: plain.level, reh: reh.level })

  const fifty = '主人在改接线（那部分一直没弄完），说要先跑一遍。'
  const eff = rehearseAdjustedAge(50, 30, old, NOW)
  check('有效年龄可以掉到 30 天以下', eff < 30, eff)
  check('掉到门槛下就不糊', fadeText(fifty, eff).level === 0, fadeText(fifty, eff))
}

// ---- 删完读一遍（第 2 步）
{
  check('正常句子算通顺', stillReadable('主人今天在改接线，说要先跑一遍。', '主人今天在改接线，说要先跑一遍。'))
  check('太短不算', stillReadable('主人说了很多很多话。', '主人。') === false)
  check('标点开头不算', stillReadable('主人说了一句话。', '，主人说了一句话。') === false)
  check('虚词结尾不算', stillReadable('主人说了很多很多话。', '主人说了很多很多话和') === false)
  check('把主语删掉不算', stillReadable('主人今天在改接线。', '今天在改接线这件事。') === false)
  check('没有主语的原句不强求', stillReadable('接线改完了，跑一遍，再看还有没有别的问题。', '接线改完，跑一遍，再看还有没有别的问题。'))

  const who = '（主人）今天在改接线，说要先跑一遍。'
  const r = fadeText(who, 45)
  check('删掉主语就退档', r.level === 0, r)
  check('退档后原文还在', r.text === who, r.text)

  const ok = '主人今天在改接线（那部分一直没弄完），说要先跑一遍。'
  check('正常括号照样删', fadeText(ok, 45).level === 1, fadeText(ok, 45))
}

// ---- 接进装箱
{
  const items = [
    { partition: 'T1', id: 'a', text: '主人当时说「这版先放着」，后来又说随便。', created_at: new Date(Date.now() - 200 * 86400000).toISOString() },
    { partition: 'T1', id: 'b', text: '主人今天在改接线（那部分一直没弄完），说要先跑一遍。', created_at: new Date(Date.now() - 45 * 86400000).toISOString() },
  ]
  const out = packInjection({ items }, {
    budget: 400,
    fade: (it) => fadeText(it.text, it.id === 'a' ? 300 : 45),
  })
  check('装箱里用上了削过的文本', !out.text.includes('这版先放着') && out.text.includes('后来又说随便'), out.text)
  check('新记忆只删括号', out.text.includes('改接线') && !out.text.includes('那部分'), out.text)

  const plain = packInjection({ items }, { budget: 400 })
  check('不传 fade 就是原文', plain.text.includes('这版先放着'), plain.text)

  // fade 作用在「裁剪后的正文」上：档位 > 0 就一定真的改了注入文本。
  // 顺序反了会白糊——记忆正文中位 120 字，被删的括号 / 数字常落在 oneLine 砍掉的 60 字之外。
  const faded = packInjection({ items }, {
    budget: 400,
    fade: (it) => fadeText(it.text, 400, { maxLevel: 3 }),
  })
  check('档位 > 0 时注入文本一定变过',
    faded.lines.some((l) => l.fade > 0) && faded.text !== plain.text,
    { faded: faded.text, plain: plain.text })
}

// ---- 观测：每一行带 fade 档位（第 3 步）
{
  const items = [
    { partition: 'T1', id: 'a', text: '旧事一条，写长一点好占位。' },
    { partition: 'T1', id: 'b', text: '新事一条，也写长一点占位。' },
  ]
  const out = packInjection({ items }, {
    budget: 400,
    fade: (it) => (it.id === 'a' ? { text: it.text, level: 2 } : { text: it.text, level: 0 }),
  })
  check('行上带档位', out.lines.filter((l) => l.fade === 2).length === 1 && out.lines.filter((l) => l.fade === 0).length === 1, out.lines)

  const str = packInjection({ items }, { budget: 400, fade: (it) => it.text })
  check('回调返回字符串也兼容', str.lines.every((l) => l.fade === 0), str.lines)

  const none = packInjection({ items }, { budget: 400 })
  check('不传 fade 时档位为 0', none.lines.every((l) => l.fade === 0), none.lines)

  const dropped = packInjection({ items }, { budget: 60, fade: (it) => ({ text: it.text, level: 3 }) })
  check('被丢的条目也带档位', dropped.dropped.every((d) => d.fade === 3), dropped.dropped)
}

console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exitCode = 1
