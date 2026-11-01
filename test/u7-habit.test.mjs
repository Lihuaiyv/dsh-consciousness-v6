/**
 * U7：长尾习惯稳进 T1（不从日记抽事实）。
 * 运行：node test/u7-habit.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, now, localDay } from '../src/db.js'
import { writeParam } from '../src/kernel.js'
import { addMemory, isHabitText, habitImportanceFloor, habitFactKey } from '../src/modules/memory.js'
import { retrieve } from '../src/modules/retrieve.js'
import { appendTurn, buildDiary } from '../src/modules/archive.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-u7-'))
const db = openDb(path.join(dir, 'app.db'))
const aid = 'agt_u7'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid, 'u7', 'daily', 'active', now())

{
  check('识别每周习惯', isHabitText('我最近开始学游泳，每周两次'))
  check('喜欢≠每周习惯', !isHabitText('我喜欢喝美式咖啡，不加糖'))
  check('重要度地板', habitImportanceFloor('每周二晚上去游泳', 0.5) >= 0.72)
  check('非习惯不抬', habitImportanceFloor('今天天气不错', 0.5) === 0.5)
  check('自动 fact_key', /^habit\./.test(habitFactKey('每周二晚上去游泳', null)))
}

{
  const m = addMemory(db, aid, { text: '我最近开始学游泳，每周两次', type: 'fact', source: 'extract' })
  const row = db.prepare('SELECT importance,fact_key,heat FROM memory_items WHERE id=?').get(m.id)
  check('写入抬重要度', Number(row.importance) >= 0.72, row)
  check('写入打 habit key', String(row.fact_key || '').startsWith('habit.'), row)
  const r = retrieve(db, aid, '游泳', { k: 6, scene: 'S1', noUpgrade: true })
  check('S1 能召回习惯', r.items.some((x) => x.id === m.id), r.items.map((x) => x.text))
}

{
  const cold = addMemory(db, aid, {
    text: '每周三晚上去健身房练腿', type: 'fact', source: 'extract',
  })
  db.prepare("UPDATE memory_items SET temp_state='cold', state_since=? WHERE id=?").run(now(), cold.id)
  writeParam(db, aid, 'memory.retrieve.habit_cold', 'on')
  const hit = retrieve(db, aid, '健身房', { k: 6, scene: 'S1', noUpgrade: true })
  check('冷习惯字面命中可进 S1', hit.items.some((x) => x.id === cold.id), hit.items.map((x) => x.text))
  const miss = retrieve(db, aid, '量子色动力学', { k: 6, scene: 'S1', noUpgrade: true })
  check('冷习惯无关查询不穿透', !miss.items.some((x) => x.id === cold.id), miss.items.map((x) => x.text))
  writeParam(db, aid, 'memory.retrieve.habit_cold', 'off')
  const off = retrieve(db, aid, '健身房', { k: 6, scene: 'S1', noUpgrade: true })
  check('关参后冷习惯不进 S1', !off.items.some((x) => x.id === cold.id), off.items.map((x) => x.text))
  writeParam(db, aid, 'memory.retrieve.habit_cold', 'on')
}

{
  // 日记是文学投影：buildDiary 不得增产 T1 事实
  const day = localDay()
  appendTurn(db, aid, { sessionId: 's_u7', role: 'user', text: '今天去游泳了，感觉不错' })
  appendTurn(db, aid, { sessionId: 's_u7', role: 'assistant', text: '加油' })
  const before = db.prepare("SELECT COUNT(*) n FROM memory_items WHERE agent_id=? AND status='active'").get(aid).n
  await buildDiary(db, aid, day)
  const after = db.prepare("SELECT COUNT(*) n FROM memory_items WHERE agent_id=? AND status='active'").get(aid).n
  check('日记生成不增产事实', after === before, { before, after })
}

db.close()
fs.rmSync(dir, { recursive: true, force: true })
console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exitCode = 1
