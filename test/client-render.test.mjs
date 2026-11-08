// client.js 的渲染冒烟：不装 React、不装 jsdom，用一套最小桩把组件真的执行一遍。
// 抓得到：组件调用即崩、注册契约漂了、页面骨架空掉。
// 抓不到：视觉对不对、useEffect 里的副作用（这里根本不跑 effect）。
import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const src = fs.readFileSync(path.join(root, 'client.js'), 'utf8')

/* ── 1. 桩 React ───────────────────────────────────────── */
let hookState = 0
const fakeFetch = () => Promise.resolve({ ok: true, json: async () => ({}) })
const React = {
  createElement: (type, props, ...children) => ({
    type,
    props: { ...(props || {}), children: children.length === 1 ? children[0] : children },
    children,
  }),
  Fragment: 'Fragment',
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
  useLayoutEffect: () => {},
  useMemo: (f) => f(),
  useRef: (v) => ({ current: v }),
  useCallback: (f) => f,
  useReducer: (r, s) => [s, () => {}],
  useContext: () => ({}),
  useId: () => 'id-' + ++hookState,
  useTransition: () => [false, (f) => f()],
  useDeferredValue: (v) => v,
  createContext: (v) => ({ Provider: 'Provider', Consumer: 'Consumer', _v: v }),
  memo: (x) => x,
  forwardRef: (x) => x,
}

/* ── 2. 加载插件 ───────────────────────────────────────── */
let plugin = null
const win = { __ModuleLoader__: { load: (e) => { plugin = e } } }
const el = () => ({
  style: {}, setAttribute() {}, appendChild() {}, addEventListener() {}, removeEventListener() {},
  classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
  getContext: () => null, getBoundingClientRect: () => ({ width: 0, height: 0, top: 0, left: 0 }),
  querySelector: () => null, querySelectorAll: () => [], children: [], innerHTML: '', textContent: '',
})
const doc = {
  createElement: el, createElementNS: el, createTextNode: el,
  head: el(), body: el(), documentElement: el(), getElementById: () => null,
  querySelector: () => null, querySelectorAll: () => [], addEventListener() {},
}
const g = {
  window: win, document: doc, navigator: { userAgent: 'node' },
  location: { href: 'http://localhost/', search: '' },
  fetch: fakeFetch,
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  setInterval: () => 0, clearInterval() {}, setTimeout: () => 0, clearTimeout() {},
  requestAnimationFrame: () => 0, cancelAnimationFrame() {},
}
// 源码用的是全局 window / document / fetch，注入到 globalThis。
// navigator 这类是 getter-only，用 defineProperty 覆盖，覆盖不了就算了（函数参数里已经有一份）。
for (const [k, v] of Object.entries(g)) {
  try { Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true }) } catch { /* 只读的就跳过 */ }
}

const runner = new Function('window', 'document', 'navigator', 'location', 'fetch', 'localStorage', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame', src)
runner(g.window, g.document, g.navigator, g.location, g.fetch, g.localStorage, g.setInterval, g.clearInterval, g.setTimeout, g.clearTimeout, g.requestAnimationFrame, g.cancelAnimationFrame)

assert.ok(plugin && plugin.factory, 'factory 没登记')
const req = (spec) => (spec === 'react' ? { default: React, ...React } : new Proxy({}, { get: () => () => {} }))
const mod = plugin.factory(req)
assert.equal(typeof mod.apply, 'function', '插件没有 apply(ctx)')
assert.deepEqual(mod.inject, ['slots'], 'inject 声明变了')

/* ── 3. 跑 apply，抓住注册 ─────────────────────────────── */
const registered = []
const ctx = {
  effect(fn) { try { fn() } catch { /* 热更新那类失败不算 */ } },
  slots: {
    inject(name, fn) { fn() },
    register(meta, Component) { registered.push({ meta, Component }); return () => {} },
  },
}
mod.apply(ctx)

const ids = registered.map((r) => r.meta.id)
assert.deepEqual(ids, ['consciousness', 'consciousness-presence', 'consciousness-voice-mic', 'consciousness-voice-bridge'], '注册的槽位变了：' + ids.join(','))

/* ── 4. 迷你渲染：把组件真的调一遍 ─────────────────────── */
let nodes = 0
const texts = []
function render(node, depth = 0) {
  if (node == null || typeof node === 'boolean') return
  if (typeof node === 'string' || typeof node === 'number') { nodes++; texts.push(String(node)); return }
  if (typeof node === 'object' && !node.type) {
    if (Array.isArray(node)) { node.forEach((n) => render(n, depth)); return }
    return
  }
  if (Array.isArray(node)) { node.forEach((n) => render(n, depth)); return }
  if (depth > 60) return
  const { type, props, children } = node
  if (type === 'Fragment') { render(children, depth + 1); return }
  nodes++
  if (typeof type === 'function') {
    // class 组件（比如 SectionBoundary 错误边界）不能用普通函数调用
    const isClass = (type.prototype && type.prototype.isReactComponent) || /^class\b/.test(Function.prototype.toString.call(type))
    try {
      if (isClass) {
        const inst = new type({ ...props, children })
        if (typeof inst.render === 'function') render(inst.render(), depth + 1)
        return
      }
      render(type({ ...props, children }), depth + 1)
    } catch (e) {
      throw new Error('组件崩了（' + (type.name || '匿名') + '）：' + e.message)
    }
    return
  }
  render(children, depth + 1)
}

for (const r of registered) {
  const t0 = nodes
  render(r.Component({}))
  const grew = nodes - t0
  assert.ok(grew > 0, r.meta.id + ' 渲染出来是空的')
  console.log(`PASS ${r.meta.id} 渲染了 ${grew} 个节点（label=${r.meta.label}）`)
}

assert.ok(nodes > 20, '总共只渲染出 ' + nodes + ' 个节点，页面骨架像被抽掉了')
const joined = texts.join(' ')
assert.ok(joined.length > 0, '一个文本节点都没有')
console.log(`PASS 组件可执行：${registered.length} 个槽位，${nodes} 个节点，${texts.length} 段文本`)
