import fs from 'node:fs'
import path from 'node:path'
const root = 'src'
const files = []
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith('.js')) files.push(p) } }
walk(root); files.push('index.js')
const ktext = fs.readFileSync('src/kernel.js', 'utf8')
const exports = new Set([...ktext.matchAll(/export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z0-9_]+)/g)].map((m) => m[1]))
for (const m of ktext.matchAll(/export\s*\{([^}]+)\}/g)) for (const part of m[1].split(',')) exports.add(part.trim().split(/\s+as\s+/).pop())
const missing = []
for (const f of files) {
  const t = fs.readFileSync(f, 'utf8')
  const re = /import\s*\{([^}]+)\}\s*from\s*['"][^'"]*kernel\.js['"]/g
  for (const m of t.matchAll(re)) {
    for (const raw of m[1].split(',')) {
      const name = raw.trim().split(/\s+as\s+/)[0].trim()
      if (!name) continue
      if (!exports.has(name)) missing.push(f + ' -> ' + name)
    }
  }
}
console.log('exports', exports.size, 'missing', missing.length)
for (const x of missing) console.log('  MISSING', x)
