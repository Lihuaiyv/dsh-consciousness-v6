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
import { bootstrap, commit, ownerPerson, ingest, bumpRelation } from '../src/modules/relations.js'
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

// ---------------- 7 关系入账 / 关系动力也走这一条 ----------------
// 以前这两处各写一份：入账先通道后主人，动力兜底反过来先主人；
// 这条钉住的是「问谁在说话的地方只剩一处」。
{
  const D = mkAgent()
  bootstrap(db, D)
  const oD = ownerPerson(db, D)
  commit(db, D, {
    kind: 'seed', source: 'system', text: 'wz-d', fingerprint: 'who:test:wzd',
    mutations: [{ op: 'person.create', person: { name: '文钊丙', tier: 'acquaintance', graph_visible: true, closeness: 0.3, trust: 0.4, dependence: 0.05 } }],
  })
  const wz3 = db.prepare("SELECT * FROM rel_person WHERE agent_id=? AND name='文钊丙'").get(D)
  commit(db, D, {
    kind: 'seed', source: 'system', text: 'wz-d ch', fingerprint: 'who:test:wzd:ch',
    mutations: [{ op: 'channel.register', person_id: wz3.id, channel: 'qq', handle: '456', confidence: 0.9 }],
  })

  // 入账：QQ 456 说的这一句，touch 落文钊丙，不落主人
  ingest(db, D, { text: '今天有点累', channel: 'qq', handle: '456' })
  const wz3a = db.prepare('SELECT * FROM rel_person WHERE id=?').get(wz3.id)
  const oDa = db.prepare('SELECT * FROM rel_person WHERE id=?').get(oD.id)
  check('入账按通道记到文钊丙', !!wz3a.last_talk_at && !oDa.last_talk_at, { wz: wz3a.last_talk_at, owner: oDa.last_talk_at })

  // 动力记账：不传人时也先看通道（以前这里主人优先，正好反了）
  commit(db, D, {
    kind: 'seed', source: 'system', text: 'wz-d ui', fingerprint: 'who:test:wzd:ui',
    mutations: [{ op: 'channel.register', person_id: wz3.id, channel: 'ui', handle: 'local', confidence: 0.9 }],
  })
  const c0 = Number(wz3a.closeness)
  const rel = bumpRelation(db, D, { v: 0.8, kind: 'praise', label: 'joy', reason: '考卷：不传人' })
  const wz3b = db.prepare('SELECT * FROM rel_person WHERE id=?').get(wz3.id)
  const oDb = db.prepare('SELECT * FROM rel_person WHERE id=?').get(oD.id)
  check('动力记账不传人：先看通道，记给文钊丙', rel && rel.person_id === wz3.id && Number(wz3b.closeness) > c0, rel)
  check('主人没被顺手加亲近', Number(oDb.closeness) === Number(oD.closeness), { was: oD.closeness, now: oDb.closeness })
}

console.log('\n通过 ' + pass + ' / ' + (pass + fail))
if (fail) process.exitCode = 1
