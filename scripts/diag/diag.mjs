/**
 * 诊断入口（2026-11-22）
 *
 * 把今天排查卡死用过的脚本收成一个文件，按子命令跑：
 *   node scripts/diag/diag.mjs audit      存储体检 auditStore 的耗时（副本库）
 *   node scripts/diag/diag.mjs surface    浮现队列那条查询加索引前后（副本库）
 *   node scripts/diag/diag.mjs heartbeat  心跳账：每跳跑了多久 + 几张表多大
 *   node scripts/diag/diag.mjs purge      体检时间戳有没有落库
 *   node scripts/diag/diag.mjs freeze     进程级趋势（内存/页错误/卡死次数）
 *   node scripts/diag/diag.mjs breath     呼吸哨兵自检（故意堵主线程 3 秒）
 *   node scripts/diag/diag.mjs stage      段落探针自检
 *
 * 只读的口子（audit/surface 除外）都会复制一份真库到 scratch 再跑，跑完自己删。
 * 判据：卡死 = 探活超时（freeze-watch.jsonl 里 pingFails 涨）；stall 变大不算。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { auditStore } from '../../src/modules/ops.js'
import { queueSurface } from '../../src/modules/pulse.js'
import { startBreathWatch } from '../../src/modules/breath_watch.js'

// 路径一律从本文件位置推，不写盘符（门禁：路径闸）。
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')          // dsh-consciousness-v6
const PLUG = path.resolve(ROOT, '..')                 // plugins
const RUN = path.join(PLUG, 'runtime', 'consciousness')
const REAL = path.join(RUN, 'app.db')
const SCRATCH = path.join(PLUG, 'scratch')

/** 复制一份真库到 scratch/<name>，用完删。 */
function withCopy(name) {
  const dir = path.join(SCRATCH, name)
  const dst = path.join(dir, 'app.db')
  fs.mkdirSync(dir, { recursive: true })
  for (const f of ['', '-wal', '-shm']) {
    try { fs.copyFileSync(REAL + f, dst + f) } catch { /* 没有就跳过 */ }
  }
  return {
    db: new DatabaseSync(dst, { timeout: 20000 }),
    clean() { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 清不掉算了 */ } },
  }
}

function readonly() {
  return new DatabaseSync(REAL, { readOnly: true })
}

/* ---------------- audit ---------------- */
function cmdAudit() {
  const { db, clean } = withCopy('diag-audit')
  try {
    const times = []
    for (let i = 0; i < 3; i++) {
      const t = Date.now()
      const r = auditStore(db, { repair: false })
      const ms = Date.now() - t
      times.push(ms)
      console.log(`第 ${i + 1} 次：${ms}ms  ${r.checks.map((c) => c.name + ':' + c.bad).join(' ')}`)
    }
    const worst = Math.max(...times)
    console.log(worst < 500 ? `\n通过：最慢 ${worst}ms（改前是 34 秒级）` : `\n太慢：最慢 ${worst}ms，检查是不是又整表扫了`)
  } finally { clean() }
}

/* ---------------- surface ---------------- */
function cmdSurface() {
  const { db, clean } = withCopy('diag-surface')
  try {
    const aid = String(db.prepare('SELECT agent_id FROM memory_items GROUP BY agent_id ORDER BY COUNT(*) DESC LIMIT 1').get().agent_id)
    try { db.prepare("UPDATE surface_queue SET state='expired' WHERE state='pending'").run() } catch { /* ignore */ }
    const opt = { at: Date.now(), limit: 1, cooldownDays: 0, intervalMs: 0 }
    let t = Date.now()
    const oldN = queueSurface(db, aid, opt)
    const oldMs = Date.now() - t
    console.log(`旧索引：${oldMs}ms，入队 ${oldN}`)
    db.exec('CREATE INDEX IF NOT EXISTS idx_surf_mem ON surfaced_items(agent_id, memory_id, at)')
    db.exec('CREATE INDEX IF NOT EXISTS idx_sq_mem ON surface_queue(agent_id, memory_id, state)')
    try { db.prepare("UPDATE surface_queue SET state='expired' WHERE state='pending'").run() } catch { /* ignore */ }
    t = Date.now()
    const newN = queueSurface(db, aid, opt)
    const newMs = Date.now() - t
    console.log(`新索引：${newMs}ms，入队 ${newN}`)
    console.log(newMs < 300 ? `\n通过：加索引后 ${newMs}ms（改前 ${oldMs}ms）` : `\n太慢：${newMs}ms`)
  } finally { clean() }
}

/* ---------------- heartbeat ---------------- */
function cmdHeartbeat() {
  const db = readonly()
  try {
    console.log('== 心跳账（last_ms 就是这一跳跑了多久，正常几十毫秒）==')
    for (const r of db.prepare('SELECT agent_id,last_at,last_ms,failures,interval_ms FROM heartbeats').all()) {
      console.log(` ${r.agent_id}  last_ms=${r.last_ms}  failures=${r.failures}  间隔=${r.interval_ms}`)
    }
    console.log('\n== 几张关键表的行数 ==')
    for (const t of ['memory_items', 'memory_fts', 'surfaced_items', 'surface_queue', 'fragments', 'affect_events', 'chat_turns', 'event_edges']) {
      let n = 'no-table'
      try { n = db.prepare('SELECT COUNT(*) n FROM ' + t).get().n } catch { /* 表不存在 */ }
      console.log(` ${t.padEnd(16)} ${n}`)
    }
  } finally { db.close() }
}

/* ---------------- purge ---------------- */
function cmdPurge() {
  const db = readonly()
  try {
    const r = db.prepare("SELECT value FROM flags WHERE key='maintenance.last_purge'").get()
    console.log('maintenance.last_purge =', r ? r.value : '（还没记：新代码还没跑过体检）')
    if (r) console.log('换算：', new Date(Number(r.value)).toLocaleString())
  } finally { db.close() }
}

/* ---------------- freeze ---------------- */
function cmdFreeze() {
  const file = RUN + '/freeze-watch.jsonl'
  const rows = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim().startsWith('{')).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  const ticks = rows.filter((r) => r.kind === 'tick')
  console.log(`采样 ${ticks.length} 条，从 ${ticks[0] && ticks[0].t} 到 ${ticks[ticks.length - 1] && ticks[ticks.length - 1].t}`)
  const byBucket = new Map()
  for (const r of ticks) {
    const t = Date.parse(r.t)
    if (!Number.isFinite(t)) continue
    const b = Math.floor(t / 600000)
    if (!byBucket.has(b)) byBucket.set(b, r)
  }
  console.log('\n时间(HH:MM) | host内存 线程 句柄 | 进程数 | 页错误 磁盘% | 探活失败累计')
  for (const [b, r] of [...byBucket.entries()].sort((a, c) => a[0] - c[0])) {
    const host = (r.procs || []).find((p) => p.role === 'host-main') || {}
    console.log(`${new Date(b * 600000).toISOString().slice(11, 16)} | ${String(host.mb || '-').padStart(6)} ${String(host.threads || '-').padStart(4)} ${String(host.handles || '-').padStart(5)} | ${String((r.procs || []).length).padStart(5)} | ${String(r.sys && r.sys.pagesSec).padStart(6)} ${String(r.sys && r.sys.diskPct).padStart(5)} | ${r.pingFails || 0}`)
  }
  const bad = ticks.filter((r) => Number(r.pingFails) > 0)
  console.log(`\n探活失败过的采样：${bad.length} 条（这才是真卡死的证据）`)
}

/* ---------------- breath / stage 自检 ---------------- */
async function cmdBreath() {
  const out = path.join(RUN, 'diag-breath.jsonl')
  const stage = path.join(RUN, 'diag-breath-stage.log')
  fs.writeFileSync(stage, 'line1\n2026-11-22T10:00:00Z prestep\n')
  const w = startBreathWatch({ outPath: out, stagePath: stage, stuckMs: 1000 })
  await new Promise((r) => setTimeout(r, 400))
  const t0 = Date.now()
  while (Date.now() - t0 < 3000) { /* 故意堵住主线程 */ }
  await new Promise((r) => setTimeout(r, 1600))
  w.stop()
  const lines = fs.readFileSync(out, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const stall = lines.filter((x) => x.kind === 'stall')
  const ok = stall.length > 0 && lines.some((x) => x.kind === 'recover')
  console.log(`记录 ${lines.length} 条：${lines.map((x) => x.kind).join(',')}`)
  if (stall[0]) console.log(`最大停摆 ${stall[0].stalledMs}ms，当时停在：${stall[0].stageTail}`)
  console.log(ok ? '\n通过：堵住时记下了，恢复也记下了' : '\n失败：哨兵没记到')
  try { fs.unlinkSync(out) } catch { /* ignore */ }
  try { fs.unlinkSync(stage) } catch { /* ignore */ }
}

async function cmdStage() {
  const out = path.join(RUN, 'diag-stage.log')
  const { mark, start } = await import('../../src/modules/loop_watch.js')
  const lines = []
  start((m) => lines.push(m), { stageFile: out })
  mark('diag-test')
  const t0 = Date.now()
  while (Date.now() - t0 < 2000) { /* 堵住 */ }
  await new Promise((r) => setTimeout(r, 120))
  const tail = fs.readFileSync(out, 'utf8').trim().split('\n').pop()
  console.log('stage 最后一行：', tail)
  console.log(lines.some((x) => x.includes('eventloop-stall')) ? '通过：堵住时报出了 eventloop-stall' : '失败：没报')
  try { fs.unlinkSync(out) } catch { /* ignore */ }
}

/* ---------------- scan：全场 SQL 查询计划体检 ---------------- */
function cmdScan() {
  const root = ROOT
  const files = []
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'docs' || e.name === 'test'
        || e.name === 'scripts' || e.name === 'scratch' || e.name === 'client') continue
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.(js|mjs)$/.test(e.name) && e.name !== 'client.js') files.push(p)
    }
  }
  walk(root)

  const db = new DatabaseSync(REAL, { readOnly: true })
  const sizes = {}
  for (const r of db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()) {
    if (/^(sqlite_|_)/.test(r.name)) continue
    try { sizes[r.name] = db.prepare('SELECT COUNT(*) n FROM ' + r.name).get().n } catch { sizes[r.name] = -1 }
  }
  const BIG = new Set(Object.entries(sizes).filter(([, n]) => n > 5000).map(([t]) => t))
  console.log('大表（>5000 行）：' + [...BIG].map((t) => t + '(' + sizes[t] + ')').join(', '))

  const found = []
  const re = /prepare\(\s*[`'"]((?:SELECT|WITH)[\s\S]{0,600}?)[`'"]/gi
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8')
    let m
    re.lastIndex = 0
    while ((m = re.exec(src))) {
      const sql = m[1]
      if (!sql.includes('?') && !/FROM\s+\w+/i.test(sql)) continue
      const line = src.slice(0, m.index).split('\n').length
      try {
        const plan = db.prepare('EXPLAIN QUERY PLAN ' + sql).all()
        const scans = []
        for (const p of plan) {
          const d = String(p.detail || '')
          const sm = d.match(/SCAN\s+(?:TABLE\s+)?(\w+)/)
          if (sm && BIG.has(sm[1])) scans.push(sm[1])
        }
        if (scans.length) found.push({ file: path.relative(root, f), line, tables: [...new Set(scans)], sql: sql.replace(/\s+/g, ' ').slice(0, 90) })
      } catch { /* 动态拼的 SQL 没法预判，跳过 */ }
    }
  }
  db.close()

  if (!found.length) { console.log('\n没有发现「大表全表扫」的查询。'); return }
  console.log('\n涉及大表且走全表扫的查询（' + found.length + ' 条）：')
  for (const x of found) {
    console.log(`\n ${x.file}:${x.line}`)
    console.log(` 扫到：${x.tables.join(', ')}`)
    console.log(` ${x.sql}`)
  }
  console.log('\n注意：单次全表扫不一定有问题——要看它在不在一日一次/一次性的活里，还是被循环调用。')
}

const cmd = String(process.argv[2] || '').trim()
const table = { audit: cmdAudit, surface: cmdSurface, heartbeat: cmdHeartbeat, purge: cmdPurge, freeze: cmdFreeze, scan: cmdScan }
if (table[cmd]) table[cmd]()
else if (cmd === 'breath') await cmdBreath()
else if (cmd === 'stage') await cmdStage()
else {
  console.log('用法：node scripts/diag/diag.mjs <audit|surface|heartbeat|purge|freeze|breath|stage>')
  process.exit(1)
}
