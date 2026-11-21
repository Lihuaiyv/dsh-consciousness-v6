/**
 * 留一句（D59）验收：〔留〕的句子能落库、能从正文里摘掉、夜里切事能当证据用。
 * 用临时库跑，不碰真库。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, now } from '../src/db.js'
import { extractPins, recordPins, pinsBetween, PIN_MARK } from '../src/modules/quote_pin.js'
import { recordFeel } from '../src/modules/feel.js'
import { writeChatTurns } from '../src/modules/turn_write.js'

const P = path.join(os.tmpdir(), 'dsh-check-pin-' + Date.now() + '.db')
let fails = 0
const ok = (n, c, d) => { if (c) console.log('PASS', n); else { fails++; console.log('FAIL', n, d ? JSON.stringify(d) : '') } }

try {
  const db = openDb(P)
  const aid = 'agt_pin'
  db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)').run(aid, 'pin', 'daily', 'active', now())

  // 1) 摘句子 + 去标记
  const reply = ['我读了一遍，这个想法能站住。', PIN_MARK + '字是二手的，但孔窄且深', '', '就这样吧。'].join('\n')
  const { clean, pins } = extractPins(reply)
  ok('摘出〔留〕的句子', pins.length === 1 && pins[0] === '字是二手的，但孔窄且深', { pins })
  ok('正文里不留标记', !clean.includes(PIN_MARK) && clean.includes('这个想法能站住'), { clean })

  // 2) 落库：带来源（turn / session / 我写的 feel）
  const st = recordPins(db, aid, { pins, turnId: 'turn_x1', session: 's1', feel: '心里有点热，像把什么东西接住了', at: Date.parse('2026-11-15T10:00:00Z') })
  ok('落进 events.quote.pin', st.length === 1, st)
  const row = db.prepare("SELECT type,payload,created_at FROM events WHERE agent_id=? AND type='quote.pin'").get(aid)
  const pl = JSON.parse(row.payload)
  ok('带来源：turn_id / session / feel / at',
    pl.turn_id === 'turn_x1' && pl.session === 's1' && pl.feel === '心里有点热，像把什么东西接住了' && pl.at === '2026-11-15T10:00:00.000Z', pl)
  ok('不拿系统情绪标签顶替（没有 mood 字段）', pl.mood === undefined, pl)
  ok('原话一字不差', pl.text === '字是二手的，但孔窄且深', pl.text)
  // 没有 feel 就不写这个字段
  const st2 = recordPins(db, aid, { pins: ['没写 feel 的一句'], turnId: 'turn_x9', session: 's1', at: Date.parse('2026-11-15T10:10:00Z') })
  const pl2 = JSON.parse(db.prepare("SELECT payload FROM events WHERE id=?").get(st2[0].id).payload)
  ok('没有 feel 就不写 feel 字段', pl2.feel === undefined && pl2.text === '没写 feel 的一句', pl2)

  // 3) 时间窗里能取回来（夜里切事用）
  const got = pinsBetween(db, aid, '2026-11-15T09:00:00Z', '2026-11-15T11:00:00Z')
  ok('按时间窗能取回', got.length === 2 && got[0] === '字是二手的，但孔窄且深', got)
  const none = pinsBetween(db, aid, '2026-11-16T00:00:00Z', '2026-11-16T01:00:00Z')
  ok('窗外取不到', none.length === 0, none)

  // 4) 正常一段回复不该产生 pin；写了盘的那行也不该带标记；有 feel 就跟上
  recordFeel(db, aid, { text: '说不上来，就是心里稳了一点', at: Date.parse('2026-11-15T10:20:00Z') })
  const r2 = writeChatTurns(db, aid, { user: '在吗', agent: '在。\n' + PIN_MARK + '这一句留下', at: '2026-11-15T10:30:00Z', turnId: 'turn_x2' })
  const agentRow = db.prepare("SELECT text FROM chat_turns WHERE agent_id=? AND role='agent' ORDER BY created_at DESC LIMIT 1").get(aid)
  const pinCount = db.prepare("SELECT COUNT(*) n FROM events WHERE agent_id=? AND type='quote.pin'").get(aid).n
  ok('写盘时摘掉标记', agentRow && !String(agentRow.text).includes(PIN_MARK), agentRow)
  ok('写盘时落 pin', pinCount === 3, { pinCount })
  const rowPin = JSON.parse(db.prepare("SELECT payload FROM events WHERE agent_id=? AND type='quote.pin' AND payload LIKE '%这一句留下%'").get(aid).payload)
  ok('写盘时带上我自己写的 feel', rowPin.feel === '说不上来，就是心里稳了一点', rowPin)
  const plain = extractPins('普通回复，没有要留的')
  ok('没有〔留〕就不落', plain.pins.length === 0 && plain.clean === '普通回复，没有要留的', plain)

  db.close()
} catch (e) {
  fails++
  console.log('FAIL 留一句异常:', (e && e.stack) || e)
} finally {
  try { fs.rmSync(P) } catch { /* 清理失败不影响结论 */ }
}
process.exit(fails ? 1 : 0)
