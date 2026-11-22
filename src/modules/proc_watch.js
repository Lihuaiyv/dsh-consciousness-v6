/**
 * 进程观察（2026-11-22，给「调用看板」用）
 *
 * 看板要显示两样东西：
 *   1. 本机现在有哪些模型进程（ollama 本体 / llama-server，一个模型一个 llama-server）；
 *   2. 有谁**新起来**、谁**退出了**——不然「悄悄起了第二个小模型」看不见。
 *
 * 为什么不用 wmic：Win11 已经删了。这里用 Get-Process 取 pid / 名字 / 启动时间 / 内存 / CPU。
 * 采样只在有人开看板时才发生：缓存 2 秒，重复请求复用，绝不堵住调用。
 */
import { execFile } from 'node:child_process'

const PATTERNS = ['ollama*', 'llama-server*']
const CACHE_MS = 2000
const EVENT_MAX = 30

let cache = { at: 0, items: [], error: '' }
let inflight = null
let sampleCount = 0
const firstSeen = new Map()   // pid -> 首次看到的时间
const events = []             // { at, kind: 'start'|'stop', pid, name }
let lastKeys = new Set()

/** 诊断用：真正去问系统问了几次（缓存命中不算）。 */
export function processStats() {
  return { sampleCount, lastAt: cache.at, inflight: !!inflight }
}

function psCommand() {
  const names = PATTERNS.join(',')
  return `$ErrorActionPreference='SilentlyContinue'; Get-Process -Name ${names} | `
    + `Select-Object Id,ProcessName,@{n='Started';e={try{$_.StartTime.ToUniversalTime().ToString('o')}catch{''}}},`
    + `@{n='MB';e={[int]($_.WorkingSet64/1MB)}},@{n='CPU';e={[double]([math]::Round($_.CPU,1))}} `
    + `| ConvertTo-Json -Compress -Depth 3`
}

function parse(text) {
  const raw = String(text || '').trim()
  if (!raw) return []
  let j = null
  try { j = JSON.parse(raw) } catch { return [] }
  const list = Array.isArray(j) ? j : [j]
  return list.map((o) => ({
    pid: Number(o.Id) || 0,
    name: String(o.ProcessName || ''),
    startedAt: String(o.Started || ''),
    memMB: Number(o.MB) || 0,
    cpu: Number(o.CPU) || 0,
  })).filter((o) => o.pid > 0)
}

function diff(items, nowIso) {
  const keys = new Set(items.map((o) => o.pid + ':' + o.name))
  const freshPids = new Set()
  // 第一次采样时「全都没见过」——那不是新起的，别让看板一打开就全标「新」。
  const firstSample = lastKeys.size === 0
  if (!firstSample) {
    for (const it of items) {
      const k = it.pid + ':' + it.name
      if (!lastKeys.has(k)) { events.push({ at: nowIso, kind: 'start', pid: it.pid, name: it.name }); freshPids.add(it.pid) }
    }
    for (const k of lastKeys) {
      if (keys.has(k)) continue
      const [pid, name] = k.split(':')
      events.push({ at: nowIso, kind: 'stop', pid: Number(pid) || 0, name })
    }
    if (events.length > EVENT_MAX) events.splice(0, events.length - EVENT_MAX)
  }
  lastKeys = keys
  for (const it of items) {
    if (!firstSeen.has(it.pid)) firstSeen.set(it.pid, nowIso)
  }
  for (const pid of [...firstSeen.keys()]) {
    if (!items.some((o) => o.pid === pid)) firstSeen.delete(pid)
  }
  return { freshPids, firstSample }
}

function sample() {
  sampleCount++
  return new Promise((resolve) => {
    let done = false
    const finish = (items, error = '') => {
      if (done) return
      done = true
      const at = new Date().toISOString()
      const { freshPids } = diff(items, at)
      const rich = items.map((o) => ({
        ...o,
        firstSeenAt: firstSeen.get(o.pid) || at,
        fresh: freshPids.has(o.pid),
      }))
      cache = { at: Date.now(), items: rich, error }
      resolve(cache)
    }
    try {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psCommand()],
        { timeout: 5000, windowsHide: true, maxBuffer: 1 << 20 },
        (err, stdout, stderr) => finish(err ? [] : parse(stdout), err ? String(stderr || err.message).slice(0, 160) : ''))
    } catch (e) {
      finish([], String(e && e.message || e).slice(0, 160))
    }
  })
}

/**
 * 取一份进程快照（带「新/退出」事件）。2 秒内重复调用复用缓存。
 * @returns {Promise<{at:number, items:Array, events:Array, error:string}>}
 */
export async function processSnapshot({ force = false } = {}) {
  const fresh = Date.now() - cache.at < CACHE_MS
  if (!force && fresh && cache.at) return { ...cache, events: events.slice(-12) }
  if (inflight) return inflight
  inflight = sample().then((c) => {
    inflight = null
    return { ...c, events: events.slice(-12) }
  }).catch((e) => {
    inflight = null
    return { at: Date.now(), items: [], events: events.slice(-12), error: String(e && e.message || e).slice(0, 160) }
  })
  return inflight
}

/** 测试/诊断用：清空历史（不碰系统进程）。 */
export function resetProcessWatch() {
  firstSeen.clear()
  events.length = 0
  lastKeys = new Set()
  cache = { at: 0, items: [], error: '' }
}
