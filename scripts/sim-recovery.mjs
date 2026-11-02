/**
 * 恢复动力学的整体对比：旧参数（β=0.07、好坏一样快）vs 新参数（β=0.11、负 1.4×/正 0.8×）。
 *
 * 两个场景：
 *   1. 连聊 12 小时（每 3 分钟一句，情绪正负交替），看慢情绪能不能跟住水位；
 *   2. 挨了一下之后没人理（6 小时），看多快回到水位附近——分别看「被抬高」和「被压下去」。
 *
 * 运行：node scripts/sim-recovery.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, now } from '../src/db.js'
import { attachDb } from '../src/algo/index.js'
import { setParam } from '../src/kernel.js'
import { seedAffect, applyEmotionV3 } from '../src/modules/affect.js'

const H = 3600000
const MIN = 60000

function fresh(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-sim-' + tag + '-'))
  const db = openDb(path.join(dir, 'app.db'))
  attachDb(db)
  /* 每条时间线用同一个 agent id：底色是按 seed 长的，换个 id 就是换个人生，比不了 */
  const aid = 'agt_sim'
  const t0 = Date.parse('2026-11-01T08:00:00.000Z')
  db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
    .run(aid, tag, 'daily', 'active', new Date(t0).toISOString())
  seedAffect(db, aid)
  return { db, aid, t0, dir }
}

/* 1. 连聊 12 小时。pump=true 模拟「旧版回读」：每轮把她自己的语气温度往慢情绪里灌 */
function chat(beta, neg, pos, pump = false) {
  const { db, aid, t0 } = fresh('chat' + Math.round(beta * 1000) + (pump ? 'p' : ''))
  setParam(db, aid, 'affect.slow.beta', { value: beta })
  setParam(db, aid, 'affect.recover.neg', { value: neg })
  setParam(db, aid, 'affect.recover.pos', { value: pos })
  setParam(db, aid, 'affect.walk.sd', { value: 0 })
  setParam(db, aid, 'affect.spont.rate', { value: 0 })
  const pattern = [[-0.3, 'irritated'], [0.2, 'joy'], [-0.15, 'confused'], [0.3, 'peaceful']]
  const devs = []
  let last = null
  for (let i = 1; i <= 240; i++) { // 12h，每 3 分钟
    const [pleasure, label] = pattern[i % pattern.length]
    const at = t0 + i * 3 * MIN
    last = applyEmotionV3(db, aid, { pleasure, label, at, fresh: true })
    if (pump) {
      /* 旧 applySelfRead：读自己的语气（这里当 0.55），差得远就往慢情绪里挪，最多 ±0.03/轮 */
      const row = db.prepare('SELECT slow, fast FROM affect_v3 WHERE agent_id=?').get(aid)
      const slow = Number(row.slow)
      const diff = 0.55 - slow
      if (Math.abs(diff) >= 0.25) {
        let d = 0.06 * diff
        if (d < 0) d *= 0.5
        d = Math.max(-0.03, Math.min(0.03, Math.round(d * 1000) / 1000))
        const next = Math.max(-1, Math.min(1, Math.round((slow + d) * 1000) / 1000))
        db.prepare('UPDATE affect_v3 SET slow=?, total=?, slow_at=? WHERE agent_id=?')
          .run(next, Math.round((next + 0.35 * Number(row.fast)) * 1000) / 1000, new Date(at).toISOString(), aid)
      }
    }
    if (i > 180) {
      const row = db.prepare('SELECT slow, baseline FROM affect_v3 WHERE agent_id=?').get(aid)
      devs.push(Math.abs(Number(row.slow) - Number(row.baseline)))
    }
  }
  const avg = devs.reduce((a, b) => a + b, 0) / devs.length
  const max = Math.max(...devs)
  return { avg, max, end: last }
}

/* 2. 挨一下之后没人理：看 1/2/4/6 小时各剩多少 */
function afterEvent(beta, neg, pos, sign) {
  const { db, aid, t0, dir } = fresh('ev' + sign + Math.round(beta * 1000))
  setParam(db, aid, 'affect.slow.beta', { value: beta })
  setParam(db, aid, 'affect.recover.neg', { value: neg })
  setParam(db, aid, 'affect.recover.pos', { value: pos })
  setParam(db, aid, 'affect.walk.sd', { value: 0 })
  setParam(db, aid, 'affect.spont.rate', { value: 0 })
  /* 单看恢复速度：把「水位被拖着走」的负荷关掉，不然两边的水位本身在动，没法比 */
  setParam(db, aid, 'affect.baseline.load.gain', { value: 0 })
  applyEmotionV3(db, aid, { pleasure: sign * 0.7, label: sign > 0 ? 'joy' : 'frustrated', at: t0 })
  const marks = {}
  for (const h of [1, 2, 4, 6]) {
    const r = applyEmotionV3(db, aid, { pleasure: 0, label: 'calm', at: t0 + h * H, fresh: false })
    marks[h] = Math.abs(Number(r.slow) - Number(r.baseline))
  }
  const r0 = db.prepare('SELECT slow, baseline FROM affect_v3 WHERE agent_id=?').get(aid)
  return marks
}

const OLD = { beta: 0.07, neg: 1, pos: 1 }
const NEW = { beta: 0.11, neg: 1.4, pos: 0.8 }

const chatOld = chat(OLD.beta, OLD.neg, OLD.pos)
const chatPump = chat(OLD.beta, OLD.neg, OLD.pos, true)
const chatNew = chat(NEW.beta, NEW.neg, NEW.pos)
const upOld = afterEvent(OLD.beta, OLD.neg, OLD.pos, +1)
const upNew = afterEvent(NEW.beta, NEW.neg, NEW.pos, +1)
const downOld = afterEvent(OLD.beta, OLD.neg, OLD.pos, -1)
const downNew = afterEvent(NEW.beta, NEW.neg, NEW.pos, -1)

const f = (x) => Number(x).toFixed(3)
console.log('连聊 12 小时（每 3 分钟一句，正负交替）')
console.log(`  慢情绪离水位的平均距离   旧(带旧回读灌入) ${f(chatPump.avg)}   旧参数(不灌) ${f(chatOld.avg)}   新 ${f(chatNew.avg)}`)
console.log(`  最远的那一刻             旧(带灌入) ${f(chatPump.max)}   旧参数(不灌) ${f(chatOld.max)}   新 ${f(chatNew.max)}`)
console.log('\n挨一下之后没人理：离水位还剩多少')
console.log('                    1h        2h        4h        6h')
console.log(`  被抬高  旧   ${f(upOld[1])}    ${f(upOld[2])}    ${f(upOld[4])}    ${f(upOld[6])}`)
console.log(`  被抬高  新   ${f(upNew[1])}    ${f(upNew[2])}    ${f(upNew[4])}    ${f(upNew[6])}`)
console.log(`  被压着  旧   ${f(downOld[1])}    ${f(downOld[2])}    ${f(downOld[4])}    ${f(downOld[6])}`)
console.log(`  被压着  新   ${f(downNew[1])}    ${f(downNew[2])}    ${f(downNew[4])}    ${f(downNew[6])}`)
