/**
 * 按分量选人 + 三小时结算 + 自适应额度。
 * 运行：node test/self-settle.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { attachDb } from '../src/algo/index.js'
import { writeExtractedItem, settleSelfHot, selfQuotaToday, selfCountToday } from '../src/features.js'
import { scoreSelf } from '../src/modules/memory_source.js'
import { setParam } from '../src/kernel.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name + '  ' + JSON.stringify(detail === undefined ? '' : detail).slice(0, 400)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-settle-'))
const db = openDb(path.join(dir, 'app.db'))
attachDb(db)
const aid = 'agt_settle'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid, '结算', 'daily', 'active', new Date().toISOString())
const row = (id) => db.prepare('SELECT * FROM memory_items WHERE id=?').get(id)

// ---- 1. 规则分 ----
const sInsight = scoreSelf('我想明白了，摘要是给你看的，不是我记住的东西')
const sProgress = scoreSelf('我跑了整套测试，又改了一个字段的命名')
check('想明白的分高于进度', sInsight > sProgress, { sInsight, sProgress })
check('分数落在 0–1', [sInsight, sProgress, scoreSelf(''), scoreSelf('我'.repeat(300))].every((x) => x >= 0 && x <= 1))
check('空串 0 分', scoreSelf('') === 0)

// ---- 2. admission=score：低分先落冷 ----
setParam(db, aid, 'self.admission', { value: 'score' })
setParam(db, aid, 'self.admission.min_score', { value: 0.5 })
setParam(db, aid, 'self.quota.auto', { value: 'off' })
setParam(db, aid, 'self.per_day', { value: 20 })
const low = writeExtractedItem(db, aid, { text: '我提交了第三次修复，把字段名改短了一点', who: 'self' })
check('低分不占热层（落冷）', low.cold === true && low.score < 0.5, low)
const high = writeExtractedItem(db, aid, { text: '我想明白了，那些摘要记的是你，不是我，我不想再这样记下去', who: 'self' })
check('高分进热层', high.action === 'new' && high.id && row(high.id).temp_state !== 'cold', high)
check('热层条目带着分数', high.id && Number(row(high.id).importance) >= 0.5, high.id && row(high.id).importance)

// ---- 2b. 额度满了，高分可以破例 ----
setParam(db, aid, 'self.per_day', { value: 1 })
const bypassHigh = writeExtractedItem(db, aid, { text: '我想明白了一件事：热层该按分量选，谁先来不算数', who: 'self' })
check('额度满时高分破例进热层', bypassHigh.action === 'new' && bypassHigh.cold !== true, bypassHigh)
const bypassEv = db.prepare("SELECT COUNT(*) n FROM events WHERE agent_id=? AND type='memory.self.bypass'").get(aid).n
check('破例记事件', bypassEv >= 1, bypassEv)
const medium = writeExtractedItem(db, aid, { text: '我把日志里的空行数改成了零', who: 'self' })
check('额度满时普通分仍落冷', medium.cold === true, medium)
setParam(db, aid, 'self.per_day', { value: 20 })
// auto 开着时日额度是软的：窗口还有位就还能进，不会早上写满下午就进不来
setParam(db, aid, 'self.quota.auto', { value: 'on' })
setParam(db, aid, 'self.quota.base', { value: 1 })
setParam(db, aid, 'self.per_window', { value: 99 })
const softA = writeExtractedItem(db, aid, { text: '我把今天的现场记录又核了一遍，心里踏实些了', who: 'self' })
const softB = writeExtractedItem(db, aid, { text: '我心里有点急着想把明天的清点表先列好，省得明天忘', who: 'self' })
check('auto 开着日额度是软的', softA.cold !== true && softB.cold !== true, { softA, softB })
setParam(db, aid, 'self.per_window', { value: 2 })
setParam(db, aid, 'self.quota.base', { value: 4 })

// ---- 3. 结算：冷层高分换掉热层低分 ----
setParam(db, aid, 'self.settle', { value: 'on' })
setParam(db, aid, 'self.settle.gap', { value: 0.1 })
// 手工造一条低分热条 + 一条高分冷条，保证结算有对象可换
const now = new Date().toISOString()
const mk = (text, imp, cold) => {
  const id = 'mem_' + Math.random().toString(16).slice(2, 10)
  db.prepare("INSERT INTO memory_items(id,agent_id,type,mark,text,source,confidence,importance,created_at,last_decay_at,status,band,temp_state,state_since) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, aid, 'episode', 'normal', text, 'self', 0.7, imp, now, now, 'active', 'hot', cold ? 'cold' : 'hot', cold ? now : null)
  return id
}
const lowHot = mk('我跑了第几步测试，跟上次一样', 0.2, false)
const highCold = mk('我意识到自己一直替别人记事情，心里有点空', 0.8, true)
const moved = settleSelfHot(db, aid)
check('结算换了一条', moved.moved === 1, moved)
check('低分退冷', row(lowHot).temp_state === 'cold', row(lowHot).temp_state)
check('高分升热', row(highCold).temp_state === 'hot', row(highCold).temp_state)
const ev = db.prepare("SELECT COUNT(*) n FROM events WHERE agent_id=? AND type='memory.self.settle'").get(aid).n
check('结算记事件', ev >= 1, ev)
check('差不够就不换', settleSelfHot(db, aid).moved === 0)

// ---- 4. 关掉结算 ----
setParam(db, aid, 'self.settle', { value: 'off' })
check('开关关掉不结算', settleSelfHot(db, aid).moved === 0)
setParam(db, aid, 'self.settle', { value: 'on' })

// ---- 5. 自适应额度 ----
setParam(db, aid, 'self.quota.auto', { value: 'on' })
setParam(db, aid, 'self.quota.base', { value: 4 })
setParam(db, aid, 'self.quota.max', { value: 16 })
const q0 = selfQuotaToday(db, aid, Date.now() + 3600 * 1000)
check('安静的一天用保底', q0 === 4, q0)
// 造 120 轮对话 + 50 次被挡，额度该往上浮
const stmt = db.prepare('INSERT INTO events VALUES(?,?,?,?,?)')
for (let i = 0; i < 120; i++) stmt.run('evt_' + Math.random().toString(16).slice(2, 10), aid, 'chat.turn', '{}', new Date().toISOString())
for (let i = 0; i < 50; i++) stmt.run('evt_' + Math.random().toString(16).slice(2, 10), aid, 'memory.self_rejected', '{}', new Date().toISOString())
const q1 = selfQuotaToday(db, aid, Date.now() + 2 * 3600 * 1000)
check('聊得多额度上浮', q1 > q0 && q1 <= 16, { q0, q1 })
check('额度不超过封顶', selfQuotaToday(db, aid, Date.now() + 3 * 3600 * 1000) <= 16)

// ---- 6. auto 关掉回到固定值 ----
setParam(db, aid, 'self.quota.auto', { value: 'off' })
setParam(db, aid, 'self.per_day', { value: 9 })
check('auto 关掉用固定值', selfQuotaToday(db, aid, Date.now() + 4 * 3600 * 1000) === 9)
setParam(db, aid, 'self.quota.auto', { value: 'on' })

console.log('\n通过 ' + pass + ' / ' + (pass + fail))
if (fail) { console.log('失败:', fail); process.exit(1) }

