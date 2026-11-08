/**
 * 放下那件事（settle）：只降不升、收益递减、内容得贴着那件事。
 * 运行：node test/settle.test.mjs
 *
 * 验八件事：
 *   1. 没有挂着的事 → no_open
 *   2. 太短的一句话不生效（note_too_short）
 *   3. 「算了 / 好吧」这种空话不生效（generic）
 *   4. 第一次减半
 *   5. 第二次只去掉剩下的三分之一
 *   6. 第三次起不再减（already_flat）
 *   7. 只动 episode，不碰 affect_v3 的慢 / 快
 *   8. 每次真的放下了都留一条 affect.settle 事件
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { settleEmotion } from '../src/modules/emotion_event.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name + '  ' + JSON.stringify(detail === undefined ? '' : detail).slice(0, 400)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-settle-'))
const db = openDb(path.join(dir, 'app.db'))
const aid = 'agt_settle'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid, '放下', 'daily', 'active', new Date().toISOString())

const note = '他说我不活，我还在想这话是不是真的'

// ---------- 1. 没有挂着的事 ----------
check('没有 open episode → no_open', settleEmotion(db, aid, { note }).reason === 'no_open')

// ---------- 造一条 ----------
const t0 = new Date(Date.now() - 10 * 60000).toISOString()
db.prepare(`INSERT INTO affect_episodes(id, agent_id, cause, appraisal, label, intensity, resolution, started_at, ended_at, renewals, rise_from, rise_at)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run('ep_settle', aid, '你一点都不活', null, 'frustrated', 0.8, null, t0, null, 0, 0.2, t0)
db.prepare('INSERT OR IGNORE INTO affect_v3(agent_id, baseline, slow, fast, total, slow_at) VALUES(?,?,?,?,?,?)')
  .run(aid, 0.17, 0.22, 0.1, 0.25, new Date().toISOString())

// ---------- 2 / 3. 不生效的那两种 ----------
check('太短不生效', settleEmotion(db, aid, { note: '难过' }).reason === 'note_too_short')
check('空话不生效（剥掉套话后没剩下东西）', settleEmotion(db, aid, { note: '好吧，算了，都过去了。' }).reason === 'generic')
check('不生效时强度没动', Number(db.prepare('SELECT intensity FROM affect_episodes WHERE id=?').get('ep_settle').intensity) === 0.8)

// ---------- 4. 第一次减半 ----------
const s1 = settleEmotion(db, aid, { note })
check('第一次放下成功', s1.ok === true, s1)
check('第一次减半', Math.abs(Number(db.prepare('SELECT intensity FROM affect_episodes WHERE id=?').get('ep_settle').intensity) - 0.4) < 1e-9)
check('写了 resolution=folded', db.prepare('SELECT resolution FROM affect_episodes WHERE id=?').get('ep_settle').resolution === 'folded')

// ---------- 5. 第二次只去掉剩下的三分之一 ----------
const s2 = settleEmotion(db, aid, { note })
const after2 = Number(db.prepare('SELECT intensity FROM affect_episodes WHERE id=?').get('ep_settle').intensity)
check('第二次放下成功', s2.ok === true, s2)
check('第二次不是再减半', after2 > 0.2 && after2 < 0.4, after2)
check('第二次 = 剩下的 2/3', Math.abs(after2 - 0.4 * 0.667) < 0.002, after2)

// ---------- 6. 第三次起不再减 ----------
const s3 = settleEmotion(db, aid, { note })
check('第三次不再减', s3.ok === false && s3.reason === 'already_flat', s3)

// ---------- 7. 不碰慢 / 快 ----------
const v3 = db.prepare('SELECT slow, fast, total FROM affect_v3 WHERE agent_id=?').get(aid)
check('慢情绪没被碰', Number(v3.slow) === 0.22, v3)
check('快情绪没被碰', Number(v3.fast) === 0.1, v3)
check('总情绪没被碰', Number(v3.total) === 0.25, v3)

// ---------- 8. 事件 ----------
const evs = db.prepare("SELECT payload FROM events WHERE agent_id=? AND type='affect.settle'").all(aid)
check('留了两条 affect.settle 事件', evs.length === 2, evs.length)
check('事件带 episode_id', evs.every((e) => JSON.parse(e.payload).episode_id === 'ep_settle'))

/* ───────── ⑨ 说话用的那份强度要跟着降 ─────────
   演练里抓到的坑：只降 episode 的话，我口头说放下了、句子还是短的。 */
const aid2 = 'agt_settle_state'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid2, '状态跟随', 'daily', 'active', new Date().toISOString())
db.prepare(`INSERT INTO affect_episodes(id, agent_id, cause, appraisal, label, intensity, resolution, started_at, ended_at, renewals, rise_from, rise_at)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run('ep_state', aid2, '你一点都不活', null, 'frustrated', 0.8, null, t0, null, 0, 0.2, t0)
db.prepare('INSERT OR REPLACE INTO affect_state(agent_id, primary_label, intensity, mood, pleasure, arousal, dominance, updated_at) VALUES(?,?,?,?,?,?,?,?)')
  .run(aid2, 'frustrated', 0.8, 0.4, 0, 0, 0, new Date().toISOString())
settleEmotion(db, aid2, { note: '他说我不活，我还在想这话是不是真的' })
check('说话用的强度跟着降', Number(db.prepare('SELECT intensity FROM affect_state WHERE agent_id=?').get(aid2).intensity) === 0.4)
db.prepare("INSERT OR REPLACE INTO affect_state(agent_id, primary_label, intensity, mood, pleasure, arousal, dominance, updated_at) VALUES(?,?,?,?,?,?,?,?)")
  .run(aid2, 'joy', 0.9, 0.7, 0, 0, 0, new Date().toISOString())
settleEmotion(db, aid2, { note: '再想一次那句，好像没那么扎了，但还是会想起来' })
const keep = db.prepare('SELECT primary_label, intensity FROM affect_state WHERE agent_id=?').get(aid2)
check('主情绪不是它时不误伤', keep.primary_label === 'joy' && Number(keep.intensity) === 0.9, keep)

console.log('')
console.log('通过 ' + pass + ' / ' + (pass + fail))
process.exit(fail ? 1 : 0)

