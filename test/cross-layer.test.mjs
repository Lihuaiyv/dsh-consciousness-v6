/**
 * S2 跨库失效测试：
 *   A. T2 纪要里有更晚的同主题记录 → 旧记忆护照标「后来在纪要里聊到」；
 *   B. 换会话时今天早些时候的纪要能带出来；刚聊完的不重复；
 *   C. 只读：不 touch。
 *
 * 运行：node test/cross-layer.test.mjs
 */
import { makeWorld } from './eval-persona/setup.mjs'
import { addMemory } from '../src/modules/memory.js'
import { passportLine } from '../src/modules/passport.js'
import { sessionBridge } from '../src/modules/archive.js'
import { packMemoryBlock } from '../index.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) } else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)) }
}

function putEpisode(db, aid, id, day, endAt, summary, openLoops = '[]') {
  db.prepare(`INSERT INTO episodes(id,agent_id,session_id,day,start_at,end_at,turns,title,summary,topics,open_loops,source,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, aid, 's_' + id, day, endAt, endAt, 4, '测试', summary, '["测试"]', openLoops, 'rules', new Date().toISOString())
}

// A. T2 纪要交叉
{
  const w = makeWorld()
  try {
    w.db.prepare('DELETE FROM memory_items WHERE agent_id=?').run(w.aid)
    const old = addMemory(w.db, w.aid, { text: '用户有一个「情绪快照」的事还没做完', type: 'fact', fact_key: '用户.情绪快照.待完成' })
    w.db.prepare('UPDATE memory_items SET created_at=? WHERE id=?').run(new Date(Date.now() - 3 * 3600000).toISOString(), old.id)
    const today = new Date().toISOString().slice(0, 10)
    putEpisode(w.db, w.aid, 'ep_cross', today, new Date(Date.now() - 1 * 3600000).toISOString(), '记忆能不能自己浮上来这事已经验证过了，能浮上来了')
    // 注意：smary 里没有「情绪快照」；this test needs topic in summary
    w.db.prepare("UPDATE episodes SET summary=? WHERE id='ep_cross'").run('情绪快照已经做好了，还做了点别的')
    const row = w.db.prepare('SELECT * FROM memory_items WHERE id=?').get(old.id)
    const line = passportLine(w.db, w.aid, row)
    check('T2 纪要交叉：标出后来聊到', line.includes('纪要里聊到') && line.includes('情绪快照'), line)
    const packed = packMemoryBlock(w.db, w.aid, [{ ...row, partition: 'T1' }], 400)
    check('检索块里有跨库护照', packed.text.includes('纪要里聊到'), packed.text)
  } finally { w.close() }
}

// A2. T3 日记交叉
{
  const w = makeWorld()
  try {
    w.db.prepare('DELETE FROM memory_items WHERE agent_id=?').run(w.aid)
    const old = addMemory(w.db, w.aid, { text: '用户有一个「情绪快照」的事还没做完', type: 'fact', fact_key: '用户.情绪快照.待完成' })
    w.db.prepare('UPDATE memory_items SET created_at=? WHERE id=?').run(new Date(Date.now() - 3 * 3600000).toISOString(), old.id)
    const today = new Date().toISOString().slice(0, 10)
    w.db.prepare(`INSERT INTO diaries(id,agent_id,day,text,mood,highlights,refs,source,version,late,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run('dry_cross_' + w.aid, w.aid, today, '今天把情绪快照弄好了，心里松了一下。', 'calm', null, null, 'model', 1, 0, new Date().toISOString(), new Date().toISOString())
    const row = w.db.prepare('SELECT * FROM memory_items WHERE id=?').get(old.id)
    const line = passportLine(w.db, w.aid, row)
    check('T3 日记交叉：标出后来写到', line.includes('日记里写到') && line.includes('情绪快照'), line)
  } finally { w.close() }
}

// A3. T4 原话交叉（topic 需 ≥3 字）
{
  const w = makeWorld()
  try {
    w.db.prepare('DELETE FROM memory_items WHERE agent_id=?').run(w.aid)
    const old = addMemory(w.db, w.aid, { text: '用户有个「情绪快照」的事还没做完', type: 'fact', fact_key: '用户.情绪快照.待完成' })
    w.db.prepare('UPDATE memory_items SET created_at=? WHERE id=?').run(new Date(Date.now() - 3 * 3600000).toISOString(), old.id)
    w.db.prepare(`INSERT INTO raw_turns(id,agent_id,session_id,turn_id,seq,role,text,tool,meta,created_at,day)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run('rt_cross_' + w.aid, w.aid, 's1', 't1', 1, 'user', '情绪快照已经弄好了，你看一下', null, null, new Date().toISOString(), new Date().toISOString().slice(0, 10))
    const row = w.db.prepare('SELECT * FROM memory_items WHERE id=?').get(old.id)
    const line = passportLine(w.db, w.aid, row)
    check('T4 原话交叉：标出后来提过', line.includes('后来你提过') && line.includes('情绪快照'), line)
  } finally { w.close() }
}

// B. bridge allowToday
{
  const w = makeWorld()
  try {
    const today = new Date().toISOString().slice(0, 10)
    putEpisode(w.db, w.aid, 'ep_today', today, new Date(Date.now() - 3 * 3600000).toISOString(), '今天早些时候聊了记忆浮现，已经能浮上来了')
    const b = sessionBridge(w.db, w.aid, { allowToday: true })
    check('今天早些时候也带', b.includes('今天早些时候') && b.includes('能浮上来'), b)
    const b2 = sessionBridge(w.db, w.aid, { allowToday: true, gapMin: 300 })
    check('间隔不够就不带', !b2.includes('今天早些时候'), b2)
    const b3 = sessionBridge(w.db, w.aid, { today: '2026-03-01' })
    check('显式 today 保持旧行为', b3 === '' || b3.includes('上次'), b3)
    // 不再把散场前那串问话当「还没收尾的」念出来：它没有 id、没法关，念一次就是一笔假账
    putEpisode(w.db, w.aid, 'ep_loops', '2026-03-01', new Date(Date.now() - 3 * 3600000).toISOString(),
      '聊到零件和温度', JSON.stringify(['待立表是什么？不是删了吗？', '还得等温度查完是吗？']))
    const b4 = sessionBridge(w.db, w.aid, { today: '2026-03-02' })
    check('带上纪要', b4.includes('零件和温度'), b4)
    check('不再念「还没收尾的」', !b4.includes('还没收尾') && !b4.includes('待立表'), b4)
  } finally { w.close() }
}

// C. 只读
{
  const w = makeWorld()
  try {
    const before = w.db.prepare('SELECT id, hits FROM memory_items WHERE agent_id=? ORDER BY id').all(w.aid)
    const row = w.db.prepare('SELECT * FROM memory_items WHERE agent_id=? LIMIT 1').get(w.aid)
    if (row) passportLine(w.db, w.aid, row)
    const after = w.db.prepare('SELECT id, hits FROM memory_items WHERE agent_id=? ORDER BY id').all(w.aid)
    check('跨库护照不加热记忆', JSON.stringify(before) === JSON.stringify(after), { before, after })
  } finally { w.close() }
}

console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exitCode = 1
