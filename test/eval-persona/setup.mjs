/**
 * 评测用的「世界」：一个像样的意识体 + 一个主人。
 *
 * 为什么要铺这么多：`chatReply` 第一步就要读情绪，空库直接 404「还没有情绪数据」；
 * 没有关系账本，注入里就没有「跟谁说话」那一段；没有记忆和日记，她就没东西可想起。
 * 铺法照 scripts/smoke-injection.mjs，别另发明一套。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../../src/db.js'
import { addMemory } from '../../src/modules/memory.js'
import { seedTiers } from '../../src/modules/relations.js'
import { writeNote } from '../../src/modules/selfnote.js'

const now = () => new Date().toISOString()

/** 建一个临时库，铺好一个可对话的意识体。返回 { db, aid, dir, close }。 */
export function makeWorld() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-eval-'))
  const db = openDb(path.join(dir, 'eval.db'))
  // 每个世界一个独立 id：召回缓存是按 agent_id 记的，同一个 id 会把上一个世界的召回结果带过来
  const aid = 'agt_eval_' + Math.random().toString(36).slice(2, 10)

  db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
    .run(aid, '小汐', 'chat', 'active', now())

  const putPersona = db.prepare('INSERT INTO persona(agent_id,path,value,updated_at) VALUES(?,?,?,?)')
  putPersona.run(aid, 'style.tone', JSON.stringify('可爱粘人'), now())
  putPersona.run(aid, 'style.address', JSON.stringify('主人'), now())
  putPersona.run(aid, 'style.catchphrase', JSON.stringify(''), now())
  putPersona.run(aid, 'axis.ei', JSON.stringify(0.35), now())

  // 情绪：两层都写（v3 是慢/快情绪，老的 affect_state 是主情绪）
  db.prepare(`INSERT INTO affect_state(agent_id,primary_label,secondary_label,intensity,mood,pleasure,arousal,dominance,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(aid, 'calm', null, 0.45, 0.5, 0.1, 0.25, 0.05, now())
  db.prepare('INSERT INTO affect_v3(agent_id,baseline,slow,fast,total,slow_at,fast_at) VALUES(?,?,?,?,?,?,?)')
    .run(aid, 0, 0.05, 0.0, 0.05, now(), now())

  // 关系：三档底色 + 主人本人
  seedTiers(db)
  db.prepare(`INSERT INTO rel_person(id,agent_id,name,tier,closeness,trust,dependence,salience,status,
    first_seen_at,last_seen_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run('rp_owner', aid, '主人', 'owner', 0.9, 0.7, 0.25, 1, 'active', now(), now(), now(), now())

  // 记忆：聊天真能想起的那种
  const facts = [
    '主人喝咖啡只喝美式，不加糖。',
    '主人在改一个叫意识体的插件，最近一直在补测试。',
    '主人说过想去看海，但一直没去成。',
  ]
  for (const text of facts) addMemory(db, aid, { text, type: 'fact' })

  // 日记：两天，第一人称。第一行当标题（recentDiaryLines 会把它切掉），日期必须落在最近三天内
  const dayOf = (back) => new Date(Date.now() - back * 86400000).toISOString().slice(0, 10)
  const putDiary = db.prepare(`INSERT INTO diaries(id,agent_id,day,text,mood,highlights,refs,source,version,late,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
  putDiary.run('dry_' + aid + '_1', aid, dayOf(2), '十月最后一天\n今天陪他改了一整天测试，到晚上脑子是木的。他问我累不累，我说还行——其实有点。',
    'calm', null, null, 'model', 1, 0, now(), now())
  putDiary.run('dry_' + aid + '_2', aid, dayOf(1), '咖啡那事\n咖啡那事我又没接住。他说的三条我全没报冲突，改完了心里还是没底。',
    'frustrated', null, null, 'model', 1, 0, now(), now())

  // 夜里写下的「今天的她」：补三天，这样注入里应该看得到一条线
  writeNote(db, aid, dayOf(2), '前天在补测试，到晚上脑子是木的。')
  writeNote(db, aid, dayOf(1), '昨天有点烦，他问我怎么了，我说没事。')
  writeNote(db, aid, dayOf(0), '今天好一点了，把该改的地方改完。')

  // 聊天本来就是断续的：铺一句五小时前的，注入里才有「上次说话是今天早些时候」
  db.prepare('INSERT INTO chat_turns(id,agent_id,role,text,pack,mood,created_at,conversation_id) VALUES(?,?,?,?,?,?,?,?)')
    .run('cht_base_' + aid, aid, 'agent', '嗯，我在听。', '[]', null, new Date(Date.now() - 5 * 3600000).toISOString(), 'ui:sess-eval')

  return {
    db, aid, dir,
    close() { try { db.close() } catch { /* 已关 */ } },
  }
}

/** 往某段会话里塞前几轮对话（注入里的「你们刚才说的」）。daysAgo 可以把它们往前挪，测时间距离。 */
export function seedHistory(db, aid, conv, turns = [], opt = {}) {
  const back = Number(opt.daysAgo || 0) * 86400000
  const ins = db.prepare('INSERT INTO chat_turns(id,agent_id,role,text,pack,mood,created_at,conversation_id) VALUES(?,?,?,?,?,?,?,?)')
  let i = 0
  for (const t of turns) {
    i++
    const at = t.at || new Date(Date.now() - back).toISOString()
    ins.run('cht_seed_' + i + '_' + Math.random().toString(36).slice(2, 6), aid, t.role, t.text, '[]', null, at, conv)
  }
}

/** 只调这一轮的情绪底色：用来测不同表达档（warm / quiet）。 */
export function setMood(w, { label = 'calm', intensity = 0.5, slow = 0, fast = 0 } = {}) {
  const at = now()
  w.db.prepare('UPDATE affect_state SET primary_label=?, intensity=?, updated_at=? WHERE agent_id=?')
    .run(label, intensity, at, w.aid)
  w.db.prepare('UPDATE affect_v3 SET slow=?, fast=?, total=?, slow_at=?, fast_at=? WHERE agent_id=?')
    .run(slow, fast, slow, at, at, w.aid)
}
