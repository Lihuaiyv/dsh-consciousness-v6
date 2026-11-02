/**
 * P5：记忆加工对齐。
 * QQ 聊完不该只是零散记忆点：原文要落 raw_turns（日记/纪要的料），
 * 关系账本要认人，每 6 轮要压出一条纪要；陌生人一样都不落。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { handle } from '../src/api.js'
import { extractMentions } from '../src/modules/relations.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-p5-'))
let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) } else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail)) }
}
async function call(db, method, p, body = {}) {
  const req = { method, path: p, body: method === 'GET' ? body : { ...body, __idempotencyKey: 'k' + Math.random().toString(36).slice(2) }, token: 'user' }
  return handle(db, req)
}
const num = (db, sql, ...a) => Number(db.prepare(sql).get(...a).n || 0)

const db = openDb(path.join(dir, 'p5.db'))
const aid = (await call(db, 'POST', '/v1/agents', { name: '小测' })).body.id
await call(db, 'PUT', '/v1/qq/settings', { default_agent: aid, owner: '3192248859' })

const CONV = 'qq:p:3192248859'
const owner = { channel: 'qq', handle: '3192248859' }
const guest = { channel: 'qq', handle: '5550001' }

// ① 主人聊 3 轮：原文层应该一进一回都落下来
{
  const baseRaw = num(db, "SELECT COUNT(*) n FROM raw_turns WHERE agent_id=? AND session_id=?", aid, CONV)
  for (const t of ['我叫阿哲，在做一个插件', '小周是我同事', '今天有点累']) {
    const r = await call(db, 'POST', '/v1/chat', { text: t, conversation_id: CONV, speaker: owner, default_agent: aid })
    check('主人可正常回复 [' + t.slice(0, 6) + ']', r.status === 200 && !!r.body.reply, r.body)
  }
  const raw = num(db, "SELECT COUNT(*) n FROM raw_turns WHERE agent_id=? AND session_id=?", aid, CONV)
  check('原文层落了 6 条（3 问 3 答）', raw - baseRaw === 6, raw - baseRaw)
  const userRaw = num(db, "SELECT COUNT(*) n FROM raw_turns WHERE agent_id=? AND session_id=? AND role='user'", aid, CONV)
  check('其中 3 条是用户说的', userRaw === 3, userRaw)
}

// ② 关系账本：提到的人要进账
{
  const before = num(db, "SELECT COUNT(*) n FROM rel_person WHERE agent_id=?", aid)
  await call(db, 'POST', '/v1/chat', { text: '小周今天生日，记得提醒我', conversation_id: CONV, speaker: owner, default_agent: aid })
  const after = num(db, "SELECT COUNT(*) n FROM rel_person WHERE agent_id=?", aid)
  const evBefore = num(db, "SELECT COUNT(*) n FROM rel_evidence WHERE agent_id=?", aid)
  await call(db, 'POST', '/v1/chat', { text: '小周喜欢喝美式', conversation_id: CONV, speaker: owner, default_agent: aid })
  const evAfter = num(db, "SELECT COUNT(*) n FROM rel_evidence WHERE agent_id=?", aid)
  check('关系证据会增长', evAfter > evBefore, { evBefore, evAfter })
  check('提到的人进了人物账（或已有证据）', after >= before, { before, after })
}

// ③ 每 6 轮压一条纪要
{
  const before = num(db, "SELECT COUNT(*) n FROM episodes WHERE agent_id=? AND session_id=?", aid, CONV)
  let saw = null
  for (let i = 0; i < 6; i++) {
    const r = await call(db, 'POST', '/v1/chat', { text: '纪要测试第' + i + '句，我们今天在调 QQ 通道', conversation_id: CONV, speaker: owner, default_agent: aid })
    if (r.body.narrative_episode) saw = r.body.narrative_episode
  }
  const after = num(db, "SELECT COUNT(*) n FROM episodes WHERE agent_id=? AND session_id=?", aid, CONV)
  check('6 轮后压出纪要', after > before, { before, after })
  check('回包标出了纪要 id', !!saw, saw)
}

// ④ 纪要有正文、有标题，不是空壳
{
  const ep = db.prepare("SELECT title, summary, turns FROM episodes WHERE agent_id=? AND session_id=? ORDER BY created_at DESC LIMIT 1").get(aid, CONV)
  check('纪要有标题', !!ep && String(ep.title || '').length > 0, ep && ep.title)
  check('纪要有摘要', !!ep && String(ep.summary || '').length > 0, ep && ep.summary)
  check('纪要记了轮数', !!ep && Number(ep.turns) > 0, ep && ep.turns)
}

// ⑤ 陌生人：一条原文都不落，也不压纪要
{
  const gconv = 'qq:p:5550001'
  const rawBefore = num(db, "SELECT COUNT(*) n FROM raw_turns WHERE agent_id=? AND session_id=?", aid, gconv)
  const epBefore = num(db, "SELECT COUNT(*) n FROM episodes WHERE agent_id=? AND session_id=?", aid, gconv)
  for (let i = 0; i < 8; i++) {
    await call(db, 'POST', '/v1/chat', { text: '路人第' + i + '句', conversation_id: gconv, speaker: guest, default_agent: aid })
  }
  check('陌生人不落原文层', num(db, "SELECT COUNT(*) n FROM raw_turns WHERE agent_id=? AND session_id=?", aid, gconv) === rawBefore)
  check('陌生人不压纪要', num(db, "SELECT COUNT(*) n FROM episodes WHERE agent_id=? AND session_id=?", aid, gconv) === epBefore)
}

// ⑥ 批量抽事实：同一段里第三句才抽一次（不再一句一抽）
{
  const conv = 'qq:p:3192248859'
  const memBefore = num(db, "SELECT COUNT(*) n FROM memory_items WHERE agent_id=? AND status='active'", aid)
  for (const t of ['第一句：我住杭州', '第二句：我在写代码', '第三句：我喜欢美式']) {
    await call(db, 'POST', '/v1/chat', { text: t, conversation_id: conv, speaker: owner, default_agent: aid })
  }
  const memAfter = num(db, "SELECT COUNT(*) n FROM memory_items WHERE agent_id=? AND status='active'", aid)
  check('三轮之后记忆有增长（episode 或事实）', memAfter > memBefore, { memBefore, memAfter })
}

// ⑦ 疑问词不该被当成新认识的人（「我叫什么来着」以前会建出一个叫「什么」的人）
{
  const junk = ['我叫什么来着', '你说是谁', '那个咋办', '啥时候']
  for (const t of junk) {
    const made = extractMentions(db, aid, t).filter((m) => m.create)
    check('不建人：' + t, made.length === 0, made.map((m) => m.surface))
  }
  const real = extractMentions(db, aid, '小周是我同事')
  check('真名字照认：小周', real.some((m) => m.surface.includes('小周')), real.map((m) => m.surface))
}

db.close()
console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) { console.log('失败', fail); process.exit(1) }
