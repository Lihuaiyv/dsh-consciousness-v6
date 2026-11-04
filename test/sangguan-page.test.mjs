/**
 * 三观页渲染（S13 F0–F6）：client.js 在 vm 里跑，fetch 直连真实 api.handle + 临时库，逐条核对前端规则 F-I1–F-I7。
 * 运行：node test/sangguan-page.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-sgpage-'))
process.env.DSH_HOME = home
const { openDb } = await import('../src/db.js')
const api = await import('../src/api.js')
const { append, newId } = await import('../src/modules/sangguan/ledger.js')
const { retireClaim } = await import('../src/modules/sangguan/retire.js')
const { loadState } = await import('../src/modules/sangguan/projection.js')

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 900)) }
}
const db = openDb(path.join(home, 'app.db'))

// ---------- 极简 React：带依赖比较的 hooks；子组件展开时用一次性 hook 槽 ----------
let slots = []
let cursor = 0
let dirty = false
let effects = []
const same = (a, b) => a && b && a.length === b.length && a.every((x, i) => Object.is(x, b[i]))
function createElement(type, props, ...children) {
  return { type, props: props || {}, children: children.flat(Infinity).filter((c) => c != null && c !== false) }
}
const React = {
  createElement,
  Fragment: 'fragment',
  useState(init) {
    const i = cursor++
    if (!(i in slots)) slots[i] = typeof init === 'function' ? init() : init
    const mine = slots
    return [slots[i], (v) => { mine[i] = typeof v === 'function' ? v(mine[i]) : v; if (mine === top) dirty = true }]
  },
  useRef(v) { const i = cursor++; if (!(i in slots)) slots[i] = { current: v }; return slots[i] },
  useCallback(fn, deps) {
    const i = cursor++
    if (!(i in slots) || !same(slots[i].deps, deps)) slots[i] = { fn, deps }
    return slots[i].fn
  },
  useMemo(fn) { cursor++; return fn() },
  useEffect(fn, deps) {
    const i = cursor++
    if (!(i in slots) || !deps || !same(slots[i], deps)) { slots[i] = deps; effects.push(fn) }
  },
}
let top = slots

let inflight = 0
let calls = []
const fetchMock = async (url, opts) => {
  const req = JSON.parse(opts.body)
  inflight++
  calls.push(req.method + ' ' + req.path)
  try {
    const r = await api.handle(db, { method: req.method, path: req.path, token: req.token, body: req.body })
    return { json: async () => r.body }
  } finally { inflight-- }
}
const document = {
  createElement: () => ({ appendChild() {}, style: {}, remove() {} }),
  head: { appendChild() {} }, body: { appendChild() {}, children: [] },
  addEventListener() {}, removeEventListener() {}, visibilityState: 'visible',
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
  Math, Date, JSON, Promise, Number, String, Array, Object, Error, Map, Set, Uint8Array, TextEncoder, TextDecoder, URLSearchParams,
  btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
  atob: (s) => Buffer.from(s, 'base64').toString('binary'),
}
sandbox.window.document = document
sandbox.globalThis = sandbox
const here = path.dirname(fileURLToPath(import.meta.url))
let src = fs.readFileSync(path.join(here, '..', 'client.js'), 'utf8')
src = src.replace("    return {\n      inject: ['slots'],", "    return {\n      __test: { SangguanPage, SimpleHome },\n      inject: ['slots'],")
if (!src.includes('__test: { SangguanPage, SimpleHome }')) throw new Error('没找到注入点')
vm.createContext(sandbox)
vm.runInContext(src, sandbox, { filename: 'client.js' })
const plugin = captured.factory((name) => { if (name === 'react') return React; throw new Error('未知依赖 ' + name) })
const Page = plugin.__test.SangguanPage
const Home = plugin.__test.SimpleHome

function expand(node) {
  if (node == null || node === false) return null
  if (Array.isArray(node)) return node.map(expand)
  if (typeof node !== 'object') return node
  if (typeof node.type === 'function') {
    const saved = [slots, cursor]
    slots = []; cursor = 0
    const out = node.type({ ...node.props, children: node.children.length === 1 ? node.children[0] : node.children })
    ;[slots, cursor] = saved
    return expand(out)
  }
  return { ...node, children: node.children.map(expand) }
}
async function render(props, state, Comp = Page) {
  slots = state.slots
  top = slots
  let tree = null
  for (let round = 0; round < 40; round++) {
    slots = state.slots; top = slots; cursor = 0; dirty = false; effects = []
    tree = Comp(props)
    const fx = effects
    for (const fn of fx) fn()
    await new Promise((r) => setTimeout(r, 15))
    while (inflight) await new Promise((r) => setTimeout(r, 5))
    await new Promise((r) => setTimeout(r, 5))
    if (!dirty && !fx.length) break
  }
  slots = state.slots; cursor = 0
  return expand(Comp(props))
}
const textOf = (n) => (n == null ? '' : typeof n !== 'object' ? String(n) : Array.isArray(n) ? n.map(textOf).join('') : n.children.map(textOf).join(''))
function find(n, pred, out = []) {
  if (n == null || typeof n !== 'object') return out
  if (Array.isArray(n)) { n.forEach((x) => find(x, pred, out)); return out }
  if (pred(n)) out.push(n)
  n.children.forEach((x) => find(x, pred, out))
  return out
}
const sectionOf = (tree, title) => find(tree, (n) => n.type === 'section' && textOf(find(n, (x) => x.type === 'h2')[0]) === title)[0] || null
const act = (fn) => fn()
const settle = async () => { await new Promise((r) => setTimeout(r, 20)); while (inflight) await new Promise((r) => setTimeout(r, 5)) }

// ---------- 数据 ----------
const mkAgent = async (name) => (await api.handle(db, { method: 'POST', path: '/v1/agents', token: 'user', body: { name, __idempotencyKey: 'mk-' + name } })).body.id
let clock = Date.now() - 20 * 86400000
const tick = () => new Date((clock += 60000)).toISOString()
const put = (aid, evs) => append(db, aid, evs)
const claim = (aid, layer, kind, text, actor = 'sys') => put(aid, [{ type: 'CLAIM_EXP', layer, actor, at: tick(), payload: { claims: [{ layer, kind, text, origin: 'extract' }] } }]).entities.claims[0]
const kappa = (aid, layer, a, b, q) => {
  const at = tick()
  const qid = newId('questions', at)
  return put(aid, [{ type: 'KAPPA_OPEN', layer, actor: 'judge', at, payload: { questions: [{ id: qid, layer, text: q }], kappas: [{ layer, q_id: qid, pos_id: a, neg_id: b, dep: 'd', excl: 'e' }] } }]).entities.kappas[0]
}

// ---------- F0：关闭时 ----------
{
  const off = await mkAgent('关着的')
  const tree = await render({ aid: off, view: 'user', act }, { slots: [] })
  const t = textOf(tree)
  check('关闭：一行说明 + 打开按钮', t.includes('三观引擎未启用') && t.includes('打开三观引擎'), t.slice(0, 300))
  check('关闭：不渲染空框架（无世界观 / 人生观 / 价值观区）', !sectionOf(tree, '世界观') && !sectionOf(tree, '价值观'))
  check('关闭：只请求 status 与旧仪表，不碰三观数据接口', !calls.some((c) => /\/sangguan\/(heads|kappa|events|timeline)/.test(c)), calls)
  check('关闭：旧维度仪表在', t.includes('世界（旧八维）') && t.includes('价值（旧十维）'))
}

// ---------- 打开 + 造数据 ----------
const aid = await mkAgent('三观页')
await api.handle(db, { method: 'PUT', path: '/v1/agents/' + aid + '/sangguan/config', token: 'user', body: { enabled: true, __idempotencyKey: 'on' } })
const wb = claim(aid, 'W', 'belt', '世界大体可以被理解')
const wCore = put(aid, [{ type: 'CORE_ESTABLISH', layer: 'W', actor: 'judge', at: tick(), payload: { from_id: wb, claims: [{ layer: 'W', kind: 'core', text: '世界大体可以被理解', origin: 'extract', pred: [wb] }] } }]).entities.claims[0]
claim(aid, 'W', 'belt', '人多数时候愿意讲道理')
const wDead = claim(aid, 'W', 'belt', '已经被推翻的旧看法')
put(aid, [{ type: 'CON', layer: 'W', actor: 'sys', at: tick(), payload: { claim_id: wDead } }])
const wa = claim(aid, 'W', 'belt', '认真听比急着答更有用')
const wn = claim(aid, 'W', 'belt', '先给答案再慢慢听')
const kW = kappa(aid, 'W', wa, wn, '该先听还是先答')
claim(aid, 'L', 'chapter', '学着把话说清楚的一年')
claim(aid, 'L', 'role', '做一个耐心的倾听者')
const va = claim(aid, 'V', 'norm', '诚实比体面更重要')
const vb = claim(aid, 'V', 'norm', '照顾对方的感受更要紧')
const kV = kappa(aid, 'V', va, vb, '该直说还是该体谅')
put(aid, [
  { type: 'DELIBERATE', layer: 'V', actor: 'judge', at: tick(), payload: { kappa_id: kV, branch: 'COEX' } },
  { type: 'COEX', layer: 'V', actor: 'judge', at: tick(), payload: { kappa_id: kV, loss: { lean_pole: 'neg', cost: '有时把话说得太软' } } },
])
claim(aid, 'V', 'ideal', '成为让人安心的人')
// 只接受、没确认的合题：页面不得出现「想通了」（F-I3）
const la = claim(aid, 'L', 'chapter', '把工作放第一')
const lb = claim(aid, 'L', 'chapter', '把家人放第一')
const kL = kappa(aid, 'L', la, lb, '先顾哪头')
put(aid, [
  { type: 'DELIBERATE', layer: 'L', actor: 'judge', at: tick(), payload: { kappa_id: kL, branch: 'SUB' } },
  { type: 'SUB_ACCEPT', layer: 'L', actor: 'judge', at: tick(), payload: { kappa_id: kL, claims: [{ layer: 'L', kind: 'chapter', text: '忙季顾工作、平时顾家', origin: 'synth', pred: [la, lb], q_id: db.prepare('SELECT q_id FROM claim_kappa WHERE id=?').get(kL).q_id }] } },
])
{
  const at = tick()
  put(aid, [{ type: 'NU_REGISTER', actor: 'judge', at, payload: { nus: [{ claim_id: wCore, expect: '下次争执他会讲理', observe: '下次争执', p: 0.7, due_at: new Date(clock + 30 * 86400000).toISOString() }] } }])
}
put(aid, [{ type: 'INQUIRY', layer: 'W', actor: 'judge', at: tick(), payload: { target_type: 'claim', target_id: wa, mode: 'ask', question: '你更喜欢先被听完吗' } }])
for (let i = 0; i < 10; i++) put(aid, [{ type: 'EVIDENCE', actor: 'user', at: tick(), payload: { evidence: [{ kind: 'act', target_type: 'claim', target_id: wCore, sign: 1, weight: 0.6, ref: 'r' + i } ] } }])
put(aid, [{ type: 'SUMMARY_BUILD', actor: 'judge', at: tick(), payload: { summaries: [{ layer: null, kind: 'chapter', from_seq: 0, to_seq: 5, text: JSON.stringify({ chapter: '学会先听', at_the_time: '我那时觉得直说最省事', hindsight: '现在看，先听更省事' }) }] } }])

// ---------- 三个数：违背 / 兑现率 / 改主意 得真取自账本，不是占位 ----------
{
  // 另记一条预料并当场结掉：不动上面那条「等着看」的用例
  const nu = put(aid, [{ type: 'NU_REGISTER', actor: 'judge', at: tick(), payload: { nus: [{ claim_id: wCore, expect: '这一条只用来算兑现率', observe: '算完即弃', p: 0.6, due_at: new Date(clock + 2 * 86400000).toISOString() }] } }]).entities.nus[0]
  put(aid, [{ type: 'VIOLATE', layer: 'V', actor: 'judge', at: tick(), payload: { claim_id: va } }])
  put(aid, [{ type: 'NU_RESOLVE', actor: 'judge', at: tick(), payload: { nu_id: nu, outcome: 'hit' } }])
}

// ---------- 作废细分：判不了 vs 连坐（不是判错） ----------
{
  // ① 判不了：到点一条记录都没有
  const nuNoRec = put(aid, [{ type: 'NU_REGISTER', actor: 'sys', at: tick(), payload: { nus: [{ claim_id: wCore, expect: '这一条到点没留下记录', observe: '看看有没有记录', p: 0.6, due_at: new Date(clock + 86400000).toISOString() }] } }]).entities.nus[0]
  put(aid, [{ type: 'NU_RESOLVE', actor: 'sys', at: tick(), payload: { nu_id: nuNoRec, outcome: 'void', why: 'no_records' } }])
  // ② 连坐：命题被收回，挂在它下面的预见跟着 void
  const retiredClaim = claim(aid, 'V', 'norm', '说话前先数三秒')
  put(aid, [{ type: 'NU_REGISTER', actor: 'sys', at: tick(), payload: { nus: [{ claim_id: retiredClaim, expect: '这周能做到先数三秒', observe: '看有没有忍住', p: 0.5, due_at: new Date(clock + 5 * 86400000).toISOString() }] } }])
  retireClaim(db, aid, retiredClaim, { at: tick(), reason: 'no_tradeoff' })
}

// ---------- 承诺不算价值观：页面上不该在价值观栏出现 ----------
put(aid, [{ type: 'CLAIM_EXP', layer: 'V', actor: 'sys', at: tick(), payload: { claims: [{ layer: 'V', kind: 'commit', text: '我答应：明天把脚本补上', origin: 'extract' }] } }])

// ---------- 草稿箱：一条五闸全过，一条还差 ----------
const postDraft = async (body) => (await api.handle(db, {
  method: 'POST', path: '/v1/agents/' + aid + '/sangguan/drafts', token: 'user',
  body: { ...body, __idempotencyKey: 'd-' + Math.random() },
})).body
await postDraft({
  text: '数据不对就从头再跑，哪怕你在催',
  alt: '按趋势补个数先交差', foregone: '多花两天', exclusion: '不会拿一个大概对的数交差',
  evidence: [{ at: '2026-11-01', quote: '你说「别糊弄，重跑」' }], vouch: true,
})
await postDraft({
  text: '答应了的事就要做完，哪怕拖到很晚',
  evidence: [{ at: '2026-11-02', quote: '你说过会等' }], vouch: false,
})

// ---------- F1–F5：用户视图 ----------
calls = []
const userState = { slots: [] }
let tree = await render({ aid, view: 'user', act }, userState)
let t = textOf(tree)
check('三列：三层各一句 + 纪元戳', t.includes('世界大体可以被理解') && /第 \d+ 季/.test(t), t.slice(0, 400))
check('三列：无核心的层标「尚未立论」（F-I5）', t.includes('尚未立论'))
const sgrid = find(tree, (n) => n.props && n.props.className === 'dshc-sg3')
check('三列：三列同排在一个格子里', sgrid.length === 1 && sgrid[0].children.length === 3, sgrid.length)
check('三列：每列写自己的判据', t.includes('能预测事、经得起撞') && t.includes('走过哪几章、花了多久') && t.includes('选了这边、放弃了什么'))
check('三列：在争的矛盾在各自的列里', t.includes('该先听还是先答') && t.includes('没有可参照的旧事'))
const W = sectionOf(tree, '世界观')
const V = sectionOf(tree, '价值观')
const Lz = sectionOf(tree, '人生观')
check('世界观列：硬核大字 + 保护带', W && textOf(W).includes('世界大体可以被理解') && textOf(W).includes('人多数时候愿意讲道理'))
check('世界观列：在争标记', W && textOf(W).includes('在争'))
check('终态命题不进主区（F-I4）', W && !textOf(W).includes('已经被推翻的旧看法'))
check('价值观列：取舍卡「两样都要」+ 偏向 + 代价', V && textOf(V).includes('两样都要') && textOf(V).includes('平时偏向「照顾对方的感受更要紧」') && textOf(V).includes('有时把话说得太软'), V && textOf(V))
check('价值观列：没有第三栏合题', V && !textOf(V).includes('正在试的说法') && !textOf(V).includes('想通了'))
check('承诺不算价值观：价值观列不出现「我答应」', V && !textOf(V).includes('我答应'), V && textOf(V))
check('价值观列：规范 / 理想分两层', V && textOf(V).includes('平时怎么做') && textOf(V).includes('仰望什么'))
check('人生观列：叙事弧（当时 / 回头看分两栏）+ 角色', Lz && textOf(Lz).includes('当时它这样讲') && textOf(Lz).includes('现在回头看') && textOf(Lz).includes('做一个耐心的倾听者'))
check('诚实：SUB_ACCEPT 无 CONFIRM → 「正在试」，不出现「想通了」（F-I3）', Lz && textOf(Lz).includes('正在试') && !t.includes('想通了'), Lz && textOf(Lz))
check('预见：三列（结局 / 正文 / 依据），把握几成，对 / 不对按钮', t.includes('预计：下次争执他会讲理') && t.includes('把握 7 成') && t.includes('等着看'))
check('预见：分「还在等」和「已经判过」两段', t.includes('还在等（') && t.includes('已经判过（'), t.slice(0, 1200))
check('预见：作废分两种，判不了说清「没留下能查的记录」', t.includes('没留下能查的记录，判不了'), t.slice(0, 1200))
check('预见：作废分两种，连坐说清「依附的那句话已经收回，不是判错」', t.includes('依附的那句话已经收回，不是判错'), t.slice(0, 1200))
check('预见：说清「对 / 不对」只是留证据、作废不进准确率', t.includes('只是留一条证据') && t.includes('作废不算猜错'), t.slice(0, 1200))
check('它最近在想什么：提问可回答', t.includes('它想问你：你更喜欢先被听完吗') && t.includes('是这样'))
check('史：转折时间线有「两样都要」「立为核心」', textOf(sectionOf(tree, '史')).includes('决定两样都要') && textOf(sectionOf(tree, '史')).includes('立为核心'))
check('用户视图零术语：无 κ / π / ν / σ（F-I7）', !/[κπνσ]/.test(t), (t.match(/.{0,20}[κπνσ].{0,20}/g) || []).slice(0, 3))
check('用户视图不露 id', !/\b(cl|k|nu|q)_[0-9A-Z]{6,}/.test(t))
check('影子期说明', t.includes('影子期') && t.includes('/ 7 天'))
check('三个数已搬走：三观页不再出现「说过的没做到」', !t.includes('说过的没做到'))
check('草稿箱：两条草稿都在', t.includes('数据不对就从头再跑') && t.includes('答应了的事就要做完'))
check('草稿箱：五闸都用普通话写', t.includes('有另一条路') && t.includes('说了代价') && t.includes('能排除') && t.includes('不是工作说明') && t.includes('有生活作证'))
check('草稿箱：缺闸的标「还差几道」，并写着还差什么', t.includes('还差几道')
  && find(tree, (n) => n.props && typeof n.props.title === 'string' && n.props.title.startsWith('还差')).length >= 1)
check('草稿箱：过了闸的才能点入库', (() => {
  const bs = find(tree, (n) => n.type === 'button' && textOf(n) === '入库')
  return bs.length === 2 && bs.some((b) => b.props.disabled === true) && bs.some((b) => !b.props.disabled)
})(), find(tree, (n) => n.type === 'button' && textOf(n) === '入库').map((b) => !!b.props.disabled))
check('页面只读 /sangguan/* 与旧仪表（F-I1）', calls.every((c) => /^GET .*\/(sangguan\/|values$|worldview$|lifeview$)/.test(c)), calls.filter((c) => !/\/(sangguan\/|values$|worldview$|lifeview$)/.test(c)))

// ---------- 点开命题：为什么 + 链 + 对 / 不对（F-I6） ----------
{
  const row = find(W, (n) => n.props && n.props.role === 'button' && textOf(n).includes('世界大体可以被理解'))[0]
  row.props.onClick()
  tree = await render({ aid, view: 'user', act }, userState)
  t = textOf(tree)
  check('点开：解释句出现（模板句兜底）', t.includes('我会这样看「世界大体可以被理解」'), t.slice(0, 600))
  check('点开：链浏览显示前身', t.includes('之前'))
  const yes = find(tree, (n) => n.type === 'button' && textOf(n) === '对')
  check('点开：有「对」按钮', yes.length >= 1)
  const before = db.prepare("SELECT COUNT(*) n FROM claim_events WHERE agent_id=? AND type='EVIDENCE' AND actor='user'").get(aid).n
  await yes[yes.length - 1].props.onClick()
  await settle()
  tree = await render({ aid, view: 'user', act }, userState)
  const after = db.prepare("SELECT COUNT(*) n FROM claim_events WHERE agent_id=? AND type='EVIDENCE' AND actor='user'").get(aid).n
  check('点「对」：只产生一条用户证据（F-I2）', after === before + 1, { before, after })
  check('点「对」：提示已记下', textOf(tree).includes('记下了'))
}

// ---------- 草稿箱：点入库真的写账本 ----------
{
  const bs = find(tree, (n) => n.type === 'button' && textOf(n) === '入库' && !n.props.disabled)
  check('草稿箱：有可点的入库按钮', bs.length === 1, bs.length)
  await bs[0].props.onClick()
  await settle()
  tree = await render({ aid, view: 'user', act }, userState)
  t = textOf(tree)
  const row = db.prepare("SELECT text FROM persona_claims WHERE agent_id=? AND layer='V' AND kind='norm' AND origin='user' ORDER BY created_at DESC LIMIT 1").get(aid)
  check('入库：写进 V 层 norm，正文对得上', row && row.text === '数据不对就从头再跑，哪怕你在催', row)
  check('入库：箱子里那条关掉了，计数写清楚', t.includes('已经入库 1 条'), t.slice(0, 600))
}

// ---------- 三列开关：点一下真的开 ----------
{
  const Lsec = sectionOf(tree, '人生观')
  const openBtn = find(Lsec, (n) => n.type === 'button' && textOf(n) === '打开这一列')[0]
  check('三列：关着的列有「打开这一列」', !!openBtn)
  await openBtn.props.onClick()
  await settle()
  tree = await render({ aid, view: 'user', act }, userState)
  const L2 = sectionOf(tree, '人生观')
  check('三列：点开后 L 列标「开着」', textOf(L2).includes('开着'))
  const cfg = (await api.handle(db, { method: 'GET', path: '/v1/agents/' + aid + '/sangguan/config', token: 'viewer' })).body
  check('三列：开关真的写进配置', cfg.config.lanes.L === true, cfg.config.lanes)
}

// ---------- 召回预览：一句话看出会想起什么 ----------
{
  const input = find(tree, (n) => n.type === 'input' && String((n.props && n.props.placeholder) || '').includes('这次要不要'))
  check('召回：有试一句的输入框', input.length === 1)
  input[0].props.onChange({ target: { value: '先听还是先答' } })
  tree = await render({ aid, view: 'user', act }, userState)
  const tryBtn = find(tree, (n) => n.type === 'button' && textOf(n) === '试试')[0]
  check('召回：有「试试」按钮', !!tryBtn)
  await tryBtn.props.onClick()
  await settle()
  tree = await render({ aid, view: 'user', act }, userState)
  t = textOf(tree)
  check('召回：显示会想起的那几行', t.includes('这一刻会想起') && t.includes('你看世界的方式：世界大体可以被理解'), t.slice(0, 900))
}

// ---------- 概览：三个数搬到「它靠不靠谱」 ----------
{
  const agent = { id: aid, name: '三观页', created_at: new Date(clock - 20 * 86400000).toISOString(), last_interaction_at: new Date(clock).toISOString() }
  const homeProps = { aid, agent, ov: { memory_count: 2 }, act, close: () => {}, setTab: () => {}, setView: () => {}, running: true, setRunning: () => Promise.resolve() }
  const ht = await render(homeProps, { slots: [] }, Home)
  const hs = textOf(ht)
  check('概览：靠不靠谱卡里出现三个数', hs.includes('说过的没做到') && hs.includes('答应的事兑现了') && hs.includes('自己改了主意'), hs.slice(0, 900))
  check('概览：违背数真取自账本（1 次）', hs.includes('说过的没做到1 次'), hs.slice(0, 900))
  check('概览：改主意是 0 就照实写 0', hs.includes('自己改了主意0 次'), hs.slice(0, 900))
}

// ---------- F6：tech 视图 ----------
{
  calls = []
  const tt = await render({ aid, view: 'tech', act }, { slots: [] })
  const s = textOf(tt)
  check('tech：显示 π 与 id', s.includes('π ') && /cl_[0-9A-Z]/.test(s), s.slice(0, 1500))
  check('tech：注入预览（影子期）', s.includes('注入（影子期）') && s.includes('tokens'), s.slice(0, 300))
  check('tech：体征与预算', s.includes('账本 seq') && s.includes('mid '))
  check('tech：事件账', s.includes('事件账') && /#\d+ \d{4}-\d{2}-\d{2}T/.test(s))
  check('tech：换代提案区', s.includes('换代提案') && s.includes('没有待批的提案'))
  check('tech：矛盾卡带 σ 与审议次数', s.includes('σ=struggle') && s.includes('审议'))
}

console.log(`\n通过 ${pass} / ${pass + fail}`)
try { db.close() } catch { /* ignore */ }
try { fs.rmSync(home, { recursive: true, force: true }) } catch { /* ignore */ }
process.exit(fail ? 1 : 0)
