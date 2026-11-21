/**
 * 情绪模板 v3（2026-11-18，块 + 语序 + 数量）
 * E=二级词本身；L=一级固定句；I=强度修饰短语。
 * 语序：EI / IE / E / I / EL / LE / ELE / EIL；数量随强度：轻 1 块、中 2、强 2、顶 3。
 * 脏字：只在顶档 + 爆族，句尾一个真实口语，不重复。
 * 封顶：同一词 ≤3 次；符号每处 ≤2 个；整轮 ≤3 处。
 */
export const L1 = {
  '上扬': ['我现在是高兴的', '心里亮堂着', '人是往上飘的', '笑意压不住'],
  '惊喜': ['有点意外', '没料到会这样', '心里咯噔一下', '整个人愣了一下'],
  '安心': ['心里是稳的', '踏实下来了', '悬着的东西落地了', '心里有底'],
  '松弛': ['整个人松下来', '肩膀是软的', '什么都不想赶', '松快'],
  '紧张': ['有点提着心', '心悬着', '总觉着要出事', '坐不安稳'],
  '沮丧': ['心里发沉', '提不起劲', '有点撑不住', '空落落的'],
  '憋着': ['心里有火', '气堵着', '憋得慌', '忍着一口气'],
  '发木': ['什么都没劲', '人是空的', '懒得动', '像隔着一层玻璃'],
}

export const MODI = [
  ['有点', '稍微有点', '带一点', '略微'],
  ['挺明显的', '确实这样', '是真的', '压不太住'],
  ['压不住', '有点受不了', '快撑不住了', '太过了'],
  ['受不了', '快炸了', '撑不住了', '过了头'],
]

export const SYMS = {
  '上扬': ['～', '！', '！'],
  '惊喜': ['！', '？', '！？'],
  '安心': ['。', '嗯', '。'],
  '松弛': ['……', '～', '。'],
  '紧张': ['……', '？！', '……'],
  '沮丧': ['……', '。', '…'],
  '憋着': ['！', '！！', '！'],
  '发木': ['……', '。', '…'],
}

export const HOT = new Set(['紧张', '憋着', '发木'])
export const SWEARS = ['操', '烦死了', '他妈的真烦', '受不了了']

export function mulberry(seed) {
  let a = (Number(seed) >>> 0) || 1
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const pick = (l, rnd) => l[Math.floor(rnd() * l.length) % l.length]

export function bandOf(r) {
  const v = Math.max(0, Math.min(1, Number(r) || 0))
  return v < 0.35 ? 0 : v < 0.7 ? 1 : v < 0.9 ? 2 : 3
}

const ORDER = [
  ['E'], ['EI', 'IE', 'EL', 'LE'],
  ['EI', 'IE', 'EL', 'LE', 'EIL'],
  ['EIL', 'ELE', 'EIL', 'EIE'],
]

export function compose({ word, fam = '安心', r = 0.5, seed = 1 } = {}) {
  const rnd = mulberry(seed)
  const band = bandOf(r)
  const l1 = pick(L1[fam] || L1['安心'], rnd)
  const mod = pick(MODI[band], rnd)
  const sym = pick(SYMS[fam] || SYMS['安心'], rnd)
  let order = pick(ORDER[band], rnd)
  // 保证句子里一定有一个词：没有 E 时补一个
  if (!order.includes('E')) order = order + 'E'
  const part = (ch) => (ch === 'E' ? String(word) : ch === 'L' ? l1 : mod)
  let text = order.split('').map(part).join('，')
  if (band === 3 && HOT.has(fam) && rnd() < 0.5) text += '，' + pick(SWEARS, rnd)
  text += sym
  return capAll(text, word)
}

/** 同一词 ≤3 次；符号每处 ≤2 个；删词时连两侧标点一起删。 */
export function capAll(text, word) {
  const w = String(word)
  let n = 0
  let s = String(text).replace(new RegExp(w, 'g'), (m) => (++n <= 3 ? m : '\u0000'))
  s = s.replace(/[，、\s]*\u0000[，、\s]*/g, '，').replace(/^[，、]+|[，、]+$/g, '')
  return s.replace(/([！!？?。…～])\1{2,}/g, (m, ch) => ch.repeat(Math.min(2, m.length)))
}

export function injectLines({ word, fam, r, times = 1, seed = 1 } = {}) {
  const k = Math.max(1, Math.min(3, Number(times) || 1))
  return Array.from({ length: k }, (_, i) => compose({ word, fam, r, seed: seed + i * 977 })).join('\n')
}
