/**
 * 锚点轮转（B3）：重要的东西每轮都在，但不能每轮都是同一句。
 *
 * 以前 importanceAnchors 取的是「importance 最高的那两条」，集合恒定 →
 * 每轮注入都在复读同两句。现在第一个名额固定（身份 / 承诺该稳），
 * 其余名额挑「最久没被想起」的，靠 touch() 的 last_hit_at 自然轮转。
 *
 * 运行：node test/anchor-rotate.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { addMemory } from '../src/modules/memory.js'
import { touch } from '../src/modules/tiers.js'
import { importanceAnchors } from '../src/modules/retrieve.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)) }
}

const now = () => new Date().toISOString()
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-anchor-'))
const db = openDb(path.join(dir, 'app.db'))
const aid = 'agt_anchor_1'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid, '小汐', 'chat', 'active', now())

// 几件「该一直被记着」的事：带承诺/边界词，importance 会到 0.85
const texts = [
  '答应主人的事：周末把脚本修好。',
  '承诺过不主动提那件事。',
  '边界：不要替主人做决定。',
  '答应过每天睡前回一句。',
  '承诺记住主人怕吵。',
]
for (const t of texts) addMemory(db, aid, { text: t, type: 'fact' })
// 生产里 importance 由抽取/巩固给；测试里直接抬到锚点线上，避免依赖抽取细节
db.prepare('UPDATE memory_items SET importance=0.85 WHERE agent_id=?').run(aid)

// 钉住一条当「身份锚」，让第一个名额有确定答案
const pinned = db.prepare("SELECT id FROM memory_items WHERE agent_id=? AND text LIKE '%脚本修好%'").get(aid)
db.prepare("UPDATE memory_items SET mark='locked' WHERE id=?").run(pinned.id)

const ids = (rows) => rows.map((r) => r.id)
const a1 = importanceAnchors(db, aid, { limit: 2 })
check('拿得到两个锚点', a1.length === 2, ids(a1))
check('第一个名额是钉住的那条', a1[0].id === pinned.id, ids(a1))

// 模拟这一轮被召回：touch 把 last_hit_at 拨新
touch(db, ids(a1))
const a2 = importanceAnchors(db, aid, { limit: 2 })
check('身份锚仍然稳定', a2[0].id === pinned.id, ids(a2))
check('第二个名额换人了', a2[1].id !== a1[1].id, { before: ids(a1), after: ids(a2) })

// 连续几轮：第二个名额应该转起来，而不是钉死在一条上
const seen = new Set()
for (let i = 0; i < 4; i++) {
  const cur = importanceAnchors(db, aid, { limit: 2 })
  seen.add(cur[1].id)
  touch(db, ids(cur))
}
check('连续几轮会转到不同的条目', seen.size >= 3, [...seen])

// limit=1 只给身份锚
const one = importanceAnchors(db, aid, { limit: 1 })
check('limit=1 只给最重的一条', one.length === 1 && one[0].id === pinned.id, ids(one))

// 池子小于名额时不死循环、不报错
const a5 = importanceAnchors(db, aid, { limit: 5 })
check('要得多也不会重复', new Set(ids(a5)).size === a5.length && a5.length <= 5, ids(a5))

// 空库
const empty = importanceAnchors(db, '不存在', { limit: 2 })
check('没有锚点时返回空数组', Array.isArray(empty) && empty.length === 0)

// 低重要度的不该被当锚点
addMemory(db, aid, { text: '今天天气不错。', type: 'fact', importance: 0.2 })
db.prepare("UPDATE memory_items SET importance=0.2 WHERE agent_id=? AND text LIKE '%天气不错%'").run(aid)
const withLow = importanceAnchors(db, aid, { limit: 5 })
check('低重要度不进锚点', !ids(withLow).includes('m_low'), ids(withLow))

db.close()
console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exitCode = 1
