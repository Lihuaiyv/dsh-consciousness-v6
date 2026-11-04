/**
 * INV12：大脑盒只准依赖自己（./）和端口契约（../ports/）。
 *
 * 为什么：大脑一旦能直接 import db / api / modules/actions，它就不再是「裁决层」，
 * 而是又一个总装车间；换零件时又会被牵连进去。
 *
 * 用法：node scripts/check-brain.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dir = path.join(root, 'src', 'brain')
const ALLOW = [/^\.\//, /^\.\.\/ports\//]

function walk(p, out = []) {
  if (!fs.existsSync(p)) return out
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    const fp = path.join(p, e.name)
    if (e.isDirectory()) walk(fp, out)
    else if (e.name.endsWith('.js')) out.push(fp)
  }
  return out
}

const files = walk(dir)
const hits = []
for (const f of files) {
  const s = fs.readFileSync(f, 'utf8')
  for (const m of s.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
    const spec = m[1]
    if (!ALLOW.some((re) => re.test(spec))) {
      const line = s.slice(0, m.index).split('\n').length
      hits.push({ file: path.relative(root, f).replace(/\\/g, '/'), line, spec })
    }
  }
}

if (hits.length) {
  console.error('INV12 大脑盒越界：')
  for (const h of hits) console.error(`  ${h.file}:${h.line}  import '${h.spec}'`)
  console.error('\n大脑只准 import 自己（./）或端口契约（../ports/）。要读库/发消息，让调用方拼好状态再进来。')
  process.exit(1)
}
console.log(`brain ok — ${files.length} 个文件，无越界 import`)
