/**
 * P4：多轮上下文 + 召回条数。
 * - 设置项可读可写、有上下限
 * - 同一段会话会把最近几轮带给模型（history_used 增长，封顶 8 轮）
 * - 陌生人只带 2 轮，防串话
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { handle } from '../src/api.js'
import { recentHistory } from '../src/features.js'
import { replyMessages, buildReplySystem } from '../src/model.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-p4-'))
let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) } else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail)) }
}
async function call(db, method, p, body = {}) {
  const req = { method, path: p, body: method === 'GET' ? body : { ...body, __idempotencyKey: 'k' + Math.random().toString(36).slice(2) }, token: 'user' }
  return handle(db, req)
}
const db = openDb(path.join(dir, 'p4.db'))
const made = await call(db, 'POST', '/v1/agents', { name: '小测' })
const aid = made.body.id
await call(db, 'PUT', '/v1/qq/settings', { default_agent: aid, owner: '3192248859' })

// ① 设置项：默认值 + 上下限
{
  const s0 = (await call(db, 'GET', '/v1/qq/settings')).body
  check('默认带 8 轮历史', s0.history_turns === 8, s0.history_turns)
  check('默认召回 10 条', s0.recall_items === 10, s0.recall_items)
  const s1 = (await call(db, 'PUT', '/v1/qq/settings', { history_turns: 99, recall_items: 1 })).body
  check('轮数封顶 20', s1.history_turns === 20, s1.history_turns)
  check('召回有下限 3', s1.recall_items === 3, s1.recall_items)
  const s2 = (await call(db, 'PUT', '/v1/qq/settings', { history_turns: -5, recall_items: 99 })).body
  check('轮数有下限 0', s2.history_turns === 0, s2.history_turns)
  check('召回封顶 20', s2.recall_items === 20, s2.recall_items)
  await call(db, 'PUT', '/v1/qq/settings', { history_turns: 8, recall_items: 10 })
}

// ② 同一段会话：第一句没有历史，之后逐句变多，封顶 16 条
{
  const conv = 'qq:p:3192248859'
  const first = await call(db, 'POST', '/v1/chat', {
    text: '第一句', conversation_id: conv, speaker: { channel: 'qq', handle: '3192248859' }, default_agent: aid,
  })
  check('第一句不带历史', first.body.history_used === 0, first.body.history_used)
  for (let i = 2; i <= 6; i++) {
    await call(db, 'POST', '/v1/chat', {
      text: '第' + i + '句', conversation_id: conv, speaker: { channel: 'qq', handle: '3192248859' }, default_agent: aid,
    })
  }
  const seventh = await call(db, 'POST', '/v1/chat', {
    text: '第七句', conversation_id: conv, speaker: { channel: 'qq', handle: '3192248859' }, default_agent: aid,
  })
  check('第二句起带历史', (await call(db, 'POST', '/v1/chat', {
    text: '第八句', conversation_id: conv, speaker: { channel: 'qq', handle: '3192248859' }, default_agent: aid,
  })).body.history_used > 0)
  check('历史随轮次增长', seventh.body.history_used >= 4, seventh.body.history_used)
}

// ③ 封顶：主人这段聊到 20 句，最多 16 条（8 轮）
{
  const conv = 'qq:p:3192248859'
  let last = null
  for (let i = 1; i <= 20; i++) {
    last = await call(db, 'POST', '/v1/chat', {
      text: '连续第' + i + '句', conversation_id: conv, speaker: { channel: 'qq', handle: '3192248859' }, default_agent: aid,
    })
  }
  check('最多带 16 条（8 轮）', last.body.history_used <= 16, last.body.history_used)
  check('接近封顶（>12 条）', last.body.history_used > 12, last.body.history_used)
}

// ④ 陌生人：只带 2 轮
{
  const conv = 'qq:p:8880002'
  let last = null
  for (let i = 1; i <= 10; i++) {
    last = await call(db, 'POST', '/v1/chat', {
      text: '路人第' + i + '句', conversation_id: conv, speaker: { channel: 'qq', handle: '8880002' }, default_agent: aid,
    })
  }
  check('陌生人只带 4 条（2 轮）', last.body.history_used <= 4, last.body.history_used)
  check('陌生人确实带了少量历史', last.body.history_used > 0, last.body.history_used)
  check('陌生人仍然不学', last.body.learned === false, last.body.learned)
}

// ⑤ 关掉历史后不再带
{
  await call(db, 'PUT', '/v1/qq/settings', { history_turns: 0 })
  const r = await call(db, 'POST', '/v1/chat', {
    text: '关掉历史后', conversation_id: 'qq:p:3192248859', speaker: { channel: 'qq', handle: '3192248859' }, default_agent: aid,
  })
  check('history_turns=0 时不带历史', r.body.history_used === 0, r.body.history_used)
  await call(db, 'PUT', '/v1/qq/settings', { history_turns: 8 })
}

// ⑥ recentHistory 直接测：顺序、条数、空会话
{
  const rows = recentHistory(db, aid, 'qq:p:3192248859', 8)
  check('recentHistory 返回数组', Array.isArray(rows), rows && rows.length)
  check('recentHistory 条数为偶数（一问一答）', rows.length % 2 === 0, rows.length)
  check('最旧的在前', rows.length ? String(rows[0].role) === 'user' : true, rows[0])
  check('不存在的会话返回空', recentHistory(db, aid, 'qq:p:none', 8).length === 0)
  check('rounds=0 返回空', recentHistory(db, aid, 'qq:p:3192248859', 0).length === 0)
}

// ⑦ 真正喂给模型的消息序列：system → 历史（交替）→ 当前这句
{
  const msgs = replyMessages({
    text: '现在这句',
    history: [
      { role: 'user', text: '我叫阿哲' },
      { role: 'assistant', text: '记住了' },
      { role: 'user', text: '我叫什么' },
      { role: 'assistant', text: '阿哲' },
    ],
  })
  check('第一条是 system', msgs[0].role === 'system', msgs[0].role)
  check('历史按顺序在中间', msgs[1].content === '我叫阿哲' && msgs[2].role === 'assistant' && msgs[3].content === '我叫什么', msgs.map((m) => m.role))
  check('最后一条是当前这句', msgs[msgs.length - 1].content === '现在这句', msgs[msgs.length - 1])
  check('历史条数正确', msgs.length === 6, msgs.length)
  const long = replyMessages({ text: 'x', history: [{ role: 'user', text: 'A'.repeat(600) }] })
  check('单条历史封顶 300', long[1].content.length <= 300, long[1].content.length)
  check('没有历史时只有两条', replyMessages({ text: 'x' }).length === 2, replyMessages({ text: 'x' }).length)
}

// ⑧ 宿主模型那条路：历史压成文本进 system（assistant 消息会报 replayState）
{
  const hist = [{ role: 'user', text: '我叫阿哲' }, { role: 'assistant', text: '记住了' }]
  const sysHost = buildReplySystem({ text: '我叫什么', history: hist, historyInSystem: true })
  check('宿主路径把历史写进 system', sysHost.includes('我叫阿哲') && sysHost.includes('记住了'), sysHost.slice(-160))
  check('历史有明确标题', sysHost.includes('你们刚才说的'), sysHost.slice(-160))
  check('你 / 我 两种标号都在', sysHost.includes('你：我叫阿哲') && sysHost.includes('我：记住了'), sysHost.slice(-160))
  const sysOpenai = buildReplySystem({ text: '我叫什么', history: hist })
  check('非宿主路径不重复塞 system', !sysOpenai.includes('我叫阿哲'), sysOpenai.slice(-120))
  const sysEmpty = buildReplySystem({ text: 'x', history: [], historyInSystem: true })
  check('没历史时不加空段', !sysEmpty.includes('你们刚才说的'), sysEmpty.slice(-80))
}

db.close()
console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) { console.log('失败', fail); process.exit(1) }
