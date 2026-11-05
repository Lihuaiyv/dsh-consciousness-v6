/**
 * INV10：扫描 tracked 模块的 SQL，表必须落在归属白名单内；写还要落在 `writes` 里。
 * 读写拆分是逐个域补的：填了 writes 的域，写别的表就被拒；没填的仍按老样子放行。
 * 用法：node scripts/check-ownership.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { OWNERSHIP, SHARED, WRITE_SPLIT, isTableAllowed } from '../src/ports/ownership.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const src = path.join(__dirname, '..', 'src')

// 写：INSERT / REPLACE / UPDATE / DELETE / 改表结构；读：FROM / JOIN
const WRITE_RE = /\b(?:INSERT(?:\s+OR\s+REPLACE)?\s+INTO|REPLACE\s+INTO|UPDATE|DELETE\s+FROM|CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?|ALTER\s+TABLE|DROP\s+TABLE)\s+([a-zA-Z_][a-zA-Z0-9_]*)/gi
const READ_RE = /\b(?:FROM|JOIN)\s+([a-zA-Z_][a-zA-Z0-9_]*)/gi
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
  const writes = new Set()
  const reads = new Set()
  for (const m of text.matchAll(WRITE_RE)) {
    const t = m[1].toLowerCase()
    if (!SKIP.has(t)) writes.add(t)
  }
  for (const m of text.matchAll(READ_RE)) {
    const t = m[1].toLowerCase()
    if (!SKIP.has(t)) reads.add(t)
  }
  for (const t of writes) {
    const r = isTableAllowed(rel, t, 'write')
    if (!r.ok) {
      violations.push({
        file: rel, table: t, op: 'write', module: r.module,
        reason: r.reason || 'not_allowed', allowed: r.allowed,
      })
    }
  }
  for (const t of reads) {
    const r = isTableAllowed(rel, t, 'read')
    if (!r.ok) {
      violations.push({
        file: rel, table: t, op: 'read', module: r.module,
        reason: r.reason || 'not_allowed', allowed: r.allowed,
      })
    }
  }
}

// 声明自检：writes 必须在 tables 里；同一张表最多一个域声明写（SHARED 除外）
const declared = []
let declaredDomains = 0
for (const [mod, spec] of Object.entries(OWNERSHIP)) {
  if (!spec.writes) continue
  declaredDomains++
  for (const t of spec.writes) {
    if (!spec.tables.includes(t)) {
      violations.push({ module: mod, table: t, op: 'declare', reason: 'writes_not_in_tables' })
    }
    if (SHARED.includes(t)) continue
    declared.push([t, mod])
  }
}
const byTable = new Map()
for (const [t, mod] of declared) {
  if (!byTable.has(t)) byTable.set(t, [])
  byTable.get(t).push(mod)
}
for (const [t, mods] of byTable) {
  const uniq = [...new Set(mods)]
  if (uniq.length > 1) {
    const split = WRITE_SPLIT[t]
    if (split && uniq.every((m) => split.includes(m))) continue
    violations.push({ table: t, op: 'declare', reason: 'multi_writer', modules: uniq })
  }
}

if (violations.length) {
  console.error('INV10 表白名单失败：')
  for (const v of violations) {
    if (v.file) {
      console.error(`  ${v.file} → ${v.table}（${v.op}，module=${v.module}，${v.reason}）`)
    } else if (v.reason === 'multi_writer') {
      console.error(`  ${v.table} 被多个域声明写：${v.modules.join(', ')}`)
    } else {
      console.error(`  ${v.module || '?'} → ${v.table}（${v.reason}）`)
    }
  }
  process.exit(1)
}

const pending = Object.keys(OWNERSHIP).length - declaredDomains
console.log(`ownership ok — ${files.length} files；已分读写 ${declaredDomains} 个域，其余 ${pending} 个域还按老样子；shared=[${SHARED.join(',')}]`)
