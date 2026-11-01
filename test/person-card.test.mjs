/**
 * 人物卡渲染冒烟：点「改称呼」→ 输入框接住旧称呼 → 保存 → 真的打到 /rename。
 * 星图测试（map-render）走不到人物卡弹窗，这里单独喂假数据跑一遍。
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
let src = fs.readFileSync(path.join(here, '..', 'client.js'), 'utf8')
src = src.replace(
  "    return {\n      inject: ['slots'],",
  "    return {\n      __test: { PersonCardDialog },\n      inject: ['slots'],")
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

let current = {
  id: 'p1', name: '小小尼', tier: 'acquaintance', tier_label: '熟人', status: 'active',
  closeness: 0.25, trust: 0.4, dependence: 0.05, graph_visible: false,
  summary: '我兄弟小小尼姑', last_talk_at: null, version: 1, aliases: [],
}
const renameCalls = []
const fetchMock = async (url, opts) => {
  const body = JSON.parse(opts.body)
  const p = String(body.path || '')
  if (/\/rename$/.test(p)) {
    renameCalls.push(body)
    current = { ...current, name: body.body.name, aliases: [...(current.aliases || []), current.name] }
    return { json: async () => current }
  }
  if (/\/persons\/p1$/.test(p)) {
    return { json: async () => ({ person: current, card: current.name + '（熟人）\n我记得的就这些，可能不全。', evidence: [], edges: [] }) }
  }
  return { json: async () => ({}) }
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

const PersonCardDialog = plugin.__test.PersonCardDialog
const tick = () => new Promise((r) => setTimeout(r, 5))
const render = () => {
  cursor = 0
  dirty = false
  effects = []
  const tree = PersonCardDialog({ aid: 'agt_x', pid: 'p1', onClose() {}, onChanged() {} })
  for (const fn of effects) fn()
  return tree
}
const flatten = (node, out = []) => {
  if (node == null || typeof node !== 'object') return out
  if (Array.isArray(node)) { node.forEach((n) => flatten(n, out)); return out }
  out.push(node)
  flatten(node.children, out)
  return out
}
const byText = (tree, text) => flatten(tree).find((n) => typeof (n.props && n.props.onClick) === 'function'
  && n.children.some((c) => c === text))
const byPlaceholder = (tree, ph) => flatten(tree).find((n) => n.props && n.props.placeholder === ph)

const problems = []
let tree = null
// 数据是异步来的：多跑几轮，等到人物卡真的画出来
for (let round = 0; round < 20; round++) {
  tree = render()
  await tick()
  if (byText(tree, '改称呼')) break
}
if (!byText(tree, '改称呼')) problems.push('人物卡上没有「改称呼」按钮')
if (!flatten(tree).some((n) => n.children && n.children[0] === '小小尼')) problems.push('名字没画出来')

// 点「改称呼」：按钮换成输入框，里面是现在的称呼
const edit = byText(tree, '改称呼')
if (edit) {
  edit.props.onClick({ stopPropagation() {} })
  tree = render()
  await tick()
  const input = byPlaceholder(tree, '这人叫什么')
  if (!input) problems.push('点了「改称呼」没出现输入框')
  else if (input.props.value !== '小小尼') problems.push('输入框里不是现在的称呼：' + input.props.value)
  else {
    input.props.onChange({ target: { value: '小小尼姑' } })
    tree = render()
    await tick()
    const save = byText(tree, '保存')
    if (!save) problems.push('编辑态没有「保存」按钮')
    else {
      save.props.onClick({ stopPropagation() {} })
      await tick()
      for (let i = 0; i < 8; i++) { tree = render(); await tick() }
      const call = renameCalls[0]
      if (!renameCalls.length) problems.push('保存没有打到 /rename')
      else if (call.path !== '/v1/persons/p1/rename' || call.body.name !== '小小尼姑') problems.push('请求不对：' + JSON.stringify(call))
      const texts = flatten(tree).map((n) => (n.children && n.children.length === 1 ? n.children[0] : null)).filter((x) => typeof x === 'string')
      if (!texts.includes('小小尼姑')) problems.push('改完名字没跟着刷新：' + texts.slice(0, 12).join('|'))
    }
  }
}

if (problems.length) {
  console.log('FAIL 人物卡改称呼：' + problems.join('；'))
  process.exit(1)
}
console.log('PASS 人物卡改称呼：按钮 / 输入框 / 保存请求 / 刷新都对')
