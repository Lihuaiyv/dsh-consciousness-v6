/**
 * INV10：modules/* 依赖图无环；禁止互相 import 对方「未导出的 store 私货」——
 * 现阶段约定：只允许 import 同级模块的公开 .js，且图必须 DAG。
 * 用法：node scripts/dep-graph.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const modDir = path.join(__dirname, '..', 'src', 'modules')

const IMPORT_RE = /from\s+['"](\.[^'"]+)['"]/g

const files = fs.readdirSync(modDir).filter((f) => f.endsWith('.js'))
const nodes = new Set(files.map((f) => f.replace(/\.js$/, '')))
/** @type {Map<string, Set<string>>} */
const edges = new Map()
for (const n of nodes) edges.set(n, new Set())

for (const file of files) {
  const from = file.replace(/\.js$/, '')
  const text = fs.readFileSync(path.join(modDir, file), 'utf8')
  for (const m of text.matchAll(IMPORT_RE)) {
    const spec = m[1]
    if (!spec.startsWith('./')) continue
    const base = path.basename(spec).replace(/\.js$/, '')
    if (nodes.has(base) && base !== from) edges.get(from).add(base)
  }
}

// Kahn topological sort — 若不能排完则有环
const indeg = new Map([...nodes].map((n) => [n, 0]))
for (const [, tos] of edges) for (const t of tos) indeg.set(t, (indeg.get(t) || 0) + 1)
const q = [...nodes].filter((n) => indeg.get(n) === 0)
const order = []
while (q.length) {
  const n = q.shift()
  order.push(n)
  for (const t of edges.get(n)) {
    indeg.set(t, indeg.get(t) - 1)
    if (indeg.get(t) === 0) q.push(t)
  }
}

if (order.length !== nodes.size) {
  console.error('INV10 依赖环：')
  for (const [f, tos] of edges) if (tos.size) console.error(`  ${f} → ${[...tos].join(', ')}`)
  process.exit(1)
}

console.log('dep-graph ok —', order.join(' → '))
for (const [f, tos] of [...edges.entries()].sort()) {
  if (tos.size) console.log(`  ${f} → ${[...tos].join(', ')}`)
}
