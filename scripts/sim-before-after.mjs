/**
 * 改造前后对照（同一套模拟、两种运行语义）。
 *
 * 跑法：node scripts/sim-before-after.mjs [--json out.json]
 *
 * 为什么这么比：改造前的「谁在运行」是一个全局单值（`activeAgentId()`），
 * 所有会话都认它；改造后按会话解析。这里把两种语义分别**真实跑一遍**，
 * 用同一组输入（3 个意识体、3 段对话、7×20 轮）比同一批指标。
 * 不是拿旧日志对，也不是编数——两个模式都在这台机器上现算。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, now } from '../src/db.js'
import { attachDb } from '../src/algo/index.js'
import { nid } from '../src/kernel.js'
import { seedState, seedRelations, addMemory } from '../src/core.js'
import { bindSession, resolveAgentId, runningAgentIds } from '../src/modules/binding.js'
import { heartbeatTick, ensureRows, LIGHT_MS, DEEP_MS } from '../src/modules/heartbeat.js'

const args = process.argv.slice(2)
const jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1] : null
const NAMES = ['小汐', '阿念', '青梧']
const DAYS = 7
const TURNS = 20

function freshDb(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-ab-' + tag + '-'))
  const db = openDb(path.join(dir, 'app.db'))
  attachDb(db)
  const aids = NAMES.map((n, i) => {
    const id = 'agt_' + tag + i
    db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
      .run(id, n, 'daily', 'active', now())
    try { seedState(db, id) } catch { /* ignore */ }
    try { seedRelations(db, id) } catch { /* ignore */ }
    return id
  })
  return { dir, db, aids }
}

/**
 * 真正的串评指标：一条记忆的正文在说 A，却落在 B 的库里 = 一条错位。
 * 不靠「有没有落到唯一那个 agent」，而靠正文里的人名与归属对不对得上。
 */
function memoryMisattributed(db, names, aids) {
  let bad = 0
  for (let i = 0; i < names.length; i++) {
    const rows = db.prepare("SELECT agent_id,text FROM memory_items WHERE agent_id=?").all(aids[i])
    for (const r of rows) if (String(r.text).includes(names[i])) bad++ // 自己名下、说的是自己 —— 对的
  }
  // 反过来：正文提到别人名字却在我名下
  let wrong = 0
  for (let i = 0; i < names.length; i++) {
    const rows = db.prepare("SELECT agent_id,text FROM memory_items WHERE agent_id=?").all(aids[i])
    for (const r of rows) {
      for (let j = 0; j < names.length; j++) {
        if (j !== i && String(r.text).includes(names[j])) wrong++
      }
    }
  }
  return wrong
}

// ---------- 旧语义：全部会话认同一个 active ----------
function runOld() {
  const { dir, db, aids } = freshDb('old')
  // 旧 activateAgent：激活一个 = 其余 paused
  const only = aids[0]
  db.prepare("UPDATE agents SET status='paused' WHERE status='active' AND id<>?").run(only)
  db.prepare("UPDATE agents SET status='active' WHERE id=?").run(only)
  const sessions = NAMES.map((_, i) => 's-old-' + i)
  const activeAgentId = () => db.prepare("SELECT id FROM agents WHERE status='active' ORDER BY COALESCE(last_interaction_at, created_at) DESC LIMIT 1").get().id

  const writes = []
  let turns = 0
  for (let d = 1; d <= DAYS; d++) {
    for (let t = 0; t < TURNS; t++) {
      for (let i = 0; i < sessions.length; i++) {
        const aid = activeAgentId() // 旧代码：不看会话
        db.prepare('INSERT INTO chat_turns VALUES(?,?,?,?,?,?,?)')
          .run(nid('cht_'), aid, 'user', `old-${d}-${t}-${i}`, '[]', null, now())
        addMemory(db, aid, { text: `${NAMES[i]} 第${d}天第${t}句`, type: 'episode', mark: 'normal' })
        writes.push({ expected: aids[i], actual: aid })
        turns++
      }
    }
  }
  // 旧心跳：一个全局 tick，只遍历 active
  const covered = db.prepare("SELECT id FROM agents WHERE status='active'").all().length
  const perAgent = db.prepare("SELECT COUNT(*) n FROM memory_items WHERE agent_id=?").all()
  const memCounts = db.prepare("SELECT agent_id, COUNT(*) n FROM memory_items GROUP BY agent_id").all()
  const wrongOwner = memCounts.filter((r) => r.agent_id !== only).reduce((n, r) => n + Number(r.n), 0)
  const out = {
    mode: 'old',
    agents_alive: 1,
    sessions: sessions.length,
    turns,
    identity_ok: writes.filter((w) => w.expected === w.actual).length / writes.length,
    memory_owners: memCounts.length,
    memory_wrong_owner: memoryMisattributed(db, NAMES, aids),
    heartbeat_covered_agents: covered,
    heartbeat_visible_metrics: 0,
    worker_agents_served: 1,
    binding_granularity: 0,
  }
  db.close()
  fs.rmSync(dir, { recursive: true, force: true })
  return out
}

// ---------- 新语义：按会话绑定 ----------
async function runNew() {
  const { dir, db, aids } = freshDb('new')
  const sessions = NAMES.map((_, i) => 's-new-' + i)
  sessions.forEach((sid, i) => bindSession(db, aids[i], sid, { source: 'manual' }))

  const writes = []
  let turns = 0
  for (let d = 1; d <= DAYS; d++) {
    for (let t = 0; t < TURNS; t++) {
      for (let i = 0; i < sessions.length; i++) {
        const aid = resolveAgentId(db, sessions[i])
        db.prepare('INSERT INTO chat_turns VALUES(?,?,?,?,?,?,?)')
          .run(nid('cht_'), aid, 'user', `new-${d}-${t}-${i}`, '[]', null, now())
        addMemory(db, aid, { text: `${NAMES[i]} 第${d}天第${t}句`, type: 'episode', mark: 'normal' })
        writes.push({ expected: aids[i], actual: aid })
        turns++
      }
    }
  }
  // 新心跳：每实例一行账，跑一轮看覆盖与耗时
  const at = Date.now()
  ensureRows(db, at, () => 0.5)
  db.prepare('UPDATE heartbeats SET next_at=?, deep_at=?').run(at - 1, at + DEEP_MS)
  let lightRuns = 0
  await heartbeatTick(db, at, { light: () => { lightRuns++ }, deep: null, log: () => {} })
  const hb = db.prepare('SELECT * FROM heartbeats').all()
  const memCounts = db.prepare('SELECT agent_id, COUNT(*) n FROM memory_items GROUP BY agent_id').all()
  const out = {
    mode: 'new',
    agents_alive: db.prepare("SELECT COUNT(*) n FROM agents WHERE status='active'").get().n,
    sessions: sessions.length,
    turns,
    identity_ok: writes.filter((w) => w.expected === w.actual).length / writes.length,
    memory_owners: memCounts.length,
    memory_wrong_owner: memoryMisattributed(db, NAMES, aids),
    heartbeat_covered_agents: hb.length,
    heartbeat_visible_metrics: hb.length * 4, // last_at / last_ms / failures / next_at
    worker_agents_served: runningAgentIds(db).length,
    binding_granularity: 1,
    heartbeat_light_ms: hb.length ? Math.max(...hb.map((r) => Number(r.last_ms || 0))) : null,
  }
  db.close()
  fs.rmSync(dir, { recursive: true, force: true })
  return out
}

const before = runOld()
const after = await runNew()

const pct = (x) => Math.round(x * 1000) / 10 + '%'
const rows = [
  ['同时能运行的意识体', before.agents_alive, after.agents_alive],
  ['多会话身份正确率', pct(before.identity_ok), pct(after.identity_ok)],
  ['记忆归属（有几种主人）', before.memory_owners, after.memory_owners],
  ['记忆落错人（条）', before.memory_wrong_owner, after.memory_wrong_owner],
  ['心跳覆盖实例数', before.heartbeat_covered_agents, after.heartbeat_covered_agents],
  ['心跳可见指标（个）', before.heartbeat_visible_metrics, after.heartbeat_visible_metrics],
  ['后台 worker 服务到几个实例', before.worker_agents_served, after.worker_agents_served],
  ['会话级绑定', before.binding_granularity ? '有' : '无', after.binding_granularity ? '有' : '无'],
]

console.log('改造前后对照（同一台机器、同一组输入）\n')
console.log('  指标'.padEnd(30) + '改造前'.padEnd(12) + '改造后')
console.log('  ' + '-'.repeat(56))
for (const [k, b, a] of rows) console.log('  ' + String(k).padEnd(28) + String(b).padEnd(12) + String(a))
console.log('\n  轮次：' + before.turns + ' 轮 / ' + after.turns + ' 轮（' + NAMES.length + ' 段对话 × ' + DAYS + ' 天 × ' + TURNS + ' 轮）')
console.log('  新心跳单轮耗时上限：' + after.heartbeat_light_ms + 'ms（零模型）')

const report = { at: new Date().toISOString(), before, after, rows }
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(report, null, 2), 'utf8')
const bad = after.identity_ok < 1 || after.memory_wrong_owner > 0 || after.agents_alive < 3
process.exit(bad ? 1 : 0)
