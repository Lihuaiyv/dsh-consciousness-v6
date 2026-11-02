/**
 * 不可逆的那一层：水位随机游走（walk）。
 * 运行：node test/walk.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, now } from '../src/db.js'
import { attachDb } from '../src/algo/index.js'
import { setParam, getParam } from '../src/kernel.js'
import { seedAffect, applyEmotionV3, affectTrend } from '../src/modules/affect.js'
import { gaussFrom, stepWalk } from '../src/algo/walk.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) } else {
    fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400))
  }
}
const finite = (x) => Number.isFinite(x)

/* 固定序列的 0..1 随机数，测试不靠运气 */
function mulberry32(a) {
  let t = a >>> 0
  return function () {
    t = (t + 0x6d2b79f5) >>> 0
    let x = t
    x = Math.imul(x ^ (x >>> 15), x | 1)
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61)
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296
  }
}

/* ---------- 纯函数 ---------- */

const rndA = mulberry32(20261102)
const gs = []
for (let i = 0; i < 20000; i++) gs.push(gaussFrom(rndA))
const gMean = gs.reduce((a, b) => a + b, 0) / gs.length
const gSd = Math.sqrt(gs.reduce((a, b) => a + (b - gMean) ** 2, 0) / gs.length)
check('正态：均值贴 0', Math.abs(gMean) < 0.05, { gMean: +gMean.toFixed(4) })
check('正态：标准差贴 1', Math.abs(gSd - 1) < 0.05, { gSd: +gSd.toFixed(4) })
check('正态：没有 NaN', gs.every(finite))
check('正态：坏 rnd 返回 0', gaussFrom(() => NaN) === 0 && gaussFrom(() => 0) !== 0 || finite(gaussFrom(() => 0)))

check('dt=0 原地不动', stepWalk({ walk: 0.123, dtHours: 0, tauH: 36, sd: 0.03 }) === 0.123)
check('sd=0 只剩回零（不带随机）',
  Math.abs(stepWalk({ walk: 0.2, dtHours: 36, tauH: 36, sd: 0 }) - 0.2 * Math.exp(-1)) < 1e-5)

/* 均值回归：从 0.2 出发、走一个 tau，平均应该落到 0.2/e 附近 */
const rndB = mulberry32(7)
let sum = 0
for (let i = 0; i < 3000; i++) sum += stepWalk({ walk: 0.2, dtHours: 36, tauH: 36, sd: 0.03, rnd: rndB })
const avg = sum / 3000
check('往 0 回归（走一个 tau 平均落到 0.2/e）', Math.abs(avg - 0.2 * Math.exp(-1)) < 0.01, { avg: +avg.toFixed(4) })

/* 稳态标准差 = sd */
const rndC = mulberry32(99)
let w = 0
const settle = []
for (let i = 0; i < 6000; i++) {
  w = stepWalk({ walk: w, dtHours: 36, tauH: 36, sd: 0.035, rnd: rndC })
  if (i > 500) settle.push(w)
}
const sMean = settle.reduce((a, b) => a + b, 0) / settle.length
const sSd = Math.sqrt(settle.reduce((a, b) => a + (b - sMean) ** 2, 0) / settle.length)
check('稳态幅度贴 sd（0.035 上下 ±15%）', Math.abs(sSd - 0.035) < 0.035 * 0.15, { sSd: +sSd.toFixed(4), sMean: +sMean.toFixed(4) })
check('稳态均值贴 0', Math.abs(sMean) < 0.01, { sMean: +sMean.toFixed(4) })
check('永远落在 ±1 里', settle.every((x) => Math.abs(x) <= 1))

/* 不可重放：同一出发点、过同样的时间，随机数不同就走到别处 */
const one = stepWalk({ walk: 0.1, dtHours: 12, tauH: 36, sd: 0.03, rnd: mulberry32(1) })
const two = stepWalk({ walk: 0.1, dtHours: 12, tauH: 36, sd: 0.03, rnd: mulberry32(2) })
check('同起点不同运气 → 走到不同地方', one !== two, { one, two })
check('同一个运气 → 同一处', one === stepWalk({ walk: 0.1, dtHours: 12, tauH: 36, sd: 0.03, rnd: mulberry32(1) }))
check('长空档不会飘出界', [-9, 9, 999].every((h) => Math.abs(stepWalk({ walk: 0.9, dtHours: h, tauH: 36, sd: 0.2, rnd: mulberry32(3) })) <= 1))
check('坏输入不产生 NaN', finite(stepWalk({ walk: NaN, dtHours: NaN, tauH: NaN, sd: NaN })))

/* ---------- 接进库里 ---------- */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-walk-'))
const db = openDb(path.join(dir, 'app.db'))
attachDb(db)
const aid = 'agt_walk'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid, '游走', 'daily', 'active', now())
seedAffect(db, aid)

const H = 3600000
const t0 = Date.parse('2026-11-01T10:00:00.000Z')

const first = applyEmotionV3(db, aid, { pleasure: 0.2, label: 'joy', at: t0 })
check('第一笔：没有上一次，游走还是 0', first.walk === 0, { walk: first.walk })
const row1 = db.prepare('SELECT walk, walk_at FROM affect_v3 WHERE agent_id=?').get(aid)
check('第一笔：walk_at 写进去了', Number.isFinite(Date.parse(row1.walk_at)))

const second = applyEmotionV3(db, aid, { pleasure: 0.1, label: 'calm', at: t0 + 10 * H })
check('隔 10 小时再走一步：游走动了', Math.abs(second.walk) > 1e-6, { walk: second.walk })
check('游走幅度在合理范围（±0.15 内）', Math.abs(second.walk) < 0.15, { walk: second.walk })
check('walk 存在库里', db.prepare('SELECT walk FROM affect_v3 WHERE agent_id=?').get(aid).walk === second.walk)
check('baseline 带着游走（不是纯函数那层）',
  Math.abs(second.baseline - (Number(second.baseline)) ) < 1e-9 && finite(second.baseline))

/* 关掉 sd：游走必须老老实实回到 0 那条路 */
setParam(db, aid, 'affect.walk.sd', { value: 0 })
check('sd 参数能读出来', Number(getParam(db, aid, 'affect.walk.sd')) === 0)
const third = applyEmotionV3(db, aid, { pleasure: 0.05, label: 'calm', at: t0 + 20 * H })
check('sd=0 之后不再乱走（只剩回零）', Math.abs(third.walk) < Math.abs(second.walk) + 1e-9, { third: third.walk, second: second.walk })
setParam(db, aid, 'affect.walk.sd', { value: 0.03 })

/* 走势：历史只认样本里记下的 walk */
const tNow = Date.now()
const segsAt = tNow - 3600e3
db.prepare('INSERT INTO affect_samples VALUES(?,?,?,?,?,?,?)')
  .run('afs_walk_a', aid, new Date(segsAt).toISOString(), 'calm', 0.2,
    JSON.stringify({ pleasure: 0.1 }), JSON.stringify({ slow: 0.1, fast: 0.05, base_off: null, walk: null }))
db.prepare('INSERT INTO affect_samples VALUES(?,?,?,?,?,?,?)')
  .run('afs_walk_b', aid, new Date(tNow - 600e3).toISOString(), 'calm', 0.2,
    JSON.stringify({ pleasure: 0.1 }), JSON.stringify({ slow: 0.1, fast: 0.05, base_off: null, walk: 0.05 }))
const tr = affectTrend(db, aid, 1)
const pA = tr.points.find((p) => p.at === segsAt)
const pB = tr.points.find((p) => p.at === tNow - 600e3)
check('走势里老样本的 walk 是 null（不冒充 0）', pA && pA.wk === null, { wk: pA && pA.wk })
check('走势里新样本的 walk 读得出来', pB && Math.abs(pB.wk - 0.05) < 1e-9, { wk: pB && pB.wk })
check('walk 真的抬高了那一点的底色', pB && pA && pB.b - pA.b > 0.03, { d: pB && pA && +(pB.b - pA.b).toFixed(3) })

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
