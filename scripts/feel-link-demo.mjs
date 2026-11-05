/**
 * 整体模拟：一轮轮走完整链路，看 feel 现在能连到多少地方。
 * 用法：node scripts/feel-link-demo.mjs
 * 输出一份 JSON 统计（覆盖率）——报告用它对比「改动前 / 改动后」。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { attachDb } from '../src/algo/index.js'
import { model } from '../src/kernel.js'
import { appendTurn, buildEpisode, buildDiaryV1 } from '../src/modules/archive.js'
import { recordFeel, listFeels } from '../src/modules/feel.js'
import { addMemory, setFeelProvider } from '../src/modules/memory.js'
import { attachableFeelId } from '../src/modules/feel.js'
import { addLoop } from '../src/modules/loops.js'
import { observe } from '../src/modules/relations.js'
import { generateNow } from '../src/modules/thoughts.js'

setFeelProvider(attachableFeelId)

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-feeldemo-'))
const db = openDb(path.join(dir, 'app.db'))
attachDb(db)
const aid = 'agt_demo'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid, '演示', 'daily', 'active', new Date().toISOString())
db.prepare('INSERT OR REPLACE INTO agent_params(agent_id,key,value,updated_at) VALUES(?,?,?,?)')
  .run(aid, 'affect.feel.min.gap', '0', new Date().toISOString())

const day = new Date().toISOString().slice(0, 10)
const SESSION = 'demo-session'
const realComplete = model.complete
model.complete = async () => ''

let turns = 0
for (let i = 0; i < 10; i++) {
  const turnId = 'turn_demo_' + i
  const userText = ['今天在改记忆的连接', '有几句感觉想留下来', '存根那边也要能看见', '日记翻到时带着原话', '开环挂着的时候是什么心情', '关系账上也记一笔', '嘀咕的时候接着写', '纪要的时段里取一条', '最后按感觉能找回来', '这样连起来才像一条线'][i]
  appendTurn(db, aid, { sessionId: SESSION, role: 'user', text: userText, turnId, at: new Date(Date.now() - (10 - i) * 60000).toISOString(), day })
  recordFeel(db, aid, { text: '第 ' + (i + 1) + ' 轮写下的感觉', sessionId: SESSION, turnId, at: new Date(Date.now() - (10 - i) * 60000 + 1000).toISOString() })
  addMemory(db, aid, { text: userText, type: 'fact', source: 'manual' })
  appendTurn(db, aid, { sessionId: SESSION, role: 'assistant', text: '回你一句：' + userText, turnId, at: new Date(Date.now() - (10 - i) * 60000 + 2000).toISOString(), day })
  addLoop(db, aid, { text: '关于「' + userText.slice(0, 6) + '」还要再确认' })
  observe(db, aid, { text: userText, source: 'chat', sessionId: SESSION, turnId })
  turns++
}
buildEpisode(db, aid, { session: SESSION })
await generateNow(db, aid)
await buildDiaryV1(db, aid, day)
model.complete = realComplete

const n = (sql, ...a) => (db.prepare(sql).get(...a) || {}).c || 0
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0)
const out = {
  feel_total: n('SELECT COUNT(*) c FROM affect_feel'),
  feel_with_turn: n('SELECT COUNT(*) c FROM affect_feel WHERE turn_id IS NOT NULL'),
  memories: n('SELECT COUNT(*) c FROM memory_items'),
  memories_with_feel: n('SELECT COUNT(*) c FROM memory_items WHERE feel_id IS NOT NULL'),
  facts: n('SELECT COUNT(*) c FROM fact_archive'),
  facts_with_feel: n('SELECT COUNT(*) c FROM fact_archive WHERE feel_id IS NOT NULL'),
  episodes: n('SELECT COUNT(*) c FROM episodes'),
  episodes_with_feel: n('SELECT COUNT(*) c FROM episodes WHERE feel_id IS NOT NULL'),
  diaries: n('SELECT COUNT(*) c FROM diaries'),
  diaries_with_feel: n("SELECT COUNT(*) c FROM diaries WHERE feel_ids IS NOT NULL AND feel_ids<>'[]'"),
  loops: n('SELECT COUNT(*) c FROM open_loops'),
  loops_with_feel: n('SELECT COUNT(*) c FROM open_loops WHERE feel_id IS NOT NULL'),
  rel_events: n('SELECT COUNT(*) c FROM rel_event'),
  rel_events_with_feel: n('SELECT COUNT(*) c FROM rel_event WHERE feel_id IS NOT NULL'),
  thoughts: n('SELECT COUNT(*) c FROM thoughts'),
  thoughts_with_feel: n('SELECT COUNT(*) c FROM thoughts WHERE feel_id IS NOT NULL'),
}
out.coverage = {
  feel_turn: pct(out.feel_with_turn, out.feel_total),
  memory: pct(out.memories_with_feel, out.memories),
  fact: pct(out.facts_with_feel, out.facts),
  episode: pct(out.episodes_with_feel, out.episodes),
  diary: pct(out.diaries_with_feel, out.diaries),
  loop: pct(out.loops_with_feel, out.loops),
  rel_event: pct(out.rel_events_with_feel, out.rel_events),
  thought: pct(out.thoughts_with_feel, out.thoughts),
}
// feel 列表里的 around 是否按轮对上了
const list = listFeels(db, aid, { limit: 20 })
out.around_ok = list.filter((x) => x.around && x.around.user).length
out.turns = turns
db.close()
console.log(JSON.stringify(out, null, 2))
