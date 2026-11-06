import fs from 'node:fs'
import path from 'node:path'
const files = []
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith('.js')) files.push(p) } }
walk('src'); files.push('index.js')
const ktext = fs.readFileSync('src/kernel.js', 'utf8')
const keys = new Set([...ktext.matchAll(/^\s*'([\w.]+)':\s*\[/gm)].map((m) => m[1]))
const used = new Set()
for (const f of files) {
  const t = fs.readFileSync(f, 'utf8')
  for (const m of t.matchAll(/getParam\([^,]+,\s*'([\w.]+)'/g)) used.add(m[1])
}
const missing = [...used].filter((k) => !keys.has(k))
console.log('used', used.size, 'declared', keys.size, 'missing', missing.length)
missing.forEach((k) => console.log('  ', k))
