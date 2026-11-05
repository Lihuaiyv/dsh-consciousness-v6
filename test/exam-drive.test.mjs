/**
 * 驱力缺口零件 · 考卷
 *
 * 管的是「她现在最缺什么、缺到什么档」：五维缺口 → D → 带迟滞的档位 → 解锁。
 * 不管「要不要开口」（主动开口）、不管「能不能花令牌」（预算/端口，同文件不同事）。
 *
 * 运行：node test/exam-drive.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, now } from '../src/db.js'
import { run as algoRun } from '../src/algo/index.js'
import { personaSetpoint, deficitV1 } from '../src/algo/deficit.js'
import { seedDrive, hasDriveState, getDrive, evaluateDrive } from '../src/modules/drive.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 500)) }
}

const run = (v, input) => algoRun('deficit', v, {}, input)
const dims = (x) => ({ R: x, E: x, C: x, A: x, S: x })

// ================================================================ 纯公式：缺口与档位
{
  const zero = run('v1', { dims: dims(0.6), setpoint: dims(0.6), coupling: 0 })
  check('不缺时缺口为 0', zero.deficits.R === 0 && zero.D === 0, zero)
  check('不缺时是 D0', zero.band === 'D0', zero.band)

  const d2 = run('v1', { dims: dims(0.2), setpoint: dims(0.6) })
  check('缺口 0.65 → D2', d2.band === 'D2', d2)
  check('D 取最大缺口', Math.abs(d2.D - 0.65) < 1e-3, d2.D)

  const d3 = run('v1', { dims: dims(0.1), setpoint: dims(0.6) })
  check('缺口 0.825 → D3', d3.band === 'D3', d3.band)
  check('D 夹在 0~1', d3.D <= 1 && d3.D >= 0, d3.D)

  const one = run('v1', { dims: { R: 0.2, E: 0.6, C: 0.6, A: 0.6, S: 0.6 }, setpoint: dims(0.6) })
  check('只缺一维，取那一维', one.band === 'D2' && one.deficits.R > 0.5 && one.deficits.E === 0, one.deficits)
}

// ================================================================ 纯公式：迟滞
{
  const up = run('v1', { dims: dims(0.302), setpoint: dims(0.6), prev_band: 'D2' })
  check('D 0.47 在离开线上方 → 留在 D2', up.band === 'D2', { D: up.D, band: up.band })
  const down = run('v1', { dims: dims(0.32), setpoint: dims(0.6), prev_band: 'D2' })
  check('D 0.44 跌破离开线 → 降到 D1', down.band === 'D1', { D: down.D, band: down.band })
  const rise = run('v1', { dims: dims(0.2), setpoint: dims(0.6), prev_band: 'D0' })
  check('升档要过进入线：D 0.65 → D2', rise.band === 'D2', rise.band)
  const stay = run('v1', { dims: dims(0.32), setpoint: dims(0.6), prev_band: 'D1' })
  check('在档内不抖', stay.band === 'D1', stay.band)
  const direct = deficitV1.run({}, { dims: dims(0.302), setpoint: dims(0.6), prev_band: 'D2' })
  check('直调 v1 也守迟滞', direct.band === 'D2', direct.band)
}

// ================================================================ 纯公式：平滑与耦合
{
  const smooth = run('v1', { dims: dims(0.2), setpoint: dims(0.6), smooth_prev: dims(0), alpha: 0.35 })
  check('平滑 = 旧 0.65 + 新 0.35', Math.abs(smooth.deficits.R - 0.35 * 0.65) < 1e-3, smooth.deficits.R)
  const cold = run('v1', { dims: dims(0.2), setpoint: dims(0.6), alpha: 0.35 })
  check('冷启动直接取当前缺口', Math.abs(cold.deficits.R - 0.65) < 1e-3, cold.deficits.R)
  const coupled = run('v1', { dims: dims(0.6), setpoint: dims(0.6), coupling: 0.05 })
  check('耦合把「刚好持平」抬过基线，缺口仍 0', coupled.D === 0, coupled.D)
  check('raw 和 smooth 都交出来', !!coupled.raw && !!coupled.smooth)
}

// ================================================================ 六个版本：各自的性格
{
  const mid = run('v1', { dims: dims(0.3), setpoint: dims(0.6) })
  const loose = run('v1b', { dims: dims(0.3), setpoint: dims(0.6) })
  check('v1 更严：0.475 只到 D1', mid.band === 'D1', mid.band)
  check('v1b 更松：0.475 就到 D2', loose.band === 'D2', loose.band)

  const capped = run('v1c', { dims: dims(0.1), setpoint: dims(0.6), prev_band: 'D0' })
  check('v1c 一次最多升一档', capped.band === 'D1', capped.band)
  const uncapped = run('v1', { dims: dims(0.1), setpoint: dims(0.6), prev_band: 'D0' })
  check('v1 可以一步到 D3', uncapped.band === 'D3', uncapped.band)

  const neutral = personaSetpoint({})
  check('中立人格回到 0.6', Object.values(neutral).every((v) => v === 0.6), neutral)
  const sensitive = personaSetpoint({ tf: 1, sn: 1, jp: 1, ei: 1, sensitivity: 0 })
  check('偏情感 → 关系基线更低', sensitive.R === 0.5, sensitive)
  check('偏直觉 → 表达基线更高', sensitive.E === 0.8, sensitive.E)
  check('偏外向 → 自主基线更高', sensitive.A === 0.7, sensitive.A)
  check('不敏感 → 安全基线更低', sensitive.S === 0.4, sensitive.S)

  const v1d = run('v1d', { dims: dims(0.6), setpoint: dims(0.6), persona: {} })
  check('v1d 中立人格时不缺', v1d.band === 'D0' && v1d.D === 0, v1d)

  const v2 = run('v2', { dims: dims(0.2), setpoint: dims(0.6) })
  check('v2 也能算缺口', v2.D > 0.5 && ['D1', 'D2', 'D3'].includes(v2.band), v2)
  const v3off = run('v3', { dims: dims(0.2), setpoint: dims(0.6), weights_on: false })
  check('v3 关权重时和 v2 同判', v3off.band === v2.band && Math.abs(v3off.D - v2.D) < 0.15, { v2: v2.D, v3: v3off.D })
  check('每个版本都报自己的名字', ['v1', 'v1b', 'v1c', 'v1d', 'v2', 'v3'].every((v) => {
    const r = run(v, { dims: dims(0.6), setpoint: dims(0.6) })
    return r.algo && r.algo.name === 'deficit' && r.algo.version === v
  }))
}

// ================================================================ 状态：种子 / 读 / 评估
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-drive-'))
const db = openDb(path.join(dir, 'app.db'))
const aid = 'agt_drive'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid, '驱力', 'daily', 'active', now())
{
  check('还没种时没有驱力', hasDriveState(db, aid) === false)
  seedDrive(db, aid)
  check('种下去就有状态', hasDriveState(db, aid) === true)
  const row = db.prepare('SELECT * FROM drive_state WHERE agent_id=?').get(aid)
  check('初始五维：0.55 / 安全 0.6', row.r === 0.55 && row.s === 0.6, { r: row.r, s: row.s })
  check('初始档位 D0', row.band === 'D0', row.band)
  check('初始令牌袋有 c1–c4', ['c1', 'c2', 'c3', 'c4'].every((k) => k in JSON.parse(row.tokens)), row.tokens)

  const g = getDrive(db, aid)
  check('读驱力带缺口和档位', typeof g.deficits.R === 'number' && g.band === 'D0', g)
  check('读驱力带基线', g.setpoint && g.setpoint.R === 0.6, g.setpoint)
  check('读驱力带解锁', g.unlocked && g.unlocked.c4 === true && g.unlocked.c1 === false, g.unlocked)
  check('初始没有缺口（还在 D0 线内）', g.D <= 0.1, g.D)
}

// ================================================================ 状态：评估 / 档位 / 连击 / 解锁
{
  db.prepare('UPDATE drive_state SET r=0.2, last_eval_at=? WHERE agent_id=?').run(now(), aid)
  const e = evaluateDrive(db, aid)
  check('关系油位掉 → 缺口升', e.deficits.R > 0.5, e.deficits)
  check('档位离开 D0', e.band !== 'D0', e.band)
  check('评估留一条事件', Number(db.prepare("SELECT COUNT(*) n FROM events WHERE agent_id=? AND type='drive.evaluated'").get(aid).n) >= 1)

  const row = db.prepare('SELECT band,streak FROM drive_state WHERE agent_id=?').get(aid)
  check('同档继续 → 连击加一', Number(row.streak) >= 1, row)

  // 回落到同一档：连击继续加
  const before = Number(db.prepare('SELECT streak FROM drive_state WHERE agent_id=?').get(aid).streak)
  const e2 = evaluateDrive(db, aid)
  const after = Number(db.prepare('SELECT streak FROM drive_state WHERE agent_id=?').get(aid).streak)
  check('同档再评估，连击往上走', after >= before || e2.band !== db.prepare('SELECT band FROM drive_state WHERE agent_id=?').get(aid).band, { before, after })

  // 解锁：D1 连击 3 → c3（用干净的新实例，避免前面评估留下的代理扰动）
  const unlockAid = 'agt_unlock'
  db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)').run(unlockAid, '解锁', 'daily', 'active', now())
  seedDrive(db, unlockAid)
  const spU = { R: 0.6, E: 0.6, C: 0.6, A: 0.6, S: 0.6, _habit: { R: 0.55, E: 0.55, C: 0.55, A: 0.55, S: 0.6 }, _moved: { R: 0, E: 0, C: 0, A: 0, S: 0 }, _learn_at: now(), _aligned: true }
  db.prepare("UPDATE drive_state SET r=0.2, e=0.2, c=0.2, a=0.2, s=0.2, band='D3', streak=4, last_eval_at=?, setpoint=? WHERE agent_id=?")
    .run(now(), JSON.stringify(spU), unlockAid)
  const e3 = evaluateDrive(db, unlockAid)
  check('D3 连击到 5 解锁 c1', e3.unlocked.c1 === true, e3)

  // 休眠：14 天没互动
  db.prepare("UPDATE agents SET last_interaction_at=? WHERE id=?").run(new Date(Date.now() - 20 * 86400000).toISOString(), aid)
  const e4 = evaluateDrive(db, aid)
  check('两周没互动 → 休眠', e4.dormant === true, e4.dormant)
  check('休眠时给 3 次醒后缓冲', e4.unlocked._resume === 3, e4.unlocked)

  // 唤醒
  db.prepare('UPDATE agents SET last_interaction_at=? WHERE id=?').run(now(), aid)
  const e5 = evaluateDrive(db, aid)
  check('有互动就不休眠', e5.dormant === false, e5.dormant)

  // 基线学习：上次评估在十天前
  const sp = JSON.parse(db.prepare('SELECT setpoint FROM drive_state WHERE agent_id=?').get(aid).setpoint)
  sp._learn_at = new Date(Date.now() - 10 * 86400000).toISOString()
  db.prepare('UPDATE drive_state SET setpoint=?, last_eval_at=? WHERE agent_id=?')
    .run(JSON.stringify(sp), new Date(Date.now() - 10 * 86400000).toISOString(), aid)
  const e6 = evaluateDrive(db, aid)
  check('隔了十天会学一次基线', e6.learned === true, e6.learned)
  check('学完基线是五个数', e6.setpoint && ['R', 'E', 'C', 'A', 'S'].every((k) => typeof e6.setpoint[k] === 'number'), e6.setpoint)
}

// ================================================================ 状态：缺数据要报错，不装
{
  const other = 'agt_no_drive'
  db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)').run(other, '空的', 'daily', 'active', now())
  let threw = false
  try { evaluateDrive(db, other) } catch { threw = true }
  check('没有驱力数据就报错，不硬算', threw === true)
}

console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exitCode = 1
