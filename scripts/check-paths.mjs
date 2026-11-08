/**
 * 路径闸：tracked 的代码文件里不许出现写死的绝对路径。
 *
 * 为什么要有它：2026-11-08 重装，用户从 ygys1 变成 l、仓库从 D:\deepseek 搬到 D:\deepseek_local，
 * 十几个脚本里写死的 `C:/Users/ygys1/.dsh/...` 当场全指错地方——不报错，只是读到空库。
 * 搬家还会再发生，所以把这件事做成闸：路径从 src/paths.js 取，或者用相对路径。
 *
 * 扫描范围：src/、scripts/、test/ 下的源文件 + 根目录入口（index.js / client.js / package.json）。
 * 不扫 docs/、drafts/：那里记历史，出现旧路径是正常的。
 * 例外：行内带 `check-paths:allow` 的，跳过（写测试夹具时用得到）。
 *
 * 用法：node scripts/check-paths.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CODE_DIRS = ['src', 'scripts', 'test']
const ROOT_ENTRIES = ['index.js', 'client.js', 'package.json']
const EXTS = new Set(['.js', '.mjs', '.cjs', '.ts', '.py', '.ps1', '.json'])
const ABS = /(?:[A-Za-z]:[\\/](?:Users|deepseek))|(?:\/Users\/[A-Za-z0-9._-]+)/i

function listed() {
  const out = new Set()
  // git 里的（已进版本库的）和磁盘上正在写的都要扫：
  // 只信 ls-files 的话，刚新建、还没 add 的文件会漏过去——那正是最容易带进绝对路径的时刻。
  try {
    const r = spawnSync('git', ['-C', root, 'ls-files'], { encoding: 'utf8', timeout: 30000 })
    if (r.status === 0 && r.stdout) for (const f of r.stdout.split('\n')) if (f) out.add(f)
  } catch { /* 没有 git 就只扫磁盘 */ }
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      if (name === 'node_modules' || name === '.git' || name === 'scratch' || name === 'var') continue
      const p = path.join(dir, name)
      const st = fs.statSync(p)
      if (st.isDirectory()) { walk(p); continue }
      out.add(path.relative(root, p).replace(/\\/g, '/'))
    }
  }
  for (const d of CODE_DIRS) { try { walk(path.join(root, d)) } catch { /* 目录可能不在 */ } }
  for (const f of ROOT_ENTRIES) if (fs.existsSync(path.join(root, f))) out.add(f)
  return [...out]
}

const files = listed().filter((f) => {
  if (f.startsWith('docs/') || f.startsWith('drafts/')) return false
  if (f.includes('node_modules')) return false
  const base = f.split('/').pop()
  if (ROOT_ENTRIES.includes(f)) return true
  if (!CODE_DIRS.some((d) => f.startsWith(d + '/'))) return false
  return EXTS.has(path.extname(base))
})

const hits = []
for (const f of files) {
  let text
  try { text = fs.readFileSync(path.join(root, f), 'utf8') } catch { continue }
  if (text.includes('\u0000')) continue
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i]
    if (!ABS.test(ln)) continue
    if (ln.includes('check-paths:allow')) continue
    if (f === 'src/paths.js' || f === 'scripts/check-paths.mjs') continue
    hits.push({ file: f, line: i + 1, text: ln.trim().slice(0, 120) })
  }
}

if (hits.length) {
  console.error('发现写死的绝对路径（改用 src/paths.js 或相对路径；确实要留的加 check-paths:allow）：')
  for (const h of hits) console.error('  ' + h.file + ':' + h.line + '  ' + h.text)
  console.error('\n共 ' + hits.length + ' 处，扫了 ' + files.length + ' 个文件')
  process.exit(1)
}

console.log('路径闸 ok — ' + files.length + ' 个文件里没有写死的绝对路径')
