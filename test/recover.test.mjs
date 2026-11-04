/**
 * 恢复速度分正负：坏情绪退得快（neg 是「用时倍数」，0.5 = 一半时间），
 * 好情绪留得久（pos 1.5 = 一倍半时间）。
 *
 * 同一只实例、同一份状态、同一个起点跑两遍，只改「差在水位哪一边」。
 * 为了把别的力摘干净：累积负荷、随机游走、日节律、底色的纹全部关掉，
 * 水位在这一小时里不动，剩下的只有「往水位回落」这一路。
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
const close = (a, b, eps = 0.02) => Math.abs(a - b) < eps

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-rec-'))
const db = openDb(path.join(dir, 'app.db'))
attachDb(db)
const aid = 'agt_rec'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid, '恢复', 'daily', 'active', now())
seedAffect(db, aid)

/* 摘干净：不游走、不攒负荷、水位本身也不动（没有日节律/没有纹）。 */
setParam(db, aid, 'affect.walk.sd', { value: 0 })
setParam(db, aid, 'affect.baseline.load.gain', { value: 0 })
setParam(db, aid, 'affect.baseline.circadian', { value: 0 })
setParam(db, aid, 'affect.baseline.rough', { value: 0 })
setParam(db, aid, 'affect.baseline.cycle', { value: 0 })
const beta = Number(getParam(db, aid, 'affect.slow.beta')) || 0.1733

const T0 = Date.parse('2026-11-01T08:00:00.000Z')
const COLS = ['baseline', 'slow', 'fast', 'total', 'slow_at', 'fast_at', 'base_off', 'base_off_at', 'walk', 'walk_at', 'circ_phase', 'circ_phase_at', 'rec_label']

applyEmotionV3(db, aid, { pleasure: 0, label: 'calm', at: T0 })
const snapshot = db.prepare('SELECT * FROM affect_v3 WHERE agent_id=?').get(aid)
snapshot.base_off = 0
snapshot.walk = 0
const restore = () => {
  db.prepare('UPDATE affect_v3 SET ' + COLS.map((c) => c + '=?').join(', ') + ' WHERE agent_id=?')
    .run(...COLS.map((c) => snapshot[c]), aid)
}
const b0 = Number(snapshot.baseline)
const D = 0.25 // 往上往下都留得下，不撞 ±1 的边

/** 从水位 ±D 出发空转 1 小时，返回「还剩原来距离的几成」 */
function devRun(sign, hours = 1) {
  restore()
  const s0 = Math.max(-1, Math.min(1, b0 + sign * D))
  db.prepare('UPDATE affect_v3 SET slow=?, fast=?, total=?, slow_at=?, fast_at=? WHERE agent_id=?')
    .run(s0, 0, s0, new Date(T0).toISOString(), new Date(T0).toISOString(), aid)
  const r = applyEmotionV3(db, aid, { pleasure: 0, label: 'calm', at: T0 + hours * H, fresh: false })
  return { s0, s1: r.slow, b1: r.baseline, frac: Math.abs(r.slow - r.baseline) / Math.abs(s0 - b0) }
}

/* ---------- 一、不分正负时，两边一样快 ---------- */
setParam(db, aid, 'affect.recover.neg', { value: 1 })
setParam(db, aid, 'affect.recover.pos', { value: 1 })
const up1 = devRun(+1)
const down1 = devRun(-1)
check('neg=pos=1：两边都用基础半衰期', close(up1.frac, Math.exp(-beta), 0.02) && close(down1.frac, Math.exp(-beta), 0.02),
  { up: +up1.frac.toFixed(3), down: +down1.frac.toFixed(3), want: +Math.exp(-beta).toFixed(3) })
check('neg=pos=1：两边对称（差 < 0.02）', Math.abs(up1.frac - down1.frac) < 0.02,
  { up: +up1.frac.toFixed(3), down: +down1.frac.toFixed(3) })

/* ---------- 二、neg=0.5 / pos=1.5：坏情绪退得快，好情绪留得久 ---------- */
setParam(db, aid, 'affect.recover.neg', { value: 0.5 })
setParam(db, aid, 'affect.recover.pos', { value: 1.5 })
const up = devRun(+1)
const down = devRun(-1)
check('被抬高之后一小时：退掉一部分', up.frac > 0 && up.frac < 0.9, { frac: +up.frac.toFixed(3) })
check('低落之后一小时：剩得更少（退得快）',
  down.frac < up.frac - 0.02, { up: +up.frac.toFixed(3), down: +down.frac.toFixed(3) })
check('抬高：按 pos=1.5 的时长走（速率 ÷1.5）', close(up.frac, Math.exp(-beta / 1.5), 0.02),
  { got: +up.frac.toFixed(3), want: +Math.exp(-beta / 1.5).toFixed(3) })
check('低落：按 neg=0.5 的时长走（速率 ×2）', close(down.frac, Math.exp(-beta * 2), 0.02),
  { got: +down.frac.toFixed(3), want: +Math.exp(-beta * 2).toFixed(3) })

/* ---------- 三、越极端越快/越慢 ---------- */
setParam(db, aid, 'affect.recover.neg', { value: 0.25 })
const downFast = devRun(-1)
check('neg 越小，低落退得越快', downFast.frac < down.frac, { a: +downFast.frac.toFixed(3), b: +down.frac.toFixed(3) })
setParam(db, aid, 'affect.recover.pos', { value: 3 })
const upSlow = devRun(+1)
check('pos 越大，抬高留得越久', upSlow.frac > up.frac, { a: +upSlow.frac.toFixed(3), b: +up.frac.toFixed(3) })

/* ---------- 四、贴着水位的死区：不许在 0 附近来回抽 ---------- */
setParam(db, aid, 'affect.recover.neg', { value: 0.5 })
setParam(db, aid, 'affect.recover.pos', { value: 1.5 })
restore()
const bNear = Number(db.prepare('SELECT baseline FROM affect_v3 WHERE agent_id=?').get(aid).baseline)
db.prepare('UPDATE affect_v3 SET slow=?, slow_at=? WHERE agent_id=?')
  .run(bNear + 0.005, new Date(T0).toISOString(), aid)
const near = applyEmotionV3(db, aid, { pleasure: 0, label: 'calm', at: T0 + H, fresh: false })
check('贴着水位时不抽（一小时只挪一点点）', Math.abs(near.slow - bNear) < 0.05,
  { s: near.slow, b: bNear })

/* ---------- 五、参数读得出来 ---------- */
check('参数读得出来',
  Number(getParam(db, aid, 'affect.recover.neg')) === 0.5
  && Number(getParam(db, aid, 'affect.recover.pos')) === 1.5)

try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 清理失败不报 */ }

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
