/**
 * 星图预览：把 PersonMap 真跑一遍，导出一个静态 HTML，方便在浏览器里看排版。
 * 用法：node scripts/map-preview.mjs  →  docs/relation-map.html
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
let src = fs.readFileSync(path.join(root, 'client.js'), 'utf8')
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

const now = Date.now()
const persons = [
  { id: 'p0', name: '主人', tier: 'owner', status: 'active', closeness: 0.99, trust: 0.83, dependence: 0.2, last_talk_at: new Date(now).toISOString() },
  { id: 'p1', name: '小周', tier: 'acquaintance', status: 'active', closeness: 0.55, trust: 0.6, dependence: 0.3, last_talk_at: new Date(now).toISOString() },
  { id: 'p2', name: '阿强', tier: 'acquaintance', status: 'active', closeness: 0.5, trust: 0.55, dependence: 0.28, last_talk_at: new Date(now).toISOString() },
  { id: 'p3', name: '老陈', tier: 'acquaintance', status: 'active', closeness: 0.5, trust: 0.5, dependence: 0.25, last_talk_at: new Date(now).toISOString() },
  { id: 'p4', name: '李雷', tier: 'acquaintance', status: 'active', closeness: 0.45, trust: 0.5, dependence: 0.2, last_talk_at: new Date(now).toISOString() },
  { id: 'p5', name: '王老师', tier: 'stranger', status: 'active', closeness: 0.25, trust: 0.2, dependence: 0.1 },
  { id: 'p6', name: '周哥', tier: 'stranger', status: 'active', closeness: 0.25, trust: 0.2, dependence: 0.1 },
  { id: 'p7', name: '小林', tier: 'stranger', status: 'active', closeness: 0.25, trust: 0.2, dependence: 0.1 },
  { id: 'p8', name: '阿念', tier: 'stranger', status: 'active', closeness: 0.25, trust: 0.2, dependence: 0.1 },
  { id: 'p9', name: '小赵', tier: 'stranger', status: 'active', closeness: 0.25, trust: 0.2, dependence: 0.1 },
  { id: 'p10', name: '老张', tier: 'stranger', status: 'active', closeness: 0.25, trust: 0.2, dependence: 0.1 },
  { id: 'p11', name: '韩梅梅', tier: 'stranger', status: 'active', closeness: 0.25, trust: 0.2, dependence: 0.1 },
  { id: 'p12', name: '小林同学', tier: 'stranger', status: 'active', closeness: 0.25, trust: 0.2, dependence: 0.1 },
  { id: 'p13', name: '端过滤', tier: 'stranger', status: 'active', closeness: 0.25, trust: 0.2, dependence: 0.1 },
  { id: 'p14', name: '已归档', tier: 'stranger', status: 'archived', closeness: 0.25, trust: 0.2, dependence: 0.1 },
]
const edges = {
  p1: [{ id: 'e1', kind: 'colleague', role_label: '同事', other: { id: 'p2', name: '阿强' } }],
  p2: [{ id: 'e1', kind: 'colleague', role_label: '同事', other: { id: 'p1', name: '小周' } },
    { id: 'e2', kind: 'relation', role_label: '朋友', other: { id: 'p3', name: '老陈' } }],
  p3: [{ id: 'e2', kind: 'relation', role_label: '朋友', other: { id: 'p2', name: '阿强' } }],
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

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const styleText = (o) => Object.entries(o).map(([k, v]) => k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()) + ':' + v).join(';')
const ATTR = {
  textAnchor: 'text-anchor', stopColor: 'stop-color', stopOpacity: 'stop-opacity',
  strokeWidth: 'stroke-width', strokeOpacity: 'stroke-opacity', strokeDasharray: 'stroke-dasharray',
  strokeLinecap: 'stroke-linecap', strokeLinejoin: 'stroke-linejoin', fillOpacity: 'fill-opacity',
  patternUnits: 'patternUnits', fontSize: 'font-size',
}
function toHtml(node) {
  if (node == null || node === false || node === true) return ''
  if (Array.isArray(node)) return node.map(toHtml).join('')
  if (typeof node !== 'object') return esc(node)
  const { type, props, children } = node
  if (typeof type === 'function') return toHtml(type(props || {}))
  const attrs = []
  let inner = ''
  for (const [k, v] of Object.entries(props || {})) {
    if (k === 'children' || k.startsWith('on') || v == null || typeof v === 'function') continue
    if (k === 'dangerouslySetInnerHTML') { inner = v.__html || ''; continue }
    if (k === 'style') { attrs.push('style="' + esc(styleText(v)) + '"'); continue }
    if (k === 'className') { attrs.push('class="' + esc(v) + '"'); continue }
    attrs.push((ATTR[k] || k) + '="' + esc(v) + '"')
  }
  return '<' + type + (attrs.length ? ' ' + attrs.join(' ') : '') + '>' + (inner || toHtml(children)) + '</' + type + '>'
}

const cssStart = src.indexOf('const CSS = `')
const css = src.slice(cssStart + 13, src.indexOf('`\n', cssStart + 14))
const html = '<!doctype html><meta charset="utf-8"><style>' + css + '</style>'
  + '<body style="margin:0;background:#17181c;color:#e8e8ea;font-family:system-ui,sans-serif">'
  + '<div class="dshc" style="padding:18px 20px;max-width:560px">'
  + toHtml(tree)
  + '</div></body>'
const out = path.join(root, 'docs', 'relation-map.html')
fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, html, 'utf8')
console.log('written', out)
