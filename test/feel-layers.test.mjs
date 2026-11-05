/**
 * Phase 3：叙述层带感觉——开环 / 纪要 / 日记 / 嘀咕。
 * 运行：node test/feel-layers.test.mjs
 *
 * 验证：
 *   1. open_loops 挂上时带 30 分钟窗口内最近一条 feel_id；
 *   2. episodes 取该时段内最近一条 feel_id（更新分支也不丢）；
 *   3. diaries 存当天所有 feel id（JSON 数组）；
 *   4. thoughts 挂最近一条 feel_id；
 *   5. 没有感觉时都是 null / []，不报错、不拿旧感觉凑。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { attachDb } from '../src/algo/index.js'
import { model } from '../src/kernel.js'
import { addLoop } from '../src/modules/loops.js'
import { buildEpisode, buildDiaryV1, listEpisodes, getDiary } from '../src/modules/archive.js'
import { generateNow } from '../src/modules/thoughts.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name + '  ' + JSON.stringify(detail === undefined ? '' : detail).slice(0, 400)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-feellayers-'))
const db = openDb(path.join(dir, 'app.db'))
attachDb(db)
const aid = 'agt_feellayers'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid, '层', 'daily', 'active', new Date().toISOString())

const now = () => new Date().toISOString()
function feel(text, offsetMin = 0) {
  const id = 'afe_lay' + Math.random().toString(36).slice(2, 8)
  db.prepare('INSERT INTO affect_feel(id,agent_id,at,text,label,fast,slow,total,session_id,source) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(id, aid, new Date(Date.now() + offsetMin * 60000).toISOString(), text, 'calm', 0.1, 0.2, 0.3, null, 'tool')
  return id
}

// ---------- 1. open_loops ----------
{
  const fid = feel('挂着这件事的时候心里有点悬', -5)
  const lp = addLoop(db, aid, { text: '回头要跟他确认一下边界' })
  const row = db.prepare('SELECT feel_id FROM open_loops WHERE id=?').get(lp.id)
  check('开环带窗口内最近的 feel_id', row && row.feel_id === fid, row)

  // 窗口外（两小时前）的感觉不认——换一个新实例，避免窗口内的正常 feel 干扰
  const other = 'agt_feellayers_old'
  db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
    .run(other, other, 'daily', 'active', new Date().toISOString())
  db.prepare('INSERT INTO affect_feel(id,agent_id,at,text,label,fast,slow,total,session_id,source) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run('afe_old_2h', other, new Date(Date.now() - 120 * 60000).toISOString(), '两小时前的感觉', null, null, null, null, null, 'tool')
  const lp2 = addLoop(db, other, { text: '隔了很久才想起来的事' })
  const row2 = db.prepare('SELECT feel_id FROM open_loops WHERE id=?').get(lp2.id)
  check('开环不拿窗口外的旧感觉凑', row2 && row2.feel_id === null, row2)
}

// ---------- 2. episodes ----------
{
  const fid = feel('这会儿聊得挺专注的', -20)
  const day = now().slice(0, 10)
  db.prepare('INSERT INTO raw_turns(id,agent_id,session_id,turn_id,seq,role,text,tool,meta,created_at,day) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run('raw_lay_u', aid, 'sess_lay', 'turnLay', 1, 'user', '今天我们聊了纪要带感觉这件事', null, null, new Date(Date.now() - 25 * 60000).toISOString(), day)
  db.prepare('INSERT INTO raw_turns(id,agent_id,session_id,turn_id,seq,role,text,tool,meta,created_at,day) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run('raw_lay_a', aid, 'sess_lay', 'turnLay', 2, 'assistant', '嗯，写进去之后翻纪要就能看见。', null, null, new Date(Date.now() - 18 * 60000).toISOString(), day)
  const ep = buildEpisode(db, aid, { session: 'sess_lay' })
  check('纪要带时段内最近的 feel_id', ep && ep.feel_id === fid, ep && ep.feel_id)
  const row = db.prepare('SELECT feel_id FROM episodes WHERE id=?').get(ep.id)
  check('纪要落库带 feel_id', row && row.feel_id === fid, row)
  // 更新分支：再跑一次不丢
  const ep2 = buildEpisode(db, aid, { session: 'sess_lay' })
  const row2 = db.prepare('SELECT feel_id FROM episodes WHERE id=?').get(ep2.id)
  check('纪要更新分支也保留 feel_id', row2 && row2.feel_id === fid, row2)
}

// ---------- 3. diaries ----------
{
  const f1 = feel('早上那会儿很轻', -60)
  const f2 = feel('中午心里有点紧', -10)
  const day = now().slice(0, 10)
  const d = await buildDiaryV1(db, aid, day)
  check('日记写得出来', !!d && !!d.id, d && d.id)
  const row = db.prepare('SELECT feel_ids FROM diaries WHERE agent_id=? AND day=?').get(aid, day)
  let ids = []
  try { ids = JSON.parse(row && row.feel_ids || '[]') } catch { ids = [] }
  check('日记带当天全部 feel id', Array.isArray(ids) && ids.includes(f1) && ids.includes(f2), ids)
  const got = getDiary(db, aid, day)
  check('读日记时 feel_ids 字段也在', got && typeof got.feel_ids === 'string', got && got.feel_ids)
}

// ---------- 4. thoughts ----------
{
  const fid = feel('心里有点想说话', -3)
  const realComplete = model.complete
  model.complete = async () => ''
  const view = await generateNow(db, aid)
  model.complete = realComplete
  check('嘀咕生成成功', !!(view && view.items && view.items.length), view && view.updated_at)
  const row = db.prepare('SELECT feel_id FROM thoughts WHERE agent_id=? ORDER BY created_at DESC LIMIT 1').get(aid)
  check('嘀咕带最近的 feel_id', row && row.feel_id === fid, row)
}

// ---------- 5. 没有感觉的情况 ----------
{
  const other = 'agt_feellayers2'
  db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
    .run(other, other, 'daily', 'active', new Date().toISOString())
  const lp = addLoop(db, other, { text: '新实例的第一件悬着的事' })
  const row = db.prepare('SELECT feel_id FROM open_loops WHERE id=?').get(lp.id)
  check('没感觉的实例：开环 feel_id 为 null', row && row.feel_id === null, row)
  const empty = getDiary(db, other, now().slice(0, 10))
  check('没写日记时 getDiary 返回 null', empty === null, empty)
}

db.close()
console.log('\n通过 ' + pass + ' / ' + (pass + fail))
if (fail) { console.log('失败:', fail); process.exit(1) }
