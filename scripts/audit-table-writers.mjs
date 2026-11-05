/**
 * 写权地图：按 ownership 的 files 扫 SQL，看每张表到底被哪些域写。
 * 用法：node scripts/audit-table-writers.mjs
 * 输出：控制台摘要 + docs/表-谁在写-2026-11-05.md
 *
 * 只看「写」：INSERT / REPLACE / UPDATE / DELETE / 改表结构。读不算。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { OWNERSHIP, SHARED } from '../src/ports/ownership.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const src = path.join(root, 'src')

const WRITE_RE = /\b(?:INSERT(?:\s+OR\s+REPLACE)?\s+INTO|REPLACE\s+INTO|UPDATE|DELETE\s+FROM|CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?|ALTER\s+TABLE|DROP\s+TABLE)\s+([a-zA-Z_][a-zA-Z0-9_]*)/gi
const SKIP = new Set(['select', 'set', 'values', 'where', 'and', 'or', 'on', 'as'])

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name)
    const st = fs.statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (name.endsWith('.js')) out.push(p)
  }
  return out
}

const fileToModule = new Map()
for (const [mod, spec] of Object.entries(OWNERSHIP)) {
  for (const f of spec.files) fileToModule.set(f.replace(/\\/g, '/'), mod)
}
const tracked = new Set(fileToModule.keys())

const stats = new Map() // table -> { mods:Set, files:Set }
for (const file of walk(src)) {
  const rel = path.relative(src, file).replace(/\\/g, '/')
  if (!tracked.has(rel)) continue
  const mod = fileToModule.get(rel)
  const text = fs.readFileSync(file, 'utf8')
  for (const m of text.matchAll(WRITE_RE)) {
    const t = m[1].toLowerCase()
    if (SKIP.has(t)) continue
    if (!stats.has(t)) stats.set(t, { mods: new Set(), files: new Set() })
    stats.get(t).mods.add(mod)
    stats.get(t).files.add(rel)
  }
}

const shared = new Set(SHARED)
const rows = [...stats.entries()]
  .filter(([t]) => !shared.has(t))
  .map(([t, v]) => ({ table: t, mods: [...v.mods].sort(), files: [...v.files].sort() }))
  .sort((a, b) => b.mods.length - a.mods.length || a.table.localeCompare(b.table))

const multi = rows.filter((r) => r.mods.length > 1)
const lines = []
lines.push('# 表 · 谁在写（2026-11-05 快照）')
lines.push('')
lines.push('> 由 `scripts/audit-table-writers.mjs` 扫出来：只看 SQL 写（增 / 改 / 删），不看读。')
lines.push('> 共享表（agents / events / journal / idempotency）不在统计里；权限本来就大家有。')
lines.push('')
lines.push(`写表合计：${rows.length} 张；多人写：${multi.length} 张。`)
lines.push('')
lines.push('## 一张表几个写手')
lines.push('')
lines.push('| 表 | 写的人 | 文件 |')
lines.push('|---|---|---|')
for (const r of rows) {
  lines.push(`| ${r.table} | ${r.mods.join(' / ')} | ${r.files.join('<br>')} |`)
}
lines.push('')
lines.push('## 先处理谁')
lines.push('')
if (multi.length) {
  lines.push('多人写的，按「写的人多」往下排。要么把写收口到一个零件，要么在 ownership 里写清谁是唯一写手、别人只能读（或走端口）。')
} else {
  lines.push('没有多人写的表。')
}
lines.push('')

const out = path.join(root, 'docs', '表-谁在写-2026-11-05.md')
fs.writeFileSync(out, lines.join('\n'), 'utf8')

console.log(`写表 ${rows.length} 张，多人写 ${multi.length} 张。报告：docs/表-谁在写-2026-11-05.md`)
for (const r of multi.slice(0, 12)) console.log(`  ${r.table} ← ${r.mods.join(', ')}`)
