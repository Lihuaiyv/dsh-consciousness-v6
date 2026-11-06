/**
 * 个人微信（本机 UI 自动化）通道。
 *
 * 真正的窗口操作在 scripts/wechat-send.ps1：UIAutomation 找搜索框 → 只点名字完全对上的联系人
 * → 找输入框 → 粘贴 → Enter/发送。找不到可点的元素时默认**不降级**（宁可失败也不发错人），
 * 只有设置里明确打开「键盘兜底」才走 Ctrl+F / 粘贴 / Enter 的流程。
 *
 * 这个文件只负责：写请求 JSON、起 PowerShell、读结果 JSON、超时与串行化。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SCRIPT_PATH = fileURLToPath(new URL('../../../scripts/wechat-send.ps1', import.meta.url))
const PY_SCRIPT_PATH = fileURLToPath(new URL('../../../scripts/wechat-send.py', import.meta.url))
const POWERSHELL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const PYTHON = process.env.DSHC_PYTHON || 'python'

// 同一时间只允许一个窗口自动化在跑，避免两个发送互相抢焦点。
let chain = Promise.resolve()

function serial(fn) {
  const run = chain.then(fn, fn)
  chain = run.catch(() => {})
  return run
}

export class WeChatError extends Error {
  constructor(code, message, details) {
    super(message)
    this.name = 'WeChatError'
    this.code = code
    this.details = details || null
  }
}

function parseResult(text) {
  if (!text) return null
  try { return JSON.parse(text) } catch { return null }
}

function runScript(payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(SCRIPT_PATH)) {
      reject(new WeChatError('WECHAT_SCRIPT_MISSING', '找不到 scripts/wechat-send.ps1：' + SCRIPT_PATH))
      return
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-wx-'))
    const reqFile = path.join(dir, 'request.json')
    const outFile = path.join(dir, 'result.json')
    fs.writeFileSync(reqFile, JSON.stringify(payload), 'utf8')

    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT_PATH, '-RequestFile', reqFile, '-ResultFile', outFile]
    let child
    try {
      child = spawn(POWERSHELL, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      fs.rmSync(dir, { recursive: true, force: true })
      reject(new WeChatError('WECHAT_SPAWN', '起不了 PowerShell：' + String((e && e.message) || e)))
      return
    }

    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (b) => { if (stdout.length < 4000) stdout += b.toString('utf8') })
    child.stderr.on('data', (b) => { if (stderr.length < 4000) stderr += b.toString('utf8') })

    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { child.kill() } catch { /* 已经退出 */ }
      fs.rmSync(dir, { recursive: true, force: true })
      reject(new WeChatError('WECHAT_TIMEOUT', '微信自动化超过 ' + Math.round(timeoutMs / 1000) + ' 秒还没结束；窗口可能卡住了。'))
    }, Math.max(5000, timeoutMs))

    child.on('error', (e) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fs.rmSync(dir, { recursive: true, force: true })
      reject(new WeChatError('WECHAT_SPAWN', 'PowerShell 起不来：' + String((e && e.message) || e)))
    })

    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      let raw = ''
      try { raw = fs.readFileSync(outFile, 'utf8') } catch { raw = '' }
      fs.rmSync(dir, { recursive: true, force: true })
      const result = parseResult(raw)
      if (!result) {
        reject(new WeChatError('WECHAT_SCRIPT_FAILED', '微信自动化脚本没有产出结果（exit=' + code + '）'
          + (stderr ? '：' + stderr.trim().slice(0, 300) : '')
          + (stdout ? ' stdout=' + stdout.trim().slice(0, 200) : '')))
        return
      }
      resolve(result)
    })
  })
}

/** 只探测窗口和可用的控件，不发消息。 */
export function probe(timeoutMs = 25000) {
  return serial(() => runScript({ mode: 'probe', launch: false }, timeoutMs))
}

// ---------------- Python 后端（wechatauto-replica） ----------------
//
// 微信 4.1 聊天界面是自绘的，冷启动 UIA 只暴露 Qt 空壳；wechatauto-replica 会热激活
// Qt accessibility gate，再用 UIA 优先 / OCR 兜底发送。它不是必装依赖：装了就走它，
// 没装就退回 PowerShell 的 UIA（微信 3.9 / 登录窗可用）。

let pyCheck = { at: 0, ok: false, error: '' }
// 装了 wechatauto 的那个解释器。机器上常常有好几个 python（3.14 在前、包却装在 3.12），
// 不能只认 PATH 里的 `python`——那样会「明明装了却说没装」，发信悄悄退回读不到控件的 UIA。
let pyPick = { at: 0, cmd: '', pre: [], ok: false, error: '' }

function pythonCandidates() {
  const out = []
  const push = (cmd, pre = []) => {
    if (!cmd) return
    if (out.some((c) => c.cmd === cmd && c.pre.join(' ') === pre.join(' '))) return
    out.push({ cmd, pre })
  }
  push(process.env.DSHC_PYTHON)
  const home = process.env.USERPROFILE || process.env.HOME || ''
  if (home) {
    for (const v of ['312', '313', '311', '310']) {
      push(path.join(home, 'AppData', 'Local', 'Programs', 'Python', 'Python' + v, 'python.exe'))
    }
  }
  push('python')
  push('py', ['-3.12'])
  return out
}

function checkImport({ cmd, pre }) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(cmd, [...pre, '-c', 'import wechatauto, sys; sys.stdout.write("ok")'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      resolve({ ok: false, error: String((e && e.message) || e) })
      return
    }
    let out = ''
    let err = ''
    let done = false
    const finish = (r) => { if (done) return; done = true; resolve(r) }
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* 已退出 */ }
      finish({ ok: false, error: 'import wechatauto 超时' })
    }, 9000)
    child.stdout.on('data', (b) => { if (out.length < 200) out += b.toString('utf8') })
    child.stderr.on('data', (b) => { if (err.length < 400) err += b.toString('utf8') })
    child.on('error', (e) => { clearTimeout(timer); finish({ ok: false, error: String((e && e.message) || e) }) })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0 && out.trim() === 'ok') finish({ ok: true, error: '' })
      else finish({ ok: false, error: err.trim().slice(0, 300) || ('import wechatauto 失败（exit=' + code + '）') })
    })
  })
}

/** 找一个真能 import wechatauto 的解释器；找不到就如实说找不到（别假装有）。 */
export async function detectPython({ force = false } = {}) {
  if (!force && Date.now() - pyPick.at < 10 * 60 * 1000) return pyPick
  let lastErr = '没有找到能 import wechatauto 的 Python'
  for (const c of pythonCandidates()) {
    const r = await checkImport(c)
    if (r.ok) {
      pyPick = { at: Date.now(), cmd: c.cmd, pre: c.pre, ok: true, error: '' }
      pyCheck = { at: Date.now(), ok: true, error: '' }
      return pyPick
    }
    lastErr = (c.cmd || 'python') + '：' + r.error
  }
  pyPick = { at: Date.now(), cmd: '', pre: [], ok: false, error: lastErr.slice(0, 400) }
  pyCheck = { at: Date.now(), ok: false, error: pyPick.error }
  return pyPick
}

export async function wechatautoAvailable({ force = false } = {}) {
  const p = await detectPython({ force })
  return !!p.ok
}

export function pythonStatus() {
  return {
    available: pyCheck.ok,
    at: pyCheck.at ? new Date(pyCheck.at).toISOString() : null,
    cmd: pyPick.cmd ? ([pyPick.cmd, ...pyPick.pre].join(' ')) : '',
    error: pyCheck.error,
  }
}

function runPython(payload, timeoutMs, py = null) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(PY_SCRIPT_PATH)) {
      reject(new WeChatError('WECHAT_PY_MISSING', '找不到 scripts/wechat-send.py：' + PY_SCRIPT_PATH))
      return
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-wxpy-'))
    const reqFile = path.join(dir, 'request.json')
    const outFile = path.join(dir, 'result.json')
    fs.writeFileSync(reqFile, JSON.stringify(payload), 'utf8')
    // 用「真装了 wechatauto 的那个解释器」；没有就退回默认的 python（会明确报 WECHATAUTO_MISSING）。
    const cmd = (py && py.ok && py.cmd) || PYTHON
    const pre = (py && py.ok && Array.isArray(py.pre)) ? py.pre : []
    let child
    try {
      child = spawn(cmd, [...pre, PY_SCRIPT_PATH, reqFile, outFile], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      fs.rmSync(dir, { recursive: true, force: true })
      reject(new WeChatError('WECHAT_PY_SPAWN', '起不了 Python：' + String((e && e.message) || e)))
      return
    }
    let stderr = ''
    child.stderr.on('data', (b) => { if (stderr.length < 3000) stderr += b.toString('utf8') })
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { child.kill() } catch { /* 已退出 */ }
      fs.rmSync(dir, { recursive: true, force: true })
      reject(new WeChatError('WECHAT_TIMEOUT', 'Python 微信后端超过 ' + Math.round(timeoutMs / 1000) + ' 秒没结束。'))
    }, Math.max(5000, timeoutMs))
    child.on('error', (e) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fs.rmSync(dir, { recursive: true, force: true })
      reject(new WeChatError('WECHAT_PY_SPAWN', 'Python 起不来：' + String((e && e.message) || e)))
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      let raw = ''
      try { raw = fs.readFileSync(outFile, 'utf8') } catch { raw = '' }
      fs.rmSync(dir, { recursive: true, force: true })
      const result = parseResult(raw)
      if (!result) {
        reject(new WeChatError('WECHAT_PY_FAILED', 'Python 后端没有产出结果（exit=' + code + '）'
          + (stderr ? '：' + stderr.trim().slice(0, 500) : '')))
        return
      }
      resolve(result)
    })
  })
}

/**
 * 发一条微信。
 * @param {{target:string,text:string,launch?:boolean,allowKeysFallback?:boolean,dryRun?:boolean,exe?:string,backend?:'auto'|'wechatauto'|'uia'}} opts
 */
export function send(opts) {
  const payload = {
    mode: 'send',
    target: String(opts.target || ''),
    text: String(opts.text || ''),
    launch: opts.launch !== false,
    allow_keys_fallback: !!opts.allowKeysFallback,
    dry_run: !!opts.dryRun,
    exe: opts.exe || '',
  }
  const timeoutMs = opts.timeoutMs || (payload.allow_keys_fallback ? 70000 : 55000)
  const backend = opts.backend || 'auto'
  return serial(async () => {
    if (backend !== 'uia') {
      const py = await detectPython()
      if (py.ok) return runPython(payload, timeoutMs, py)
      if (backend === 'wechatauto') {
        throw new WeChatError('WECHATAUTO_MISSING',
          '没装 wechatauto-replica：pip install wechatauto-replica（另装 winsdk / pypinyin）。'
          + '装好后把「个人微信后端」切回自动或 Python；不想装就切回 UIA（微信 3.9 才能直接用）。')
      }
    }
    return runScript(payload, timeoutMs)
  })
}
