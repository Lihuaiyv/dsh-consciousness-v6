/**
 * 整体模拟：三段 QQ 会话（主人 + 两个陌生人）跑完，验证
 *   会话隔离 / 绑定 / 记忆闸 / 上下文预算。
 * 默认复制真实 app.db 来跑（不写线上库）；没有就新建空库。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { handle } from '../src/api.js'
import { attachContextBlock } from '../src/features.js'

const live = path.join(os.homedir(), '.dsh', 'consciousness', 'app.db')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-e2e-'))
let db
if (fs.existsSync(live)) {
  const dst = path.join(dir, 'app.db')
  fs.copyFileSync(live, dst)
  for (const ext of ['-wal', '-shm']) if (fs.existsSync(live + ext)) fs.copyFileSync(live + ext, dst + ext)
  db = openDb(dst)
} else {
  db = openDb(path.join(dir, 'fresh.db'))
}

async function call(method, p, body = {}) {
  const req = { method, path: p, body: method === 'GET' ? body : { ...body, __idempotencyKey: 'sim' + Math.random().toString(36).slice(2) }, token: 'user' }
  const r = await handle(db, req)
  if (r.status !== 200) throw new Error(p + ' -> ' + JSON.stringify(r.body))
  return r.body
}

// 找一个可用的意识体：优先小汐，没有就建一个
let aid = null
try { aid = db.prepare("SELECT id FROM agents WHERE status='active' AND name='小汐' LIMIT 1").get()?.id } catch { /* 空库 */ }
if (!aid) aid = (await call('POST', '/v1/agents', { name: '小汐' })).id
const agent = db.prepare('SELECT name FROM agents WHERE id=?').get(aid)?.name || aid
// 独立脚本没有宿主提示词：挂一个桩，验证「主人有包、陌生人没包」这条路径
attachContextBlock((d, id) => '## 意识体：' + (d.prepare('SELECT name FROM agents WHERE id=?').get(id)?.name || '') + '\n' + 'X'.repeat(300))

const memCount = () => Number(db.prepare('SELECT COUNT(*) n FROM memory_items WHERE agent_id=?').get(aid).n)
const turnCount = (conv) => Number(db.prepare('SELECT COUNT(*) n FROM chat_turns WHERE agent_id=? AND conversation_id=?').get(aid, conv).n)

const owner = '3192248859'
const convs = {
  owner: `qq:p:${owner}`,
  a: 'qq:p:90001',
  b: 'qq:p:90002',
}
const sends = [
  { conv: convs.owner, handle: owner, text: '我今天在调记忆检索，有点累' },
  { conv: convs.owner, handle: owner, text: '晚上想喝点热的东西' },
  { conv: convs.a, handle: '90001', text: '你好，你叫什么名字？' },
  { conv: convs.a, handle: '90001', text: '你平时喜欢做什么' },
  { conv: convs.b, handle: '90002', text: '在吗，今天天气不错' },
  { conv: convs.b, handle: '90002', text: '你会记住我吗' },
]

const before = memCount()
const convBefore = {
  [convs.owner]: turnCount(convs.owner),
  [convs.a]: turnCount(convs.a),
  [convs.b]: turnCount(convs.b),
}
const rows = []
for (const s of sends) {
  const m0 = memCount()
  const out = await call('POST', '/v1/chat', {
    text: s.text, conversation_id: s.conv,
    speaker: { channel: 'qq', handle: s.handle }, default_agent: aid,
  })
  rows.push({
    conv: s.conv,
    learned: out.learned,
    ctx: out.context_chars,
    source: out.source,
    memDelta: memCount() - m0,
    reply: String(out.reply || '').slice(0, 60),
  })
}
const after = memCount()

const convRows = db.prepare("SELECT conversation_id, agent_id, handle, state FROM conversations WHERE conversation_id IN (?,?,?) ORDER BY conversation_id")
  .all(convs.owner, convs.a, convs.b)
const leaked = db.prepare(`SELECT conversation_id, COUNT(*) n FROM chat_turns
  WHERE agent_id=? AND conversation_id IS NOT NULL GROUP BY conversation_id`).all(aid)

console.log(JSON.stringify({
  agent,
  memory: { before, after },
  perTurn: rows,
  conversations: convRows,
  turnsByConversation: leaked,
  isolation: {
    ownerTurns: turnCount(convs.owner),
    strangerATurns: turnCount(convs.a),
    strangerBTurns: turnCount(convs.b),
  },
}, null, 1))

// 断言：主人学、陌生人不学；每段账独立；上下文只给主人
const ownerLearned = rows.filter((r) => r.conv === convs.owner).every((r) => r.learned === true && r.ctx > 0)
const strangerSilent = rows.filter((r) => r.conv !== convs.owner).every((r) => r.learned === false && r.ctx === 0)
const strangerNoMaster = rows.filter((r) => r.conv !== convs.owner)
  .every((r) => !r.reply.includes('主人') && !r.reply.startsWith('记下了'))
const isolated = ['owner', 'a', 'b'].every((k) => turnCount(convs[k]) - convBefore[convs[k]] === 4) // 2 句 × (user+agent)
const targetConvs = Object.values(convs)
const noCross = leaked.filter((x) => targetConvs.includes(x.conversation_id)).length === 3
const ok = ownerLearned && strangerSilent && strangerNoMaster && isolated && noCross && convRows.length === 3
console.log(ok ? '\nE2E OK：主人学、陌生人不学/不叫主人、三段账各自独立、上下文只给主人' : '\nE2E FAIL')
db.close()
process.exit(ok ? 0 : 1)
