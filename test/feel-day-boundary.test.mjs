/**
 * P3：日界——本地日 vs UTC 日。
 * 运行：node test/feel-day-boundary.test.mjs
 *
 * 验证：
 *   1. feelRecall 找当天日记用本地日历日（凌晨 0-8 点也能找到）；
 *   2. buildDiaryV1 按本地日的时间边界取 raw_turns / 记忆（不再拿本地日去对 UTC 的 day 字段）；
 *   3. fetchSceneLines 取场景原话不再依赖 raw_turns.day（created_at 范围已足够）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, localDay } from '../src/db.js'
import { attachDb } from '../src/algo/index.js'
import { recordFeel, feelRecall } from '../src/modules/feel.js'
import { buildDiaryV1, appendTurn } from '../src/modules/archive.js'
import { fetchSceneLines } from '../src/modules/diary.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name + '  ' + JSON.stringify(detail === undefined ? '' : detail).slice(0, 400)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-feelday-'))
const db = openDb(path.join(dir, 'app.db'))
attachDb(db)
const aid = 'agt_feelday'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid, '日界', 'daily', 'active', new Date().toISOString())

// 本地凌晨 01:30 —— 在北京时区，UTC 还是前一天
const dawn = new Date()
dawn.setHours(1, 30, 0, 0)
const localD = localDay(dawn)
const utcD = dawn.toISOString().slice(0, 10)
const couldDiffer = localD !== utcD
console.log((couldDiffer ? '' : '[提示] 当前时区本地日与 UTC 日相同，凌晨差异用例在这里不会触发；其余断言照跑。'))

// ---------- 1. feelRecall 用本地日找日记 ----------
{
  db.prepare('INSERT INTO affect_feel(id,agent_id,at,text,label,fast,slow,total,session_id,source) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run('afe_dawn', aid, dawn.toISOString(), '凌晨写下的感觉', 'calm', null, null, null, null, 'tool')
  db.prepare(`INSERT INTO diaries(id,agent_id,day,text,mood,highlights,refs,source,version,late,feel_ids,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('dry_dawn', aid, localD, '凌晨那天的日记', 'calm', '[]', '{}', 'rules', 1, 0, '[]', new Date().toISOString(), new Date().toISOString())
  const out = feelRecall(db, aid, { from: new Date(dawn.getTime() - 60000).toISOString(), to: new Date(dawn.getTime() + 60000).toISOString() })
  const hit = out.find((x) => x.feel.id === 'afe_dawn')
  check('凌晨的 feel 能配到本地那天的日记', hit && hit.diary && hit.diary.day === localD, hit && hit.diary)
  if (couldDiffer) {
    check('（对照）UTC 日确实不是本地日', utcD !== localD, { utcD, localD })
  }
}

// ---------- 2. buildDiaryV1 按时间边界取 raw（raw_turns.day 故意写成 UTC 日）----------
{
  const at = dawn.toISOString()
  db.prepare('INSERT INTO raw_turns(id,agent_id,session_id,turn_id,seq,role,text,tool,meta,created_at,day) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run('raw_dawn_u', aid, 'sess_dawn', 'turn_dawn', 1, 'user', '凌晨这一句要进日记', null, null, at, utcD)
  db.prepare('INSERT INTO raw_turns(id,agent_id,session_id,turn_id,seq,role,text,tool,meta,created_at,day) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run('raw_dawn_a', aid, 'sess_dawn', 'turn_dawn', 2, 'assistant', '凌晨回的这一句也是', null, null, at, utcD)
  const d = await buildDiaryV1(db, aid, localD, { force: true })
  check('buildDiaryV1 用本地日能拿到凌晨的原文', !!d, d)
  check('日记的 day 是本地日', d && d.day === localD, d && d.day)
  if (couldDiffer) {
    check('（对照）raw_turns.day 是 UTC 日，与本地日不同', utcD !== localD, { utcD, localD })
  }
}

// ---------- 3. fetchSceneLines 不再依赖 raw_turns.day ----------
{
  db.prepare(`INSERT INTO episodes(id,agent_id,session_id,day,start_at,end_at,turns,title,summary,topics,open_loops,importance,source,feel_id,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    'ep_dawn', aid, 'sess_dawn', utcD, new Date(dawn.getTime() - 60000).toISOString(), new Date(dawn.getTime() + 60000).toISOString(),
    2, '凌晨那一段', '摘要', '[]', '[]', 0.5, 'rules', null, new Date().toISOString(),
  )
  const got = fetchSceneLines(db, aid, {
    kind: 'ep', id: 'ep_dawn', session_id: 'sess_dawn', day: utcD,
    start_at: new Date(dawn.getTime() - 60000).toISOString(),
    end_at: new Date(dawn.getTime() + 60000).toISOString(),
    summary: '摘要',
  }, { rawPerScene: 800, rawMaxTurns: 10 })
  check('场景原话取得到（不靠 day 字段）', got && got.turns >= 1, got && got.turns)
}

db.close()
console.log('\n通过 ' + pass + ' / ' + (pass + fail))
if (fail) { console.log('失败:', fail); process.exit(1) }
