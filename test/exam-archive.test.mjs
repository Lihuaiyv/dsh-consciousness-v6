/**
 * 归档零件 · 考卷
 *
 * 管的是「只增不减的那几本底账」：T4 原文（raw_turns）、FA 事实出生照（fact_archive）、
 * T2 纪要（episodes）、T3 日记的读口，以及两个索引的重建。
 *
 * 不管「一条记忆怎么写进抽屉」（记忆存储）、不管「变淡」（冷暖）、不管「怎么召回」（召回）。
 *
 * 运行：node test/exam-archive.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import {
  appendTurn, listRaw, searchRaw, listSessions, archiveFact, listFactArchive,
  searchFactArchive, buildEpisode, listEpisodes, getDiary, recentDiaryLines,
  rebuildRawFts, rebuildFactFts,
} from '../src/modules/archive.js'
import { setEpisodePoignancy } from '../src/modules/episode_fields.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-exam-arc-'))
const db = openDb(path.join(dir, 'app.db'))
const aid = 'agt_exam_arc'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid, '考卷归档', 'daily', 'active', new Date().toISOString())

const count = (sql, ...args) => Number(db.prepare(sql).get(...args).n)
const iso = (ms) => new Date(ms).toISOString()

// ================================================================ T4 原文：只追加，按轮去重
{
  check('空文本：不写', appendTurn(db, aid, { text: '  ' }).id === null)
  const a = appendTurn(db, aid, { sessionId: 's1', role: 'user', text: '今天想去看海，可以吗？', turnId: 't1', at: iso(Date.now()) })
  check('写入：拿到 id / seq=1', !!a.id && a.seq === 1 && a.duplicate === false, a)
  const row = db.prepare('SELECT * FROM raw_turns WHERE id=?').get(a.id)
  check('原文行：角色 / 会话 / 正文 / 轮次', row && row.role === 'user' && row.session_id === 's1' && row.turn_id === 't1' && row.text.includes('看海'), row)
  check('原文索引也写了一条', count('SELECT COUNT(*) n FROM raw_fts WHERE id=?', a.id) === 1)

  const dup = appendTurn(db, aid, { sessionId: 's1', role: 'user', text: '换一句不同的', turnId: 't1' })
  check('同一轮同一角色：重放不新建', dup.duplicate === true && dup.id === a.id, dup)

  const b = appendTurn(db, aid, { sessionId: 's1', role: 'assistant', text: '去吧，带件外套。', turnId: 't1', at: iso(Date.now()) })
  check('同一轮换角色：是新的一条', b.duplicate === false && b.id !== a.id, b)
  check('seq 递增', b.seq === 2, b)

  const near = appendTurn(db, aid, { sessionId: 's2', role: 'user', text: '嗯', at: iso(Date.now()) })
  const near2 = appendTurn(db, aid, { sessionId: 's2', role: 'user', text: '嗯', at: iso(Date.now() + 1000) })
  check('没轮次号：三秒内同句算重放', near2.duplicate === true && near2.id === near.id, { near, near2 })
  const later = appendTurn(db, aid, { sessionId: 's2', role: 'user', text: '嗯', at: iso(Date.now() + 5000) })
  check('超过三秒：新的一条', later.duplicate === false && later.id !== near.id, later)

  const raw = listRaw(db, aid, { session: 's1' })
  check('按会话能取回两条', raw.length === 2 && raw.every((r) => r.session_id === 's1'), raw.length)
  const hits = searchRaw(db, aid, '看海', 5)
  check('原文检索：找得到', hits.length >= 1 && hits.some((r) => String(r.text).includes('看海')), hits)
  const sessions = listSessions(db, aid)
  check('会话列表：s1 / s2 都在', sessions.some((s) => s.session_id === 's1') && sessions.some((s) => s.session_id === 's2'), sessions)
}

// ================================================================ FA 事实出生照：一条出生照只拍一次
{
  check('缺 id 或正文：不拍', archiveFact(db, aid, { text: '有字没 id' }).id === null)
  const f = archiveFact(db, aid, { memory_id: 'mem_a', text: '主人喝咖啡只喝美式。', type: 'fact', importance: 0.7, feel_id: 'afe_1' })
  check('拍成功：拿到 id', !!f.id && f.duplicate === false, f)
  const row = db.prepare('SELECT * FROM fact_archive WHERE id=?').get(f.id)
  check('出生照：正文 / 类型 / 重要度 / feel', row && row.text.includes('美式') && row.type === 'fact' && Number(row.importance) === 0.7 && row.feel_id === 'afe_1', row)
  check('事实索引也写了一条', count('SELECT COUNT(*) n FROM fact_fts WHERE id=?', f.id) === 1)
  const dup = archiveFact(db, aid, { memory_id: 'mem_a', text: '换一句' })
  check('同一条记忆再拍：返回旧的，不新建', dup.duplicate === true && dup.id === f.id, dup)
  const list = listFactArchive(db, aid)
  check('出生照列表能取到', list.some((r) => r.id === f.id), list.length)
  const hits = searchFactArchive(db, aid, '美式', 5)
  check('出生照检索：找得到', hits.length >= 1, hits)
}

// ================================================================ T2 纪要：从原文压一条，重复跑是更新不是新建
{
  const ep = buildEpisode(db, aid, { session: 's1' })
  check('压出纪要：拿到 id / 标题', ep && !!ep.id && String(ep.title || '').length > 0, ep)
  check('纪要带你对我说的 / 我对你说的', String(ep.summary || '').includes('你对我说：') && String(ep.summary || '').includes('我对你说：'), ep && ep.summary)
  check('纪要记下轮数', ep.turns === 2, ep && ep.turns)
  const again = buildEpisode(db, aid, { session: 's1' })
  check('再压一次：更新同一条，不新建', again.updated === true && again.id === ep.id, again)
  check('纪要列表里只有一条', listEpisodes(db, aid).filter((e) => e.session_id === 's1').length === 1)
  check('没给 day / session：抛错', (() => { try { buildEpisode(db, aid, {}); return false } catch { return true } })())
  setEpisodePoignancy(db, aid, ep.id, 0.66)
  check('窄写口：只改戳心度这一列', Number(db.prepare('SELECT poignancy FROM episodes WHERE id=?').get(ep.id).poignancy) === 0.66)
}

// ================================================================ T2 纪要：末尾带上「那会儿我留了一句」
// 那半句不是规则挑的、也不是模型编的，是当时她自己写的第一人称一行（feel）。
// 这几条盯的就是：该带的时候带上，不该带的时候一句都不许塞。
{
  const base = Date.parse('2026-03-05T10:00:00.000Z')
  const at = (s) => new Date(base + s * 1000).toISOString()
  const feel = (id, text, when) => db.prepare(
    'INSERT INTO affect_feel(id,agent_id,at,text,label,fast,slow,total) VALUES(?,?,?,?,?,?,?,?)')
    .run(id, aid, when, text, 'calm', 0.1, 0.1, 0.2)

  appendTurn(db, aid, { sessionId: 's_feel', role: 'user', text: '你说我们能记住多少', at: at(0) })
  appendTurn(db, aid, { sessionId: 's_feel', role: 'assistant', text: '我记着的那些，都是我自己挑的。', at: at(10) })
  feel('afe_t1', '手心有点热，想再多说两句。', at(5))
  const epFeel = buildEpisode(db, aid, { session: 's_feel' })
  check('纪要带上那会儿我留的那句', String(epFeel.summary || '').includes('那会儿我留了一句：手心有点热'), epFeel && epFeel.summary)
  check('纪要挂上这条 feel 的 id', epFeel.feel_id === 'afe_t1', epFeel && epFeel.feel_id)

  // 窗口之外的感觉：不许拿来凑
  appendTurn(db, aid, { sessionId: 's_feel_out', role: 'user', text: '早上的事', at: at(100) })
  feel('afe_out', '早上那会儿还没睡醒。', at(900))
  const epOut = buildEpisode(db, aid, { session: 's_feel_out' })
  check('窗口外的感觉不硬塞进纪要', !String(epOut.summary || '').includes('那会儿我留了一句'), epOut && epOut.summary)

  // 太长：不写
  appendTurn(db, aid, { sessionId: 's_feel_long', role: 'user', text: '一句话', at: at(200) })
  feel('afe_long', '这句太长了'.repeat(20), at(205))
  const epLong = buildEpisode(db, aid, { session: 's_feel_long' })
  check('感觉行太长：不写进纪要', !String(epLong.summary || '').includes('那会儿我留了一句'), epLong && epLong.summary)

  // 带内联代码：不写
  appendTurn(db, aid, { sessionId: 's_feel_code', role: 'user', text: '一句话', at: at(300) })
  feel('afe_code', '看了下 `ls` 的输出，没别的', at(305))
  const epCode = buildEpisode(db, aid, { session: 's_feel_code' })
  check('感觉行带代码：不写进纪要', !String(epCode.summary || '').includes('那会儿我留了一句'), epCode && epCode.summary)
}

// ================================================================ T3 日记：读口
{
  const day = new Date().toISOString().slice(0, 10)
  db.prepare(`INSERT INTO diaries(id,agent_id,day,text,mood,highlights,refs,source,version,late,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run('dry_exam_1', aid, day, '改到半夜\n今天陪他改了一整天，到晚上脑子是木的。', 'calm', null, null, 'model', 1, 0, iso(Date.now()), iso(Date.now()))
  const d = getDiary(db, aid, day)
  check('按天取到日记', d && String(d.text).includes('脑子是木的'), d)
  check('不存在的天：没有', getDiary(db, aid, '2000-01-01') === null)
  const lines = recentDiaryLines(db, aid, 3, 200)
  check('最近几天能压成行', Array.isArray(lines) && lines.some((l) => String(l).includes('脑子是木的')), lines)
}

// ================================================================ 索引重建：删了能补回来
{
  db.exec('DELETE FROM raw_fts')
  check('清掉原文索引', count('SELECT COUNT(*) n FROM raw_fts') === 0)
  rebuildRawFts(db)
  const rawN = count('SELECT COUNT(*) n FROM raw_turns WHERE agent_id=?', aid)
  check('重建后条数对得上', count('SELECT COUNT(*) n FROM raw_fts') === rawN, { rawN })

  db.exec('DELETE FROM fact_fts')
  rebuildFactFts(db)
  const faN = count('SELECT COUNT(*) n FROM fact_archive WHERE agent_id=?', aid)
  check('事实索引重建：条数对得上', count('SELECT COUNT(*) n FROM fact_fts') === faN, { faN })
}

console.log('\n通过 ' + pass + ' / ' + (pass + fail))
if (fail) process.exitCode = 1
