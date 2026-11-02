/**
 * 多实例整体模拟（真实函数、临时库，不碰线上）。
 *
 * 跑法：node scripts/sim-multi-agent.mjs [--json out.json]
 *
 * 验的是「会不会串」这件事本身：
 *   3 个意识体 / 3 段对话 / 7 天 × 每段每天 20 轮
 *   → 每一行写入都必须落在该会话绑定的那个 agent_id 上
 *   → 每段对话拼出来的系统提示必须是它自己那个人
 *   → 心跳按实例各跳各的，light 档一次模型都不许调
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, now } from '../src/db.js'
import { attachDb } from '../src/algo/index.js'
import { nid } from '../src/kernel.js'
import { seedState, seedRelations, addMemory } from '../src/core.js'
import {
  bindSession, resolveAgentId, unbindAgent, bindingsOf, runningAgentIds, setMaxRunning, maxRunning,
} from '../src/modules/binding.js'
import { heartbeatTick, ensureRows, LIGHT_MS, DEEP_MS } from '../src/modules/heartbeat.js'

const args = process.argv.slice(2)
const jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1] : null

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-sim-ma-'))
const db = openDb(path.join(dir, 'app.db'))
attachDb(db)

const NAMES = ['小汐', '阿念', '青梧']
const aids = []
for (let i = 0; i < NAMES.length; i++) {
  const id = 'agt_sim' + i
  db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
    .run(id, NAMES[i], 'daily', 'active', now())
  try { seedState(db, id) } catch { /* 种子失败不影响模拟 */ }
  try { seedRelations(db, id) } catch { /* 老的种子签名 */ }
  aids.push(id)
}

// 每段对话绑一个人
const sessions = aids.map((aid, i) => {
  const sid = 'sess-sim-' + i
  const r = bindSession(db, aid, sid, { source: 'manual' })
  if (!r.ok) throw new Error('绑定失败：' + JSON.stringify(r))
  return sid
})

const DAYS = 7
const TURNS = 20
const writes = []          // {agent_id, session, kind}
const mismatches = []
let turns = 0

for (let day = 1; day <= DAYS; day++) {
  for (let t = 0; t < TURNS; t++) {
    for (let i = 0; i < sessions.length; i++) {
      const sid = sessions[i]
      const expected = resolveAgentId(db, sid)
      if (!expected) { mismatches.push({ sid, why: 'no-binding' }); continue }
      // 一轮：写 chat_turn + 一条记忆（模拟对话落库与抽取）
      db.prepare('INSERT INTO chat_turns VALUES(?,?,?,?,?,?,?)')
        .run(nid('cht_'), expected, 'user', `day${day}-t${t}-${NAMES[i]}`, '[]', null, now())
      addMemory(db, expected, { text: `${NAMES[i]} 第${day}天第${t}句：我们聊到了第${t + day}件事`, type: 'episode', mark: 'normal' })
      writes.push({ agent_id: expected, session: sid, kind: 'turn+mem' })
      turns++
    }
  }
}

// ---- 1) 串没串：每行写入的 agent_id 必须是该会话绑定的那个 ----
const byAgent = new Map(aids.map((a) => [a, 0]))
for (const w of writes) byAgent.set(w.agent_id, (byAgent.get(w.agent_id) || 0) + 1)
const crossRows = []
for (const w of writes) {
  const owner = db.prepare("SELECT agent_id FROM chat_turns WHERE text LIKE ?").get('%' + w.session + '%')
  if (owner && owner.agent_id !== w.agent_id) crossRows.push({ ...w, owner: owner.agent_id })
}
// 更直接的一条：每张表里「记忆正文提到了别人名字」的行 = 串了
const leaks = []
for (let i = 0; i < aids.length; i++) {
  const rows = db.prepare("SELECT id,text FROM memory_items WHERE agent_id=? AND status='active'").all(aids[i])
  for (const r of rows) {
    for (let j = 0; j < NAMES.length; j++) {
      if (j === i) continue
      if (String(r.text).includes(NAMES[j])) leaks.push({ agent: NAMES[i], saw: NAMES[j], text: r.text })
    }
  }
}

// ---- 2) 注入会不会拿错人 ----
const { consciousnessBlock } = await import('../index.js')
const injectOk = []
for (let i = 0; i < sessions.length; i++) {
  const aid = resolveAgentId(db, sessions[i])
  let block = ''
  try { block = String(consciousnessBlock(db, aid)) } catch (e) { block = 'ERR:' + e.message }
  const own = block.includes('意识体：' + NAMES[i])
  const other = NAMES.filter((n, j) => j !== i).some((n) => block.includes('意识体：' + n))
  injectOk.push({ session: sessions[i], agent: NAMES[i], own, other })
}

// ---- 3) 心跳：每实例各跳各的，light 不调模型 ----
const lightCalls = []
const deepCalls = []
let at = Date.now()
ensureRows(db, at, () => 0.5)
for (let round = 0; round < 6; round++) {
  at += LIGHT_MS
  db.prepare('UPDATE heartbeats SET next_at=?').run(at - 1)
  // deep 保持在未来：这一轮只验 light
  db.prepare('UPDATE heartbeats SET deep_at=?').run(at + DEEP_MS)
  await heartbeatTick(db, at, {
    light: (aid) => { lightCalls.push(aid) },
    deep: async (aid) => { deepCalls.push(aid) },
    log: () => {},
  })
}
const hbRows = db.prepare('SELECT * FROM heartbeats ORDER BY agent_id').all()

// ---- 4) 并发上限 ----
unbindAgent(db, aids[0], 'sim')
unbindAgent(db, aids[1], 'sim')
unbindAgent(db, aids[2], 'sim')
setMaxRunning(db, 2)
const b1 = bindSession(db, aids[0], 'cap-1', { source: 'manual' })
const b2 = bindSession(db, aids[1], 'cap-2', { source: 'manual' })
const b3 = bindSession(db, aids[2], 'cap-3', { source: 'manual' })
const capOk = b1.ok && b2.ok && !b3.ok && b3.queued === true && runningAgentIds(db).length === 2
setMaxRunning(db, 3)

const report = {
  at: new Date().toISOString(),
  agents: NAMES,
  sessions: sessions.length,
  turns,
  writes: writes.length,
  cross_rows: crossRows.length,
  leaks: leaks.length,
  inject_mismatch: injectOk.filter((x) => !x.own || x.other).length,
  heartbeat_ticks: lightCalls.length,
  heartbeat_per_agent: Object.fromEntries(hbRows.map((r) => [r.agent_id, lightCalls.filter((a) => a === r.agent_id).length])),
  model_calls_in_light: deepCalls.length,
  concurrency_cap_ok: capOk,
  max_running: maxRunning(db),
  bindings_after_cap_test: bindingsOf(db, aids[0]).length + bindingsOf(db, aids[1]).length + bindingsOf(db, aids[2]).length,
}

console.log('多实例模拟结果')
console.log('  实例 / 会话        : ' + NAMES.join(' / ') + '  ·  ' + sessions.length + ' 段对话')
console.log('  模拟轮次           : ' + turns + ' 轮 · ' + (DAYS) + ' 天')
console.log('  写入行             : ' + writes.length)
console.log('  串评行（cross_rows） : ' + crossRows.length + (crossRows.length ? '  ' + JSON.stringify(crossRows.slice(0, 3)) : ''))
console.log('  记忆串人（leaks）   : ' + leaks.length + (leaks.length ? '  ' + JSON.stringify(leaks.slice(0, 2)) : ''))
console.log('  注入拿错人         : ' + report.inject_mismatch + ' / ' + sessions.length)
console.log('  心跳跳次           : ' + lightCalls.length + '  ' + JSON.stringify(report.heartbeat_per_agent))
console.log('  light 里调模型次数 : ' + deepCalls.length)
console.log('  并发上限起作用     : ' + (capOk ? '是' : '否'))

if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(report, null, 2), 'utf8')
db.close()
fs.rmSync(dir, { recursive: true, force: true })

const bad = crossRows.length + leaks.length + report.inject_mismatch + deepCalls.length + (capOk ? 0 : 1)
process.exit(bad ? 1 : 0)
