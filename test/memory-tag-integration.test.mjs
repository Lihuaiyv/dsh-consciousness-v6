/**
 * 时间标签的端到端：真的走 retrieve → packInjection，看旧记忆会不会带上年龄。
 * 单测只证明函数对，这条证明「接线也对」——retrieve 的条目得真有 created_at。
 *
 * 运行：node test/memory-tag-integration.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { addMemory } from '../src/modules/memory.js'
import { retrieve } from '../src/modules/retrieve.js'
import { packInjection } from '../src/modules/pack.js'
import { memoryTag } from '../src/modules/memory_tag.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)) }
}

const now = () => new Date().toISOString()
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-tag-'))
const db = openDb(path.join(dir, 'app.db'))
const aid = 'agt_tag_1'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid, '小汐', 'chat', 'active', now())

addMemory(db, aid, { text: '主人说过想去看海。', type: 'fact' })
addMemory(db, aid, { text: '主人喜欢先给结论再解释。', type: 'fact' })
addMemory(db, aid, { text: '主人在改情绪和记忆的接线。', type: 'fact' })

// 把「看海」那条挪到 100 天前，模拟旧记忆
const DAY = 86400000
const old = new Date(Date.now() - 100 * DAY).toISOString()
db.prepare("UPDATE memory_items SET created_at=? WHERE agent_id=? AND text LIKE '%看海%'").run(old, aid)

const r = retrieve(db, aid, '看海', { k: 6 })
check('检索能拿回那条旧记忆', r.items.some((x) => String(x.text).includes('看海')), r.items.map((x) => x.text))
check('条目带 created_at', r.items.every((x) => !!x.created_at), r.items.map((x) => x.created_at))

const packed = packInjection({ items: r.items }, { budget: 400, decorate: (it) => memoryTag(it) })
check('旧记忆带上年龄标签', /（3 个月前，[^）]*）主人说过想去看海/.test(packed.text), packed.text)
// 今天刚写的会走「配额新近」那条路，标「今天刚发生」；关键是别再标成「个月前」
const todayLines = packed.text.split('\n').filter((l) => !l.includes('看海'))
check('今天的事不带年龄但标新近',
  todayLines.every((l) => !/个月前|天前/.test(l)) && todayLines.some((l) => l.includes('（今天刚发生）')),
  todayLines)

const noTag = packInjection({ items: r.items }, { budget: 400 })
check('关掉 decorate 就没有标签', !noTag.text.includes('个月前'), noTag.text)

db.close()
console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exitCode = 1
