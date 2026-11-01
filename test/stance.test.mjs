/**
 * 看法只在这句话碰上时出一步。闲聊不出。偏离大的优先。
 * 运行：node test/stance.test.mjs
 */
import { leansFromMeter, matchStance } from '../src/algo/stance.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 500)) }
}

const danger = [{ key: 'safe', pole: 'lo', dev: 0.3 }]
const hit = matchStance('这件事还没发生，会不会出事', danger)
check('危险世界碰上未发生的事', hit && hit.line === '先问会不会出事', hit)
check('同一条看法，闲聊不出', matchStance('今天天气不错', danger) === null)
check('没有这条偏离，就不出', matchStance('会不会出事', []) === null)
check('空话不出', matchStance('   ', danger) === null)

const both = [
  { key: 'safe', pole: 'lo', dev: 0.1 },
  { key: 'security', pole: 'hi', dev: 0.4 },
]
const win = matchStance('会不会出事，我怕会失去', both)
check('两条都碰上时偏离大的赢', win && win.key === 'security' && win.line === '先把会失去的那部分说清', win)

const leans = leansFromMeter({
  world: [{ key: 'safe', weight: 0.2 }, { key: 'agency', weight: 0.52 }],
  life: [{ key: 'purpose', weight: 0.7 }],
  values: [{ key: 'benevolence', weight: 0.4 }, { key: 'security', weight: 0.11 }, { key: 'power', weight: 0.1 }, { key: 'achievement', weight: 0.2 }],
})
check('世界观没偏够的不进', !leans.some((x) => x.key === 'agency'), leans)
check('危险世界进了低侧', leans.some((x) => x.key === 'safe' && x.pole === 'lo'))
check('人生观朝向进了高侧', leans.some((x) => x.key === 'purpose' && x.pole === 'hi'))
check('价值观只留拉开的前三，不含贴着初值的权力', leans.filter((x) => x.pole === 'hi' && ['benevolence', 'security', 'power', 'achievement'].includes(x.key)).map((x) => x.key).sort().join(',') === 'achievement,benevolence,security', leans)

const flat = leansFromMeter({ values: [{ key: 'benevolence', weight: 0.11 }, { key: 'security', weight: 0.1 }] })
check('价值观几乎一样高就不算', flat.length === 0, flat)

const all = leansFromMeter({
  world: [
    ['safe', 0.2], ['enticing', 0.8], ['alive', 0.2], ['just', 0.8], ['agency', 0.8],
    ['trustPeople', 0.2], ['complexity', 0.8], ['revisable', 0.2],
  ].map(([key, weight]) => ({ key, weight })),
  life: [
    ['purpose', 0.8], ['horizon', 0.2], ['communion', 0.8], ['growth', 0.2],
    ['coherence', 0.8], ['mattering', 0.2], ['search', 0.8],
  ].map(([key, weight]) => ({ key, weight })),
  values: [
    ['benevolence', 0.3], ['universalism', 0.2], ['selfDirection', 0.16], ['security', 0.14],
    ['tradition', 0.12], ['conformity', 0.11], ['achievement', 0.1],
  ].map(([key, weight]) => ({ key, weight })),
})
for (const chat of ['今天天气不错', '在吗', '哈哈好', '晚上吃什么']) {
  check('闲聊不出：' + chat, matchStance(chat, all) === null, matchStance(chat, all))
}
check('低侧「没什么好看」不误触高侧', matchStance('真没什么好看的', leansFromMeter({ world: [{ key: 'enticing', weight: 0.8 }] })) === null)

const step = matchStance('那我怎么办', leansFromMeter({ world: [{ key: 'agency', weight: 0.8 }] }))
check('问怎么办才给下一步', step && step.line === '给一个他能做的下一步', step)

console.log(`\n通过 ${pass} / ${pass + fail}`)
process.exit(fail ? 1 : 0)
