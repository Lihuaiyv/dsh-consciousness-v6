// 零件册的界桩：一行一个零件，检查登记是不是真的。
// 运行：node scripts/check-parts.mjs
//
// 硬规矩（对应词表 5.1 + 分离度）：
//   1. 零件册里的文件必须存在
//   2. 零件册里的考卷必须真能跑（文件存在；跑不跑由各自的 test 负责）
//   3. 名字 / 归属 / 入口不能空
//   4. 零件内文件不许 import 宿主薄壳 features.js（回流检查）
// 任何一条不对就红。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PARTS } from '../src/modules/parts.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let fail = 0
const red = (msg) => { fail++; console.log('FAIL ' + msg) }

for (const p of PARTS) {
  const tag = p.id || '(缺 id)'
  if (!p.name || !p.owner || !p.entry) red(tag + '：名字/归属/入口不能空')
  if (!Array.isArray(p.files) || !p.files.length) red(tag + '：至少要登记一个文件')
  for (const f of p.files || []) {
    if (!fs.existsSync(path.join(root, f))) red(tag + '：文件不存在 ' + f)
  }
  if (p.exam && p.exam.file && !fs.existsSync(path.join(root, p.exam.file))) {
    red(tag + '：考卷不存在 ' + p.exam.file)
  }
  if (p.status === '可换' && !(p.rollback && p.rollback.pointer)) red(tag + '：可换零件必须有回退点')
  // 回流检查：零件内部不许反向依赖宿主薄壳 features.js
  for (const f of p.files || []) {
    if (!String(f).startsWith('src/parts/')) continue
    try {
      const src = fs.readFileSync(path.join(root, f), 'utf8')
      if (/from\s+'\.\.\/(?:\.\.\/)?features\.js'/.test(src)) red(tag + '：零件文件 import 了 features.js（回流）: ' + f)
    } catch { /* 上面已查存在 */ }
  }
}

console.log(fail ? '\n零件册界桩：' + fail + ' 条红' : '\n零件册界桩：全绿（' + PARTS.length + ' 个零件）')
if (fail) process.exitCode = 1
