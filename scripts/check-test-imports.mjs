// 静态检查：test/*.mjs 里从 ../src 具名导入的符号，目标文件真的导出了吗？
import fs from 'node:fs'
import path from 'node:path'

const root = process.argv[2] || process.cwd()
const testDir = path.join(root, 'test')
const srcDir = path.join(root, 'src')

function exportsOf(file) {
  let text = ''
  try { text = fs.readFileSync(file, 'utf8') } catch { return null }
  const names = new Set()
  const re = /export\s+(?:async\s+)?(?:function|function\*|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g
  for (const m of text.matchAll(re)) names.add(m[1])
  // export { a, b as c }
  for (const m of text.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const seg = part.trim()
      if (!seg) continue
      const as = seg.split(/\s+as\s+/)
      names.add((as[1] || as[0]).trim())
    }
  }
  if (/export\s+default\b/.test(text)) names.add('default')
  return names
}

function specFiles(spec, baseDir) {
  const p = path.resolve(baseDir, spec)
  const out = [p]
  if (!path.extname(p)) out.push(p + '.js', p + '.mjs', path.join(p, 'index.js'))
  return out
}

const problems = []
for (const name of fs.readdirSync(testDir)) {
  if (!name.endsWith('.mjs')) continue
  const file = path.join(testDir, name)
  const text = fs.readFileSync(file, 'utf8')
  const re = /import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g
  for (const m of text.matchAll(re)) {
    const spec = m[2]
    if (!spec.startsWith('.')) continue
    const target = specFiles(spec, testDir).find((p) => fs.existsSync(p))
    if (!target) continue
    const ex = exportsOf(target)
    if (!ex) continue
    for (const part of m[1].split(',')) {
      const seg = part.trim()
      if (!seg) continue
      const imported = seg.split(/\s+as\s+/)[0].trim()
      if (!imported) continue
      if (!ex.has(imported)) problems.push({ file: name, from: path.relative(root, target), missing: imported })
    }
  }
}

if (!problems.length) console.log('ok: 没有缺失的具名导出')
else {
  const byFile = new Map()
  for (const p of problems) {
    if (!byFile.has(p.file)) byFile.set(p.file, [])
    byFile.get(p.file).push(`${p.missing} (from ${p.from})`)
  }
  for (const [f, list] of byFile) console.log(f, '->', list.join('; '))
  console.log(`\n${byFile.size} 个文件有缺失导出，共 ${problems.length} 处`)
}
