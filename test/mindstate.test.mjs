/**
 * mindstate 单测：上下文水位 + 复盘欠债。
 * 跑法：node test/mindstate.test.mjs
 *
 * 不给宿主：这条链路里没有任何 DSH 服务，只搬 db 和两条参数。
 */
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, now } from '../src/db.js'
import { writeParam } from '../src/kernel.js'
import { mindLine, noteMeter, meterFromUsage, _resetMindState, meterOf } from '../src/modules/mindstate.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-mind-'))
const db = openDb(path.join(dir, 'app.db'))
let pass = 0
let fail = 0
function check(name, ok, extra) {
  if (ok) { pass++; console.log('  ✓ ' + name) } else { fail++; console.log('  ✗ ' + name, extra === undefined ? '' : JSON.stringify(extra)) }
}

function newAgent(tag) {
  const aid = 'agt_mind_' + tag + '_' + Math.random().toString(36).slice(2, 7)
  db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
    .run(aid, 'mind-' + tag, 'chat', 'active', now())
  return aid
}

const H = 3600000
const T0 = Date.parse('2026-11-03T12:00:00.000Z')

// ---------------------------------------------------------------- 水位
{
  const aid = newAgent('meter')
  _resetMindState()

  noteMeter('sess-a', { used: 700, window: 1000 })
  const line = mindLine(db, aid, { nowMs: T0 })
  check('水位 70%：出现「快到上限」', line.includes('快到上限'), line)
  check('水位 70%：带了「【状态】」前缀', line.startsWith('【状态】'), line)

  noteMeter('sess-a', { used: 200, window: 1000 })
  check('水位 20%：沉默', mindLine(db, aid, { nowMs: T0 }) === '')

  noteMeter('sess-a', { used: 850, window: 1000 })
  check('水位 85%：已过压缩线，不再催（交给原生压缩）', mindLine(db, aid, { nowMs: T0 }) === '')

  noteMeter('sess-b', { used: 900, window: 0 })
  check('没有窗口：不猜，沉默', mindLine(db, aid, { nowMs: T0 }) === '')

  noteMeter('sess-c', { used: 650, window: 1000 })
  writeParam(db, aid, 'mind.meter.ratio', 0.7)
  check('ratio 调到 0.7：65% 沉默', mindLine(db, aid, { nowMs: T0 }) === '')
  noteMeter('sess-c', { used: 750, window: 1000 })
  check('ratio 调到 0.7：75% 开口', mindLine(db, aid, { nowMs: T0 }).includes('快到上限'))
  writeParam(db, aid, 'mind.meter.ratio', 0.6)

  writeParam(db, aid, 'mind.meter.enable', 'off')
  noteMeter('sess-a', { used: 700, window: 1000 })
  check('总开关 off：沉默', mindLine(db, aid, { nowMs: T0 }) === '')
  writeParam(db, aid, 'mind.meter.enable', 'on')

  _resetMindState()
  meterFromUsage('sess-u', { inputTokens: 900, outputTokens: 10, totalTokens: 910 })
  const m = meterOf('sess-u')
  check('usage 退路：记下 inputTokens 水位', m && m.used === 900 && m.window === 0, m)
  check('usage 退路：没有窗口就不说话', mindLine(db, aid, { nowMs: T0 }) === '')
  _resetMindState()
}

// ---------------------------------------------------------------- 欠债
{
  const aid = newAgent('debt')
  _resetMindState()

  // 从未整理过：新库不该催账
  check('从没整理过：沉默', mindLine(db, aid, { nowMs: T0 }) === '')

  const lastAt = new Date(T0 - 26 * H).toISOString()
  db.prepare('INSERT INTO consolidation_log(id,agent_id,day,at,steps,ok,ms) VALUES(?,?,?,?,?,?,?)')
    .run('cl_1', aid, '2026-11-02', lastAt, '[]', 1, 100)

  const insTurn = db.prepare('INSERT INTO raw_turns(id,agent_id,session_id,turn_id,seq,role,text,created_at,day) VALUES(?,?,?,?,?,?,?,?,?)')
  for (let i = 0; i < 19; i++) {
    insTurn.run('rt_' + i, aid, 's1', 't' + i, i, 'user', '话 ' + i, new Date(T0 - 10 * H + i * 1000).toISOString(), '2026-11-03')
  }
  check('攒了 19 条（差一条）：沉默', mindLine(db, aid, { nowMs: T0 }) === '')

  insTurn.run('rt_19', aid, 's1', 't19', 19, 'assistant', '回 19', new Date(T0 - 9 * H).toISOString(), '2026-11-03')
  const line = mindLine(db, aid, { nowMs: T0 })
  check('攒够 20 条：说「还攒着」', line.includes('还攒着'), line)
  check('欠债：带上了小时数', line.includes('26'), line)

  const again = mindLine(db, aid, { nowMs: T0 })
  check('冷却中：同一句不连说两遍', again === '', again)

  // 冷却过了：又说
  const later = mindLine(db, aid, { nowMs: T0 + 7 * H })
  check('冷却 6 小时后再提一次', later.includes('还攒着'), later)

  // 整理过了：不欠了
  db.prepare('INSERT INTO consolidation_log(id,agent_id,day,at,steps,ok,ms) VALUES(?,?,?,?,?,?,?)')
    .run('cl_2', aid, '2026-11-03', new Date(T0 + 8 * H).toISOString(), '[]', 1, 100)
  check('刚整理完：沉默', mindLine(db, aid, { nowMs: T0 + 9 * H }) === '')

  writeParam(db, aid, 'mind.review.enable', 'off')
  check('欠债开关 off：沉默', mindLine(db, aid, { nowMs: T0 + 7 * H }) === '')
  writeParam(db, aid, 'mind.review.enable', 'on')
}

// ---------------------------------------------------------------- 两条同时
{
  const aid = newAgent('both')
  _resetMindState()
  const lastAt = new Date(T0 - 30 * H).toISOString()
  db.prepare('INSERT INTO consolidation_log(id,agent_id,day,at,steps,ok,ms) VALUES(?,?,?,?,?,?,?)')
    .run('cl_b', aid, '2026-11-01', lastAt, '[]', 1, 100)
  const insTurn = db.prepare('INSERT INTO raw_turns(id,agent_id,session_id,turn_id,seq,role,text,created_at,day) VALUES(?,?,?,?,?,?,?,?,?)')
  for (let i = 0; i < 21; i++) {
    insTurn.run('bt_' + i, aid, 's1', 't' + i, i, 'user', '话', new Date(T0 - 5 * H).toISOString(), '2026-11-03')
  }
  noteMeter('sess-both', { used: 720, window: 1000 })
  const line = mindLine(db, aid, { nowMs: T0 })
  check('两条同时：一句话里都有', line.includes('快到上限') && line.includes('还攒着'), line)
  check('两条同时：只有一个【状态】前缀', (line.match(/【状态】/g) || []).length === 1, line)
  _resetMindState()
}

// ---------------------------------------------------------------- 隔离
{
  const aid = newAgent('iso')
  check('空会话：沉默', mindLine(db, aid, { nowMs: T0 }) === '')
  _resetMindState()
}

console.log('')
console.log('通过 ' + pass + ' / ' + (pass + fail))
if (fail) process.exit(1)
