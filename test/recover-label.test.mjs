/**
 * 恢复快慢按「哪一种情绪」分：
 *   说不清的闷（lost/confused）拖得久，被凶一下（irritated）散得快，
 *   高兴（joy/curious）散得最快，平静（calm/peaceful）居中。
 * 同一只实例、同一份状态、同一段时长，只换标签。
 * 运行：node test/recover-label.test.mjs
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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-reclabel-'))
const db = openDb(path.join(dir, 'app.db'))
attachDb(db)
const aid = 'agt_reclabel'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid, '标签恢复', 'daily', 'active', now())
seedAffect(db, aid)

/* 把别的力都摘掉：不游走、不攒负荷、水位本身也不动（没有日节律/没有纹）。
   水位一动，frac 的分子分母就不同步，剩多少全看这一小时里水涨了还是落了。 */
setParam(db, aid, 'affect.walk.sd', { value: 0 })
setParam(db, aid, 'affect.baseline.load.gain', { value: 0 })
setParam(db, aid, 'affect.baseline.circadian', { value: 0 })
setParam(db, aid, 'affect.baseline.rough', { value: 0 })
setParam(db, aid, 'affect.baseline.cycle', { value: 0 })

const T0 = Date.parse('2026-11-02T08:00:00.000Z')
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

/** 挨同样一下（pleasure=-0.6），隔 1 小时看还剩原来距离的几成 */
function oneHour(label, pleasure = -0.6) {
  restore()
  const r0 = applyEmotionV3(db, aid, { pleasure, label, at: T0, fresh: true })
  const s0 = Number(r0.slow)
  const bStart = Number(r0.baseline)
  const r1 = applyEmotionV3(db, aid, { pleasure: 0, label: 'calm', at: T0 + H, fresh: false })
  return { s0, bStart, s1: Number(r1.slow), b1: Number(r1.baseline), frac: Math.abs(Number(r1.slow) - Number(r1.baseline)) / Math.abs(s0 - bStart) }
}

const lost = oneHour('lost')
const irr = oneHour('irritated')
const calmUp = oneHour('calm', +0.6)
const curiousUp = oneHour('curious', +0.6)
check('闷着（lost）比被凶（irritated）退得慢',
  lost.frac > irr.frac + 0.02, { lost: +lost.frac.toFixed(3), irr: +irr.frac.toFixed(3) })
/* 高兴那一类（curious，0.8）比平静那一类（calm，1.0）散得快 */
check('高兴（curious）比平静（calm）退得快',
  curiousUp.frac < calmUp.frac - 0.01, { curious: +curiousUp.frac.toFixed(3), calm: +calmUp.frac.toFixed(3) })
/* 标签那层是「用时倍数」：lost = 1.3，irritated = 0.9。
   两边都低于水位，正负那层（1/neg = 2）同时乘上去，比值里约掉了
   → 速率比 ≈ 0.9 / 1.3 ≈ 0.69（对数意义下）。 */
const rateRatio = Math.log(Math.max(1e-9, lost.frac)) / Math.log(Math.max(1e-9, irr.frac))
check('lost : irritated 的快慢比 ≈ 0.69',
  Math.abs(rateRatio - 0.9 / 1.3) < 0.12, { ratio: +rateRatio.toFixed(3), want: +(0.9 / 1.3).toFixed(3) })

/* 四个标签参数都设回 1：三种情绪一样快（只剩正负那层） */
for (const k of ['affect.recover.deep', 'affect.recover.sharp', 'affect.recover.bright', 'affect.recover.soft']) {
  setParam(db, aid, k, { value: 1 })
}
const lostFlat = oneHour('lost')
const irrFlat = oneHour('irritated')
check('标签参数=1 时，闷和被凶一样快', Math.abs(lostFlat.frac - irrFlat.frac) < 0.03,
  { lost: +lostFlat.frac.toFixed(3), irr: +irrFlat.frac.toFixed(3) })
check('参数读得出来', Number(getParam(db, aid, 'affect.recover.deep')) === 1)

/* 走势里的 now 也跟着标签走：把最后一个样本的标签换成 lost，半衰期应该更长 */
setParam(db, aid, 'affect.recover.deep', { value: 1.3 })
const ins = (at, label) => db.prepare('INSERT INTO affect_samples VALUES(?,?,?,?,?,?,?)')
  .run('afs_' + Math.random().toString(36).slice(2, 8), aid, new Date(at).toISOString(), label, 0.3,
    JSON.stringify({ pleasure: 0.1 }),
    JSON.stringify({ slow: 0.05, fast: 0.1, baseline: -0.2, base_off: 0, walk: 0, circ_phase: 0 }))
const { affectTrend } = await import('../src/modules/affect.js')
const tA = Date.now() - 60000
db.prepare("DELETE FROM affect_samples WHERE agent_id=?").run(aid)
ins(tA, 'lost')
const nowLost = affectTrend(db, aid, 1).now
db.prepare("DELETE FROM affect_samples WHERE agent_id=?").run(aid)
ins(tA, 'irritated')
const nowIrr = affectTrend(db, aid, 1).now
check('走势的 now：标签不同，回一半的时间不同', nowLost.half_h > nowIrr.half_h,
  { lost: nowLost.half_h, irr: nowIrr.half_h })
check('now 里带上了标签和倍数', nowLost.label === 'lost' && Math.abs(nowLost.rec_mul - 1.3) < 1e-9,
  { label: nowLost.label, mul: nowLost.rec_mul })

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
