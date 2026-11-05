/**
 * Phase 5：感觉检索 + 感觉/事件对照。
 * 运行：node test/feel-search.test.mjs
 *
 * 验证：
 *   1. 按 label 找 feel，同时带上同时段记忆和当天日记；
 *   2. 按时间范围过滤；
 *   3. 感觉 ↔ 情绪事件对照：找得到紧随其后的事件、标签一致率算得对、没有事件的是 null；
 *   4. GET /feel/search 与 /feel/compare 路由可用；
 *   5. feel_search 工具能注册并执行。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { attachDb } from '../src/algo/index.js'
import { addMemory } from '../src/modules/memory.js'
import { feelRecall, feelEventContrast } from '../src/modules/feel.js'
import { handle } from '../src/api.js'
import { createActionTools } from '../src/modules/actions/index.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name + '  ' + JSON.stringify(detail === undefined ? '' : detail).slice(0, 400)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-feelsearch-'))
const db = openDb(path.join(dir, 'app.db'))
attachDb(db)
const aid = 'agt_feelsearch'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid, '找', 'daily', 'active', new Date().toISOString())

function feel(label, text, offsetMin = 0) {
  const id = 'afe_fs' + Math.random().toString(36).slice(2, 8)
  db.prepare('INSERT INTO affect_feel(id,agent_id,at,text,label,fast,slow,total,session_id,source) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(id, aid, new Date(Date.now() + offsetMin * 60000).toISOString(), text, label, 0.1, 0.2, 0.3, null, 'tool')
  return id
}
function event(label, offsetMin = 0, sig = 0.5) {
  const id = 'aev_' + Math.random().toString(36).slice(2, 8)
  db.prepare('INSERT INTO affect_events(id,agent_id,at,cause,label,sig,gate) VALUES(?,?,?,?,?,?,?)')
    .run(id, aid, new Date(Date.now() + offsetMin * 60000).toISOString(), 'test', label, sig, 1)
  return id
}

// ---------- 1. 按 label 找 + 带记忆 / 日记 ----------
{
  const fid = feel('joy', '这会儿是真的很开心', -10)
  addMemory(db, aid, { text: '主人今天夸了我一句', type: 'fact', source: 'manual' })
  const day = new Date().toISOString().slice(0, 10)
  db.prepare(`INSERT INTO diaries(id,agent_id,day,text,mood,highlights,refs,source,version,late,feel_ids,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('dry_fs', aid, day, '今天挺开心的。', 'joy', '[]', '{}', 'rules', 1, 0, JSON.stringify([fid]), new Date().toISOString(), new Date().toISOString())
  const out = feelRecall(db, aid, { label: 'joy' })
  const hit = out.find((x) => x.feel.id === fid)
  check('按 label 找到那条感觉', !!hit, out.map((x) => x.feel.id))
  check('带上同时段记忆', hit && hit.memories.some((m) => m.text.includes('夸了我一句')), hit && hit.memories)
  check('带上当天日记', hit && hit.diary && hit.diary.day === day, hit && hit.diary)
}

// ---------- 2. 时间范围过滤 ----------
{
  feel('curious', '很久以前的好奇', -60 * 24 * 3)
  const from = new Date(Date.now() - 3600000).toISOString()
  const out = feelRecall(db, aid, { from })
  check('时间范围外的感觉不出现', !out.some((x) => x.feel.text === '很久以前的好奇'), out.map((x) => x.feel.text))
}

// ---------- 3. 感觉 ↔ 事件对照 ----------
{
  const f1 = feel('joy', '先说这条有事件的', -20)
  const e1 = event('joy', -15, 0.6)
  const f2 = feel('calm', '这条后面没有事件', -5)
  const out = feelEventContrast(db, aid, { days: 30, limit: 50 })
  const p1 = out.pairs.find((p) => p.feel_id === f1)
  const p2 = out.pairs.find((p) => p.feel_id === f2)
  check('找到紧随其后的事件', p1 && p1.event_id === e1, p1)
  check('标签一致判定正确', p1 && p1.same_label === true, p1)
  check('没有事件的感觉 event_id 为 null', p2 && p2.event_id === null, p2)
  check('统计只算有事件的', out.stats.with_event >= 1 && out.stats.same_label >= 1, out.stats)
}

// ---------- 4. API 路由 ----------
{
  const call = (p) => handle(db, { method: 'GET', path: p, token: 'user', body: {} })
  const r1 = await call('/v1/agents/' + aid + '/feel/search?label=joy')
  check('GET /feel/search 200', r1.status === 200, r1.status)
  check('search 返回 items', r1.body && Array.isArray(r1.body.items), r1.body && typeof r1.body.items)
  const r2 = await call('/v1/agents/' + aid + '/feel/compare?days=30')
  check('GET /feel/compare 200', r2.status === 200, r2.status)
  check('compare 返回 stats', r2.body && r2.body.stats && typeof r2.body.stats.same_rate !== 'undefined', r2.body && r2.body.stats)
}

// ---------- 5. 工具注册 ----------
{
  const tools = createActionTools({
    getDb: () => db,
    getAgentId: () => aid,
    getAgentIdForSession: () => aid,
    getWeb: () => null,
    getModel: () => null,
    gateSearch: () => ({ allowed: true }),
  })
  const t = tools.find((x) => x.name === 'feel_search')
  check('feel_search 工具已注册', !!t, tools.map((x) => x.name))
  const v = await t.execute({ label: 'joy' })
  check('工具能执行并返回 items', v && Array.isArray(v.items) && v.items.length >= 1, v)
}

db.close()
console.log('\n通过 ' + pass + ' / ' + (pass + fail))
if (fail) { console.log('失败:', fail); process.exit(1) }
