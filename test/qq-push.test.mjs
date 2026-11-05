/**
 * 主动消息走 QQ：桥的 sendText 打通，发不出去不丢话，核对式的不发。
 * 运行：node test/qq-push.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { attachDb } from '../src/algo/index.js'
import { ownerChatKey, pushableLine, pushProactiveToQQ } from '../src/modules/qq_push.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name + '  ' + JSON.stringify(detail === undefined ? '' : detail).slice(0, 400)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-qqpush-'))
const db = openDb(path.join(dir, 'app.db'))
attachDb(db)
const aid = 'agt_qqpush'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid, '推送', 'daily', 'active', new Date().toISOString())

const addPending = (text) => {
  const id = 'prc_' + Math.random().toString(36).slice(2, 10)
  db.prepare("INSERT INTO proactive(id,agent_id,text,reason,dim,state,created_at) VALUES(?,?,?,?,?,?,?)")
    .run(id, aid, text, 'test', 'R', 'pending', new Date().toISOString())
  return id
}
const stateOf = (id) => db.prepare('SELECT state, delivered_at d FROM proactive WHERE id=?').get(id)

// ---- chatKey / 闸门 ----
check('QQ 号 → 私聊 chatKey', ownerChatKey('3192248859') === 'u:3192248859', ownerChatKey('3192248859'))
check('空号 → 空', ownerChatKey('') === '' && ownerChatKey(null) === '')
check('带符号也能归一', ownerChatKey('319-224-8859') === 'u:3192248859', ownerChatKey('319-224-8859'))
check('正常一句话可发', pushableLine('主人，有点想你了，最近还好吗？'))
check('核对式不发', !pushableLine('你先前说「A」，可后来又说「B」，到底哪个'))
check('前后不一不发', !pushableLine('这两句前后不一，我需要确认一下'))
check('太短不发', !pushableLine('嗯'))
check('太长不发', !pushableLine('很长'.repeat(120)))
check('JSON 不发', !pushableLine('{"a":1}'))

// ---- 发不出去的情况 ----
check('没桥 → no_bridge', (await pushProactiveToQQ({ db, aid, api: null, chatKey: 'u:1', line: '在吗', proactiveId: addPending('在吗') })).reason === 'no_bridge')
check('没目标 → no_target', (await pushProactiveToQQ({ db, aid, api: { sendText: async () => {} }, chatKey: '', line: '在吗', proactiveId: addPending('在吗') })).reason === 'no_target')
const badId = addPending('你先前说A可后来又说B')
const r0 = await pushProactiveToQQ({ db, aid, api: { sendText: async () => {} }, chatKey: 'u:1', line: '你先前说A可后来又说B', proactiveId: badId })
check('核对式被挡在发送前', r0.reason === 'not_pushable' && stateOf(badId).state === 'pending', r0)

// ---- 成功 ----
const calls = []
const api = { sendText: async (chatKey, text) => { calls.push({ chatKey, text }) } }
const okId = addPending('主人，有点想你了，最近还好吗？')
const r1 = await pushProactiveToQQ({ db, aid, api, chatKey: 'u:3192248859', line: '主人，有点想你了，最近还好吗？', proactiveId: okId })
check('发送成功', r1.ok === true, r1)
check('桥收到一次', calls.length === 1 && calls[0].chatKey === 'u:3192248859', calls)
check('发的是原文', calls[0] && calls[0].text.includes('有点想你了'), calls[0])
const st = stateOf(okId)
check('状态变成 delivered', st && st.state === 'delivered', st)
check('delivered_at 留空（等她真回话）', st && !st.d, st)
const ev = db.prepare("SELECT COUNT(*) n FROM events WHERE agent_id=? AND type='proactive.qq_pushed'").get(aid).n
check('记了一条推送事件', ev === 1, ev)
const turn = db.prepare("SELECT role, text, conversation_id FROM chat_turns WHERE agent_id=? ORDER BY created_at DESC LIMIT 1").get(aid)
check('本地账本也留了一条', turn && turn.role === 'agent' && String(turn.text).includes('有点想你了'), turn)
check('账本的 conversation_id 对得上', turn && turn.conversation_id === 'qq:p:3192248859', turn && turn.conversation_id)

// 同一条不会再发（state 不是 pending 了）
const r2 = await pushProactiveToQQ({ db, aid, api, chatKey: 'u:3192248859', line: '主人，有点想你了，最近还好吗？', proactiveId: okId })
check('发了的同一条不会再发', r2.reason === 'already' && calls.length === 1, { r2, calls: calls.length })

// ---- 桥抛错：话留在队列 ----
const boomId = addPending('主人，今天下雨了，记得带伞')
const r3 = await pushProactiveToQQ({
  db, aid, chatKey: 'u:3192248859', line: '主人，今天下雨了，记得带伞', proactiveId: boomId,
  api: { sendText: async () => { throw new Error('ws closed') } },
})
check('桥抛错 → send_failed', r3.reason === 'send_failed' && r3.error === 'ws closed', r3)
check('失败的话还在 pending', stateOf(boomId).state === 'pending', stateOf(boomId))

db.close()
console.log('\n通过 ' + pass + ' / ' + (pass + fail))
if (fail) { console.log('失败:', fail); process.exit(1) }
