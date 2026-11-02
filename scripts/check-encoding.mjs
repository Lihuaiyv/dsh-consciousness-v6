/**
 * 编码体检：找出被「UTF-8 读成 GBK」弄坏的中文行。
 *
 * 不是修复工具——原意一旦丢了就补不回来，硬猜比留着更糟。
 * 它的活是：每次改动后告诉你「还剩多少行是坏的、在哪」，别让坏注释悄悄长回来。
 *
 *   node scripts/check-encoding.mjs            # 只报告
 *   node scripts/check-encoding.mjs --strict   # 有坏行就退出码 1（给 CI 用）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SKIP = new Set(['node_modules', '.git', '_rescue-20261101-2158', '_bak_kernel_p0_20261102', '_bak_client_20261102-135812.js'])
const EXTS = new Set(['.js', '.mjs', '.json', '.md'])

/** 坏掉的典型长相：整行大多数汉字落在 U+9300–U+9FFF（GBK 二次编码的产物）。 */
function looksBroken(line) {
  const cjk = line.match(/[\u4e00-\u9fff]/g) || []
  if (cjk.length < 4) return false
  const bad = line.match(/[\u9300-\u9fff]/g) || []
  if (line.includes('\uFFFD')) return true
  return bad.length / cjk.length >= 0.35
}

const hits = []
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { walk(p); continue }
    if (!EXTS.has(path.extname(e.name))) continue
    let text = ''
    try { text = fs.readFileSync(p, 'utf8') } catch { continue }
    text.split('\n').forEach((l, i) => { if (looksBroken(l)) hits.push({ file: path.relative(root, p), line: i + 1, text: l.trim().slice(0, 70) }) })
  }
}
walk(root)

const byFile = new Map()
for (const h of hits) byFile.set(h.file, (byFile.get(h.file) || 0) + 1)

if (!hits.length) {
  console.log('ok: 没有编码损坏的行')
} else {
  console.log('编码损坏 ' + hits.length + ' 行，涉及 ' + byFile.size + ' 个文件：')
  for (const [f, n] of [...byFile.entries()].sort((a, b) => b[1] - a[1])) console.log('  ' + f + '  ' + n + ' 行')
  console.log('\n前 5 行示例：')
  for (const h of hits.slice(0, 5)) console.log('  ' + h.file + ':' + h.line + '  ' + h.text)
  console.log('\n说明：原意已丢失，不自动改写（猜出来的注释比坏的更危险）。新写的中文别再用 PowerShell 的 Set-Content 往返。')
}
if (process.argv.includes('--strict') && hits.length) process.exitCode = 1
