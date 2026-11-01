/**
 * 概览「它的想法」：热度挑选 / 四问配额 / 冲突过滤 / 提前刷新 / POST
 * 运行：node test/thoughts.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, now } from '../src/db.js'
import { attachDb } from '../src/algo/index.js'
import { addMemory } from '../src/modules/memory.js'
import {
  pickMemories, getThoughts, generateNow, shouldRefresh, prompt, fallbackThoughts,
  cooldownHours,
} from '../src/modules/thoughts.js'
import { handle } from '../src/api.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 600)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-th-'))
const db = openDb(path.join(dir, 'app.db'))
attachDb(db)
const aid = 'agt_thoughts'
db.prepare("INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)")
  .run(aid, '想法人', 'daily', 'active', now())
db.prepare('INSERT INTO persona VALUES(?,?,?,?,?)').run(aid, 'style.address', JSON.stringify('阿明'), 'manual', now())

// ---- T0：过滤失效与冲突
{
  const ok = addMemory(db, aid, { text: '我喜欢安静', type: 'appraisal', importance: 0.8, salience: 0.6 })
  const bad = addMemory(db, aid, { text: '已失效的旧说法', type: 'fact', importance: 0.9 })
  db.prepare('UPDATE memory_items SET invalid_at=? WHERE id=?').run(now(), bad.id)
  const a = addMemory(db, aid, { text: '冲突边 A：讨厌辣', type: 'fact', importance: 0.7 })
  const b = addMemory(db, aid, { text: '冲突边 B：喜欢辣', type: 'fact', importance: 0.7 })
  db.prepare('INSERT INTO conflicts(id,agent_id,a_id,b_id,state,opened_at) VALUES(?,?,?,?,?,?)')
    .run('cf_th_1', aid, a.id, b.id, 'open', now())

  const picked = pickMemories(db, aid, 22, { you: '阿明' })
  const ids = new Set(picked.items.map((x) => x.id))
  check('失效记忆不进素材', !ids.has(bad.id), [...ids])
  check('冲突两侧不进素材', !ids.has(a.id) && !ids.has(b.id), [...ids])
  check('正常记忆能进', ids.has(ok.id), [...ids])
  check('banned 计数', picked.banned >= 2, picked.banned)
  check('total 不含冲突条', picked.total === picked.scanned - picked.banned || picked.total <= picked.scanned - 2, {
    total: picked.total, scanned: picked.scanned, banned: picked.banned,
  })
}

// ---- T0：locked + heat 优先；band 有配额
{
  const locked = addMemory(db, aid, { text: '钉住：永远叫我阿明', type: 'fact', importance: 0.2 })
  db.prepare("UPDATE memory_items SET mark='locked', importance=0.2 WHERE id=?").run(locked.id)
  const oldLong = addMemory(db, aid, { text: '很久以前的小事一', type: 'fact', importance: 0.05 })
  db.prepare('UPDATE memory_items SET created_at=?, last_hit_at=?, hits=0 WHERE id=?')
    .run(new Date(Date.now() - 400 * 86400000).toISOString(), new Date(Date.now() - 400 * 86400000).toISOString(), oldLong.id)

  const picked = pickMemories(db, aid, 10, { you: '阿明' })
  check('钉住优先进列', picked.items[0] && picked.items[0].id === locked.id, picked.items.slice(0, 3).map((x) => x.text))
  const bands = {}
  for (const it of picked.items) bands[it.band] = (bands[it.band] || 0) + 1
  check('有 band 字段', picked.items.every((x) => x.band), bands)
}

// ---- T1：四问桶有代表（有足够材料时）
{
  addMemory(db, aid, { text: '我今天心情有点乱', type: 'appraisal', importance: 0.8, salience: 0.7 })
  addMemory(db, aid, { text: '阿明不喜欢被催', type: 'fact', importance: 0.85 })
  addMemory(db, aid, { text: '外面下雨了路很滑', type: 'episode', importance: 0.6 })
  addMemory(db, aid, { text: '答应下周一起整理文档', type: 'fact', importance: 0.9 })
  const picked = pickMemories(db, aid, 22, { you: '阿明', relNames: ['阿明'] })
  const buckets = new Set(picked.items.map((x) => x.bucket).filter(Boolean))
  check('四问定向至少沾上两桶', ['self', 'other', 'world', 'want'].filter((k) => buckets.has(k)).length >= 2, [...buckets])
  check('取材有上限不重复', picked.items.length <= 22 && new Set(picked.items.map((x) => x.id)).size === picked.items.length, picked.items.length)
  const withName = pickMemories(db, aid, 22, { you: '阿明', relNames: ['阿明'] })
  check('other 桶要具体称呼', withName.items.some((x) => x.bucket === 'other' && /阿明/.test(x.text)), withName.items.filter((x) => x.bucket === 'other').map((x) => x.text))
}

// ---- T1：prompt 文案与截断
{
  const ctx = {
    name: '想法人', days: 3, mode: '日常模式', you: '阿明',
    affect: { label: 'calm', intensity: 0.2 }, drive: { band: 'idle', D: 0.1 },
    relations: [{ name: '阿明', kind: 'owner', closeness: 0.8 }],
    mems: [
      { text: '短记忆', type: '事实', band: 'short', bucket: 'self', text_long: null },
      { text: 'x'.repeat(200), type: '经过', band: 'long', bucket: 'world' },
    ],
    total: 2, diaries: ['- 2026-10-30：今天有点闷'], episodes: [{ day: '2026-10-30', title: '聊雨', summary: '说了路滑', open_loops: ['带伞'] }],
  }
  // fix mems shape
  ctx.mems = [
    { text: '短记忆', type: '事实', band: 'short', bucket: 'self' },
    { text: 'x'.repeat(200), type: '经过', band: 'long', bucket: 'world' },
  ]
  const p = prompt(ctx)
  check('prompt 不再谎称只按权重', !/分层 \+ 权重 \+ 近期/.test(p.text) && /热度账本/.test(p.text), p.text.slice(0, 200))
  check('prompt 含日记与纪要', /近几天日记/.test(p.text) && /未了/.test(p.text), p.text)
  check('prompt 有轻哲学指引', /我是谁/.test(p.system) && /不要引经据典/.test(p.system), p.system.slice(0, 200))
  check('long band 截断更短', p.text.includes('x'.repeat(60)) && !p.text.includes('x'.repeat(90)), true)
  const fb = fallbackThoughts({ you: '阿明' })
  check('fallback 四段', fb.self && fb.other.includes('阿明') && fb.world && fb.want, fb)
}

// ---- T2：日记 / 纪要进 gather（经 generate 链路用 prompt 验证库内数据）
{
  const day = now().slice(0, 10)
  db.prepare(`INSERT INTO diaries(id,agent_id,day,text,mood,highlights,refs,source,version,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
    .run('dy_th_1', aid, day, '标题\n今天把书桌擦了一遍，心里安静一点。', 'calm', '[]', '{}', 'rules', 1, now(), now())
  db.prepare(`INSERT INTO episodes(id,agent_id,session_id,day,seg,title,summary,topics,beats,mood,open_loops,importance,hits,source,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run('ep_th_1', aid, 'sess_th', day, 0, '擦桌子', '擦完觉得清爽', '[]', '[]', 'calm',
      JSON.stringify(['下次整理抽屉']), 0.6, 0, 'rules', now())

  const v = await generateNow(db, aid)
  check('生成四段齐全', v.items && v.items.length === 4 && v.items.every((i) => i.text), v.items)
  check('生成后状态新鲜', v.status === 'fresh', v.status)
  check('称呼标签', v.items[1].label === '它眼中的阿明', v.items[1].label)

  const row = db.prepare('SELECT payload FROM thoughts WHERE agent_id=? ORDER BY created_at DESC LIMIT 1').get(aid)
  let payload = null
  try { payload = JSON.parse(row.payload) } catch { /* 无 */ }
  check('写入 payload 快照', payload && payload.address === '阿明' && payload.affect_label !== undefined, payload)
}

// ---- T3：提前刷新
{
  const latest = db.prepare('SELECT * FROM thoughts WHERE agent_id=? ORDER BY created_at DESC LIMIT 1').get(aid)
  check('周期内默认不刷', shouldRefresh(db, aid, latest).stale === false, shouldRefresh(db, aid, latest))

  db.prepare("UPDATE persona SET value=? WHERE agent_id=? AND path='style.address'").run(JSON.stringify('小柯'), aid)
  const byAddr = shouldRefresh(db, aid, latest)
  check('改称呼触发刷新', byAddr.stale === true && byAddr.reason === 'address', byAddr)
  // 改回，避免后续干扰
  db.prepare("UPDATE persona SET value=? WHERE agent_id=? AND path='style.address'").run(JSON.stringify('阿明'), aid)

  db.prepare('UPDATE thoughts SET created_at=? WHERE id=?')
    .run(new Date(Date.now() - 40 * 86400000).toISOString(), latest.id)
  const aged = db.prepare('SELECT * FROM thoughts WHERE id=?').get(latest.id)
  check('过期触发刷新', shouldRefresh(db, aid, aged).reason === 'interval', shouldRefresh(db, aid, aged))

  // 冷却期内：高热不刷
  db.prepare('UPDATE thoughts SET created_at=? WHERE id=?')
    .run(new Date(Date.now() - 2 * 3600000).toISOString(), latest.id)
  const hot = addMemory(db, aid, { text: '刚发生：约好明天见面', type: 'fact', importance: 0.95, salience: 0.8 })
  db.prepare('UPDATE memory_items SET created_at=? WHERE id=?')
    .run(new Date(Date.now() - 500).toISOString(), hot.id)
  const cooled = shouldRefresh(db, aid, db.prepare('SELECT * FROM thoughts WHERE id=?').get(latest.id))
  check('冷却期内高热不刷', cooled.stale === false, { cooled, cooldownH: cooldownHours() })

  // 过冷却（25h）但未到 30 天周期：高热应刷
  db.prepare('UPDATE thoughts SET created_at=? WHERE id=?')
    .run(new Date(Date.now() - 25 * 3600000).toISOString(), latest.id)
  const byHeat = shouldRefresh(db, aid, db.prepare('SELECT * FROM thoughts WHERE id=?').get(latest.id))
  check('过冷却后高热触发', byHeat.stale === true && byHeat.reason === 'heat', byHeat)
}

// ---- T3：GET 过期会 generating；POST 强制重想
{
  db.prepare('UPDATE thoughts SET created_at=? WHERE agent_id=?')
    .run(new Date(Date.now() - 40 * 86400000).toISOString(), aid)
  const g = getThoughts(db, aid)
  check('GET 过期进入 generating/stale', g.status === 'generating' || g.status === 'stale', g.status)

  const post = await handle(db, {
    method: 'POST', path: '/v1/agents/' + aid + '/thoughts',
    body: { __idempotencyKey: 'th-post-1' }, token: 'user',
  })
  check('POST /thoughts 200', post.status === 200 && post.body && post.body.items && post.body.items.length === 4, post)
  check('POST 后新鲜', post.body.status === 'fresh', post.body.status)
}

// ---- F：POST 不双跑 + 只留最近 20 条
{
  // 塞 25 条旧想法，再 generateNow → 应 prune 到 ≤20
  const stamp = Date.now()
  for (let i = 0; i < 25; i++) {
    db.prepare('INSERT INTO thoughts(id,agent_id,self_text,other_text,world_text,want_text,other_label,source,created_at,payload) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run('th_old_' + i, aid, 's', 'o', 'w', 't', '阿明', 'rules',
        new Date(stamp - (30 - i) * 60000).toISOString(), JSON.stringify({ address: '阿明' }))
  }
  await generateNow(db, aid)
  const n = db.prepare('SELECT COUNT(*) c FROM thoughts WHERE agent_id=?').get(aid).c
  check('想法只留最近 20 条', n <= 20, n)

  // GET kick 异步后立刻 POST：应复用同一 inflight，净增至多 1 条（再被 prune 压回 ≤20）
  db.prepare('UPDATE thoughts SET created_at=? WHERE agent_id=?')
    .run(new Date(Date.now() - 40 * 86400000).toISOString(), aid)
  const before = db.prepare('SELECT COUNT(*) c FROM thoughts WHERE agent_id=?').get(aid).c
  getThoughts(db, aid)
  const reused = await generateNow(db, aid)
  const after = db.prepare('SELECT COUNT(*) c FROM thoughts WHERE agent_id=?').get(aid).c
  check('POST 复用 inflight 后仍新鲜', reused.status === 'fresh' && reused.items.length === 4, reused)
  check('POST 不双跑（条数不暴涨）', after <= Math.max(before + 1, 20), { before, after })
}

console.log('\n' + pass + ' passed, ' + fail + ' failed')
if (fail) process.exit(1)
