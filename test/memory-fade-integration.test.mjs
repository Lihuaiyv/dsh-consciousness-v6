/**
 * 内容级模糊的端到端：走 packMemoryBlock（线上同一条路），确认
 *   1) 旧记忆真的被删掉细节；
 *   2) 数据库里的原文一个字没动；
 *   3) memory.inject.fade=off 时回到原文 + 只有标签。
 *
 * 运行：node test/memory-fade-integration.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { addMemory } from '../src/modules/memory.js'
import { seedTiers } from '../src/modules/relations.js'
import { writeParam } from '../src/kernel.js'
import { packMemoryBlock } from '../index.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)) }
}

const now = () => new Date().toISOString()
const DAY = 86400000
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-fade-'))
const db = openDb(path.join(dir, 'app.db'))
const aid = 'agt_fade'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid, '小汐', 'chat', 'active', now())
seedTiers(db)

const OLD = '主人当时说「这版先放着」，后来又说了别的。'
const MID = '主人今天在改接线（那部分一直没弄完），说要先跑一遍。'
addMemory(db, aid, { text: OLD, type: 'fact' })
addMemory(db, aid, { text: MID, type: 'fact' })
db.prepare("UPDATE memory_items SET created_at=?, importance=0.4 WHERE agent_id=? AND text=?").run(new Date(Date.now() - 200 * DAY).toISOString(), aid, OLD)
db.prepare("UPDATE memory_items SET created_at=?, importance=0.4 WHERE agent_id=? AND text=?").run(new Date(Date.now() - 45 * DAY).toISOString(), aid, MID)

const rows = db.prepare('SELECT id,text,created_at,importance,type,mark FROM memory_items WHERE agent_id=? ORDER BY created_at').all(aid)
const items = rows.map((r) => ({ partition: 'T1', ...r }))

const out = packMemoryBlock(db, aid, items, 400)
check('旧记忆的原话被删掉', !out.text.includes('这版先放着'), out.text)
check('旧记忆的主干还在', out.text.includes('后来又说'), out.text)
check('半旧记忆的括号被删掉', !out.text.includes('那部分一直没弄完'), out.text)
check('半旧记忆的主干还在', out.text.includes('改接线'), out.text)
check('照样带时间标签', /（\d+ 个月前/.test(out.text), out.text)

// 数据库里的原文必须原封不动
const after = db.prepare('SELECT text FROM memory_items WHERE agent_id=? ORDER BY created_at').all(aid).map((r) => r.text)
check('库里原文没被改', after.includes(OLD) && after.includes(MID), after)

// 开关关掉：只剩标签，正文完整
writeParam(db, aid, 'memory.inject.fade', 'off')
const off = packMemoryBlock(db, aid, items, 400)
check('关掉后原话回来了', off.text.includes('这版先放着'), off.text)
check('关掉后括号也回来了', off.text.includes('那部分一直没弄完'), off.text)
check('关掉后仍有时间标签', /（\d+ 个月前/.test(off.text), off.text)

// 重要度高的不糊
writeParam(db, aid, 'memory.inject.fade', 'on')
db.prepare('UPDATE memory_items SET importance=0.9 WHERE agent_id=? AND text=?').run(aid, OLD)
const rows2 = db.prepare('SELECT id,text,created_at,importance,type,mark FROM memory_items WHERE agent_id=? ORDER BY created_at').all(aid)
const high = packMemoryBlock(db, aid, rows2.map((r) => ({ partition: 'T1', ...r })), 400)
check('重要度高的一字不删', high.text.includes('这版先放着'), high.text)

// 复习抵年龄：同一句旧事，被想起过就该糊得慢一点
{
  const Q = '主人说三周后把「那版」发出去，然后再说别的。'
  addMemory(db, aid, { text: Q, type: 'fact' })
  db.prepare("UPDATE memory_items SET created_at=?, importance=0.4 WHERE agent_id=? AND text=?").run(new Date(Date.now() - 200 * DAY).toISOString(), aid, Q)
  const load = () => db.prepare('SELECT id,text,created_at,importance,type,mark,hits,last_hit_at FROM memory_items WHERE agent_id=? AND text=?').get(aid, Q)

  const cold = packMemoryBlock(db, aid, [{ partition: 'T1', ...load() }], 400)
  check('没复习过：删到第三档', cold.lines.some((l) => l.fade === 3), cold.lines.map((l) => l.fade))

  db.prepare('UPDATE memory_items SET hits=40, last_hit_at=? WHERE agent_id=? AND text=?').run(now(), aid, Q)
  const warm = packMemoryBlock(db, aid, [{ partition: 'T1', ...load() }], 400)
  check('复习过：糊得慢一档', (warm.lines[0] || {}).fade < (cold.lines[0] || {}).fade, { cold: cold.lines[0] && cold.lines[0].fade, warm: warm.lines[0] && warm.lines[0].fade })

  writeParam(db, aid, 'memory.fade.rehearsal', 'off')
  const off = packMemoryBlock(db, aid, [{ partition: 'T1', ...load() }], 400)
  check('关掉复习抵年龄就回到第三档', off.lines[0].fade === 3, off.lines[0] && off.lines[0].fade)
  writeParam(db, aid, 'memory.fade.rehearsal', 'on')

  // max_level = 0 是「关」，不能反过来变成「最强」
  writeParam(db, aid, 'memory.fade.max_level', '0')
  const zero = packMemoryBlock(db, aid, [{ partition: 'T1', ...load() }], 400)
  check('max_level=0 等于关掉', zero.text.includes('那版'), zero.text)
  writeParam(db, aid, 'memory.fade.max_level', '3')
}

db.close()
console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exitCode = 1
