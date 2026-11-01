/**
 * 五轴接线自检：在真实库的副本上跑，不碰线上数据。
 *
 * 验三件事：
 *   1. 证据攒够密度 → 轴真的动（tf 从 0.51 往 F 一侧）
 *   2. 冷却 / 迟滞仍然生效（第二次不会连跳）
 *   3. 意图会把方向掰过去（setAxisIntent 后，证据方向被覆盖）
 *
 * 用法：node dsh-plugin/scripts/axis-verify.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { openDb } from '../src/db.js'
import { addEvidence, flush, density, snapshot } from '../src/modules/axis_evidence.js'
import { readAxes, releaseAxis, setAxisIntent, getAxisIntent, clearAxisIntent } from '../src/modules/traits.js'

const src = path.join(os.homedir(), '.dsh', 'consciousness', 'app.db')
const tmp = path.join(os.tmpdir(), 'axis-verify-' + Date.now() + '.db')
fs.copyFileSync(src, tmp)
const db = openDb(tmp)

const aid = 'agt_3977d80f17'
const log = (k, v) => console.log(k.padEnd(26), typeof v === 'string' ? v : JSON.stringify(v))

// 0. 表与解锁状态
const tf = db.prepare("SELECT value, origin FROM persona WHERE agent_id=? AND path='axis.tf'").get(aid)
log('tf 当前', tf)
if (tf.origin !== 'auto') {
  const r = releaseAxis(db, aid, 'tf', '自检')
  log('解锁 tf', r)
}
log('五轴', readAxes(db, aid))

// 1. 造 3 条同向证据（tf 往 F 一侧），应触发一次漂移
for (let i = 0; i < 3; i++) addEvidence(db, aid, { axis: 'tf', dir: -1, strength: 0.8, source: 'verify' })
log('tf 证据密度', density(db, aid, 'tf', 20))
let moved = flush(db, aid)
log('第一次 flush', moved)
const after1 = readAxes(db, aid)
log('tf 漂移后', after1.tf)

// 2. 立刻再来 3 条：冷却应该挡住
for (let i = 0; i < 3; i++) addEvidence(db, aid, { axis: 'tf', dir: -1, strength: 0.8, source: 'verify' })
moved = flush(db, aid)
log('冷却中 flush', moved)
log('tf 未连跳', readAxes(db, aid).tf)

// 3. 意图：把方向掰到「更外向」（ei 往上）
setAxisIntent(db, aid, 'ei', 0.75, 7)
log('ei 意图', getAxisIntent(db, aid, 'ei'))
for (let i = 0; i < 3; i++) addEvidence(db, aid, { axis: 'ei', dir: 1, strength: 0.9, source: 'verify' })
moved = flush(db, aid)
log('意图方向 flush', moved.filter((m) => m.axis === 'ei'))
log('ei 漂移后', readAxes(db, aid).ei)
clearAxisIntent(db, aid, 'ei')

// 4. 快照
log('证据快照', snapshot(db, aid))

db.close()
try { fs.unlinkSync(tmp) } catch { /* ignore */ }
console.log('\n自检完成（临时库已删）')
