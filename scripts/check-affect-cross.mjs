// 验收（2026-11-18）：底色跨会话——起点由慢情绪算、会话静默结算余温、开关能退
// 真库不碰：内存库 + 假 complete。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { getFlag, writeParam } from '../src/kernel.js'
import { appraiseTurnNow } from '../src/modules/affect_v4_shadow.js'

let passed = 0
function check(name, ok, detail) {
  if (!ok) { console.error('FAIL', name, detail === undefined ? '' : JSON.stringify(detail)); process.exit(1) }
  passed++
  console.log('ok', name)
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'affect-cross-'))
const db = openDb(path.join(dir, 'a.db'))
const aid = 'agt_cross'
const MIN = 60000
const T0 = Date.parse('2026-11-18T02:00:00.000Z')
const near = (a, b, eps = 1e-6) => Math.abs(Number(a) - Number(b)) <= eps
const setSlow = (v) => db.prepare(`INSERT INTO affect_v3(agent_id, baseline, slow, slow_at) VALUES(?,?,?,?)
  ON CONFLICT(agent_id) DO UPDATE SET slow=excluded.slow, slow_at=excluded.slow_at`).run(aid, 0, v, new Date(T0).toISOString())
const slowOf = () => Number(db.prepare('SELECT slow FROM affect_v3 WHERE agent_id=?').get(aid)?.slow)
const judge = (o) => async () => JSON.stringify({ meaning: '测试', why: '测试', from: o && o.severity === 'existence' ? '你不该在' : '这一句', severity: 'none', ...o })
let n = 0
async function turn(conv, at, j, text = '一句普通的话') {
  const id = 't' + (++n)
  await appraiseTurnNow(db, aid, { text, turnId: id, conversationId: conv, now: at, complete: judge(j) })
  const row = db.prepare("SELECT s,n,d,judgment_json FROM affect_v4_shadow WHERE agent_id=? AND turn_id=? AND source='model'").get(aid, id)
  return { s: Number(row.s), n: Number(row.n), d: Number(row.d), judge: JSON.parse(row.judgment_json || '{}') }
}
const stateOf = (conv) => JSON.parse(getFlag(db, `affect.v4.state|${conv}`) || 'null')

/* 1) 起点由慢情绪算 */
setSlow(0.6)
let r = await turn('cA', T0, { goal_delta: 0, expect_delta: 0, future_delta: 0 })
check('慢情绪 +0.6：新会话从 S0=0.83 / D0=0.77 起（不是 0.5）', near(r.s, 0.83, 0.001) && near(r.d, 0.77, 0.001), r)
check('N 不跟底色走，仍是 0.15', near(r.n, 0.15, 0.001), r.n)
check('状态里记着这一段的起点 b', near(stateOf('cA').b.s, 0.83, 0.001), stateOf('cA').b)
setSlow(-0.3)
r = await turn('cA2', T0, { goal_delta: 0, expect_delta: 0, future_delta: 0 })
check('慢情绪 -0.3：起点 S0=0.335', near(r.s, 0.335, 0.001), r.s)

/* 2) 会话静默 30 分钟 → 结算余温（正向） */
setSlow(0.4)
const baseS = 0.5 + 0.55 * 0.4 // 0.72
let e = null
for (let i = 0; i < 4; i++) e = await turn('cB', T0 + i * MIN, { goal_delta: 0.6, expect_delta: 0.3, future_delta: 0.5 })
const before = slowOf()
await turn('cB', T0 + 95 * MIN, { goal_delta: 0, expect_delta: 0, future_delta: 0 })
const afterPos = slowOf()
check('正向会话结束后，慢情绪被抬高', afterPos > before + 0.02, { before, afterPos })
check('单次封顶 ±0.10', afterPos - before <= 0.10 + 1e-9, { d: afterPos - before })
const last = JSON.parse(getFlag(db, 'affect.v4.cross.last') || '{}')
check('结算记了一笔（谁、从哪到哪、warm）', last.conv === 'cB' && near(last.from, before, 1e-9), last)

/* 3) 同一段里再隔 40 分钟不算新会话（状态已重置，但这次是一段新的） */
const s1 = slowOf()
await turn('cB', T0 + 70 * MIN, { goal_delta: 0, expect_delta: 0, future_delta: 0 })
check('同一会话接着来，不重复结算（这一段从新起点起）', near(slowOf(), s1, 1e-9), { s1, now: slowOf() })

/* 4) 负向会话 → 余温往下 */
setSlow(0.2)
for (let i = 0; i < 4; i++) await turn('cC', T0 + i * MIN, { goal_delta: -0.6, expect_delta: 0.4, future_delta: -0.5 })
const b2 = slowOf()
await turn('cC', T0 + 95 * MIN, { goal_delta: 0, expect_delta: 0, future_delta: 0 })
check('负向会话结束后，慢情绪被压低', slowOf() < b2 - 0.02, { before: b2, after: slowOf() })

/* 5) 极端事件那段会话，单次上限放到 0.15 */
setSlow(0.0)
await turn('cD', T0, { goal_delta: -1, expect_delta: 0.9, future_delta: -1, severity: 'existence' })
const b3 = slowOf()
await turn('cD', T0 + 95 * MIN, { goal_delta: 0, expect_delta: 0, future_delta: 0 })
const dShock = slowOf() - b3
check('存在级会话的余温上限更宽（≤0.15，且比普通上限 0.1 大）', dShock >= -0.15 - 1e-9 && dShock <= -0.10 - 1e-9, dShock)

/* 6) 单日累计上限 0.20 */
const dayRaw = getFlag(db, 'affect.v4.cross.day')
const daySum = dayRaw ? Number(JSON.parse(dayRaw).sum) : 0
check('单日累计不超过 ±0.20', Math.abs(daySum) <= 0.20 + 1e-9, daySum)

/* 6b) 存在级会话里后面又聊了几句，收尾仍按「存在级」上限算 */
const T2 = T0 + 48 * 60000 * 60
setSlow(0)
await turn('cF', T2, { goal_delta: -1, expect_delta: 0.9, future_delta: -1, severity: 'existence' })
await turn('cF', T2 + MIN, { goal_delta: 0, expect_delta: 0, future_delta: 0 })
await turn('cF', T2 + 2 * MIN, { goal_delta: 0, expect_delta: 0, future_delta: 0 })
const b4 = slowOf()
await turn('cF', T2 + 95 * MIN, { goal_delta: 0, expect_delta: 0, future_delta: 0 })
const dShock2 = slowOf() - b4
check('通天那段后面又聊了几句，收尾仍按 ±0.15 算', dShock2 >= -0.15 - 1e-9 && dShock2 <= -0.10 - 1e-9, dShock2)

/* 6c) 旧会话超过 24 小时不再补渗余温 */
setSlow(0.1)
const T3 = T2 + 48 * 60000 * 60
await turn('cG', T3, { goal_delta: 0.6, expect_delta: 0.3, future_delta: 0.5 })
const staleBefore = slowOf()
await turn('cG', T3 + 25 * 60 * MIN, { goal_delta: 0, expect_delta: 0, future_delta: 0 })
check('静默超过 24 小时：不补渗余温', near(slowOf(), staleBefore, 1e-9), { before: staleBefore, now: slowOf() })

/* 6d) 两个会话同时开：B 结束时染了慢情绪，A 的起点不被拽走 */
setSlow(0.2)
const aBase = 0.5 + 0.55 * 0.2
await turn('cH', T3, { goal_delta: 0, expect_delta: 0, future_delta: 0 })
for (let i = 0; i < 3; i++) await turn('cI', T3 + i * MIN, { goal_delta: 0.6, expect_delta: 0.3, future_delta: 0.5 })
await turn('cH', T3 + 5 * MIN, { goal_delta: 0, expect_delta: 0, future_delta: 0 })
check('A 这一段继续用自己记下的起点 b（不被 B 的结算拽走）', near(stateOf('cH').b.s, aBase, 1e-9), stateOf('cH').b)

/* 7) 静默 40 分钟还不算翻篇（默认阈值 45 分钟） */
const T4 = T2 + 96 * 60000 * 60
setSlow(0.1)
await turn('cJ', T4, { goal_delta: 0.5, expect_delta: 0.2, future_delta: 0.4 })
const early = slowOf()
await turn('cJ', T4 + 40 * MIN, { goal_delta: 0, expect_delta: 0, future_delta: 0 })
check('静默 40 分钟不结算（阈值 90）', near(slowOf(), early, 1e-9), { early, now: slowOf() })

/* 8) 中途有高峰、收尾回平的那段，也要留痕 */
setSlow(0)
await turn('cK', T4, { goal_delta: 0.6, expect_delta: 0.3, future_delta: 0.5 })
await turn('cK', T4 + MIN, { goal_delta: 0.6, expect_delta: 0.3, future_delta: 0.5 })
await turn('cK', T4 + 2 * MIN, { goal_delta: -0.6, expect_delta: 0.4, future_delta: -0.5 })
await turn('cK', T4 + 3 * MIN, { goal_delta: -0.6, expect_delta: 0.4, future_delta: -0.5 })
const peakState = stateOf('cK')
check('状态里记着这段的峰值（离起点最远的那一下）', !!peakState.peak && Math.abs(peakState.peak.s) > 0.2, peakState.peak)
const beforePeak = slowOf()
await turn('cK', T4 + 95 * MIN, { goal_delta: 0, expect_delta: 0, future_delta: 0 })
// 2026-11-21：peak 取的是「离起点最远的那一下」，可以是负的（这段最后两句就是往下推的）。
// 断言只验「收尾确实留了痕迹」，不假定方向——原来锁死「正余温」，形状一改就误报。
check('中途被抬得高、收尾回平：收尾仍留下余温痕迹', Math.abs(slowOf() - beforePeak) > 0.02, { before: beforePeak, after: slowOf() })
/* 9) 短会话打折 + 隔夜折减 */
const T5 = T4 + 48 * 60000 * 60
setSlow(0)
await turn('cL', T5, { goal_delta: 0.6, expect_delta: 0.3, future_delta: 0.5 })
const b6 = slowOf()
await turn('cL', T5 + 95 * MIN, { goal_delta: 0, expect_delta: 0, future_delta: 0 })
const dShort = slowOf() - b6
check('单轮寒暄的余温要打折（<0.04，不是吃满 0.10）', dShort > 0.01 && dShort < 0.04, dShort)

setSlow(0)
for (let i = 0; i < 4; i++) await turn('cM', T5, { goal_delta: 0.6, expect_delta: 0.3, future_delta: 0.5 })
const b7 = slowOf()
await turn('cM', T5 + 95 * MIN, { goal_delta: 0, expect_delta: 0, future_delta: 0 })
const dLong = slowOf() - b7
check('4 轮有内容的会话不打折（余温远大于单轮寒暄）', dLong > dShort * 2, { short: dShort, long: dLong })

setSlow(0)
for (let i = 0; i < 4; i++) await turn('cN', T5, { goal_delta: 0.6, expect_delta: 0.3, future_delta: 0.5 })
const b8 = slowOf()
await turn('cN', T5 + 12 * 60 * MIN, { goal_delta: 0, expect_delta: 0, future_delta: 0 })
check('隔 12 小时才来结算：余温按半衰期折掉大半（<0.03）', slowOf() - b8 > 0 && slowOf() - b8 < 0.03, slowOf() - b8)

/* 10) 关开关：起点回 0.5、不结算 */
writeParam(db, aid, 'affect.v4.cross', 'off')
setSlow(0.6)
r = await turn('cE', T0, { goal_delta: 0, expect_delta: 0, future_delta: 0 })
check('cross=off：起点回 0.5 / 0.15 / 0.5', near(r.s, 0.5, 0.001) && near(r.d, 0.5, 0.001), r)
for (let i = 0; i < 3; i++) await turn('cE', T0 + i * MIN, { goal_delta: 0.5, expect_delta: 0.2, future_delta: 0.4 })
const offSlow = slowOf()
await turn('cE', T0 + 95 * MIN, { goal_delta: 0, expect_delta: 0, future_delta: 0 })
check('cross=off：不写余温（慢情绪不动）', near(slowOf(), offSlow, 1e-9), { offSlow, now: slowOf() })

db.close()
try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
console.log(`\n${passed} 项全过`)




