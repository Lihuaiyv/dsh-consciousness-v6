/**
 * 零件册数据契约：先有册子，再往里加零件。
 * 运行：node test/parts.test.mjs
 *
 * 管的是「这一行本身登记得对不对」：字段齐、id 唯一、文件存在、状态不说谎。
 * 换零件之前要过的那张考卷是另一回事，在零件自己名下（exam.file）。
 * 以后接进 check:arch 时，这里就是界桩的三条：文件存在、考卷存在、可换要三样齐。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PARTS, listParts } from '../src/modules/parts.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) } else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)) }
}

const ROLES = ['大脑', '骨架', '基因', '器官', '四肢', '皮肤', '免疫']
const CHAINS = ['链上', '链外']
const JUDGES = ['机器', '人', '混合']
const STATUSES = ['在用', '可换', '已退役']

check('零件册不是空的', PARTS.length > 0, PARTS.length)

const ids = PARTS.map((p) => p.id)
check('id 唯一且非空', ids.every(Boolean) && new Set(ids).size === ids.length, ids)

for (const p of PARTS) {
  const tag = p.id || '(缺 id)'
  check(tag + '：名字 / 归属 / 入口不为空', !!(p.name && p.owner && p.entry), p)
  check(tag + '：角色在词表里', ROLES.includes(p.role), p.role)
  check(tag + '：链上 / 链外二选一', CHAINS.includes(p.chain), p.chain)
  check(tag + '：判准在词表里', JUDGES.includes(p.judge), p.judge)
  check(tag + '：状态在词表里', STATUSES.includes(p.status), p.status)
  check(tag + '：至少有一个文件', Array.isArray(p.files) && p.files.length > 0, p.files)
  for (const f of p.files || []) {
    check(tag + '：文件存在 ' + f, fs.existsSync(path.join(root, f)), f)
  }
  check(tag + '：exam 是对象', p.exam && typeof p.exam === 'object', p.exam)
  if (p.exam && p.exam.file) {
    check(tag + '：考卷存在 ' + p.exam.file, fs.existsSync(path.join(root, p.exam.file)), p.exam.file)
  }
  check(tag + '：rollback 是对象', p.rollback && typeof p.rollback === 'object', p.rollback)
  check(tag + '：swaps 是数组', Array.isArray(p.swaps), p.swaps)
  if (p.status === '可换') {
    check(tag + '：可换要三样齐（考卷）', !!(p.exam && p.exam.file), p.exam)
    check(tag + '：可换要三样齐（回退点）', !!(p.rollback && p.rollback.pointer), p.rollback)
  }
}

const copy = listParts()
copy[0].files.push('__不该进册子__')
copy[0].name = '改了副本'
check('listParts 返回副本，改不动册子', PARTS[0].name !== '改了副本' && !PARTS[0].files.includes('__不该进册子__'), PARTS[0].files)

console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exitCode = 1
