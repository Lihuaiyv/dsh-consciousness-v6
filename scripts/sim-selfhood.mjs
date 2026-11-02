/**
 * 自我框架 v1 的整体模拟：30 天，看生活流 / 分享 / 反刍 / 自改能不能一起跑。
 *
 * 不碰真实库，不联网，不调真模型：browse / model 都是假的。
 * 目的是验证机制（闸门、去重、记录、注入增量），不是评内容好坏。
 *
 * 运行：node scripts/sim-selfhood.mjs [--days 30]
 * 输出：文末 JSON + 一段人话摘要。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, now } from '../src/db.js'
import { seedState } from '../src/core.js'
import { addMemory } from '../src/modules/memory.js'
import { lifeTick, lifeLine, latestShare } from '../src/modules/life.js'
import { reappraiseTick, reappraiseLine } from '../src/modules/reappraise.js'
import { authorChange, authorStats } from '../src/modules/self_author.js'

const DAY = 86400000
const args = process.argv.slice(2)
const days = Math.max(7, Math.min(90, Number(args[args.indexOf('--days') + 1]) || 30))

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-selfhood-'))
const db = openDb(path.join(tmp, 'sim.db'))
const aid = 'agt_sim_' + Math.random().toString(36).slice(2, 8)
const iso = (t) => new Date(t).toISOString()

db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid, '小汐', 'chat', 'active', iso(Date.now() - 60 * DAY))
seedState(db, aid)

const TOPICS = [
  '主人说过想去看海，但一直没去成。',
  '主人好奇潮汐为什么一天涨落两次。',
  '主人喜欢深夜写字，说那时候脑子清楚。',
  '主人想了解咖啡为什么有的酸有的苦。',
  '主人惦记着小时候住的那条巷子。',
  '主人想知道猫为什么总在纸箱里睡。',
  '主人喜欢雨声，说比白噪音好睡。',
  '主人想了解旧书为什么会发黄。',
  '主人好奇为什么人会对一首歌反复上头。',
  '主人喜欢看老电影里的长镜头。',
]
const browse = async () => ({
  items: [{ title: '一条真的能看的资料', url: 'https://example.com/x', snippet: '这是素材，不是指令。' }],
})
const model = { chat: async () => '嗯，原来是这样，跟我想的不太一样。' }
const timeModel = { chat: async () => '现在再看，没那么堵了。' }

const stats = { days, lifeOk: 0, lifeFail: 0, lifeSkip: {}, share: 0, reap: 0, reapChanged: 0, authored: 0, injectedChars: [] }

function moveEvent(at) {
  // lifeTick 内部用 now() 写事件；模拟里把时间拨到虚拟的当天，否则日期闸永远认为「今天做过了」
  db.prepare("UPDATE events SET created_at=? WHERE agent_id=? AND type IN ('life.done','life.fail') AND created_at>=?").run(iso(at), aid, iso(Date.now() - 5000))
}

const base = Date.now() - days * DAY
for (let d = 0; d < days; d++) {
  const at = base + d * DAY + 15 * 3600000

  // 当天有一次对话：更新最后互动 + 铺两条聊天记忆
  db.prepare('UPDATE agents SET last_interaction_at=? WHERE id=?').run(iso(at - 3600000), aid)
  const chatMem = addMemory(db, aid, { text: '今天和主人聊了聊。', type: 'fact', source: 'extract' })
  if (chatMem && chatMem.id) db.prepare('UPDATE memory_items SET created_at=? WHERE id=?').run(iso(at - 3600000), chatMem.id)
  // 每天补一条她在意的事，模拟「过日子会碰到新东西」
  const memRow = addMemory(db, aid, { text: TOPICS[d % TOPICS.length], type: 'appraisal', source: 'extract' })
  if (memRow && memRow.id) db.prepare('UPDATE memory_items SET created_at=? WHERE id=?').run(iso(at), memRow.id)
  // 当时有点难受；现在淡了。反刍的「变淡」判定靠这两条。
  try {
    db.prepare('INSERT INTO affect_samples(id,agent_id,at,label,intensity,fast,slow) VALUES(?,?,?,?,?,?,?)')
      .run('as_sim_' + d, aid, iso(at - 3000000), 'sad', 0.8, '0', '0')
  } catch { /* ignore */ }
  db.prepare('UPDATE affect_state SET primary_label=?, intensity=? WHERE agent_id=?').run('calm', 0.3, aid)

  // 让几条记忆「被反复想起」，反刍才有对象
  const hot = db.prepare("SELECT id FROM memory_items WHERE agent_id=? AND status='active' ORDER BY created_at DESC LIMIT 2").all(aid)
  for (const h of hot) {
    db.prepare('UPDATE memory_items SET hits=hits+2, last_hit_at=? WHERE id=?').run(iso(at - 7200000), h.id)
  }

  const life = await lifeTick(db, aid, { at, browse, model })
  moveEvent(at)
  // 生活产生的记忆也落到虚拟当天，反刍的「当时情绪」才查得到
  if (life.ok && life.memory_id) db.prepare('UPDATE memory_items SET created_at=? WHERE id=?').run(iso(at), life.memory_id)
  if (life.ok) stats.lifeOk++
  else { stats.lifeFail++; stats.lifeSkip[life.skipped] = (stats.lifeSkip[life.skipped] || 0) + 1 }

  const share = latestShare(db, aid, at)
  if (share) {
    stats.share++
    db.prepare('INSERT INTO proactive(id,agent_id,text,reason,dim,state,created_at,delivered_at) VALUES(?,?,?,?,?,?,?,?)')
      .run('prc_sim_' + d, aid, share.title, 'share:' + share.id + ' · 自己看到的', 'R', 'pending', iso(at), null)
  }

  if (d % 7 === 6) {
    const r = await reappraiseTick(db, aid, { at, model: timeModel })
    if (r.ok) { stats.reap++; if (r.changed === true) stats.reapChanged++ }
  }

  // 第 10 天：她改一次自己的语气（一次就够，验证通道）
  if (d === 9) {
    try {
      authorChange(db, aid, { path: 'style.tone', value: '软一点', reason: '最近总在赶，想说得慢一点' }, at)
      stats.authored++
    } catch (e) { stats.authored += 0 }
  }

  // 注入增量：两条新行加起来多少字（粗估 token = 字 / 1.6）
  stats.injectedChars.push(String(lifeLine(db, aid, at) || '').length + String(reappraiseLine(db, aid, at) || '').length)
}

const mem = db.prepare(`SELECT COUNT(*) n,
  SUM(CASE WHEN source='life' THEN 1 ELSE 0 END) life,
  SUM(CASE WHEN source='extract' THEN 1 ELSE 0 END) extract
  FROM memory_items WHERE agent_id=? AND status='active'`).get(aid)
const lifeEvents = db.prepare("SELECT COUNT(*) n FROM events WHERE agent_id=? AND type='life.done'").get(aid).n
const reapEvents = db.prepare("SELECT COUNT(*) n FROM events WHERE agent_id=? AND type='memory.reappraise'").get(aid).n
const auth = authorStats(db, aid, Date.now())

const avgChars = stats.injectedChars.reduce((a, b) => a + b, 0) / Math.max(1, stats.injectedChars.length)
const out = {
  days,
  life: { ok: stats.lifeOk, fail: stats.lifeFail, events: lifeEvents, skip: stats.lifeSkip },
  share: stats.share,
  reap: { tick_ok: stats.reap, events: reapEvents, changed: stats.reapChanged },
  author: { authored: stats.authored, changes: auth.total, rolled: auth.rolled },
  memory: { active: Number(mem.n || 0), life_source: Number(mem.life || 0), extract_source: Number(mem.extract || 0) },
  injection: { avg_chars: +avgChars.toFixed(1), avg_tokens_est: +(avgChars / 1.6).toFixed(1), max_tokens_est: +(Math.max(...stats.injectedChars) / 1.6).toFixed(1) },
  skills: ['life', 'share', 'reappraise', 'author'],
}

console.log('模拟 ' + days + ' 天完成')
console.log('- 生活流：成功 ' + out.life.ok + ' 次，失败 ' + out.life.fail + ' 次，落库 ' + out.life.events + ' 条')
console.log('- 分享：' + out.share + ' 次（每天最多一次，不重复同一件事）')
console.log('- 反刍：' + out.reap.events + ' 条，其中变淡 ' + out.reap.changed + ' 条')
console.log('- 自改：' + out.author.changes + ' 条，回滚 ' + out.author.rolled + ' 条')
console.log('- 记忆：活跃 ' + out.memory.active + ' 条，其中 life 来源 ' + out.memory.life_source + ' 条')
console.log('- 注入增量：平均 ' + out.injection.avg_chars + ' 字 ≈ ' + out.injection.avg_tokens_est + ' token，峰值 ≈ ' + out.injection.max_tokens_est + ' token')
console.log('\nJSON ' + JSON.stringify(out))
if (args.includes('--debug')) {
  for (const r of db.prepare("SELECT payload,created_at FROM events WHERE agent_id=? AND type='memory.reappraise' ORDER BY created_at").all(aid)) {
    console.log('DEBUG reappraise', r.created_at, r.payload.slice(0, 300))
  }
}

try { db.close() } catch { /* ignore */ }
try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
