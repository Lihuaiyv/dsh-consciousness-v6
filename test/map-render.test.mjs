/**
 * 星图渲染冒烟：render-audit 走不到 PersonMap（数据是异步来的），这里单独喂假数据跑一遍，
 * 确认节点、名字、边都真的画出来，且没有运行时错误。
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
let src = fs.readFileSync(path.join(here, '..', 'client.js'), 'utf8')
src = src.replace(
  "    return {\n      inject: ['slots'],",
  "    return {\n      __test: { PersonMap },\n      inject: ['slots'],")
if (!src.includes('__test')) throw new Error('没找到注入点')

let slots = []
let cursor = 0
let dirty = false
let effects = []
function createElement(type, props, ...children) {
  return { type, props: props || {}, children: children.flat(Infinity).filter((c) => c != null && c !== false) }
}
const React = {
  createElement,
  useState(init) {
    const i = cursor++
    if (!(i in slots)) slots[i] = typeof init === 'function' ? init() : init
    return [slots[i], (v) => { slots[i] = typeof v === 'function' ? v(slots[i]) : v; dirty = true }]
  },
  useRef(v) { const i = cursor++; if (!(i in slots)) slots[i] = { current: v }; return slots[i] },
  useCallback(fn) { cursor++; return fn },
  useMemo(fn) { cursor++; return fn() },
  useEffect(fn) { cursor++; effects.push(fn) },
}

const persons = [
  { id: 'p0', name: '主人', tier: 'owner', status: 'active', closeness: 0.9, trust: 0.8, dependence: 0.2 },
  { id: 'p1', name: '小周', tier: 'acquaintance', status: 'active', closeness: 0.5, trust: 0.5, dependence: 0.3 },
  { id: 'p2', name: '端过滤', tier: 'stranger', status: 'active', closeness: 0.2, trust: 0.2, dependence: 0.1 },
  { id: 'p3', name: '小林同学', tier: 'stranger', status: 'active', closeness: 0.2, trust: 0.2, dependence: 0.1 },
  { id: 'p4', name: '已归档的人', tier: 'stranger', status: 'archived', closeness: 0.2, trust: 0.2, dependence: 0.1 },
]
const edges = {
  p0: [{ id: 'e1', kind: 'colleague', role_label: '同事', other: { id: 'p1', name: '小周' } }],
  p1: [{ id: 'e1', kind: 'colleague', role_label: '同事', other: { id: 'p0', name: '主人' } }],
  // 两个都不是主人：人-人边只该画这一次，反方向那条被去重
  p2: [{ id: 'e2', kind: 'friend', role_label: '朋友', other: { id: 'p3', name: '小林同学' } }],
  p3: [{ id: 'e2', kind: 'friend', role_label: '朋友', other: { id: 'p2', name: '端过滤' } }],
}
const fetchMock = async (url, opts) => {
  const body = JSON.parse(opts.body)
  let out = {}
  if (/\/persons$/.test(body.path)) out = persons
  else {
    const m = body.path.match(/\/persons\/([^/]+)$/)
    if (m) out = { person: persons.find((p) => p.id === m[1]), card: '', evidence: [], edges: edges[m[1]] || [] }
  }
  return { json: async () => out }
}

const document = {
  createElement: () => ({ appendChild() {}, style: {}, remove() {} }),
  head: { appendChild() {} }, body: { appendChild() {}, children: [] },
  addEventListener() {}, removeEventListener() {},
}
let captured = null
const sandbox = {
  window: {
    __ModuleLoader__: { load: (m) => { captured = m } },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    addEventListener() {}, removeEventListener() {}, confirm: () => false,
    innerWidth: 1280, innerHeight: 800, React,
  },
  document, fetch: fetchMock, console, setTimeout, clearTimeout, setInterval, clearInterval,
  Math, Date, JSON, Promise, Number, String, Array, Object, Error, Uint8Array, TextEncoder, TextDecoder,
  btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
  atob: (s) => Buffer.from(s, 'base64').toString('binary'),
}
sandbox.window.document = document
sandbox.globalThis = sandbox
vm.createContext(sandbox)
vm.runInContext(src, sandbox, { filename: 'client.js' })
const plugin = captured.factory((name) => {
  if (name === 'react') return React
  throw new Error('未知依赖 ' + name)
})

const PersonMap = plugin.__test.PersonMap
let tree = null
for (let round = 0; round < 12; round++) {
  cursor = 0
  dirty = false
  effects = []
  tree = PersonMap({ aid: 'agt_x', fallback: [], seed: 0 })
  for (const fn of effects) fn()
  await new Promise((r) => setTimeout(r, 5))
  if (!dirty) break
}

const flat = []
const walk = (node) => {
  if (node == null || typeof node !== 'object') return
  if (Array.isArray(node)) { node.forEach(walk); return }
  flat.push(node)
  walk(node.children)
}
walk(tree)

const nodes = flat.filter((n) => n.type === 'g' && n.props.className === 'node')
const labels = flat.filter((n) => n.type === 'text' && String(n.props.className || '').startsWith('lbl'))
const dots = flat.filter((n) => n.type === 'circle' && n.props.className === 'dot')
const edgesOut = flat.filter((n) => n.type === 'path' && String(n.props.key || '').startsWith('ed-'))
const spokes = flat.filter((n) => n.type === 'path' && String(n.props.key || '').startsWith('lk-'))

const problems = []
if (!flat.some((n) => n.type === 'svg')) problems.push('没有 svg')
if (nodes.length !== 4) problems.push('节点数 ' + nodes.length + '，应为 4（归档的人不该入图）')
if (dots.length !== 4) problems.push('圆点 ' + dots.length)
if (labels.length !== 4) problems.push('名字 ' + labels.length)
if (spokes.length !== 4) problems.push('中心连线 ' + spokes.length)
if (edgesOut.length !== 1) problems.push('人-人边 ' + edgesOut.length + '，应为 1（和主人的边走辐条，反方向那条去重）')
if (edgesOut.length === 1 && edgesOut[0].props.key !== 'ed-e2') problems.push('画出来的人-人边不对：' + edgesOut[0].props.key)
if (nodes.some((n) => !n.props['data-dim'] || n.props['data-dim'] !== '0')) problems.push('初始不应有暗掉的节点')
const names = labels.map((n) => n.children[0])
if (!names.includes('主人') || !names.includes('小周')) problems.push('名字不对：' + names.join(','))

if (problems.length) {
  console.log('FAIL 星图渲染：' + problems.join('；'))
  process.exit(1)
}
console.log('PASS 星图渲染：4 个节点 / 名字 / 连线都在，归档的人没入图')
