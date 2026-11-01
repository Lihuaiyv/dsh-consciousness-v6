/**
 * 参数实例化：业务代码不得读写 PARAMS[x][1]（默认值槽）。
 * 运行时取值必须走 getParam(db, aid, key)；目录级读等级/是否存在可用 PARAMS[key]。
 * 仅 kernel.js 允许定义 PARAMS 字面量。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const src = path.join(__dirname, '..', 'src')

const BAN = [
  { re: /PARAMS\s*\[[^\]]+\]\s*\[\s*1\s*\]/, why: '读/写默认值槽 PARAMS[k][1]' },
  { re: /PARAMS\s*\[[^\]]+\]\s*=/, why: '整键覆盖 PARAMS[k]=' },
  { re: /PARAMS\s*\[[^\]]+\]\s*\[\s*1\s*\]\s*=/, why: '写入 PARAMS[k][1]=' },
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
  const rel = path.relative(src, file).replace(/\\/g, '/')
  if (rel === 'kernel.js') continue // 目录定义处
  const text = fs.readFileSync(file, 'utf8')
  // 去掉注释行，减少误报
  const code = text.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
  for (const { re, why } of BAN) {
    if (re.test(code)) hits.push({ file: rel, why })
  }
}

if (hits.length) {
  console.error('参数实例化违规（须用 getParam/writeParam）：')
  for (const h of hits) console.error('  ' + h.file + '  — ' + h.why)
  process.exit(1)
}
console.log('params ok — 无 PARAMS[k][1] 读写')
