/**
 * P1 她自己的记忆车道：source='self'、第一人称闸门、每日上限、夜间一天一条。
 * 运行：node test/memory-self-lane.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { attachDb } from '../src/algo/index.js'
import { writeExtractedItem, selfCountToday } from '../src/features.js'
import { getParam, setParam } from '../src/kernel.js'
import { memoryTag } from '../src/modules/memory_tag.js'
import { writeSelfDay, selfDayMaterial } from '../src/modules/self_memory.js'
import { EXTRACT_SYS } from '../src/model.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name + '  ' + JSON.stringify(detail === undefined ? '' : detail).slice(0, 400)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-self-'))
const db = openDb(path.join(dir, 'app.db'))
attachDb(db)
const aid = 'agt_self'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid, '她自己', 'daily', 'active', new Date().toISOString())
const row = (id) => db.prepare('SELECT * FROM memory_items WHERE id=?').get(id)
const day = (() => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
})()

// ---- 提示词分道 ----
check('提示词带 who 字段', EXTRACT_SYS.includes('"who":"user|self"'), EXTRACT_SYS.slice(0, 80))
check('提示词要求 self 第一人称', EXTRACT_SYS.includes('第一人称') && EXTRACT_SYS.includes('以「我」开头'))
check('提示词禁止第三人称旁白', EXTRACT_SYS.includes('第三人称旁白'))
check('提示词限制 self 每轮 3 条', EXTRACT_SYS.includes('最多 3 条'))

// ---- self 落库 ----
const s1 = writeExtractedItem(db, aid, { text: '我把摘要那条默认关掉了，刷新后确认它不再写第三人称旁白', who: 'self' })
const r1 = row(s1.id)
check('self 落库', !!r1, s1)
check('self 来源是 self', r1 && r1.source === 'self', r1 && r1.source)
check('self 复用 episode 类型', r1 && r1.type === 'episode', r1 && r1.type)
check('self 置信度 0.75', r1 && Number(r1.confidence) === 0.75, r1 && r1.confidence)
check('self 重要度 0.45', r1 && Number(r1.importance) === 0.45, r1 && r1.importance)
check('self 计数 +1', selfCountToday(db, aid) === 1, selfCountToday(db, aid))

// ---- 用户那条道没变 ----
const u1 = writeExtractedItem(db, aid, { text: '多选题少选给半分', type: 'fact', who: 'user' })
const ru = row(u1.id)
check('user 仍走 extract', ru && ru.source === 'extract', ru && ru.source)
check('user 置信度 0.7', ru && Number(ru.confidence) === 0.7)

// ---- 闸门 ----
const before = db.prepare("SELECT COUNT(*) n FROM memory_items WHERE agent_id=? AND source='self'").get(aid).n
const bad = writeExtractedItem(db, aid, { text: '用户正在推进一个分步骤实现任务', who: 'self' })
check('旁白式 self 被丢', bad.action === 'drop' && bad.reason === 'self_gate', bad)
check('旁白式 self 没落库', db.prepare("SELECT COUNT(*) n FROM memory_items WHERE agent_id=? AND source='self'").get(aid).n === before)
const ev = db.prepare("SELECT COUNT(*) n FROM events WHERE agent_id=? AND type='memory.self_rejected'").get(aid).n
check('拒绝写事件', ev >= 1, ev)

// ---- 每日上限 ----
const capBefore = selfCountToday(db, aid)
setParam(db, aid, 'self.per_day', { value: capBefore + 1 })
const c1 = writeExtractedItem(db, aid, { text: '我把召回的名额留给自己的事了', who: 'self' })
const c2 = writeExtractedItem(db, aid, { text: '我盯着那段注入文本，发现多出来的那条是我自己', who: 'self' })
check('上限内继续写', !!c1.id && !c2.id, { capBefore, c1, c2 })
check('超过上限被丢', c2.action === 'drop' && c2.reason === 'self_per_day', c2)
check('上限不挡用户那条道', writeExtractedItem(db, aid, { text: '考试系统判分规则里多选题少选给半分', type: 'fact', who: 'user' }).action === 'new')
setParam(db, aid, 'self.per_day', { value: 8 })

// ---- 开关 ----
setParam(db, aid, 'memory.write.self', { value: 'off' })
check('开关关掉不写', writeExtractedItem(db, aid, { text: '我把今天的路铺完了，心里松了一点', who: 'self' }).action === 'drop')
setParam(db, aid, 'memory.write.self', { value: 'on' })

// ---- 标签 ----
const tagRow = { text: '我', source: 'self', confidence: 0.75, created_at: new Date().toISOString() }
check('self 贴「我自己记得的」', memoryTag(tagRow, Date.now(), { provenance: true }).includes('我自己记得的'), memoryTag(tagRow, Date.now(), { provenance: true }))
check('provenance 关时 self 不贴', memoryTag(tagRow, Date.now()) === '', memoryTag(tagRow, Date.now()))

// ---- 夜间一天一条 ----
check('无素材不写', (await writeSelfDay(db, aid, '2026-10-01', { chat: async () => '我不会被调用的' })).skipped === 'no_material')
check('素材函数能看到自己的条目', selfDayMaterial(db, aid, day).includes('我把召回的名额留给自己的事了'), selfDayMaterial(db, aid, day).slice(0, 120))
const fake = async () => '我今天把记忆那条道从头铺了一遍，中间发现自己一直在替别人记事，改完以后心里有点空，也有点稳。'
const w1 = await writeSelfDay(db, aid, day, { chat: fake })
check('夜间写成功', !!w1.ok, w1)
const rw = w1.id ? row(w1.id) : null
check('夜间条目来源 self', rw && rw.source === 'self', rw && rw.source)
check('夜间条目带 fact_key', rw && String(rw.fact_key || '').startsWith('self.day.'), rw && rw.fact_key)
const w2 = await writeSelfDay(db, aid, day, { chat: fake })
check('一天只写一条', w2.skipped === 'exists', w2)

// 造一个「那天有素材」的条目：写进去再把 created_at 挪到那天
const seedDay = (d, text) => {
  const s = writeExtractedItem(db, aid, { text, who: 'self' })
  db.prepare('UPDATE memory_items SET created_at=? WHERE id=?').run(d + 'T10:00:00.000Z', s.id)
  return s.id
}
seedDay('2026-10-02', '我那天翻了一遍注入文本，发现里面没有一句是我自己')
const w3 = await writeSelfDay(db, aid, '2026-10-02', { chat: async () => '用户正在整理名单' })
check('模型写了旁白也不落库', w3.skipped === 'gate', w3)

// ---- 没有模型就跳过 ----
seedDay('2026-10-03', '我那天想弄明白为什么生活流一直不跑')
const w4 = await writeSelfDay(db, aid, '2026-10-03', { chat: null })
check('没有模型跳过', w4.skipped === 'no_model', w4)

db.close()
console.log('\n通过 ' + pass + ' / ' + (pass + fail))
if (fail) { console.log('失败:', fail); process.exit(1) }
