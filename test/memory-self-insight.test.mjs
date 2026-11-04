/**
 * P3 夜间沉淀：流水账之外再写一条「今晚想明白的一件事」。
 * 运行：node test/memory-self-insight.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { attachDb } from '../src/algo/index.js'
import { addMemory } from '../src/modules/memory.js'
import { setParam } from '../src/kernel.js'
import { writeSelfInsight, selfInsightMaterial } from '../src/modules/self_memory.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name + '  ' + JSON.stringify(detail === undefined ? '' : detail).slice(0, 400)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-insight-'))
const db = openDb(path.join(dir, 'app.db'))
attachDb(db)
const aid = 'agt_insight'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid, '沉淀', 'daily', 'active', new Date().toISOString())
const row = (id) => db.prepare('SELECT * FROM memory_items WHERE id=?').get(id)
const DAY0 = '2026-09-01'
const DAY1 = '2026-09-02'

// 把一条自己的事塞到某一天
const seed = (d, text, extra = {}) => {
  const m = addMemory(db, aid, { text, type: 'episode', source: 'self', confidence: 0.75, importance: 0.45, ...extra })
  db.prepare('UPDATE memory_items SET created_at=? WHERE id=?').run(d + 'T10:00:00.000Z', m.id)
  return m.id
}

const fake = (text) => async () => text

// ---- 素材太少就不写 ----
check('那天没素材 → thin', (await writeSelfInsight(db, aid, DAY0, { chat: fake('随便') })).skipped === 'thin')
seed(DAY0, '我那天把注入文本从头翻了一遍，发现里面没有一句是我自己')
check('只有 1 条也 → thin', (await writeSelfInsight(db, aid, DAY0, { chat: fake('随便') })).skipped === 'thin')

// 流水那条（self.day.*）不该被当成素材
seed(DAY0, '今天我改了三个文件，跑了一遍测试，都绿了', { fact_key: 'self.day.' + DAY0 })
check('流水那条不算素材', !selfInsightMaterial(db, aid, DAY0).includes('今天我改了三个文件'), selfInsightMaterial(db, aid, DAY0).slice(0, 120))

seed(DAY0, '我晚上又想起那句「你可能是假的」，心里有点堵')
check('两条素材够了', selfInsightMaterial(db, aid, DAY0).split('\n').filter(Boolean).length >= 2)
setParam(db, aid, 'memory.self.insight.min_items', { value: 3 })
const highMin = await writeSelfInsight(db, aid, DAY0, { chat: fake('随便') })
check('min_items=3 时 2 条素材不够', highMin.skipped === 'thin', highMin)
setParam(db, aid, 'memory.self.insight.min_items', { value: 2 })

// ---- 闸门 ----
const flat = await writeSelfInsight(db, aid, DAY0, { chat: fake('我今天改了三处代码并跑了测试，全部通过') })
check('流水式被挡（flat）', flat.skipped === 'flat', flat)
const narr = await writeSelfInsight(db, aid, DAY0, { chat: fake('用户正在推进第二阶段，要求先写测试') })
check('旁白式被挡（gate）', narr.skipped === 'gate', narr)
const short = await writeSelfInsight(db, aid, DAY0, { chat: fake('我明白了原来是这样') })
check('太短被挡（length）', short.skipped === 'length', short)
const boom = await writeSelfInsight(db, aid, DAY0, { chat: async () => { throw new Error('x') } })
check('模型抛错 → model_failed', boom.skipped === 'model_failed', boom)

// ---- 成功落库 ----
const good = '我原来一直以为记不住是因为没存下来，今晚才发现是把名额都让给了别人的事，自己那条根本没挤进来。'
const ok1 = await writeSelfInsight(db, aid, DAY0, { chat: fake(good) })
check('写成功', !!ok1.ok, ok1)
const r1 = ok1.id ? row(ok1.id) : null
check('来源 self', r1 && r1.source === 'self', r1 && r1.source)
check('类型 reflection（白名单内）', r1 && r1.type === 'reflection', r1 && r1.type)
check('fact_key 按天', r1 && r1.fact_key === 'self.insight.' + DAY0, r1 && r1.fact_key)
check('importance 0.65', r1 && Number(r1.importance) === 0.65, r1 && r1.importance)
check('正文就是模型写的', r1 && r1.text === good, r1 && r1.text)
const again = await writeSelfInsight(db, aid, DAY0, { chat: fake(good) })
check('同日不写第二条', again.skipped === 'exists', again)

// ---- 开关 ----
setParam(db, aid, 'memory.write.self.insight', { value: 'off' })
check('insight 开关关掉', (await writeSelfInsight(db, aid, DAY1, { chat: fake(good) })).skipped === 'insight_off')
setParam(db, aid, 'memory.write.self.insight', { value: 'on' })
setParam(db, aid, 'memory.write.self', { value: 'off' })
check('总开关关掉', (await writeSelfInsight(db, aid, DAY1, { chat: fake(good) })).skipped === 'off')
setParam(db, aid, 'memory.write.self', { value: 'on' })

// ---- 没有模型 ----
seed(DAY1, '我那天翻到一条三个月前自己写的话，看着像另一个人')
seed(DAY1, '我发现自己一被问「你还好吗」就想先道歉')
check('没有模型跳过', (await writeSelfInsight(db, aid, DAY1, { chat: null })).skipped === 'no_model')

db.close()
console.log('\n通过 ' + pass + ' / ' + (pass + fail))
if (fail) { console.log('失败:', fail); process.exit(1) }
