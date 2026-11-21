/**
 * 后台宿主模型调用的闸门（2026-11-17）。
 *
 * 为什么单独一条：宿主模型（deepseek-flash）是云端，不占本地显存，但后台任务
 * 一起发会打满连接/配额，也会撞限速。本地那边已经有一条队列（local_llm.js），
 * 这里给「后台宿主调用」也排上：全局并发默认 2，排队超时就放弃，让调用方走兜底。
 *
 * 顺序纪律（主人 2026-11-17 点名）：
 * - 同一个 agent 的调用串成一条链，严格按发起顺序执行——topic 一定在 judge 前面，
 *   上一轮的帧一定先落，不会因为并发/排队反序。
 * - 不同 agent 之间互不阻塞（各自一条链），只共享全局并发额度。
 *
 * 注意：聊天回复本身不走这里（那是前台，必须即时）；这里只接待后台调用。
 */
import { getFlag } from '../kernel.js'

const Q_RECENT_MAX = 30
const qRecent = []
const pending = new Set()
const chains = new Map() // agentKey -> 该 agent 链尾 Promise（保序用）
const waiters = [] // 等全局槽：{ resolve, priority, seq }
let running = 0
let qSeq = 0

function concurrency(db) {
  try {
    const v = String(getFlag(db, 'llm.host.concurrency') || '').trim()
    const n = Number(v)
    if (Number.isFinite(n) && n >= 1) return Math.min(8, Math.floor(n))
  } catch { /* 读不到就按 2 */ }
  return 2
}

function acquire(db, priority = 5) {
  if (running < concurrency(db)) { running++; return Promise.resolve() }
  return new Promise((resolve) => {
    waiters.push({ resolve, priority: Number(priority) || 5, seq: ++qSeq })
    waiters.sort((a, b) => a.priority - b.priority || a.seq - b.seq)
  })
}

function release() {
  running = Math.max(0, running - 1)
  const next = waiters.shift()
  if (next) { running++; next.resolve() }
}

function record(it, ok, err) {
  qRecent.push({
    at: new Date().toISOString(),
    label: it.label || '',
    agent: String(it.key || '').slice(0, 8),
    waitedMs: Math.max(0, (it.startedAt || Date.now()) - it.enqueuedAt),
    ms: it.startedAt ? Date.now() - it.startedAt : 0,
    ok: !!ok,
    error: ok ? '' : String((err && err.message) || err || '').slice(0, 120),
  })
  if (qRecent.length > Q_RECENT_MAX) qRecent.splice(0, qRecent.length - Q_RECENT_MAX)
}

function fail(it, e) {
  it.phase = 'timeout'
  if (it.timer) { clearTimeout(it.timer); it.timer = null }
  pending.delete(it)
  record(it, false, e)
  it.reject(e)
}

async function exec(it, db) {
  if (it.phase === 'timeout') return
  const waited = Date.now() - it.enqueuedAt
  if (waited > it.timeoutMs) { fail(it, new Error(`host queue timeout: waited ${waited}ms (${it.label || 'host'})`)); return }
  await acquire(db, it.priority)
  if (it.phase === 'timeout') { release(); return }
  if (it.timer) { clearTimeout(it.timer); it.timer = null }
  it.phase = 'running'
  it.startedAt = Date.now()
  // 2026-11-17：预算管到「执行」——排队 + 执行合计不得超过 timeoutMs。
  // 之前只管排队，判断层实际跑 35 秒也照等；情绪链不吃这个亏，超了直接弃、回退规则。
  // 说明：这里的超时不取消真正的模型请求（kernelModel.complete 不支持取消），
  // 只把结果丢掉；宿主侧那条请求会自己结束。
  const left = Math.max(0, it.timeoutMs - (Date.now() - it.enqueuedAt))
  let runTimer = null
  try {
    const v = await Promise.race([
      Promise.resolve().then(() => it.run()),
      new Promise((_, rej) => {
        runTimer = setTimeout(() => rej(new Error(`host run timeout: ${Date.now() - it.startedAt}ms (${it.label || 'host'})`)), left)
        if (runTimer.unref) runTimer.unref()
      }),
    ])
    pending.delete(it)
    record(it, true)
    it.resolve(v)
  } catch (e) {
    pending.delete(it)
    record(it, false, e)
    it.reject(e)
  } finally {
    if (runTimer) clearTimeout(runTimer)
    release()
  }
}

/**
 * 排队执行一个后台宿主调用。对外一般不直接调，用 hostComplete。
 * 同一个 agent 的调用严格保序；不同 agent 共享全局并发。
 */
export function scheduleHostTask(db, { agent = '', label = '', timeoutMs = 30000, priority = 5, run } = {}) {
  return new Promise((resolve, reject) => {
    if (typeof run !== 'function') { reject(new Error('host task: no run')); return }
    const key = String(agent || '')
    const it = {
      seq: ++qSeq,
      key,
      label: String(label || '').slice(0, 40),
      priority: Number.isFinite(Number(priority)) ? Number(priority) : 5,
      timeoutMs: Math.max(1000, Number(timeoutMs) || 30000),
      enqueuedAt: Date.now(), startedAt: 0, phase: 'waiting', timer: null,
      run, resolve, reject,
    }
    // 排队超时：还没轮到就等超了，直接失败，调用方走兜底
    it.timer = setTimeout(() => {
      if (it.phase !== 'waiting') return
      fail(it, new Error(`host queue timeout: waited ${Date.now() - it.enqueuedAt}ms (${it.label || 'host'})`))
    }, it.timeoutMs)
    if (it.timer.unref) it.timer.unref()
    pending.add(it)
    // 2026-11-17 优先级：回复前的判断（affect:judge）不能排在上一轮总结后面——
    // 高优先级（<3）不挂同 agent 链，直接进闸门抢槽；全局槽也按 priority 插队。
    if (it.priority < 3) { exec(it, db); return }
    // 同一 agent 串成一条链：前一个落定后才启动下一个（topic -> judge 的顺序靠这个）
    const prev = chains.get(key) || Promise.resolve()
    const tail = prev.catch(() => {}).then(() => exec(it, db))
    const keep = tail.catch(() => {})
    chains.set(key, keep)
    keep.finally(() => { if (chains.get(key) === keep) chains.delete(key) })
  })
}

/**
 * 后台宿主调用：把 complete(req) 交给闸门。
 * @param complete 宿主模型的 complete 函数（一般传 kernelModel.complete 或 model.chat 包装）
 * @param agent    同一 agent 保序（一般传 agent_id）
 */
export async function hostComplete(db, { complete, agent = '', label = '', timeoutMs = 30000, priority = 5, ...req } = {}) {
  if (typeof complete !== 'function') throw new Error('host complete: no model')
  return scheduleHostTask(db, { agent, label, timeoutMs, priority, run: () => complete(req) })
}

/** 宿主后台队列快照：给工具和诊断用，只读。 */
export function hostQueueInfo(db) {
  const now = Date.now()
  return {
    concurrency: (() => { try { return concurrency(db) } catch { return 2 } })(),
    running,
    queued: Math.max(0, pending.size - running),
    waiting: waiters.length,
    recent: qRecent.slice(-10),
    at: new Date(now).toISOString(),
  }
}
