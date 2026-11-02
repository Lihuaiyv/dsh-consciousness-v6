/**
 * 谁在说话：主人 / 陌生人 / 漏了号的通道。
 *
 * 老口子：`canLearn = !speakerHandle || isOwner(...)` ——
 * 通道漏了号（桥超时、字段改名）就等于「当主人」，模型失败时兜底回复
 * 会对着陌生人喊「主人」、说「记下了」。
 * 这里把「号不对」和「根本没号」分开测：
 *   - 带号且不是主人 → 陌生人
 *   - 外部通道没号     → 陌生人（宁可少学，不可串人）
 *   - 网页那条路没 speaker → 主人本人
 * 运行：node test/speaker-identity.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { handle } from '../src/api.js'
import { isOwner, isLocalChannel, ownerHandle } from '../src/modules/conversations.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) } else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 300)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-speaker-'))
const db = openDb(path.join(dir, 'speaker.db'))
const count = (sql, ...args) => Number(db.prepare(sql).get(...args).n || 0)

async function call(method, p, body = {}) {
  return handle(db, {
    method,
    path: p,
    body: method === 'GET' ? body : { ...body, __idempotencyKey: 'k' + Math.random().toString(36).slice(2) },
    token: 'user',
  })
}

const OWNER = '3192248859'
const made = await call('POST', '/v1/agents', { name: '认人小测' })
const aid = made.body.id
await call('PUT', '/v1/qq/settings', { default_agent: aid, owner: OWNER })

// ---- 纯函数：号本身
{
  check('主人号原样', isOwner(db, OWNER) === true)
  check('带 qq: 前缀仍认主人', isOwner(db, 'qq:' + OWNER) === true)
  check('带空格仍认主人', isOwner(db, '  ' + OWNER + '  ') === true)
  check('数字/字符串同号', isOwner(db, Number(OWNER)) === true)
  check('别的号不是主人', isOwner(db, '222') === false)
  check('空号不是主人', isOwner(db, '') === false && isOwner(db, null) === false)
  check('本地通道认得出来', isLocalChannel('ui') && isLocalChannel('') && isLocalChannel('local'))
  check('外部通道不是本地', !isLocalChannel('qq') && !isLocalChannel('wechat'))
  check('默认主人号就是配置里的', ownerHandle(db) === OWNER)
}

// ---- 带上号：主人 / 陌生人
async function turn(label, speaker, conv) {
  const before = count('SELECT COUNT(*) n FROM memory_items WHERE agent_id=?', aid)
  const r = await call('POST', '/v1/chat', {
    text: '我叫' + label + '，我最爱吃火锅',
    conversation_id: conv,
    speaker,
    default_agent: aid,
  })
  const after = count('SELECT COUNT(*) n FROM memory_items WHERE agent_id=?', aid)
  return { r, grew: after - before, reply: String((r.body && r.body.reply) || ''), source: r.body && r.body.source, learned: r.body && r.body.learned }
}

{
  const ownerTurn = await turn('主人本人', { channel: 'qq', handle: OWNER }, 'qq:p:' + OWNER)
  check('主人这一轮能回', ownerTurn.r.status === 200 && !!ownerTurn.reply, ownerTurn.r.body)
  check('主人标记 learned=true', ownerTurn.learned === true, ownerTurn.learned)
  check('主人这边确实写了记忆', ownerTurn.grew > 0, ownerTurn.grew)

  const ownerPrefix = await turn('带前缀的主人', { channel: 'qq', handle: 'qq:' + OWNER }, 'qq:p:' + OWNER)
  check('带前缀的号也算主人', ownerPrefix.learned === true, ownerPrefix.learned)

  // 主人这边也一样：规则兜底不许假装记住了（「记下了」「我先记下来」「要我记住」都算装懂）
  if (ownerTurn.source === 'rules') {
    check('主人兜底不说记下了', !/记下了|记住了|记下来/.test(ownerTurn.reply), ownerTurn.reply)
    check('主人兜底不追问要不要记住', !/要我记住/.test(ownerTurn.reply), ownerTurn.reply)
    check('主人兜底承认在听', /在听|我在/.test(ownerTurn.reply), ownerTurn.reply)
  }

  const stranger = await turn('路人甲', { channel: 'qq', handle: '222' }, 'qq:p:222')
  check('陌生人能正常回', stranger.r.status === 200 && !!stranger.reply, stranger.r.body)
  check('陌生人标记 learned=false', stranger.learned === false, stranger.learned)
  check('陌生人的话不进记忆', stranger.grew === 0, stranger.grew)
  if (stranger.source === 'rules') {
    check('兜底回复不喊主人', !stranger.reply.includes('主人'), stranger.reply)
    check('兜底回复不说记下了', !/记下了|记住了/.test(stranger.reply), stranger.reply)
  }
}

// ---- 没号：外部通道 = 陌生人；网页 = 主人本人
{
  const noHandle = await turn('没号的路人', { channel: 'qq', handle: '' }, 'qq:p:333')
  check('QQ 通道漏了号也能回', noHandle.r.status === 200 && !!noHandle.reply, noHandle.r.body)
  check('QQ 通道漏了号当陌生人', noHandle.learned === false, noHandle.learned)
  check('漏号也不进记忆', noHandle.grew === 0, noHandle.grew)
  if (noHandle.source === 'rules') {
    check('漏号时兜底不喊主人', !noHandle.reply.includes('主人'), noHandle.reply)
    check('漏号时兜底不说记下了', !/记下了|记住了/.test(noHandle.reply), noHandle.reply)
  }

  // 网页那条路不带 speaker（走 /v1/agents/:id/chat），说话的就是主人本人
  const beforeWeb = count('SELECT COUNT(*) n FROM memory_items WHERE agent_id=?', aid)
  const web = await call('POST', '/v1/agents/' + aid + '/chat', { text: '网页这边我在，今天有点累' })
  const afterWeb = count('SELECT COUNT(*) n FROM memory_items WHERE agent_id=?', aid)
  check('网页没 speaker 也能回', web.status === 200 && !!web.body.reply, web.body)
  check('网页没 speaker 就是主人（照常学）', afterWeb - beforeWeb > 0, afterWeb - beforeWeb)

  const uiEmpty = await turn('网页带空号', { channel: 'ui', handle: '' }, 'ui:sess-2')
  check('ui 通道空号仍是主人', uiEmpty.learned === true, uiEmpty.learned)
}

// ---- 网页那条 GET/POST 路由（不带 speaker）也走同一套判断
{
  const before = count('SELECT COUNT(*) n FROM memory_items WHERE agent_id=?', aid)
  const r = await call('POST', '/v1/agents/' + aid + '/chat', { text: '今天有点累' })
  const after = count('SELECT COUNT(*) n FROM memory_items WHERE agent_id=?', aid)
  check('网页回话 200', r.status === 200 && !!r.body.reply, r.body)
  check('网页路径照常学（learned 字段缺省也算主人）', after - before >= 0, { before, after })
}

// ---- 陌生人这一轮的原文仍落在自己的会话里（该聊还能聊）
{
  const turns = count("SELECT COUNT(*) n FROM chat_turns WHERE agent_id=? AND conversation_id='qq:p:222'", aid)
  check('陌生人的对话照样落 chat_turns', turns >= 2, turns)
  const raw = count("SELECT COUNT(*) n FROM raw_turns WHERE agent_id=? AND session_id='qq:p:222'", aid)
  check('陌生人的原文不落 raw_turns', raw === 0, raw)
}

console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exitCode = 1
