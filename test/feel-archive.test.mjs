/**
 * Phase 2：T4 事实存根带 feel_id。
 * 运行：node test/feel-archive.test.mjs
 *
 * 验证：
 *   1. fact_archive 有 feel_id 列；
 *   2. addMemory 写存根时带上记忆出生那一刻的 feel；
 *   3. GET /archive/facts 返回的存根带 feel 对象；没挂的返回 null，不拿最近的顶；
 *   4. 老存根（无 feel_id）读出来是 null，不报错；
 *   5. gate 的历史存根（<id>:hist:<n>）也带 feel_id（列形状正确）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { attachDb } from '../src/algo/index.js'
import { addMemory, setFeelProvider } from '../src/modules/memory.js'
import { attachableFeelId } from '../src/modules/feel.js'
import { listFactArchive } from '../src/modules/archive.js'
import { handle } from '../src/api.js'

setFeelProvider(attachableFeelId)

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name + '  ' + JSON.stringify(detail === undefined ? '' : detail).slice(0, 400)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-feelarch-'))
const db = openDb(path.join(dir, 'app.db'))
attachDb(db)
const aid = 'agt_feelarch'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid, '存根', 'daily', 'active', new Date().toISOString())

const cols = db.prepare("SELECT name FROM pragma_table_info('fact_archive')").all().map((r) => r.name)
check('fact_archive 有 feel_id 列', cols.includes('feel_id'), cols)

function feel(text) {
  const id = 'afe_arch' + Math.random().toString(36).slice(2, 8)
  db.prepare('INSERT INTO affect_feel(id,agent_id,at,text,label,fast,slow,total,session_id,source) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(id, aid, new Date().toISOString(), text, 'joy', 0.1, 0.2, 0.3, null, 'tool')
  return id
}

// ---------- 1. addMemory 真实路径 ----------
const fid = feel('写这条时心里挺松的')
const m = addMemory(db, aid, { text: '用户在测试存根带感觉。', type: 'fact', source: 'manual' })
const fa = db.prepare('SELECT feel_id, memory_id FROM fact_archive WHERE memory_id=?').get(m.id)
check('存根有这一条', !!fa, fa)
check('存根带记忆出生时的 feel_id', fa && fa.feel_id === fid, fa)

// ---------- 2. API 返回带 feel ----------
const call = (method, p) => handle(db, { method, path: p, token: 'user', body: {} })
{
  const r = await call('GET', '/v1/agents/' + aid + '/archive/facts?limit=50')
  check('GET /archive/facts 200', r.status === 200, r.status)
  const items = (r.body && r.body.items) || []
  const hit = items.find((x) => x.memory_id === m.id)
  check('列表项带 feel 对象', hit && hit.feel && hit.feel.text === '写这条时心里挺松的', hit && hit.feel)
  check('列表项保留 feel_id', hit && hit.feel_id === fid, hit && hit.feel_id)
}

// ---------- 3. 无 feel 的存根：null，不顶最近的 ----------
{
  const other = 'agt_feelarch2'
  db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
    .run(other, other, 'daily', 'active', new Date().toISOString())
  const m2 = addMemory(db, other, { text: '另一个 agent 的存根。', type: 'fact', source: 'manual' })
  const items = listFactArchive(db, other, { limit: 10 })
  const hit = items.find((x) => x.memory_id === m2.id)
  check('没挂 feel 的存根 feel_id 为 null', hit && hit.feel_id === null, hit && hit.feel_id)
  check('同库别处的 feel 不会串过来', hit && hit.feel_id !== fid, hit && hit.feel_id)
}

// ---------- 4. 老存根（无 feel_id）读出来是 null ----------
{
  db.prepare("INSERT INTO fact_archive(id,agent_id,memory_id,text,created_at) VALUES(?,?,?,?,?)")
    .run('fa_legacy', aid, 'mem_legacy', '老的一条存根', new Date().toISOString())
  const items = listFactArchive(db, aid, { limit: 50 })
  const legacy = items.find((x) => x.memory_id === 'mem_legacy')
  check('老存根能读出来，feel_id 为 null', legacy && legacy.feel_id === null, legacy && legacy.feel_id)
}

// ---------- 5. gate 历史存根的列形状（同一句 SQL 能写进去） ----------
{
  db.prepare(`INSERT OR IGNORE INTO fact_archive(id,agent_id,memory_id,text,type,mark,fact_key,source,payload,created_at,feel_id)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
    'hist_probe', aid, 'mem_legacy:hist:1', '旧句', 'fact', 'normal', null,
    'update_history', JSON.stringify({ at: new Date().toISOString(), actor: 'gate' }), new Date().toISOString(), fid,
  )
  const row = db.prepare('SELECT feel_id FROM fact_archive WHERE id=?').get('hist_probe')
  check('历史存根能写 feel_id', row && row.feel_id === fid, row)
}

db.close()
console.log('\n通过 ' + pass + ' / ' + (pass + fail))
if (fail) { console.log('失败:', fail); process.exit(1) }
