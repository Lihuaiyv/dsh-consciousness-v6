/**
 * G1 守门：memory_items 的「生效 / 正文 / 可见性」只能经 modules/timeline.js 改，
 * 否则时效索引会漏记、as-of 回答就会悄悄出错。
 * 例外：硬删（DELETE，不是 UPDATE）、db.js 的回滚恢复。
 * 用法：node scripts/check-timeline.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const src = path.join(__dirname, '..', 'src')
const ALLOW = new Set(['modules/timeline.js', 'db.js'])
const RE = /UPDATE\s+memory_items\s+SET\s+[^`'"]*?\b(invalid_at|text|status)\s*=/gi

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name)
    if (fs.statSync(p).isDirectory()) walk(p, out)
    else if (name.endsWith('.js')) out.push(p)
  }
  return out
}

const hits = []
for (const file of walk(src)) {
  const rel = path.relative(src, file).replace(/\\/g, '/')
  if (ALLOW.has(rel)) continue
  const text = fs.readFileSync(file, 'utf8')
  for (const m of text.matchAll(RE)) {
    const line = text.slice(0, m.index).split('\n').length
    hits.push(`${rel}:${line}  ${m[1]}`)
  }
}

if (hits.length) {
  console.error('时效索引守门失败：以下位置绕过 timeline.js 改了 memory_items')
  for (const h of hits) console.error('  ' + h)
  process.exit(1)
}
console.log('check-timeline ok')
