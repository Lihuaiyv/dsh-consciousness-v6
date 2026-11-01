/**
 * U8：记忆健康快照 + memory-health API。
 * 运行：node test/u8-health.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, now } from '../src/db.js'
import { addMemory } from '../src/modules/memory.js'
import { applyWrite } from '../src/modules/gate.js'
import { logRetrieval, memoryHealth } from '../src/modules/retrieval_log.js'
import { handle } from '../src/api.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-u8-'))
const db = openDb(path.join(dir, 'app.db'))
const aid = 'agt_u8'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid, 'u8', 'daily', 'active', now())

addMemory(db, aid, { text: '每周二晚上去游泳', type: 'fact', source: 'episode' })
addMemory(db, aid, { text: '我喜欢手冲咖啡', type: 'fact', source: 'extract' })
applyWrite(db, aid, { text: '我不喜欢手冲咖啡了', entity_id: null }, (cand) => addMemory(db, aid, {
  text: cand.text, type: 'fact', source: 'extract', skipConflict: true,
}))
logRetrieval(db, aid, { scene: 'S1', query: '游泳', items: 1, tokens: 8, ms: 1 })
logRetrieval(db, aid, { scene: 'S1', query: '无关词xyz', items: 0, tokens: 0, ms: 1 })

const h = memoryHealth(db, aid, 7)
check('health 有召回统计', h.retrieve && h.retrieve.total >= 2, h.retrieve)
check('health 有冲突开案', h.conflicts.open >= 1, h.conflicts)
check('health 有习惯计数', h.habits.active + h.habits.cold >= 1, h.habits)
check('health 有来源分布', (h.sources.episode || 0) + (h.sources.extract || 0) >= 1, h.sources)
check('health ok 字段存在', typeof h.ok === 'boolean', h)

const api = await handle(db, {
  method: 'GET', path: `/v1/agents/${aid}/memory-health?days=7`,
  body: { __idempotencyKey: 'u8h1' }, token: 'user',
})
check('HTTP memory-health', api.status < 400 && api.body && api.body.retrieve, api.body)

db.close()
fs.rmSync(dir, { recursive: true, force: true })
console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exitCode = 1
