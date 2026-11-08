/**
 * 目录卫生闸：仓库根目录只留入口、源码和约定里的目录，别的都算脏。
 *
 * 为什么要有它：根目录曾经堆着上百个 `_*.mjs` 草稿、`.out` 输出、`_bak_*` 备份，
 * 一百多个未跟踪文件，谁也不知道哪个还有用。规矩是：一次性的进 scratch/，运行产物进 var/，
 * 两个目录都在 .gitignore 里；根目录只许白名单里的东西。
 *
 * 只查「根目录」，不查 src/ 之类——那里的新文件是该被提交的代码，不是脏东西。
 * 被 .gitignore 挡住的不报（那说明规则已经管住了）。
 *
 * 用法：node scripts/check-hygiene.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// 根目录白名单：目录只列允许存在的，文件只列该留的
const ALLOW_DIRS = new Set([
  '.git', 'src', 'scripts', 'test', 'docs', 'drafts', 'locale', 'assets',
  'scratch', 'var', 'node_modules', '__pycache__',
  'client', // client.js 的源码分片（scripts/split-client.mjs 生成）
])
const ALLOW_FILES = new Set([
  '.gitignore', '.gitattributes', 'index.js', 'client.js', 'package.json', 'README.md', 'LICENSE',
  'cordis.patch.yml', 'icon.svg', 'model.json.example', 'xmind.json',
])

function ignored(rel) {
  try {
    const r = spawnSync('git', ['-C', root, 'check-ignore', '-q', rel], { timeout: 15000 })
    return r.status === 0
  } catch { return false }
}

const bad = []
for (const name of fs.readdirSync(root, { withFileTypes: true })) {
  const n = name.name
  if (name.isDirectory()) {
    if (ALLOW_DIRS.has(n)) continue
    if (ignored(n)) continue
    bad.push(n + '/')
  } else {
    if (ALLOW_FILES.has(n)) continue
    if (ignored(n)) continue
    bad.push(n)
  }
}

if (bad.length) {
  console.error('根目录有 ' + bad.length + ' 个不该出现在这里的东西：')
  for (const b of bad) console.error('  ' + b)
  console.error('\n规矩：一次性的放 scratch/，运行产物放 var/（两者已忽略）；要进版本库的放进对应目录。')
  process.exit(1)
}

console.log('目录卫生 ok — 根目录只有入口、源码和约定里的目录')
