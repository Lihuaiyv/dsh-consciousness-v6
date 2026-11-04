/**
 * 整体功能模拟（本阶段）：QQ 通道 → 回话余量 → Shadow 只读观测。
 *
 * 跑法：node scripts/sim-shadow-qq.mjs
 *
 * 验的是「这几块拼在一起」：
 *   1. QQ 主人的回话会留下关系余量（偏冷才记），陌生人不记；
 *   2. Shadow 聚合能把这些余量读出来（记录 / 提示 / 结算 / 冷热分布）；
 *   3. 结算默认关，打开后也要冷样本够数才小步动三轴；
 *   4. 记忆来源与低置信度按 active + 未失效统计；
 *   5. 空库/空会话不炸，计数是 0 而不是 null。
 *
 * 用临时真库（openDb 建全表），不写线上库；不 mock 业务函数，只 mock 宿主 ctx.on。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { openDb } from '../src/db.js'
import { handle } from '../src/api.js'
import { writeParam } from '../src/kernel.js'
import { attachQQIngest } from '../src/modules/qq_bridge.js'
import { shadowReport, settleSelfResidue, recordReplyResidue } from '../src/modules/self_residue.js'

const OWNER_QQ = '3192248859'
const OWNER_CHAT = 'u:' + OWNER_QQ
const OWNER_CONV = 'qq:p:' + OWNER_QQ
const STRANGER_CHAT = 'u:10001'

let pass = 0
let fail = 0
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)) }
}

const tmpDirs = []
function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-shadow-sim-'))
  tmpDirs.push(dir)
  const db = openDb(path.join(dir, 'app.db'))
  return db
}

async function newAgent(db, name) {
  const r = await handle(db, { method: 'POST', path: '/v1/agents', body: { name, __idempotencyKey: 'a' + Math.random().toString(36).slice(2) }, token: 'user' })
  if (r.status !== 200) throw new Error('建 agent 失败: ' + JSON.stringify(r.body))
  return r.body.id
}

function makeCtx() {
  const handlers = new Map()
  return {
    on(id, fn) { handlers.set(id, fn); return () => handlers.delete(id) },
    effect(cb) { return cb() },
    fire(id, payload) { const fn = handlers.get(id); if (fn) fn(payload) },
  }
}

function boot() {
  const db = freshDb()
  const ctx = makeCtx()
  const params = { 'qq.bridge.enable': 'on', 'qq.bridge.owner_qq': OWNER_QQ, 'qq.bridge.ingest': 'on' }
  const ingest = attachQQIngest({
    getCtx: () => ctx,
    getDb: () => db,
    getAid: () => AID,
    param: (k) => params[k],
    log: () => {},
  })
  return { db, ctx, ingest }
}

let AID = ''
const residueRows = (db) => db.prepare("SELECT payload FROM events WHERE agent_id=? AND type='rel.self_residue'").all(AID)
  .map((r) => JSON.parse(r.payload))

function round(ctx, { chatKey, messageId, text, reply }) {
  ctx.fire('qqbridge:inbound', { chatKey, userId: Number(String(chatKey).slice(2)) || 0, messageId, text, at: Date.now() })
  ctx.fire('qqbridge:outbound', { chatKey, kind: 'text', text: reply, batches: 1, mode: 'text', at: Date.now() })
}

// ---------------------------------------------------------------- 1. 主人：6 句常态 + 1 句偏冷
let mainDb = null
{
  const { db, ctx } = boot()
  mainDb = db
  AID = await newAgent(db, '小汐')
  // 给 QQ 落库一个真实的情绪标签来源
  db.prepare('INSERT OR REPLACE INTO affect_state(agent_id,primary_label,updated_at) VALUES(?,?,?)')
    .run(AID, 'calm', new Date().toISOString())

  for (let i = 0; i < 6; i++) {
    round(ctx, {
      chatKey: OWNER_CHAT, messageId: 'warm' + i, text: '在吗 ' + i,
      reply: '今天还挺好的，放松了哈哈，第' + i + '句。',
    })
  }
  const beforeCold = residueRows(db).length
  round(ctx, {
    chatKey: OWNER_CHAT, messageId: 'cold1', text: '你怎么了',
    reply: '算了，没什么好说的，随便吧。',
  })
  const rows = residueRows(db)
  check('常态回话不记余量（没偏就不写）', beforeCold === 0, { beforeCold })
  check('偏冷那一句记了 1 条', rows.length === 1, rows)
  check('冷的方向与负偏差', rows[0] && rows[0].dir === 'cold' && Number(rows[0].delta) < 0, rows[0])

  const rep = shadowReport(db, AID, { days: 7 })
  check('Shadow 余量：记录 1', rep.residue.recorded === 1, rep.residue.recorded)
  check('Shadow 余量：冷 1 暖 0', rep.residue.by_dir.cold === 1 && rep.residue.by_dir.warm === 0, rep.residue.by_dir)
  check('Shadow 余量：还没提示过', rep.residue.shown === 0, rep.residue.shown)
  check('Shadow 开关：记录开、结算关', rep.residue.recording === true && rep.residue.settling === false, rep.residue)
  const off = settleSelfResidue(db, AID)
  check('结算默认关：不动三轴', off.skipped === 'settle-off', off)

  const moods = db.prepare("SELECT mood FROM chat_turns WHERE agent_id=? AND role='agent'").all(AID)
  check('QQ 回话落了情绪标签（不是 null）', moods.length === 7 && moods.every((m) => !!m.mood), moods)

  // 打开结算 → 冷样本只有 1 条，应该 below
  writeParam(db, AID, 'relation.selfresidue.settle', 'on')
  const settled = settleSelfResidue(db, AID)
  check('结算打开但样本不足 → below，不动三轴', settled.settled === 0 && settled.skipped === 'below', settled)

  // 再补两句偏冷 → 满 3 条、累计 ≤ -1.2 才结算
  recordReplyResidue(db, AID, '算了，别问了，我不想说。', { conv: OWNER_CONV })
  recordReplyResidue(db, AID, '随便你吧，我无所谓。', { conv: OWNER_CONV })
  const settled2 = settleSelfResidue(db, AID)
  check('冷样本满 3 条 → 结算 1 次', settled2.settled >= 1 && settled2.dir === 'cold', settled2)
  check('结算只动一点点（v=-0.08）', settled2.v === -0.08, settled2)
  const rep2 = shadowReport(db, AID, { days: 7 })
  check('Shadow 能读到这次结算', rep2.residue.settled >= 1 && rep2.residue.last_settle && rep2.residue.last_settle.dir === 'cold', rep2.residue.last_settle)
}

// ---------------------------------------------------------------- 2. 陌生人：不记余量
{
  const { db, ctx } = boot()
  AID = await newAgent(db, '小汐')
  for (let i = 0; i < 6; i++) {
    round(ctx, {
      chatKey: STRANGER_CHAT, messageId: 's' + i, text: '你好 ' + i,
      reply: '今天还挺好的，放松了哈哈，第' + i + '句。',
    })
  }
  round(ctx, {
    chatKey: STRANGER_CHAT, messageId: 'scold', text: '你是不是机器人',
    reply: '算了，没什么好说的，随便吧。',
  })
  check('陌生人的回话不记余量', residueRows(db).length === 0, residueRows(db))
  const rep = shadowReport(db, AID, { days: 7 })
  check('陌生人会话也不会被 Shadow 误算成主人', rep.residue.recorded === 0, rep.residue.recorded)
}

// ---------------------------------------------------------------- 3. 记忆来源 / 低置信度
{
  const db = freshDb()
  AID = await newAgent(db, '小汐')
  const ins = db.prepare(`INSERT INTO memory_items(
    id,agent_id,type,text,source,w0,weight,stability,difficulty,last_decay_at,valid_at,invalid_at,status,created_at,confidence)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  const t = new Date().toISOString()
  const add = (id, text, source, confidence, status, invalidAt) => ins.run(
    id, AID, 'fact', text, source, 0.5, 0.5, 1.0, 5.0, t, t, invalidAt, status, t, confidence,
  )
  add('m1', '从聊天记下的', 'extract', 0.9, 'active', null)
  add('m2', '我猜的', 'reflect', 0.3, 'active', null)
  add('m3', '手动写的', 'manual', 0.8, 'active', null)       // 正常置信度：不算低
  add('m4', '已删掉的', 'extract', 0.1, 'forgotten', null)   // 非 active：不算
  add('m5', '已失效的', 'extract', 0.1, 'active', t)         // 已失效：不算
  const rep = shadowReport(db, AID, { days: 7 })
  const bySrc = Object.fromEntries(rep.memory.by_source.map((x) => [x.source, x.n]))
  check('记忆只统计 active 且未失效', rep.memory.total === 3, rep.memory)
  check('低置信只算 confidence<0.55 且有值', rep.memory.low_confidence === 1, rep.memory.low_confidence)
  check('按来源分组正确', bySrc.extract === 1 && bySrc.reflect === 1 && bySrc.manual === 1, bySrc)
}

// ---------------------------------------------------------------- 4. 空库 / 无事件
{
  const db = freshDb()
  AID = await newAgent(db, '小汐')
  const rep = shadowReport(db, AID, { days: 7 })
  check('空库不炸：余量全 0', rep.residue.recorded === 0 && rep.residue.shown === 0 && rep.residue.settled === 0, rep.residue)
  check('空库不炸：内心行全 0、丢弃率 null', rep.mind.committed === 0 && rep.mind.dropped === 0 && rep.mind.dropped_rate === null, rep.mind)
  check('空库不炸：记忆 0 条', rep.memory.total === 0 && rep.memory.by_source.length === 0, rep.memory)
  check('参数快照带默认值', rep.params['relation.selfresidue'] === 'on' && rep.params['relation.selfresidue.settle'] === 'off', rep.params)
}

for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ } }
console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exitCode = 1
