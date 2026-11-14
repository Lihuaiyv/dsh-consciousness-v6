/**
 * 本地 Ollama 适配（只给「work 段摘要」用，不碰回复/检索/抽取）。
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
  const portableExe = base ? path.join(base, 'ollama', 'ollama.exe') : ''
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

async function postChat(url, body, timeoutMs) {
  return fetch(`${url}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(Math.max(1000, Number(timeoutMs) || 120000)),
  })
}

/** 调本地 /api/chat（JSON 约束）。连不上先重连一次；仍不行就抛错，由调用方走词法/主模型兜底。 */
export async function localComplete(db, { system = '', text = '', maxTokens = 500, timeoutMs = 120000 } = {}) {
  const { url, model } = localCutConfig(db)
  const body = {
    model,
    stream: false,
    format: 'json',
    options: {
      temperature: 0.1,
      top_p: 0.9,
      num_ctx: 8192,
      num_predict: Math.max(64, Number(maxTokens) || 500),
    },
    messages: [
      { role: 'system', content: String(system || '') },
      { role: 'user', content: String(text || '') },
    ],
  }
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
