/**
 * 考卷打假：塞坏版本，看卷子红不红。
 * 用法：node scripts/exam-sabotage.mjs
 *
 * 三个坏版本：拿掉 6 小时节流 / 把「提满五次收掉」的线改高 / 把「太短不挂」放宽。
 * 每个都要让开环考卷至少红一条；三个都拦住才 exit 0。
 * 改了 loops 的实现或考卷的 import 写法，这里也要跟着改。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const impl = path.join(root, 'src/parts/loops/index.js')
const exam = path.join(root, 'test/exam-loops.test.mjs')
const implText = fs.readFileSync(impl, 'utf8')
const examText = fs.readFileSync(exam, 'utf8')

const MUTANTS = [
  ['拿掉 6 小时节流',
    'const throttle = Number(opt.throttleHours == null ? 6 : opt.throttleHours) * HOUR',
    'const throttle = 0'],
  ['把「提满五次收掉」的线改到 99',
    'if (Number(r.fire_count || 0) >= 5) continue',
    'if (Number(r.fire_count || 0) >= 99) continue'],
  ['把「太短不挂」放宽（4 个字也认）',
    'if (t.length < 6 || VAGUE_RE.test(t)) return null',
    'if (VAGUE_RE.test(t)) return null'],
]

let pass = 0
let fail = 0
for (let i = 0; i < MUTANTS.length; i++) {
  const [name, from, to] = MUTANTS[i]
  if (!implText.includes(from)) {
    fail++
    console.log('FAIL ' + name + '：变异点没找到，脚本要跟着实现更新')
    continue
  }
  const mutantPath = path.join(root, 'src/parts/loops/.sabotage-' + i + '.mjs')
  const examPath = path.join(root, 'test/.sabotage-' + i + '.test.mjs')
  fs.writeFileSync(mutantPath, implText.replace(from, to))
  fs.writeFileSync(examPath, examText.replace(
    "from '../src/modules/loops.js'",
    "from '../src/parts/loops/.sabotage-" + i + ".mjs'",
  ))
  try {
    const r = spawnSync(process.execPath, [examPath], { cwd: root, encoding: 'utf8', timeout: 120000 })
    const out = String(r.stdout || '') + String(r.stderr || '')
    const redLines = (out.match(/^FAIL /gm) || []).length
    if (r.status !== 0 && redLines > 0) {
      pass++
      console.log('PASS ' + name + '：卷子拦住（' + redLines + ' 条红）')
    } else {
      fail++
      console.log('FAIL ' + name + '：卷子没拦住（exit=' + r.status + '）')
    }
  } finally {
    try { fs.unlinkSync(mutantPath) } catch { /* 已删 */ }
    try { fs.unlinkSync(examPath) } catch { /* 已删 */ }
  }
}

console.log('\n通过 ' + pass + ' / ' + (pass + fail))
if (fail) process.exitCode = 1
