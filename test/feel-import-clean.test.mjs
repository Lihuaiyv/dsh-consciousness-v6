/**
 * P2：导入记忆包后，悬空的 feel 引用要清掉。
 * 运行：node test/feel-import-clean.test.mjs
 *
 * 验证：
 *   1. 记忆包导入到没有对应 feel 的库，memory/fact_archive/episodes 的 feel_id 变 NULL；
 *   2. diaries 的 feel_ids 里不存在的 id 被过滤掉；
 *   3. 目标库自己的 feel 行不受影响；
 *   4. 导入的其他内容（记忆正文）照常进来。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { attachDb } from '../src/algo/index.js'
import { exportMemory, importMemory } from '../src/features.js'
import { recordFeel, attachableFeelId } from '../src/modules/feel.js'
import { addMemory, setFeelProvider } from '../src/modules/memory.js'

setFeelProvider(attachableFeelId)

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name + '  ' + JSON.stringify(detail === undefined ? '' : detail).slice(0, 400)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-feelimp-'))
const dbA = openDb(path.join(dir, 'a.db'))
const aidA = 'agt_impa'
dbA.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aidA, '源', 'daily', 'active', new Date().toISOString())
attachDb(dbA)
const f = recordFeel(dbA, aidA, { text: '导入前手停在按钮上' })
const fRow = dbA.prepare('SELECT id FROM affect_feel WHERE agent_id=? ORDER BY at DESC LIMIT 1').get(aidA)
const fid = fRow && fRow.id
check('源库 feel 写入', f.ok && !!fid, f)
const m = addMemory(dbA, aidA, { text: '源库里的记忆，带着感觉。', type: 'fact', source: 'manual' })
dbA.prepare("INSERT INTO episodes(id,agent_id,session_id,day,start_at,end_at,turns,title,summary,topics,open_loops,importance,source,feel_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
  .run('ep_src', aidA, 's1', '2026-11-05', null, null, 2, '源纪要', '摘要', '[]', '[]', 0.5, 'rules', fid, new Date().toISOString())
dbA.prepare("INSERT INTO diaries(id,agent_id,day,text,mood,highlights,refs,source,version,late,feel_ids,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
  .run('dry_src', aidA, '2026-11-05', '源日记', 'calm', '[]', '{}', 'rules', 1, 0, JSON.stringify([fid, 'afe_missing']), new Date().toISOString(), new Date().toISOString())

const out = exportMemory(dbA, aidA)
check('导出记忆包成功', out && out.zip_base64, out && out.counts)

// ---------- 导入到没有这条 feel 的库 ----------
const dbB = openDb(path.join(dir, 'b.db'))
const aidB = 'agt_impb'
dbB.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aidB, '目标', 'daily', 'active', new Date().toISOString())
attachDb(dbB)
const ownFeel = recordFeel(dbB, aidB, { text: '目标库自己那条还热着' })
const ownRow = dbB.prepare('SELECT id FROM affect_feel WHERE agent_id=?').get(aidB)
const res = importMemory(dbB, aidB, { zip_base64: out.zip_base64 })
check('导入成功', res && res.memory >= 1, res)

const memB = dbB.prepare('SELECT id, text, feel_id FROM memory_items WHERE agent_id=? AND text LIKE ?').get(aidB, '%源库里的记忆%')
check('导入的记忆正文进来了', !!memB, memB)
check('导入的 memory.feel_id 被清成 NULL', memB && memB.feel_id === null, memB && memB.feel_id)

const factB = dbB.prepare('SELECT feel_id FROM fact_archive WHERE agent_id=? AND text LIKE ?').get(aidB, '%源库里的记忆%')
check('导入的 fact_archive.feel_id 被清成 NULL', factB && factB.feel_id === null, factB && factB.feel_id)

const epB = dbB.prepare('SELECT feel_id FROM episodes WHERE agent_id=? AND title=?').get(aidB, '源纪要')
check('导入的 episode.feel_id 被清成 NULL', epB && epB.feel_id === null, epB && epB.feel_id)

const dryB = dbB.prepare('SELECT feel_ids FROM diaries WHERE agent_id=? AND day=?').get(aidB, '2026-11-05')
let dryIds = []
try { dryIds = JSON.parse(dryB && dryB.feel_ids || '[]') } catch { dryIds = [] }
check('导入的日记 feel_ids 被过滤为空', Array.isArray(dryIds) && dryIds.length === 0, dryB && dryB.feel_ids)

const own = dbB.prepare('SELECT 1 FROM affect_feel WHERE id=?').get(ownRow && ownRow.id)
check('目标库自己的 feel 不受影响', !!own, ownFeel)

dbA.close()
dbB.close()
console.log('\n通过 ' + pass + ' / ' + (pass + fail))
if (fail) { console.log('失败:', fail); process.exit(1) }
