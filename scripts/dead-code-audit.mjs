/**
 * 死代码审计 v2（只读）。
 *
 *   node scripts/dead-code-audit.mjs
 *
 * 只看真正没用的：
 *   A import 了、文件里再没出现过
 *   B export 了、本文件和外文件都没再用（内部只用它、却 export 出去的不算死代码，只算多余导出）
 *   C 本文件里声明了、之后一次都没再读过（死变量 / 死函数）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const files = []
const walk = (p) => {
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    if (e.name.startsWith('_') || e.name === 'node_modules' || e.name.includes('.bak')) continue
    const fp = path.join(p, e.name)
    if (e.isDirectory()) walk(fp)
    else if (e.name.endsWith('.js')) files.push(fp)
  }
}
for (const f of ['index.js', 'client.js', 'src']) {
  const p = path.join(root, f)
  if (!fs.existsSync(p)) continue
  if (fs.statSync(p).isDirectory()) walk(p)
  else files.push(p)
}
const tests = []
for (const d of ['test', 'scripts']) {
  const p = path.join(root, d)
  if (!fs.existsSync(p)) continue
  for (const e of fs.readdirSync(p)) if (e.endsWith('.mjs')) tests.push(path.join(p, e))
}
const all = [...files, ...tests]
const src = new Map(all.map((f) => [f, fs.readFileSync(f, 'utf8')]))
const rel = (f) => path.relative(root, f).replace(/\\/g, '/')
const count = (s, name) => (s.match(new RegExp('\\b' + name.replace(/[$]/g, '\\$') + '\\b', 'g')) || []).length

const A = []
for (const f of files) {
  const s = src.get(f)
  const re = /import\s*\{([^}]*)\}\s*from\s*['"][^'"]+['"]/g
  let m
  while ((m = re.exec(s))) {
    for (const raw of m[1].split(',')) {
      const name = raw.trim().split(/\s+as\s+/).pop().trim()
      if (!/^[A-Za-z_$][\w$]*$/.test(name)) continue
      if (count(s.replace(m[0], ''), name) === 0) A.push({ file: rel(f), name, line: s.slice(0, m.index).split('\n').length })
    }
  }
}

const B = []
for (const f of files) {
  const s = src.get(f)
  const re = /export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/g
  let m
  while ((m = re.exec(s))) {
    const name = m[1]
    const line = s.slice(0, m.index).split('\n').length
    const own = s.split('\n').slice(line).join('\n')
    if (count(own, name) > 0) continue // 本文件后面还在用 → 只是多余 export
    let other = 0
    for (const g of all) if (g !== f && count(src.get(g), name) > 0) other++
    if (!other) B.push({ file: rel(f), name, line })
  }
}

const C = []
for (const f of files) {
  const s = src.get(f)
  const re = /^\s*(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=/gm
  let m
  while ((m = re.exec(s))) {
    const name = m[1]
    const line = s.slice(0, m.index).split('\n').length
    const own = s.split('\n').slice(line).join('\n')
    if (count(own, name) === 0) C.push({ file: rel(f), name, line })
  }
}

console.log('== A 未使用的 import ==')
for (const x of A) console.log(`  ${x.file}:${x.line}  ${x.name}`)
console.log('\n== B 真正没人用的 export（本文件后续也没读）==')
for (const x of B) console.log(`  ${x.file}:${x.line}  ${x.name}`)
console.log('\n== C 声明后再没读过的变量 ==')
for (const x of C) console.log(`  ${x.file}:${x.line}  ${x.name}`)
console.log(`\n文件 ${files.length} 个；A ${A.length} / B ${B.length} / C ${C.length}`)
