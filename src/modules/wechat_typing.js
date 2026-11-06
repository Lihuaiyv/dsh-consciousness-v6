/**
 * 微信「正在输入」：在她开口之前，先让对面看到她真的在打字。
 *
 * 微信不给第三方打字状态；对方看到的那行「正在输入」只跟「输入框里真的有人在打字」有关。
 * 所以这条路是真的在输入框里放草稿（scripts/wechat-typing.py 用剪贴板粘贴），
 * 每两秒半改一次保持状态，等我们这边把回复写好，再整句覆盖、停一下、回车。
 *
 * 纪律：
 *   1) 失败不能留草稿：脚本在退出前会清空输入框；清不掉会在结果里说明。
 *   2) 抢不到窗口就老实退回普通发送（sendMessage），别为了「像在打字」把话弄丢。
 *   3) 一次只允许一个打字进程（同一时间只能有一个窗口焦点）。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_PATH = fileURLToPath(new URL('../../scripts/wechat-typing.py', import.meta.url))

/** 是否装了那条「打草稿」的路（脚本在就行；python/包由调用方保证）。 */
export function wechatTypingAvailable() {
  try { return fs.existsSync(SCRIPT_PATH) } catch { return false }
}

/**
 * 开始「正在输入」。立刻返回，不 await——抢窗口和打字由 Python 那边做。
 *
 * @param {{target:string, python?:string, pre?:string[], leadMs?:number, timeoutMs?:number, placeholder?:string}} o
 * @returns {{ finish(text:string):Promise<object>, cancel(reason?:string):void, dir:string }}
 */
export function startWeChatTyping(o = {}) {
  const target = String(o.target || '').trim()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-wxtyping-'))
  const reqFile = path.join(dir, 'request.json')
  const resFile = path.join(dir, 'result.json')
  const waitFile = path.join(dir, 'answer.json')
  const python = o.python || 'python'
  const pre = Array.isArray(o.pre) ? o.pre : []

  const payload = {
    target,
    wait_file: waitFile,
    lead_ms: Math.max(0, Math.min(5000, Number(o.leadMs) || 1200)),
    timeout_ms: Math.max(5000, Math.min(180000, Number(o.timeoutMs) || 120000)),
    placeholder: String(o.placeholder || '…').slice(0, 8),
  }

  let child = null
  let settled = false
  let settledResolve = null
  const done = new Promise((resolve) => { settledResolve = resolve })
  const cleanup = () => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 临时目录删不掉不算错 */ } }
  const settle = (v) => { if (settled) return; settled = true; cleanup(); settledResolve(v) }

  if (!target || !wechatTypingAvailable()) {
    settle({ ok: false, code: 'NOT_STARTED', message: target ? '没有打字脚本' : '没有收件人' })
    return { finish: () => Promise.resolve({ ok: false, code: 'NOT_STARTED' }), cancel: () => {}, dir }
  }

  try {
    fs.writeFileSync(reqFile, JSON.stringify(payload), 'utf8')
    child = spawn(python, [...pre, SCRIPT_PATH, reqFile, resFile], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (e) {
    settle({ ok: false, code: 'SPAWN_FAILED', message: String((e && e.message) || e) })
    return { finish: () => Promise.resolve({ ok: false, code: 'SPAWN_FAILED' }), cancel: () => {}, dir }
  }

  let stderr = ''
  child.stderr.on('data', (b) => { if (stderr.length < 2000) stderr += b.toString('utf8') })
  child.on('error', (e) => settle({ ok: false, code: 'SPAWN_FAILED', message: String((e && e.message) || e) }))
  child.on('close', (code) => {
    if (settled) return
    let raw = ''
    try { raw = fs.readFileSync(resFile, 'utf8') } catch { raw = '' }
    let res = null
    try { res = raw ? JSON.parse(raw) : null } catch { res = null }
    if (!res) {
      settle({ ok: false, code: 'TYPING_FAILED', message: '打字脚本没产出结果（exit=' + code + '）' + (stderr ? '：' + stderr.trim().slice(0, 200) : '') })
      return
    }
    settle(res)
  })

  return {
    dir,
    /** 把写好的那句话交过去：脚本会覆盖草稿、停一下、回车。 */
    finish(text) {
      try { fs.writeFileSync(waitFile, JSON.stringify({ text: String(text || '') }), 'utf8') } catch { /* 写不进去就等超时 */ }
      return done
    },
    /** 不要了（比如生成失败）：杀掉进程，脚本的 finally 会尽量清草稿。 */
    cancel() {
      try { child.kill() } catch { /* 已经退出 */ }
      settle({ ok: false, code: 'CANCELLED' })
    },
  }
}
