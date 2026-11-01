/**
 * G1-4 时间解析：把问句里「有锚点的过去时间」解析成半开区间 [from, to)。
 *
 *   - 本地日界（进程时区）换算成 UTC ISO，和 localDay / raw_turns.day 同一套口径；
 *   - 只认有锚点的表达；「当时 / 那时 / 以前」不触发，避免劫持日常检索；
 *   - 「3 月」不带年：取最近一个已开始的 3 月（含本月）；
 *   - to 截到现在；整段都在未来 → null；「今天 / 本周 / 这个月」这类「现在进行时」→ null（走普通检索）。
 *
 * 纯函数，可注入 now。
 */

const CN = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
const NUM = '[0-9０-９零〇一二两三四五六七八九十]+'
const SEASONS = { 春: 2, 夏: 5, 秋: 8, 冬: 11 }
const WEEKDAY = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0, 末: -1 }

/** 中文 / 全角 / 半角数字 → 整数（支持到 99）。 */
export function cnNum(s) {
  const t = String(s || '').replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
  if (/^\d+$/.test(t)) return Number(t)
  if (!t) return NaN
  if (t === '十') return 10
  const i = t.indexOf('十')
  if (i < 0) return t.length === 1 && CN[t] != null ? CN[t] : NaN
  const hi = i === 0 ? 1 : CN[t.slice(0, i)]
  const lo = i === t.length - 1 ? 0 : CN[t.slice(i + 1)]
  return hi == null || lo == null ? NaN : hi * 10 + lo
}

const D = (y, m, d = 1) => new Date(y, m, d)
const validDay = (y, m, d) => { const x = D(y, m, d); return x.getFullYear() === y && x.getMonth() === m && x.getDate() === d }
const startOfDay = (t) => D(t.getFullYear(), t.getMonth(), t.getDate())
const addDays = (t, n) => D(t.getFullYear(), t.getMonth(), t.getDate() + n)
const mondayOf = (t) => addDays(startOfDay(t), -((t.getDay() + 6) % 7))
const seasonRange = (y, s) => [D(y, SEASONS[s]), D(y, SEASONS[s] + 3)]

function finish(start, end, granularity, phrase, now) {
  if (!(start instanceof Date) || !(end instanceof Date) || Number.isNaN(+start) || Number.isNaN(+end)) return null
  if (+start >= +now) return null
  const clip = +end > +now ? now : end
  return { from: start.toISOString(), to: clip.toISOString(), granularity, phrase, clipped: +end > +now }
}

/** 年份前缀：今年 / 去年 / 前年 / 大前年 / 2025年 / 二〇二五年 */
function yearOf(tok, now) {
  const y = now.getFullYear()
  if (!tok) return null
  if (tok === '今年') return y
  if (tok === '去年') return y - 1
  if (tok === '前年') return y - 2
  if (tok === '大前年') return y - 3
  const m = tok.match(/^([0-9０-９]{4}|[零〇一二三四五六七八九]{4})年?$/)
  if (!m) return null
  const s = m[1].replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
  return /^\d{4}$/.test(s) ? Number(s) : Number([...s].map((c) => CN[c]).join(''))
}

const YEAR = '(今年|去年|前年|大前年|[0-9０-９]{4}\\s*年|[零〇一二三四五六七八九]{4}年)'

/**
 * @param {string} text
 * @param {{now?: Date|number|string}} [opt]
 * @returns {{from:string,to:string,granularity:string,phrase:string,clipped:boolean}|null}
 */
export function parseTimeRange(text, opt = {}) {
  const raw = String(text || '')
  if (!raw.trim()) return null
  // 「三天之前」→「三天前」；其余「之前 / 以前 / 目前 / 当前…」里的「前」不是锚点（防「之前天气」「之前年轻」误中）
  const unit = '(天|日|周|星期|礼拜|个月|个星期|年)'
  const s = raw
    .replace(new RegExp(`(${NUM})\\s*${unit}\\s*(之|以)前`, 'g'), '$1$2前')
    .replace(/(半\s*年)\s*(之|以)前/g, '$1前')
    .replace(/([之以提从先目当眼面跟空生])前/g, '$1＿')
    // 「马上 / 晚上 / 早上…」里的「上」不是「上周 / 上个月」
    .replace(/([马晚早楼路线身手头街墙桌床])上/g, '$1＿')
  const now = opt.now != null ? new Date(opt.now) : new Date()
  if (Number.isNaN(+now)) return null
  const today = startOfDay(now)
  const Y = now.getFullYear()
  const M = now.getMonth()
  let m

  // ISO / 斜杠日期：2026-03-15、2026/3/15、2026-03
  if ((m = s.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/))) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])]
    if (!validDay(y, mo, d)) return null
    return finish(D(y, mo, d), D(y, mo, d + 1), 'day', m[0], now)
  }
  if ((m = s.match(/(\d{4})[-/](\d{1,2})(?![\d/-])/))) {
    const [y, mo] = [Number(m[1]), Number(m[2]) - 1]
    if (mo < 0 || mo > 11) return null
    return finish(D(y, mo), D(y, mo + 1), 'month', m[0], now)
  }

  // [年] M 月 D 日/号
  if ((m = s.match(new RegExp(`${YEAR}?\\s*(${NUM})\\s*月\\s*(${NUM})\\s*[日号]`)))) {
    const mo = cnNum(m[2]) - 1
    const d = cnNum(m[3])
    if (!(mo >= 0 && mo <= 11 && d >= 1 && d <= 31)) return null
    let y = m[1] ? yearOf(m[1].replace(/\s+/g, ''), now) : null
    if (y != null) {
      if (!validDay(y, mo, d)) return null
    } else {
      // 不带年：最近一个已经到过的这一天（2 月 29 日往回找闰年）
      y = Y
      let tries = 0
      while ((!validDay(y, mo, d) || +D(y, mo, d) > +today) && tries < 8) { y--; tries++ }
      if (!validDay(y, mo, d)) return null
    }
    return finish(D(y, mo, d), D(y, mo, d + 1), 'day', m[0], now)
  }

  // [年] M 月（「三个月」里的「个月」不算）
  if ((m = s.match(new RegExp(`${YEAR}?\\s*(${NUM})\\s*月(?:份)?(?![\\s]*[0-9０-９零〇一二两三四五六七八九十]+\\s*[日号])`)))
    && !/个\s*月/.test(m[0]) && !new RegExp(`${NUM}\\s*个\\s*月`).test(s.slice(Math.max(0, m.index - 1), m.index + m[0].length + 1))) {
    const mo = cnNum(m[2]) - 1
    if (mo >= 0 && mo <= 11) {
      let y = m[1] ? yearOf(m[1].replace(/\s+/g, ''), now) : null
      if (y == null) y = mo <= M ? Y : Y - 1
      return finish(D(y, mo), D(y, mo + 1), 'month', m[0], now)
    }
  }

  // [年] 春/夏/秋/冬（天/季）
  if ((m = s.match(new RegExp(`${YEAR}?\\s*(春|夏|秋|冬)(?:天|季)`)))) {
    const k = m[2]
    let y = m[1] ? yearOf(m[1].replace(/\s+/g, ''), now) : null
    if (y == null) y = +seasonRange(Y, k)[0] <= +now ? Y : Y - 1
    else if (k === '冬' && m[1] === '今年' && M <= 1) y = Y - 1 // 一二月说「今年冬天」= 正在过的这个冬天
    const [f, t] = seasonRange(y, k)
    return finish(f, t, 'season', m[0], now)
  }

  // 单独的年：去年 / 前年 / 2025年（放在月、季之后，避免吞掉「去年三月」）
  if ((m = s.match(/(去年|前年|大前年|[0-9０-９]{4}\s*年(?!\s*[0-9０-９零〇一二两三四五六七八九十]+\s*月)|[零〇一二三四五六七八九]{4}年)/))) {
    const y = yearOf(m[1].replace(/\s+/g, ''), now)
    if (y != null) return finish(D(y, 0), D(y + 1, 0), 'year', m[0], now)
  }

  // 昨天 / 前天 / 大前天
  if ((m = s.match(/(大前天|前天|昨天|昨日|昨晚|昨夜)/))) {
    const back = m[1] === '大前天' ? 3 : m[1] === '前天' ? 2 : 1
    return finish(addDays(today, -back), addDays(today, -back + 1), 'day', m[0], now)
  }

  // 上周X / 上周末 / 上上周 / 上周
  if ((m = s.match(/(上上|上)(?:个)?(?:周|星期|礼拜)([一二三四五六日天末])?/))) {
    const weeks = m[1] === '上上' ? 2 : 1
    const mon = addDays(mondayOf(now), -7 * weeks)
    if (m[2]) {
      const wd = WEEKDAY[m[2]]
      if (wd === -1) return finish(addDays(mon, 5), addDays(mon, 7), 'days', m[0], now)
      const off = (wd + 6) % 7
      return finish(addDays(mon, off), addDays(mon, off + 1), 'day', m[0], now)
    }
    return finish(mon, addDays(mon, 7), 'week', m[0], now)
  }

  // 上个月 / 上上个月
  if ((m = s.match(/(上上|上)(?:个)?月/))) {
    const back = m[1] === '上上' ? 2 : 1
    return finish(D(Y, M - back), D(Y, M - back + 1), 'month', m[0], now)
  }

  // N 天 / 周 / 个月 / 年 前；半年前
  if ((m = s.match(/半\s*年前/))) {
    const c = D(Y, M - 6, now.getDate())
    return finish(addDays(c, -15), addDays(c, 16), 'window', m[0], now)
  }
  if ((m = s.match(new RegExp(`(${NUM})\\s*(天|日|周|星期|礼拜|个月|个星期|年)前`)))) {
    const n = cnNum(m[1])
    if (!(n >= 1 && n <= 99)) return null
    const u = m[2]
    if (u === '天' || u === '日') return finish(addDays(today, -n), addDays(today, -n + 1), 'day', m[0], now)
    if (u === '周' || u === '星期' || u === '礼拜' || u === '个星期') {
      const mon = addDays(mondayOf(now), -7 * n)
      return finish(mon, addDays(mon, 7), 'week', m[0], now)
    }
    if (u === '个月') {
      const c = D(Y, M - n, now.getDate())
      return finish(addDays(c, -15), addDays(c, 16), 'window', m[0], now)
    }
    const c = D(Y - n, M, now.getDate())
    return finish(addDays(c, -90), addDays(c, 91), 'window', m[0], now)
  }

  // 前几天 / 前些天 / 这几天之前：最近一周（不含今天）
  if ((m = s.match(/(前几天|前些天|前些日子|前阵子)/))) {
    return finish(addDays(today, m[1] === '前阵子' || m[1] === '前些日子' ? -21 : -6), today, 'days', m[0], now)
  }

  return null
}

/** 问句里是否带有可解析的过去时间（给对话自动触发用）。 */
export function hasPastAnchor(text, opt = {}) {
  return parseTimeRange(text, opt) != null
}
