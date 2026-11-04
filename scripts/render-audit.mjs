/**
 * 页面渲染冒烟：用假的 React 把 client.js 里的页面组件真跑一遍，
 * 抓「渲染时某个变量没定义」这类会让整页白屏的错误。
 *
 * 用法：node dsh-plugin/scripts/render-audit.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const file = path.join(here, '..', 'client.js')
let src = fs.readFileSync(file, 'utf8')

// 只在测试时把内部组件暴露出来，不改生产代码
src = src.replace(
  "    return {\n      inject: ['slots'],",
  "    return {\n      __test: { Page, Detail, Roster, OverviewPage, CharacterCard, MemoryPage, PersonaPage, RelationPage, AffectPage, DrivePage, SelfPage, SettingsPage, MetricsPage, AlgoBindingsPanel, MemoryImportDialog, MemorySettingsCard, ParamRow, FoldBlock, SettingJump, KnobCard, DriveBaselineCard, SETTING_KNOBS, PARAM_TAB_GROUPS, PARAM_META, SelfProposalCard, SelfAutoGroup, SelfIdeaRow, SelfChangeRow, SelfFinishedRow, prefSense, PrefRow },\n      inject: ['slots'],")
if (!src.includes('__test')) throw new Error('没找到可注入的返回点，client.js 结构变了')

const errors = []

function createElement(type, props, ...children) {
  return { type, props: props || {}, children: children.flat(Infinity).filter((c) => c != null && c !== false && c !== true) }
}

const React = {
  createElement,
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useRef: (v) => ({ current: v }),
  useCallback: (fn) => fn,
  useEffect: () => {},
  useMemo: (fn) => fn(),
}

/** 够用的假 DOM：头像浮窗是直接操作 DOM 的，得能验证它真的挂上又真的收走 */
class FakeEl {
  constructor(tag) {
    this.tagName = String(tag || '').toUpperCase()
    this.children = []
    this.parentNode = null
    this.style = {}
    this.dataset = {}
    this.listeners = {}
    this.id = ''
    this.className = ''
    this.textContent = ''
    this.files = []
  }
  appendChild(el) { el.parentNode = this; this.children.push(el); return el }
  removeChild(el) {
    const i = this.children.indexOf(el)
    if (i >= 0) this.children.splice(i, 1)
    el.parentNode = null
    return el
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this) }
  contains(el) {
    if (!el) return false
    if (el === this) return true
    return this.children.some((c) => c.contains && c.contains(el))
  }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn) }
  removeEventListener(type, fn) {
    const list = this.listeners[type] || []
    const i = list.indexOf(fn)
    if (i >= 0) list.splice(i, 1)
  }
  dispatch(type, ev = {}) {
    const e = { target: this, currentTarget: this, stopPropagation() {}, preventDefault() {}, ...ev }
    for (const fn of [...(this.listeners[type] || [])]) fn(e)
  }
  getBoundingClientRect() { return { left: 120, top: 40, right: 184, bottom: 104, width: 64, height: 64 } }
  click() { this.dispatch('click') }
  getContext() { return { drawImage() {} } }
  toDataURL() { return 'data:image/webp;base64,x' }
}

const docListeners = {}
const document = {
  createElement: (tag) => new FakeEl(tag),
  getElementById: (id) => document.body.children.find((c) => c.id === id) || null,
  head: new FakeEl('head'),
  body: new FakeEl('body'),
  documentElement: new FakeEl('html'),
  addEventListener(type, fn) { (docListeners[type] ||= []).push(fn) },
  removeEventListener(type, fn) {
    const list = docListeners[type] || []
    const i = list.indexOf(fn)
    if (i >= 0) list.splice(i, 1)
  },
}
document.head.appendChild = document.body.appendChild.bind(document.body)

const fireDoc = (type, ev) => { for (const fn of [...(docListeners[type] || [])]) fn(ev) }

let captured = null
const sandbox = {
  window: {
    __ModuleLoader__: { load: (m) => { captured = m } },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    addEventListener() {}, removeEventListener() {},
    confirm: () => false,
    alert: () => {},
    innerWidth: 1280, innerHeight: 800,
  },
  document,
  fetch: async () => ({ json: async () => ({}) }),
  console,
  setTimeout, clearTimeout, setInterval, clearInterval,
  Math, Date, JSON, Promise, Number, String, Array, Object, Error,
  Uint8Array, TextEncoder, TextDecoder,
  btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
  atob: (s) => Buffer.from(s, 'base64').toString('binary'),
  createImageBitmap: async () => ({ width: 32, height: 32 }),
}
sandbox.window.document = document
sandbox.window.React = React
sandbox.globalThis = sandbox

vm.createContext(sandbox)
vm.runInContext(src, sandbox, { filename: 'client.js' })
if (!captured) throw new Error('模块没被加载')

const plugin = captured.factory((name) => {
  if (name === 'react') return React
  throw new Error('未知依赖 ' + name)
})
const T = plugin.__test

function walk(node, pathStr) {
  if (node == null || typeof node !== 'object') return
  if (Array.isArray(node)) { node.forEach((c, i) => walk(c, pathStr + '[' + i + ']')); return }
  const { type, props, children } = node
  if (typeof type === 'function') {
    let out
    try {
      out = type(props || {})
    } catch (e) {
      errors.push(pathStr + ' → ' + (type.name || 'Anonymous') + ': ' + (e && e.stack || e))
      return
    }
    walk(out, pathStr + '/' + (type.name || 'Anonymous'))
    return
  }
  walk(children, pathStr + '/' + type)
}

const agent = {
  id: 'agt_test', name: '测试体', status: 'active', mode: 'work',
  created_at: new Date(Date.now() - 3 * 86400000).toISOString(),
  last_interaction_at: new Date(Date.now() - 3600000).toISOString(),
}
const overview = {
  status: 'good', alerts: [], recent: { last_interaction: new Date(Date.now() - 3600000).toISOString(), last_memory: { type: 'fact', text: '一句记忆' } },
  affect: { label: 'calm' }, memory_count: 12, inbox: { todo: 1, change: 0 },
  conflicts_open: 0, unread: 0, warn: [], drive: { D: 0.4, tokens: { c1: 1, c2: 1, c3: 1, c4: 1 } },
  mode: 'work', agents_running: true,
}

const cases = []
const common = {
  aid: agent.id, act: async (fn) => fn(), close() {}, agent, agents: [agent],
  setTab() {}, focus: null, jump() {}, reloadOv: async () => {}, reloadAgents: async () => {},
}
for (const view of ['user', 'tech']) {
  for (const [name, Comp] of [
    ['Overview', T.OverviewPage],
    ['Memory', T.MemoryPage],
    ['Persona', T.PersonaPage],
    ['Relation', T.RelationPage],
    ['Affect', T.AffectPage],
    ['Drive', T.DrivePage],
    ['Self', T.SelfPage],
    ['Settings', T.SettingsPage],
    ['Metrics', T.MetricsPage],
  ]) {
    cases.push([name + '/' + view, () => Comp({ ...common, view, tab: name.toLowerCase() })])
  }
  cases.push(['Detail/' + view, () => T.Detail({
    agent, pending: null, setAid() {}, act: async (fn) => fn(), close() {}, reloadAgents: async () => {},
  })])
}
cases.push(['AlgoBindingsPanel/user', () => T.AlgoBindingsPanel({ aid: agent.id, act: async (fn) => fn(), view: 'user' })])
cases.push(['AlgoBindingsPanel/tech', () => T.AlgoBindingsPanel({ aid: agent.id, act: async (fn) => fn(), view: 'tech' })])
cases.push(['MemoryImportDialog', () => T.MemoryImportDialog({ aid: agent.id, onClose() {}, onImported() {} })])
const memParams = [
  { key: 'memory.decay.lambda', value: 0.02, level: 'C4' },
  { key: 'memory.recall.floor', value: 0, level: 'C4' },
  { key: 'memory.inject.budget', value: 800, level: 'C4' },
  { key: 'memory.auto', value: true, level: 'C4' },
]
cases.push(['MemorySettingsCard', () => T.MemorySettingsCard({ aid: agent.id, act: async (fn) => fn(), params: memParams })])
cases.push(['Roster', () => T.Roster({ agents: [agent], loading: false, error: '', reload: async () => {}, setAid() {}, act: async (fn) => fn() })])
cases.push(['CharacterCard', () => T.CharacterCard({
  a: agent, ov: overview, featured: true, onOpen() {}, onExport() {}, onDelete() {}, onPickAvatar() {},
})])
cases.push(['CharacterCard-actions', () => T.CharacterCard({
  a: agent, ov: overview, featured: true, actions: [createElement('button', null, 'x')],
})])
cases.push(['CharacterCard-no-actions', () => T.CharacterCard({
  a: agent, ov: overview, featured: true, actions: [],
})])
cases.push(['CharacterCard-foot-actions', () => T.CharacterCard({
  a: agent, ov: overview, featured: true, actionsAlign: 'end',
  actions: [createElement('button', null, '去对话'), createElement('button', null, '关掉')],
})])

/* ---- 自修改页：用真实形状的数据把四块都渲染一遍 ---- */
const iso = (hAgo) => new Date(Date.now() - hAgo * 3600000).toISOString()
const propShadow = {
  id: 'prp_1', change_class: 'C3', state: 'shadowed', field: 'affect.mapping', target: 'appraise.version',
  before: '"v1"', after: '"v1b"', deficit: 'D2', risk: '规则行为，单字段可回退', rollback_plan: '按 changes.before 回退',
  shadow_done: 12, shadow_total: 20, shadow_hit: 0.77, gate_trace: '[]', created_at: iso(2),
}
const propReady = { ...propShadow, id: 'prp_2', state: 'shadowed', shadow_done: 20 }
const propDraft = {
  id: 'prp_3', change_class: 'C2', state: 'draft', field: 'taxonomy.labels', target: 'taxonomy.labels',
  before: '[]', after: '{}', deficit: 'D2', created_at: iso(30), shadow_total: 0, shadow_done: 0,
  gate_trace: JSON.stringify([{ source: 'user-utterance', samples: 19, texts: ['这句我有点难受，又说不上来', '我也说不好'] }]),
}
const runNoop = async () => {}
const cardCommon = { run: runNoop, act: async (fn) => fn(), shadowAll: async () => {}, tick: 0 }
cases.push(['SelfProposalCard/影子中', () => T.SelfProposalCard({ ...cardCommon, p: propShadow })])
cases.push(['SelfProposalCard/跑满可批', () => T.SelfProposalCard({ ...cardCommon, p: propReady })])
cases.push(['SelfProposalCard/草案带证据', () => T.SelfProposalCard({ ...cardCommon, p: propDraft })])
cases.push(['SelfFinishedRow', () => T.SelfFinishedRow({ p: { ...propShadow, state: 'rejected', shadow_done: 0 } })])
const relItems = [
  { id: 'c1', field: 'relations.主人', before: '{"closeness":0.99,"trust":0.805,"why":"但是刚刚显示的好像是0.6，没更新吗？"}', after: '{"closeness":0.99,"trust":0.810}', applied_at: iso(1), source: 'auto' },
  { id: 'c2', field: 'relations.主人', before: '{"closeness":0.98,"trust":0.800,"why":"好，新建，放到驱力后面。"}', after: '{"closeness":0.99,"trust":0.805}', applied_at: iso(3), source: 'auto' },
  { id: 'c3', field: 'relations.主人', before: '{"closeness":0.98,"trust":0.795,"why":"你觉得换新建还是不新建比较好？"}', after: '{"closeness":0.98,"trust":0.800}', applied_at: iso(5), source: 'auto' },
]
cases.push(['SelfAutoGroup/关系', () => T.SelfAutoGroup({ g: { key: 'relation:主人', kind: 'relation', name: '主人', field: 'relations.主人', items: relItems } })])
cases.push(['SelfAutoGroup/性格', () => T.SelfAutoGroup({
  g: {
    key: 'persona:persona.axis.ei', kind: 'persona', name: '', field: 'persona.axis.ei',
    items: [{ id: 'c4', field: 'persona.axis.ei', before: '0.6', after: '0.598', applied_at: iso(9), source: 'auto', rolled_back_at: 'shrink' }],
  },
})])
cases.push(['SelfAutoGroup/清理', () => T.SelfAutoGroup({
  g: {
    key: 'cleanup', kind: 'cleanup', name: '', field: 'memory.cleanup.runtime_noise',
    items: [{ id: 'c5', field: 'memory.cleanup.runtime_noise', before: '8', after: '0', applied_at: iso(40), source: 'auto' }],
  },
})])
cases.push(['SelfIdeaRow/19-20', () => T.SelfIdeaRow({
  t: { id: 'appraise.version', label: '情绪评价算法版本', class: 'C3', progress: 19, threshold: 20, windowDays: 14, cooldownDays: 90, lastDraftAt: null },
  draftsList: [],
})])
cases.push(['SelfIdeaRow/0-10', () => T.SelfIdeaRow({
  t: { id: 'taxonomy.labels', label: '情绪分类表', class: 'C2', progress: 0, threshold: 10, windowDays: 7, cooldownDays: 30, lastDraftAt: null },
  draftsList: [],
})])
cases.push(['SelfChangeRow/人工', () => T.SelfChangeRow({
  c: { id: 'chg_1', field: 'memory.recall.floor', before: '0', after: '0.5', applied_at: iso(2), source: 'manual' },
  run: async () => {}, act: async (fn) => fn(),
})])
cases.push(['SelfChangeRow/性格未回滚', () => T.SelfChangeRow({
  c: { id: 'chg_2', field: 'persona.axis.ei', before: '0.6', after: '0.598', applied_at: iso(9), source: 'auto', rolled_back_at: 'shrink' },
  run: async () => {}, act: async (fn) => fn(),
})])

/* ---- 自修改页：四块顺序 + 人话文案是真的读数据 ---- */
const selfTree = T.SelfPage({ ...common, view: 'user', tab: 'self' })
walk(selfTree, 'SelfPage/order')
const selfText = renderTexts(selfTree).join('|')
const wantOrder = ['收件箱', '它攒了多少想法', '变更记录']
const orderIdx = wantOrder.map((s) => selfText.indexOf(s))
if (!orderIdx.every((v, i) => v >= 0 && (i === 0 || v > orderIdx[i - 1]))) {
  errors.push('自修改页顺序不对：' + wantOrder.map((s, i) => s + '@' + orderIdx[i]).join(' '))
}
if (!selfText.includes('现在没有要你点头的事')) errors.push('自修改页空状态没写清楚')
if (!selfText.includes('收件箱是空的')) errors.push('自修改页空状态缺提示')
if (!/它顺手改的小事|它的变化/.test(selfText)) errors.push('自修改页缺自动变更区块')
const heroOk = selfText.startsWith('收件箱') && selfText.includes('现在没有要你点头的事') && ['等你批', '影子中', '已生效'].every((k) => selfText.includes(k))
if (!heroOk) errors.push('顶部摘要没排在最前或缺指标')
console.log((heroOk ? 'ok   ' : 'FAIL ') + '顶部摘要：一句话 + 四个数')
console.log((orderIdx.every((v, i) => v >= 0 && (i === 0 || v > orderIdx[i - 1])) ? 'ok   ' : 'FAIL ') + '自修改页四块顺序')

const shadowText = renderTexts(T.SelfProposalCard({ ...cardCommon, p: propShadow })).join('|')
const shadowOk = shadowText.includes('影子跑了 12/20 轮') && shadowText.includes('再跑 8 轮') && shadowText.includes('当时缺口 D2')
const headOk = shadowText.includes('把「情绪评价算法」从 v1 换成 v1b')
if (!headOk) errors.push('提案卡没有一句「改什么」：' + shadowText.slice(0, 160))
console.log((headOk ? 'ok   ' : 'FAIL ') + '提案卡：一句说清改什么')
if (!shadowOk) errors.push('提案卡没把影子进度/缺口说清楚：' + shadowText.slice(0, 200))
console.log((shadowOk ? 'ok   ' : 'FAIL ') + '提案卡：影子进度 + 缺口')

const readyText = renderTexts(T.SelfProposalCard({ ...cardCommon, p: propReady })).join('|')
const readyOk = readyText.includes('现在就等你点头') && readyText.includes('批准')
if (!readyOk) errors.push('跑满影子的提案没有出现「批准」')
console.log((readyOk ? 'ok   ' : 'FAIL ') + '提案卡：跑满给批准')

const draftText = renderTexts(T.SelfProposalCard({ ...cardCommon, p: propDraft })).join('|')
const draftOk = draftText.includes('它的依据（19 条') && draftText.includes('有点难受')
if (!draftOk) errors.push('草案卡没显示证据原文：' + draftText.slice(0, 200))
console.log((draftOk ? 'ok   ' : 'FAIL ') + '提案卡：证据原文')

const relText = renderTexts(T.SelfAutoGroup({ g: { key: 'relation:主人', kind: 'relation', name: '主人', field: 'relations.主人', items: relItems } })).join('|')
const relOk = relText.includes('往前挪了 3 次') && relText.includes('因为这句话') && relText.includes('没更新吗')
if (!relOk) errors.push('关系自动变更没写成人话/没带触发原话：' + relText.slice(0, 220))
console.log((relOk ? 'ok   ' : 'FAIL ') + '自动变更：关系人话 + 依据')

const personaText = renderTexts(T.SelfAutoGroup({
  g: {
    key: 'persona:persona.axis.ei', kind: 'persona', name: '', field: 'persona.axis.ei',
    items: [{ id: 'c4', field: 'persona.axis.ei', before: '0.6', after: '0.598', applied_at: iso(9), source: 'auto', rolled_back_at: 'shrink' }],
  },
})).join('|')
const personaOk = personaText.includes('它标的原因') && personaText.includes('往中间收窄一点') && !personaText.includes('已回滚')
if (!personaOk) errors.push('性格变更把原因误当成「已回滚」：' + personaText.slice(0, 200))
console.log((personaOk ? 'ok   ' : 'FAIL ') + '自动变更：原因不当成回滚')

const ideaText = renderTexts(T.SelfIdeaRow({
  t: { id: 'appraise.version', label: '情绪评价算法版本', class: 'C3', progress: 19, threshold: 20, windowDays: 14, cooldownDays: 90, lastDraftAt: null },
  draftsList: [],
})).join('|')
const ideaOk = ideaText.includes('还差 1 条证据') && ideaText.includes('改动等级') && ideaText.includes('C3 · 规则')
if (!ideaOk) errors.push('想法行没写清「想到哪了 / 等级」：' + ideaText.slice(0, 200))
console.log((ideaOk ? 'ok   ' : 'FAIL ') + '想法行：进度 + 等级')

const changeText = renderTexts(T.SelfChangeRow({
  c: { id: 'chg_2', field: 'persona.axis.ei', before: '0.6', after: '0.598', applied_at: iso(9), source: 'auto', rolled_back_at: 'shrink' },
  run: async () => {}, act: async (fn) => fn(),
})).join('|')
const changeOk = changeText.includes('外向度') && !changeText.includes('已回滚')
if (!changeOk) errors.push('变更记录里性格原因被当成回滚：' + changeText.slice(0, 160))
console.log((changeOk ? 'ok   ' : 'FAIL ') + '变更记录：字段名说人话 + 不误标回滚')

for (const [name, run] of cases) {
  const before = errors.length
  try { walk(run(), name) } catch (e) { errors.push(name + ' 顶层: ' + (e && e.stack || e)) }
  console.log((errors.length === before ? 'ok   ' : 'FAIL ') + name)
}

/* ---- 角色卡：整卡导出不能被悄悄摘掉 ---- */
function texts(node, out = []) {
  if (node == null || typeof node === 'boolean') return out
  if (Array.isArray(node)) { for (const c of node) texts(c, out); return out }
  if (typeof node !== 'object') { out.push(String(node)); return out }
  for (const c of node.children || []) texts(c, out)
  return out
}
const withExport = texts(T.CharacterCard({
  a: agent, ov: overview, featured: true, onOpen() {}, onExport() {}, onDelete() {},
})).join('|')
const noExport = texts(T.CharacterCard({
  a: agent, ov: overview, featured: true, onOpen() {}, onDelete() {},
})).join('|')
if (!withExport.includes('整体导出')) errors.push('角色卡: 传了 onExport 却没渲染「整体导出」按钮')
if (noExport.includes('整体导出')) errors.push('角色卡: 没传 onExport 却渲染了「整体导出」按钮')
console.log((errors.some((e) => e.startsWith('角色卡:')) ? 'FAIL ' : 'ok   ') + '角色卡整体导出按钮')

/* ---- 导入记忆面板：跟「导入意识」同一套两栏（左规范 / 右随意）---- */
const dlgText = texts(T.MemoryImportDialog({ aid: agent.id, onClose() {}, onImported() {} })).join('|')
const dlgWant = ['导入记忆', '规范导入', '随意导入', '把 zip 拖到这里', '选择文件', '整理并导入']
const dlgMissing = dlgWant.filter((s) => !dlgText.includes(s))
if (dlgMissing.length) errors.push('导入记忆面板缺：' + dlgMissing.join('、'))
console.log((dlgMissing.length ? 'FAIL ' : 'ok   ') + '导入记忆面板两栏齐全')

/* ---- 记忆设置：四个旋钮都在，且默认值读的是参数而不是写死 ---- */
// Row 把 label 放在 props 里，texts() 只看 children；这里先把函数组件展开再取文字
function renderTexts(node, out = []) {
  if (node == null || typeof node === 'boolean') return out
  if (Array.isArray(node)) { for (const c of node) renderTexts(c, out); return out }
  if (typeof node !== 'object') { out.push(String(node)); return out }
  if (typeof node.type === 'function') return renderTexts(node.type({ ...node.props, children: node.children }), out)
  for (const c of node.children || []) renderTexts(c, out)
  return out
}
const setText = renderTexts(T.MemorySettingsCard({ aid: agent.id, act: async (fn) => fn(), params: memParams })).join('|')
const setWant = ['衰减速度', '遗忘阈值', '自动记忆', '每轮注入预算', '保存', '恢复默认', '0.020', '不设门槛', '800 token', '只管「长期 · 抽屉」', '0 = 现在这样', '不会删', '聊完它自己记', '带进对话的记忆越多']
const setMissing = setWant.filter((s) => !setText.includes(s))
if (setMissing.length) errors.push('记忆设置缺：' + setMissing.join('、'))
console.log((setMissing.length ? 'FAIL ' : 'ok   ') + '记忆设置四个旋钮')

/* ---- 阈值 > 0 时要算出「约 N 天后想不起来」（0.3 / 0.02 → 21 天）---- */
const setOnText = renderTexts(T.MemorySettingsCard({
  aid: agent.id, act: async (fn) => fn(),
  params: memParams.map((p) => (p.key === 'memory.recall.floor' ? { ...p, value: 0.3 } : p)),
})).join('|')
const daysOk = setOnText.includes('聊天里就不提了') && setOnText.includes('21 天')
if (!daysOk) errors.push('记忆设置没算出天数：' + setOnText.slice(0, 120))
console.log((daysOk ? 'ok   ' : 'FAIL ') + '记忆设置天数提示')

/* ---- 设置页：按页头标签分组，其他放最后 ---- */
const popErrors = []
const ok = (cond, msg) => { if (!cond) popErrors.push(msg) }
try {
  const tree = T.SettingsPage({ aid: agent.id, view: 'user', act: async (fn) => fn(), agent, reloadAgents: async () => {} })
  walk(tree, 'SettingsPage+avatar')
  const pageText = renderTexts(tree).join('|')
  ok(pageText.includes('记忆设置'), '设置页看不到「记忆设置」标题')
  const setOrder = ['设置按页头标签走', '记忆设置', '鱼格设置', '情绪设置', '驱力设置', '页头 · 其他', '它长什么样', '学习与自动执行', '主动开口', '安全边界', '真实行动', '行动日志', '测试标准', '人文社科依据', '模型接入']
  const idx = setOrder.map((s) => pageText.indexOf(s))
  ok(idx.every((v, i) => v >= 0 && (i === 0 || v > idx[i - 1])),
    '设置页分组顺序不对：' + setOrder.map((s, i) => s + '@' + idx[i]).join(' '))
  ok(['记忆', '鱼格', '情绪', '驱力', '其他'].every((t) => pageText.includes('页头 · ' + t)),
    '设置页分组没标对应页头标签')
  ok(!pageText.includes('条件系数') && !pageText.includes('存一个版本') && !pageText.includes('每日打扰'),
    '用户视图不该出现技术参数/预算/规则版本')
  const knobWords = ['学习速率', 'MBTI 效应', '情绪衰减', '这五条基线不是调出来的']
  const knobMissing = knobWords.filter((s) => !pageText.includes(s))
  ok(knobMissing.length === 0, '设置页缺少分组旋钮：' + knobMissing.join('、'))
  ok(!pageText.includes('驱力耦合') && !pageText.includes('平时想待在什么水平'), '驱力设置不该再出现手调设定点旋钮')

  const techTree = T.SettingsPage({ aid: agent.id, view: 'tech', act: async (fn) => fn(), agent, reloadAgents: async () => {} })
  walk(techTree, 'SettingsPage/tech')
  const techText = renderTexts(techTree).join('|')
  const techWant = ['其他参数', '预算', '冷却', '规则版本', '算法版本与灰度', '备份恢复演练', '技术视图说明']
  const techMissing = techWant.filter((s) => !techText.includes(s))
  ok(techMissing.length === 0, '技术视图设置页缺：' + techMissing.join('、'))
} catch (e) {
  ok(false, '设置页渲染失败: ' + (e && e.message))
}

for (const e of popErrors) errors.push('设置页: ' + e)
console.log((popErrors.length ? 'FAIL ' : 'ok   ') + '设置页分组排版')

/* ---- 设置页参数行：数字 / 布尔 / 枚举 / 字符串 / 只读都能渲染 ---- */
const paramCases = [
  ['number', { key: 'persona.learn_rate', value: 0.05, level: 'C4' }, '学习速率', '修改'],
  ['bool', { key: 'memory.auto', value: true, level: 'C4' }, '自动记忆', '修改'],
  ['enum', { key: 'persona.axes.mode', value: 'shadow', level: 'C4' }, 'MBTI 效应', '开'],
  ['text', { key: 'affect.mapping', value: 'v1', level: 'C3' }, '情绪映射', '发起提案'],
  ['readonly', { key: 'guard.budget.c3', value: 2, level: 'C0' }, 'C3 令牌上限', '只读'],
]
for (const [name, p, wantLabel, wantText] of paramCases) {
  try {
    const tree = T.ParamRow({ p, view: 'tech', onDraft() {}, onSave: async () => ({ ok: true, text: 'ok' }) })
    walk(tree, 'ParamRow/' + name)
    const rowEl = (tree.children || []).find((c) => c && c.props && c.props.label != null)
    const gotLabel = rowEl ? rowEl.props.label : ''
    const t = renderTexts(tree).join('|')
    const bad = []
    if (gotLabel !== wantLabel) bad.push('中文名=' + JSON.stringify(gotLabel))
    if (!t.includes(wantText)) bad.push('缺「' + wantText + '」')
    if (bad.length) errors.push('ParamRow/' + name + '：' + bad.join('，'))
    console.log((bad.length ? 'FAIL ' : 'ok   ') + 'ParamRow/' + name)
  } catch (e) {
    errors.push('ParamRow/' + name + ' 渲染失败: ' + (e && e.message))
    console.log('FAIL ParamRow/' + name)
  }
}
const jumpText = renderTexts(T.SettingJump({ items: [['memory', '记忆'], ['other', '其他']] })).join('|')
const jumpOk = jumpText.includes('记忆') && jumpText.includes('其他')
if (!jumpOk) errors.push('设置页分组跳转没渲染')
console.log((jumpOk ? 'ok   ' : 'FAIL ') + '设置页分组跳转')

/* ---- 两组旋钮：和记忆设置同一套排版（滑杆 / 三段按钮 / 说明 / 保存）---- */
const knobCases = [
  ['persona', T.SETTING_KNOBS.persona, ['学习速率', 'MBTI 效应', '只算不用', '0.050', '保存', '恢复默认']],
  ['affect', T.SETTING_KNOBS.affect, ['情绪衰减', '0.40', '保存', '恢复默认']],
]
for (const [name, specs, want] of knobCases) {
  try {
    const tree = T.KnobCard({ aid: agent.id, act: async (fn) => fn(), params: [], specs })
    walk(tree, 'KnobCard/' + name)
    const t = renderTexts(tree).join('|')
    const missing = want.filter((s) => !t.includes(s))
    if (missing.length) errors.push('KnobCard/' + name + ' 缺：' + missing.join('、'))
    console.log((missing.length ? 'FAIL ' : 'ok   ') + 'KnobCard/' + name)
  } catch (e) {
    errors.push('KnobCard/' + name + ' 渲染失败: ' + (e && e.message))
    console.log('FAIL KnobCard/' + name)
  }
}

/* ---- 驱力设置：只读的「自己长」基线（五条都在，且没有保存/恢复默认）---- */
try {
  const tree = T.DriveBaselineCard({ aid: agent.id, act: async (fn) => fn() })
  walk(tree, 'DriveBaselineCard')
  const t = renderTexts(tree).join('|')
  const want = ['这五条基线不是调出来的', '依恋', '探索', '胜任', '自主', '安全', '每天最多挪 0.02']
  const missing = want.filter((s) => !t.includes(s))
  if (missing.length) errors.push('DriveBaselineCard 缺：' + missing.join('、'))
  if (t.includes('保存') || t.includes('恢复默认')) errors.push('DriveBaselineCard 不该再有保存/恢复默认')
  console.log((missing.length ? 'FAIL ' : 'ok   ') + 'DriveBaselineCard')
} catch (e) {
  errors.push('DriveBaselineCard 渲染失败: ' + (e && e.message))
  console.log('FAIL DriveBaselineCard')
}

/* ---- 偏好行：厌恶度得能一眼看出是「喜欢」还是「讨厌」 ---- */
function findNode(node, pred) {
  if (!node || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const c of node) { const hit = findNode(c, pred); if (hit) return hit }
    return null
  }
  if (pred(node)) return node
  if (typeof node.type === 'function') {
    let out
    try { out = node.type({ ...node.props, children: node.children }) } catch { return null }
    return findNode(out, pred)
  }
  for (const c of node.children || []) { const hit = findNode(c, pred); if (hit) return hit }
  return null
}
const prefWire = [
  ['喜欢', 0.18, 'ok'],
  ['看情况', 0.5, undefined],
  ['讨厌', 0.86, 'bad'],
]
for (const [word, av, tone] of prefWire) {
  try {
    const tree = T.PrefRow({
      aid: agent.id, act: async (fn) => fn(), onDone() {},
      r: { id: 'prf_' + word, tag: '测试标签', aversion: av, origin: 'auto' },
    })
    walk(tree, 'PrefRow/' + word)
    const t = renderTexts(tree).join('|')
    const bad = []
    if (!t.includes(word)) bad.push('缺「' + word + '」标签')
    if (!t.includes(av.toFixed(2))) bad.push('缺数值 ' + av.toFixed(2))
    const bar = findNode(tree, (n) => n.props && n.props.className === 'dshc-bar')
    const gotTone = bar ? bar.props['data-tone'] : '(无)'
    if (gotTone !== tone) bad.push('条形色调=' + String(gotTone) + '，应为 ' + String(tone))
    if (bad.length) errors.push('PrefRow/' + word + '：' + bad.join('，'))
    console.log((bad.length ? 'FAIL ' : 'ok   ') + 'PrefRow/' + word)
  } catch (e) {
    errors.push('PrefRow/' + word + ' 渲染失败: ' + (e && e.message))
    console.log('FAIL PrefRow/' + word)
  }
}
try {
  const bad = []
  if (T.prefSense(0.10).word !== '喜欢') bad.push('0.10 判成 ' + T.prefSense(0.10).word)
  if (T.prefSense(0.99).word !== '讨厌') bad.push('0.99 判成 ' + T.prefSense(0.99).word)
  if (T.prefSense(0.50).word !== '看情况') bad.push('0.50 判成 ' + T.prefSense(0.50).word)
  if (bad.length) errors.push('prefSense 阈值：' + bad.join('，'))
  console.log((bad.length ? 'FAIL ' : 'ok   ') + 'prefSense 阈值')
} catch (e) {
  errors.push('prefSense 不可用: ' + (e && e.message))
  console.log('FAIL prefSense 阈值')
}

if (errors.length) {
  console.error('\n发现渲染错误：')
  for (const e of errors) console.error('\n' + e)
  process.exit(1)
}
console.log('\n渲染审计通过：' + cases.length + ' 个页面组合，0 错误')
