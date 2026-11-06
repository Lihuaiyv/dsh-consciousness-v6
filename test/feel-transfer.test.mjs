/**
 * P1：全量导出 / 导入要带上 affect_feel。
 * 运行：node test/feel-transfer.test.mjs
 *
 * 验证：
 *   1. exportFull 的包里含 affect_feel；
 *   2. 导入到新库后，feel 行数一致、正文一致；
 *   3. 记忆 / 事实存根里的 feel_id 能顺着翻到正文（不再悬空）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { attachDb } from '../src/algo/index.js'
import { exportFull, importFull } from '../src/features.js'
import { recordFeel, feelsByIds, attachableFeelId } from '../src/modules/feel.js'
import { addMemory, setFeelProvider } from '../src/modules/memory.js'

setFeelProvider(attachableFeelId)

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name + '  ' + JSON.stringify(detail === undefined ? '' : detail).slice(0, 400)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-feeltransfer-'))
const dbA = openDb(path.join(dir, 'a.db'))
const aidA = 'agt_src'
dbA.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aidA, '源', 'daily', 'active', new Date().toISOString())
attachDb(dbA)

const f = recordFeel(dbA, aidA, { text: '导出的时候攥着鼠标没松', sessionId: null, source: 'tool' })
check('feel 写入成功', f.ok, f)
const m = addMemory(dbA, aidA, { text: '这条记忆带着感觉，要一起搬走。', type: 'fact', source: 'manual' })
const factRow = dbA.prepare('SELECT feel_id FROM fact_archive WHERE memory_id=?').get(m.id)
check('源库：记忆挂 feel', !!factRow && typeof factRow.feel_id === 'string', factRow)

// ---------- 导出 ----------
const out = exportFull(dbA, aidA)
check('导出成功', out && out.zip_base64, out && Object.keys(out))

// ---------- 导入到新库 ----------
const dbB = openDb(path.join(dir, 'b.db'))
const aidB = 'agt_dst'
dbB.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aidB, '目标', 'daily', 'active', new Date().toISOString())
attachDb(dbB)
const res = importFull(dbB, aidB, out)
check('导入成功', res && res.imported > 0, res)

const nA = dbA.prepare('SELECT COUNT(*) c FROM affect_feel WHERE agent_id=?').get(aidA).c
const nB = dbB.prepare('SELECT COUNT(*) c FROM affect_feel WHERE agent_id=?').get(aidB).c
check('导入后 feel 条数一致', nB === nA && nB >= 1, { nA, nB })

const feelB = dbB.prepare('SELECT text, at, turn_id FROM affect_feel WHERE agent_id=? LIMIT 1').get(aidB)
check('导入后 feel 正文一致', feelB && feelB.text === '导出的时候攥着鼠标没松', feelB)

// ---------- 引用不再悬空 ----------
const memB = dbB.prepare('SELECT id, text, feel_id FROM memory_items WHERE agent_id=? AND text LIKE ?').get(aidB, '%这条记忆带着感觉%')
check('导入后记忆还在', !!memB, memB)
const map = feelsByIds(dbB, [memB && memB.feel_id])
check('导入后记忆的 feel 能翻到正文', memB && map.get(memB.feel_id) && map.get(memB.feel_id).text === '导出的时候攥着鼠标没松', memB && map.get(memB.feel_id))

const factB = dbB.prepare('SELECT feel_id FROM fact_archive WHERE agent_id=? AND text LIKE ?').get(aidB, '%这条记忆带着感觉%')
check('导入后存根的 feel 能翻到正文', factB && feelsByIds(dbB, [factB.feel_id]).get(factB.feel_id), factB)

dbA.close()
dbB.close()
console.log('\n通过 ' + pass + ' / ' + (pass + fail))
if (fail) { console.log('失败:', fail); process.exit(1) }
