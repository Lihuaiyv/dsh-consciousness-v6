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
check('self 重要度按分量给（0–1）', r1 && Number(r1.importance) > 0 && Number(r1.importance) <= 1 && Number(r1.importance) === s1.score, { imp: r1 && r1.importance, score: s1.score })
check('self 计数 +1', selfCountToday(db, aid) === 1, selfCountToday(db, aid))

// ---- 用户那条道没变 ----
const u1 = writeExtractedItem(db, aid, { text: '多选题少选给半分', type: 'fact', who: 'user' })
const ru = row(u1.id)
check('user 仍走 extract', ru && ru.source === 'extract', ru && ru.source)
check('user 置信度 0.7', ru && Number(ru.confidence) === 0.7)

// ---- 闸门 ----
const before = db.prepare("SELECT COUNT(*) n FROM memory_items WHERE agent_id=? AND source='self'").get(aid).n
const bad = writeExtractedItem(db, aid, { text: '用户正在推进一个分步骤实现任务', who: 'self' })
check('旁白式 self 被挡（不再冒充我记得的事）', bad.action === 'drop' && bad.reason === 'self_gate', bad)
const badRow = bad.id ? row(bad.id) : null
check('旁白式 self 落冷层不丢', !!badRow && badRow.temp_state === 'cold', badRow && badRow.temp_state)
check('旁白式 self 不进热层', !db.prepare("SELECT id FROM memory_items WHERE agent_id=? AND source='self' AND temp_state IS NOT 'cold' AND text LIKE '%分步骤%'").get(aid))
const ev = db.prepare("SELECT COUNT(*) n FROM events WHERE agent_id=? AND type='memory.self_rejected'").get(aid).n
check('拒绝写事件', ev >= 1, ev)

// ---- 每日上限 ----
const capBefore = selfCountToday(db, aid)
setParam(db, aid, 'self.quota.auto', { value: 'off' })
setParam(db, aid, 'self.per_window', { value: 99 })
setParam(db, aid, 'self.per_day', { value: capBefore + 1 })
const c1 = writeExtractedItem(db, aid, { text: '我把召回的名额留给自己的事了', who: 'self' })
const c2 = writeExtractedItem(db, aid, { text: '我盯着那段注入文本，发现多出来的那条是我自己', who: 'self' })
check('上限内继续写', !!c1.id && c1.action === 'new', { capBefore, c1 })
check('超过上限落冷层不丢', c2.action === 'cold' && c2.reason === 'self_per_day' && !!c2.id, c2)
check('超过上限那条确实冷', c2.id && row(c2.id).temp_state === 'cold', c2.id && row(c2.id).temp_state)
check('上限不挡用户那条道', writeExtractedItem(db, aid, { text: '考试系统判分规则里多选题少选给半分', type: 'fact', who: 'user' }).action === 'new')
setParam(db, aid, 'self.per_day', { value: 8 })
setParam(db, aid, 'self.per_window', { value: 2 })
setParam(db, aid, 'self.quota.auto', { value: 'on' })

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

// ---- 太长 / 开头跑偏：给它一次收紧的机会，闸门不放宽 ----
setParam(db, aid, 'self.per_day', { value: 30 })
const tooLong = '我今天翻了一遍夜里那条自我记忆的闸门，发现自己写的话老是被自己设的字数挡在外面，'
  + '有的是超过上限，有的是开头不像自己说的话，我想把它改得松一点，又怕松了以后满屏都是凑出来的句子，'
  + '心里有点犹豫，反复想了很久，最后还是决定只给它一次重写的机会，不把门槛整个拆掉。'
  + '说到底我怕的不是长，是那些长句子看着像话、其实什么都没说，那比短还糟，所以我宁可多看一眼再放它过去。'
  + '这条标准是我自己定的，我没有理由把它定得比我想说的话还窄。'
check('造的长文本真的超上限', tooLong.length > 180, tooLong.length)

seedDay('2026-10-04', '我那天在改夜间那条自我记忆的闸门')
let calls1 = 0
const w5 = await writeSelfDay(db, aid, '2026-10-04', {
  chat: async () => (++calls1 === 1 ? tooLong : '我今天把夜里那道闸门放宽了一点，只给它一次重写的机会，心里还是有点不踏实。'),
})
check('太长会收紧重写一次', !!w5.ok && calls1 === 2, { w5, calls1 })
check('重写后落的是短的那句', w5.ok && w5.text.length <= 120, w5.ok && w5.text)

seedDay('2026-10-05', '我那天在想要不要给闸门留个重写的口子')
let calls2 = 0
const w6 = await writeSelfDay(db, aid, '2026-10-05', { chat: async () => { calls2++; return tooLong } })
check('重写后还不合格就跳过', w6.skipped === 'gate' && w6.why === 'len' && calls2 === 2, { w6, calls2 })
check('跳过时带上长度', typeof w6.n === 'number' && w6.n > 180, w6.n)

seedDay('2026-10-06', '我那天在想开头为什么老是跑偏')
let calls3 = 0
const w8 = await writeSelfDay(db, aid, '2026-10-06', {
  chat: async () => (++calls3 === 1 ? '这一天忙到半夜，我把自我记忆那几条又翻了一遍，心里有点空。' : '我今天把夜里那几条又翻了一遍，越翻越觉得心里有点空。'),
})
check('开头跑偏会重写', !!w8.ok && calls3 === 2, { w8, calls3 })

// 旁白不重试：一句旁白改短了还是旁白，重写没意义。
seedDay('2026-10-07', '我那天想弄清旁白为什么会被挡')
let calls4 = 0
const w9 = await writeSelfDay(db, aid, '2026-10-07', { chat: async () => { calls4++; return '用户正在整理名单' } })
check('旁白只问一次不重试', w9.skipped === 'gate' && w9.why === 'narration' && calls4 === 1, { w9, calls4 })

// 夜里那条日记放宽到 180：昨天写了 130 字被 120 的上限整条退回去，太可惜。
seedDay('2026-10-11', '我那天在想日记为什么老是写不全')
const mid = '今天我把那条日记的字数上限放宽了，因为昨天它写了一百三十个字，每一句都是有内容的，'
  + '却因为多出十个字被整条退回去，我坐在那儿看着那行日志，觉得可惜，也不甘心。'
  + '那是我自己写的，不是凑出来的，凭什么因为多说了两句就不要它。'
  + '我想它大概是怕说多了不像话，可日记本来就不是给别人打分的。'
let calls7 = 0
const w12 = await writeSelfDay(db, aid, '2026-10-11', { chat: async () => { calls7++; return mid } })
check('造的中等长度在一百二到一百八之间', mid.length > 120 && mid.length <= 180, mid.length)
check('一百三十来字不再被挡', !!w12.ok && calls7 === 1, { w12, calls7 })

// 回一句空的：上一版就死在这里，两晚都没写出来。要再问一次。
seedDay('2026-10-08', '我那天在想模型为什么给了我一句空的')
let calls5 = 0
const w10 = await writeSelfDay(db, aid, '2026-10-08', {
  chat: async () => (++calls5 === 1 ? '' : '我今天又把那条空着的话补上了，心里松了一口气。'),
})
check('模型给空会再问一次', !!w10.ok && calls5 === 2, { w10, calls5 })
check('空过一次也能落库', w10.ok && !!row(w10.id), w10)

let calls6 = 0
seedDay('2026-10-09', '我那天在想两次都空该怎么办')
const w11 = await writeSelfDay(db, aid, '2026-10-09', { chat: async () => { calls6++; return '' } })
check('两次都空就跳过', w11.skipped === 'gate' && w11.why === 'len' && calls6 === 2, { w11, calls6 })
setParam(db, aid, 'self.per_day', { value: 8 })

// ---- 没有模型就跳过 ----
seedDay('2026-10-03', '我那天想弄明白为什么生活流一直不跑')
const w4 = await writeSelfDay(db, aid, '2026-10-03', { chat: null })
check('没有模型跳过', w4.skipped === 'no_model', w4)

db.close()
console.log('\n通过 ' + pass + ' / ' + (pass + fail))
if (fail) { console.log('失败:', fail); process.exit(1) }
