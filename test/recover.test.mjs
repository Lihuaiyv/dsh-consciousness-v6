/**
 * 恢复速度分正负：低落退得慢（1.4× 时长），被抬高退得快（0.8× 时长）。
 *
 * 同一只实例、同一份状态、同一个起点跑两遍，只改「差在水位哪一边」。
 * 为了把别的力摘干净：这段测试把「累积负荷」和「随机游走」都关掉
 * （它们本身就带方向性，会把两支曲线搅得没法比）。
 *
 * 运行：node test/recover.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, now } from '../src/db.js'
import { attachDb } from '../src/algo/index.js'
import { setParam, getParam } from '../src/kernel.js'
import { seedAffect, applyEmotionV3 } from '../src/modules/affect.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) } else {
    fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400))
  }
}
const H = 3600000

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-rec-'))
const db = openDb(path.join(dir, 'app.db'))
attachDb(db)
const aid = 'agt_rec'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid, '恢复', 'daily', 'active', now())
seedAffect(db, aid)

/* 摘干净：不游走、不攒负荷 */
setParam(db, aid, 'affect.walk.sd', { value: 0 })
setParam(db, aid, 'affect.baseline.load.gain', { value: 0 })

const T0 = Date.parse('2026-11-01T08:00:00.000Z')
const COLS = ['baseline', 'slow', 'fast', 'total', 'slow_at', 'fast_at', 'base_off', 'base_off_at', 'walk', 'walk_at', 'circ_phase', 'circ_phase_at']

applyEmotionV3(db, aid, { pleasure: 0, label: 'calm', at: T0 })
const snapshot = db.prepare('SELECT * FROM affect_v3 WHERE agent_id=?').get(aid)
snapshot.base_off = 0
snapshot.walk = 0
const restore = () => {
  db.prepare('UPDATE affect_v3 SET ' + COLS.map((c) => c + '=?').join(', ') + ' WHERE agent_id=?')
    .run(...COLS.map((c) => snapshot[c]), aid)
}
const b0 = Number(snapshot.baseline)

/** 从水位 ±d 出发空转 hours 小时，返回「还剩原来距离的几成」 */
function devRun(sign, d = 0.3, hours = 1) {
  restore()
  const s0 = Math.max(-1, Math.min(1, b0 + sign * d))
  db.prepare('UPDATE affect_v3 SET slow=?, fast=?, total=?, slow_at=?, fast_at=? WHERE agent_id=?')
    .run(s0, 0, s0, new Date(T0).toISOString(), new Date(T0).toISOString(), aid)
  const r = applyEmotionV3(db, aid, { pleasure: 0, label: 'calm', at: T0 + hours * H, fresh: false })
  return { s0, s1: r.slow, b1: r.baseline, frac: Math.abs(r.slow - r.baseline) / Math.abs(s0 - b0) }
}

/* 先量一条「好坏一样快」的基线：同一套度量本身带一点方向偏差（目标不是水位本身），
   后面拿比值去比，才只反映出 neg/pos 这组参数的作用。 */
setParam(db, aid, 'affect.recover.neg', { value: 1 })
setParam(db, aid, 'affect.recover.pos', { value: 1 })
const up0 = devRun(+1)
const down0 = devRun(-1)
const r0 = Math.log(Math.max(1e-6, down0.frac)) / Math.log(Math.max(1e-6, up0.frac))
check('倍数=1 时，下行/上行 的剩余比例接近 1（基线）', Math.abs(r0 - 1) < 0.45, { r0: +r0.toFixed(3) })

/* 打开 1.4 / 0.8 */
setParam(db, aid, 'affect.recover.neg', { value: 1.4 })
setParam(db, aid, 'affect.recover.pos', { value: 0.8 })
const up = devRun(+1)
const down = devRun(-1)
check('被抬高之后一小时：退掉一部分', up.frac > 0 && up.frac < 0.9, { frac: +up.frac.toFixed(3) })
check('低落之后一小时：剩得更多（退得慢）',
  down.frac > up.frac + 0.02, { up: +up.frac.toFixed(3), down: +down.frac.toFixed(3) })
const r1 = Math.log(Math.max(1e-6, down.frac)) / Math.log(Math.max(1e-6, up.frac))
const gain = r1 / r0
check('相对基线的快慢变化接近 1.4 : 0.8（≈0.57 倍）',
  Math.abs(gain - 0.8 / 1.4) < 0.12, { gain: +gain.toFixed(3), want: +(0.8 / 1.4).toFixed(3), r0: +r0.toFixed(3), r1: +r1.toFixed(3) })
check('参数读得出来',
  Number(getParam(db, aid, 'affect.recover.neg')) === 1.4
  && Number(getParam(db, aid, 'affect.recover.pos')) === 0.8)

/* 贴着水位的死区：不许在 0 附近来回抽 */
setParam(db, aid, 'affect.recover.neg', { value: 1.4 })
setParam(db, aid, 'affect.recover.pos', { value: 0.8 })
restore()
const bNear = Number(db.prepare('SELECT baseline FROM affect_v3 WHERE agent_id=?').get(aid).baseline)
db.prepare('UPDATE affect_v3 SET slow=?, slow_at=? WHERE agent_id=?')
  .run(bNear + 0.005, new Date(T0).toISOString(), aid)
const near = applyEmotionV3(db, aid, { pleasure: 0, label: 'calm', at: T0 + H, fresh: false })
check('贴着水位时不抽（一小时只挪一点点）', Math.abs(near.slow - bNear) < 0.05,
  { s: near.slow, b: bNear })

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
