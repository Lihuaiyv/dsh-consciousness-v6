/**
 * INV9：业务代码不得出现模型厂商/产品名（允许 model.js、配置示例、文档）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const src = path.join(__dirname, '..', 'src')
const ALLOW = new Set([
  'model.js',
  'model.json.example',
])
const BAN = [
  /\bopenai\b/i,
  /\banthropic\b/i,
  /\bclaude\b/i,
  /\bgpt-4\b/i,
  /\bgpt-3\b/i,
  /\bqwen\b/i,
  /\bdeepseek-chat\b/i,
  /\bdeepseek-v\b/i,
]

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name)
    if (fs.statSync(p).isDirectory()) walk(p, out)
    else if (name.endsWith('.js')) out.push(p)
  }
  return out
}

const hits = []
for (const file of walk(src)) {
  const base = path.basename(file)
  if (ALLOW.has(base)) continue
  const text = fs.readFileSync(file, 'utf8')
  for (const re of BAN) {
    if (re.test(text)) hits.push({ file: path.relative(src, file), re: String(re) })
  }
}

if (hits.length) {
  console.error('INV9 模型名泄漏：')
  for (const h of hits) console.error('  ' + h.file + '  ' + h.re)
  process.exit(1)
}
console.log('inv9 ok — 业务源码无厂商名')
