/**
 * 第三步：自己沉下去要能察觉。
 * 连续低于水位够久才认；认了只让回落快一点，不改判断、不造正向情绪。
 * 运行：node test/regulate.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, now } from '../src/db.js'
import { attachDb } from '../src/algo/index.js'
import { setParam } from '../src/kernel.js'
import { seedAffect, applyEmotionV3 } from '../src/modules/affect.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)) }
}
const H = 3600000

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-reg-'))
const db = openDb(path.join(dir, 'app.db'))
attachDb(db)
const aid = 'agt_reg'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid, '调节', 'daily', 'active', now())
seedAffect(db, aid)

/* 摘干净：不游走、不攒负荷、水位不动 */
setParam(db, aid, 'affect.walk.sd', { value: 0 })
setParam(db, aid, 'affect.baseline.load.gain', { value: 0 })
setParam(db, aid, 'affect.baseline.circadian', { value: 0 })
setParam(db, aid, 'affect.baseline.rough', { value: 0 })
setParam(db, aid, 'affect.baseline.cycle', { value: 0 })

const T0 = Date.parse('2026-11-03T08:00:00+08:00')
applyEmotionV3(db, aid, { pleasure: 0, label: 'calm', at: T0 })
const b0 = Number(db.prepare('SELECT baseline FROM affect_v3 WHERE agent_id=?').get(aid).baseline)

/** 把慢情绪按回水位、清掉沉没计数 */
function reset(at = T0) {
  db.prepare('UPDATE affect_v3 SET slow=?, total=?, slow_at=?, sink_h=0 WHERE agent_id=?')
    .run(b0, b0, new Date(at).toISOString(), aid)
}
/** 小时数里每小时来一下负面的事——一直压着才叫沉着，一次落差自己就弹回去了 */
function sustained(hours, { pleasure = -0.8 } = {}) {
  reset()
  let t = T0
  for (let i = 0; i < hours; i++) {
    applyEmotionV3(db, aid, { pleasure, label: 'lost', at: t + H, fresh: true })
    t += H
  }
  return applyEmotionV3(db, aid, { pleasure: 0, label: 'calm', at: t + 1, fresh: false })
}

/* ---------- 一、短暂低一下不算沉 ---------- */
const short = sustained(4)
check('连低几小时还不算沉（没攒够 3 小时）', short.sinking === false, { sinkH: short.sinkH, sinking: short.sinking })
check('但沉没计数在攒', short.sinkH >= 1 && short.sinkH < 3, { sinkH: short.sinkH })

/* ---------- 二、连续沉够就认 ---------- */
const long = sustained(7)
check('连低 7 小时认作沉着', long.sinking === true, { sinkH: long.sinkH })
check('认的时候记了时长', long.sinkH >= 3, { sinkH: long.sinkH })

/* ---------- 三、认了之后回落更快 ---------- */
/* 先连着压 5 小时（认作沉着），再停止事件空转 2 小时，看谁回到水位更近 */
function afterSink(enabled) {
  setParam(db, aid, 'affect.regulate.enabled', { value: enabled ? 1 : 0 })
  reset()
  let t = T0
  for (let i = 0; i < 7; i++) {
    applyEmotionV3(db, aid, { pleasure: -0.8, label: 'lost', at: t + H, fresh: true })
    t += H
  }
  return applyEmotionV3(db, aid, { pleasure: 0, label: 'calm', at: t + 2 * H, fresh: false })
}
const withReg = afterSink(true)
const withoutReg = afterSink(false)
const gapOn = Math.abs(withReg.slow - withReg.baseline)
const gapOff = Math.abs(withoutReg.slow - withoutReg.baseline)
check('开着调节：空转 2 小时后离水位更近', gapOn < gapOff, { on: gapOn, off: gapOff })
check('差得不夸张（不是一键变好）', (gapOff - gapOn) / Math.max(1e-6, gapOff) < 0.4, { on: gapOn, off: gapOff })

/* ---------- 四、一被扶起来计数就清零 ---------- */
setParam(db, aid, 'affect.regulate.enabled', { value: 1 })
const r1 = sustained(4)
const t1 = r1.sinkH
db.prepare('UPDATE affect_v3 SET slow=?, slow_at=? WHERE agent_id=?')
  .run(b0 + 0.1, new Date(T0 + 4 * H).toISOString(), aid)
const r2 = applyEmotionV3(db, aid, { pleasure: 0, label: 'calm', at: T0 + 4.4 * H, fresh: false })
check('回到水位附近，计数清零', r2.sinkH < 1, { before: t1, after: r2.sinkH })
check('也就不算沉着了', r2.sinking === false, r2)

/* ---------- 五、低得不够深也不算（只低一点点那种） ---------- */
const shallow = sustained(8, { pleasure: -0.12 })
check('只比水位低一点点，不算沉', shallow.sinking === false, { sinkH: shallow.sinkH, slow: shallow.slow, b: shallow.baseline })

/* ---------- 六、事件只写一次 ---------- */
setParam(db, aid, 'affect.regulate.beta.mul', { value: 1.2 })
db.prepare("DELETE FROM events WHERE agent_id=? AND type='affect.sinking'").run(aid)
sustained(7)
const first = db.prepare("SELECT COUNT(*) n FROM events WHERE agent_id=? AND type='affect.sinking'").get(aid).n
check('第一次沉够写了一条', first === 1, { n: first })
db.prepare('UPDATE affect_v3 SET slow=?, slow_at=? WHERE agent_id=?')
  .run(b0 - 0.35, new Date(T0).toISOString(), aid)
applyEmotionV3(db, aid, { pleasure: 0, label: 'calm', at: T0 + 2 * H, fresh: false })
const second = db.prepare("SELECT COUNT(*) n FROM events WHERE agent_id=? AND type='affect.sinking'").get(aid).n
check('一直沉着不重复写', second === 1, { n: second })

/* ---------- 七、关掉就一点不生效 ---------- */
setParam(db, aid, 'affect.regulate.enabled', { value: 0 })
const off = sustained(6)
check('关掉时不认沉着', off.sinking === false, off)

try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
