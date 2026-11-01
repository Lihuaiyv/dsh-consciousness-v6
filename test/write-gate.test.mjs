/**
 * 写入侧闸门（P4）：摘要的重要度交给模型判 + 低于门槛的进深查层 + 类型权重。
 * 运行：node test/write-gate.test.mjs
 *
 * 用替身模型（不联网），验的是分工：
 *   - 模型说「没价值」→ 不落库（由 ingest 决定，这里验 judge 的判定口径）；
 *   - 重要度 < 门槛 → addMemory(cold) 落库但 temp_state=cold：S1 不见，S3 看得见；
 *   - 类型权重：同一句查询下 fact 排在 reflection 前面，但 reflection 不会被门控挡掉。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { model } from '../src/kernel.js'
import { addMemory } from '../src/modules/memory.js'
import { retrieve, TYPE_WEIGHT } from '../src/modules/retrieve.js'
import { judgeReflection, clearJudgeCache } from '../src/modules/judge.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 300)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-gate-'))
const db = openDb(path.join(dir, 'app.db'))
const aid = 'agt_gate'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid, 'gate', 'daily', 'active', new Date().toISOString())

const realComplete = model.complete
const realCaps = model.capabilities
model.capabilities = () => ({ ...(realCaps ? realCaps.call(model) : {}), complete: true })

// ---------------------------------------------------------------- judge
{
  clearJudgeCache()
  model.complete = async () => '{"keep":false}'
  const j = await judgeReflection('用户只说了继续')
  check('模型说没价值就 keep=false', j && j.keep === false, j)

  clearJudgeCache()
  model.complete = async () => '```json\n{"keep":true,"importance":0.82}\n```'
  const j2 = await judgeReflection('用户不喜欢别人催进度，这条是边界')
  check('能解析带代码块的 JSON', !!j2 && j2.keep === true && Math.abs(j2.importance - 0.82) < 1e-6, j2)

  clearJudgeCache()
  model.complete = async () => '这条挺重要的（不是 JSON）'
  const j3 = await judgeReflection('随便一句')
  check('解析不了返回 null（调用方回退关键词分）', j3 === null, j3)
}

// ---------------------------------------------------------------- 冷层
{
  model.complete = async () => '{"keep":true,"importance":0.35}'
  const low = addMemory(db, aid, { text: '今天下午聊了聊驱力的周期，顺带看了下曲线。', type: 'reflection', importance: 0.35, cold: true, source: 'summary' })
  const row = db.prepare('SELECT temp_state FROM memory_items WHERE id=?').get(low.id)
  check('低分摘要落进冷层', row && row.temp_state === 'cold', row)

  // noUpgrade：S1 找不到东西时本来会兜底升级 S3（那时冷层是合法的），这里只验纯 S1 的口径
  const s1 = retrieve(db, aid, '驱力的周期曲线', { k: 6, floor: 0, scene: 'S1', noUpgrade: true })
  check('S1 不再注入低分摘要', !s1.items.some((x) => x.id === low.id), s1.items.map((x) => x.id))
  const s3 = retrieve(db, aid, '记不记得驱力的周期曲线', { k: 8, floor: 0, scene: 'S3' })
  check('S3 深查还能找到它', s3.items.some((x) => x.id === low.id), s3.items.map((x) => x.id))
}

// ---------------------------------------------------------------- 类型权重
{
  const fact = addMemory(db, aid, { text: '用户喜欢美式咖啡不加糖', type: 'fact', importance: 0.8 })
  const refl = addMemory(db, aid, { text: '想起美式咖啡这件事，不加糖喝着更顺', type: 'reflection', importance: 0.6 })
  check('类型权重表覆盖五种类型', TYPE_WEIGHT.fact === 1 && TYPE_WEIGHT.appraisal === 0.8 && TYPE_WEIGHT.reflection === 0.55, TYPE_WEIGHT)
  const r = retrieve(db, aid, '美式咖啡', { k: 6, floor: 0 })
  const ids = r.items.map((x) => x.id)
  check('事实和自省都进得来（没被权重挡在门外）', ids.includes(fact.id) && ids.includes(refl.id), ids)
  check('事实排在自省前面', ids.indexOf(fact.id) < ids.indexOf(refl.id), ids)
  const off = retrieve(db, aid, '美式咖啡', { k: 6, floor: 0, typeWeights: false })
  check('关掉权重也能跑', off.items.length >= 1, off.items.length)
}

model.complete = realComplete
model.capabilities = realCaps
db.close()
console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exitCode = 1
