#!/usr/bin/env node
/**
 * 实验调用的**唯一接口**（2026-11-22 主人钉的）。
 *
 * 规矩：
 *   - 实验（判官、对照、小模型试跑）不许自己连 11434，也不许自己起模型进程。
 *   - 只能 POST 到插件的 `/local/exp`，由插件里那条唯一队列排队：
 *     一次只进一个任务，实验小模型跑完立刻卸掉、把常驻 14B 热回来。
 *
 * ❌ 写实验时禁止（检验脚本 `scripts/check-local-gateway.mjs` 会扫）：
 *   1. 直接 fetch 'http://127.0.0.1:11434/api/...'  —— 绕过去就不排队
 *   2. spawn('ollama', ...) / 起 llama-server / 起任何模型进程  —— 会挤掉常驻 14B
 *   3. 自己 sleep 轮询凑一个「队列」 —— 用这个接口，队列只有一条
 *   4. 不传 model 就用常驻 14B（最稳、零重载）；只有确实要另一个模型时才传 model
 *
 * 为什么：直连 11434 会绕过队列，跟常驻 14B 抢那一个生成槽；
 * 实验模型不在常驻名单里，一调用就把 14B 挤下显卡，下一次聊天重载 40 秒起。
 *
 * 用法（脚本里）：
 *   import { expCall } from './lib/exp-call.mjs'
 *   const { text, ms, model } = await expCall({ system: SYS, text, maxTokens: 60, format: '' })
 *
 * 用法（命令行）：
 *   node scripts/lib/exp-call.mjs --text "在吗" [--system ""] [--model gemma4:12b] [--max 200]
 *   node scripts/lib/exp-call.mjs --status
 */

import fs from 'node:fs'
import path from 'node:path'
import { dbPath } from '../../src/paths.js'

const API_PATH = '/dsh-consciousness/api'

/**
 * 插件现在开在哪个端口：插件每次处理 API 请求都会把端口写进
 * `<runtime>/consciousness/gateway-api.json`（DSH 重启端口会变，别写死）。
 * 优先级：DSH_CONSCIOUSNESS_API > DSH_WEB_PORT > 端口文件 > 50200（老默认）。
 */
function portFromFile() {
  try {
    const f = path.join(path.dirname(dbPath()), 'gateway-api.json')
    const o = JSON.parse(fs.readFileSync(f, 'utf8'))
    const p = Number(o && o.port) || 0
    return p > 0 ? p : 0
  } catch { return 0 }
}

export function apiBase() {
  const env = String(process.env.DSH_CONSCIOUSNESS_API || '').trim()
  if (env) return env.replace(/\/$/, '')
  const port = String(process.env.DSH_WEB_PORT || '').trim() || String(portFromFile() || '50200')
  return `http://127.0.0.1:${port}${API_PATH}`
}

async function post(pathname, body, timeoutMs = 240000) {
  const url = apiBase()
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: 'user', method: 'POST', path: pathname, body }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await res.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { json = null }
  if (!res.ok) {
    const m = json?.error?.message || text || ('http ' + res.status)
    throw new Error(`实验接口不可用（${url}）：${String(m).slice(0, 200)}`)
  }
  if (json && json.error) throw new Error('实验接口报错：' + String(json.error.message || json.error).slice(0, 200))
  return json || {}
}

/**
 * 走唯一通道跑一次实验调用。
 * @param {object} o
 * @param {string} o.system
 * @param {string} o.text
 * @param {number} [o.maxTokens]
 * @param {string} [o.model]  空 = 用常驻的 14B（不换模型，最稳）
 * @param {string} [o.format] 'json' 或 ''（要纯文本就传 ''）
 * @param {number} [o.temperature]
 * @param {string} [o.label]
 * @param {number} [o.timeoutMs]
 */
export async function expCall({ system = '', text = '', maxTokens = 2000, model = '', format = 'json', temperature = null, label = 'exp', timeoutMs = 240000 } = {}) {
  if (!String(text || '').trim()) throw new Error('expCall: text 不能为空')
  const out = await post('/local/exp', {
    system, text, maxTokens, model, format, label, temperature,
    timeoutMs: Math.max(5000, Math.min(240000, Number(timeoutMs) || 240000)),
  }, Number(timeoutMs) || 240000)
  return { text: String(out.text || ''), model: String(out.model || ''), ms: Number(out.ms) || 0, swapped: !!out.swapped }
}

/** 看一眼队列：谁在跑、谁在排、常驻了哪几个模型。 */
export async function expStatus() {
  return post('/local/status', {})
}

/* ---------------- 命令行 ---------------- */

function arg(name, def) {
  const i = process.argv.indexOf('--' + name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def
}

const invokedDirectly = !!(process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('/scripts/lib/exp-call.mjs'))

if (invokedDirectly) {
  try {
    if (process.argv.includes('--status')) {
      const st = await expStatus()
      const sl = st.slots || {}
      const lines = [
        `在跑 ${st.running} · 在排 ${st.queued}（14B 槽 跑${sl.chat?.running ?? 0}/排${sl.chat?.queued ?? 0}；`
          + `向量槽 跑${sl.embed?.running ?? 0}/排${sl.embed?.queued ?? 0}）`,
      ]
      lines.push('常驻：' + ((st.resident || []).join(' / ') || '（没起）'))
      for (const r of (st.recent || []).slice(-5)) {
        lines.push(`- ${r.slot || '?'}/${r.label} 等${Math.round((r.waitedMs || 0) / 1000)}s 跑${Math.round((r.ms || 0) / 1000)}s ${r.ok ? 'ok' : '✗ ' + (r.error || '')}`)
      }
      if (st.lastError) lines.push('最近错误：' + st.lastError)
      console.log(lines.join('\n'))
    } else {
      const r = await expCall({
        system: arg('system', ''),
        text: arg('text', arg('prompt', '')),
        maxTokens: Number(arg('max', '200')) || 200,
        model: arg('model', ''),
        format: process.argv.includes('--json') ? 'json' : '',
        label: arg('label', 'cli'),
      })
      console.log(JSON.stringify({ model: r.model, ms: r.ms, swapped: r.swapped, text: r.text }, null, 2))
    }
  } catch (e) {
    console.error(String(e && e.message ? e.message : e))
    process.exitCode = 1
  }
}
