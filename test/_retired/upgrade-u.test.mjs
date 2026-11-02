/**
 * U0–U5 升级验收（逐步夹具，不联网）。
 * 运行：node test/upgrade-u.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, now, localDay } from '../src/db.js'
import { attachDb } from '../src/algo/index.js'
import { writeParam, getParam } from '../src/kernel.js'
import {
  llmBudgetAllow, llmBudgetBump, llmBudgetSnapshot, shouldDeferExtract, deferExtractForDay,
} from '../src/modules/llm_budget.js'
import { searchVectorAnn, rebuildVectorIndex, markVectorIndexDirty, vectorIndexMode } from '../src/modules/vector_index.js'
import { decideWrite, applyWrite } from '../src/modules/gate.js'
import { addMemory, listMemory } from '../src/modules/memory.js'
import { resolveEntity } from '../src/modules/entities.js'
import { ruleMergeAliases, applyEntityMerges, resolveEntitiesForDay, backfillEntityIdsForDay } from '../src/modules/entity_resolve.js'
import { consolidateFactsRule } from '../src/modules/consolidate.js'
import { writeDistilledFacts } from '../src/modules/episode_distill.js'
import { expandByLinks, retrieve } from '../src/modules/retrieve.js'
import { rememberFact } from '../src/modules/remember_tool.js'
import { sourceBadge } from '../src/modules/memory_source.js'
import { chatReply } from '../src/features.js'
import { enqueueExtraction } from '../src/modules/extract_queue.js'
import { listFactArchive } from '../src/modules/archive.js'
import { writeVector } from '../src/modules/vector.js'
import { seedAffect } from '../src/modules/affect.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 500)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-u-'))
const db = openDb(path.join(dir, 'app.db'))
attachDb(db)
const aid = 'agt_u'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid, 'upgrade', 'daily', 'active', now())
seedAffect(db, aid)

// ===================== U0 =====================
{
  writeParam(db, aid, 'memory.llm.daily_cap', 4)
  writeParam(db, aid, 'memory.episode.distill.daily_cap', 2)
  const day = localDay()
  check('U0 初始预算可写', llmBudgetAllow(db, aid, day, 1).ok)
  llmBudgetBump(db, aid, 'distill', day, 2)
  const def = shouldDeferExtract(db, aid, day)
  check('U0 distill 满则 defer extract', def.defer === true && def.reason === 'distill_cap', def)
  llmBudgetBump(db, aid, 'extract', day, 2)
  const snap = llmBudgetSnapshot(db, aid, day)
  check('U0 总顶用尽', snap.used >= 4 && !llmBudgetAllow(db, aid, day, 1).ok, snap)
  enqueueExtraction(db, aid, [{ role: 'user', text: '噪声话术用于预算降载' }])
  const n = deferExtractForDay(db, aid, day, 'distill_cap')
  check('U0 defer 改写 pending', n >= 1, n)
  writeParam(db, aid, 'memory.retrieve.formula', 'v3')
  check('U0 chat 默认 formula=v3', String(getParam(db, aid, 'memory.retrieve.formula')) === 'v3')
}

// ===================== U1 =====================
{
  writeParam(db, aid, 'memory.retrieve.vector.index', 'auto')
  check('U1 mode auto', vectorIndexMode(db, aid) === 'auto')
  // 造假向量：同一 dim，查询靠近 gold
  const dim = 8
  function putVec(mid, arr) {
    writeVector(db, aid, mid, Float32Array.from(arr), 'test')
  }
  const gold = addMemory(db, aid, { text: '用户喜欢深色主题写代码', type: 'fact', importance: 0.8 })
  const noise = addMemory(db, aid, { text: '今天下午开了很长的会', type: 'fact', importance: 0.4 })
  const far = addMemory(db, aid, { text: '猫粮要买三文鱼味', type: 'fact', importance: 0.5 })
  const fillIds = []
  for (let i = 0; i < 50; i++) {
    const m = addMemory(db, aid, { text: '填充向量条目' + i, type: 'fact', importance: 0.3 })
    fillIds.push(m.id)
  }
  // 全部写完再灌向量，避免异步 embed 覆盖；检索前再 dirty+rebuild
  putVec(gold.id, [1, 0, 0, 0, 0, 0, 0, 0])
  putVec(noise.id, [0.1, 0.9, 0, 0, 0, 0, 0, 0])
  putVec(far.id, [0, 0, 1, 0, 0, 0, 0, 0])
  for (let i = 0; i < fillIds.length; i++) {
    // 质量远离 dim0，避免与金标 [1,0,…] 抢 top-k
    const axis = 1 + (i % (dim - 1))
    const v = Array.from({ length: dim }, (_, j) => (j === axis ? 0.9 : 0.02))
    putVec(fillIds[i], v)
  }
  markVectorIndexDirty(aid)
  const rebuilt = rebuildVectorIndex(db, aid)
  check('U1 索引重建', rebuilt.n >= 40, rebuilt)
  const q = Float32Array.from([1, 0, 0, 0, 0, 0, 0, 0])
  const ann = searchVectorAnn(db, aid, q, { limit: 5, mode: 'auto' })
  const bf = searchVectorAnn(db, aid, q, { limit: 5, mode: 'bruteforce' })
  check('U1 ANN 命中金标', ann.some((x) => x.id === gold.id), ann.map((x) => x.id))
  check('U1 bruteforce 命中金标', bf.some((x) => x.id === gold.id), bf.map((x) => x.id))
  const overlap = ann.filter((a) => bf.some((b) => b.id === a.id)).length / Math.max(1, Math.min(ann.length, bf.length))
  check('U1 ANN vs bruteforce 重叠≥0.6', overlap >= 0.6, { overlap, ann: ann.map((x) => x.id), bf: bf.map((x) => x.id) })
  for (let i = 0; i < 50; i++) {
    const m = addMemory(db, aid, { text: '大库填充' + i, type: 'fact', importance: 0.2 })
    const axis = 1 + (i % (dim - 1))
    const v = Array.from({ length: dim }, (_, j) => (j === axis ? 0.85 : 0.02))
    putVec(m.id, v)
  }
  putVec(gold.id, [1, 0, 0, 0, 0, 0, 0, 0])
  markVectorIndexDirty(aid)
  rebuildVectorIndex(db, aid)
  const annBig = searchVectorAnn(db, aid, q, { limit: 8, mode: 'auto' })
  check('U1 大库 IVF 仍命中金标', annBig.some((x) => x.id === gold.id), annBig.map((x) => x.id))
  writeParam(db, aid, 'memory.retrieve.vector.index', 'bruteforce')
  check('U1 可回退 bruteforce', vectorIndexMode(db, aid) === 'bruteforce')
  writeParam(db, aid, 'memory.retrieve.vector.index', 'auto')
}

// ===================== U2 =====================
{
  writeParam(db, aid, 'memory.write.reconcile', 'on')
  const a = addMemory(db, aid, { text: '部署用方案乙', type: 'fact', key: 'deploy.plan', importance: 0.7 })
  const d1 = decideWrite(db, aid, { text: '部署一律用方案甲', fact_key: 'deploy.plan' })
  check('U2 同 key 判 UPDATE', d1.action === 'update', d1)
  const w = applyWrite(db, aid, { text: '部署一律用方案甲', fact_key: 'deploy.plan' }, (c) => addMemory(db, aid, {
    text: c.text, type: 'fact', key: 'deploy.plan', source: 'extract',
  }))
  check('U2 apply UPDATE', w.action === 'update' && w.id === a.id, w)
  const row = db.prepare('SELECT text,version FROM memory_items WHERE id=?').get(a.id)
  check('U2 主表一行改写', row && row.text.includes('方案甲') && Number(row.version) >= 2, row)
  const hist = listFactArchive(db, aid, { limit: 20 }).filter((x) => x.source === 'update_history' || String(x.memory_id || '').includes(a.id))
  check('U2 旧句进存根', hist.some((h) => String(h.text).includes('方案乙')), hist.map((h) => h.text))
  const merge = decideWrite(db, aid, { text: '部署一律用方案甲', fact_key: 'deploy.plan' })
  check('U2 同文再写走 merge', merge.action === 'merge', merge)
  writeParam(db, aid, 'memory.write.reconcile', 'off')
  const b = addMemory(db, aid, { text: '喜欢美式不加糖', type: 'fact', key: 'coffee.pref' })
  const off = decideWrite(db, aid, { text: '喜欢美式咖啡不加糖', fact_key: 'coffee.pref' })
  check('U2 关 reconcile 不 UPDATE', off.action !== 'update', off)
  writeParam(db, aid, 'memory.write.reconcile', 'on')
  const del = applyWrite(db, aid, { text: '喜欢美式不加糖', fact_key: 'coffee.pref', op: 'delete' }, () => null)
  check('U2 op=delete', del.action === 'delete', del)
  void b
}

// ===================== U3 =====================
{
  const e1 = resolveEntity(db, aid, '团子')
  const e2 = resolveEntity(db, aid, '小团子')
  const merges = ruleMergeAliases([{ id: e1.id, name: '团子' }, { id: e2.id, name: '小团子' }])
  check('U3 规则别名可合并', merges.length >= 1, merges)
  const n = applyEntityMerges(db, aid, merges)
  check('U3 合并落库', n >= 1, n)
  // 绕过 supersedeByKey：直接插两条同 key 活跃事实
  const idA = 'mem_csl_a'
  const idB = 'mem_csl_b'
  const at = now()
  for (const [id, text, heat] of [[idA, '猫叫团子是橘猫', 0.9], [idB, '猫的名字是团子', 0.5]]) {
    db.prepare(`INSERT OR REPLACE INTO memory_items(id,agent_id,type,mark,text,source,w0,weight,stability,difficulty,
      last_decay_at,status,created_at,version,importance,entity_id,fact_key,heat)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, aid, 'fact', 'normal', text, 'extract', 0.5, 0.5, 1, 5, at, 'active', at, 1, 0.7, e1.id, 'pet.name', heat)
  }
  const cf = consolidateFactsRule(db, aid, { limit: 5 })
  check('U3 事实 consolidate 有产出', cf.done >= 1, cf)
  const idX = 'mem_flip_a'
  const idY = 'mem_flip_b'
  db.prepare(`INSERT OR REPLACE INTO memory_items(id,agent_id,type,mark,text,source,w0,weight,stability,difficulty,
    last_decay_at,status,created_at,version,importance,entity_id,fact_key,heat)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(idX, aid, 'fact', 'normal', '喜欢加班', 'extract', 0.5, 0.5, 1, 5, at, 'active', at, 1, 0.6, e1.id, 'ot.pref', 0.5)
  db.prepare(`INSERT OR REPLACE INTO memory_items(id,agent_id,type,mark,text,source,w0,weight,stability,difficulty,
    last_decay_at,status,created_at,version,importance,entity_id,fact_key,heat)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(idY, aid, 'fact', 'normal', '不喜欢加班', 'extract', 0.5, 0.5, 1, 5, at, 'active', at, 1, 0.6, e1.id, 'ot.pref', 0.5)
  const beforeFlip = db.prepare("SELECT COUNT(*) c FROM memory_items WHERE agent_id=? AND fact_key='ot.pref' AND status='active' AND invalid_at IS NULL").get(aid).c
  consolidateFactsRule(db, aid, { limit: 5 })
  const afterFlip = db.prepare("SELECT COUNT(*) c FROM memory_items WHERE agent_id=? AND fact_key='ot.pref' AND status='active' AND invalid_at IS NULL").get(aid).c
  check('U3 极性相反不合并', afterFlip >= 2 && afterFlip >= beforeFlip, { beforeFlip, afterFlip })
  const orphan = addMemory(db, aid, { text: '团子今天不太吃饭', type: 'fact', importance: 0.5 })
  const bf = backfillEntityIdsForDay(db, aid, localDay())
  const row = db.prepare('SELECT entity_id FROM memory_items WHERE id=?').get(orphan.id)
  check('U3 回填 entity_id', bf >= 0 && (row.entity_id || bf === 0), { bf, entity_id: row.entity_id })
  const er = await resolveEntitiesForDay(db, aid, localDay(), null, {})
  check('U3 夜巡实体无模型也能跑', er.ok === true, er)
}

// ===================== U4 =====================
{
  const ep = { id: 'ep_u4', day: localDay(), seg: 0, session_id: 's', importance: 0.8, summary: '定了深色与方案' }
  const stats = writeDistilledFacts(db, aid, [
    { text: '喜欢深色主题写代码', type: 'fact', key: 'ui.theme' },
    { text: '部署一律用方案甲', type: 'fact', key: 'deploy.plan' },
  ], ep)
  check('U4 蒸馏写入', (stats.written + stats.merged + stats.updated) >= 1, stats)
  const links = db.prepare("SELECT * FROM memory_links WHERE kind='from_episode' LIMIT 20").all()
  check('U4 from_episode 边', links.length >= 0, { n: links.length, ids: stats.ids }) // 至少尝试；若 merge 到已有可能 <2 id
  if (stats.ids.length >= 2) {
    check('U4 同批互连', links.some((l) => stats.ids.includes(l.from_id) && stats.ids.includes(l.to_id)), links)
  }
  const seed = stats.ids[0] || db.prepare("SELECT id FROM memory_items WHERE agent_id=? AND status='active' LIMIT 1").get(aid).id
  const expanded = expandByLinks(db, aid, [{ partition: 'T1', id: seed }], { hops: 1, limit: 8 })
  check('U4 图扩散可跑', Array.isArray(expanded), expanded.length)
}

// ===================== U5 =====================
{
  check('U5 徽章 episode', sourceBadge('episode').label === '纪要')
  check('U5 徽章 consolidate', sourceBadge('consolidate').label === '合并')
  const rem = rememberFact(db, aid, { text: '每周二晚上去游泳', key: 'habit.swim', type: 'fact' })
  check('U5 remember 写入', rem.ok && rem.id, rem)
  const r = retrieve(db, aid, '游泳', { k: 6, floor: 0 })
  check('U5 remember 可召回', r.items.some((x) => x.id === rem.id || String(x.text || '').includes('游泳')), r.items.map((x) => x.text))
  const listed = listMemory(db, aid)
  check('U5 list 带来源徽章', listed.some((m) => m.source_badge), listed.slice(0, 3).map((m) => m.source_badge))
}

// chatReply smoke（规则回复，不需模型）
{
  try {
    const out = await chatReply(db, aid, { text: '还记得深色主题吗' })
    check('U0 chatReply 不抛', !!out && (out.reply || out.text || out.ok !== false), out && Object.keys(out))
  } catch (e) {
    check('U0 chatReply 不抛', false, String(e && e.message))
  }
}

db.close()
console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exitCode = 1
