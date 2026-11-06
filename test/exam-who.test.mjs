/**
 * 考卷 · 认人（who）
 * 运行：node test/exam-who.test.mjs
 *
 * 管：这条消息是谁说的——通道绑了谁就是谁、没绑才落到主人、都没有就 null。
 * 不管：关系怎么变（关系动力）、这句话像不像她。
 * 它要钉住的是「同一件事只留一条判断」，别让编排层和入账层各认各的。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { bootstrap, commit, ownerPerson } from '../src/modules/relations.js'
import { whoIsSpeaking } from '../src/modules/who.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name + '  ' + JSON.stringify(detail === undefined ? '' : detail).slice(0, 400)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-exam-who-'))
const db = openDb(path.join(dir, 'app.db'))
const iso = new Date().toISOString()
let seq = 0
function mkAgent() {
  seq++
  const aid = 'agt_who_' + seq
  db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,?)')
    .run(aid, '认人考卷' + seq, 'chat', 'active', iso, 13)
  return aid
}

const AID = mkAgent()
bootstrap(db, AID)
const owner = ownerPerson(db, AID)
commit(db, AID, {
  kind: 'seed', source: 'system', text: 'wz', fingerprint: 'who:test:wz',
  mutations: [{ op: 'person.create', person: { name: '文钊', tier: 'acquaintance', graph_visible: true, closeness: 0.3, trust: 0.4, dependence: 0.05 } }],
})
const wz = db.prepare("SELECT * FROM rel_person WHERE agent_id=? AND name='文钊'").get(AID)
commit(db, AID, {
  kind: 'seed', source: 'system', text: 'wz ch', fingerprint: 'who:test:wz:ch',
  mutations: [{ op: 'channel.register', person_id: wz.id, channel: 'qq', handle: '123', confidence: 0.9 }],
})

// ---------------- 1 通道绑了谁就是谁 ----------------
{
  const p = whoIsSpeaking(db, AID, { channel: 'qq', handle: '123' })
  check('QQ 123 认成文钊', p && p.id === wz.id && p.name === '文钊', p)
  check('来源标通道', p && p.source === 'channel', p && p.source)
  check('带着人物行（亲近/信任都在）', p && Number.isFinite(Number(p.closeness)) && Number.isFinite(Number(p.trust)), p)
  check('层级一起带出来', p && p.tier === 'acquaintance', p && p.tier)
}

// ---------------- 2 没绑的通道落到主人 ----------------
{
  const p = whoIsSpeaking(db, AID, { channel: 'qq', handle: '999' })
  check('没绑过的 QQ 落到主人', p && p.id === owner.id && p.name === '主人', p)
  check('来源标主人', p && p.source === 'owner', p && p.source)
}

// ---------------- 3 默认通道（ui / local）认主人 ----------------
{
  const p = whoIsSpeaking(db, AID)
  check('默认 ui/local 认主人', p && p.id === owner.id, p)
}

// ---------------- 4 精确匹配，不许模糊撞 ----------------
{
  check('handle 只差一位不串', whoIsSpeaking(db, AID, { channel: 'qq', handle: '12' }).id === owner.id)
  check('channel 不同不串', whoIsSpeaking(db, AID, { channel: 'wecom', handle: '123' }).id === owner.id)
}

// ---------------- 5 两个 agent 不串 ----------------
{
  const B = mkAgent()
  bootstrap(db, B)
  const pb = whoIsSpeaking(db, B, { channel: 'qq', handle: '123' })
  const ob = ownerPerson(db, B)
  check('B 的 qq/123 认成 B 的主人', pb && pb.id === ob.id && pb.name === '主人', pb)
}

// ---------------- 6 谁都没有 → null（调用方自己降级） ----------------
{
  const C = mkAgent()
  check('没有人物时返回 null', whoIsSpeaking(db, C) === null)
}

console.log('\n通过 ' + pass + ' / ' + (pass + fail))
if (fail) process.exitCode = 1
