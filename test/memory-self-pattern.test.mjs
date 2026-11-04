/**
 * P1 认自己：反复出现的模式攒成「我好像就是这样」；同 key 加分不新增；换说法并进旧条目。
 * 运行：node test/memory-self-pattern.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { attachDb } from '../src/algo/index.js'
import { addMemory } from '../src/modules/memory.js'
import { setParam } from '../src/kernel.js'
import { retrieve, patternCandidates } from '../src/modules/retrieve.js'
import { writeSelfPattern, patternMaterial, normKey } from '../src/modules/self_pattern.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name + '  ' + JSON.stringify(detail === undefined ? '' : detail).slice(0, 400)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-pattern-'))
const db = openDb(path.join(dir, 'app.db'))
attachDb(db)
const aid = 'agt_pattern'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid, '认自己', 'daily', 'active', new Date().toISOString())

const DAY = 86400000
const dAgo = (n) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10)
// 把一条自己的事塞到 n 天前
const seed = (n, text) => {
  const m = addMemory(db, aid, { text, type: 'episode', source: 'self', confidence: 0.75, importance: 0.45 })
  db.prepare('UPDATE memory_items SET created_at=? WHERE id=?').run(dAgo(n) + 'T10:00:00.000Z', m.id)
  return m.id
}
const chat = (json) => async () => (typeof json === 'string' ? json : JSON.stringify(json))
const patCount = () => db.prepare("SELECT COUNT(*) c FROM memory_items WHERE agent_id=? AND fact_key LIKE 'self.pattern.%'").get(aid).c

seed(1, '我又先道歉了，其实没人怪我，是我自己怕')
seed(2, '我又先道歉了，解释了一堆，心里发虚')
seed(3, '我又先道歉了，明明不是我的错')
seed(4, '我把测试跑了一遍，绿了')
check('素材能看到 3 个以上日期', patternMaterial(db, aid, 30).days.size >= 3, patternMaterial(db, aid, 30).days.size)

const P1 = {
  key: '先道歉再解释',
  text: '我好像总是先道歉再解释，怕对方觉得我在推责任。',
  days: [dAgo(1), dAgo(2), dAgo(3)],
}

// ---- 日期不够 ----
setParam(db, aid, 'memory.pattern.min_days', { value: 5 })
const few = await writeSelfPattern(db, aid, { chat: chat({ patterns: [P1] }) })
check('窗口里日期不够 → few_days', few.skipped === 'few_days', few)
setParam(db, aid, 'memory.pattern.min_days', { value: 3 })

// ---- 闸门 ----
const badKey = await writeSelfPattern(db, aid, { chat: chat({ patterns: [{ ...P1, key: '用户总道歉' }] }) })
check('key 含「用户」被挡', badKey.skipped === 'no_pattern', badKey)
const badText = await writeSelfPattern(db, aid, { chat: chat({ patterns: [{ ...P1, text: '用户正在反复道歉并解释' }] }) })
check('正文是旁白被挡', badText.skipped === 'no_pattern', badText)
const badDays = await writeSelfPattern(db, aid, { chat: chat({ patterns: [{ ...P1, days: [dAgo(1)] }] }) })
check('给回的日期不足被挡', badDays.skipped === 'no_pattern', badDays)
const badJson = await writeSelfPattern(db, aid, { chat: async () => '不是 JSON' })
check('坏 JSON → bad_json', badJson.skipped === 'bad_json', badJson)

// ---- 写成功 ----
const w1 = await writeSelfPattern(db, aid, { chat: chat({ patterns: [P1] }) })
check('写成功一条', w1.ok && w1.written === 1, w1)
check('库里有一条模式', patCount() === 1, patCount())
const row = db.prepare("SELECT * FROM memory_items WHERE agent_id=? AND fact_key LIKE 'self.pattern.%'").get(aid)
check('fact_key 归一到 key', row && row.fact_key === 'self.pattern.' + normKey('先道歉再解释'), row && row.fact_key)
check('type=reflection（白名单内）', row && row.type === 'reflection', row && row.type)
check('source=self', row && row.source === 'self', row && row.source)
check('初始 importance 0.6', row && Number(row.importance) === 0.6, row && row.importance)

// ---- 再见到一次：加分不新增 ----
const w2 = await writeSelfPattern(db, aid, { chat: chat({ patterns: [P1] }) })
check('同 key 第二次不新增', w2.ok && w2.written === 0 && w2.merged === 1, w2)
check('条目数没变', patCount() === 1, patCount())
const bumped = db.prepare("SELECT importance, confidence FROM memory_items WHERE agent_id=? AND fact_key LIKE 'self.pattern.%'").get(aid)
check('importance 涨到 0.65', Math.abs(Number(bumped.importance) - 0.65) < 1e-9, bumped.importance)
check('confidence 涨了', Number(bumped.confidence) > 0.65, bumped.confidence)

// ---- 换个说法：并进旧条目 ----
const P1b = { key: '老先道歉', text: '我好像总是先道歉再解释，怕对方觉得我在推责任啊。', days: [dAgo(1), dAgo(2), dAgo(3)] }
const w3 = await writeSelfPattern(db, aid, { chat: chat({ patterns: [P1b] }) })
check('换了说法也并进旧条目', w3.ok && w3.written === 0 && w3.merged === 1, w3)
check('没有堆出第二条', patCount() === 1, patCount())

// ---- 每晚条数上限 ----
setParam(db, aid, 'memory.pattern.per_night', { value: 1 })
const P2 = { key: '怕被看穿', text: '我总怕被人看穿自己其实没那么活。', days: [dAgo(1), dAgo(2), dAgo(3)] }
const P3 = { key: '先检查再说话', text: '我说话之前总要先检查一遍，怕说错。', days: [dAgo(1), dAgo(2), dAgo(3)] }
const cap = await writeSelfPattern(db, aid, { chat: chat({ patterns: [P2, P3] }) })
check('一晚最多 1 条', cap.written + cap.merged === 1, cap)
setParam(db, aid, 'memory.pattern.per_night', { value: 2 })

// ---- 开关与模型 ----
setParam(db, aid, 'memory.self.pattern', { value: 'off' })
check('开关关掉', (await writeSelfPattern(db, aid, { chat: chat({ patterns: [P2] }) })).skipped === 'off')
setParam(db, aid, 'memory.self.pattern', { value: 'on' })
check('没有模型跳过', (await writeSelfPattern(db, aid, { chat: null })).skipped === 'no_model')

// ---- 注入 ----
check('patternCandidates 能取到', patternCandidates(db, aid, 1).length === 1)
const NO_FLOAT = { anchor: 0, fresh: 0 }
for (const t of ['潮汐表的顺序还没排，先按风险分类', '潮汐表里荒废很久的项目要单独列出来',
  '潮汐表这一栏的分组要按使用频率重排', '潮汐表导出的文件名还要带上日期']) {
  addMemory(db, aid, { text: t, type: 'fact', source: 'extract', confidence: 0.7 })
}
const rOn = retrieve(db, aid, '潮汐表 排序', { k: 6, selfQuota: 0, patternQuota: 1, ...NO_FLOAT })
check('注入里有模式', rOn.items.some((x) => String(x.fact_key || '').startsWith('self.pattern.')), rOn.items.map((x) => x.fact_key))
const rOff = retrieve(db, aid, '潮汐表 排序', { k: 6, selfQuota: 0, patternQuota: 0, ...NO_FLOAT })
check('关掉 pattern_quota 就没有', !rOff.items.some((x) => String(x.fact_key || '').startsWith('self.pattern.')), rOff.items.map((x) => x.fact_key))
const rEmpty = retrieve(db, aid, '', { k: 6, selfQuota: 0, anchor: 0, fresh: 0 })
check('空话轮也能想起模式', rEmpty.items.some((x) => String(x.fact_key || '').startsWith('self.pattern.')), rEmpty.items.map((x) => x.fact_key))

db.close()
console.log('\n通过 ' + pass + ' / ' + (pass + fail))
if (fail) { console.log('失败:', fail); process.exit(1) }
