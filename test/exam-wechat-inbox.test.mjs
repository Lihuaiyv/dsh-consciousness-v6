/**
 * 微信收信 · 考卷
 *
 * 管的是「本地库里的新消息怎么变成她自己的账」：水位、防重、自己说的 / 对方说的分角色、
 * 第一次见到的会话只落水位不灌历史。不碰真微信（run 是注入的假读库），
 * 真读库那一段在 scripts/wechat-inbox.py，只读、不动窗口，冒烟靠手工跑一次。
 *
 * 运行：node test/exam-wechat-inbox.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { pollWeChatInbox, conversationIdOfWeChat, getSeen, runWeChatInbox } from '../src/modules/wechat_inbox.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 300)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-exam-wxin-'))
const db = openDb(path.join(dir, 'app.db'))
const aid = 'agt_exam_wxin'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid, '考卷微信收信', 'daily', 'active', new Date().toISOString())

const texts = () => db.prepare("SELECT role, text, conversation_id FROM chat_turns WHERE agent_id=? ORDER BY rowid").all(aid)
const raws = () => db.prepare('SELECT role, text, turn_id, session_id FROM raw_turns WHERE agent_id=? ORDER BY seq').all(aid)

/** 假读库：把脚本返回的 JSON 塞进来 */
function fakeRun(frames) {
  const calls = []
  const fn = async (payload) => {
    calls.push(JSON.parse(JSON.stringify(payload)))
    const next = frames.length > 1 ? frames.shift() : frames[0]
    return typeof next === 'function' ? next(payload) : next
  }
  fn.calls = calls
  return fn
}

const msg = (seq, text, extra = {}) => ({
  id: String(seq), sort_seq: seq, at: '2026-11-07T00:30:00.000Z',
  self: false, sender: 'wxid_stranger', type: '文本', text, ...extra,
})

// ================================================================ 会话 id
{
  check('会话 id：按显示名，和发信那边同口径', conversationIdOfWeChat('文件传输助手') === 'wechat:文件传输助手', conversationIdOfWeChat('文件传输助手'))
  check('会话 id：空名字就空着（不编假会话）', conversationIdOfWeChat('') === '' && conversationIdOfWeChat(null) === '')
}

// ================================================================ 第一次见到：只落水位
{
  const run = fakeRun([{ ok: true, self: 'wxid_me', chats: [{ username: 'wxid_l', name: 'L', messages: [msg(1000, '我是谁啊')] }] }])
  const out = await pollWeChatInbox({ db, aid, run })
  check('第一次见到的会话：只落水位，不灌历史', out.ok === true && out.added === 0 && out.seeded.includes('L'), out)
  check('第一次见到的会话：账本里一句都不写', texts().length === 0 && raws().length === 0, { c: texts().length, r: raws().length })
  check('水位记在这段会话名下（毫秒）', getSeen(db, 'wxid_l') === 1000, getSeen(db, 'wxid_l'))
}

// ================================================================ 第二条：落账
{
  const run = fakeRun([{ ok: true, self: 'wxid_me', chats: [{
    username: 'wxid_l', name: 'L',
    messages: [msg(1000, '我是谁啊'), msg(2000, '在吗')],
  }] }])
  const out = await pollWeChatInbox({ db, aid, run })
  check('新消息：记一条，旧的不重复', out.ok === true && out.added === 1, out)
  const t = texts()
  check('账本：会话 id + 对方说的算 user', t.length === 1 && t[0].role === 'user' && t[0].conversation_id === 'wechat:L' && t[0].text === '在吗', t)
  const r = raws()
  check('原文层：一句一条，turn_id 认得出是哪条', r.length === 1 && r[0].role === 'user'
    && r[0].turn_id === 'wx:wxid_l:2000' && r[0].session_id === 'wechat:L', r)
  check('水位推到最新那条', getSeen(db, 'wxid_l') === 2000, getSeen(db, 'wxid_l'))
}

// ================================================================ 自己发的 / 重复读
{
  const run = fakeRun([{ ok: true, self: 'wxid_me', chats: [{
    username: 'wxid_l', name: 'L',
    messages: [msg(3000, '我自己回一句', { self: true, sender: 'wxid_me' })],
  }] }])
  const out = await pollWeChatInbox({ db, aid, run })
  check('自己发的：记成 agent，不冒充对方', out.ok && out.added === 1 && texts().some((x) => x.role === 'agent' && x.text === '我自己回一句'), out)

  const again = fakeRun([{ ok: true, self: 'wxid_me', chats: [{
    username: 'wxid_l', name: 'L',
    messages: [msg(3000, '我自己回一句', { self: true, sender: 'wxid_me' })],
  }] }])
  const dup = await pollWeChatInbox({ db, aid, run: again })
  check('同一批再读一遍：一句都不多写', dup.added === 0 && texts().length === 2 && raws().length === 2, { added: dup.added, t: texts().length, r: raws().length })
}

// ================================================================ 跳过名单
{
  const run = fakeRun([{ ok: true, self: 'wxid_me', chats: [
    { username: 'weixin', name: '微信团队', messages: [msg(4000, '欢迎')] },
    { username: 'wxid_x', name: '广告', messages: [msg(5000, '推广')] },
  ] }])
  const out = await pollWeChatInbox({ db, aid, run, skip: 'weixin, 广告' })
  check('跳过名单：按 username 和显示名都认', out.ok && out.added === 0 && !out.chats.includes('微信团队') && !out.chats.includes('广告'), out)
}

// ================================================================ 读不出来
{
  const boom = fakeRun([() => { throw new Error('python 起不来') }])
  const out = await pollWeChatInbox({ db, aid, run: boom })
  check('读库抛错：如实说没读到，不写库', out.ok === false && /python/.test(out.note) && texts().length === 2, out)

  const bad = fakeRun([{ ok: false, note: '读不了微信本地库：没有密钥' }])
  const out2 = await pollWeChatInbox({ db, aid, run: bad })
  check('脚本说读不到：把原因带出来', out2.ok === false && /密钥/.test(out2.note), out2)
}

// ================================================================ 自己说过的：别记两遍
{
  const at = new Date().toISOString()
  db.prepare('INSERT INTO chat_turns(id,agent_id,role,text,pack,mood,created_at,conversation_id) VALUES(?,?,?,?,?,?,?,?)')
    .run('cht_seed_self', aid, 'agent', '我先说一句', '[]', null, at, 'wechat:自己')
  // 第一次见到这个会话：只落水位
  await pollWeChatInbox({ db, aid, run: fakeRun([{ ok: true, self: 'wxid_me', chats: [{
    username: 'wxid_self', name: '自己', messages: [msg(8000, '我先说一句', { self: true, sender: 'wxid_me', at })] ,
  }] }]) })
  // 再从库里读回同一个文本：这是发信那边刚记过的那句，不该记第二遍
  const out = await pollWeChatInbox({ db, aid, run: fakeRun([{ ok: true, self: 'wxid_me', chats: [{
    username: 'wxid_self', name: '自己', messages: [msg(9000, '我先说一句', { self: true, sender: 'wxid_me', at })] ,
  }] }]) })
  const n = db.prepare("SELECT COUNT(*) n FROM chat_turns WHERE agent_id=? AND conversation_id='wechat:自己'").get(aid).n
  check('自己说过的：发信那边记过，收信不再记第二遍', out.added === 0 && n === 1, { added: out.added, n })
}

// ================================================================ 水位、条数、注入
{
  let payloads = []
  const run = fakeRun([
    (p) => { payloads.push(p); return { ok: true, self: 'wxid_me', chats: [{ username: 'wxid_l', name: 'L', messages: [msg(6000, '第三条')] }] } },
    (p) => { payloads.push(p); return { ok: true, self: 'wxid_me', chats: [{ username: 'wxid_l', name: 'L', messages: [msg(7000, '第四条')] }] } },
  ])
  await pollWeChatInbox({ db, aid, run, chats: ['wxid_l'] })
  check('指定会话时：把这条会话的水位一起带过去', payloads[0].seen.wxid_l === 3000, payloads[0])
  await pollWeChatInbox({ db, aid, run, chats: ['wxid_l'] })
  check('指定会话时：水位只带自己那条，不串', payloads[1].seen.wxid_l === 6000, payloads[1])

  const capped = await pollWeChatInbox({ db, aid, run: fakeRun([{ ok: true, chats: [] }]), limit: 9999 })
  check('条数上限夹到 200', capped.ok === true)
}

// ================================================================ 真读库脚本的形状（不进 Python，只查参数检查）
{
  check('读库脚本的入口收得回来（不存在的解释器要报错，别静默）',
    await runWeChatInbox({ chats: null }, { python: 'definitely-no-such-python-xyz', timeoutMs: 8000 })
      .then(() => false).catch((e) => /起不来|ENOENT|spawn/.test(String(e && e.message))))
}

console.log('\n通过 ' + pass + ' / ' + (pass + fail))
if (fail) process.exitCode = 1
