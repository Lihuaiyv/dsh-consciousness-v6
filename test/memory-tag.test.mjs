/**
 * 记忆的时间 / 清晰度标签（B1/B2）+ 装箱接线。
 *
 * 运行：node test/memory-tag.test.mjs
 */
import { ageDays, agePhrase, clarityPhrase, memoryTag } from '../src/modules/memory_tag.js'
import { packInjection } from '../src/modules/pack.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 300)) }
}

const NOW = Date.parse('2026-11-02T12:00:00+08:00')
const DAY = 86400000
const rowDaysAgo = (d, extra = {}) => ({ id: 'm' + d, text: '主人说过一件事。', created_at: new Date(NOW - d * DAY).toISOString(), ...extra })

// ---- 年龄
{
  check('刚创建 0 天', Math.abs(ageDays(rowDaysAgo(0), NOW)) < 0.01)
  check('拿不到时间 → null', ageDays({ text: 'x' }, NOW) === null && ageDays(null, NOW) === null)
  check('未来时间不产生负数', ageDays({ created_at: new Date(NOW + DAY).toISOString() }, NOW) === 0)
}

// ---- 年龄措辞：一周内精确，之后模糊
{
  check('今天不标', agePhrase(0) === '' && agePhrase(0.4) === '')
  check('1 天前', agePhrase(1) === '1 天前')
  check('6 天前', agePhrase(6.9) === '6 天前')
  check('2 周前', agePhrase(14) === '2 周前')
  check('3 个月前', agePhrase(95) === '3 个月前')
  check('一年多前', agePhrase(500) === '一年多前')
}

// ---- 清晰度：越旧越糊，但不说「忘了」
{
  check('一个月内不糊', clarityPhrase(20) === '')
  check('一个月到三个月：有点糊', clarityPhrase(45) === '有点糊')
  check('三个月到一年：只记得大概', clarityPhrase(120) === '只记得大概')
  check('一年以上：记不太清', clarityPhrase(400) === '记不太清')
  check('不说「忘了」', !['有点糊', '只记得大概', '记不太清'].some((s) => s.includes('忘')))
}

// ---- 整条前缀
{
  check('今天的事不贴标签', memoryTag(rowDaysAgo(0), NOW) === '')
  check('三天前只有年龄', memoryTag(rowDaysAgo(3), NOW) === '（3 天前）', memoryTag(rowDaysAgo(3), NOW))
  check('三个月前带糊', memoryTag(rowDaysAgo(95), NOW) === '（3 个月前，只记得大概）', memoryTag(rowDaysAgo(95), NOW))
  check('一年多前', memoryTag(rowDaysAgo(500), NOW) === '（一年多前，记不太清）', memoryTag(rowDaysAgo(500), NOW))
  check('没有创建时间就不贴', memoryTag({ text: 'x' }, NOW) === '')
}

// ---- 接进装箱：decorate 生效，且旧调用不受影响
{
  const items = [
    { partition: 'T1', id: 'a', text: '主人说过想去看海。', created_at: new Date(NOW - 3 * DAY).toISOString() },
    { partition: 'T1', id: 'b', text: '主人喜欢先给结论。', created_at: new Date(NOW - 95 * DAY).toISOString() },
    { partition: 'T1', id: 'c', text: '主人今天在改接线。', created_at: new Date(NOW).toISOString() },
  ]
  const out = packInjection({ items }, { budget: 400, decorate: (it) => memoryTag(it, NOW) })
  check('三天前那条带年龄', out.text.includes('（3 天前）'), out.text)
  check('三个月前那条带糊', out.text.includes('（3 个月前，只记得大概）'), out.text)
  check('今天那条不贴', /- 主人今天在改接线/.test(out.text), out.text)
  check('标签在正文前面', out.text.includes('- （3 天前）主人说过想去看海'), out.text)

  const plain = packInjection({ items }, { budget: 400 })
  check('不传 decorate = 旧行为', !plain.text.includes('天前') && plain.text.includes('- 主人说过想去看海'), plain.text)

  // 锚点 / 新近 / 旧说法 各有专属标签，不能被年龄覆盖
  const special = packInjection({
    items: [
      { partition: 'T1', id: 'x', via: 'anchor', text: '一直记着的那件事。', created_at: new Date(NOW - 200 * DAY).toISOString() },
      { partition: 'T1', id: 'y', via: 'fresh', text: '刚刚发生的事。', created_at: new Date(NOW).toISOString() },
      { partition: 'T1', id: 'z', stale: true, text: '被推翻的旧说法。', created_at: new Date(NOW - 200 * DAY).toISOString() },
    ],
  }, { budget: 400, decorate: (it) => memoryTag(it, NOW) })
  check('锚点标「一直记着的」', special.text.includes('（一直记着的）'), special.text)
  check('新近标「今天刚发生」', special.text.includes('（今天刚发生）'), special.text)
  check('旧说法标「已更新」', special.text.includes('（已更新，旧说法）'), special.text)
  check('特殊标签不被年龄覆盖', !special.text.includes('一年多前'), special.text)
}

// ---- 预算：贴标签后依然不超
{
  const items = Array.from({ length: 20 }, (_, i) => ({
    partition: 'T1', id: 'm' + i, text: '第' + i + '条记忆，写长一点好占地方。', created_at: new Date(NOW - i * 30 * DAY).toISOString(),
  }))
  const out = packInjection({ items }, { budget: 200, decorate: (it) => memoryTag(it, NOW) })
  check('贴标签后仍守预算', out.tokens <= 200, out.tokens)
}

console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exitCode = 1
