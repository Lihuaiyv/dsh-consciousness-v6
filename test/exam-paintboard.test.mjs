/**
 * 画板零件 · 考卷
 *
 * 管的是「一支笔 + 一张纸」：落笔能存住、能画出图、能撤、能清空。
 * 不管画得像不像——那是用的人自己的事。
 *
 * 运行：node test/exam-paintboard.test.mjs
 * 机器上得有 python（PIL）。没有就 SKIP，不算失败。
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const BOARD = process.env.PAINT_BOARD || path.join(ROOT, 'src', 'parts', 'paintboard', 'board.py')
const PY = process.env.PAINT_PYTHON || 'python'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 300)) }
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-paint-'))
const env = { ...process.env, PAINTBOARD_HOME: dataDir }

function run(args) {
  return spawnSync(PY, [BOARD, ...args], { env, encoding: 'utf8', timeout: 60000 })
}

// 先探一下 python 在不在
const probe = run(['status'])
if (probe.error || probe.status !== 0) {
  console.log('SKIP 这台机器上没有跑得起来的 python（' + (probe.error?.message || probe.stderr || '').slice(0, 120) + '）')
  process.exit(0)
}

{
  const r = run(['new', '400', '400'])
  check('开新纸：退出码 0', r.status === 0, r.stderr)
  const st = fs.existsSync(path.join(dataDir, 'board.json'))
  check('开新纸：状态文件落了盘', st)
  const png = path.join(dataDir, 'board.png')
  check('开新纸：出了一张空白图', fs.existsSync(png) && fs.statSync(png).size > 500)
}

{
  const ops = [
    { pts: [[50, 50], [150, 120], [250, 60]], w: 5, c: [40, 40, 46], a: 1 },
    { pts: [[60, 300], [200, 300]], w: 3, c: [200, 60, 60], a: 0.8 },
  ]
  const opsFile = path.join(dataDir, 'ops.json')
  fs.writeFileSync(opsFile, JSON.stringify(ops), 'utf8')
  const r = run(['apply', opsFile])
  check('落两笔：退出码 0', r.status === 0, r.stderr)
  const s = run(['status']).stdout
  check('落两笔：计数是 2', /2 笔/.test(s), s)
  const size = fs.statSync(path.join(dataDir, 'board.png')).size
  check('落两笔：图变大了（真画上去了）', size > 1200, size)
}

{
  const r = run(['undo'])
  check('撤一笔：退出码 0', r.status === 0, r.stderr)
  const s = run(['status']).stdout
  check('撤一笔：剩下 1 笔', /1 笔/.test(s), s)
}

{
  const before = fs.statSync(path.join(dataDir, 'board.png')).size
  run(['stroke', JSON.stringify({ pts: [[100, 100], [300, 200]], w: 9, c: [20, 20, 20] })])
  const s = run(['status']).stdout
  check('单笔落下：计数回到 2', /2 笔/.test(s), s)
  check('单笔落下：图又变了', fs.statSync(path.join(dataDir, 'board.png')).size !== before)
}

{
  fs.writeFileSync(path.join(dataDir, 'board.json'), JSON.stringify({ w: 200, h: 200, paper: [252, 250, 246], strokes: [] }), 'utf8')
  const r = run(['render'])
  check('渲染空纸：退出码 0', r.status === 0, r.stderr)
  check('渲染空纸：图还在', fs.existsSync(path.join(dataDir, 'board.png')))
}

fs.rmSync(dataDir, { recursive: true, force: true })
console.log('\n通过 ' + pass + ' / ' + (pass + fail))
if (fail) process.exitCode = 1

