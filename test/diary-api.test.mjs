/**
 * 日记 v2 · P3 API 测试（不依赖真模型）
 * 运行：node test/diary-api.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, now } from '../src/db.js'
import { attachDb } from '../src/algo/index.js'
import { handle } from '../src/api.js'
import { buildDiaryV2 } from '../src/modules/diary.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name + '  ' + JSON.stringify(detail === undefined ? '' : detail).slice(0, 400)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-diaryapi-'))
const db = openDb(path.join(dir, 'app.db'))
attachDb(db)
const DAY = '2026-11-02'
const aid = 'agt_api'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid, 'API', 'daily', 'active', now())
db.prepare(`INSERT INTO episodes(id,agent_id,session_id,day,start_at,end_at,turns,title,summary,
  topics,mood,open_loops,importance,hits,last_hit_at,source,created_at,poignancy)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,0,NULL,'rules',?,NULL)`)
  .run('ep_api', aid, 's_api', DAY, DAY + 'T10:00:00.000Z', DAY + 'T10:10:00.000Z', 6,
    '一件有点难受的事', '你说了：我有点失望。 / 我回了：我记着。', '[]', null, '["没说完的话"]', 0.5, now())

let n = 0
async function api(method, p, body = {}) {
  const out = await handle(db, { method, path: p, body: { ...body, __idempotencyKey: 'dia' + (++n) }, token: 'user' })
  return { ok: out.status === 200, status: out.status, body: out.body, code: out.body && out.body.error && out.body.error.code }
}

// 没有日记、也没有待补 → 404
{
  const r = await api('GET', `/v1/agents/${aid}/diaries/${DAY}`)
  check('GET 空日子：404', !r.ok && r.status === 404, r)
}

// 造一条待补 → GET 返回 pending 而不是 404
{
  const out = await buildDiaryV2(db, aid, DAY, { chat: null })
  check('造待补：pending', out && out.pending === true, out)
  const r = await api('GET', `/v1/agents/${aid}/diaries/${DAY}`)
  check('GET 待补日：200', r.ok, r)
  check('GET 待补日：pending=true', r.body && r.body.pending === true, r.body)
  check('GET 待补日：带 attempts', r.body && Number(r.body.attempts) >= 1, r.body)
  check('GET 待补日：带失败原因', r.body && !!r.body.fail_reason, r.body)
  const list = await api('GET', `/v1/agents/${aid}/diary/pending?days=30`)
  check('GET 待补列表：有一条', list.ok && list.body.items.length === 1 && list.body.items[0].day === DAY, list.body)
}

// 重写路由：缺 day → 400；没有材料的日子 → 404（都在模型调用之前返回）
{
  const r = await api('POST', `/v1/agents/${aid}/diaries/rewrite`, {})
  check('重写缺 day：400', !r.ok && r.status === 400, r)
  const r2 = await api('POST', `/v1/agents/${aid}/diaries/rewrite`, { day: '2026-10-01' })
  check('重写没材料：404', !r2.ok && r2.status === 404, r2)
}

// 路由存在且是 POST（GET 不该命中 rewrite）
{
  const r = await api('GET', `/v1/agents/${aid}/diaries/rewrite`)
  check('GET rewrite：不是 200（被当日记日读取，404）', !r.ok && r.status === 404, r)
}

console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exitCode = 1
