/**
 * 本地 Ollama 适配（只给「work 段摘要」用，不碰回复/检索/抽取）。
 *
 * ⚠️ 2026-11-22 主人钉的规矩：**不要改参数！改参数需要申请！**
 *   这里说的参数是：num_gpu / num_ctx / keep_alive / model / url / exe / home / models。
 *   参数一改，ollama 会以为换了一份模型，先卸再载（一次 40 秒以上），
 *   还会把已经全放进显卡的那份顶回 CPU。今晚就是这么被反复重载拖住的。
 *   要动任何一项，先跟主人申请，同意了再改，并在这里写清日期和原因。
 *
 * 2026-11-13：work 段只要一条 ≤100 字 digest + 3~5 个抓手，14B 实测够用（0.7~4 秒/块），
 * 主模型那一路就不用花这笔钱。开关 `memory.cut.work.local` 默认 off；失败一律回退主模型。
 *
 * 地址/模型/可执行文件/家目录都可用 flags 覆盖：
 *   memory.cut.local.url        默认 http://127.0.0.1:11434
 *   memory.cut.local.model      默认 qwen2.5:14b-instruct
 *   memory.cut.local.exe        默认本机便携版（找不到就用 PATH 里的 ollama）
 *   memory.cut.local.home       默认插件目录上一层的 ollama_home（本机用户目录下的 .ollama 写不进）
 *   memory.cut.local.models     默认插件目录上一层的 ollama/models
 *   memory.cut.local.autostart  默认开；0 = 不自动拉服务
 */
import { getFlag } from '../kernel.js'
import { repoRoot } from '../paths.js'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DEF_URL = 'http://127.0.0.1:11434'
const DEF_MODEL = 'qwen2.5:14b-instruct'
const NO_WINDOW = 0x08000000 // CREATE_NO_WINDOW：重启/自动拉服务时不再闪黑框

export function localCutOn(db) {
  try {
    return String(getFlag(db, 'memory.cut.work.local') || '').trim() === '1'
  } catch { return false }
}

/** daily 主模型失败时的兜底：默认 off，线上设 memory.cut.daily.local_fallback=1。 */
export function localDailyFallbackOn(db) {
  try {
    return String(getFlag(db, 'memory.cut.daily.local_fallback') || '').trim() === '1'
  } catch { return false }
}

export function localCutConfig(db) {
  const pick = (key, def) => { try { return String(getFlag(db, key) || '') || def } catch { return def } }
  return { url: pick('memory.cut.local.url', DEF_URL), model: pick('memory.cut.local.model', DEF_MODEL) }
}

/** 本机 Ollama 的位置（可用 flags 覆盖）。便携版默认放在插件目录上一层的 ollama/。 */
export function localServerConfig(db) {
  const pick = (key, def) => { try { return String(getFlag(db, key) || '') || def } catch { return def } }
  let base = ''
  try { base = path.resolve(repoRoot(), '..', '..') } catch { /* 读不到仓库根就退回 PATH */ }
  const portableExe = base
    ? (fs.existsSync(path.join(base, 'ollama', 'ollama-noconsole.exe'))
      ? path.join(base, 'ollama', 'ollama-noconsole.exe')
      : path.join(base, 'ollama', 'ollama.exe'))
    : ''
  const portableHome = base ? path.join(base, 'ollama_home') : ''
  const portableModels = base ? path.join(base, 'ollama', 'models') : ''
  const exe = pick('memory.cut.local.exe', portableExe && fs.existsSync(portableExe) ? portableExe : 'ollama')
  const home = pick('memory.cut.local.home', portableHome && fs.existsSync(portableHome) ? portableHome : path.join(os.homedir(), '.ollama_home'))
  const models = pick('memory.cut.local.models', portableModels && fs.existsSync(portableModels) ? portableModels : path.join(home, 'models'))
  return { exe, home, models }
}

async function ping(url, timeoutMs = 1500) {
  try {
    const res = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) })
    return res.ok
  } catch { return false }
}

export async function localAvailable(db, timeoutMs = 3000) {
  const { url } = localCutConfig(db)
  return ping(url, timeoutMs)
}

let lastEnsure = 0
let lastFailAt = 0
let ensurePromise = null

/**
 * 保活：本地没起就 detached 起一个（不随插件重载/DSH 重启退出）。
 * 防抖：并发调用共用同一个 promise；失败后 5 分钟内不再重拉（避免重启时一堆黑框）；
 *       spawn 带 CREATE_NO_WINDOW。
 */
export async function ensureLocalServer(db, { force = false, waitMs = 20000 } = {}) {
  if (!force && lastEnsure && Date.now() - lastEnsure < 30000) return true
  if (!force && lastFailAt && Date.now() - lastFailAt < 5 * 60000) return false
  if (ensurePromise) return ensurePromise

  ensurePromise = (async () => {
    const { url } = localCutConfig(db)
    if (await ping(url)) { lastEnsure = Date.now(); return true }

    let auto = true
    try {
      const v = getFlag(db, 'memory.cut.local.autostart')
      if (v != null && String(v).trim() !== '') auto = String(v).trim() === '1'
    } catch { /* 读不到就按默认开 */ }
    if (!auto) return false

    const cfg = localServerConfig(db)
    try {
      const child = spawn(cfg.exe, ['serve'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        creationFlags: NO_WINDOW,
        env: {
          ...process.env,
          HOME: cfg.home,
          USERPROFILE: cfg.home,
          LOCALAPPDATA: path.join(cfg.home, 'AppData', 'Local'),
          APPDATA: path.join(cfg.home, 'AppData', 'Roaming'),
          OLLAMA_MODELS: cfg.models,
          OLLAMA_HOST: String(url).replace(/^https?:\/\//, ''),
          // 2026-11-22 主人：常驻、别老卸模型、别抢并行把内存挤爆。
          OLLAMA_KEEP_ALIVE: '-1',
          OLLAMA_MAX_LOADED_MODELS: '2',
          OLLAMA_NUM_PARALLEL: '1',
          OLLAMA_FLASH_ATTENTION: '1',
        },
      })
      child.unref()
    } catch { lastFailAt = Date.now(); return false }

    const until = Date.now() + Math.max(3000, Number(waitMs) || 20000)
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, 700))
      if (await ping(url, 1200)) { lastEnsure = Date.now(); lastFailAt = 0; return true }
    }
    lastFailAt = Date.now()
    return false
  })()

  try { return await ensurePromise } finally { ensurePromise = null }
}

/**
 * 2026-11-22 主人：DSH 起来就把两个本地模型热上，别等用到才现拉。
 *   14B（qwen2.5:14b-instruct）：常驻，keep_alive=-1；
 *   语义模型（qwen3-embedding:0.6b）：同样常驻。
 * 失败不抛，下一次看门狗会再试。
 */
export async function warmLocalModels(db) {
  const { url } = localCutConfig(db)
  // 跟 localComplete 同一套：默认 99 层；-1/负值 = 交给 ollama 自己分；0 才是 CPU。
  const numGpuOf = (m) => {
    try {
      const sku = String(m).replace(/[^a-zA-Z0-9]/g, '_')
      const per = getFlag(db, `memory.cut.local.num_gpu.${sku}`)
      const glob = getFlag(db, 'memory.cut.local.num_gpu')
      const v = (per != null && String(per).trim() !== '') ? per : glob
      const n = v != null && String(v).trim() !== '' ? Number(String(v).trim()) : 99
      return Number.isFinite(n) && n >= 0 ? n : null
    } catch { return 99 }
  }
  const out = []
  const warmChat = async (m) => {
    try {
      const r = await fetch(`${url}/api/chat`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(180000),
        // 2026-11-22：预热必须跟正式调用同参数（num_ctx 也一样），否则 ollama 会把模型
        // 当成另一份配置重新载入，白热一遍。
        body: JSON.stringify({ model: m, stream: false, keep_alive: -1, options: { num_predict: 1, ...(numGpuOf(m) == null ? {} : { num_gpu: numGpuOf(m) }), num_ctx: localNumCtx(db) }, messages: [{ role: 'user', content: '在' }] }),
      })
      out.push([m, r.ok])
    } catch { out.push([m, false]) }
  }
  const warmEmbed = async (m) => {
    try {
      const r = await fetch(`${url}/api/embed`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(120000),
        body: JSON.stringify({ model: m, input: '预热', keep_alive: -1 }),
      })
      out.push([m, r.ok])
    } catch { out.push([m, false]) }
  }
  await warmEmbed('qwen3-embedding:0.6b')
  await warmChat('qwen2.5:14b-instruct')
  return out
}

/**
 * 2026-11-22：上下文长度统一走这里。
 *   原来写死 16384，14B 的 KV cache 要两三个 G，16G 卡上模型+语义模型+桌面已经挤满，
 *   实际分配不够 → llama-server 直接中止（日志 NTSTATUS 0xffffffff）→ 每次调用都冷启动。
 *   现在默认 8192（实测 8192 稳：第二次起 0.2 秒、载入 0 秒、83 tok/s；16384 会崩）。
 *   要改就设 flag `memory.cut.local.num_ctx`；预热、正式调用、看门狗都走这一个函数。
 */
export function localNumCtx(db) {
  try {
    const v = getFlag(db, 'memory.cut.local.num_ctx')
    const n = Number(String(v == null ? '' : v).trim())
    if (Number.isFinite(n) && n >= 512) return n
  } catch { }
  return 8000
}

async function postChat(url, body, timeoutMs) {  return fetch(`${url}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(Math.max(1000, Number(timeoutMs) || 120000)),
  })
}

/** 调本地 /api/chat（JSON 约束）。连不上先重连一次；仍不行就抛错，由调用方走词法/主模型兜底。
 *  2026-11-15：`model` 可临时指定（摘要那条要在失败时明确换 qwen3，不跟着切事的默认走）。 */
async function localCompleteInner(db, { system = '', text = '', maxTokens = 500, timeoutMs = 120000, temperature = 0.1, seed = null, model: wantModel = '', format = 'json', think = null } = {}) {
  const cfg = localCutConfig(db)
  const url = cfg.url
  const model = String(wantModel || '').trim() || cfg.model
  // ⚠️ 不要改参数！改参数需要申请！（num_gpu / num_ctx / keep_alive）
  // 当前口径：99 层全上显卡、ctx 8000、keep_alive -1 常驻；-1/负值 = 交给 ollama 自己分，0 = 明确点名 CPU。
  // 没设过 → 默认 99 层，整块上显卡。
  let numGpu = 99
  try {
    const sku = String(model).replace(/[^a-zA-Z0-9]/g, '_')
    const perModel = getFlag(db, `memory.cut.local.num_gpu.${sku}`)
    const global = getFlag(db, 'memory.cut.local.num_gpu')
    const v = (perModel != null && String(perModel).trim() !== '') ? perModel : global
    if (v != null && String(v).trim() !== '') numGpu = Number(String(v).trim())
  } catch { numGpu = 99 }
  const gpuOpt = (!Number.isFinite(numGpu) || numGpu < 0) ? null : numGpu
  const body = {
    model,
    stream: false,
    // 2026-11-22：原来写死 '120s'，每次正式调用都把预热设的 -1 改回 2 分钟，
    // 于是模型两分钟就被卸、下一次又得整块重载（实测每次 load 17~55 秒，生成只要 1 秒）。
    // 改成 -1：跟预热那条一致，模型常驻，不再来回装。
    keep_alive: -1,
    ...(format ? { format } : {}),
    // 2026-11-17：qwen3 的思考开关。实测 system 里加 /no_think 无效（thinking 照旧 300+ 字），
    // 要真正关掉必须传 think:false（Ollama 0.40 支持）。
    ...(think === false ? { think: false } : {}),
    options: {
      temperature: Number.isFinite(Number(temperature)) ? Number(temperature) : 0.1,
      top_p: 0.9,
      ...(gpuOpt == null ? {} : { num_gpu: gpuOpt }),
      // 2026-11-22：原来写死 16384，显存装不下 → llama-server 崩。改成走 localNumCtx（默认 4096）。
      num_ctx: localNumCtx(db),
      num_predict: Math.max(64, Number(maxTokens) || 500),
      ...(Number.isFinite(Number(seed)) ? { seed: Number(seed) } : {}),
    },
    messages: [
      { role: 'system', content: String(system || '') },
      { role: 'user', content: String(text || '') },
    ],
  }
  // 2026-11-15：qwen3 默认先思考，format:'json' 会被思考顶乱、还慢一倍（实测 15.0s vs 2.3s）。
  // 只对这一类模型关思考；老模型不认这个字段就不用传。
  if (/qwen3/i.test(model)) body.think = false
  const t0 = Date.now()
  if (!(await ensureLocalServer(db))) throw new Error('local not running')
  let res = null
  try { res = await postChat(url, body, timeoutMs) } catch { res = null }
  if (!res || !res.ok) {
    // 连不上 -> 强制重连一次，再试；仍不行就抛错
    if (!(await ensureLocalServer(db, { force: true, waitMs: 12000 }))) throw new Error('local reconnect failed')
    res = await postChat(url, body, timeoutMs)
  }
  if (!res.ok) throw new Error('local http ' + res.status)
  const j = await res.json()
  if (j.error) throw new Error('local: ' + j.error)
  return {
    text: String(j.message?.content || ''),
    ms: Date.now() - t0,
    promptTokens: Number(j.prompt_eval_count) || 0,
    outTokens: Number(j.eval_count) || 0,
  }
}

/* ---------------- 本地调用排队（2026-11-17） ----------------
 * 2026-11-17 主人：本地模型调用经常卡住，要把现在所有调用看明白、统一排好队。
 *
 * 所有走 localComplete 的调用都进这一条队列，不再各自直连 Ollama：
 *   - 并发默认 1（Ollama 一次只真正服务一个生成，多开只会互相拖）；
 *     可用 flags 的 memory.cut.local.concurrency 改（1~4）。
 *   - 优先级（数字小先跑）：1=聊天（情绪精修）、3=切事摘要、5=普通、7=判边/蒸馏这类批量兜底。
 *   - 排队超时：在队列里等的时长算进调用方自己的 timeoutMs，等过头就提前失败，
 *     让调用方走兜底，不占着队列空转（这是「卡住」的来源之一）。
 *   - 每条调用记名字、等了多久、跑了多久：localQueueInfo() 看谁在跑/谁在排/最近怎么样。
 */
export const LOCAL_PRIORITY = Object.freeze({ chat: 1, split: 3, normal: 5, batch: 7 })

const Q_RECENT_MAX = 30
const qItems = []
const qRecent = []
let qRunning = 0
let qManual = 0 // 测试/模拟用：localBegin/localEnd 手动占位
let qSeq = 0

function queueConcurrency(db) {
  try {
    const v = String(getFlag(db, 'memory.cut.local.concurrency') || '').trim()
    const n = Number(v)
    if (Number.isFinite(n) && n >= 1) return Math.min(4, Math.floor(n))
  } catch { /* 读不到就按 1 */ }
  return 1
}

function qRecord(it, ok, err) {
  qRecent.push({
    at: new Date().toISOString(),
    label: it.label || '',
    priority: it.priority,
    waitedMs: Math.max(0, (it.startedAt || Date.now()) - it.enqueuedAt),
    ms: it.startedAt ? Date.now() - it.startedAt : 0,
    ok: !!ok,
    error: ok ? '' : String((err && err.message) || err || '').slice(0, 120),
  })
  if (qRecent.length > Q_RECENT_MAX) qRecent.splice(0, qRecent.length - Q_RECENT_MAX)
}

function qSettle(it, ok, err) {
  if (it.timer) { clearTimeout(it.timer); it.timer = null }
  const i = qItems.indexOf(it)
  if (i >= 0) qItems.splice(i, 1)
  if (it.started) qRunning = Math.max(0, qRunning - 1)
  qRecord(it, ok, err)
  qPump(it.db)
}

function qPump(db) {
  const limit = queueConcurrency(db)
  while (qRunning < limit) {
    let pick = -1
    for (let i = 0; i < qItems.length; i++) {
      const it = qItems[i]
      if (it.started) continue
      if (pick < 0) { pick = i; continue }
      const cur = qItems[pick]
      // 优先级小的先跑；同级按入队顺序
      if (it.priority < cur.priority || (it.priority === cur.priority && it.seq < cur.seq)) pick = i
    }
    if (pick < 0) return
    const it = qItems[pick]
    it.started = true
    qRunning++
    if (it.timer) { clearTimeout(it.timer); it.timer = null }
    // 执行预算 = 总预算 - 排队已花掉的时间（至少给 2 秒，别传负数）
    const left = Math.max(2000, it.timeoutMs - (Date.now() - it.enqueuedAt))
    Promise.resolve()
      .then(() => { it.startedAt = Date.now(); return it.run(left) })
      .then(
        (v) => { qSettle(it, true); it.resolve(v) },
        (e) => { qSettle(it, false, e); it.reject(e) },
      )
  }
}

/**
 * 排队执行一个本地调用。对外一般不直接调，走 localComplete。
 * run(leftMs) 里的 leftMs 是这次执行还能用的时间（已扣掉排队等待）。
 */
export function scheduleLocalTask(db, { priority = LOCAL_PRIORITY.normal, timeoutMs = 120000, label = '', run } = {}) {
  return new Promise((resolve, reject) => {
    if (typeof run !== 'function') { reject(new Error('local task: no run')); return }
    const it = {
      seq: ++qSeq,
      priority: Math.max(0, Number(priority) || 0),
      timeoutMs: Math.max(1000, Number(timeoutMs) || 120000),
      label: String(label || '').slice(0, 40),
      enqueuedAt: Date.now(), startedAt: 0, started: false, timer: null, db, run, resolve, reject,
    }
    // 排队超时：还没轮到就等超了，直接失败，别让调用方傻等
    it.timer = setTimeout(() => {
      if (it.started) return
      const i = qItems.indexOf(it)
      if (i < 0) return
      qItems.splice(i, 1)
      const e = new Error(`local queue timeout: waited ${Date.now() - it.enqueuedAt}ms (${it.label || 'local'})`)
      qRecord(it, false, e)
      qPump(db)
      it.reject(e)
    }, it.timeoutMs)
    if (it.timer.unref) it.timer.unref()
    qItems.push(it)
    qPump(db)
  })
}

/* 正在跑几个本地调用。切事据此让路——比「最近有没有人说话」准：
   看的是模型真的在被用，不是猜人可能在等。 */
export function localBusy() { return qRunning + qManual }
/** 手动占位（测试模拟「本地正忙」，不影响真实队列）。 */
export function localBegin() { qManual++ }
export function localEnd() { qManual = Math.max(0, qManual - 1) }
/** 排队等着的调用数。 */
export function localPending() { return qItems.filter((x) => !x.started).length }

/** 队列快照：谁在跑、谁在排、最近几条。给工具和诊断用，只读。 */
export function localQueueInfo(db) {
  const now = Date.now()
  const running = qItems
    .filter((x) => x.started)
    .map((x) => ({ label: x.label, priority: x.priority, runningMs: now - (x.startedAt || now), timeoutMs: x.timeoutMs }))
  const queued = qItems
    .filter((x) => !x.started)
    .sort((a, b) => a.priority - b.priority || a.seq - b.seq)
    .map((x) => ({ label: x.label, priority: x.priority, waitedMs: now - x.enqueuedAt, timeoutMs: x.timeoutMs }))
  return {
    concurrency: (() => { try { return queueConcurrency(db) } catch { return 1 } })(),
    busy: localBusy(),
    running: qRunning,
    queued: queued.length,
    runningItems: running,
    queue: queued,
    recent: qRecent.slice(-10),
  }
}

/** 对外入口：所有本地调用都从这儿过（进队列，按优先级排）。 */
export async function localComplete(db, req = {}) {
  const priority = Number.isFinite(Number(req.priority)) ? Number(req.priority) : LOCAL_PRIORITY.normal
  const timeoutMs = Math.max(1000, Number(req.timeoutMs) || 120000)
  return scheduleLocalTask(db, {
    priority,
    timeoutMs,
    label: String(req.label || ''),
    run: (leftMs) => localCompleteInner(db, { ...req, timeoutMs: leftMs }),
  })
}
