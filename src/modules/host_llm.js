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
import { compareQueued, blockOf } from './queue_policy.js'

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
  // 2026-11-22 主人：跨会话要排队——不管开几个对话，同一时刻只让一个调宿主模型。
  // 2026-11-23 改：并发 1 → 2。宿主是云端、不占本地显存，两个会话可以各调一个；
  // 真正要防的「同会话内顺序颠倒」由下面按会话的链保证，不必把全局压成 1。
  // 要回到串行仍可用 llm.host.concurrency=1 覆盖。
  return 2
}

function acquire(db, priority = 5) {
  if (running < concurrency(db)) { running++; return Promise.resolve() }
  return new Promise((resolve) => {
    waiters.push({ resolve, priority: Number(priority) || 5, seq: ++qSeq })
    // 2026-11-22 三块排队：规则只在 queue_policy.js 里定义，这里只调用。
    waiters.sort(compareQueued)
  })
}

function release() {
  running = Math.max(0, running - 1)
  const next = waiters.shift()
  if (next) { running++; next.resolve() }
}

let probeFn = null
/** 2026-11-22：宿主队列的变化也推给看板（和本地队列一样，变了才说）。 */
const hostChangeListeners = new Set()
export function onHostChange(fn) {
  if (typeof fn !== 'function') return () => {}
  hostChangeListeners.add(fn)
  return () => { hostChangeListeners.delete(fn) }
}
/** 2026-11-22 主人：别再从日志里抠——单独一张表，每次宿主调用记一行，重启后从表里读。 */
let hostDb = null
let hostInserts = 0
export function setHostDb(db) { hostDb = db || null }

/** 2026-11-22：把历史记录灌回去——进程重启后从插件的调用日志读回，看板不会一重启就清空。 */
export function setHostRecent(list) {
  if (!Array.isArray(list)) return
  qRecent.length = 0
  for (const x of list.slice(-30)) {
    if (x && x.at && x.label) qRecent.push({ at: String(x.at), label: String(x.label), ms: Number(x.ms) || 0, slot: 'host', ok: x.ok == null ? true : !!Number(x.ok) })
  }
}

function notifyHostChange() {
  if (!hostChangeListeners.size) return
  let snap = null
  try { snap = hostQueueInfo(null) } catch { return }
  for (const fn of hostChangeListeners) {
    try { fn(snap) } catch { /* 一个订阅者出错不影响别人 */ }
  }
}
/** 2026-11-22：把每条宿主调用的等待/执行耗时接到插件的 hook.log 上，方便看「卡在哪一段」。 */
export function setHostProbe(fn) {
  probeFn = typeof fn === 'function' ? fn : null
}

function record(it, ok, err) {
  const waitedMs = Math.max(0, (it.startedAt || Date.now()) - it.enqueuedAt)
  const ms = it.startedAt ? Date.now() - it.startedAt : 0
  qRecent.push({
    at: new Date().toISOString(),
    label: it.label || '',
    agent: String(it.key || '').slice(0, 8),
    waitedMs,
    ms,
    ok: !!ok,
    error: ok ? '' : String((err && err.message) || err || '').slice(0, 120),
  })
  try {
    if (probeFn) {
      probeFn('host label=' + String(it.label || '-').slice(0, 28) + ' p' + it.priority
        + ' wait=' + waitedMs + 'ms run=' + ms + 'ms ' + (ok ? 'ok' : '✗ ' + String((err && err.message) || err || '').slice(0, 60)))
    }
  } catch { /* 探针不影响调用 */ }
  if (qRecent.length > Q_RECENT_MAX) qRecent.splice(0, qRecent.length - Q_RECENT_MAX)
  // 2026-11-22：落一行到表里，重启后看板还能看见。
  try {
    if (hostDb) {
      // 注意：这里参数叫 it，不是 snap（以前写错过一次，报错被 catch 吞了，表一直空）。
      hostDb.prepare('INSERT INTO host_calls (at, label, ms, ok) VALUES (?, ?, ?, ?)')
        .run(new Date().toISOString(), String(it.label || '-').slice(0, 40), ms, ok ? 1 : 0)
      // 这张表只给面板看，不留历史：每写二十条清一次，只留最近六十条。
      if (++hostInserts % 20 === 0) {
        hostDb.prepare('DELETE FROM host_calls WHERE id NOT IN (SELECT id FROM host_calls ORDER BY id DESC LIMIT 60)').run()
      }
    }
  } catch { /* 写表/清表失败不影响队列 */ }
  notifyHostChange()
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
  const unlimited = it.timeoutMs === 0   // 2026-11-22 主人：0 = 不设超时，让它自然跑完
  const waited = Date.now() - it.enqueuedAt
  if (!unlimited && waited > it.timeoutMs) { fail(it, new Error(`host queue timeout: waited ${waited}ms (${it.label || 'host'})`)); return }
  await acquire(db, it.priority)
  if (it.phase === 'timeout') { release(); return }
  if (it.timer) { clearTimeout(it.timer); it.timer = null }
  it.phase = 'running'
  it.startedAt = Date.now()
  notifyHostChange()
  // 2026-11-17：预算管到「执行」——排队 + 执行合计不得超过 timeoutMs。
  // 之前只管排队，判断层实际跑 35 秒也照等；情绪链不吃这个亏，超了直接弃、回退规则。
  // 说明：这里的超时不取消真正的模型请求（kernelModel.complete 不支持取消），
  // 只把结果丢掉；宿主侧那条请求会自己结束。
  // 2026-11-22：timeoutMs=0 = 不截断。以前 15 秒截断会把「只是慢一点」判成失败，
  // 再触发重试，叠成分钟级卡顿。现在不设超时，真的报错才走重试。
  const left = unlimited ? 0 : Math.max(0, it.timeoutMs - (Date.now() - it.enqueuedAt))
  let runTimer = null
  try {
    const v = unlimited
      ? await it.run()
      : await Promise.race([
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
export function scheduleHostTask(db, { agent = '', lane = '', label = '', timeoutMs = 30000, priority = 5, block = null, run } = {}) {
  return new Promise((resolve, reject) => {
    if (typeof run !== 'function') { reject(new Error('host task: no run')); return }
    // 2026-11-23：链的键加上会话（lane）。
    // 以前只按 agent 编，两个会话被串成同一条链——一个会话的调用要等另一个跑完，
    // 判断层等出十几秒。加上 lane 后：同一会话内部仍严格保序（总结一定在判断前），
    // 两个会话各走各的链，不再互相等。不传 lane 的调用保持原来的 agent 级行为。
    const key = String(agent || '') + (lane ? '|' + String(lane) : '')
    const raw = Number(timeoutMs)
    const unlimited = raw === 0   // 2026-11-22：0 = 不设超时（不截断、不假失败）
    const it = {
      seq: ++qSeq,
      key,
      label: String(label || '').slice(0, 40),
      priority: Number.isFinite(Number(priority)) ? Number(priority) : 5,
      // 2026-11-22 强制引导：必须声明属于哪一块。没传就按标签推断，推断不出的记警告。
      block: block != null ? blockOf(block) : blockOf(label),
      blockInferred: block == null,
      timeoutMs: unlimited ? 0 : Math.max(1000, raw || 30000),
      enqueuedAt: Date.now(), startedAt: 0, phase: 'waiting', timer: null,
      run, resolve, reject,
    }
    if (block == null && probeFn) {
      try { probeFn('queue-block-inferred label=' + it.label + ' block=' + it.block) } catch { /* 探针失败不影响 */ }
    }
    // 排队超时：还没轮到就等超了，直接失败，调用方走兜底。不设超时时没有这一步。
    if (!unlimited) {
      it.timer = setTimeout(() => {
        if (it.phase !== 'waiting') return
        fail(it, new Error(`host queue timeout: waited ${Date.now() - it.enqueuedAt}ms (${it.label || 'host'})`))
      }, it.timeoutMs)
      if (it.timer.unref) it.timer.unref()
    }
    pending.add(it)
    notifyHostChange()
    // 2026-11-22 主人定：聊天的调用要严格先来后到，不许插队。
    // 以前 2026-11-17 为了「回复别等上一轮总结」，让 priority<3 的判定直接抢槽、
    // 不挂同 agent 链——结果下一轮判定会插到上一轮摘要前面，摘要还没生成，
    // 这一轮读到的就是旧的（甚至空的）。现在全部挂链，同会话按发起顺序走。
    // 同一 agent 串成一条链：前一个落定后才启动下一个（judge -> summary -> 下一轮 judge）
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
export async function hostComplete(db, { complete, agent = '', lane = '', label = '', timeoutMs = 30000, priority = 5, block = null, ...req } = {}) {
  if (typeof complete !== 'function') throw new Error('host complete: no model')
  return scheduleHostTask(db, { agent, lane, label, timeoutMs, priority, block, run: () => complete(req) })
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
