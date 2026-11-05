// 算法册的界桩：每条算法都要说清「谁实现、归谁」。
// 运行：node scripts/check-algos.mjs
//
// 硬规矩（对应术语表 5.1 的链：算法 → 零件 → 文件 / 考卷）：
//   1. 每条算法都要带实现文件（file，由 import.meta.url 自动带），文件必须真在
//   2. owner 只要写了，就必须是零件册里有的 id（写错等于挂到不存在的零件上）
//   3. 没写 owner 的标「待认领」，不红——但要报数，免得一直没人认领也没人看见
// 任何一条不对就红。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { list } from '../src/algo/index.js'
import { PARTS } from '../src/modules/parts.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let fail = 0
const red = (msg) => { fail++; console.log('FAIL ' + msg) }

const partIds = new Set(PARTS.map((p) => p.id))
const algos = list()
const unclaimed = []

for (const a of algos) {
  const tag = a.name + '@' + a.version
  if (!a.file) {
    red(tag + '：没有实现文件（file 要由 import.meta.url 带进来）')
    continue
  }
  let abs = null
  try { abs = fileURLToPath(a.file) } catch { abs = null }
  if (!abs || !fs.existsSync(abs)) {
    red(tag + '：实现文件不存在 ' + a.file)
  } else if (!path.resolve(abs).startsWith(root + path.sep)) {
    red(tag + '：实现文件不在仓库里 ' + abs)
  }
  if (a.owner) {
    if (!partIds.has(a.owner)) red(tag + '：owner 指回零件册失败（' + a.owner + ' 不在零件册）')
  } else {
    unclaimed.push(tag)
  }
}

if (unclaimed.length) {
  console.log('待认领 ' + unclaimed.length + ' 条：' + unclaimed.join('、'))
}
console.log(fail
  ? '\n算法册界桩：' + fail + ' 条红'
  : '\n算法册界桩：全绿（' + algos.length + ' 条，' + (algos.length - unclaimed.length) + ' 条已认领，' + unclaimed.length + ' 条待认领）')
if (fail) process.exitCode = 1
