/**
 * 卡死看门狗（2026-11-22，v3）
 *
 * 一卡死，全部会话一起卡，主人连「卡了」都发不出来，只能重启。
 * 所以现场必须自动记，而且进程不能挂在 DSH 里——DSH 卡/重启它都得活着。
 *
 * 每 10 秒一条到 runtime/consciousness/freeze-watch.jsonl：
 *   - 探活：打插件的 /ping，超时 2.5 秒算不应答
 *   - 系统：CPU、处理器排队、可用内存、分页、磁盘占用
 *   - 进程：每个 DSH / ollama / llama-server 的 CPU、内存、线程、句柄、启动时间、角色
 *   - IO：读盘 / 写盘最多的前 5 个进程（带 pid 和角色）
 * 探活连续 3 次失败，或单次超过 5 秒 → 判为真卡，另存 freeze-snapshot-<时间>.json。
 *
 * 启动：插件 apply 时自己拉起（ensureFreezeWatch）；也可手动：
 *   Start-Process node -ArgumentList "scripts/watch-freeze.mjs" -WindowStyle Hidden
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

// 路径从本文件位置推，不写死盘符（门禁：路径闸）
const ROOT = fileURLToPath(new URL('../../runtime/consciousness/', import.meta.url))
const LOG = path.join(ROOT, 'hook.log')
const OUT = path.join(ROOT, 'freeze-watch.jsonl')
const SNAP_DIR = ROOT
const PID_FILE = path.join(ROOT, 'freeze-watch.pid')
const PORT_FILE = path.join(ROOT, 'gateway-api.json')

const TICK_MS = 10000
const PING_MS = 2500
const MAX_LINES = 3000

/* ---------------- 基础 ---------------- */

function logStat() {
  try { const s = fs.statSync(LOG); return { size: s.size, mtime: Math.round(s.mtimeMs) } } catch { return { size: 0, mtime: 0 } }
}

function apiPort() {
  try {
    const o = JSON.parse(fs.readFileSync(PORT_FILE, 'utf8'))
    const p = Number(o && o.port) || 0
    return p > 0 ? p : 0
  } catch { return 0 }
}

async function pingMain(port) {
  if (!port) return { ok: false, ms: -1, why: 'no-port' }
  const t0 = Date.now()
  try {
    const r = await fetch(`http://127.0.0.1:${port}/dsh-consciousness/ping`, { signal: AbortSignal.timeout(PING_MS) })
    return { ok: r.ok, ms: Date.now() - t0, why: r.ok ? '' : 'http-' + r.status }
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, why: /timeout|abort/i.test(String(e && e.name)) ? 'timeout' : 'conn' }
  }
}

function psRun(script, timeout = 15000) {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 1 << 20 })
}

function parseJson(text) {
  const raw = String(text || '').trim()
  if (!raw) return null
  try { return JSON.parse(raw) } catch { return null }
}

const asArray = (v) => Array.isArray(v) ? v : (v ? [v] : [])

/* ---------------- 采样 ---------------- */

/** 进程表 + 系统计数器（这条命令以前跑通过，别再加复杂逻辑）。 */
function sampleBase() {
  const script = "$ErrorActionPreference='SilentlyContinue'; "
    + "$p = Get-Process -Name 'DeepSeek*','ollama*','llama*' | Select-Object Id,ProcessName,CPU,"
    + "@{n='MB';e={[int]($_.WorkingSet64/1MB)}},@{n='Threads';e={$_.Threads.Count}},@{n='Handles';e={$_.HandleCount}},"
    + "@{n='Started';e={try{$_.StartTime.ToString('HH:mm:ss')}catch{''}}}; "
    + "$c = Get-Counter '\\Processor(_Total)\\% Processor Time','\\System\\Processor Queue Length','\\Memory\\Available MBytes','\\Memory\\Pages/sec','\\PhysicalDisk(_Total)\\% Disk Time' -SampleInterval 1 -MaxSamples 1; "
    + "$g = @{ cpu = [math]::Round((($c.CounterSamples | Where-Object { $_.Path -like '*processor time*' }).CookedValue | Measure-Object -Average).Average,1); "
    + "queue = [math]::Round((($c.CounterSamples | Where-Object { $_.Path -like '*queue length*' }).CookedValue | Measure-Object -Average).Average,1); "
    + "freeMB = [math]::Round((($c.CounterSamples | Where-Object { $_.Path -like '*available mbytes*' }).CookedValue | Measure-Object -Average).Average,0); "
    + "pagesSec = [math]::Round((($c.CounterSamples | Where-Object { $_.Path -like '*pages/sec*' }).CookedValue | Measure-Object -Average).Average,1); "
    + "diskPct = [math]::Round((($c.CounterSamples | Where-Object { $_.Path -like '*disk time*' }).CookedValue | Measure-Object -Average).Average,1) }; "
    + "[pscustomobject]@{ procs = @($p); sys = $g } | ConvertTo-Json -Compress -Depth 4"
  const j = parseJson(psRun(script))
  const items = asArray(j && j.procs).map((p) => ({
    pid: Number(p.Id) || 0,
    name: String(p.ProcessName || ''),
    cpu: Number(p.CPU) || 0,
    mb: Number(p.MB) || 0,
    threads: Number(p.Threads) || 0,
    handles: Number(p.Handles) || 0,
    started: String(p.Started || ''),
  })).filter((p) => p.pid > 0)
  return { items, sys: (j && j.sys) || {} }
}

/** pid → 角色（main / renderer / gpu-process / speech-worker / runner / host-main）。 */
function sampleRoles() {
  const script = "$ErrorActionPreference='SilentlyContinue'; "
    + "Get-CimInstance Win32_Process | Where-Object { $_.Name -like 'DeepSeek*' } | "
    + "Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"
  const j = parseJson(psRun(script))
  const map = new Map()
  for (const r of asArray(j)) {
    const cl = String(r.CommandLine || '')
    let role = 'main'
    const m = cl.match(/--type=([a-zA-Z-]+)/)
    if (m) role = m[1]
    else if (/speech-to-text-sensevoice.*worker\.js/i.test(cl)) role = 'speech-worker'
    else if (/subprocess-local.*runner\.js/i.test(cl)) role = 'runner'
    else if (/dsh-desktop-host/i.test(cl)) role = 'host-main'
    map.set(Number(r.ProcessId) || 0, role)
  }
  return map
}

/** 每进程磁盘 IO（读/写 MB/s），取前 5。 */
function sampleIO() {
  const script = "$ErrorActionPreference='SilentlyContinue'; "
    + "Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | "
    + "Where-Object { $_.IOReadBytesPersec -gt 1048576 -or $_.IOWriteBytesPersec -gt 1048576 } | "
    + "Sort-Object IOReadBytesPersec -Descending | Select-Object -First 5 "
    + "@{n='pid';e={$_.IDProcess}},@{n='name';e={$_.Name}},"
    + "@{n='readMBs';e={[math]::Round($_.IOReadBytesPersec/1MB,1)}},"
    + "@{n='writeMBs';e={[math]::Round($_.IOWriteBytesPersec/1MB,1)}} | ConvertTo-Json -Compress"
  return asArray(parseJson(psRun(script))).map((x) => ({
    pid: Number(x.pid) || 0,
    name: String(x.name || ''),
    readMBs: Number(x.readMBs) || 0,
    writeMBs: Number(x.writeMBs) || 0,
  })).filter((x) => x.pid > 0)
}

function sampleAll() {
  const errs = []
  let base = { items: [], sys: {} }
  let roles = new Map()
  let io = []
  try { base = sampleBase() } catch (e) { errs.push('base:' + String((e && e.stderr) || (e && e.message) || e).slice(0, 300)) }
  try { roles = sampleRoles() } catch (e) { errs.push('roles:' + String((e && e.stderr) || (e && e.message) || e).slice(0, 300)) }
  try { io = sampleIO() } catch (e) { errs.push('io:' + String((e && e.stderr) || (e && e.message) || e).slice(0, 300)) }
  const items = base.items.map((p) => ({ ...p, role: roles.get(p.pid) || (p.name.startsWith('DeepSeek') ? 'main?' : p.name) }))
  const topIO = io.map((x) => ({ ...x, role: roles.get(x.pid) || (x.name.startsWith('DeepSeek') ? 'main?' : x.name) }))
  return { items, sys: base.sys, topIO, error: errs.join(' | ') }
}

/* ---------------- 主循环 ---------------- */

// 单例：已经有一个活着的看门狗就退出（必须先把旧 pid 读出来，再写自己的）
try {
  const old = Number(fs.readFileSync(PID_FILE, 'utf8')) || 0
  if (old && old !== process.pid) {
    try { process.kill(old, 0); process.exit(0) } catch { /* 旧的死了，继续 */ }
  }
} catch { /* 第一次 */ }
try { fs.writeFileSync(PID_FILE, String(process.pid)) } catch { /* ignore */ }

function trim() {
  try {
    const lines = fs.readFileSync(OUT, 'utf8').split('\n').filter(Boolean)
    if (lines.length > MAX_LINES) fs.writeFileSync(OUT, lines.slice(-MAX_LINES).join('\n') + '\n')
  } catch { /* 滚不动就算了 */ }
}

let last = logStat()
let lastChange = Date.now()
let snapshotAt = 0
let pingFails = 0
let tickBusy = false

fs.appendFileSync(OUT, JSON.stringify({ t: new Date().toISOString(), kind: 'watch-start', pid: process.pid, log: last, ver: 3 }) + '\n')

async function tick() {
  if (tickBusy) return
  tickBusy = true
  try {
    const now = logStat()
    if (now.size !== last.size || now.mtime !== last.mtime) { last = now; lastChange = Date.now() }
    const port = apiPort()
    const ping = await pingMain(port)
    if (ping.ok) pingFails = 0
    else pingFails++
    const stalled = Date.now() - lastChange
    const snap = sampleAll()
    const row = {
      t: new Date().toISOString(), kind: 'tick',
      port, pingMs: ping.ms, pingOk: ping.ok, pingWhy: ping.why, pingFails,
      stallMs: stalled, logSize: now.size,
      sys: snap.sys, topIO: snap.topIO, procs: snap.items,
    }
    if (snap.error) row.sampleErr = snap.error
    fs.appendFileSync(OUT, JSON.stringify(row) + '\n')

    const reallyStuck = (!ping.ok && pingFails >= 3) || (ping.ok && ping.ms > 5000)
    if (reallyStuck && Date.now() - snapshotAt > 2 * 60 * 1000) {
      snapshotAt = Date.now()
      const file = path.join(SNAP_DIR, 'freeze-snapshot-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json')
      fs.writeFileSync(file, JSON.stringify({
        at: new Date().toISOString(), port, ping, pingFails, stallMs: stalled, log: now,
        sys: snap.sys, topIO: snap.topIO, procs: snap.items,
        note: ping.ok ? '探活超过 5 秒，主进程在忙/被占' : '探活连续失败，主进程不响应',
      }, null, 2))
    }
    trim()
  } catch { /* 看门狗自己不能死 */ } finally { tickBusy = false }
}

setInterval(tick, TICK_MS)
tick()

process.on('SIGINT', () => { try { fs.unlinkSync(PID_FILE) } catch { /* ignore */ } process.exit(0) })
process.on('SIGTERM', () => { try { fs.unlinkSync(PID_FILE) } catch { /* ignore */ } process.exit(0) })
