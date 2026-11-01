/**
 * U0–U5 统一模拟：预算互斥、UPDATE、实体、蒸馏召回、remember。
 * 用法：node scripts/sim-upgrade-u.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, now } from '../src/db.js'
import { attachDb } from '../src/algo/index.js'
import { appendTurn, buildEpisodes, listFactArchive } from '../src/modules/archive.js'
import { runNightly, localDay } from '../src/modules/nightly.js'
import { retrieve } from '../src/modules/retrieve.js'
import { writeParam } from '../src/kernel.js'
import { llmBudgetSnapshot, shouldDeferExtract } from '../src/modules/llm_budget.js'
import { applyWrite } from '../src/modules/gate.js'
import { addMemory } from '../src/modules/memory.js'
import { rememberFact } from '../src/modules/remember_tool.js'
import { rebuildVectorIndex, searchVectorAnn } from '../src/modules/vector_index.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-simu-'))
const db = openDb(path.join(dir, 'app.db'))
attachDb(db)
const aid = 'agt_simu'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid, 'simu', 'daily', 'active', now())

writeParam(db, aid, 'memory.llm.daily_cap', 8)
writeParam(db, aid, 'memory.episode.distill', 'on')
writeParam(db, aid, 'memory.episode.distill.daily_cap', 3)
writeParam(db, aid, 'memory.write.reconcile', 'on')
writeParam(db, aid, 'memory.entity.resolve', 'on')
writeParam(db, aid, 'memory.consolidate.facts', 'on')
writeParam(db, aid, 'memory.retrieve.formula', 'v3')

const day = localDay()
const script = [
  '记住：部署一律用方案甲。',
  '我喜欢深色主题写代码。',
  '我的猫叫团子。',
  '团子是橘猫。',
  '每周二晚上去游泳。',
]
for (const t of script) {
  appendTurn(db, aid, { sessionId: 's1', role: 'user', text: t, at: now() })
  appendTurn(db, aid, { sessionId: 's1', role: 'assistant', text: '嗯，记下了。', at: now() })
}
await buildEpisodes(db, aid, { day, session: 's1' })

const extract = async (msgs) => {
  const blob = JSON.stringify(msgs || [])
  const out = []
  if (/方案甲/.test(blob)) out.push({ text: '部署一律用方案甲', type: 'fact', key: 'deploy.plan', op: 'add' })
  if (/深色/.test(blob)) out.push({ text: '喜欢深色主题写代码', type: 'fact', key: 'ui.theme' })
  if (/团子/.test(blob)) out.push({ text: '猫叫团子', type: 'fact', key: 'pet.name' })
  if (/游泳/.test(blob)) out.push({ text: '每周二晚上去游泳', type: 'fact', key: 'habit.swim' })
  return out.length ? out : [{ text: '用户在推进当前话题', type: 'appraisal' }]
}

const night = await runNightly(db, aid, {
  day, force: true, extract, summarize: null, merge: true,
})
console.log('nightly steps', night.steps.map((s) => s.step + ':' + (s.ok === false ? 'FAIL' : 'ok')).join(', '))

// U2 改写
applyWrite(db, aid, { text: '部署改用方案甲并冻结乙', fact_key: 'deploy.plan' }, (c) => addMemory(db, aid, {
  text: c.text, type: 'fact', key: 'deploy.plan', source: 'extract',
}))

rememberFact(db, aid, { text: '界面也要深色', key: 'ui.theme', op: 'update' })

const budget = llmBudgetSnapshot(db, aid, day)
const defer = shouldDeferExtract(db, aid, day)
console.log('budget', budget)
console.log('defer_extract', defer.defer, defer.reason)

const probes = ['方案甲', '深色', '团子', '游泳']
let hit = 0
for (const p of probes) {
  const r = retrieve(db, aid, p, { k: 6, floor: 0 })
  const ok = r.items.some((x) => String(x.text || '').includes(p))
  if (ok) hit++
  console.log(ok ? 'HIT' : 'MISS', p, r.items.slice(0, 2).map((x) => x.text))
}

const hist = listFactArchive(db, aid, { limit: 50 }).filter((x) => x.source === 'update_history')
const links = db.prepare('SELECT kind, COUNT(*) n FROM memory_links GROUP BY kind').all()
const facts = db.prepare("SELECT COUNT(*) n FROM memory_items WHERE agent_id=? AND type='fact' AND status='active' AND invalid_at IS NULL").get(aid).n

console.log('\n--- summary ---')
console.log('recall', hit + '/' + probes.length)
console.log('update_history', hist.length)
console.log('links', links)
console.log('active_facts', facts)
console.log('entity_resolve', night.steps.find((s) => s.step === 'entity_resolve'))
console.log('episode_distill', night.steps.find((s) => s.step === 'episode_distill'))

db.close()
if (hit < probes.length) process.exitCode = 1
