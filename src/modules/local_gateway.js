/**
 * 本地模型唯一通道（2026-11-22，主人钉的规矩）
 *
 * 一句话：本机 Ollama 只有一个口子，所有调用（聊天、切事、向量、实验小模型）
 * 都从这一个口子进，排队，一次只进一个任务；参数写死，不给改。
 *
 * 为什么要有这一层（2026-11-22 现场）：
 *   1. 原来有两条半路：localComplete 走了队列，但 warmLocalModels / embedding /
 *      判官实验脚本各自直连 11434。队列挡的是「一半」，另一半照样能撞上去。
 *   2. Ollama 的 NUM_PARALLEL=1，一个请求在生成，别的请求就在它后面干等。
 *      embedding 那条只等 800ms 就放弃 → 向量静默全关；聊天那条等久了就像「卡住」。
 *   3. 实验用的判官模型（gemma4:12b 等）不在常驻名单里。它一被调用，
 *      MAX_LOADED_MODELS=2 就会挤掉常驻的 14B，然后下一次聊天要整块重载（40 秒起）。
 *      这就是「一次启动两个小模型进程」的代价——现在改成排队 + 换模型前先卸。
 *
 * 现在的规矩：
 *   - 参数（url / model / num_ctx / num_gpu / keep_alive）写死在 GATEWAY 里，
 *     不读 flag、不接受 req 覆盖。想改要跟主人申请，改了在这文件里写日期和原因。
 *   - 两个槽，各自写死 1：14B 一个槽（聊天/切事/判边/实验），语义模型一个槽（只跑向量）。
 *     不同模型、不同进程，互不等待——向量不再因为前面排着 60 秒的切事而超时。
 *     同一个模型一次仍然只进一个任务。
 *   - 常驻两个：qwen2.5:14b-instruct（聊天/切事）+ qwen3-embedding:0.6b（向量）。
 *     各自只有这一条稳定通道。
 *   - 实验小模型排 14B 那个槽；换模型前先卸常驻聊天模型，跑完立刻卸掉、
 *     把 14B 热回来。全程同一个槽，所以不可能同时跑两个小模型。
 *   - 嵌套调用（任务里再调通道）直接就地跑，不再排——否则一个槽等自己，永久卡死。
 *   - 每个任务都有硬超时和 AbortController，超时立刻放槽，不会一直占着。
 *
 * ❌ 禁止（谁写谁拆，体检脚本会扫）：
 *   1. 不许在别处 fetch `127.0.0.1:11434` 的 /api/chat、/api/generate、/api/embed ——
 *      绕过去就不排队，就又会「卡住」。要调模型只能进本模块的队列（或 /local/exp）。
 *   2. 不许自己 spawn `ollama serve` / `llama-server` / 任何模型进程 ——
 *      起第二个进程就会把常驻 14B 挤下显卡。服务没起只用 ensureServer()（带进程锁）。
 *   3. 不许改 GATEWAY 里的参数 —— 改一次 ollama 就当换了份模型，先卸再载 40 秒起。
 *   4. 不许在实验脚本里另开一条队列 —— 实验也排这一条，换模型由 gatewayExperiment 负责。
 * 体检：`node scripts/check-local-gateway.mjs`（静态扫 + --live 看真实队列与进程数）。
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
// 注意：这里**不 import kernel.js**。kernel.js 会 import model.js，model.js 又要用本模块，
// 静态引入会成环（拿到的可能是半初始化的绑定）。所以通道不碰参数库，参数就是写死的这份。
import { dataDir, repoRoot } from '../paths.js'
import { compareQueued, BLOCK, blockOf, blockOfTask } from './queue_policy.js'

/* ---------------- 写死的参数（不许改，改了要申请） ---------------- */

export const GATEWAY = Object.freeze({
  url: 'http://127.0.0.1:11434',
  concurrency: 1,
  chat: Object.freeze({
    model: 'qwen2.5:14b-instruct',
    numCtx: 8000,   // 8192 稳；16384 会崩（llama-server NTSTATUS 0xffffffff）
    numGpu: 99,     // 整块上显卡
    keepAlive: -1,  // 常驻，别卸
    temperature: 0.1,
    topP: 0.9,
  }),
  embed: Object.freeze({
    model: 'qwen3-embedding:0.6b',
    keepAlive: -1,
    batch: 16,
  }),
  exp: Object.freeze({
    maxTokens: 4096,      // 实验一次最多出这么多 token，防它一个人占着槽
    keepAlive: 0,         // 实验模型跑完立刻卸，不跟常驻抢显存
  }),
})

/**
 * 优先级（数字小先跑）。主人 2026-11-22 定的顺序：
 *   **对话 > 实验 > 事后整理**。
 * 所以实验（3）排在切事（5）/ 普通（6）/ 批量兜底（7）前面——有人等着看的先跑，
 * 夜里慢慢整理的那些让路。注意：优先级只决定「下一个谁先跑」，**不打断正在跑的**；
 * 实验正在跑时，对话要等它跑完（一次只进一个任务）。
 */
export const PRIORITY = Object.freeze({
  chat: 1,      // 聊天 / 情绪精修：人在等，最高
  embed: 2,     // 向量：聊天要用的前置，轻快
  exp: 3,       // 实验（判官、对照）：人叫的，排在事后整理前面
  split: 5,     // 切事摘要（事后整理）
  normal: 6,    // 普通本地调用（事后整理）
  batch: 7,     // 判边 / 蒸馏这类批量兜底、预热（最不急）
})

const MAX_TASK_MS = 300000   // 单任务硬顶 5 分钟，超过一定放槽（防「卡住」）
const NO_WINDOW = 0x08000000 // CREATE_NO_WINDOW

/* ---------------- 队列 ---------------- */

const als = new AsyncLocalStorage()
const qItems = []
const qRecent = []
/* 2026-11-22 主人：本地队列的完成记录也要跨重启——和宿主那张表一个道理。
   它原来只在内存里，DSH 一重启端口变、看板那两行就空。 */
let localDb = null
let localInserts = 0
export function setLocalDb(db) { localDb = db || null }
/** 把历史灌回去（启动时从表里读）。 */
export function setLocalRecent(list) {
  if (!Array.isArray(list)) return
  qRecent.length = 0
  for (const x of list.slice(-40)) {
    if (!x || !x.at || !x.label) continue
    qRecent.push({
      at: String(x.at), slot: String(x.slot || 'chat'), lane: String(x.lane || 'normal'),
      label: String(x.label), priority: Number(x.priority) || 0,
      waitedMs: 0, ms: Number(x.ms) || 0, ok: x.ok == null ? true : !!Number(x.ok), reentrant: false, error: '',
    })
  }
}
const Q_RECENT_MAX = 40
/**
 * 两个槽，不是一个。
 * 主人 2026-11-22 问的正是这个：14B 和语义模型**不是同一个模型、不是同一个进程**，
 * 没必要互相让路。而且互相让路会让向量吃亏——它只肯等 800ms，前面排着一个 60 秒的
 * 切事，它就超时了，向量检索会静默失效。
 *   chat 槽：14B（聊天 / 切事 / 判边 / 实验；换实验模型时这个槽被占住）
 *   embed 槽：语义模型（只跑向量，永远不跟 14B 抢）
 * 每个槽仍然写死 1：同一个模型一次只进一个任务。
 */
const SLOTS = Object.freeze({ chat: 1, embed: 1 })
const runningBySlot = { chat: 0, embed: 0 }
let manualHold = 0
let seq = 0

/* 2026-11-22 主人：看板别每 1.5 秒来问一次，改成「变了才说」。
   入队 / 开始 / 完成三处调 notifyChange，120ms 内合并一次，推一份纯内存快照出去。
   没人在看的时候（没有订阅者）它什么都不做，零开销。 */
const changeListeners = new Set()
let changeTimer = null
export function onGatewayChange(fn) {
  if (typeof fn !== 'function') return () => {}
  changeListeners.add(fn)
  return () => { changeListeners.delete(fn) }
}
function notifyChange() {
  if (!changeListeners.size) return
  // 2026-11-22：原来合并 120ms，结果「开始」和「完成」被压成一条，只发出跑完那版——
  // 面板上槽位永远是空的。现在每次变化各推各的；一次任务最多三条，流量可忽略。
  let snap = null
  try { snap = quickStatus() } catch { return }
  for (const fn of changeListeners) {
    try { fn(snap) } catch { /* 一个订阅者出错不影响别人 */ }
  }
}

const bus = { lastError: '', lastErrorAt: '', swaps: 0, swapModel: '' }

/** lane → 槽。只有向量用自己的槽，其余全在 14B 那个槽上排。 */
function slotOf(lane) {
  return String(lane || '') === 'embed' ? 'embed' : 'chat'
}

function totalRunning() {
  return runningBySlot.chat + runningBySlot.embed
}

function record(it, ok, err) {
  qRecent.push({
    at: new Date().toISOString(),
    slot: it.slot,
    lane: it.lane,
    label: it.label,
    priority: it.priority,
    waitedMs: Math.max(0, (it.startedAt || Date.now()) - it.enqueuedAt),
    ms: it.startedAt ? Date.now() - it.startedAt : 0,
    ok: !!ok,
    reentrant: !!it.reentrant,
    error: ok ? '' : String((err && err.message) || err || '').slice(0, 140),
  })
  if (!ok) { bus.lastError = String((err && err.message) || err || '').slice(0, 200); bus.lastErrorAt = new Date().toISOString() }
  if (qRecent.length > Q_RECENT_MAX) qRecent.splice(0, qRecent.length - Q_RECENT_MAX)
  // 落一行到表里（写失败不影响队列）：看板重启后才不会空。
  try {
    if (localDb) {
      const last = qRecent[qRecent.length - 1]
      localDb.prepare('INSERT INTO local_calls (at, slot, label, ms, ok) VALUES (?, ?, ?, ?, ?)')
        .run(String(last.at), String(last.slot || 'chat'), String(last.label || '-').slice(0, 40), Number(last.ms) || 0, last.ok ? 1 : 0)
      // 这张表也只给面板看：每写二十条清一次，留最近一百二十条。
      if (++localInserts % 20 === 0) {
        localDb.prepare('DELETE FROM local_calls WHERE id NOT IN (SELECT id FROM local_calls ORDER BY id DESC LIMIT 120)').run()
      }
    }
  } catch { /* 写表失败不影响队列 */ }
}

function pickNext(slot) {
  let best = -1
  for (let i = 0; i < qItems.length; i++) {
    const it = qItems[i]
    if (it.started || it.slot !== slot) continue
    // 2026-11-22 三块排队：块间可插队、块内先来后到。规则只在 queue_policy.js 里定义。
    if (best < 0 || compareQueued(it, qItems[best]) < 0) best = i
  }
  return best
}

function settle(it, ok, value, err) {
  if (it.watchdog) { clearTimeout(it.watchdog); it.watchdog = null }
  if (it.waitTimer) { clearTimeout(it.waitTimer); it.waitTimer = null }
  const i = qItems.indexOf(it)
  if (i >= 0) qItems.splice(i, 1)
  if (it.started) runningBySlot[it.slot] = Math.max(0, runningBySlot[it.slot] - 1)
  it.started = true
  record(it, ok, err)
  notifyChange()
  if (ok) it.resolve(value)
  else it.reject(err || new Error('local gateway task failed'))
  pump()
}

function pump() {
  // 每个槽写死 1：同一个模型一次只进一个任务。两个槽互不等待（不同模型、不同进程）。
  for (const slot of Object.keys(SLOTS)) {
    while (runningBySlot[slot] < SLOTS[slot]) {
      const i = pickNext(slot)
      if (i < 0) break
      const it = qItems[i]
      if (it.started) break
      it.started = true
      runningBySlot[slot]++
      if (it.waitTimer) { clearTimeout(it.waitTimer); it.waitTimer = null }
      it.startedAt = Date.now()
      notifyChange()
      const budget = Math.max(1000, it.timeoutMs - (it.startedAt - it.enqueuedAt))
      const ac = new AbortController()
      let killed = false
      it.watchdog = setTimeout(() => {
        killed = true
        try { ac.abort(new Error(`gateway timeout ${Math.min(budget, MAX_TASK_MS)}ms (${it.label || it.lane})`)) } catch { /* ignore */ }
      }, Math.min(budget, MAX_TASK_MS))
      if (it.watchdog.unref) it.watchdog.unref()
      als.run(true, () => {
        Promise.resolve()
          .then(() => it.run({ signal: ac.signal, leftMs: budget, lane: it.lane, slot }))
          .then(
            (v) => { if (killed) return; settle(it, true, v) },
            (e) => { settle(it, false, null, e) },
          )
      })
    }
  }
}

/**
 * 往通道里放一个任务。**这是唯一的入口**（local_llm.js 的 localComplete 也走这里）。
 * 嵌套调用（已经在槽里）就地执行：不再排队，避免一个槽等自己。
 */
export function enqueue(db, { lane = 'normal', label = '', priority = PRIORITY.normal, timeoutMs = 120000, run } = {}) {
  if (typeof run !== 'function') return Promise.reject(new Error('gateway: no run'))
  const wait = Math.max(1000, Number(timeoutMs) || 120000)
  const labelOf = String(label || '').slice(0, 48)

  // 已经在运行的任务里再调通道：就地跑，不占新槽。
  if (als.getStore()) {
    return Promise.resolve().then(() => run({ signal: null, leftMs: wait, lane, reentrant: true }))
  }

  return new Promise((resolve, reject) => {
    const laneOf = String(lane || 'normal')
    const it = {
      seq: ++seq,
      lane: laneOf,
      slot: slotOf(laneOf),
      label: labelOf,
      // 2026-11-22：块在入队时定下来。先看标签里明确写的前缀，再看 lane——
      // 不能拿任意标签去猜（实验里 label 写成 "demo-A" 会被判成聊天块）。
      block: blockOfTask(labelOf, laneOf),
      priority: Math.max(0, Number(priority) || 0),
      timeoutMs: wait,
      enqueuedAt: Date.now(),
      startedAt: 0,
      started: false, watchTimer: null, waitTimer: null, watchdog: null,
      run, resolve, reject,
    }
    // 还没轮到就等超了：直接失败，让调用方走兜底，别让调用方和队列互相等死。
    it.waitTimer = setTimeout(() => {
      if (it.started) return
      const e = new Error(`gateway queue timeout: waited ${Date.now() - it.enqueuedAt}ms (${it.label || it.lane}@${it.slot})`)
      settle(it, false, null, e)
    }, wait)
    if (it.waitTimer.unref) it.waitTimer.unref()
    qItems.push(it)
    notifyChange()
    pump()
  })
}

/* ---------------- 服务器：只许一个进程 ---------------- */

function lockFile() {
  try { return path.join(dataDir(), 'local-gateway.lock') } catch { return '' }
}

function pidAlive(pid) {
  const n = Number(pid) || 0
  if (!n || n <= 0) return false
  try { process.kill(n, 0); return true } catch { return false }
}

function readLock() {
  const f = lockFile()
  if (!f) return null
  try {
    const o = JSON.parse(fs.readFileSync(f, 'utf8'))
    return o && typeof o === 'object' ? o : null
  } catch { return null }
}

function writeLock(pid) {
  const f = lockFile()
  if (!f) return
  try { fs.writeFileSync(f, JSON.stringify({ pid, at: new Date().toISOString(), exe: 'ollama-serve' })) } catch { /* 写不进去不影响调用 */ }
}

/** 服务位置：写死本机便携版优先，其次 PATH 里的 ollama。环境变量只认这三项，不读参数库。 */
export function serverConfig() {
  const pick = (envKey, def) => String(process.env[envKey] || '').trim() || def
  let base = ''
  try { base = path.resolve(repoRoot(), '..', '..') } catch { /* fall back */ }
  const portableExe = base
    ? (fs.existsSync(path.join(base, 'ollama', 'ollama-noconsole.exe'))
      ? path.join(base, 'ollama', 'ollama-noconsole.exe')
      : path.join(base, 'ollama', 'ollama.exe'))
    : ''
  const portableHome = base ? path.join(base, 'ollama_home') : ''
  const portableModels = base ? path.join(base, 'ollama', 'models') : ''
  const exe = pick('DSHC_OLLAMA_EXE', portableExe && fs.existsSync(portableExe) ? portableExe : 'ollama')
  const home = pick('DSHC_OLLAMA_HOME', portableHome && fs.existsSync(portableHome) ? portableHome : path.join(os.homedir(), '.ollama_home'))
  const models = pick('DSHC_OLLAMA_MODELS', portableModels && fs.existsSync(portableModels) ? portableModels : path.join(home, 'models'))
  return { exe, home, models }
}

let lastEnsureAt = 0
let lastFailAt = 0
let ensurePromise = null

export async function gatewayPing(timeoutMs = 1200) {
  try {
    const res = await fetch(`${GATEWAY.url}/api/tags`, { signal: AbortSignal.timeout(Math.max(200, timeoutMs)) })
    return res.ok
  } catch { return false }
}

/**
 * 服务保活：本机没起就 detached 起一个。
 * 关键纪律：**只许一个进程**——先看锁文件里的 pid，还活着就只等端口，不再 spawn。
 */
export async function ensureServer({ force = false, waitMs = 20000, timeoutMs = 1200 } = {}) {
  if (await gatewayPing(timeoutMs)) return true
  if (ensurePromise) return ensurePromise
  if (!force && lastEnsureAt && Date.now() - lastEnsureAt < 30000) return true
  if (!force && lastFailAt && Date.now() - lastFailAt < 5 * 60000) return false

  ensurePromise = (async () => {
    // 锁文件里有人活着：不再拉新进程，等那个起来。
    const lock = readLock()
    if (lock && pidAlive(lock.pid)) {
      const until = Date.now() + Math.max(2000, Number(waitMs) || 20000)
      while (Date.now() < until) {
        await new Promise((r) => setTimeout(r, 600))
        if (await gatewayPing(1200)) { lastEnsureAt = Date.now(); return true }
      }
      return false
    }

    const cfg = serverConfig()
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
          OLLAMA_HOST: GATEWAY.url.replace(/^https?:\/\//, ''),
          // 常驻、别老卸模型；并行锁 1，队列已经在上面排过队了。
          OLLAMA_KEEP_ALIVE: '-1',
          OLLAMA_MAX_LOADED_MODELS: '2',
          OLLAMA_NUM_PARALLEL: '1',
          OLLAMA_FLASH_ATTENTION: '1',
        },
      })
      child.unref()
      writeLock(child.pid)
    } catch { lastFailAt = Date.now(); return false }

    const until = Date.now() + Math.max(3000, Number(waitMs) || 20000)
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, 700))
      if (await gatewayPing(1200)) { lastEnsureAt = Date.now(); lastFailAt = 0; return true }
    }
    lastFailAt = Date.now()
    return false
  })()

  try { return await ensurePromise } finally { ensurePromise = null }
}

/* ---------------- HTTP ---------------- */

async function postJson(pathname, body, { signal = null, timeoutMs = 120000 } = {}) {
  const ac = new AbortController()
  const timer = setTimeout(() => { try { ac.abort(new Error('request timeout')) } catch { /* ignore */ } }, Math.max(1000, Number(timeoutMs) || 120000))
  const onAbort = () => { try { ac.abort(signal.reason) } catch { /* ignore */ } }
  if (signal) signal.addEventListener('abort', onAbort)
  try {
    const res = await fetch(GATEWAY.url + pathname, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ac.signal,
    })
    const text = await res.text()
    let json = null
    try { json = text ? JSON.parse(text) : null } catch { json = null }
    if (!res.ok) throw new Error(`local http ${res.status}: ${String(text || '').slice(0, 160)}`)
    if (json && json.error) throw new Error('local: ' + String(json.error).slice(0, 160))
    return json || {}
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onAbort)
  }
}

async function getJson(pathname, { timeoutMs = 2000 } = {}) {
  const res = await fetch(GATEWAY.url + pathname, { signal: AbortSignal.timeout(Math.max(200, timeoutMs)) })
  if (!res.ok) throw new Error('local http ' + res.status)
  return res.json()
}

function chatBody(model, { system = '', text = '', maxTokens = 500, temperature = null, format = 'json', keepAlive = null, think = null } = {}) {
  const c = GATEWAY.chat
  const body = {
    model,
    stream: false,
    keep_alive: keepAlive == null ? c.keepAlive : keepAlive,
    ...(format ? { format } : {}),
    // qwen3 / gemma4 这类 thinking 模型会把 token 全花在思考上、content 回空。
    // 只对实验模型传；常驻的 qwen2.5 不认这个字段，也没必要传。
    ...(think === false ? { think: false } : {}),
    options: {
      temperature: Number.isFinite(Number(temperature)) ? Number(temperature) : c.temperature,
      top_p: c.topP,
      num_gpu: c.numGpu,
      num_ctx: c.numCtx,
      num_predict: Math.max(16, Number(maxTokens) || 500),
    },
    messages: [
      { role: 'system', content: String(system || '') },
      { role: 'user', content: String(text || '') },
    ],
  }
  return body
}

/* ---------------- 常驻模型：预热 ---------------- */

/** 把常驻模型热上（各自排自己的槽，不互相挡）。DSH 起来时调一次，看门狗可以再调。 */
export async function warmResident(db = null) {
  const out = []
  try {
    await enqueue(db, {
      // lane: embed → 走语义模型那个槽，跟 14B 的活互不等待
      lane: 'embed', label: 'warm:embed', priority: PRIORITY.batch, timeoutMs: 120000,
      run: async ({ signal, leftMs }) => {
        const j = await postJson('/api/embed', { model: GATEWAY.embed.model, input: '预热', keep_alive: GATEWAY.embed.keepAlive }, { signal, timeoutMs: leftMs })
        out.push(['embed', Array.isArray(j.embeddings) ? j.embeddings.length > 0 : false])
      },
    })
  } catch (e) { out.push(['embed', false, String(e && e.message).slice(0, 80)]) }
  try {
    await enqueue(db, {
      lane: 'warm', label: 'warm:chat', priority: PRIORITY.batch, timeoutMs: 180000,
      run: async ({ signal, leftMs }) => {
        const j = await postJson('/api/chat', chatBody(GATEWAY.chat.model, { text: '在', maxTokens: 1, format: '' }), { signal, timeoutMs: leftMs })
        out.push(['chat', !!String(j.message?.content || '')])
      },
    })
  } catch (e) { out.push(['chat', false, String(e && e.message).slice(0, 80)]) }
  return out
}

/* ---------------- 聊天 / 向量：走队列 ---------------- */

/**
 * 聊天（切事摘要、情绪精修、普通调用都走这里）。
 * **model 参数写死**：req.model 会被忽略——那是以前「临时换模型」的口子，
 * 换一次模型 ollama 就重载一次，正是「卡住」的来源。
 */
export async function gatewayChat(db, req = {}) {
  const {
    system = '', text = '', maxTokens = 500, timeoutMs = 120000,
    format = 'json', temperature = null, priority = PRIORITY.normal, label = '',
  } = req
  const want = String(req.model || '').trim()
  const model = GATEWAY.chat.model
  const lane = 'chat'
  return enqueue(db, {
    lane, label: label || 'chat', priority, timeoutMs,
    run: async ({ signal, leftMs }) => {
      if (!(await ensureServer())) throw new Error('local not running')
      const t0 = Date.now()
      const j = await postJson('/api/chat', chatBody(model, { system, text, maxTokens, format, temperature }), { signal, timeoutMs: leftMs })
      return {
        text: String(j.message?.content || ''),
        ms: Date.now() - t0,
        promptTokens: Number(j.prompt_eval_count) || 0,
        outTokens: Number(j.eval_count) || 0,
        model,
        ignoredModel: want && want !== model ? want : '',
      }
    },
  })
}

/** 向量：批量，走同一条队列。返回 number[][]。 */
export async function gatewayEmbed(db, inputs, { timeoutMs = 20000, priority = PRIORITY.embed, label = 'embed' } = {}) {
  const list = (Array.isArray(inputs) ? inputs : [inputs]).map((x) => String(x == null ? '' : x))
  if (!list.length) return []
  return enqueue(db, {
    lane: 'embed', label, priority, timeoutMs,
    run: async ({ signal, leftMs }) => {
      if (!(await ensureServer())) throw new Error('local not running')
      const j = await postJson('/api/embed', { model: GATEWAY.embed.model, input: list, keep_alive: GATEWAY.embed.keepAlive }, { signal, timeoutMs: leftMs })
      const out = Array.isArray(j.embeddings) ? j.embeddings : []
      return out
    },
  })
}

/* ---------------- 实验通道：也排这条队，且只许一个小模型 ---------------- */

async function psModels(opts = {}) {
  return (await psDetail(opts)).map((m) => m.name)
}

/** /api/ps 的详细版：谁在显卡上、占多少、什么时候被卸。看板要用。
 *  2026-11-22：看板会在界面上轮询 → 这里必须缓存，否则每轮都去打一次 ollama。
 *  换模型的判断走 fresh=true，不吃缓存（差一步就会多卸一次）。 */
let psCache = { at: 0, list: [] }
const PS_CACHE_MS = 1500
async function psDetail({ fresh = false } = {}) {
  if (!fresh && psCache.at && Date.now() - psCache.at < PS_CACHE_MS) return psCache.list
  try {
    const j = await getJson('/api/ps', { timeoutMs: 3000 })
    const list = Array.isArray(j.models) ? j.models : []
    const out = list.map((m) => ({
      name: String(m.name || m.model || ''),
      size: Number(m.size) || 0,
      vram: Number(m.size_vram) || 0,
      contextLength: Number(m.context_length) || 0,
      expiresAt: String(m.expires_at || ''),
    }))
    psCache = { at: Date.now(), list: out }
    return out
  } catch { return psCache.list }
}

/** 本机装了哪些模型（/api/tags）。用来在换模型之前先确认目标存在。 */
async function installedModels() {
  try {
    const j = await getJson('/api/tags', { timeoutMs: 3000 })
    return Array.isArray(j.models) ? j.models.map((m) => String(m.name || m.model || '')) : []
  } catch { return [] }
}

/** 让 ollama 立刻卸掉某个模型（keep_alive=0）。卸不掉就如实说，不假装。 */
async function unloadModel(model) {
  if (!model) return false
  try {
    const j = await postJson('/api/generate', { model, keep_alive: 0 }, { timeoutMs: 15000 })
    // 有的模型不支持 generate，会回 error；这里算「没卸成」，由调用方决定
    return !j?.error
  } catch { return false }
}

/**
 * 实验调用：判官、对照实验、小模型试跑，全部只能从这里进。
 * - 默认就用常驻的 14B，**不换模型**（最稳，不重载）。
 * - 传了别的 model：先卸常驻聊天模型，加载实验模型，跑完 keep_alive=0 自动卸，
 *   再把 14B 热回来。全程在同一个槽里，所以不可能同时跑两个小模型。
 * - 超时/失败一定放槽，不让实验把聊天堵死。
 */
export async function gatewayExperiment(db, req = {}) {
  const {
    system = '', text = '', maxTokens = 2000, timeoutMs = 180000,
    temperature = null, label = 'exp', format = 'json',
  } = req
  const want = String(req.model || '').trim() || GATEWAY.chat.model
  return enqueue(db, {
    lane: 'exp', label: label || 'exp', priority: PRIORITY.exp, timeoutMs,
    run: async ({ signal, leftMs }) => {
      if (!(await ensureServer())) throw new Error('local not running')
      const t0 = Date.now()
      const cap = Math.min(GATEWAY.exp.maxTokens, Math.max(16, Number(maxTokens) || 2000))

      if (want === GATEWAY.chat.model) {
        const j = await postJson('/api/chat', chatBody(want, { system, text, maxTokens: cap, format, temperature }), { signal, timeoutMs: leftMs })
        return { text: String(j.message?.content || ''), ms: Date.now() - t0, model: want, swapped: false }
      }

      // 换模型：先确认这个模型本机真的装了，再腾地方——不然会白卸 14B、白跑一趟。
      const installed = await installedModels()
      if (installed.length && !installed.includes(want)) {
        throw new Error(`experiment model not installed: ${want}（本机有：${installed.join(' / ')}）`)
      }
      // 换模型：先腾地方，跑完再还回去。
      bus.swaps++
      bus.swapModel = want
      const before = await psModels({ fresh: true })
      const resident = GATEWAY.chat.model
      if (before.includes(resident)) {
        const ok = await unloadModel(resident)
        // 卸不掉不硬闯：直接从加载数量判断（MAX_LOADED_MODELS=2 会自己挤一个出去）
        if (!ok) bus.lastError = 'unload resident failed: ' + resident
      }
      let outText = ''
      try {
        const j = await postJson('/api/chat', chatBody(want, { system, text, maxTokens: cap, format, temperature, keepAlive: GATEWAY.exp.keepAlive, think: false }), { signal, timeoutMs: leftMs })
        outText = String(j.message?.content || '')
      } finally {
        // 实验模型不留：卸掉，再把 14B 热回来。失败也不抛——调用方已经拿到结果了。
        try { await unloadModel(want) } catch { /* ignore */ }
        try {
          await postJson('/api/chat', chatBody(resident, { text: '在', maxTokens: 1, format: '' }), { timeoutMs: 90000 })
        } catch { /* 热不回来下一次调用会再热 */ }
        bus.swapModel = ''
      }
      return { text: outText, ms: Date.now() - t0, model: want, swapped: true }
    },
  })
}

/* ---------------- 状态 ---------------- */

export function gatewayBusy() { return totalRunning() + manualHold }
export function gatewayPending() { return qItems.filter((x) => !x.started).length }
export function localBegin() { manualHold++ }
export function localEnd() { manualHold = Math.max(0, manualHold - 1) }

/** 同步快照（诊断/测试用，不碰网络）。 */
export function queueSnapshot() {
  return {
    running: totalRunning(),
    runningBySlot: { ...runningBySlot },
    manualHold,
    queued: qItems.filter((x) => !x.started).length,
    items: qItems.map((x) => ({ label: x.label, lane: x.lane, slot: x.slot, priority: x.priority, started: !!x.started })),
  }
}

/** 一个任务现在实际在用哪个模型（看板要显示「谁在用什么」）。 */
function modelOf(item) {
  if (item.slot === 'embed') return GATEWAY.embed.model
  return bus.swapModel || GATEWAY.chat.model
}

/** 最近窗口内的调用统计：让「0 在跑」不再被误读成「没跑」。
 *  2026-11-22 主人问「怎么是 0 在跑、0 在排」——瞬时队列空 ≠ 小模型没被调用，
 *  它们跑完就出队了。所以状态里必须带「最近 60 秒跑过几次」。 */
function recentStats(windowMs = 60000) {
  const now = Date.now()
  const from = now - windowMs
  const by = {
    chat: { n: 0, ok: 0, fail: 0, maxMs: 0 },
    embed: { n: 0, ok: 0, fail: 0, maxMs: 0 },
  }
  let lastAt = ''
  let lastLabel = ''
  for (const r of qRecent) {
    const t = Date.parse(r.at)
    if (!Number.isFinite(t) || t < from) continue
    const slot = r.slot === 'embed' ? 'embed' : 'chat'
    const b = by[slot]
    b.n++
    if (r.ok) b.ok++
    else b.fail++
    b.maxMs = Math.max(b.maxMs, Number(r.ms) || 0)
    if (!lastAt || t > Date.parse(lastAt)) { lastAt = r.at; lastLabel = r.label || r.lane }
  }
  return { windowMs, total: by.chat.n + by.embed.n, by, lastAt, lastLabel }
}

/** 同步状态：给 sync 接口（工具）用，不 ping 服务、不列常驻模型。 */
export function quickStatus() {
  const now = Date.now()
  const bySlot = {}
  for (const slot of Object.keys(SLOTS)) {
    bySlot[slot] = {
      limit: SLOTS[slot],
      running: runningBySlot[slot],
      queued: qItems.filter((x) => !x.started && x.slot === slot).length,
    }
  }
  return {
    url: GATEWAY.url,
    concurrency: GATEWAY.concurrency, // 每个模型槽的并发（写死 1）
    slots: bySlot,
    frozen: {
      chat: GATEWAY.chat.model, chatCtx: GATEWAY.chat.numCtx, chatGpu: GATEWAY.chat.numGpu,
      embed: GATEWAY.embed.model, keepAlive: GATEWAY.chat.keepAlive,
    },
    busy: gatewayBusy(),
    running: totalRunning(),
    queued: qItems.filter((x) => !x.started).length,
    runningItems: qItems.filter((x) => x.started).map((x) => ({
      slot: x.slot, model: modelOf(x), lane: x.lane, label: x.label, priority: x.priority,
      block: x.block != null ? x.block : blockOf(x.label || x.lane || x.priority),
      runningMs: now - (x.startedAt || now), timeoutMs: x.timeoutMs,
    })),
    queue: qItems.filter((x) => !x.started)
      .sort(compareQueued)
      .map((x) => ({
        slot: x.slot, model: modelOf(x), lane: x.lane, label: x.label, priority: x.priority,
        block: x.block != null ? x.block : blockOf(x.label || x.lane || x.priority),
        waitedMs: now - x.enqueuedAt, timeoutMs: x.timeoutMs,
      })),
    swapModel: bus.swapModel,
    last60s: recentStats(60000),
    recent: qRecent.slice(-12),
    lastError: bus.lastError,
    lastErrorAt: bus.lastErrorAt,
    swaps: bus.swaps,
  }
}

/** 只读快照：谁在跑、谁在排、常驻了哪几个模型（含显存）、最近几条。看板用。 */
export async function gatewayStatus(db = null) {
  const base = quickStatus()
  let up = false
  let models = []
  try {
    up = await gatewayPing(800)
    if (up) models = await psDetail()
  } catch { /* 服务没起就只报队列 */ }
  return { ...base, up, models, resident: models.map((m) => m.name) }
}

/** model.js 用：把本机 ollama 的 /embeddings 接进这条通道（不再直连）。 */
export function isLocalOllamaUrl(url) {
  try {
    const u = new URL(String(url || ''))
    const host = u.hostname
    const port = String(u.port || (u.protocol === 'https:' ? '443' : '80'))
    return (host === '127.0.0.1' || host === 'localhost' || host === '::1') && port === '11434'
  } catch { return false }
}

/** OpenAIAdapter 形状的 embed 适配器：embedOnly，其余不冒充。 */
export function gatewayEmbedAdapter() {
  return {
    name: 'gateway:embed',
    embedOnly: true,
    available() { return true },
    capabilities() { return { embed: true } },
    async embed(texts) { return gatewayEmbed(null, texts, { label: 'embed:vector' }) },
  }
}
