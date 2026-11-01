/**
 * G1-4：时间解析（表驱动，固定「现在」，与时区无关：期望值用本地构造）。
 * 运行：node test/g1-4-timeparse.test.mjs
 */
import { parseTimeRange, cnNum } from '../src/modules/timeparse.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)) }
}

const NOW = new Date(2026, 10, 1, 15, 0, 0) // 2026-11-01 周日 15:00（本地）
const L = (y, m, d = 1, h = 0) => new Date(y, m, d, h).toISOString()
const addD = (y, m, d, n) => L(y, m, d + n)

/** [问句, from, to, 粒度]；from=null 表示期望 null */
const CASES = [
  ['2026-03-15 我喝什么', L(2026, 2, 15), L(2026, 2, 16), 'day'],
  ['2026/3/5 那天', L(2026, 2, 5), L(2026, 2, 6), 'day'],
  ['2026年3月15日', L(2026, 2, 15), L(2026, 2, 16), 'day'],
  ['3月15日那天我说了啥', L(2026, 2, 15), L(2026, 2, 16), 'day'],
  ['12月25号', L(2025, 11, 25), L(2025, 11, 26), 'day'],
  ['三月十五号', L(2026, 2, 15), L(2026, 2, 16), 'day'],
  ['2026年3月', L(2026, 2), L(2026, 3), 'month'],
  ['3月份我喜欢什么', L(2026, 2), L(2026, 3), 'month'],
  ['十二月', L(2025, 11), L(2026, 0), 'month'],
  ['去年三月我喜欢喝什么', L(2025, 2), L(2025, 3), 'month'],
  ['去年3月15日', L(2025, 2, 15), L(2025, 2, 16), 'day'],
  ['去年十二月', L(2025, 11), L(2026, 0), 'month'],
  ['前年夏天', L(2024, 5), L(2024, 8), 'season'],
  ['今年春天', L(2026, 2), L(2026, 5), 'season'],
  ['去年冬天', L(2025, 11), L(2026, 2), 'season'],
  ['冬天的时候', L(2025, 11), L(2026, 2), 'season'],
  ['2026 年春天我去了一趟西安', L(2026, 2), L(2026, 5), 'season'],
  ['去年', L(2025, 0), L(2026, 0), 'year'],
  ['2025年的时候', L(2025, 0), L(2026, 0), 'year'],
  ['昨天', L(2026, 9, 31), L(2026, 10, 1), 'day'],
  ['前天聊了啥', L(2026, 9, 30), L(2026, 9, 31), 'day'],
  ['大前天', L(2026, 9, 29), L(2026, 9, 30), 'day'],
  ['上周', L(2026, 9, 19), L(2026, 9, 26), 'week'],
  ['上周三', L(2026, 9, 21), L(2026, 9, 22), 'day'],
  ['上周末', L(2026, 9, 24), L(2026, 9, 26), 'days'],
  ['上上周', L(2026, 9, 12), L(2026, 9, 19), 'week'],
  ['上个星期', L(2026, 9, 19), L(2026, 9, 26), 'week'],
  ['上个月', L(2026, 9), L(2026, 10), 'month'],
  ['上上个月', L(2026, 8), L(2026, 9), 'month'],
  ['三天前', L(2026, 9, 29), L(2026, 9, 30), 'day'],
  ['三天之前', L(2026, 9, 29), L(2026, 9, 30), 'day'],
  ['两周前', L(2026, 9, 12), L(2026, 9, 19), 'week'],
  ['三个月前', addD(2026, 7, 1, -15), addD(2026, 7, 1, 16), 'window'],
  ['一个月前', addD(2026, 9, 1, -15), addD(2026, 9, 1, 16), 'window'],
  ['半年前', addD(2026, 4, 1, -15), addD(2026, 4, 1, 16), 'window'],
  ['两年前', addD(2024, 10, 1, -90), addD(2024, 10, 1, 91), 'window'],
  ['前几天', L(2026, 9, 26), L(2026, 10, 1), 'days'],
  // 闰年
  ['2024年2月29日', L(2024, 1, 29), L(2024, 2, 1), 'day'],
  ['2025年2月29日', null],
  ['2月29日', L(2024, 1, 29), L(2024, 2, 1), 'day'],
  // 无锚点 / 现在进行时 / 未来 → null
  ['当时我喜欢什么', null],
  ['那时候你记得吗', null],
  ['我以前养过狗', null],
  ['今天吃什么', null],
  ['这个月忙不忙', null],
  ['明天去哪', null],
  ['我喜欢喝咖啡', null],
  ['我最近开始学游泳，每周两次', null],
  ['马上周末了', null],
  ['晚上周三见', null],
  ['之前天气不错', null],
  ['之前年轻的时候', null],
  ['三个月的计划', null],
  ['2027年3月', null],
  ['2026年12月', null],
  ['2026年13月', null],
]

for (const [q, from, to, g] of CASES) {
  const r = parseTimeRange(q, { now: NOW })
  if (from === null) check(`「${q}」→ null`, r === null, r)
  else check(`「${q}」→ ${g}`, r && r.from === from && r.to === to && r.granularity === g, { got: r, want: { from, to, g } })
}

// 截到现在：本月
{
  const r = parseTimeRange('十一月', { now: NOW })
  check('本月截到现在（clipped）', r && r.from === L(2026, 10) && r.to === NOW.toISOString() && r.clipped, r)
}

// 跨零点：本地 3/15 00:30 算 3/15，3/14 23:30 不算
{
  const r = parseTimeRange('3月15日', { now: NOW })
  const inR = (t) => t >= r.from && t < r.to
  check('跨零点：00:30 落在当天', inR(new Date(2026, 2, 15, 0, 30).toISOString()))
  check('跨零点：前一晚 23:30 不落在当天', !inR(new Date(2026, 2, 14, 23, 30).toISOString()))
}

// 跨年：现在 = 2026-01-05
{
  const now = new Date(2026, 0, 5, 10)
  const a = parseTimeRange('上个月', { now })
  check('跨年：上个月 = 2025-12', a && a.from === L(2025, 11) && a.to === L(2026, 0), a)
  const b = parseTimeRange('十二月', { now })
  check('跨年：十二月 = 2025-12', b && b.from === L(2025, 11), b)
  const c = parseTimeRange('今年冬天', { now })
  check('跨年：一月说今年冬天 = 正在过的冬天', c && c.from === L(2025, 11) && c.clipped, c)
  const d = parseTimeRange('上周', { now })
  check('跨年：上周跨年', d && d.from === L(2025, 11, 29) && d.to === L(2026, 0, 5), d)
}

// 数字
check('cnNum 十五', cnNum('十五') === 15)
check('cnNum 二十一', cnNum('二十一') === 21)
check('cnNum 十', cnNum('十') === 10)
check('cnNum 全角', cnNum('１２') === 12)
check('cnNum 两', cnNum('两') === 2)

console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exitCode = 1
