/**
 * P2 写入侧测试：实体归一化 / 写入门控 / 抽取队列 / HTTP。
 * 运行：node test/p2.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, now } from '../src/db.js'
import { attachDb } from '../src/algo/index.js'
import { addMemory } from '../src/modules/memory.js'
import { extractEntityNames, resolveEntity, entityForText, listEntities, factsOfEntity } from '../src/modules/entities.js'
import { similarity, polarity, decideWrite, applyWrite, GATE, polarityFlip } from '../src/modules/gate.js'
import { enqueueExtraction, tickExtraction, queueStats, pruneQueue, retryFailed, MAX_ATTEMPTS } from '../src/modules/extract_queue.js'
import { handle } from '../src/api.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-p2-'))
const db = openDb(path.join(dir, 'app.db'))
attachDb(db)
const aid = 'agt_p2'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid, 'P2', 'daily', 'active', now())

// ---- 实体
{
  const names = extractEntityNames('我的猫叫团子，另外我在做「DSH 意识体」这个项目')
  check('抽到宠物名', names.includes('团子'), names)
  check('抽到引号里的项目名', names.some((n) => n.includes('DSH')), names)
  const a = resolveEntity(db, aid, '团子', 'pet')
  const b = resolveEntity(db, aid, '团子')
  check('同名字解析到同一个实体', a.id === b.id, { a, b })
  check('第二次不加新行', listEntities(db, aid).length === 1, listEntities(db, aid).length)
  const t = entityForText(db, aid, '团子今天不太吃饭')
  check('从句子拿到实体', t && t.name === '团子', t)
  const m = addMemory(db, aid, { text: '团子是一只橘猫', type: 'fact', entity_id: a.id })
  check('记忆能挂 entity_id', db.prepare('SELECT entity_id FROM memory_items WHERE id=?').get(m.id).entity_id === a.id)
  const facts = factsOfEntity(db, aid, a.id)
  check('按实体能翻到事实', facts.length === 1 && /橘猫/.test(facts[0].text), facts)
}

// ---- 门控
{
  check('相似度：改一个字仍很高', similarity('用户喜欢喝咖啡', '用户喜欢喝咖啡') === 1)
  check('极性：否定句为 -1', polarity('用户不喜欢喝咖啡') === -1 && polarity('用户喜欢喝咖啡') === 1)
  const base = addMemory(db, aid, { text: '用户喜欢喝美式咖啡', type: 'fact' })
  const dup = decideWrite(db, aid, { text: '用户喜欢喝美式咖啡' })
  check('同义 → 合并', dup.action === 'merge' && dup.target.id === base.id, dup)
  const flip = decideWrite(db, aid, { text: '用户不喜欢喝美式咖啡' })
  check('高相似 + 极性相反 → 冲突', flip.action === 'conflict', flip)

  // 「别」两义 + 公共片段太短：这两个都是误判来源，不许再判成冲突
  check('别的东西里的别不是否定', polarityFlip('快情绪 f现在有没有加上：喜欢的东西', '情绪这个可能是因为刚刚在优化别的东西') === false)
  check('只共享虚词尾巴不算同一件事', polarityFlip('我喜欢的东西', '别人用的东西') === false)
  check('真的否定仍然算翻转', polarityFlip('用户喜欢喝美式咖啡', '用户不喜欢喝美式咖啡') === true)
  check('别+动词仍然算否定', polarityFlip('别去那家店了', '去那家店了') === true)
  check('公共片段 ≥4 字才判', polarityFlip('用户喜欢吃辣', '用户不喜欢吃辣') === true)
  const fresh = decideWrite(db, aid, { text: '用户养了一只叫团子的橘猫' })
  check('不相干 → 新增', fresh.action === 'new', fresh)
  const short = decideWrite(db, aid, { text: '好' })
  check('太短 → 丢弃', short.action === 'drop', short)
  const noise = decideWrite(db, aid, { text: 'Time sampled 2026-10-29 ## 运行时' })
  check('运行时噪音 → 丢弃', noise.action === 'drop', noise)

  const before = db.prepare('SELECT hits,weight FROM memory_items WHERE id=?').get(base.id)
  const out = applyWrite(db, aid, { text: '用户喜欢喝美式咖啡' }, (c) => addMemory(db, aid, { text: c.text }))
  const after = db.prepare('SELECT hits,weight FROM memory_items WHERE id=?').get(base.id)
  check('合并会强化而不是新增', out.action === 'merge' && Number(after.hits) === Number(before.hits) + 1, { out, before, after })
  check('合并后条数没变多', db.prepare("SELECT COUNT(*) n FROM memory_items WHERE agent_id=? AND text LIKE '%美式咖啡%'").get(aid).n === 1)

  const created = applyWrite(db, aid, { text: '用户住在杭州西湖边' }, (c) => addMemory(db, aid, { text: c.text }))
  check('门控放行新增', created.action === 'new' && !!created.id, created)
}

// ---- 抽取队列
{
  const t = [{ role: 'user', text: '我今天去跑了五公里' }, { role: 'assistant', text: '厉害' }]
  const a = enqueueExtraction(db, aid, t)
  const b = enqueueExtraction(db, aid, t)
  check('入队成功', a && a.duplicate === false, a)
  check('同一批不重复入队', b.duplicate === true && b.id === a.id, b)
  check('空批次不入队', enqueueExtraction(db, aid, []) === null)

  let calls = 0
  const ok = await tickExtraction(db, aid, async (turns) => { calls++; return { n: turns.length } }, { max: 1 })
  check('worker 跑掉一批', ok.length === 1 && ok[0].ok === true && calls === 1, ok)
  check('跑完标 done', queueStats(db, aid).done === 1, queueStats(db, aid))

  const t2 = [{ role: 'user', text: '明天要早起体检' }]
  enqueueExtraction(db, aid, t2)
  const bad = await tickExtraction(db, aid, async () => { throw new Error('模型挂了') }, { max: 1 })
  check('失败不算跑完', bad.length === 1 && bad[0].ok === false, bad)
  const st = queueStats(db, aid)
  check('失败后回到 pending 等重试', st.pending === 1, st)
  const row = db.prepare("SELECT attempts,next_at,last_error FROM extract_queue WHERE state='pending'").get()
  check('记了次数与退避时间', Number(row.attempts) === 1 && !!row.next_at && /模型挂了/.test(row.last_error), row)

  // 立即到期 → 连跑到失败上限
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    db.prepare("UPDATE extract_queue SET next_at=? WHERE state='pending'").run(new Date(Date.now() - 1000).toISOString())
    await tickExtraction(db, aid, async () => { throw new Error('还是挂') }, { max: 1 })
  }
  check('到上限标 failed', queueStats(db, aid).failed === 1, queueStats(db, aid))
  check('可以手动重试', retryFailed(db, aid) === 1 && queueStats(db, aid).pending === 1, queueStats(db, aid))

  db.prepare("UPDATE extract_queue SET updated_at=? WHERE state IN ('done','failed')").run(new Date(Date.now() - 10 * 86400000).toISOString())
  check('清理旧记录', pruneQueue(db, aid, 7) >= 1)
}

// ---- HTTP
{
  let n = 0
  const api = async (method, p, body = {}) => {
    const out = await handle(db, { method, path: p, body: { ...body, __idempotencyKey: 'p2' + (++n) }, token: 'user' })
    return out.body
  }
  const ents = await api('GET', `/v1/agents/${aid}/entities`)
  check('HTTP 实体列表', Array.isArray(ents.items) && ents.items.length >= 1, ents.items && ents.items.length)
  const q = await api('GET', `/v1/agents/${aid}/extract-queue`)
  check('HTTP 队列统计', q && typeof q.pending === 'number', q)
}

console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exitCode = 1
