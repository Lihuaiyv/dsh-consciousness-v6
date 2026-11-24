/**
 * 排队分块门禁（2026-11-22）
 *
 * 为什么有这一条：模型调用以前各自写 priority 数字，散在十几个地方，
 * 改一处忘一处，还出现过「判定插到摘要前面，摘要没生成、这一轮读空」。
 * 现在规则只有一份（src/modules/queue_policy.js），每个调用必须回答「我属于哪一块」。
 *
 * 检查：src/ 下每个模型调用点（hostComplete / scheduleHostTask / localComplete /
 * gatewayChat / gatewayEmbed / model.embed）要么显式写 block:，要么 label 用已知前缀。
 * 两样都没有 → 失败。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = path.join(repoRoot, 'src')

const CALL_RE = /\b(hostComplete|scheduleHostTask|localComplete|gatewayChat|gatewayEmbed|localJudge)\s*\(/
// 裸调模型：只有包在 hostComplete 的 complete 回调里才允许（那才进队列）
const BARE_CHAT_RE = /\b(model|kernelModel)\.chat\s*\(/
// label 前缀 → 归块（必须和 queue_policy.js 的 blockOf 对齐）
const KNOWN_PREFIX = /label:\s*'(chat|affect:judge|affect:summary|affect:summary:retry|affect:topic|embed|exp:|split:|nightly:|batch:)/
const BLOCK_RE = /block:/

const problems = []
let scanned = 0

function scanFile(p) {
  const text = fs.readFileSync(p, 'utf8')
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    // 裸调 model.chat：只有包在 hostComplete 的 complete 回调里才放行（那才真的进队列）
    if (BARE_CHAT_RE.test(lines[i])) {
      const around = lines.slice(Math.max(0, i - 8), Math.min(lines.length, i + 4)).join('\n')
      if (!/complete\s*:/.test(around)) {
        problems.push({ file: path.relative(repoRoot, p), line: i + 1, text: '裸调模型（没进队列）：' + lines[i].trim().slice(0, 90) })
      }
      scanned++
      continue
    }
    if (!CALL_RE.test(lines[i])) continue
    // 函数定义、导出、内部透传不算调用点
    if (/^\s*(export\s+)?(async\s+)?function\s+/.test(lines[i])) continue
    if (/^\s*return\s+\w+\(/.test(lines[i])) continue
    scanned++
    // 调用点可能跨多行：看接下来 12 行
    const window = lines.slice(i, Math.min(lines.length, i + 12)).join('\n')
    if (BLOCK_RE.test(window) || KNOWN_PREFIX.test(window)) continue
    problems.push({ file: path.relative(repoRoot, p), line: i + 1, text: lines[i].trim().slice(0, 110) })
  }
}

function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name)
    const st = fs.statSync(p)
    if (st.isDirectory()) { walk(p); continue }
    if (!name.endsWith('.js')) continue
    scanFile(p)
  }
}

walk(SRC)
// 2026-11-22：插件根也有调用点（index.js），以前漏扫了
for (const name of fs.readdirSync(repoRoot)) {
  if (!name.endsWith('.js')) continue
  scanFile(path.join(repoRoot, name))
}

if (problems.length) {
  console.log('发现没声明排队块的模型调用（加 block: \'chat\'|\'exp\'|\'night\'，或 label 用已知前缀）：')
  for (const p of problems) console.log('  ' + p.file + ':' + p.line + '  ' + p.text)
  console.log('共 ' + problems.length + ' 处，扫了 ' + scanned + ' 个调用点')
  process.exit(1)
}
console.log('排队分块门禁通过：' + scanned + ' 个调用点都声明了块')
