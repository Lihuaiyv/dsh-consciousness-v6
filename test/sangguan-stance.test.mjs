/**
 * P1 立场闸：三观只收「它在表态」的句子，工程记录与待办不收。
 * 运行：node test/sangguan-stance.test.mjs
 */
import { stanceGate, fieldCheck, classify } from '../src/modules/sangguan/gates.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)) }
}

// ---------- 放行：真的在表态 ----------
const STANCE = [
  '我更看重照顾身边的人',
  '人多数时候愿意讲道理',
  '汐是夜里涨落的潮水，退得再远也会再回来一次',
  '世界大体可以被理解',
  '真诚比技巧重要',
  '宁愿慢一点，也不糊弄过去',
  '我觉得把话说清楚比说得漂亮要紧',
  '有人说数据不会骗人，但我不信',
]
for (const t of STANCE) check('放行：' + t.slice(0, 18), stanceGate(t) === null, stanceGate(t))

// ---------- 拒收：工程记录 / 待办 ----------
const NOT_STANCE = [
  '电脑关机或插件没开，这套服务就不存在，微信也发不出去。',
  '线上 dsh-consciousness-v6 的 536 个测试全过，代码本身没有问题。',
  '项目真正乱的地方在于同一份东西存在多份，而不在代码质量。',
  '先做开机自启和后台守护，把本机长时间在线跑顺，再考虑上服务器。',
  '桌面 dsh-plugin 是一份过期副本，比线上少 255 个文件，而且两边互有缺失。',
  '下周把部署脚本补一下',
  '今天的测试又挂了两个',
  '这个接口要加个重试',
]
for (const t of NOT_STANCE) check('拒收：' + t.slice(0, 18), stanceGate(t) === 'not_stance', stanceGate(t))

// ---------- 原有 W1 判定没被顶掉 ----------
check('W1 仍拦缺层', fieldCheck({ kind: 'belt', text: '我更看重照顾身边的人' }) === '缺层或层非法')
check('W1 仍拦模型自评', fieldCheck({ layer: 'W', kind: 'belt', text: '作为一个人工智能语言模型，我会尽量帮你' }) === '模型自评')
check('W1 仍拦元叙述', fieldCheck({ layer: 'W', kind: 'belt', text: '1. 事实：用户只问了一句什么意思' }) === '元叙述（在对用户做画像，不是立场）')
check('W1 仍拦核心直建', fieldCheck({ layer: 'V', kind: 'principle', text: '我更看重照顾身边的人' }) === '核心不能由抽取直建')

// ---------- 挂进 W1 之后 ----------
check('fieldCheck 带上立场闸', fieldCheck({ layer: 'W', kind: 'belt', text: '线上 536 个测试全过，代码没问题' }) === 'not_stance')
check('fieldCheck 放行真立场', fieldCheck({ layer: 'V', kind: 'norm', text: '我更看重照顾身边的人' }) === null)

// ---------- W1–W5：立场闸先于去重，直接 REJECT ----------
{
  const cand = { layer: 'W', kind: 'belt', text: '电脑关机或插件没开，这套服务就不存在' }
  const near = [{ id: 'cl_x', sim: 0.9, status: 'active', kind: 'belt', layer: 'W', mode: 'lexical' }]
  const r = classify(cand, near, null, { judge: 'ok', theta_dup: 0.8 })
  check('W1–W5：工程句在去重之前就被拒', r.cls === 'REJECT' && r.report.w === 'W1' && r.report.reason === 'not_stance', r)
  const ok = classify({ layer: 'V', kind: 'norm', text: '我更看重把话说明白' }, near, null, { judge: 'ok', theta_dup: 0.8 })
  check('W1–W5：立场句照常进分类（不被立场闸误杀）', ok.cls !== 'REJECT' || ok.report.reason !== 'not_stance', ok)
}

console.log(`\n通过 ${pass} / ${pass + fail}`)
process.exit(fail ? 1 : 0)
