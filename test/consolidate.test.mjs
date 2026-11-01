/**
 * 记忆整理（consolidate）：用模型把重复的自省合并成一条。
 * 运行：node test/consolidate.test.mjs
 *
 * 这里用替身模型（不联网），验的是「拼装 — 合并 — 退场」这条链：
 *   - 同义的一批 → 写一条合并稿，旧的那几条 invalid_at + superseded_by 指向它；
 *   - 模型说没价值（keep:false）→ 整批软删退场（不写合并稿）；
 *   - 模型返回解析不了 → 一条都不动；
 *   - 默认召回（S1）不见旧条目，深查（S3）还看得到、标 stale。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { model } from '../src/kernel.js'
import { addMemory } from '../src/modules/memory.js'
import { retrieve } from '../src/modules/retrieve.js'
import { planBatches, consolidatePending, mergeBatch } from '../src/modules/consolidate.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-csl-'))
const db = openDb(path.join(dir, 'app.db'))
const aid = 'agt_csl'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid, 'csl', 'daily', 'active', new Date().toISOString())

const realComplete = model.complete
const realCaps = model.capabilities
let calls = 0
// 替身：脚本里没有宿主模型，能力位也得一起打开
model.capabilities = () => ({ ...(realCaps ? realCaps.call(model) : {}), complete: true })
function stub(reply) {
  model.complete = async () => { calls++; return typeof reply === 'function' ? reply(calls) : reply }
}

// 四条几乎一样的自省 + 一条无关的
const ids = [
  addMemory(db, aid, { text: '用户在这段对话中只说了“继续”，没有透露可验证的个人事实，偏好推进当前任务。', type: 'reflection' }),
  addMemory(db, aid, { text: '用户在对话中只说了“继续”，未提供新的个人信息，希望助手接着推进当前任务。', type: 'reflection' }),
  addMemory(db, aid, { text: '用户只说了“继续”，没有透露身份或背景，倾向让助手延续当前任务。', type: 'reflection' }),
  addMemory(db, aid, { text: '这段对话里用户只说了继续，没有提供个人信息，希望继续当前任务。', type: 'reflection' }),
].map((r) => r.id)
const keepFact = addMemory(db, aid, { text: '用户喜欢美式咖啡不加糖', type: 'fact' })

// ---- 聚类：同义的四条应该进同一批
{
  const batches = planBatches(db, aid, { limit: 5 })
  const hit = batches.find((b) => b.filter((m) => ids.includes(m.id)).length >= 3)
  check('同义自省被聚成一批', !!hit, batches.map((b) => b.length))
  check('fact 不参与自省整理', !batches.some((b) => b.some((m) => m.id === keepFact.id)), batches.map((b) => b.length))
}

// ---- 模型返回不可解析：一条都不动
{
  stub('我觉得它们挺像的，但是我不想输出 JSON。')
  const before = db.prepare("SELECT COUNT(*) c FROM memory_items WHERE agent_id=? AND invalid_at IS NOT NULL").get(aid).c
  const out = await consolidatePending(db, aid, { limit: 1 })
  const after = db.prepare("SELECT COUNT(*) c FROM memory_items WHERE agent_id=? AND invalid_at IS NOT NULL").get(aid).c
  check('解析失败不写也不退场', after === before && out.failed >= 1, { before, after, out })
}

// ---- 模型说没价值：不写合并稿，但整批软删（别占坑）
{
  stub('{"keep":false,"reason":"都是流水账"}')
  const out = await consolidatePending(db, aid, { limit: 1 })
  check('keep=false 不落库', (out.dropped || 0) >= 1, out)
  const mergedNone = db.prepare("SELECT COUNT(*) c FROM memory_items WHERE agent_id=? AND source='consolidate'").get(aid).c
  check('keep=false 不写合并稿', mergedNone === 0, mergedNone)
  const deadish = db.prepare(`SELECT id, status, invalid_at FROM memory_items WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids)
  const gone = deadish.filter((r) => r.status === 'soft_deleted' || r.invalid_at)
  check('keep=false 整批退场', gone.length >= 3, deadish)
}

// ---- 正常合并（重新塞一批同义自省）
const ids2 = [
  addMemory(db, aid, { text: '用户在这段对话中只说了“继续”，没有透露可验证的个人事实，偏好推进当前任务。', type: 'reflection' }),
  addMemory(db, aid, { text: '用户在对话中只说了“继续”，未提供新的个人信息，希望助手接着推进当前任务。', type: 'reflection' }),
  addMemory(db, aid, { text: '用户只说了“继续”，没有透露身份或背景，倾向让助手延续当前任务。', type: 'reflection' }),
  addMemory(db, aid, { text: '这段对话里用户只说了继续，没有提供个人信息，希望继续当前任务。', type: 'reflection' }),
].map((r) => r.id)
{
  stub('{"keep":true,"text":"用户常用“继续”“接”这类短指令让助手往下推进，要求保持简洁。","importance":0.7}')
  const out = await consolidatePending(db, aid, { limit: 1 })
  check('合并成功', out.ok && out.done >= 1, out)
  const merged = db.prepare("SELECT id,text,importance,source FROM memory_items WHERE agent_id=? AND source='consolidate' ORDER BY created_at DESC LIMIT 1").get(aid)
  check('写了合并稿', !!merged && /继续/.test(merged.text), merged)
  check('合并稿带重要度', !!merged && Math.abs(Number(merged.importance) - 0.7) < 0.01, merged && merged.importance)
  if (!merged) { model.complete = realComplete; model.capabilities = realCaps; db.close(); process.exit(1) }
  const olds = db.prepare(`SELECT id, invalid_at, superseded_by FROM memory_items WHERE id IN (${ids2.map(() => '?').join(',')})`).all(...ids2)
  const dead = olds.filter((r) => r.invalid_at && r.superseded_by === merged.id)
  check('旧条目被标失效且指向合并稿', dead.length >= 3, olds)

  const s1 = retrieve(db, aid, '用户只说了继续', { k: 6, floor: 0, scene: 'S1' })
  check('S1 不再想起旧流水账', !s1.items.some((x) => dead.some((d) => d.id === x.id)), s1.items.map((x) => x.id))
  const s3 = retrieve(db, aid, '记不记得用户只说了继续', { k: 8, floor: 0, scene: 'S3' })
  const staleHit = s3.items.find((x) => dead.some((d) => d.id === x.id))
  check('S3 深查还能看到旧条目', !!staleHit, s3.items.map((x) => `${x.id}:${x.stale ? 'stale' : 'new'}`))
  check('旧条目标了 stale', !!staleHit && staleHit.stale === true, staleHit && staleHit.stale)
}

// ---- 合并稿本身没被顶掉
{
  stub('{"keep":true,"text":"用户偏好简短指令推进。","importance":0.6}')
  const batches = planBatches(db, aid, { limit: 3 })
  if (batches.length) await mergeBatch(db, aid, batches[0], {})
  const alive = db.prepare("SELECT COUNT(*) c FROM memory_items WHERE agent_id=? AND source='consolidate' AND invalid_at IS NULL").get(aid).c
  check('合并稿仍然有效', alive >= 1, alive)
}

model.complete = realComplete
model.capabilities = realCaps
db.close()
console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exitCode = 1
