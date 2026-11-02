/**
 * 整体联调（在线上库副本上跑，不动真库）：
 * ① 多轮上下文 ② 原文/纪要/关系/记忆加工 ③ 通道健康 ④ 会话改绑 ⑤ 陌生人隔离
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { handle } from '../src/api.js'

const LIVE = path.join(os.homedir(), '.dsh', 'consciousness')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-e2e2-'))
for (const s of ['', '-wal', '-shm']) {
  const src = path.join(LIVE, 'app.db' + s)
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, 'app.db' + s))
}
const db = openDb(path.join(dir, 'app.db'))

let pass = 0; let fail = 0
const check = (n, ok, d) => { if (ok) { pass++; console.log('PASS', n) } else { fail++; console.log('FAIL', n, d === undefined ? '' : JSON.stringify(d)) } }
async function call(method, p, body = {}) {
  const req = { method, path: p, body: method === 'GET' ? body : { ...body, __idempotencyKey: 'k' + Math.random().toString(36).slice(2) }, token: 'user' }
  return handle(db, req)
}
const num = (sql, ...a) => Number(db.prepare(sql).get(...a).n || 0)

const A = (await call('POST', '/v1/agents', { name: '甲' })).body.id
const B = (await call('POST', '/v1/agents', { name: '乙' })).body.id
await call('PUT', '/v1/qq/settings', { default_agent: A, owner: '3192248859', history_turns: 8, recall_items: 10 })

const OWNER = { channel: 'qq', handle: '3192248859' }
const OCONV = 'qq:p:3192248859'
const S = { channel: 'qq', handle: '76001' }
const SCONV = 'qq:p:76001'

// ① 多轮 + 原文 + 纪要
{
  let last = null
  for (let i = 1; i <= 8; i++) {
    last = await call('POST', '/v1/chat', { text: '第' + i + '句：我叫阿灯，在调 QQ 通道', conversation_id: OCONV, speaker: OWNER, default_agent: A })
  }
  check('主人多轮：带满 16 条历史', last.body.history_used === 16, last.body.history_used)
  check('主人多轮：learned 仍为 true', last.body.learned === true, last.body.learned)
  check('原文层一进一出都落了', num("select count(*) n from raw_turns where session_id=?", OCONV) === 16, num("select count(*) n from raw_turns where session_id=?", OCONV))
  check('8 轮压出了纪要', num("select count(*) n from episodes where session_id=?", OCONV) >= 1, num("select count(*) n from episodes where session_id=?", OCONV))
}

// ② 陌生人：只聊不学、不落原文、不压纪要
{
  let last = null
  for (let i = 1; i <= 6; i++) {
    last = await call('POST', '/v1/chat', { text: '路人第' + i + '句', conversation_id: SCONV, speaker: S, default_agent: A })
  }
  check('陌生人 learned=false', last.body.learned === false, last.body.learned)
  check('陌生人拿不到意识体包', last.body.context_chars === 0, last.body.context_chars)
  check('陌生人只带 2 轮', last.body.history_used <= 4, last.body.history_used)
  check('陌生人不落原文', num("select count(*) n from raw_turns where session_id=?", SCONV) === 0, num("select count(*) n from raw_turns where session_id=?", SCONV))
  check('陌生人不压纪要', num("select count(*) n from episodes where session_id=?", SCONV) === 0)
  check('陌生人不写记忆', num("select count(*) n from memory_items where agent_id=? and text like '%路人第%'", A) === 0, num("select count(*) n from memory_items where agent_id=? and text like '%路人第%'", A))
}

// ③ 改绑：这段换到乙，甲的记忆不串
{
  const b = await call('POST', '/v1/conversations/bind', { conversation_id: SCONV, agent_id: B, handle: '76001' })
  check('改绑成功并带角色名', b.body.agent_name === '乙', b.body)
  const r = await call('POST', '/v1/chat', { text: '换人了？', conversation_id: SCONV, speaker: S, default_agent: A })
  check('改绑后由乙回', r.body.agent_id === B, r.body.agent_id)
  check('乙说话仍不算主人', r.body.learned === false, r.body.learned)
  const rel = await call('DELETE', '/v1/conversations/' + encodeURIComponent(SCONV))
  check('释放成功', rel.body.released === 1, rel.body)
  const back = await call('POST', '/v1/chat', { text: '回来了', conversation_id: SCONV, speaker: S, default_agent: A })
  check('释放后回默认甲', back.body.agent_id === A, back.body.agent_id)
}

// ④ 通道健康（真桥）
{
  process.env.DSHC_BRIDGE = 'http://127.0.0.1:3100'
  const h = await call('GET', '/v1/qq/health')
  check('健康接口通', h.status === 200 && typeof h.body.ok === 'boolean', h.body.ok)
  check('QQ 在线', h.body.ok === true && !!h.body.napcat.nickname, h.body.napcat)
  delete process.env.DSHC_BRIDGE
}

// ⑤ 设置项
{
  const s = (await call('GET', '/v1/qq/settings')).body
  check('设置里有多轮与召回', s.history_turns === 8 && s.recall_items === 10, s)
}

db.close()
fs.rmSync(dir, { recursive: true, force: true })
console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exit(1)
