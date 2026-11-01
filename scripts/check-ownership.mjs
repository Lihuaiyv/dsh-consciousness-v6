/**
 * INV10：扫描 modules/algo/kernel SQL，表必须落在归属白名单内。
 * 用法：node scripts/check-ownership.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { OWNERSHIP, SHARED, isTableAllowed } from '../src/ports/ownership.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const src = path.join(__dirname, '..', 'src')

const SQL_RE = /\b(?:FROM|INTO|UPDATE|JOIN)\s+([a-zA-Z_][a-zA-Z0-9_]*)/gi
const SKIP = new Set(['select', 'set', 'values', 'where', 'and', 'or', 'on', 'as', 'left', 'right', 'inner', 'outer', 'cross'])

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name)
    const st = fs.statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (name.endsWith('.js')) out.push(p)
  }
  return out
}

const tracked = new Set()
for (const spec of Object.values(OWNERSHIP)) {
  if (spec.tables.includes('*')) continue
  for (const f of spec.files) tracked.add(f.replace(/\\/g, '/'))
}

const violations = []
const files = walk(src).filter((p) => {
  const rel = path.relative(src, p).replace(/\\/g, '/')
  return tracked.has(rel)
})

for (const file of files) {
  const rel = path.relative(src, file).replace(/\\/g, '/')
  const text = fs.readFileSync(file, 'utf8')
  const found = new Set()
  for (const m of text.matchAll(SQL_RE)) {
    const t = m[1].toLowerCase()
    if (SKIP.has(t)) continue
    found.add(t)
  }
  // 模板字符串里的 ${t} 动态表名：ops purge —— 已在白名单宽表；跳过明显动态
  for (const t of found) {
    const r = isTableAllowed(rel, t)
    if (!r.ok) violations.push({ file: rel, table: t, module: r.module, allowed: r.allowed })
  }
}

if (violations.length) {
  console.error('INV10 表白名单失败：')
  for (const v of violations) console.error(`  ${v.file} → ${v.table} (module=${v.module})`)
  process.exit(1)
}

console.log(`ownership ok — ${files.length} files, shared=[${SHARED.join(',')}]`)
