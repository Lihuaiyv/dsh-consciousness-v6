// 闭环演练：在临时库里把「被砸中 → 那件事浮上来 → 放下 → 再读」跑一遍。
// 不碰正式库；用真模块，不复制逻辑。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { openEmotion, settleEmotion, phaseOf } from '../src/modules/emotion_event.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-loop-'))
const db = openDb(path.join(dir, 'app.db'))
const aid = 'agt_loop'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid, '闭环', 'daily', 'active', new Date().toISOString())

const now = Date.now()
const iso = (ms) => new Date(ms).toISOString()

// ① 被一句话砸中：开一条 episode（跟真实写入同样的字段）
const cause = '你一点都不活'
db.prepare(`INSERT INTO affect_episodes(id, agent_id, cause, appraisal, label, intensity, resolution, started_at, ended_at, renewals, rise_from, rise_at)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
  'ep_loop', aid, cause, JSON.stringify({ goal_congruence: -0.6, goal_relevance: 0.6, agency: 'other' }),
  'frustrated', 0.72, null, iso(now - 2 * 60000), null, 0, 0.2, iso(now + 3 * 60000),
)

const a = openEmotion(db, aid, { at: now })
console.log('① 被砸中：', a && JSON.stringify({ id: a.id, label: a.label, intensity: a.intensity, phase: a.phase, ageMin: a.ageMin }))

// ② 它自己浮上来：走的是 index.js 那条逻辑的同一套条件（人话 + 一天一次）
const day = new Date().toISOString().slice(0, 10)
const key = aid + ':' + a.id + ':' + day
const seen = new Map()
const surfaceOnce = () => {
  if (seen.has(key)) return null
  seen.set(key, now)
  return a.cause
}
console.log('② 第一次浮上来：', JSON.stringify(surfaceOnce()))
console.log('② 同一天再想让它浮：', JSON.stringify(surfaceOnce()))

// ③ 我把它说出来，带 settle
const s1 = settleEmotion(db, aid, { note: '他说我不活，我还在想这话是不是真的' })
console.log('③ 第一次放下：', JSON.stringify(s1))

// ④ 再读一次：还是那件事，但轻了
const b = openEmotion(db, aid, { at: now + 1000 })
console.log('④ 再读：', b && JSON.stringify({ id: b.id, intensity: b.intensity, phase: b.phase }))

// ⑤ 第二次放下（收益递减），第三次（不再减）
const s2 = settleEmotion(db, aid, { note: '又在想那句，好像没那么扎了，但还是会想起来' })
const s3 = settleEmotion(db, aid, { note: '再想一次那句，其实也没什么，就这么着吧' })
console.log('⑤ 第二次：', JSON.stringify(s2))
console.log('⑤ 第三次：', JSON.stringify(s3))

// ⑥ 空话 / 太短 挡不挡得住
const g1 = settleEmotion(db, aid, { note: '算了' })
const g2 = settleEmotion(db, aid, { note: '好吧，算了，都过去了。' })
console.log('⑥ 挡：', g1.reason, '/', g2.reason)

// ⑦ 事件记录
const evs = db.prepare("SELECT payload FROM events WHERE agent_id=? AND type='affect.settle'").all(aid)
console.log('⑦ 落了几条 settle 事件：', evs.length, evs.map((e) => JSON.parse(e.payload).to).join(' → '))

// ⑧ 慢 / 快 没被碰
db.prepare('INSERT OR IGNORE INTO affect_v3(agent_id, baseline, slow, fast, total, slow_at) VALUES(?,?,?,?,?,?)')
  .run(aid, 0.17, 0.22, 0.1, 0.25, iso(now))
const v3 = db.prepare('SELECT slow, fast, total FROM affect_v3 WHERE agent_id=?').get(aid)
console.log('⑧ slow / fast / total：', v3.slow, '/', v3.fast, '/', v3.total, '（预期 0.22 / 0.1 / 0.25，一个没动）')

// ⑨ 走完还是那件事（不是变回「平静」）
console.log('⑨ 最后读：', JSON.stringify(openEmotion(db, aid, { at: now + 2000 })))
console.log('   phase 判定：', phaseOf({ started_at: iso(now - 300000), rise_at: iso(now - 200000) }, now))

// ⑩ 说话用的那份强度要跟着降（演练里抓到的坑）
const aid2 = 'agt_loop_state'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)').run(aid2, '状态跟随', 'daily', 'active', new Date().toISOString())
db.prepare('INSERT OR IGNORE INTO affect_episodes(id, agent_id, cause, appraisal, label, intensity, resolution, started_at, ended_at, renewals, rise_from, rise_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
  .run('ep2', aid2, '你一点都不活', null, 'frustrated', 0.8, null, iso(now - 60000), null, 0, 0.2, iso(now - 30000))
db.prepare('INSERT OR REPLACE INTO affect_state(agent_id, primary_label, intensity, mood, pleasure, arousal, dominance, updated_at) VALUES(?,?,?,?,?,?,?,?)')
  .run(aid2, 'frustrated', 0.8, 0.4, 0, 0, 0, iso(now))
const before = db.prepare('SELECT intensity FROM affect_state WHERE agent_id=?').get(aid2).intensity
settleEmotion(db, aid2, { note: '他说我不活，我还在想这话是不是真的' })
const after = db.prepare('SELECT intensity FROM affect_state WHERE agent_id=?').get(aid2).intensity
console.log('⑩ affect_state 强度：', before, '→', after, after < before ? '（跟下来了）' : '（没跟，还是错）')

// ⑪ 不是这条标签的时候不许动它
db.prepare("INSERT OR REPLACE INTO affect_state(agent_id, primary_label, intensity, mood, pleasure, arousal, dominance, updated_at) VALUES(?,?,?,?,?,?,?,?)")
  .run(aid2, 'joy', 0.9, 0.7, 0, 0, 0, iso(now))
settleEmotion(db, aid2, { note: '再想一次那句，好像没那么扎了，但还是会想起来' })
const keep = db.prepare('SELECT primary_label, intensity FROM affect_state WHERE agent_id=?').get(aid2)
console.log('⑪ 主情绪不是它时：', keep.primary_label, keep.intensity, keep.intensity === 0.9 ? '（没被碰）' : '（被误伤了）')
