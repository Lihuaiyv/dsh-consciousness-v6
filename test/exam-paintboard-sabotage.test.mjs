/**
 * 画板 · 打假
 *
 * 往实现里塞一个坏版本，看考卷拦不拦得住。
 * 坏在哪：`render()` 不再写图片文件——看起来一切正常，但纸上什么都没有。
 *
 * 用法：node test/exam-paintboard-sabotage.test.mjs
 * 机器上没 python 就 SKIP，不算失败。
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const BOARD = path.join(ROOT, 'src', 'parts', 'paintboard', 'board.py')
const EXAM = path.join(HERE, 'exam-paintboard.test.mjs')
const PY = process.env.PAINT_PYTHON || 'python'

if (!fs.existsSync(BOARD)) {
  console.log('SKIP 找不到 board.py')
  process.exit(0)
}

// 先确认正常版本能过，不然「拦住」没意义
const pyOk = spawnSync(PY, ['-c', 'import PIL; print("ok")'], { encoding: 'utf8' })
if (pyOk.error || pyOk.status !== 0) {
  console.log('SKIP 没有能跑 PIL 的 python')
  process.exit(0)
}

const orig = fs.readFileSync(BOARD, 'utf8')
const mutantPath = path.join(path.dirname(BOARD), 'board.sabotage.py')
const target = '    out.save(PNG)'
if (!orig.includes(target)) {
  console.log('FAIL 变异点没找到（board.py 里 `out.save(PNG)` 变了），脚本要跟着更新')
  process.exit(1)
}
fs.writeFileSync(mutantPath, orig.replace(target, '    pass  # 打假：不写图'), 'utf8')

let passed = false
let detail = ''
try {
  const r = spawnSync(process.execPath, [EXAM], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 180000,
    env: { ...process.env, PAINT_BOARD: mutantPath },
  })
  const out = String(r.stdout || '') + String(r.stderr || '')
  const red = (out.match(/^FAIL /gm) || []).length
  passed = r.status !== 0 && red > 0
  detail = 'exit=' + r.status + '，红 ' + red + ' 条'
} finally {
  try { fs.unlinkSync(mutantPath) } catch { /* 已删 */ }
}

if (passed) {
  console.log('PASS 画板：坏版本（不写图）被考卷拦住了（' + detail + '）')
} else {
  console.log('FAIL 画板：坏版本没被拦住（' + detail + '）')
  process.exitCode = 1
}
