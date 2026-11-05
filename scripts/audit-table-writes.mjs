/**
 * 盘一张表的写点：node scripts/audit-table-writes.mjs memory_items
 * 输出每个写点：哪个域、哪个文件、第几行、什么动作、SQL 片段。
 * 只扫 ownership 登记过的文件；不改任何东西。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { OWNERSHIP } from '../src/ports/ownership.js'

const table = String(process.argv[2] || '').toLowerCase()
if (!table) {
  console.error('用法：node scripts/audit-table-writes.mjs <表名>')
  process.exit(1)
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const src = path.join(root, 'src')
const VERB_RE = /\b(INSERT(?:\s+OR\s+REPLACE)?\s+INTO|REPLACE\s+INTO|UPDATE|DELETE\s+FROM|CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?|ALTER\s+TABLE|DROP\s+TABLE)\s+`?([a-zA-Z_][a-zA-Z0-9_]*)`?/gi

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

const hits = []
for (const file of walk(src)) {
  const rel = path.relative(src, file).replace(/\\/g, '/')
  if (!tracked.has(rel)) continue
  const text = fs.readFileSync(file, 'utf8')
  for (const m of text.matchAll(VERB_RE)) {
    if (m[2].toLowerCase() !== table) continue
    const line = text.slice(0, m.index).split('\n').length
    const snippet = text.slice(m.index, m.index + 170).replace(/\s+/g, ' ').trim()
    hits.push({ module: fileToModule.get(rel), file: rel, line, verb: m[1].replace(/\s+/g, ' ').toUpperCase(), snippet })
  }
}

hits.sort((a, b) => a.module.localeCompare(b.module) || a.file.localeCompare(b.file) || a.line - b.line)
console.log(table + '：' + hits.length + ' 个写点')
for (const h of hits) {
  console.log(`\n[${h.module}] ${h.file}:${h.line}  ${h.verb}`)
  console.log('  ' + h.snippet)
}
