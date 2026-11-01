// 用真实接口数据把 MemoryPage 渲染一遍（useState 可持久、effect 会跑、fetch 走真接口），
// 目的是在 Node 里复现「点记忆就白屏」的异常，拿到确切堆栈。
import fs from 'node:fs'
import vm from 'node:vm'

const BASE = process.env.DSHC_BASE || 'http://127.0.0.1:58664'
let SRC = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
SRC = SRC.replace(
  "    return {\n      inject: ['slots'],",
  "    return {\n      __test: { MemoryPage },\n      inject: ['slots'],")
if (!SRC.includes('__test')) throw new Error('没找到注入点')

const store = new Map()
let CURRENT = null
const effects = []

function slot(init) {
  const st = store.get(CURRENT) || { s: [], i: 0 }
  store.set(CURRENT, st)
  return st
}
const React = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }),
  useState: (init) => {
    const st = slot()
    const i = st.i++
    if (!(i in st.s)) st.s[i] = typeof init === 'function' ? init() : init
    const set = (v) => { st.s[i] = typeof v === 'function' ? v(st.s[i]) : v }
    return [st.s[i], set]
  },
  useRef: (v) => { const st = slot(); const i = st.i++; if (!(i in st.s)) st.s[i] = { current: v }; return st.s[i] },
  useCallback: (fn) => { const st = slot(); const i = st.i++; if (!(i in st.s)) st.s[i] = fn; return st.s[i] },
  useMemo: (fn) => { const st = slot(); const i = st.i++; if (!(i in st.s)) st.s[i] = fn(); return st.s[i] },
  useEffect: (fn) => { slot().i++; effects.push(fn) },
}
const document = {
  createElement: () => ({ style: {}, appendChild() {}, remove() {}, addEventListener() {}, removeEventListener() {}, classList: { add() {}, remove() {} }, setAttribute() {} }),
  addEventListener() {}, removeEventListener() {}, getElementById: () => null, querySelector: () => null,
  body: { appendChild() {}, removeChild() {} }, documentElement: { style: {} },
}
const sandbox = {
  window: {
    __ModuleLoader__: { load: (m) => { sandbox.__m = m } },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    addEventListener() {}, removeEventListener() {}, confirm: () => false, alert: () => {},
    innerWidth: 1280, innerHeight: 800, location: { href: BASE },
  },
  document,
  fetch: (url, opts) => fetch(BASE + url, opts),
  console, setTimeout, clearTimeout, setInterval, clearInterval,
  Math, Date, JSON, Promise, Number, String, Array, Object, Error, Map, Set,
  Uint8Array, TextEncoder, TextDecoder,
  btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
  atob: (s) => Buffer.from(s, 'base64').toString('binary'),
  createImageBitmap: async () => ({ width: 32, height: 32 }),
}
sandbox.window.document = document
sandbox.window.React = React
sandbox.globalThis = sandbox
vm.createContext(sandbox)
vm.runInContext(SRC, sandbox, { filename: 'client.js' })
const mod = sandbox.__m
if (!mod) throw new Error('模块没被加载')
const plugin = mod.factory((name) => { if (name === 'react') return React; throw new Error('未知依赖 ' + name) })
const T = plugin.__test

const errors = []
function walk(node, path) {
  if (node == null || typeof node !== 'object') return
  if (Array.isArray(node)) { node.forEach((c, i) => walk(c, path + '[' + i + ']')); return }
  const { type, props, children } = node
  if (typeof type === 'function') {
    const key = path + '/' + (type.name || 'Anon')
    const prev = CURRENT
    CURRENT = key
    let out
    try { out = type(props || {}) } catch (e) {
      errors.push(key + ' → ' + (e && e.stack || e))
      CURRENT = prev
      return
    }
    CURRENT = prev
    walk(out, key)
    const st = store.get(key)
    if (st) {
      const prevCount = st.last
      if (prevCount != null && prevCount !== st.i) {
        errors.push('hook 数量变化 → ' + key + '：上次 ' + prevCount + ' 个，这次 ' + st.i + ' 个（真实 React 会直接抛 Rendered fewer hooks）')
      }
      st.last = st.i
    }
    return
  }
  walk(children, path + '/' + type)
}

const aid = process.env.DSHC_AID || 'agt_3977d80f17'
const base = { aid, act: async (fn) => fn(), setTab() {}, focus: null, jump() {}, close() {}, reloadOv: async () => {} }

for (const view of ['user', 'tech']) {
  store.clear()
  for (let round = 0; round < 8; round++) {
    effects.length = 0
    let tree
    CURRENT = 'root'
    try { tree = T.MemoryPage({ ...base, view }) } catch (e) { errors.push('MemoryPage 调用 → ' + (e && e.stack || e)); break }
    CURRENT = null
    walk(tree, '')
    for (const fn of effects) { try { fn() } catch (e) { errors.push('effect → ' + (e && e.stack || e)) } }
    await new Promise((r) => setTimeout(r, 300))
  }
}

if (!errors.length) console.log('没有抛异常')
else { console.log('捕获到 ' + errors.length + ' 个异常：'); for (const e of errors.slice(0, 12)) console.log('\n---\n' + e) }
process.exit(0)
