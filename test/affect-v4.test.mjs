/**
 * 三递质情绪引擎 v4：纯算法验收。
 * 运行：node test/affect-v4.test.mjs
 *
 * 影子期只锁「算得对」：三轴方向、八角的软分配、二级词的门控、旧事收口。
 * 不碰库、不调模型、不看线上行为。
 */
import {
  transmitters, primaryDistribution, secondaryDistribution, infer,
  shouldCloseFrame, extendFrame, PRIMARY_CORNERS, SECONDARY_PROTOTYPES,
  byAdjustedD, gateOf,
} from '../src/algo/affect_v4.js'
import { gridDistribution, nearestCell, slotOf, intensityOf, typicalityOf } from '../src/algo/grid_pick.js'
import { GRID_CELLS } from '../src/algo/lexicon_grid.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) } else {
    fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400))
  }
}
const near = (a, b, eps = 1e-3) => Math.abs(a - b) <= eps
const finite = (x) => Number.isFinite(x)
const sumP = (arr, key) => arr.reduce((s, x) => s + Number(x[key] || 0), 0)

/* ---------- 三递质：方向必须是现实物理那一侧 ---------- */

const good = transmitters({ goal_cong: 1, control: 1, certainty: 1 })
const bad = transmitters({ goal_cong: -1, control: 0, certainty: 0 })
check('血清素：现状好 → 高', good.s > 0.9, good)
check('血清素：现状不好 → 低', bad.s < 0.1, bad)
check('血清素：好和坏要拉开', good.s - bad.s > 0.8, { good: good.s, bad: bad.s })

const calmNow = transmitters({ expectation: 0, novelty: 0 })
const shock = transmitters({ expectation: 1, novelty: 1 })
check('去甲肾上腺素：稀松平常 → 低', calmNow.n < 0.2, calmNow)
check('去甲肾上腺素：脱离预期 → 高', shock.n > 0.9, shock)
check('去甲肾上腺素：低不等于零', calmNow.n > 0.05, calmNow)

const hopeful = transmitters({ future: 1 })
const hopeless = transmitters({ future: -1 })
check('多巴胺：未来往好的方向 → 高', hopeful.d > 0.99, hopeful)
check('多巴胺：未来反了 → 低', hopeless.d < 0.01, hopeless)

const noInfo = transmitters({})
check('缺字段：不炸、不编成 0', finite(noInfo.s) && finite(noInfo.n) && finite(noInfo.d), noInfo)
check('缺字段：三轴都在 0~1', [noInfo.s, noInfo.n, noInfo.d].every((x) => x >= 0 && x <= 1), noInfo)

/* ---------- 八个角：软分配，不是硬分桶 ---------- */

const even = primaryDistribution(0.5, 0.5, 0.5)
check('中心：八个角一样重', even.every((c) => near(c.weight, 0.125)), even.map((c) => c.weight))
check('中心：权重和 = 1', near(sumP(even, 'weight'), 1), sumP(even, 'weight'))
check('中心：没有塌成一个角', even[0].weight < 0.2, even[0])

check('疏淡顶：s=1,n=0,d=0 → 疏淡 第一', primaryDistribution(1, 0, 0)[0].name === '疏淡', primaryDistribution(1, 0, 0)[0])
check('安住顶：s=1,n=0,d=1 → 安住 第一', primaryDistribution(1, 0, 1)[0].name === '安住', primaryDistribution(1, 0, 1)[0])
check('警醒顶：s=1,n=1,d=0 → 警醒 第一', primaryDistribution(1, 1, 0)[0].name === '警醒', primaryDistribution(1, 1, 0)[0])
check('敞亮顶：s=1,n=1,d=1 → 敞亮 第一', primaryDistribution(1, 1, 1)[0].name === '敞亮', primaryDistribution(1, 1, 1)[0])
check('沉沦顶：s=0,n=0,d=0 → 沉沦 第一', primaryDistribution(0, 0, 0)[0].name === '沉沦', primaryDistribution(0, 0, 0)[0])
check('郁结顶：s=0,n=0,d=1 → 郁结 第一', primaryDistribution(0, 0, 1)[0].name === '郁结', primaryDistribution(0, 0, 1)[0])
check('惊惧顶：s=0,n=1,d=0 → 惊惧 第一', primaryDistribution(0, 1, 0)[0].name === '惊惧', primaryDistribution(0, 1, 0)[0])
check('渴慕顶：s=0,n=1,d=1 → 渴慕 第一', primaryDistribution(0, 1, 1)[0].name === '渴慕', primaryDistribution(0, 1, 1)[0])

check('八个角：名字不重', new Set(PRIMARY_CORNERS.map((c) => c.name)).size === 8, PRIMARY_CORNERS.map((c) => c.name))
check('八个角：正好覆盖 2^3', new Set(PRIMARY_CORNERS.map((c) => `${c.s}${c.n}${c.d}`)).size === 8)

/* ---------- 二级：门控管住「不是这件事就不该冒出来」 ---------- */

const baseFrame = { target: 'none', agency: 'self', goal_cong: -0.8, expectation: 0.2, future: -0.6 }
// 2026-11-20：返回是「同格优先」，前 N 名基本被同格占满，单看某个词有没有进前五验不出门控。
// 改成直接验门控乘数：库里写着「意思里就带着是谁」的词，对不上那一位就被压到 0.3。
const gateMul = (name, x) => gateOf((SECONDARY_PROTOTYPES.find((p) => p.name === name) || {}).gate, x)

check('愧疚：库里标了 self', JSON.stringify((SECONDARY_PROTOTYPES.find((p) => p.name === '愧疚') || {}).gate) === JSON.stringify(['self']))
check('愧疚：是我弄的（agency=self）→ 门控不打折', gateMul('愧疚', { target: 'none', agency: 'self' }) === 1)
check('愧疚：是对方弄的（agency=other）→ 门控压到 0.3', near(gateMul('愧疚', { target: 'none', agency: 'other' }), 0.3, 1e-9))

const wrongedX = { target: 'other', agency: 'other' }
const notWrongedX = { target: 'me', agency: 'other' }
check('委屈：库里标了 other', JSON.stringify((SECONDARY_PROTOTYPES.find((p) => p.name === '委屈') || {}).gate) === JSON.stringify(['other']))
check('委屈：对方惹的（target=other）→ 门控不打折', gateMul('委屈', wrongedX) === 1)
check('委屈：不是对方惹的（target=me）→ 门控压到 0.3', near(gateMul('委屈', notWrongedX), 0.3, 1e-9))

const safeCalm = secondaryDistribution({ goal_cong: 0.8, control: 0.9, certainty: 0.9, expectation: 0.1, future: 0.4, norm: 0 }, { limit: 28 })
// 2026-11-20：不锁具体词名了——「安心 / 踏实 / 满足」现在不在库里。
// 改成验口径：安稳时排头的词必须落在「安」那一侧（s ≥ 0.5），且前二也都在那一侧。
const coordOf = (name) => SECONDARY_PROTOTYPES.find((x) => x.name === name) || {}
check('安稳时：排头的词落在「安」那一侧', Number(coordOf(safeCalm[0].name).s) >= 0.5, { top: safeCalm[0].name, s: coordOf(safeCalm[0].name).s })
check('安稳时：前二都在「安」那一侧', safeCalm.slice(0, 2).every((x) => Number(coordOf(x.name).s) >= 0.5), safeCalm.slice(0, 2).map((x) => ({ n: x.name, s: coordOf(x.name).s })))

check('二级：没有 NaN、p 在 0~1', safeCalm.every((x) => finite(x.p) && x.p >= 0 && x.p <= 1), safeCalm)
check('二级：默认最多五个', secondaryDistribution(baseFrame).length <= 5)
check('二级：词表每个原型都有坐标', SECONDARY_PROTOTYPES.every((p) => finite(p.s) && finite(p.n) && finite(p.d)))
check('二级：门控名没有拼错', SECONDARY_PROTOTYPES.every((p) => (p.gate || []).every((g) =>
  ['other', 'self', 'me', 'lowControl', 'highExpect', 'negNorm', 'posNorm', 'negFuture', 'posFuture'].includes(g))))

/* ---------- 一帧算到底 ---------- */

const out = infer({ goal_cong: -0.6, control: 0.3, certainty: 0.5, expectation: 0.7, future: -0.4, norm: -0.2, target: 'other', agency: 'self' })
check('infer：三轴都在 0~1', [out.s, out.n, out.d].every((x) => finite(x) && x >= 0 && x <= 1))
check('infer：primary 八个角、和 = 1', out.primary.length === 8 && near(sumP(out.primary, 'weight'), 1), sumP(out.primary, 'weight'))
check('infer：secondary 有词、p 和 ≤ 1', out.secondary.length > 0 && sumP(out.secondary, 'p') <= 1.0001, sumP(out.secondary, 'p'))
check('infer：label 是二级枚举词（不并列时）', out.tie === 0 && SECONDARY_PROTOTYPES.some((p) => p.name === out.label), { tie: out.tie, label: out.label })
check('infer：confidence 在 0~1', [out.confidence.primary, out.confidence.secondary].every((x) => x >= 0 && x <= 1), out.confidence)

/* ---------- 并列：不按数组顺序硬塞一个角 ---------- */

const neutral = infer({ goal_cong: 0, expectation: 0.2, future: 0 })
check('中立点：四角等距 → tie=1、label 仍是二级枚举词', neutral.tie === 1 && SECONDARY_PROTOTYPES.some((p) => p.name === neutral.label), { tie: neutral.tie, label: neutral.label, top: neutral.primary.slice(0, 4) })
check('中立点：一级置信度接近 0', neutral.confidence.primary < 0.01, neutral.confidence.primary)
check('中立点：分布本身仍是八等分左右，没被抹掉', neutral.primary.every((x) => x.weight > 0.05), neutral.primary.map((x) => x.weight))
check('并列门槛可调：tieGap=0 时仍给角名', infer({ goal_cong: 0, expectation: 0.2, future: 0 }, null, { tieGap: 0 }).label !== '说不清')
const strong = infer({ goal_cong: 0.8, expectation: 0.05, future: 0.8 })
check('明确角：tie=0，label 是二级枚举词', strong.tie === 0 && SECONDARY_PROTOTYPES.some((p) => p.name === strong.label), { tie: strong.tie, label: strong.label })
const nearTie = infer({ goal_cong: 0.1, expectation: 0.9, future: 0 })
check('差点并列：门槛内仍然给「说不清」', nearTie.tie === 1 || nearTie.confidence.primary >= 0.03, { tie: nearTie.tie, conf: nearTie.confidence.primary })

/* ---------- 旧事收口：静默 10 分钟，scene 最多 4 小时 ---------- */

const t0 = Date.parse('2026-11-16T20:00:00+08:00')
const min = 60000
check('收口：静默 2 分钟 → 还开着', shouldCloseFrame({ open: true, startedAt: new Date(t0 - 60 * min).toISOString(), lastAt: new Date(t0 - 2 * min).toISOString() }, t0) === false)
check('收口：静默 4 分钟 → 收', shouldCloseFrame({ open: true, startedAt: new Date(t0 - 60 * min).toISOString(), lastAt: new Date(t0 - 4 * min).toISOString() }, t0) === true)
check('收口：scene 撑到 5 小时 → 收', shouldCloseFrame({ open: true, startedAt: new Date(t0 - 300 * min).toISOString(), lastAt: new Date(t0 - 1 * min).toISOString() }, t0) === true)
check('收口：已经关了的帧不再关', shouldCloseFrame({ open: false }, t0) === true)
check('收口：没时间字段 → 收（不硬挂）', shouldCloseFrame({ open: true }, t0) === true)
check('收口：静默阈值可配', shouldCloseFrame({ open: true, lastAt: new Date(t0 - 20 * min).toISOString() }, t0, { silentMs: 30 * min }) === false)

/* ---------- 续帧：数值平均，被惊到那一下不丢 ---------- */

const f0 = { open: true, startedAt: '2026-11-16T20:00:00+08:00', lastAt: '2026-11-16T20:00:00+08:00', control: 0.2, expectation: 0.3, evidence: ['a'] }
const f1 = extendFrame(f0, { control: 0.6, expectation: 0.8, evidence: ['a', 'b'] }, t0)
check('续帧：不合并判断字段（control 保持原值）', near(f1.control, 0.2, 0.01), f1.control)
check('续帧：target 跟着新句走（不粘上一句）', extendFrame(f0, { target: 'other', agency: 'self' }, t0).target === 'other')
check('续帧：不合并判断字段（expectation 保持原值）', near(f1.expectation, 0.3, 0.01), f1.expectation)
check('续帧：evidence 追加去重', JSON.stringify(f1.evidence) === JSON.stringify(['a', 'b']), f1.evidence)
check('续帧：lastAt 更新', f1.lastAt === new Date(t0).toISOString(), f1.lastAt)
check('续帧：不修改原帧', f0.control === 0.2 && f0.expectation === 0.3)

/* ---------- 是谁造成的：只改「想要」这根，且只改没成的那一侧 ---------- */

const bw = 0.2
check('by：别人弄的、事情没成 → 往零拉（还留着劲）', near(byAdjustedD(-0.5, 'other', bw), -0.4, 1e-9), byAdjustedD(-0.5, 'other', bw))
check('by：我自己弄的、事情没成 → 更闷（没处使）', near(byAdjustedD(-0.5, 'me', bw), -0.6, 1e-9), byAdjustedD(-0.5, 'me', bw))
check('by：外面砸的，跟 me 一样没处使', near(byAdjustedD(-0.5, 'world', bw), -0.6, 1e-9), byAdjustedD(-0.5, 'world', bw))
check('by：别人害我 和 我搞砸，必须分开', byAdjustedD(-0.5, 'other', bw) > byAdjustedD(-0.5, 'me', bw))
check('by：事情成了，不管谁做的都不碰', byAdjustedD(0.5, 'me', bw) === 0.5 && byAdjustedD(0.5, 'other', bw) === 0.5, { me: byAdjustedD(0.5, 'me', bw), other: byAdjustedD(0.5, 'other', bw) })
check('by：没给 by（规则兜底）→ 原样', byAdjustedD(-0.5, '', bw) === -0.5)
check('by：开关关掉（w=0）→ 原样', byAdjustedD(-0.5, 'me', 0) === -0.5)
check('by：推到头也不越出 -1', byAdjustedD(-1, 'me', bw) >= -1)

/* ---------- 网格选词（2026-11-20）：先落片，再按判据落格 ---------- */

const piece1 = GRID_CELLS[0]                       // 烦 担忧 怨望 烦恼 尴尬 憎恶
const home = { s: piece1.s, n: piece1.n, d: piece1.d }

const pick = (judg, opt = {}) => gridDistribution(home, judg, { limit: 6, ...opt })
const names = (arr) => arr.map((x) => x.name)

check('网格：落片按片心距离，片心自己落回这片', nearestCell(home).index === 0)
check('网格：判据 by/to 映射成格子', slotOf({ by: '对方', to: '冲自己' }).join('·') === '对方·冲自己')
check('网格：判断层给了 to 就用它，不再看帧的 target', slotOf({ by: '对方', to: 'none' }, { target: 'me' }).join('·') === '对方·无')
check('网格：判断层明说「我冲对方」时不套旧兜底', slotOf({ by: 'me', to: 'other' }).join('·') === '我·冲对方')
check('网格：判据缺了就落 无·无', slotOf({}).join('·') === '无·无' && slotOf({ by: '对方' }).join('·') === '无·无')
check('网格：不认识的 by 也落 无·无', slotOf({ by: '外星人', to: '冲自己' }).join('·') === '无·无')

// 只在落进来的那一片里挑，不许跨片
const inPiece = pick({ by: '对方', to: '冲自己' })
check('网格：只在片内挑，不跨片', inPiece.every((x) => piece1.words.includes(x.name)), names(inPiece))
check('网格：返回条数不超过片内词数', inPiece.length <= piece1.words.length)

// 判据不同，挑出来的头名会换
const a = pick({ by: '对方', to: '冲自己' })
const b = pick({ by: '我', to: '冲对方' })
check('网格：换个判据，头名会换', a[0].name !== b[0].name || a[0].score !== b[0].score, { a: a[0].name, b: b[0].name })
check('网格：别人冲我 → 头名是这格里最典型的', a[0].typical === 1, a[0])
check('网格：我冲对方 → 头名也是这格里最典型的', b[0].typical === 1, b[0])

// 典型度永远不为 0，所以格子永远不会空
check('网格：典型度永远大于 0', piece1.words.every((w) => typicalityOf(w, '外面', '冲外面') > 0))
check('网格：随便给个格子也挑得出词', pick({ by: '外面', to: '冲外面' }).length > 0)

// 浓淡参与排序：强度低的点上，轻的词应当比重的词占优
const lowInt = intensityOf({ s: 0.5, n: 0.5, d: 0.5 })
check('网格：中点强度算作 0', lowInt === 0, lowInt)
const highInt = intensityOf({ s: 0, n: 1, d: 0 })
check('网格：极端位置强度接近 1', highInt > 0.9, highInt)
check('网格：浓淡权重可调（权重全给典型度时不报错）', pick({ by: '对方', to: '冲自己' }, { typicalWeight: 1 }).length > 0)

// 位置给不出时返回空，不抛
check('网格：位置是坏值 → 返回空数组', gridDistribution({}, { by: '我', to: '冲自己' }).length === 0)

// 开关：关着走旧路（全词表），开着走网格
const legacy = secondaryDistribution({}, { position: home, limit: 5 }, { by: '对方', to: '冲自己' })
const gridded = secondaryDistribution({}, { position: home, limit: 5, grid: true }, { by: '对方', to: '冲自己' })
check('开关：关着仍走全词表', legacy.length > 0)
check('开关：开着只在片内', gridded.every((x) => piece1.words.includes(x.name)), names(gridded))
check('占比：p 都大于 0', gridded.every((x) => x.p > 0))
check('占比：p 不超 1（整片占比，切前 5 个凑不满）', gridded.reduce((t, x) => t + x.p, 0) <= 1.001, gridded.map((x) => x.p))
check('占比：按 p 降序', gridded.every((x, i) => i === 0 || gridded[i - 1].p >= x.p))
check('旧路已经没了：不传 grid 也走网格', secondaryDistribution({}, { position: home, limit: 5 }, { by: '对方', to: '冲自己' }).every((x) => piece1.words.includes(x.name)))
check('旧路已经没了：geo=sphere 不再换距离', secondaryDistribution({}, { position: home, limit: 5, geo: 'sphere' }, { by: '对方', to: '冲自己' }).every((x) => piece1.words.includes(x.name)))

/* ---------- 汇总 ---------- */

console.log(`\n${pass} pass, ${fail} fail`)
if (fail) process.exitCode = 1
