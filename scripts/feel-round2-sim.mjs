/**
 * 第二轮整体模拟：一轮轮走完整链路 → 导出导入 → 展示 API → 体检。
 * 用法：node scripts/feel-round2-sim.mjs
 * 输出 JSON 对比数据（报告用）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, localDay } from '../src/db.js'
import { attachDb } from '../src/algo/index.js'
import { model } from '../src/kernel.js'
import { appendTurn, buildEpisode, buildDiaryV1 } from '../src/modules/archive.js'
import { recordFeel, attachableFeelId, feelsByIds } from '../src/modules/feel.js'
import { addMemory, setFeelProvider } from '../src/modules/memory.js'
import { addLoop } from '../src/modules/loops.js'
import { observe } from '../src/modules/relations.js'
import { generateNow } from '../src/modules/thoughts.js'
import { exportFull, importFull, exportMemory, importMemory } from '../src/features.js'
import { auditStore } from '../src/modules/ops.js'
import { handle } from '../src/api.js'

setFeelProvider(attachableFeelId)

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-r2sim-'))
const db = openDb(path.join(dir, 'a.db'))
attachDb(db)
const aid = 'agt_r2'
const A = (sql, ...a) => db.prepare(sql).all(...a)
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid, '二轮', 'daily', 'active', new Date().toISOString())
db.prepare('INSERT OR REPLACE INTO agent_params(agent_id,key,value,updated_at) VALUES(?,?,?,?)')
  .run(aid, 'affect.feel.min.gap', '0', new Date().toISOString())

const out = {}
const day = localDay(new Date())
const SESSION = 'r2-session'
const re = model.complete
model.complete = async () => ''

const lines = ['今天做第二轮优化', '先修导出导入口', '再把日界改成本地日', '页面把感觉显示出来', '记忆列表要折叠重复', '对照只给趋势和抽样', '体检加 feel 引用检查', '模拟要跑整条链路', '导出要带上 feel 表', '导入要清悬空引用', '最后整体回归', '再对比数据写报告']
for (let i = 0; i < lines.length; i++) {
  const at = new Date(Date.now() - (12 - i) * 60000)
  const turnId = 'turn_r2_' + i
  appendTurn(db, aid, { sessionId: SESSION, role: 'user', text: lines[i], turnId, at: at.toISOString(), day })
  recordFeel(db, aid, { text: '第 ' + (i + 1) + ' 步写下的感觉', sessionId: SESSION, turnId, at: new Date(at.getTime() + 500).toISOString() })
  addMemory(db, aid, { text: lines[i], type: 'fact', source: 'manual' })
  appendTurn(db, aid, { sessionId: SESSION, role: 'assistant', text: '回你：' + lines[i], turnId, at: new Date(at.getTime() + 1000).toISOString(), day })
  addLoop(db, aid, { text: '关于「' + lines[i].slice(0, 4) + '」再确认一下' })
  observe(db, aid, { text: lines[i], source: 'chat', sessionId: SESSION, turnId })
}
buildEpisode(db, aid, { session: SESSION })
await generateNow(db, aid)
await buildDiaryV1(db, aid, day)
model.complete = re

const n = (sql, ...a) => Number((db.prepare(sql).get(...a) || {}).c || 0)
const feels = n('SELECT COUNT(*) c FROM affect_feel')
out.sim = {
  feel: feels,
  feel_turn: n('SELECT COUNT(*) c FROM affect_feel WHERE turn_id IS NOT NULL'),
  mem_total: n('SELECT COUNT(*) c FROM memory_items'),
  mem_feel: n('SELECT COUNT(*) c FROM memory_items WHERE feel_id IS NOT NULL'),
  mem_distinct_feel: n('SELECT COUNT(DISTINCT feel_id) c FROM memory_items WHERE feel_id IS NOT NULL'),
  fact_feel: n('SELECT COUNT(*) c FROM fact_archive WHERE feel_id IS NOT NULL'),
  ep_feel: n('SELECT COUNT(*) c FROM episodes WHERE feel_id IS NOT NULL'),
  diary_feel: n("SELECT COUNT(*) c FROM diaries WHERE feel_ids IS NOT NULL AND feel_ids<>'[]'"),
  loop_feel: n('SELECT COUNT(*) c FROM open_loops WHERE feel_id IS NOT NULL'),
  rel_feel: n('SELECT COUNT(*) c FROM rel_event WHERE feel_id IS NOT NULL'),
  thought_feel: n('SELECT COUNT(*) c FROM thoughts WHERE feel_id IS NOT NULL'),
}

// ---------- 展示 API ----------
{
  const call = (p) => handle(db, { method: 'GET', path: p, token: 'user', body: {} })
  const d = await call('/v1/agents/' + aid + '/diaries/' + day)
  const eps = await call('/v1/agents/' + aid + '/episodes?limit=10')
  const evs = await call('/v1/agents/' + aid + '/relations/events?limit=20')
  const cmp = await call('/v1/agents/' + aid + '/feel/compare?days=7')
  out.display = {
    diary_feels: ((d.body || {}).feels || []).length,
    episode_feel: (Array.isArray(eps.body) ? eps.body : []).filter((x) => x.feel).length,
    rel_event_feel: ((evs.body || {}).items || []).filter((x) => x.feel).length,
    compare_mode: (cmp.body || {}).mode,
    compare_samples: ((cmp.body || {}).samples || []).length,
    compare_same_rate: cmp.body && cmp.body.stats ? cmp.body.stats.same_rate : null,
  }
}

// ---------- 全量导出 → 导入 ----------
{
  const full = exportFull(db, aid)
  const dbB = openDb(path.join(dir, 'b.db'))
  const aidB = 'agt_r2b'
  dbB.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
    .run(aidB, '目标', 'daily', 'active', new Date().toISOString())
  attachDb(dbB)
  importFull(dbB, aidB, full)
  const feelB = Number(dbB.prepare('SELECT COUNT(*) c FROM affect_feel WHERE agent_id=?').get(aidB).c)
  const memWithFeel = dbB.prepare("SELECT feel_id FROM memory_items WHERE agent_id=? AND feel_id IS NOT NULL LIMIT 1").get(aidB)
  const ok = memWithFeel ? !!feelsByIds(dbB, [memWithFeel.feel_id]).get(memWithFeel.feel_id) : false
  out.transfer = { felt_before: feels, felt_after: feelB, ref_ok: ok }
  dbB.close()
}

// ---------- 记忆包导入 → 悬空清空 ----------
{
  const pk = exportMemory(db, aid)
  const dbC = openDb(path.join(dir, 'c.db'))
  const aidC = 'agt_r2c'
  dbC.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
    .run(aidC, '另一个', 'daily', 'active', new Date().toISOString())
  attachDb(dbC)
  importMemory(dbC, aidC, { zip_base64: pk.zip_base64 })
  const dangling = Number(dbC.prepare(`SELECT COUNT(*) c FROM memory_items m WHERE m.agent_id=? AND m.feel_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM affect_feel f WHERE f.id=m.feel_id)`).get(aidC).c)
  out.memoryPack = { imported_mem: Number(dbC.prepare('SELECT COUNT(*) c FROM memory_items WHERE agent_id=?').get(aidC).c), dangling_feel_refs: dangling }
  dbC.close()
}

// ---------- 体检 ----------
{
  const a = auditStore(db)
  const c = a.checks.find((x) => x.name === 'feel_refs')
  out.health = { feel_refs_bad: c ? c.bad : null, ok: a.ok }
}

db.close()
console.log(JSON.stringify(out, null, 2))
