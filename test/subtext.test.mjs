/**
 * 潜台词测试：只从现有状态拼，不调模型；紧预算时属于「可先丢」的一类。
 * 运行：node test/subtext.test.mjs
 */
import { subtextOf } from '../src/modules/expression_state.js'
import { clampInjection } from '../src/features.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name + '  ' + JSON.stringify(detail === undefined ? '' : detail).slice(0, 400)) }
}

// ---- 条件与优先级 ----
check('压火 + 对方开心 → 不想扫兴', subtextOf({ hot: true, userLabel: 'joy' }).includes('不想扫兴'))
check('冲突 + 低信任 → 有句实话', subtextOf({ conflictLine: '对不上', lowTrust: true }).includes('有句实话'))
check('只有冲突 → 想问怕吵', subtextOf({ conflictLine: '对不上' }).includes('想问，但怕一问就变成吵架'))
check('压火但对方不开心 → 不硬套扫兴', subtextOf({ hot: true, userLabel: 'frustrated' }) === '')
check('什么都没有 → 空', subtextOf({}) === '')

// ---- 预算：紧的时候先丢 ----
{
  const lines = [
    '## 意识体：X',
    '感觉现在大概的情绪是：心里是松的。',
    '（心里其实想说但没说出口：' + '想问，但怕一问就变成吵架。'.repeat(4) + '这句不用讲出来。）',
    '关于这句话，你能想起的事：\n- ' + 'x'.repeat(200),
  ]
  const out = clampInjection(lines, 30)
  check('紧预算：潜台词被丢', out.dropped.includes('subtext'), out.dropped)
  check('紧预算：正文里不剩潜台词', !out.text.includes('心里其实'), out.text)
  check('紧预算：情绪行还在', out.text.includes('感觉现在大概'), out.text)
}

// ---- 宽松预算：潜台词保留 ----
{
  const lines = [
    '## 意识体：X',
    '感觉现在大概的情绪是：心里是松的。',
    '（心里其实想说但没说出口：想问，但怕一问就变成吵架。这句不用讲出来。）',
  ]
  const out = clampInjection(lines, 400)
  check('宽松预算：潜台词保留', out.text.includes('心里其实'), out.text)
}

console.log('\n通过 ' + pass + ' / ' + (pass + fail))
if (fail) { console.log('失败:', fail); process.exit(1) }
