/**
 * Phase 0：feel 钉到当轮 turn_id。
 * 运行：node --experimental-sqlite test/feel-turnid.test.mjs
 *
 * 验证：
 *   1. affect_feel 有 turn_id 列，recordFeel 会写；
 *   2. 不传 turnId 时，从 raw_turns 里最近一条 user 行自己找（同会话优先）；
 *   3. 有 turn_id 的 feel，around 按轮取 user/agent，不再靠 5 分钟时间窗猜；
 *   4. 两条相邻 feel 不会串到隔壁轮；
 *   5. 老 feel（无 turn_id）仍能按时间窗兜底；
 *   6. 太久以前的 user 轮不认（60 分钟窗口外留空，不编）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { attachDb } from '../src/algo/index.js'
import { recordFeel, listFeels, getFeel } from '../src/modules/feel.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name + '  ' + JSON.stringify(detail === undefined ? '' : detail).slice(0, 400)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-feelturn-'))
const db = openDb(path.join(dir, 'app.db'))
attachDb(db)
const aid = 'agt_feelturn'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid, '钉', 'daily', 'active', new Date().toISOString())

const iso = (offsetSec) => new Date(Date.now() + offsetSec * 1000).toISOString()

// ---------- 1. 列存在 ----------
const cols = db.prepare("SELECT name FROM pragma_table_info('affect_feel')").all().map((r) => r.name)
check('affect_feel 有 turn_id 列', cols.includes('turn_id'), cols)

// ---------- 2. 造两轮原文 ----------
db.prepare('INSERT INTO raw_turns(id,agent_id,session_id,turn_id,seq,role,text,tool,meta,created_at,day) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
  .run('raw_u1', aid, 's1', 'turnA', 1, 'user', 'A 轮那句', null, null, iso(-60), '2026-11-05')
db.prepare('INSERT INTO raw_turns(id,agent_id,session_id,turn_id,seq,role,text,tool,meta,created_at,day) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
  .run('raw_a1', aid, 's1', 'turnA', 2, 'assistant', 'A 轮的回复', null, null, iso(-58), '2026-11-05')

// 测试里把频率闸关掉：两条 feel 只差几秒，真实对话里也不会这样密
db.prepare('INSERT OR REPLACE INTO agent_params(agent_id,key,value,updated_at) VALUES(?,?,?,?)')
  .run(aid, 'affect.feel.min.gap', '0', new Date().toISOString())

// 显式 turnId：around 按轮取 A，不按时间窗
const r1 = recordFeel(db, aid, { text: '手指扣在桌沿上', sessionId: 's1', turnId: 'turnA', at: Date.now() - 55000 })
check('显式 turnId 写入成功', r1.ok && r1.turn_id === 'turnA', r1)

// 不传 turnId：自动解析最近一条 user 行（此时最近是 turnA）
const r2 = recordFeel(db, aid, { text: '被这么一钉反而踏实', sessionId: 's1', at: Date.now() - 53000 })
check('自动解析取到最近 user 轮的 turn_id', r2.ok && r2.turn_id === 'turnA', r2)

// ---------- 3. 新的一轮到来后，自动解析切到新轮 ----------
db.prepare('INSERT INTO raw_turns(id,agent_id,session_id,turn_id,seq,role,text,tool,meta,created_at,day) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
  .run('raw_u2', aid, 's1', 'turnB', 3, 'user', 'B 轮那句', null, null, iso(-20), '2026-11-05')
db.prepare('INSERT INTO raw_turns(id,agent_id,session_id,turn_id,seq,role,text,tool,meta,created_at,day) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
  .run('raw_a2', aid, 's1', 'turnB', 4, 'assistant', 'B 轮的回复', null, null, iso(-18), '2026-11-05')

const r3 = recordFeel(db, aid, { text: '这会儿肩膀落下来了', sessionId: 's1', at: Date.now() - 15000 })
check('新一轮的 feel 挂到 turnB', r3.ok && r3.turn_id === 'turnB', r3)

// ---------- 4. around 精确对轮 ----------
const list = listFeels(db, aid, { limit: 20 })
const f1 = list.find((f) => f.text === '手指扣在桌沿上')
const f3 = list.find((f) => f.text === '这会儿肩膀落下来了')
check('feel1 按 turnA 取 user', f1 && f1.around && f1.around.user === 'A 轮那句', f1 && f1.around)
check('feel1 按 turnA 取 agent', f1 && f1.around && f1.around.agent === 'A 轮的回复', f1 && f1.around)
check('feel3 按 turnB 取 user', f3 && f3.around && f3.around.user === 'B 轮那句', f3 && f3.around)
check('feel3 按 turnB 取 agent', f3 && f3.around && f3.around.agent === 'B 轮的回复', f3 && f3.around)

// 列表返回 turn_id，界面/后续查询能直接用
check('列表带 turn_id', f1 && f1.turn_id === 'turnA', f1)
check('单条带 turn_id', (() => { const g = getFeel(db, aid, f1.id); return g && g.turn_id === 'turnA' })())

// ---------- 5. 老 feel（无 turn_id）仍按时间窗兜底 ----------
db.prepare('INSERT INTO chat_turns(id,agent_id,role,text,pack,mood,created_at,conversation_id) VALUES(?,?,?,?,?,?,?,?)')
  .run('cht_old_u', aid, 'user', '老的那句', '[]', null, iso(-600), null)
db.prepare('INSERT INTO chat_turns(id,agent_id,role,text,pack,mood,created_at,conversation_id) VALUES(?,?,?,?,?,?,?,?)')
  .run('cht_old_a', aid, 'agent', '老的回复', '[]', null, iso(-590), null)
db.prepare('INSERT INTO affect_feel(id,agent_id,at,text,label,fast,slow,total,session_id,source) VALUES(?,?,?,?,?,?,?,?,?,?)')
  .run('afe_old', aid, iso(-595), '一条老的、没有轮次的感觉', null, null, null, null, null, 'tool')
const oldOne = getFeel(db, aid, 'afe_old')
check('老 feel 没有 turn_id 也不报错', oldOne && oldOne.turn_id === null, oldOne)
check('老 feel 按时间窗兜底配到上下文', oldOne && oldOne.around && oldOne.around.user === '老的那句', oldOne && oldOne.around)

// ---------- 6. 60 分钟窗口外的 user 轮不认 ----------
const db2dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-feelturn2-'))
const db2 = openDb(path.join(db2dir, 'app.db'))
const aid2 = 'agt_feelturn2'
db2.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid2, '旧', 'daily', 'active', new Date().toISOString())
db2.prepare('INSERT INTO raw_turns(id,agent_id,session_id,turn_id,seq,role,text,tool,meta,created_at,day) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
  .run('raw_ancient', aid2, 's2', 'turnAncient', 1, 'user', '两小时前那句', null, null, iso(-7200), '2026-11-05')
const r4 = recordFeel(db2, aid2, { text: '太久了不该挂', sessionId: 's2', at: Date.now() })
check('60 分钟外的轮不认，turn_id 留空', r4.ok && r4.turn_id === null, r4)
db2.close()

db.close()
console.log('\n通过 ' + pass + ' / ' + (pass + fail))
if (fail) { console.log('失败:', fail); process.exit(1) }
