// client.js 冒烟：不靠浏览器，把 __ModuleLoader__ 的 factory 在 node 里真的跑一遍。
// 能抓到的：语法错误、模块顶层就崩、factory 返回的不是对象、require 了没声明的东西。
// 抓不到的：React 渲染结果对不对（那要真 DOM，留给后面接 jsdom 或 esbuild 时做）。
import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const src = fs.readFileSync(path.join(root, 'client.js'), 'utf8')

// 1) 把源码当脚本跑，拿到 load 的登记
let reg = null
const win = {
  __ModuleLoader__: {
    load(entry) { reg = entry },
  },
}
const noop = () => {}
const fakeEl = () => ({
  style: {}, setAttribute: noop, appendChild: noop, removeChild: noop,
  addEventListener: noop, removeEventListener: noop, classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
  getContext: () => null, getBoundingClientRect: () => ({ width: 0, height: 0, top: 0, left: 0 }),
  querySelector: () => null, querySelectorAll: () => [], children: [], childNodes: [], innerHTML: '', textContent: '',
})
const doc = {
  createElement: fakeEl, createElementNS: fakeEl, createTextNode: () => fakeEl(),
  head: fakeEl(), body: fakeEl(), documentElement: fakeEl(),
  querySelector: () => null, querySelectorAll: () => [],
  addEventListener: noop, removeEventListener: noop,
  getElementById: () => null,
}

const runner = new Function('window', 'document', 'navigator', 'location', 'self', 'globalThis', src)
runner(win, doc, { userAgent: 'node' }, { href: 'http://localhost/' }, win, globalThis)

assert.ok(reg, 'client.js 没有调用 __ModuleLoader__.load')
assert.equal(reg.id, 'dsh-consciousness-v6', '模块 id 不对')
assert.equal(typeof reg.factory, 'function', 'factory 不是函数')

// 2) 给 factory 一个最小的 require：react 用桩，其它一律返回 Proxy 桩
const req = (spec) => {
  if (spec === 'react') {
    const React = {
      createElement: (type, props, ...children) => ({ type, props, children }),
      Fragment: 'Fragment',
      useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
      useEffect: () => {}, useMemo: (f) => f(), useRef: (v) => ({ current: v }),
      useCallback: (f) => f, useReducer: (r, s) => [s, () => {}], useContext: () => ({}),
      createContext: (v) => ({ Provider: 'P', Consumer: 'C', _v: v }), memo: (x) => x, forwardRef: (x) => x,
    }
    return { default: React, ...React }
  }
  return new Proxy(function () {}, {
    get: (_t, k) => {
      if (k === 'then') return undefined
      if (k === Symbol.toPrimitive) return () => ''
      return new Proxy(function () {}, { get: () => () => {} })
    },
    apply: () => ({}),
  })
}

let exportsObj
try {
  exportsObj = reg.factory(req)
} catch (e) {
  assert.fail('factory 执行崩了：' + e.message)
}
assert.ok(exportsObj && typeof exportsObj === 'object', 'factory 没有返回 exports 对象')

console.log('PASS client.js 冒烟：load 契约 + factory 可执行，导出键 ' + Object.keys(exportsObj).length + ' 个')
