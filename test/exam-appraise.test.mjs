/**
 * 情绪评价零件 · 考卷
 *
 * 管的是「这句话让她什么感觉」里的**判**：标签 + 几项分量（相关性 / 一致 / 分因）。
 * 不管「判完之后水位怎么涨」——那是情绪动力，还没立零件。
 *
 * 运行：node test/exam-appraise.test.mjs
 */
import { rulesAppraise, appraiseV1, appraiseV1b } from '../src/algo/appraise.js'
import { run as algoRun } from '../src/algo/index.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 500)) }
}
const v1 = (input) => algoRun('appraise', 'v1', {}, input)
const v1b = (input) => algoRun('appraise', 'v1b', {}, input)

// ================================================================ 规则：冲我来的才影响我
{
  const praise = rulesAppraise('你真好')
  check('冲我来的夸奖 → joy', praise.label === 'joy', praise.label)
  check('夸奖的一致性为正', praise.goal_congruence === 0.6, praise.goal_congruence)
  check('谢谢也算夸', rulesAppraise('谢谢你').label === 'joy', rulesAppraise('谢谢你').label)

  const critic = rulesAppraise('你太烦了')
  check('冲我来的批评 → irritated', critic.label === 'irritated', critic.label)
  check('批评的一致性为负', critic.goal_congruence === -0.6, critic.goal_congruence)

  const negated = rulesAppraise('你不好')
  check('否定式不是夸（你不好）', negated.label === 'irritated', negated.label)
  check('否定式不记正分', negated.goal_congruence === -0.6, negated.goal_congruence)

  const selfMood = rulesAppraise('我今天很开心')
  check('自述心情不进主标签', selfMood.label === 'calm', selfMood.label)
  check('自述心情进 user_label', selfMood.user_label === 'joy', selfMood.user_label)
  check('自述心情不改一致性', selfMood.goal_congruence === 0, selfMood.goal_congruence)
}

// ================================================================ 规则：问句 / 威胁 / 空
{
  check('问句 → curious', rulesAppraise('你明天来吗？').label === 'curious', rulesAppraise('你明天来吗？').label)
  const unsure = rulesAppraise('可能是吧')
  check('不确定 → curious', unsure.label === 'curious', unsure.label)
  check('不确定时把握低', unsure.certainty === 0.3, unsure.certainty)
  check('不确定时新奇高', unsure.novelty === 0.6, unsure.novelty)

  check('威胁词 → lost', rulesAppraise('密码泄露了').label === 'lost', rulesAppraise('密码泄露了').label)
  const empty = rulesAppraise('')
  check('空话 → calm 且相关性 0', empty.label === 'calm' && empty.goal_relevance === 0, empty)
  check('空话不改一致性', empty.goal_congruence === 0, empty.goal_congruence)
}

// ================================================================ 规则：分因 / 混合 / 边界
{
  const directed = rulesAppraise('你今天好看')
  check('带「你」算冲我来的', directed.agency === 'other', directed.agency)
  const own = rulesAppraise('我今天写完了一段')
  check('不带「你」算自己的事', own.agency === 'self', own.agency)
  check('有内容就算相关', directed.goal_relevance === 0.8, directed.goal_relevance)

  const mixed = rulesAppraise('你真好笑，又真烦')
  check('夸和批一起出现 → 不偏袒', mixed.label === 'calm', mixed.label)
  check('混合时 user_label 记批评', mixed.user_label === 'irritated', mixed.user_label)
  check('混合时一致性回到 0', mixed.goal_congruence === 0, mixed.goal_congruence)

  const noYou = rulesAppraise('别说了')
  check('没点名就不算冲我来的', noYou.label === 'calm', noYou.label)
  check('没点名仍记对方情绪', noYou.user_label === 'irritated', noYou.user_label)

  const long = rulesAppraise('前面说了一大堆话，' + '反反复复。'.repeat(200) + '最后你真好')
  check('长文本仍认得出夸奖', long.label === 'joy', long.label)
  check('规则来源标 rules', long.source === 'rules', long.source)
}

// ================================================================ 对照版 v1b：更敏感
{
  const p = rulesAppraise('你真好')
  const c = rulesAppraise('你太烦了')
  check('v1b 夸奖更重', v1b({ text: '你真好' }).goal_congruence === 0.85)
  check('v1b 批评更重', v1b({ text: '你太烦了' }).goal_congruence === -0.85)
  check('v1b 不确定性新奇更高', v1b({ text: '可能是吧' }).novelty === 0.75, v1b({ text: '可能是吧' }).novelty)
  check('v1b 威胁也走 lost', v1b({ text: '有人发起攻击' }).label === 'lost', v1b({ text: '有人发起攻击' }).label)
  check('v1b 相关性更高', v1b({ text: '你真好' }).goal_relevance === 0.9, v1b({ text: '你真好' }).goal_relevance)
  void p; void c
}

// ================================================================ 算法入口 v1：模型说了算
{
  const fromModel = appraiseV1.run({}, { text: '你真好', hint: { label: 'curious', source: 'model', goal_relevance: 0.4 } })
  check('v1 采用模型标签', fromModel.label === 'curious', fromModel.label)
  check('v1 采用模型相关性', fromModel.goal_relevance === 0.4, fromModel.goal_relevance)
  check('v1 标明来源 model', fromModel.source === 'model', fromModel.source)
  check('v1 结果带算法名', fromModel.algo && fromModel.algo.name === 'appraise' && fromModel.algo.version === 'v1', fromModel.algo)

  const none = v1({ text: '今天天气不错', hint: { label: 'calm', source: 'model', none: true, goal_relevance: 0.9 } })
  check('none 把相关性压到地板', none.goal_relevance <= 0.15, none.goal_relevance)
  check('none 标出来', none.none === true, none.none)
  check('none 时目标是 none', none.target === 'none', none.target)

  const noChange = v1({ text: '你真好', hint: { label: 'joy', source: 'model' } })
  check('没给 change 就是 null（不能变 0）', noChange.change === null, noChange.change)
  const withChange = v1({ text: '你真好', hint: { label: 'joy', source: 'model', change: 0.4 } })
  check('给了 change 就收下', withChange.change === 0.4, withChange.change)

  const concern = v1({ text: '你真好', hint: { label: 'joy', source: 'model', concern_relevance: 0.9, goal_relevance: 0.1 } })
  check('关切口径优先于旧口径', concern.goal_relevance === 0.9, concern.goal_relevance)

  const over = v1({ text: '你真好', hint: { label: 'joy', source: 'model', goal_congruence: 1.5 } })
  check('一致性夹到 ±1', over.goal_congruence === 1, over.goal_congruence)

  const badAgency = v1({ text: '你真好', hint: { label: 'joy', source: 'model', agency: '外星人' } })
  check('非法分因退回 self', badAgency.agency === 'self', badAgency.agency)
  check('分因缺省是 me', badAgency.target === 'me', badAgency.target)

  const badReceive = v1({ text: '你真好', hint: { label: 'joy', source: 'model', receive: '乱写' } })
  check('非法接法退回 auto', badReceive.receive === 'auto', badReceive.receive)
  const dampen = v1({ text: '你真好', hint: { label: 'joy', source: 'model', receive: 'dampen' } })
  check('合法接法收下', dampen.receive === 'dampen', dampen.receive)

  const longWhy = v1({ text: '你真好', hint: { label: 'joy', source: 'model', why: '因'.repeat(300), unsaid: '言'.repeat(300) } })
  check('why 截到 120 字', longWhy.why.length === 120, longWhy.why.length)
  check('unsaid 截到 120 字', longWhy.unsaid.length === 120, longWhy.unsaid.length)

  const nothing = v1({ text: '你真好' })
  check('没 hint 就走规则', nothing.label === 'joy' && nothing.source === 'rules', { label: nothing.label, source: nothing.source })
  const junk = v1({ text: '你真好', hint: '不是对象' })
  check('hint 不是对象也走规则', junk.label === 'joy' && junk.source === 'rules', junk.label)

  const emptyLabel = v1({ text: '你真好', hint: { source: 'model' } })
  check('模型没给标签就 calm', emptyLabel.label === 'calm', emptyLabel.label)

  const weird = v1({ text: '你真好', hint: { label: '不认识的词', source: 'model' } })
  check('算法层不筛词（词表闸在上游）', weird.label === '不认识的词', weird.label)
}

// ================================================================ 对照版 v1b：始终走规则
{
  const ignored = v1b({ text: '你真好', hint: { label: 'curious', source: 'model', goal_relevance: 0.1 } })
  check('v1b 忽略模型标签', ignored.label === 'joy', ignored.label)
  check('v1b 忽略模型相关性', ignored.goal_relevance === 0.9, ignored.goal_relevance)
  check('v1b 结果带算法名', ignored.algo && ignored.algo.version === 'v1b', ignored.algo)
}

// ================================================================ 规则与算法一致
{
  const t = '你今天真好看'
  const byRules = rulesAppraise(t)
  const byAlgo = v1({ text: t })
  check('规则和 v1 无 hint 时同判', byRules.label === byAlgo.label && byRules.goal_congruence === byAlgo.goal_congruence, { byRules: byRules.label, byAlgo: byAlgo.label })
  check('规则版有 source', byRules.source === 'rules', byRules.source)
  check('算法版补 unsaid 字段', typeof byAlgo.unsaid === 'string')
}

console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exitCode = 1
