/**
 * 阶段 C：把时间说出来。
 *
 * 要保证：
 *   1) 非槽位旧条目（反思 / 情景 / 评价）超过三天 → 带一句「记下的判断，不是说现在」；
 *   2) 三天以内不贴（刚说完的事还新鲜，贴了是噪音）；
 *   3) 槽位（fact）走原来的更新分支，不被 statement 抢；
 *   4) 参数 off 时不贴；
 *   5) T2 纪要带 created_at（memoryTag 才能贴年龄）；
 *   6) T3 日记正文前带 day。
 *
 * 运行：node test/passport-statement.test.mjs
 */
import { makeWorld } from './eval-persona/setup.mjs'
import { addMemory } from '../src/modules/memory.js'
import { passportLine } from '../src/modules/passport.js'
import { searchEpisodes, searchDiaries } from '../src/modules/retrieve.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) } else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)) }
}
const daysAgo = (d) => new Date(Date.now() - d * 86400000).toISOString()
const rowOf = (w, id) => w.db.prepare('SELECT * FROM memory_items WHERE id=?').get(id)

/** 把一条记忆的「说话时间」改到 N 天前（说话时间优先取 timeline 的 ADD.valid_from）。 */
function backdate(w, id, days) {
  const t = daysAgo(days)
  w.db.prepare('UPDATE memory_items SET created_at=? WHERE id=?').run(t, id)
  try {
    w.db.prepare("UPDATE memory_timeline SET valid_from=?, at=? WHERE agent_id=? AND memory_id=? AND op='ADD'").run(t, t, w.aid, id)
  } catch { /* 老库没有 timeline */ }
}

// ① 非槽位旧条目：超过三天贴一句
{
  const w = makeWorld()
  try {
    const m = addMemory(w.db, w.aid, { text: '我想明白了：它反不反应不是重点，我在不在才是', type: 'reflection' })
    backdate(w, m.id, 10)
    const line = passportLine(w.db, w.aid, rowOf(w, m.id))
    check('旧反思带「记下的判断」', line.includes('记下的判断') && line.includes('不是说现在'), line)
    check('旧反思带日期', /\d{2}-\d{2}/.test(line), line)
  } finally { w.close() }
}

// ② 三天以内不贴
{
  const w = makeWorld()
  try {
    const m = addMemory(w.db, w.aid, { text: '今天想了一下：先把手头这件事做完再说', type: 'reflection' })
    backdate(w, m.id, 1)
    check('一天前的反思不贴', passportLine(w.db, w.aid, rowOf(w, m.id)) === '', passportLine(w.db, w.aid, rowOf(w, m.id)))
    backdate(w, m.id, 5)
    check('五天前的反思要贴', passportLine(w.db, w.aid, rowOf(w, m.id)).includes('记下的判断'))
  } finally { w.close() }
}

// ③ 槽位不被 statement 抢：fact 有 key 时走原分支
{
  const w = makeWorld()
  try {
    const a = addMemory(w.db, w.aid, { text: '咖啡的偏好还没定下来，等之后再说', type: 'fact', fact_key: '用户.咖啡.偏好' })
    backdate(w, a.id, 10)
    const b = addMemory(w.db, w.aid, { text: '咖啡的偏好已经定下来了', type: 'fact', fact_key: '用户.咖啡.偏好' })
    w.db.prepare('UPDATE memory_items SET invalid_at=NULL, superseded_by=NULL WHERE id=?').run(a.id)
    backdate(w, a.id, 10)
    const line = passportLine(w.db, w.aid, rowOf(w, a.id))
    check('槽位走「有更新的说法」', line.includes('有更新的说法'), line)
    check('槽位不贴「记下的判断」', !line.includes('记下的判断'), line)
  } finally { w.close() }
}

// ④ 参数 off 时不贴
{
  const w = makeWorld()
  try {
    const m = addMemory(w.db, w.aid, { text: '一条十天后该带时间的自省', type: 'reflection' })
    backdate(w, m.id, 10)
    check('statement=on 会贴', passportLine(w.db, w.aid, rowOf(w, m.id), { statement: 'on' }).includes('记下的判断'))
    check('statement=off 不贴', passportLine(w.db, w.aid, rowOf(w, m.id), { statement: 'off' }) === '', passportLine(w.db, w.aid, rowOf(w, m.id), { statement: 'off' }))
  } finally { w.close() }
}

// ⑤ T2 纪要带 created_at + 正文带 day
{
  const w = makeWorld()
  try {
    const today = new Date().toISOString().slice(0, 10)
    w.db.prepare(`INSERT INTO episodes(id,agent_id,session_id,day,start_at,end_at,turns,title,summary,topics,open_loops,source,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('ep_c1', w.aid, 's_c1', today, daysAgo(1), daysAgo(0), 6, '记忆时态', '聊了怎么判新旧', '["记忆"]', '[]', 'rules', daysAgo(0))
    const got = searchEpisodes(w.db, w.aid, '记忆时态')
    check('T2 命中', got.length >= 1, got)
    const it = got[0]
    check('T2 带 created_at', !!it.created_at && it.created_at.startsWith(today), it)
    check('T2 正文带 day', String(it.text).includes(today), it.text)
  } finally { w.close() }
}

// ⑥ T3 日记正文前带 day
{
  const w = makeWorld()
  try {
    const today = new Date().toISOString().slice(0, 10)
    w.db.prepare(`INSERT INTO diaries(id,agent_id,day,text,mood,highlights,refs,source,version,late,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run('dy_c1', w.aid, today, '今天把时间线理顺了，心里松一点', '', '[]', '[]', 'model', 1, 0, daysAgo(0), daysAgo(0))
    const got = searchDiaries(w.db, w.aid, '时间线理顺')
    check('T3 命中', got.length >= 1, got)
    const it = got[0]
    check('T3 正文带 day', String(it.text).startsWith(today), it.text)
    check('T3 带 created_at', !!it.created_at && it.created_at.startsWith(today), it)
  } finally { w.close() }
}

console.log('\n' + pass + ' passed, ' + fail + ' failed')
if (fail) process.exitCode = 1
