/**
 * 第二批展示的 API：日记 / 关系事件 / 纪要带感觉，对照默认收敛。
 * 运行：node test/feel-display-api.test.mjs
 *
 * 验证：
 *   1. GET /diaries/:day 返回 feels 数组（按 feel_ids 顺序，找不到的 id 被过滤）；
 *   2. GET /relations/events 每笔带 feel 对象；
 *   3. GET /episodes 每条带 feel 对象；
 *   4. GET /feel/compare 默认只给 stats + 3 条抽样，full=1 才给全量 pairs。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { attachDb } from '../src/algo/index.js'
import { handle } from '../src/api.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name + '  ' + JSON.stringify(detail === undefined ? '' : detail).slice(0, 400)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-feeldisp-'))
const db = openDb(path.join(dir, 'app.db'))
attachDb(db)
const aid = 'agt_feeldisp'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid, '展示', 'daily', 'active', new Date().toISOString())

const nowIso = () => new Date().toISOString()
function feel(id, text, label = 'calm') {
  db.prepare('INSERT INTO affect_feel(id,agent_id,at,text,label,fast,slow,total,session_id,source) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(id, aid, nowIso(), text, label, 0.1, 0.2, 0.3, null, 'tool')
}
const call = (p) => handle(db, { method: 'GET', path: p, token: 'user', body: {} })

feel('afe_d1', '日记里该出现的第一句')
feel('afe_d2', '日记里该出现的第二句')
feel('afe_rel', '记账那一刻有点软')

// ---------- 1. 日记 ----------
const today = new Date().toISOString().slice(0, 10)
db.prepare(`INSERT INTO diaries(id,agent_id,day,text,mood,highlights,refs,source,version,late,feel_ids,created_at,updated_at)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
  'dry_disp', aid, today, '这一天的日记正文', 'calm', '[]', '{}', 'rules', 1, 0,
  JSON.stringify(['afe_d1', 'afe_missing', 'afe_d2']), nowIso(), nowIso(),
)
{
  const r = await call('/v1/agents/' + aid + '/diaries/' + today)
  check('GET /diaries 200', r.status === 200, r.status)
  const feels = (r.body && r.body.feels) || []
  check('日记带 feels 数组', Array.isArray(feels) && feels.length === 2, feels)
  check('按 feel_ids 顺序、过滤掉不存在的 id',
    feels[0] && feels[0].id === 'afe_d1' && feels[1] && feels[1].id === 'afe_d2', feels.map((f) => f.id))
}

// ---------- 2. 关系事件 ----------
db.prepare(`INSERT INTO rel_event(id,agent_id,kind,source,session_id,turn_id,speaker_id,text,payload,at,fingerprint,created_at,feel_id)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
  'rev_disp', aid, 'utterance', 'chat', 's1', 't1', null, '小周说晚上一起吃饭', '{}',
  nowIso(), 'fp_disp', nowIso(), 'afe_rel',
)
{
  const r = await call('/v1/agents/' + aid + '/relations/events?limit=10')
  check('GET /relations/events 200', r.status === 200, r.status)
  const items = (r.body && r.body.items) || []
  const hit = items.find((x) => x.id === 'rev_disp')
  check('关系事件带 feel 对象', hit && hit.feel && hit.feel.text === '记账那一刻有点软', hit && hit.feel)
}

// ---------- 3. 纪要 ----------
db.prepare(`INSERT INTO episodes(id,agent_id,session_id,day,start_at,end_at,turns,title,summary,topics,open_loops,importance,source,feel_id,created_at)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
  'ep_disp', aid, 's1', today, nowIso(), nowIso(), 2, '带感觉的纪要', '摘要', '[]', '[]', 0.5, 'rules', 'afe_d2', nowIso(),
)
{
  const r = await call('/v1/agents/' + aid + '/episodes?limit=10')
  check('GET /episodes 200', r.status === 200, r.status)
  const items = Array.isArray(r.body) ? r.body : (r.body && r.body.items) || []
  const hit = items.find((x) => x.id === 'ep_disp')
  check('纪要带 feel 对象', hit && hit.feel && hit.feel.text === '日记里该出现的第二句', hit && hit.feel)
}

// ---------- 4. 对照默认收敛 ----------
feel('afe_cmp', '对照用的一条', 'joy')
db.prepare('INSERT INTO affect_events(id,agent_id,at,cause,label,sig,gate) VALUES(?,?,?,?,?,?,?)')
  .run('aev_disp', aid, nowIso(), 'test', 'joy', 0.5, 1)
{
  const r = await call('/v1/agents/' + aid + '/feel/compare?days=7')
  check('compare 默认 200', r.status === 200, r.status)
  check('默认 mode=trend', r.body && r.body.mode === 'trend', r.body && r.body.mode)
  check('默认只给 stats + ≤3 条抽样', r.body && r.body.stats && Array.isArray(r.body.samples) && r.body.samples.length <= 3, r.body && r.body.samples)
  const f = await call('/v1/agents/' + aid + '/feel/compare?days=7&full=1')
  check('full=1 才给全量 pairs', f.body && Array.isArray(f.body.pairs), f.body && Object.keys(f.body || {}))
}

db.close()
console.log('\n通过 ' + pass + ' / ' + (pass + fail))
if (fail) { console.log('失败:', fail); process.exit(1) }
