/**
 * 每实例心跳测试（schema 12）。
 * 运行：node test/heartbeat.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, now } from '../src/db.js'
import { attachDb } from '../src/algo/index.js'
import {
  ensureRows, dueRows, heartbeatTick, setHeartbeatMode, poke, heartbeatStats,
  LIGHT_MS, DEEP_MS, MAX_INTERVAL_MS, BACKOFF_AFTER,
} from '../src/modules/heartbeat.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-hb-'))
const db = openDb(path.join(dir, 'app.db'))
attachDb(db)

function mk(id, status = 'active') {
  db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
    .run(id, id, 'daily', status, now())
  db.prepare("INSERT INTO agent_runtime(agent_id,state,since,updated_at) VALUES(?,'idle',?,?)").run(id, now(), now())
  return id
}
const A = mk('agt_h1')
const B = mk('agt_h2')
const C = mk('agt_paused', 'paused')

// 用固定随机源，让抖动可预期
const fixed = () => 0.5

// ---- 建账 ----
{
  ensureRows(db, 1_000_000, fixed)
  const rows = db.prepare('SELECT * FROM heartbeats ORDER BY agent_id').all()
  check('每个 active 实例一行', rows.length === 2, rows.map((r) => r.agent_id))
  check('暂停的实例不建账', !rows.some((r) => r.agent_id === C))
  check('间隔默认 5 分钟', rows.every((r) => Number(r.interval_ms) === LIGHT_MS), rows.map((r) => r.interval_ms))
  check('deep 到期时间也建了', rows.every((r) => Number(r.deep_at) > Number(r.next_at)), rows.map((r) => r.deep_at))
  ensureRows(db, 1_000_000, fixed)
  check('重复建账不重复插', db.prepare('SELECT COUNT(*) n FROM heartbeats').get().n === 2)
}

// ---- 到期筛选 ----
{
  db.prepare("UPDATE heartbeats SET next_at=?").run(2_000_000)
  check('没到期不跑', dueRows(db, 1_500_000).length === 0)
  check('到期就选中', dueRows(db, 2_000_000).length === 2, dueRows(db, 2_000_000).length)
  db.prepare("UPDATE heartbeats SET mode='off' WHERE agent_id=?").run(A)
  check('mode=off 不跳', dueRows(db, 2_000_000).every((r) => r.agent_id !== A))
  setHeartbeatMode(db, A, 'auto')
}

// ---- light 零模型 ----
{
  let lightCalls = []
  const modelCalls = []
  const at = 3_000_000
  db.prepare('UPDATE heartbeats SET next_at=?, deep_at=?').run(at, at + DEEP_MS)
  await heartbeatTick(db, at, {
    light: (aid) => lightCalls.push(aid),
    deep: (aid) => { modelCalls.push(aid); return Promise.resolve() },
    log: () => {},
  })
  check('两个实例都跳了', lightCalls.length === 2, lightCalls)
  check('deep 没到期就不调模型', modelCalls.length === 0, modelCalls)
  const rows = db.prepare('SELECT * FROM heartbeats ORDER BY agent_id').all()
  check('跳完推进 next_at', rows.every((r) => Number(r.next_at) > at), rows.map((r) => r.next_at))
  check('记了耗时', rows.every((r) => Number(r.last_ms) >= 0 && r.last_at === at), rows.map((r) => r.last_ms))
}

// ---- deep 到期 + 并发闸 ----
{
  const at = 4_000_000
  db.prepare("UPDATE heartbeats SET next_at=?, deep_at=?").run(at - 1000, at - 1000)
  let running = 0
  let peak = 0
  const order = []
  const out = await heartbeatTick(db, at, {
    light: () => {},
    deep: async (aid) => {
      running++; peak = Math.max(peak, running)
      await new Promise((r) => setTimeout(r, 5))
      running--
      order.push(aid)
    },
    maxDeep: 1,
    log: () => {},
  })
  check('deep 到期只放 1 个进来', out.deep === 1, out)
  check('不并发超限', peak <= 1, peak)
  check('跳过的记一笔 skips', db.prepare('SELECT SUM(skips) s FROM heartbeats').get().s >= 1, db.prepare('SELECT skips FROM heartbeats').all())
  check('被跳过的 deep_at 保留（下轮补）', db.prepare('SELECT deep_at FROM heartbeats').all().some((r) => Number(r.deep_at) <= at))
}

// ---- 失败与退避 ----
{
  const at = 6_000_000
  db.prepare('UPDATE heartbeats SET failures=0, interval_ms=?, next_at=?, deep_at=?').run(LIGHT_MS, at, at + DEEP_MS)
  let boom = true
  for (let i = 0; i < BACKOFF_AFTER; i++) {
    const t = at + i * LIGHT_MS
    db.prepare('UPDATE heartbeats SET next_at=?').run(t)
    await heartbeatTick(db, t, { light: () => { if (boom) throw new Error('模拟失败') }, log: () => {} })
  }
  const row = db.prepare('SELECT * FROM heartbeats WHERE agent_id=?').get(A)
  check('连续失败记下来了', Number(row.failures) >= BACKOFF_AFTER, row.failures)
  check('失败 3 次后间隔翻倍', Number(row.interval_ms) === LIGHT_MS * 2, row.interval_ms)
  check('错误原因留着', String(row.last_error || '').includes('模拟失败'), row.last_error)
  boom = false
  const t2 = at + 10 * LIGHT_MS
  db.prepare('UPDATE heartbeats SET next_at=?').run(t2)
  await heartbeatTick(db, t2, { light: () => {}, log: () => {} })
  const row2 = db.prepare('SELECT * FROM heartbeats WHERE agent_id=?').get(A)
  check('成功一次清掉失败计数', Number(row2.failures) === 0, row2.failures)
  check('成功也保留（退下来的）间隔不继续翻倍', Number(row2.interval_ms) <= MAX_INTERVAL_MS, row2.interval_ms)
}

// ---- 抖动不越界 ----
{
  const at = 9_000_000
  db.prepare('UPDATE heartbeats SET interval_ms=?, next_at=?, deep_at=?' + '').run(LIGHT_MS, at, at + DEEP_MS)
  await heartbeatTick(db, at, { light: () => {}, log: () => {} })
  const gaps = db.prepare('SELECT next_at - ? g FROM heartbeats').all(at).map((r) => Number(r.g))
  check('抖动落在 0.9~1.1 倍之间', gaps.every((g) => g >= LIGHT_MS * 0.9 && g <= LIGHT_MS * 1.1), gaps)
}

// ---- 暂停的实例不会被跳 ----
{
  const at = 12_000_000
  db.prepare('UPDATE heartbeats SET mode=?, next_at=?').run('auto', at)
  db.prepare("UPDATE agents SET status='paused' WHERE id=?").run(B)
  const ran = []
  await heartbeatTick(db, at, { light: (aid) => ran.push(aid), log: () => {} })
  check('暂停后不再跳', !ran.includes(B) && ran.includes(A), ran)
  db.prepare("UPDATE agents SET status='active' WHERE id=?").run(B)
}

// ---- 统计与 poke ----
{
  const st = heartbeatStats(db)
  check('统计能读', st.total === 2 && typeof st.overdue === 'number', st)
  const before = db.prepare('SELECT next_at FROM heartbeats WHERE agent_id=?').get(B).next_at
  poke(db, B, 123)
  const after = db.prepare('SELECT next_at FROM heartbeats WHERE agent_id=?').get(B).next_at
  check('poke 改下一次到期', after === 123 && after !== before, { before, after })
}

db.close()
fs.rmSync(dir, { recursive: true, force: true })
console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
