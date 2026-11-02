/**
 * 阶段 0：记忆溯源链。
 *
 * 以前 raw_turns.turn_id 全是空的、memory_items.source_turn_id 一条都 join 不上，
 * 所以「你上次说过什么」只有正文，没有出处。这里验证整条链：
 *   captureTurn 生成 turn_id → 入队保留 → ingest 取出 → addMemory 存下 → 能 join 回原话。
 *
 * 运行：node test/turn-id.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { addMemory } from '../src/modules/memory.js'
import { seedTiers } from '../src/modules/relations.js'
import { appendTurn, backfillTurnIds } from '../src/modules/archive.js'
import { enqueueExtraction, makeTurnId, pickBatchTurnId } from '../src/modules/extract_queue.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)) }
}

const now = () => new Date().toISOString()
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-turnid-'))
const db = openDb(path.join(dir, 'app.db'))
const aid = 'agt_turnid'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid, '小汐', 'chat', 'active', now())
seedTiers(db)

// ---- turn_id 生成
{
  const ids = new Set()
  for (let i = 0; i < 300; i++) ids.add(makeTurnId())
  check('makeTurnId 300 次不重复', ids.size === 300, ids.size)
  check('makeTurnId 带 turn_ 前缀', makeTurnId().startsWith('turn_'))
  check('makeTurnId 两轮之间有区分', makeTurnId() !== makeTurnId())
}

// ---- 从一批 turns 里取 turn_id
{
  check('pickBatchTurnId 取最后一条带 id 的', pickBatchTurnId([{ turnId: 'a' }, { turnId: 'b' }]) === 'b')
  check('pickBatchTurnId 跳过没有 id 的', pickBatchTurnId([{ turnId: 'a' }, { role: 'user' }]) === 'a')
  check('pickBatchTurnId 空数组为 null', pickBatchTurnId([]) === null)
  check('pickBatchTurnId 全无 id 为 null', pickBatchTurnId([{ role: 'user' }, { role: 'assistant' }]) === null)
}

// ---- 入队不丢 turnId
const tid = makeTurnId()
{
  const q = enqueueExtraction(db, aid, [
    { role: 'user', text: '主人今天在改接线，说要先跑一遍', turnId: tid },
    { role: 'assistant', text: '好，跑完告诉你', turnId: tid },
  ])
  check('入队成功', !!q && q.duplicate === false, q)
  const row = db.prepare('SELECT turns FROM extract_queue WHERE id=?').get(q.id)
  const turns = JSON.parse(row.turns)
  check('队列里保留了 turnId', turns[0].turnId === tid && turns[1].turnId === tid, turns)
  check('同一批取得到 turnId', pickBatchTurnId(turns) === tid)
}

// ---- 原文落库带 turn_id
{
  const res = appendTurn(db, aid, { sessionId: 'sess1', role: 'user', text: '主人今天在改接线，说要先跑一遍', turnId: tid, at: now() })
  check('appendTurn 写入成功', !!res.id, res)
  const row = db.prepare('SELECT turn_id FROM raw_turns WHERE id=?').get(res.id)
  check('raw_turns.turn_id 不再是空', row.turn_id === tid, row)
}

// ---- 记忆存下 turn_id，并且能 join 回原话
{
  const mem = addMemory(db, aid, { text: '主人在改接线，准备先跑一遍', type: 'fact', turn_id: tid })
  check('addMemory 返回 id', !!mem && !!mem.id, mem)
  const row = db.prepare('SELECT source_turn_id FROM memory_items WHERE id=?').get(mem.id)
  check('memory_items.source_turn_id 存下了', row.source_turn_id === tid, row)

  const joined = db.prepare(
    'SELECT r.text FROM memory_items m JOIN raw_turns r ON r.turn_id = m.source_turn_id WHERE m.id=?',
  ).all(mem.id)
  check('能 join 回原话', joined.length >= 1 && joined[0].text.includes('改接线'), joined)
}

// ---- 没带 turn_id 时不该编一个出来
{
  const mem = addMemory(db, aid, { text: '用户喜欢手冲咖啡', type: 'fact' })
  const row = db.prepare('SELECT source_turn_id FROM memory_items WHERE id=?').get(mem.id)
  check('没传就留空，不瞎编', row.source_turn_id == null || row.source_turn_id === '', row)
}

// ---- 库里原文必须是原样（溯源不能改正文）
{
  const txt = db.prepare('SELECT text FROM raw_turns WHERE turn_id=?').get(tid)
  check('原文一个字没动', txt && txt.text === '主人今天在改接线，说要先跑一遍', txt)
}

// ---- 历史回溯：已有的原话配成「一轮」
{
  const t = (n) => new Date(Date.now() - n * 60000).toISOString()
  appendTurn(db, aid, { sessionId: 'bf', role: 'user', text: '历史第一句', at: t(50) })
  appendTurn(db, aid, { sessionId: 'bf', role: 'assistant', text: '历史第一句的回复', at: t(49) })
  appendTurn(db, aid, { sessionId: 'bf', role: 'user', text: '历史第二句', at: t(48) })
  appendTurn(db, aid, { sessionId: 'bf', role: 'user', text: '历史第三句连着说', at: t(47) })

  const n = backfillTurnIds(db, aid)
  check('回溯补了行', n >= 4, n)
  const rows = db.prepare("SELECT role,seq,turn_id FROM raw_turns WHERE session_id='bf' ORDER BY seq").all()
  check('user + 紧邻 assistant 共用一轮', rows[0].turn_id === rows[1].turn_id, rows.slice(0, 2))
  check('连续两条 user 不并成一轮', rows[2].turn_id !== rows[3].turn_id, rows.slice(2, 4))
  check('补上后没有空 turn_id',
    db.prepare("SELECT COUNT(*) n FROM raw_turns WHERE agent_id=? AND (turn_id IS NULL OR turn_id='')").get(aid).n === 0)
  const again = backfillTurnIds(db, aid)
  check('重复跑不重复改', again === 0, again)
}

db.close()
console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exitCode = 1
