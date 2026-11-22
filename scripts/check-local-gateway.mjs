#!/usr/bin/env node
/**
 * 体检：本地模型是不是只剩一条通道（2026-11-22 主人钉的规矩）。
 *
 * 查三件：
 *   1. 参数写死——通道里不该再出现「读 flag 改参数」的口子；
 *   2. 没有绕过队列直连 11434 的代码（src/ 和 scripts/ 都扫）；
 *   3. 实验只能走 /local/exp：脚本里不该再自己 spawn 模型进程。
 *
 * 用法：
 *   node scripts/check-local-gateway.mjs          # 只做静态检查（离线也能跑）
 *   node scripts/check-local-gateway.mjs --live   # 再看一眼插件里真实的队列
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { GATEWAY, PRIORITY } from '../src/modules/local_gateway.js'
import { apiBase } from './lib/exp-call.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const LIVE = process.argv.includes('--live')

let pass = 0
let fail = 0
const bad = []
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) } else { fail++; console.log('FAIL', name, detail === undefined ? '' : String(detail).slice(0, 200)) }
}

function walk(dir, out = []) {
  let ents = []
  try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of ents) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (['node_modules', 'scratch', '.git', 'docs', 'test'].includes(e.name)) continue
      walk(p, out)
    } else if (/\.(mjs|js|cjs)$/.test(e.name)) out.push(p)
  }
  return out
}

/** 这些文件本来就该碰端点：通道本体 + 兼容层（只写注释/转发）+ 体检自己。 */
const ALLOW = new Set([
  path.join(ROOT, 'src', 'modules', 'local_gateway.js'),
  path.join(ROOT, 'src', 'modules', 'local_llm.js'),
  path.join(ROOT, 'scripts', 'check-local-gateway.mjs'),
])

const files = [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'scripts'))]
const offenders = []
for (const f of files) {
  if (ALLOW.has(f)) continue
  let txt = ''
  try { txt = fs.readFileSync(f, 'utf8') } catch { continue }
  const rel = path.relative(ROOT, f).replace(/\\/g, '/')
  // 只看真正会发请求的行：注释里提到端点不算（文档里要解释「以前直连」）。
  const codeLines = txt.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
  const code = codeLines.join('\n')
  if (/127\.0\.0\.1:11434|localhost:11434/.test(code)) offenders.push(rel + ' → 直连 11434')
  if (/\/api\/(chat|generate|embed)\b/.test(code) && /fetch\(/.test(code)) offenders.push(rel + ' → 原生 ollama 端点')
  // 脚本自己起模型进程（只看代码行：注释里写「不许 spawn ollama」不算）
  if (/^scripts\//.test(rel)) {
    if (/spawn(Sync)?\(\s*['"`][^'"`]*ollama/i.test(code)) offenders.push(rel + ' → 自己起 ollama')
  }
}
check('没有绕过通道直连 11434 的代码', offenders.length === 0, offenders.join(' | '))
if (offenders.length) bad.push(...offenders)

// scratch/ 里的一次性实验：只提醒，不判红（那是草稿区），但别让它悄悄养成直连的习惯。
{
  const warns = []
  for (const f of walk(path.join(ROOT, 'scratch'))) {
    let txt = ''
    try { txt = fs.readFileSync(f, 'utf8') } catch { continue }
    const code = txt.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n')
    if (/127\.0\.0\.1:11434|localhost:11434/.test(code)) warns.push(path.relative(ROOT, f).replace(/\\/g, '/'))
  }
  if (warns.length) console.log('提醒：scratch/ 里还有直连 11434 的草稿（不判红，实验请改走 exp-call.mjs）：', warns.slice(0, 6).join(' | '))
}

// 参数写死
check('并发写死 1', GATEWAY.concurrency === 1, GATEWAY.concurrency)
check('聊天模型 = qwen2.5:14b-instruct', GATEWAY.chat.model === 'qwen2.5:14b-instruct', GATEWAY.chat.model)
check('语义模型 = qwen3-embedding:0.6b', GATEWAY.embed.model === 'qwen3-embedding:0.6b', GATEWAY.embed.model)
check('num_ctx 写死 8000', GATEWAY.chat.numCtx === 8000, GATEWAY.chat.numCtx)
check('常驻 keep_alive = -1', GATEWAY.chat.keepAlive === -1, GATEWAY.chat.keepAlive)
check('实验模型跑完就卸', GATEWAY.exp.keepAlive === 0, GATEWAY.exp.keepAlive)

// 优先级齐不齐 + 顺序对不对（主人 2026-11-22：对话 > 实验 > 事后整理）
for (const k of ['chat', 'embed', 'split', 'normal', 'exp', 'batch']) {
  check('优先级有 ' + k, Number.isFinite(PRIORITY[k]), PRIORITY[k])
}
check('顺序：对话最高', PRIORITY.chat === Math.min(...Object.values(PRIORITY)), PRIORITY)
check('顺序：实验排在事后整理前面', PRIORITY.exp < PRIORITY.split, { exp: PRIORITY.exp, split: PRIORITY.split })
check('顺序：事后整理内部 切事 > 普通 > 批量', PRIORITY.split < PRIORITY.normal && PRIORITY.normal < PRIORITY.batch,
  { split: PRIORITY.split, normal: PRIORITY.normal, batch: PRIORITY.batch })

if (LIVE) {
  // 端口别写死：DSH 重启会换口。apiBase() 从 runtime/consciousness/gateway-api.json 读。
  const base = apiBase()
  try {
    const r = await fetch(base, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'user', method: 'POST', path: '/local/status', body: {} }),
      signal: AbortSignal.timeout(10000),
    })
    const j = await r.json()
    check('插件里的通道在线', !!j && j.ok === true, JSON.stringify(j).slice(0, 160))
    if (j && j.ok) {
      console.log('并发', j.concurrency, '· 在跑', j.running, '· 在排', j.queued, '· 常驻', (j.resident || []).join(' / ') || '（没起）')
      check('线上并发也是 1', j.concurrency === 1, j.concurrency)
      check('常驻模型不超过 2 个（不许同时跑两个小模型）', (j.resident || []).length <= 2, (j.resident || []).join(','))
    }
  } catch (e) {
    fail++
    console.log('FAIL 连不上插件接口：', String(e && e.message || e).slice(0, 160))
    console.log('      （插件没开就只跑静态检查：去掉 --live）')
  }
  // 进程数：llama-server 一个模型一个进程，常驻两个最多 2 个；ollama 本体只许 1 个。
  try {
    const r = spawnSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8', timeout: 15000 })
    const rows = String(r.stdout || '').split(/\r?\n/).filter(Boolean)
    const count = (name) => rows.filter((l) => l.toLowerCase().startsWith(`"${name.toLowerCase()}"`)).length
    const llama = count('llama-server.exe')
    const ollama = rows.filter((l) => /^"ollama/i.test(l)).length
    console.log('进程：llama-server', llama, '个 · ollama*', ollama, '个')
    check('模型进程不超过 2 个（14B + 语义）', llama <= 2, llama)
    check('ollama 本体只有 1 个', ollama <= 1, ollama)
  } catch { console.log('提醒：数不了进程（tasklist 不可用），跳过进程检查') }

  // 看板（2026-11-22）：页面能开、数据口有槽和进程两段。
  try {
    const origin = new URL(base).origin
    const b = await fetch(origin + '/dsh-consciousness/board', { signal: AbortSignal.timeout(8000) })
    const html = await b.text()
    check('看板页面能打开', b.ok && /模型调用看板/.test(html) && html.length > 2000, 'http ' + b.status + ' len ' + html.length)
    const lr = await fetch(origin + '/dsh-consciousness/live', { signal: AbortSignal.timeout(8000) })
    const lj = await lr.json()
    check('看板数据口：两个槽', !!lj && !!lj.gateway && !!lj.gateway.slots && !!lj.gateway.slots.chat && !!lj.gateway.slots.embed, JSON.stringify(lj).slice(0, 120))
    check('看板数据口：常驻模型 + 进程两段都有', Array.isArray(lj.models || lj.gateway?.models) && Array.isArray(lj.procs?.items), JSON.stringify(lj.procs).slice(0, 120))
    const procs = lj.procs?.items || []
    const llama = procs.filter((x) => /llama-server/i.test(x.name)).length
    check('看板看到的模型进程 ≤ 2', llama <= 2, llama)
  } catch (e) {
    fail++
    console.log('FAIL 看板接口：', String(e && e.message || e).slice(0, 160))
  }
}

console.log(`\n${pass}/${pass + fail} 通过`)
if (fail) process.exitCode = 1
