/**
 * 开环别把技术讨论当待办。
 *
 * 真实库里误挂过两条：一条是「用户正在检查某段代码的缺陷…」，
 * 一条是「BAD_TAIL 的判定范围过宽…」。它们是技术讨论，不是承诺，
 * 挂在 open_loops 里会每轮提醒我一次。
 *
 * 运行：node test/loop-guard.test.mjs
 */
import { detectLoop } from '../src/modules/loops.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)) }
}

// 技术讨论：不该挂
const NOT_LOOP = [
  '用户正在检查某段代码的缺陷，其中发现一处问题：`oneLine(body, 60)` 的调用位置排在 fade 之后。',
  '`BAD_TAIL` 的判定范围过宽，会把“然后再说别的”这类正常句尾误判为残句，导致整档内容被挡掉。',
  '这个函数返回的时间格式不对，时区没带。',
  '数据库那张表结构改过了，字段名换了一个。',
]

/**
 * 状态汇报：也不该挂。
 * 这类句子带「待办」两个字，可它只是在说事情进行到哪一步，没人被派活。
 * 真挂上去，过两天我就会去催主人「那个还没弄完吧」。
 */
const STATUS_REPORT = [
  '当前任务已进入收尾阶段，待办包括重载规则兜底修复、线上终验和汇总前后数据。',
  '目前已进入测试阶段，还有两个没通过。',
  '正在进行第二轮压测，数据还在跑。',
  '这一版已处于联调状态，接口都通了。',
]
for (const t of STATUS_REPORT) {
  const r = detectLoop(t)
  check('状态汇报不挂：' + t.slice(0, 18), r === null, r)
}

for (const t of NOT_LOOP) {
  const r = detectLoop(t)
  check('技术讨论不挂：' + t.slice(0, 18), r === null, r)
}

// 技术待办：照样挂
const IS_LOOP = [
  '答应过周末把脚本修好，修完先跑一遍不出假数据。',
  '待办改进方向：将插件注入的意识体包内容接入 QQ 端 reply() 的 prompt。',
  '回头把那个接口改一下，返回的时候区补上。',
  '明天记得提醒我交表。',
  // 同样说「收尾阶段」，但句子里有「你」——这是在派活，照样挂
  '你明天把收尾阶段的报告发我，待办里那两条也算上。',
]
for (const t of IS_LOOP) {
  const r = detectLoop(t)
  check('该挂的照样挂：' + t.slice(0, 18), !!r && !!r.kind, r)
}

// 已经做完的不挂
check('完成句不挂', detectLoop('已经搞定了，脚本跑通了，不用再管它了') === null)
// 太短的不挂
check('太短不挂', detectLoop('回头再说') === null)
// 纯应答不挂
check('纯应答不挂', detectLoop('好的') === null)

console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exitCode = 1
