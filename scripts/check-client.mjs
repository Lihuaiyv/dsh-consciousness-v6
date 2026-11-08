// 客户端半的结构闸：client.js 不靠打包器也能查。
// 运行：node scripts/check-client.mjs
//
// 为什么单独做：client.js 是 window.__ModuleLoader__ 的 CJS-ish 工厂，不是 ESM，
// 没有打包器就拆不开文件。那就先把「它必须长成什么样」钉成机器可查的几条，
// 免得它继续胖下去还没人吭声（2026-11-08 是 698 KB）。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const file = path.join(root, 'client.js')
const BUDGET_KB = 760

let red = 0
const fail = (m) => { red++; console.log('FAIL ' + m) }
const ok = (m) => console.log('ok   ' + m)

if (!fs.existsSync(file)) { fail('client.js 不存在'); process.exit(1) }
const src = fs.readFileSync(file, 'utf8')
const kb = fs.statSync(file).size / 1024

// 1. 体积预算
if (kb > BUDGET_KB) fail(`client.js ${kb.toFixed(0)} KB，超过预算 ${BUDGET_KB} KB（拆分或先说明为什么）`)
else ok(`体积 ${kb.toFixed(0)} KB / 预算 ${BUDGET_KB} KB`)

// 2. 加载契约：必须走 __ModuleLoader__.load，id 固定
if (!/window\.__ModuleLoader__\.load\(\{/.test(src)) fail('没有走 window.__ModuleLoader__.load({...}) 契约')
else ok('加载契约 __ModuleLoader__.load')

if (!/id:\s*'dsh-consciousness-v6'/.test(src)) fail("load 的 id 不是 'dsh-consciousness-v6'")
else ok('模块 id 正确')

if (!/factory\s*\(\s*(?:require|[\w$]+)\s*\)/.test(src)) fail('factory 不接收 require')
else ok('factory 接收 require')

// 3. 必须依赖 react，且用 createElement（这个 loader 没有 JSX 编译）
if (!/require\(\s*'react'\s*\)/.test(src)) fail("没有 require('react')")
else ok("require('react')")

if (/\breturn\s*\(\s*<[A-Za-z]/.test(src)) fail('出现了 JSX 字面量（这个 loader 不编译 JSX）')
else ok('没有 JSX 字面量')

// 4. 危险写法
for (const [re, name] of [
  [/\beval\s*\(/, 'eval('],
  [/new\s+Function\s*\(/, 'new Function('],
  [/document\.write\s*\(/, 'document.write('],
]) {
  if (re.test(src)) fail('出现危险写法 ' + name)
}
if (!/\beval\s*\(/.test(src)) ok('无 eval / new Function / document.write')

// 5. 注册的入口数量（防止某次改动把整块 UI 悄悄删掉）
const sections = (src.match(/id:\s*'consciousness/g) || []).length
if (sections < 1) fail('找不到 consciousness 的注册入口')
else ok(`注册入口 ${sections} 个`)

// 6. 顶层不该有裸的 console.log 洪泛（允许 console.warn/error）
const logs = (src.match(/(?<!\.)\bconsole\.log\(/g) || []).length
if (logs > 5) fail(`console.log 有 ${logs} 处，UI 代码里留这么多会刷屏`)
else ok(`console.log ${logs} 处`)

console.log(red ? `\n客户端结构闸：${red} 条红` : '\n客户端结构闸：全绿')
if (red) process.exitCode = 1
