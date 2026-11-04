/**
 * 第 2 步：查记忆的读通路——列表带 feel、独立接口翻 feel。
 * 运行：node test/memory-feel-api.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { attachDb } from '../src/algo/index.js'
import { addMemory, listMemory, setFeelProvider } from '../src/modules/memory.js'
import { attachableFeelId } from '../src/modules/feel.js'
import { handle } from '../src/api.js'

setFeelProvider(attachableFeelId)

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name + '  ' + JSON.stringify(detail === undefined ? '' : detail).slice(0, 400)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-feelapi-'))
const db = openDb(path.join(dir, 'app.db'))
attachDb(db)
const aid = 'agt_feelapi'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid, '读通路', 'daily', 'active', new Date().toISOString())

function feel(agoMin, text) {
  const id = 'afe_a' + Math.random().toString(36).slice(2, 8)
  db.prepare('INSERT INTO affect_feel(id,agent_id,at,text,label,fast,slow,total,session_id,source) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(id, aid, new Date(Date.now() - agoMin * 60000).toISOString(), text, 'joy', 0.12, 0.2, 0.32, null, 'tool')
  return id
}

const call = (method, p) => handle(db, { method, path: p, token: 'user', body: {} })

// 1) 记忆列表带 feel 内容（批量一次查）
{
  const fid = feel(3, '带 feel 的那条')
  const m = addMemory(db, aid, { text: '这条是带着感觉写下的。', type: 'fact', source: 'extract' })
  const rows = listMemory(db, aid)
  const hit = rows.find((r) => r.id === m.id)
  check('列表带 feel_id', hit && hit.feel_id === fid, hit && hit.feel_id)
  check('列表带 feel 正文', hit && hit.feel && hit.feel.text === '带 feel 的那条', hit && hit.feel)
  check('feel 带时间与读数', hit && hit.feel && hit.feel.at && hit.feel.fast === 0.12, hit && hit.feel)
}

// 2) 没挂 feel 的条目：feel 是 null，不拿最近的顶上
{
  const m = addMemory(db, aid, { text: '这条没挂感觉（用另一个 agent 写）。', type: 'fact', source: 'manual' })
  const other = 'agt_feelapi2'
  db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
    .run(other, other, 'daily', 'active', new Date().toISOString())
  const m2 = addMemory(db, other, { text: '另一个 agent 的条目。', type: 'fact', source: 'manual' })
  const rows = listMemory(db, other)
  const hit = rows.find((r) => r.id === m2.id)
  check('没挂 feel 的条目 feel 为 null', hit && hit.feel === null, hit && hit.feel)
  check('同表里别处的 feel 不会串过来', hit && hit.feel_id == null, hit && hit.feel_id)
}

// 3) GET /memory 直接带 feel（界面不二次请求）
{
  const r = await call('GET', '/v1/agents/' + aid + '/memory')
  check('GET /memory 200', r.status === 200, r.status)
  const list = Array.isArray(r.body) ? r.body : (r.body && r.body.items) || []
  const hit = list.find((x) => x.text === '这条是带着感觉写下的。')
  check('GET /memory 里带 feel', hit && hit.feel && hit.feel.text === '带 feel 的那条', hit && hit.feel)
}

// 4) GET /feel 列表：倒序、limit 生效
{
  feel(2, '最近一条')
  feel(1, '更新的一条')
  const r = await call('GET', '/v1/agents/' + aid + '/feel?limit=2')
  check('GET /feel 200', r.status === 200, r.status)
  const items = r.body.items || []
  check('limit=2 只回两条', items.length === 2, items.length)
  check('按时间倒序（最新的在前）', items[0].text === '更新的一条' && items[1].text === '最近一条', items.map((x) => x.text))
}

// 5) GET /feel/:id 单条；不存在给 404
{
  const fid = feel(1, '单条取回')
  const r = await call('GET', '/v1/agents/' + aid + '/feel/' + fid)
  check('单条 200 且内容对', r.status === 200 && r.body.text === '单条取回', r.body)
  const miss = await call('GET', '/v1/agents/' + aid + '/feel/afe_nope')
  check('不存在返回 404', miss.status === 404, miss.status)
}

// 6) 对方 agent 的 feel 不会串（路径里的 agent 隔离）
{
  const other = 'agt_feelapi3'
  db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
    .run(other, other, 'daily', 'active', new Date().toISOString())
  const r = await call('GET', '/v1/agents/' + other + '/feel')
  check('别的 agent 看不到这条的 feel', r.status === 200 && (r.body.items || []).length === 0, r.body)
}

// 7) 记忆页热度榜（/memory/top）也带 feel——页面上「当时的感觉」就靠它
{
  const { topMemory } = await import('../src/modules/study.js')
  const top = topMemory(db, aid, { limit: 20 })
  const hit = (top.items || []).find((x) => x.text === '这条是带着感觉写下的。')
  check('topMemory 条目带 feel', hit && hit.feel && hit.feel.text === '带 feel 的那条', hit && hit.feel)
}

// 8) 时间线（/memory/timeline）同样带 feel——翻那天的记忆时也看得到
{
  const r = await call('GET', '/v1/agents/' + aid + '/memory/timeline?days=5')
  const groups = (r.body && r.body.groups) || []
  const items = groups.flatMap((g) => g.items || [])
  const hit = items.find((x) => x.text === '这条是带着感觉写下的。')
  check('timeline 条目带 feel', hit && hit.feel && hit.feel.text === '带 feel 的那条', hit && hit.feel)
}

db.close()
console.log('\n通过 ' + pass + ' / ' + (pass + fail))
if (fail) { console.log('失败:', fail); process.exit(1) }
