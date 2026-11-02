/**
 * 节律被经历改写：深夜还在说话，日节律的相位往后挪；平时自己收回来。
 * 运行：node test/circ-phase.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, now } from '../src/db.js'
import { attachDb } from '../src/algo/index.js'
import { setParam, getParam } from '../src/kernel.js'
import { seedAffect, applyEmotionV3, affectTrend } from '../src/modules/affect.js'
import { circadianAt } from '../src/algo/baseline.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) } else {
    fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400))
  }
}
const finite = (x) => Number.isFinite(x)
const seed = 'agt_phase'
const H = 3600000
const r4 = (x) => Math.round(Number(x) * 10000) / 10000

/* ---------- 纯函数：相位就是个平移 ---------- */

const T = Date.parse('2026-11-01T00:00:00.000Z')
check('相位 0 就是旧公式',
  circadianAt(T, seed, 0.06) === circadianAt(T, seed, 0.06, 0))
check('往后挪 60 分钟 = 值等于一小时前的那个（形状没变，只是平移）',
  Math.abs(circadianAt(T, seed, 0.06, 60) - circadianAt(T - H, seed, 0.06, 0)) < 1e-12,
  { a: r4(circadianAt(T, seed, 0.06, 60)), b: r4(circadianAt(T - H, seed, 0.06, 0)) })
check('幅度没变（挪相位不放大）',
  Math.abs(circadianAt(T, seed, 0.06, 180)) <= 0.06 + 1e-12)
check('amplitude=0 时相位也不管事',
  circadianAt(T, seed, 0, 300) === 0 && circadianAt(T, seed, NaN, 300) === 0)
check('坏相位不产生 NaN', finite(circadianAt(T, seed, 0.06, NaN)) && finite(circadianAt(T, seed, 0.06, 'x')))

/* ---------- 接进库里 ---------- */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-phase-'))
const db = openDb(path.join(dir, 'app.db'))
attachDb(db)
const aid = 'agt_phase'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid, '相位', 'daily', 'active', now())
seedAffect(db, aid)

const night = (d, h, m = 0) => new Date(2026, 10, d, h, m, 0).getTime()

const a1 = applyEmotionV3(db, aid, { pleasure: 0.1, label: 'calm', at: night(1, 2, 0) })
check('凌晨两点还在说话：相位往后挪 12 分钟', a1.circPhase === 12, { ph: a1.circPhase })
check('相位也写进库里', Number(db.prepare('SELECT circ_phase FROM affect_v3 WHERE agent_id=?').get(aid).circ_phase) === 12)

const a2 = applyEmotionV3(db, aid, { pleasure: 0.1, label: 'calm', at: night(1, 2, 10) })
check('十分钟内又说一句：不重复挪（只会按 tau 极慢地收一点）',
  a2.circPhase > 11.9 && a2.circPhase <= 12, { ph: a2.circPhase })

const a3 = applyEmotionV3(db, aid, { pleasure: 0.1, label: 'calm', at: night(1, 3, 30) })
check('隔了一个半小时又熬：再挪一档（12 上下）',
  a3.circPhase - a2.circPhase > 11.5 && a3.circPhase - a2.circPhase < 12.1, { ph: a3.circPhase })

const a4 = applyEmotionV3(db, aid, { pleasure: 0.1, label: 'calm', at: new Date(2026, 10, 1, 12, 0, 0).getTime() })
check('白天说话：不挪相位，只按 tau 往回收',
  a4.circPhase < 24 && a4.circPhase > 20, { ph: a4.circPhase })

/* 已经拖得很后了：再熬也封在 180（不会把一天转过去） */
db.prepare('UPDATE affect_v3 SET circ_phase=175, circ_phase_at=?, slow_at=?, fast_at=? WHERE agent_id=?')
  .run(new Date(night(2, 1, 0)).toISOString(), new Date(night(2, 1, 0)).toISOString(), new Date(night(2, 1, 0)).toISOString(), aid)
const capped = applyEmotionV3(db, aid, { pleasure: 0, label: 'calm', at: night(2, 2, 0) })
check('拖到 175 再熬一档：封在 180', Math.abs(capped.circPhase - 180) < 1e-6, { ph: capped.circPhase })

/* 关掉：相位不动 */
setParam(db, aid, 'affect.circ.nightShift', { value: 0 })
check('nightShift 参数读得出来', Number(getParam(db, aid, 'affect.circ.nightShift')) === 0)
db.prepare('UPDATE affect_v3 SET circ_phase=0, circ_phase_at=? WHERE agent_id=?').run(new Date(night(3, 2, 0)).toISOString(), aid)
const off = applyEmotionV3(db, aid, { pleasure: 0, label: 'calm', at: night(3, 2, 0) + 2 * H })
check('nightShift=0 时熬夜也不挪', off.circPhase === 0, { ph: off.circPhase })
setParam(db, aid, 'affect.circ.nightShift', { value: 12 })

/* 走势：历史只认样本里记的相位 */
const tNow = Date.now()
const at1 = tNow - 7200e3
const at2 = tNow - 3600e3
const ins = (id, at, ph) => db.prepare('INSERT INTO affect_samples VALUES(?,?,?,?,?,?,?)')
  .run(id, aid, new Date(at).toISOString(), 'calm', 0.2,
    JSON.stringify({ pleasure: 0.1 }),
    JSON.stringify({ slow: 0.1, fast: 0.05, base_off: null, walk: null, circ_phase: ph }))
ins('afs_ph_a', at1, 0)
ins('afs_ph_b', at2, 60)
const tr = affectTrend(db, aid, 1)
const pA = tr.points.find((p) => p.at === at1)
const pB = tr.points.find((p) => p.at === at2)
check('走势读得出当时的相位', pA && pB && pA.ph === 0 && pB.ph === 60, { a: pA && pA.ph, b: pB && pB.ph })
check('相位真的改变了那一点的水位', pA && pB && Math.abs(pB.b - pA.b) > 1e-6, { d: pA && pB && +(pB.b - pA.b).toFixed(4) })

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
