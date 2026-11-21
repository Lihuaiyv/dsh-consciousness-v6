/**
 * DSH 私有文件读口（2026-11-19，D95）——「断了要说出来」这件事的验收。
 *
 *   1. 正常文件 → ok，值对，报告 ok
 *   2. 冷启动没文件 → absent，不崩、不算断
 *   3. 曾读到过、后来结构变了 → degraded，带原因；断链记一次、takeBreaks 取走即清
 *   4. 冷却内重复坏不重复报
 *   5. 修好后读回 ok
 *   6. 曾读到过、文件被删 → missing，要报
 *   7. dshHome / 读点清单 / readOr 兜底
 *
 * 运行：node test/host-files.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createFileSeam, dshHome, FILE_POINTS, breakLineOf } from '../src/host/fs.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)) }
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-hostfs-'))
fs.mkdirSync(path.join(home, 'storages'), { recursive: true })
const wsFile = path.join(home, 'storages', 'workspace.json')
const goodWs = { global: { archivedSessionIds: ['s1', 's2'], workspaceIds: ['w1'] }, tables: { workspaces: { w1: { title: '主分支', sessionIds: ['s9'] } } } }
fs.writeFileSync(wsFile, JSON.stringify(goodWs))

const logs = []
// env 传空对象：不让外面 shell 的 DSH_PROFILE_DIR 混进来，测试只认自己的临时目录
const seam = createFileSeam({ home, env: {}, log: (m) => logs.push(m) })

// 1) 正常
const ws = seam.read('workspace')
check('workspace 正常读', ws.ok && ws.value.global.archivedSessionIds.length === 2, ws)
check('报告 status=ok', seam.report().status === 'ok', seam.report().status)

// 2) 冷启动没有就是没有，不算断
const noTitle = seam.read('session.title', 'nope')
check('没有标题文件 → absent', noTitle.ok === false && noTitle.level === 'absent', noTitle)
check('absent 不产生断链', seam.hasBreaks() === false)

// 3) 结构变了 → degraded + 一句原因
fs.writeFileSync(wsFile, JSON.stringify({ global: { archivedSessionIds: 'bad' } }))
const bad = seam.read('workspace')
check('archivedSessionIds 不是数组 → degraded', bad.ok === false && bad.level === 'degraded', bad)
check('原因写得出来', /不是数组/.test(String(bad.reason)), bad.reason)
check('断链记下了', seam.hasBreaks() === true)
const taken = seam.takeBreaks()
check('takeBreaks 取到一条', taken.length === 1 && taken[0].id === 'workspace', taken)
check('取走后清空', seam.hasBreaks() === false)
check('降级时调用方拿到 fallback', seam.readOr('workspace', null) === null)

// 4) 冷却：还坏着，但 6h 内不再报
seam.read('workspace')
check('冷却内不重复报', seam.hasBreaks() === false)

// 5) 修好 → 读回 ok
fs.writeFileSync(wsFile, JSON.stringify({ global: { archivedSessionIds: ['a'] } }))
const back = seam.read('workspace')
check('修好后读回 ok', back.ok === true && seam.report().status === 'ok', back)

// 6) 曾读到过、文件被删 → missing，要报
fs.unlinkSync(wsFile)
const gone = seam.read('workspace')
check('文件被删 → missing', gone.ok === false && gone.level === 'missing', gone)
check('删掉会报断链', seam.hasBreaks() === true)
const taken2 = seam.takeBreaks()
check('报的级别是 missing', taken2.length === 1 && taken2[0].level === 'missing', taken2)

// 7) 路径与兜底
check('dshHome 认 DSH_HOME', dshHome({ DSH_HOME: 'D:/x' }) === 'D:/x', dshHome({ DSH_HOME: 'D:/x' }))
check('dshHome 有默认值', typeof dshHome({}) === 'string' && dshHome({}).length > 0)
check('读点清单三项', FILE_POINTS.length === 3, FILE_POINTS)
check('pathOf 找不到给空串', seam.pathOf('qq.sessions') === '')
check('报告里每个读点都有 level', seam.report().entries.every((e) => typeof e.level === 'string'), seam.report().entries)

// 8) 「我会说出来」这句话本身要有护栏：提示词那行由纯函数拼，能单独测
check('没断链 → 提示词里一句都不加', breakLineOf([]) === '' && breakLineOf(null) === '')
{
  const line = breakLineOf([{ id: 'workspace', reason: '顶层不是对象' }, { id: 'qq.sessions', level: 'missing' }])
  check('有断链 → 带 id 和原因', /workspace/.test(line) && /顶层不是对象/.test(line) && /qq\.sessions/.test(line), line)
  check('有断链 → 说清要我去查', /DSH/.test(line) && /跟主人说/.test(line), line)
}

console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) {
  console.log('失败', fail)
  process.exit(1)
}
