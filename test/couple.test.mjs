/**
 * 快慢耦合：同一句刺激，水位低的时候反应更大，水位高的时候更扛得住。
 * 运行：node test/couple.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, now } from '../src/db.js'
import { attachDb } from '../src/algo/index.js'
import { setParam } from '../src/kernel.js'
import { seedAffect, applyEmotionV3 } from '../src/modules/affect.js'
import { coupledF, fastOf } from '../src/algo/emotion.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) } else {
    fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400))
  }
}
const finite = (x) => Number.isFinite(x)
const r3 = (x) => Math.round(Number(x) * 1000) / 1000

/* ---------- 纯函数 ---------- */

check('gain=0：和旧的「谁说的都一样重」一致', coupledF(0.4, -0.8, 0) === 0.4)
check('水位低（-0.6）放大 30%', coupledF(0.4, -0.6, 0.5) === 0.52, { v: coupledF(0.4, -0.6, 0.5) })
check('水位高（+0.6）收 30%', coupledF(0.4, 0.6, 0.5) === 0.28, { v: coupledF(0.4, 0.6, 0.5) })
check('水位为 0 时不放大也不收', coupledF(0.4, 0, 0.5) === 0.4)
check('负刺激同样按这个方向放大（不是只放大高兴）', coupledF(-0.4, -0.6, 0.5) === -0.52)
check('放大有上限（couple 封 2）', coupledF(0.5, -1, 2) === 1 || coupledF(0.9, -1, 2) === 1, { v: coupledF(0.9, -1, 2) })
check('收也有下限（couple 底 0.4）', coupledF(0.5, 1, 2) === 0.2, { v: coupledF(0.5, 1, 2) })
check('结果夹在 ±1', coupledF(0.9, -1, 0.5) === 1)
check('坏输入不产生 NaN', finite(coupledF(NaN, NaN, NaN)) && finite(coupledF('x', 'y', 'z')))

/* ---------- 接进库里 ---------- */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-couple-'))
const db = openDb(path.join(dir, 'app.db'))
attachDb(db)
const aid = 'agt_couple'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid, '耦合', 'daily', 'active', now())
seedAffect(db, aid)

const base = Date.parse('2026-11-01T08:00:00.000Z')
const H = 3600000

/* gain=0：快情绪就是刺激本身 */
setParam(db, aid, 'affect.couple.gain', { value: 0 })
const g0 = applyEmotionV3(db, aid, { pleasure: 0.4, label: 'joy', eUser: 0, closeness: 0.5, at: base })
check('gain=0 时快情绪 = 刺激（0.4）', g0.fast === 0.4, { f: g0.fast })

/* gain 打开：快情绪 = 刺激 × (1 − gain·水位) */
setParam(db, aid, 'affect.couple.gain', { value: 0.5 })
const raw = fastOf({ fSelf: 0.4, eUser: 0, ePrev: 0, closeness: 0.5 })
let lo = 0
let hi = 0
let mismatch = 0
for (let i = 1; i <= 24; i++) {
  const r = applyEmotionV3(db, aid, { pleasure: 0.4, label: 'joy', eUser: 0, closeness: 0.5, at: base + i * 1.5 * H })
  const want = coupledF(raw, r.baseline, 0.5)
  if (r.fast !== want) mismatch++
  if (r.baseline < -0.05) lo++
  if (r.baseline > 0.05) hi++
}
check('一天里每个点都对得上公式（刺激 × 耦合）', mismatch === 0, { mismatch })
check('这一天里水位高低两种情况都出现过（不是空跑）', lo > 0 && hi > 0, { lo, hi })

/* 水位低的那几笔，确实比 gain=0 时更重 */
const row = db.prepare('SELECT baseline FROM affect_v3 WHERE agent_id=?').get(aid)
const applied = applyEmotionV3(db, aid, { pleasure: 0.4, label: 'joy', eUser: 0, closeness: 0.5, at: base + 40 * H })
const ratio = applied.fast / 0.4
const expectRatio = 1 - 0.5 * applied.baseline
check('耦合倍数就是 1 − 0.5·水位', Math.abs(ratio - expectRatio) < 0.002, { ratio: r3(ratio), expect: r3(expectRatio) })
check('水位是负的时候倍数 > 1', applied.baseline >= 0 || ratio > 1, { b: applied.baseline, ratio: r3(ratio) })

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
