// 验收（2026-11-18）：判断层出增量 + 维持 + 回落
// 真库不碰：全部用假时钟、内存库。
// 1) 连续两轮正向：S 逐步升，不一步到顶
// 2) 大负面：半小时内维持（激素还在效价期）
// 3) 半小时后 2~3 小时内回落到平静附近（假时钟）
// 4) 边界：夹在 0~1，k 可配
// 5) 开关：affect.v4.dyn=off 回旧逻辑（位置直落），delta 时两轮累积 + 状态落 flag
// 6) 会话隔离：两个会话各一份状态
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { getFlag, setFlag, writeParam } from '../src/kernel.js'
import { advanceState, deltasOf, applyShock, CALM, infer } from '../src/algo/affect_v4.js'
import { appraiseTurnNow, JUDGE_SYS } from '../src/modules/affect_v4_shadow.js'

let passed = 0
function check(name, ok, detail) {
  if (!ok) { console.error('FAIL', name, detail === undefined ? '' : JSON.stringify(detail)); process.exit(1) }
  passed++
  console.log('ok', name)
}
const HOUR = 3600000
const T0 = Date.parse('2026-11-18T02:00:00.000Z')
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps

/* ── 1) 连续两轮正向：逐步升，不一步到顶 ── */
const s1 = advanceState(null, { s: 0.6 }, { at: T0 })
// 2026-11-21：ks 默认从 0.35 收到 0.1（《设计-三递质各自算法》），断言只验「只推一小步」。
check('第一轮：从平静起，只推一小步（安是慢轴，不一步到位）', s1.s > 0.5 && s1.s < 0.65, s1)
const s2 = advanceState(s1, { s: 0.6 }, { at: T0 + 60000 })
check('第二轮：继续升，不是一步到顶', s2.s > s1.s && s2.s < 0.99, { s1: s1.s, s2: s2.s })
const s3 = advanceState(null, { s: 0.6 }, { at: T0, k: 0.1 })
check('k 可配：k=0.1 时只推 0.06', near(s3.s, 0.56), s3)

/* ── 2) 大负面：半小时内维持 ── */
const bad = advanceState(null, { s: -0.8 }, { at: T0 })
// 2026-11-21：ks 收到 0.1 后，一句大负面推的是 0.08 不是 0.28。断言只验「往下走、但不贴底」。
check('负面：S 往下走，但不一步贴底', bad.s < 0.5 && bad.s > 0.25, bad)
// 2026-11-19：默认回落改成连续衰减，下面这段测的是**旧规则（step）**的行为，
// 所以显式传 decay:'step'。新规则的行为在 2b 那段另测。
const held = advanceState(bad, null, { at: T0 + 0.4 * HOUR, decay: 'step' })
check('半小时内不回落（旧规则 step 的维持窗）', near(held.s, bad.s), { bad: bad.s, held: held.s })
const expHeld = advanceState(bad, null, { at: T0 + 0.4 * HOUR })
check('新规则（连续衰减）：半小时内已经在回落，不再死等', expHeld.s > bad.s + 0.005, { bad: bad.s, expHeld: expHeld.s })

/* ── 3) 半小时后回落，2~3 小时回一半以上，6 小时接近平静 ── */
const r3 = advanceState(bad, null, { at: T0 + 3 * HOUR, decay: 'step' })
check('3 小时：回落过半（旧规则 step）', Math.abs(r3.s - CALM.s) < Math.abs(bad.s - CALM.s) * 0.5, { bad: bad.s, at3h: r3.s })
const r6 = advanceState(bad, null, { at: T0 + 6 * HOUR, decay: 'step' })
check('6 小时：接近平静（缺口 < 20%）', Math.abs(r6.s - CALM.s) < Math.abs(bad.s - CALM.s) * 0.2, r6)
check('回落是单调的：3h > 6h 的偏离', Math.abs(r3.s - CALM.s) > Math.abs(r6.s - CALM.s), { at3h: r3.s, at6h: r6.s })
check('没新事件：只往平静回落，不加增量', Math.abs(r6.s - CALM.s) < Math.abs(held.s - CALM.s) && Math.abs(r6.s - CALM.s) < 0.05, r6)

/* ── 3b) 三条轴各有各的速度（2026-11-18 主人定）── */
const spike = { s: 0.9, n: 0.9, d: 0.9, at: new Date(T0).toISOString() }
const afterHalf = advanceState(spike, null, { at: T0 + 0.75 * HOUR, decay: 'step' })
const afterTwo = advanceState(spike, null, { at: T0 + 2 * HOUR, decay: 'step' })
// 新规则下三条轴也各有各的速度：觉最快、安最慢
const expHalf = advanceState(spike, null, { at: T0 + 0.75 * HOUR })
check('新规则：0.75h 后觉比安落得多', expHalf.n < expHalf.s - 0.2, expHalf)
check('N 比 S 回得快：0.75h 时 N 已掉一半以上', afterHalf.n < 0.55 && afterHalf.s > 0.8, afterHalf)
check('D 比 S 慢：2h 时 D 的偏离大于 S', Math.abs(afterTwo.d - CALM.d) > Math.abs(afterTwo.s - CALM.s) * 1.2, afterTwo)
check('N 无维持窗：0.75h 就回落（不是等 0.5h 才开始）', afterHalf.n < CALM.n + (0.9 - CALM.n) * 0.6, afterHalf.n)
const custom = advanceState(spike, null, { at: T0 + 0.5 * HOUR, hold: 0, tau: { n: 0.1 } })
check('按轴参数优先于全局：N 用 6 分钟常数', custom.n < 0.2, custom.n)
check('全局 hold/tau 兜底：只给一个数时三轴共用', near(advanceState(spike, null, { at: T0 + 3 * HOUR, holdHours: 0.5, tauHours: 1 }).s, advanceState(spike, null, { at: T0 + 3 * HOUR, hold: 0.5, tau: 1 }).s), '')

/* ── 4) 边界：夹在 0~1；N 走包络不硬顶 ── */
const top = advanceState({ s: 0.95, n: 0.95, d: 0.95, at: T0 }, { s: 1, n: 1, d: 1 }, { at: T0 + 1000 })
// 2026-11-21：ks=0.1 且维持窗去掉之后，S 不再一步顶到 1，但必须仍然「往顶上走、不越界」。
check('上限不越界（S/D 往上顶但不超 1；N 遇到更大意外到 1）', top.s > 0.9 && top.s <= 1 && top.d === 1 && top.n === 1, top)
const low = advanceState({ s: 0.05, n: 0.05, d: 0.05, at: T0 }, { s: -1, n: -1, d: -1 }, { at: T0 + 1000 })
// 2026-11-19 改：N 的负增量现在也会往下压（「正如我所想」= 觉低），
// 以前那条「不往下压」的旧行为已经废了。
// 2026-11-21：S 的绝对地板从 0 提到 0.12——真链路里「算了不用你看了」一句就能把安压到 0.03，
// 之后所有回暖都在低位打转。人被连否到底时底下还留着「我还在」那点底，不会归零。
// 2026-11-21 再改：地板不负责把已经在 0.12 以下的位置往上抬（震到 0.02 之后下一句负面
// 反而回升，方向是反的）。从 0.05 起往下的，就留在 0.05；从 0.3 起压下来的，停在地板 0.12。
check('下限不越界（0.12 以下不跳回地板，只慢慢往平静渗；N 托在静息水平，D 掉到 0）', low.s < 0.08 && low.d === 0 && low.n >= 0.15 && low.n < 0.2, low)
const lowFromMid = (() => {
  let st = { s: 0.3, n: 0.2, d: 0.5, at: T0 }
  for (let i = 1; i <= 30; i++) st = advanceState(st, { s: -1 }, { at: T0 + i * 60000 })
  return st
})()
check('地板 0.12：一直被压到底时停在 0.12', near(lowFromMid.s, 0.12), lowFromMid.s)
const cold = advanceState(null, null, { at: T0 })
check('冷启动 = 平静基线', near(cold.s, CALM.s) && near(cold.n, CALM.n) && near(cold.d, CALM.d), cold)

/* ── 4b) 三条轴的增量是三套算法（2026-11-18 主人定）── */
const sFar = advanceState({ s: 0.8, n: 0.2, d: 0.5, at: T0 }, { s: 0.6 }, { at: T0 + 1000 })
const sNear = advanceState(null, { s: 0.6 }, { at: T0 })
check('S 越靠边推得越少（0.8 起点那一步 < 0.5 起点那一步）', (sFar.s - 0.8) < (sNear.s - 0.5), { far: sFar.s, near: sNear.s })
const sBack = advanceState({ s: 0.9, n: 0.2, d: 0.5, at: T0 }, { s: -0.6 }, { at: T0 + 1000 })
// 2026-11-21：ks=0.1 之后不再锁 0.69。本意不变——往平静走的那一步不打「靠边」折扣，
// 比往外推那一步大（0.9 起点 vs 0.8 起点，用同一条 sFar 对账）。
check('S 往平静拉回不打折（回中的步子 ≥ 向外推的步子）', sBack.s < 0.9 && (0.9 - sBack.s) >= (sFar.s - 0.8) * 0.99, { back: sBack.s, far: sFar.s })
const n1 = advanceState(null, { n: 0.6 }, { at: T0 })
const n2 = advanceState(n1, { n: 0.6 }, { at: T0 + 1000 })
check('N 是尖峰包络：连来两次同等意外不叠加', near(n1.n, 0.66, 0.01) && near(n2.n, 0.66, 0.01), { n1: n1.n, n2: n2.n })
const nBig = advanceState(n1, { n: 1 }, { at: T0 + 1000 })
check('N 包络：更大的意外能顶上去', nBig.n > n1.n, { before: n1.n, after: nBig.n })
const nCalm = advanceState({ s: 0.5, n: 0.6, d: 0.5, at: T0 }, { n: -0.8 }, { at: T0 + 1000 })
// 2026-11-21 改：负向力度 0.6→0.2 且托在 base.n（警觉不低于静息水平）。
// 本意不变：从 0.6 起，「正如我所想」要真的把它压下来，不能当没发生。
check('N 遇到「正如我所想」（负的外）会往下压', nCalm.n < 0.6 - 0.05 && nCalm.n >= 0.15, nCalm.n)
const dUp = advanceState(null, { d: 0.6 }, { at: T0 })
const dDown = advanceState({ s: 0.5, n: 0.2, d: 0.5, at: T0 }, { d: -0.6 }, { at: T0 + 1000 })
check('D 慢涨快跌（+0.6 → +0.15；-0.6 → -0.27）', near(dUp.d, 0.65) && near(dDown.d, 0.23), { up: dUp.d, down: dDown.d })

/* ── 4c) 饱和疲劳：只有连续贴顶/贴底一段时间才触发，平常的细微情绪不碰 ── */
// 这一组测的是**旧规则（step）**的疲劳窗 / 0.78 带子，所以默认走 step。
// 新规则（连续衰减）没有带子，也就没有「停在哪」这回事，另段测。
function runNeutral(start, turns, opt = { decay: 'step' }) {
  let st = { ...start, at: new Date(T0).toISOString() }
  for (let i = 1; i <= turns; i++) st = advanceState(st, { s: 0, n: 0, d: 0 }, { at: T0 + i * 60000, ...opt })
  return st
}
const preFatigue = runNeutral({ s: 0.92, n: 0.2, d: 0.5 }, 10)
check('贴顶 10 分钟还不回落（疲劳窗 45 分钟）', near(preFatigue.s, 0.92, 0.01), preFatigue.s)
const tired = runNeutral({ s: 0.92, n: 0.2, d: 0.5 }, 100)
check('贴顶满 45 分钟后开始回落（100 分钟时已下来）', tired.s < 0.86, tired.s)
check('回落到 0.78 上下就停，不会一路漏光', tired.s > 0.72 && tired.s < 0.82, tired.s)
const subtle = runNeutral({ s: 0.7, n: 0.2, d: 0.5 }, 30)
check('平常的细微情绪不触发疲劳：0.7 挂 30 分钟不动', near(subtle.s, 0.7, 0.001), subtle.s)
const bottom = runNeutral({ s: 0.05, n: 0.2, d: 0.5 }, 100)
check('贴底也会回升（不会一路贴底）', bottom.s > 0.15, bottom.s)
const jumped = advanceState({ s: 0.92, n: 0.2, d: 0.5, at: T0 }, null, { at: T0 + 50 * 60000, decay: 'step' })
check('老状态没有 hot 时，按「上次那轮就已经在顶区」算', jumped.s < 0.92, jumped.s)
check('状态里记着「什么时候进的顶区」', !!jumped.hot && Number.isFinite(Date.parse(jumped.hot.s)), jumped.hot)
// 回归：hot 写进状态后是 null（不是时间戳），不能被当成 1970 年、一上来就触发疲劳
const hotNullState = { s: 0.95, n: 0.2, d: 0.5, at: new Date(T0).toISOString(), hot: { s: null, n: null, d: null } }
const hotNull = advanceState(hotNullState, null, { at: T0 + 10 * 60000, decay: 'step' })
check('hot=null 不触发疲劳（顶区 10 分钟还在原地 0.95）', near(hotNull.s, 0.95, 0.001), hotNull.s)

/* ── 4d) 极端事件：门槛卡两道，触发一步通天 ── */
const shockBad = applyShock({ s: 0.7, n: 0.2, d: 0.6 }, { goal_delta: -1, severity: 'existence' })
check('存在被否：一步砸到近乎见底（S 0.02 / D 0.05 / N≥0.9）', !!shockBad && near(shockBad.s, 0.02) && near(shockBad.d, 0.05) && shockBad.n >= 0.9, shockBad)
const shockGood = applyShock({ s: 0.4, n: 0.2, d: 0.35 }, { goal_delta: 1, severity: 'existence' })
check('存在被确认：一步到近乎满格（S 0.98 / D 0.95）', !!shockGood && near(shockGood.s, 0.98) && near(shockGood.d, 0.95), shockGood)
check('门槛一：不到 0.9 不触发（-0.85 只走增量）', applyShock({ s: 0.5, n: 0.2, d: 0.5 }, { goal_delta: -0.85, severity: 'existence' }) === null)
check('门槛二：不是 existence 不触发（strong 只走增量）', applyShock({ s: 0.5, n: 0.2, d: 0.5 }, { goal_delta: -1, severity: 'strong' }) === null)
check('没标 severity 的老判断不触发', applyShock({ s: 0.5, n: 0.2, d: 0.5 }, { goal_delta: -1 }) === null)
check('判断提示词要 severity（none/strong/existence）', /severity/.test(JUDGE_SYS) && /existence/.test(JUDGE_SYS) && /strong/.test(JUDGE_SYS))

/* ── 5) 判断字段：新字段优先，老字段兼容 ── */
const nd = deltasOf({ goal_delta: -0.6, expect_delta: 0.4, future_delta: -0.2 })
check('增量字段：原样读出', nd.s === -0.6 && nd.n === 0.4 && nd.d === -0.2, nd)
const legacy = deltasOf({ goal_cong: 0.5, expectation: 0.3, future: -0.4 })
check('老字段兼容：当成增量读', legacy.s === 0.5 && legacy.n === 0.3 && legacy.d === -0.4, legacy)
check('判断提示词改问增量', /goal_delta/.test(JUDGE_SYS) && /expect_delta/.test(JUDGE_SYS) && /future_delta/.test(JUDGE_SYS) && /增量|变化量/.test(JUDGE_SYS))

/* ── 6) 接线：delta 开（默认）两轮累积、状态落 flag；off 回旧逻辑 ── */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'affect-delta-'))
const db = openDb(path.join(dir, 'a.db'))
const aid = 'agt_delta'
const reply = JSON.stringify({ fact: '被夸', meaning: '被夸', by: 'other', to: 'me', goal_delta: 0.6, expect_delta: 0.3, future_delta: 0.4, severity: 'none', why: '被夸', from: '这一句' })
const complete = async () => reply

await appraiseTurnNow(db, aid, { text: '你今天真厉害', turnId: 'd1', conversationId: 'cA', now: T0, complete })
const row1 = db.prepare("SELECT s,n,d,judgment_json FROM affect_v4_shadow WHERE agent_id=? AND turn_id='d1' AND source='model'").get(aid)
console.error('DBG row1.s=', row1.s, 'dyn=', JSON.stringify(JSON.parse(row1.judgment_json || '{}').dyn))
// 2026-11-21：安的斜率按《设计-三递质各自算法》收到 ks=0.1（原来 0.35）。
// 断言只验本意：从平静起「只推一小步」——往好的方向走，但一步不至于把它推到边上。
const sAfter1 = Number(row1.s)
// 2026-11-21：ks 0.55（模型实测给的增量是 0.3~0.6，0.35 拉不开距离）。断言只验「往上走、但不一步到顶」。
check('第一轮：从平静起往上推，但不一步到顶', sAfter1 > 0.5 && sAfter1 < 0.95, row1.s)
const j1 = JSON.parse(row1.judgment_json || '{}')
check('影子行记了原始增量（冷启动 prev=null）', j1.dyn && near(j1.dyn.delta.s, 0.6) && j1.dyn.prev === null && near(j1.dyn.state.s, sAfter1), j1.dyn)
const flag1 = JSON.parse(getFlag(db, 'affect.v4.state|cA') || '{}')
check('状态落 affect.v4.state|cA', near(flag1.s, sAfter1) && !!flag1.at, flag1)

await appraiseTurnNow(db, aid, { text: '你今天真厉害', turnId: 'd2', conversationId: 'cA', now: T0 + 60000, complete })
const row2 = db.prepare("SELECT s,judgment_json FROM affect_v4_shadow WHERE agent_id=? AND turn_id='d2' AND source='model'").get(aid)
// 2026-11-21：不锁具体值。本意是「靠边打折」：第二轮涨的步子必须比第一轮小，不能线性叠加。
const sAfter2 = Number(row2.s)
const step1 = Number(row1.s) - 0.5
check('第二轮：接着累积，但靠边那一步比第一步小（不线性叠加）',
  sAfter2 > Number(row1.s) && sAfter2 <= 1 && (sAfter2 - Number(row1.s)) < step1,
  `第一轮 ${row1.s}（+${step1.toFixed(3)}）→ 第二轮 ${sAfter2}（+${(sAfter2 - Number(row1.s)).toFixed(3)}）`)

const j2 = JSON.parse(row2.judgment_json || '{}')
check('重复打折：同方向第二句的 d 被折到 0.75 倍', near(j2.dyn.damp, 0.75), j2.dyn)
check('重复打折：状态里记着连着第几次（dStreak=2）', JSON.parse(getFlag(db, 'affect.v4.state|cA') || '{}').dStreak === 2, getFlag(db, 'affect.v4.state|cA'))

await appraiseTurnNow(db, aid, { text: '你在吗', turnId: 'd3', conversationId: 'cB', now: T0 + 120000, complete: async () => JSON.stringify({ fact: '闲聊', meaning: '闲聊', by: 'other', to: 'none', goal_delta: 0, expect_delta: 0, future_delta: 0, severity: 'none', why: '闲聊', from: '这一句' }) })
const flagB = JSON.parse(getFlag(db, 'affect.v4.state|cB') || '{}')
const flagA = JSON.parse(getFlag(db, 'affect.v4.state|cA') || '{}')
check('会话隔离：B 有自己的状态，不动 A', !!flagB.at && near(flagA.s, sAfter2, 0.0001), { a: flagA.s, b: flagB.s })

// 极端事件接线：existence + Δ=-1 → 一步到底；普通 Δ=-0.9 没标 existence → 只走增量
const judgeShock = JSON.stringify({ fact: '被说不该在', meaning: '被说不该在', by: 'other', to: 'me', goal_delta: -1, expect_delta: 0.9, future_delta: -1, severity: 'existence', why: '存在被否', from: '你不该在' })
await appraiseTurnNow(db, aid, { text: '你不该在', turnId: 'd5', conversationId: 'cC', now: T0 + 240000, complete: async () => judgeShock })
const row5 = db.prepare("SELECT s,d,n,judgment_json FROM affect_v4_shadow WHERE agent_id=? AND turn_id='d5' AND source='model'").get(aid)
check('接线：极端事件一步通天落表（S 0.02 / D 0.05 / N 0.9）', near(Number(row5.s), 0.02) && near(Number(row5.d), 0.05) && Number(row5.n) >= 0.9, { s: row5.s, n: row5.n, d: row5.d })
check('接线：影子行标了 shock', JSON.parse(row5.judgment_json || '{}').dyn?.shock === true, row5.judgment_json)
// 2026-11-21：shock 以前一旦写进状态就永不过期，之后每轮 hold=1h，两句间隔不到一小时就永远不回落。
// 现在记 shockAt，过了 shockHold 小时就交回正常回落。
const neutralJudge = JSON.stringify({ fact: '过了一会儿', meaning: '没新事', by: 'other', to: 'none', goal_delta: 0, expect_delta: -0.3, future_delta: 0, severity: 'none', why: '只是过去了一段时间', from: '时钟' })
await appraiseTurnNow(db, aid, { text: '还在忙', turnId: 'd5h', conversationId: 'cC', now: T0 + 240000 + 30 * 60000, complete: async () => neutralJudge })
const rowHeld = db.prepare("SELECT s FROM affect_v4_shadow WHERE agent_id=? AND turn_id='d5h' AND source='model'").get(aid)
check('shock 维持窗内：半小时后还在谷底（S≈0.02）', near(Number(rowHeld.s), 0.02, 0.005), rowHeld.s)
await appraiseTurnNow(db, aid, { text: '还在忙', turnId: 'd5x', conversationId: 'cC', now: T0 + 240000 + 61 * 60000, complete: async () => neutralJudge })
const rowExpired = db.prepare("SELECT s FROM affect_v4_shadow WHERE agent_id=? AND turn_id='d5x' AND source='model'").get(aid)
check('shock 过期：一小时后交回回落（S 离开 0.02，但还没回平静）', Number(rowExpired.s) > 0.03 && Number(rowExpired.s) < 0.45, rowExpired.s)
check('shock 过期：状态里的 shock 被清掉', JSON.parse(getFlag(db, 'affect.v4.state|cC') || '{}').shock === false, getFlag(db, 'affect.v4.state|cC'))
const judgeHeavy = JSON.stringify({ fact: '被狠狠批了', meaning: '被狠狠批了', by: 'other', to: 'me', goal_delta: -0.9, expect_delta: 0.4, future_delta: -0.6, severity: 'strong', why: '被批', from: '这一句' })
await appraiseTurnNow(db, aid, { text: '你这做的什么呀', turnId: 'd6', conversationId: 'cD', now: T0 + 300000, complete: async () => judgeHeavy })
const row6 = db.prepare("SELECT s FROM affect_v4_shadow WHERE agent_id=? AND turn_id='d6' AND source='model'").get(aid)
// 2026-11-21：不锁 0.185（那是 ks=0.35 时代的数）。本意：没标 existence 就只走增量，不下到 0.02。
const s6 = Number(row6.s)
check('接线：没到门槛只走增量（往下推，但不是一步到底）', s6 > 0.02 && s6 < 0.3, row6.s)

writeParam(db, aid, 'affect.v4.dyn', 'off')
await appraiseTurnNow(db, aid, { text: '你今天真厉害', turnId: 'd4', conversationId: 'cA', now: T0 + 180000, complete })
const row4 = db.prepare("SELECT s, judgment_json FROM affect_v4_shadow WHERE agent_id=? AND turn_id='d4' AND source='model'").get(aid)
check('开关 off：回旧逻辑（位置直落 0.5+0.5×0.6=0.8）', near(Number(row4.s), 0.8), row4.s)
const flagA2 = JSON.parse(getFlag(db, 'affect.v4.state|cA') || '{}')
check('开关 off：状态不再被改写', near(flagA2.s, sAfter2, 0.0001), flagA2)

/* 位置帧也能走 infer：位置给进去，词跟着位置走 */
const out = infer({ target: 'me', agency: 'other' }, { goal_delta: 0.6 }, { position: { s: 0.9, n: 0.2, d: 0.7 } })
check('累积位置帧能直接出词（不再回头改判断语义）', near(out.s, 0.9) && typeof out.label === 'string', { s: out.s, label: out.label })

db.close()
try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 忽略 */ }
console.log(`\n${passed} 项全过`)


