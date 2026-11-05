// 零件册的界桩：一行一个零件，检查登记是不是真的。
// 运行：node scripts/check-parts.mjs
//
// 硬规矩（对应词表 5.1 + 分离度）：
//   1. 零件册里的文件必须存在
//   2. 零件册里的考卷必须真能跑：界桩自己把考卷跑一遍，退出码非 0 就是红
//   3. 名字 / 归属 / 入口不能空
//   4. 零件内文件不许 import 宿主薄壳 features.js（回流检查）
//   5. 考卷实跑的「通过 N / M」要和册子里登记的一致（登记不能停在旧数）
// 任何一条不对就红。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
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
  if (p.exam && p.exam.file) {
    const abs = path.join(root, p.exam.file)
    if (!fs.existsSync(abs)) {
      red(tag + '：考卷不存在 ' + p.exam.file)
    } else {
      // 真跑：退出码 + 实跑分数都要对得上。别让「文件在」冒充「考卷能跑」。
      // 输出落临时文件再读（照 run-tests 的做法）：沙箱里子进程的管道 stdio 会 EPERM。
      const t0 = Date.now()
      const log = path.join(os.tmpdir(), 'dshc-exam-' + tag.replace(/[^\w.-]/g, '_') + '-' + process.pid + '.log')
      const fd = fs.openSync(log, 'w')
      let status = null
      try {
        status = spawnSync(process.execPath, [abs], { cwd: root, stdio: ['ignore', fd, fd], timeout: 180000 }).status
      } finally {
        fs.closeSync(fd)
      }
      let out = ''
      try { out = fs.readFileSync(log, 'utf8') } catch { out = '' }
      try { fs.unlinkSync(log) } catch { /* 删不掉不影响判定 */ }
      if (status !== 0) {
        const tail = out.trim().split('\n').slice(-3).join(' | ')
        red(tag + '：考卷跑挂了（exit ' + status + '） ' + tail)
      } else {
        const hits = out.match(/通过\s*(\d+)\s*\/\s*(\d+)/g) || []
        const last = hits.length ? hits[hits.length - 1].match(/(\d+)\s*\/\s*(\d+)/) : null
        const got = last ? last[1] + '/' + last[2] : ''
        const want = String(p.exam.score || '').replace(/\s+/g, '')
        if (want && got && got !== want) red(tag + '：考卷实跑 ' + got + '，登记 ' + want)
        else console.log('OK ' + tag + '：考卷 ' + (got || '通过') + '，' + (Date.now() - t0) + 'ms')
      }
    }
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
