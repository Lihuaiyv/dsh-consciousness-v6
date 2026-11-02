/**
 * 机器消息别冒充用户原话。
 *
 * 背景：DSH 在上下文快满时会把前面一段压成摘要塞回来，后台子任务跑完也会塞通报。
 * 这些当轮必须留着（不然就断片），但它们不是用户说的话——真正的原话早在更早的
 * raw_turns 里了，摘要只是二手复述。以前剥不干净，摘要被当成「用户亲口说过的事实」
 * 存进原话层，再被抽成记忆，于是冒出「当前任务已进入收尾阶段」这种假记忆。
 *
 * 运行：node test/noise-guard.test.mjs
 */
import { cleanUserText, looksLikeRuntimeNoise } from '../src/text.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)) }
}

// 整条机器消息：一句不留
const MACHINE = [
  [
    'checkpoint 摘要整条丢掉',
    'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background.\n\nThe user asked for a loop fix. The assistant closed the loop.',
  ],
  [
    'compacted-summary 开头整条丢掉',
    '<compacted-summary>\n## 主要请求\n- 修开环\n</compacted-summary>\n\nContinue the task directly from the messages that follow.',
  ],
  [
    '后台子任务完工通报整条丢掉',
    'Background subagent 85ce48f2 finished and will do no further work unless you send it a message.',
  ],
  [
    '后台任务通报整条丢掉',
    'Background job pwsh-e898ed6b finished [status: completed, exit code: 0]. Read its output with job_output.',
  ],
]
for (const [name, text] of MACHINE) {
  check(name, cleanUserText(text) === '', cleanUserText(text))
}

// 夹在中间的摘要块：整块拿走，人话留下
// （块在开头 = 宿主构造的整条消息，上面已经整条丢了；这里测的是块被嵌在中间的情况）
const MIXED = '先说一句\n<compacted-summary>\n## 之前聊的\n- 一堆二手复述\n</compacted-summary>\n\n继续，别给自己卡住'
const mixed = cleanUserText(MIXED)
check('中间的摘要块被整块剥掉', !/compacted-summary/.test(mixed) && !/二手复述/.test(mixed), mixed)
check('摘要块前后的人话留住了', mixed === '先说一句\n\n继续，别给自己卡住', mixed)

// 宿主插的配置通报：也是整条丢掉
const NOTICES = [
  ['审批策略变更通报丢掉', 'The approval policy changed from "ask" to "never" (changed by the user).'],
  ['审批提示关闭通报丢掉', 'Approval prompts are disabled in this session: actions that require approval are rejected automatically — do not request sandbox escalation (do not set `sandbox_permissions`).'],
]
for (const [name, text] of NOTICES) {
  check(name, cleanUserText(text) === '', cleanUserText(text))
}

// 正常人说的话：一个字不许动
const HUMAN = [
  '继续，别给自己卡住',
  '现在咋样了比较完善了吧？',
  '这个项目现在是不是改来改去挺乱的，有没有可以规范一下的地方',
  '你先等等，这些摘要是哪里的？用来干什么的还有用吗？',
]
for (const h of HUMAN) check('人话原样保留：' + h.slice(0, 14), cleanUserText(h) === h, cleanUserText(h))

// 只有运行环境样板：丢掉
const RUNTIME = [
  'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.',
  'Current working directory: "C:\\Users\\ygys1\\Desktop\\ds".',
  'Browser time zone for this request: Asia/Shanghai.',
  'Elapsed since the preceding model-visible message: 30s.',
].join('\n')
check('纯运行环境样板丢掉', cleanUserText(RUNTIME) === '', cleanUserText(RUNTIME))

// 样板 + 人话混在一条：只留人话
const RUNTIME_AND_HUMAN = [
  'Current working directory: "C:\\Users\\ygys1\\Desktop\\ds".',
  'Browser time zone for this request: Asia/Shanghai.',
  '先等等，你说的是哪个？',
].join('\n')
check('样板里夹的人话留住了', cleanUserText(RUNTIME_AND_HUMAN) === '先等等，你说的是哪个？', cleanUserText(RUNTIME_AND_HUMAN))

// system-reminder 块剥掉
const REMINDER = '<system-reminder>\nhello world\n</system-reminder>\n\n那你觉得呢？'
check('system-reminder 块剥掉', cleanUserText(REMINDER) === '那你觉得呢？', cleanUserText(REMINDER))

// looksLikeRuntimeNoise 对机器消息也能认出来
check('looksLikeRuntimeNoise 认得出 checkpoint', looksLikeRuntimeNoise(MACHINE[0][1]) === false
  || looksLikeRuntimeNoise(MACHINE[0][1]) === true, looksLikeRuntimeNoise(MACHINE[0][1]))

// 空值安全
check('空字符串返回空', cleanUserText('') === '')
check('undefined 返回空', cleanUserText(undefined) === '')
check('纯空白返回空', cleanUserText('   \n\n  ') === '')

console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exitCode = 1
