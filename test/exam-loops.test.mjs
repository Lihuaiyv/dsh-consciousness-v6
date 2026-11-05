/**
 * 考卷 · 开环（loops）
 * 运行：node test/exam-loops.test.mjs
 *
 * 它是搬零件前的尺子：把开环现在的行为一条条钉住。
 * 之后 `src/modules/loops.js` 搬进 `src/parts/loops/`，这张卷子必须原样全绿。
 *
 * 这张卷子管什么：一句话算不算欠着的事、到期怎么认、合并去重、
 * 什么时候冒出来、节流和收账、你说「好了」关哪条、交给注入的那行字。
 * 不管：主动开口要不要说（那是开口的卷子）、句子像不像她。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import {
  detectLoop, parseDue, addLoop, pendingLoops, markLoopsFired,
  settleLoopsFromUser, closeLoops, expireLoops, loopLineFor, loopPrefixOf, loopStats,
  markLoopImportant, isLoopImportant,
} from '../src/modules/loops.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name + '  ' + JSON.stringify(detail === undefined ? '' : detail).slice(0, 400)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-exam-loops-'))
const db = openDb(path.join(dir, 'app.db'))
const H = 3600000
const D = 86400000
const T0 = Date.parse('2026-11-05T10:00:00+08:00') // 周四上午
const iso = (t) => new Date(t).toISOString()
let seq = 0
function mkAgent() {
  seq++
  const id = 'agt_exam_loop_' + seq
  db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
    .run(id, '考卷' + seq, 'chat', 'active', iso(T0))
  return id
}

// ---------------- 1 该挂：话里真有一件还没完的事 ----------------
{
  const cases = [
    ['明天提醒我交水电费', 'reminder', true],
    ['你明天能不能提醒我一下体检', 'reminder', true],
    ['答应过主人把那版配色改一下', 'promise', false],
    ['下周三前把那份合同改完', 'task', true],
    ['回头再修那个脚本', 'task', false],
    ['等一会儿我把日志发你', 'task', true],
    ['周末陪我去看展', 'task', true],
    ['记得提醒我买猫粮', 'reminder', false],
  ]
  for (const [text, kind, hasDue] of cases) {
    const r = detectLoop(text, T0)
    check('该挂：' + text.slice(0, 16), !!r && r.kind === kind, r)
    check('到期线：' + text.slice(0, 12), !!r && (hasDue ? !!r.due_at : r.due_at === null), r && r.due_at)
  }
}

// ---------------- 2 不该挂：问句、已完成、汇报体、技术讨论、空泛 ----------------
{
  const cases = [
    '你觉得这个方案怎么样？',
    '那个脚本我已经修好了',
    '当前任务已进入收尾阶段，待办包括重载规则兜底修复',
    '这个函数的参数太宽了，判断逻辑有问题',
    '好的',
    '明天吧',
    '这个版本之后再说吧',
    '更新之后再说',
    '今晚你没开的话是不是明天也会跑？',
    '我喜欢喝美式咖啡不加糖',
  ]
  for (const text of cases) {
    check('不该挂：' + text.slice(0, 16), detectLoop(text, T0) === null, detectLoop(text, T0))
  }
}

// ---------------- 3 到期怎么认：只认说出口的，不猜 ----------------
{
  const plus = (n) => T0 + n * D
  check('到期：明天 = 次日 9 点', (() => {
    const d = parseDue('明天', T0)
    return d && new Date(d).getHours() === 9 && Date.parse(d) > T0 && Date.parse(d) <= T0 + D
  })(), parseDue('明天', T0))
  check('到期：后天 = 隔一天', (() => {
    const d = Date.parse(parseDue('后天', T0))
    return d > plus(1) && d <= plus(2) + D
  })())
  check('到期：大后天 = 再隔一天', (() => {
    const d = Date.parse(parseDue('大后天', T0))
    return d > plus(2) && d <= plus(3) + D
  })())
  check('到期：一会儿 = 两小时后', (() => {
    const d = Date.parse(parseDue('等一会儿', T0))
    return d === T0 + 2 * H
  })(), parseDue('等一会儿', T0))
  check('到期：回头 / 下次 = 不设死线', parseDue('回头再说', T0) === null && parseDue('下次吧', T0) === null)
  check('到期：下个月 = 30 天后', (() => {
    const d = Date.parse(parseDue('下个月', T0))
    return d > plus(29) && d <= plus(30) + D
  })())
}

// ---------------- 4 挂账：同一件事只挂一条 ----------------
{
  const aid = mkAgent()
  const a = addLoop(db, aid, { text: '把那个备份脚本修一下', at: T0 })
  check('挂账：新的一行 created', a.created && !!a.id, a)
  const b = addLoop(db, aid, { text: '把那个备份脚本修一下。', at: T0 + 1000 })
  check('去重：字面一样不重挂', b.created === false && b.id === a.id, b)
  const c = addLoop(db, aid, { text: '那个备份脚本还没弄完', at: T0 + 2000 })
  check('去重：连续 4 字算同一件', c.created === false && c.id === a.id, c)
  const d = addLoop(db, aid, { text: '明天要早起体检', at: T0 + 3000 })
  check('去重：不相干的两件事各挂各的', d.created === true && d.id !== a.id, d)
  check('挂账：并成两条，不是三条', loopStats(db, aid).open === 2, loopStats(db, aid))
}

// ---------------- 5 什么时候冒出来：到点 / 搁两天 / 节流 / 提满收掉 ----------------
{
  const aid = mkAgent()
  const noDue = addLoop(db, aid, { text: '回头把那个报告写完', at: T0 })
  const dueText = '明天交水电费'
  const due = addLoop(db, aid, { text: dueText, ...detectLoop(dueText, T0), at: T0 })
  const early = pendingLoops(db, aid, { at: T0 + H, limit: 5 })
  check('浮现：刚挂的、没到点的先不冒', !early.some((x) => x.id === noDue.id), early.map((x) => x.text))

  const onDue = pendingLoops(db, aid, { at: T0 + D + H, limit: 5, throttleHours: 0 })
  check('浮现：到期先冒', onDue.length > 0 && onDue[0].id === due.id, onDue.map((x) => x.text))

  const stale = pendingLoops(db, aid, { at: T0 + 2 * D + H, limit: 5, throttleHours: 0 })
  check('浮现：没死线的搁两天也冒', stale.some((x) => x.id === noDue.id), stale.map((x) => x.text))

  markLoopsFired(db, [noDue.id], T0 + 2 * D + H)
  const throttled = pendingLoops(db, aid, { at: T0 + 2 * D + 2 * H, limit: 5, throttleHours: 6 })
  check('浮现：六小时内不重复提', throttled.every((x) => x.id !== noDue.id), throttled.map((x) => x.text))
  const again = pendingLoops(db, aid, { at: T0 + 2 * D + 8 * H, limit: 5, throttleHours: 6 })
  check('浮现：过了六小时可以再提', again.some((x) => x.id === noDue.id), again.map((x) => x.text))

  db.prepare("UPDATE open_loops SET fire_count=5 WHERE id=?").run(noDue.id)
  const capped = pendingLoops(db, aid, { at: T0 + 3 * D, limit: 5, throttleHours: 0 })
  check('浮现：提满五次不再冒', capped.every((x) => x.id !== noDue.id), capped.map((x) => x.text))
  const closed = expireLoops(db, aid, T0 + 3 * D)
  const row = db.prepare('SELECT state, closed_by FROM open_loops WHERE id=?').get(noDue.id)
  check('收账：提满五次自动关，理由记「念够了」', closed === 1 && row.state === 'closed' && row.closed_by === 'expired', { closed, row })
}

// ---------------- 6 关账：你说「好了」时关哪条 ----------------
{
  const aid = mkAgent()
  const a = addLoop(db, aid, { text: '下周三前把那份合同改完', at: T0 })
  const n0 = settleLoopsFromUser(db, aid, [{ role: 'user', text: '好了' }], { at: T0 + H })
  const r0 = db.prepare('SELECT state FROM open_loops WHERE id=?').get(a.id)
  check('关账：随口一句「好了」不误关', n0 === 0 && r0.state === 'open', { n0, r0 })

  const n1 = settleLoopsFromUser(db, aid, [{ role: 'user', text: '那份合同搞定了' }], { at: T0 + 2 * H })
  const r1 = db.prepare('SELECT state, closed_by FROM open_loops WHERE id=?').get(a.id)
  check('关账：点到同一件事就关，留「用户关的」', n1 === 1 && r1.state === 'closed' && r1.closed_by === 'user_done', { n1, r1 })
}
{
  const aid = mkAgent()
  const a = addLoop(db, aid, { text: '记得提醒我交水电费', kind: 'reminder', at: T0 })
  markLoopsFired(db, [a.id], T0)
  const n = settleLoopsFromUser(db, aid, [{ role: 'user', text: '好了，交完了' }], { at: T0 + 10 * 60000 })
  check('关账：两小时内提过的，说好了就关', n === 1, n)
}
{
  const aid = mkAgent()
  const a = addLoop(db, aid, { text: '把日志归档一下', at: T0 })
  const n = closeLoops(db, aid, [a.id], 'manual', T0 + H)
  const r = db.prepare('SELECT state, closed_by FROM open_loops WHERE id=?').get(a.id)
  check('关账：手动关也留痕', n === 1 && r.state === 'closed' && r.closed_by === 'manual', { n, r })
}

// ---------------- 7 状态机：开 → 说了一半 → 关 ----------------
{
  const aid = mkAgent()
  const a = addLoop(db, aid, { text: '回头把桌面收拾一下', at: T0 })
  const s0 = db.prepare('SELECT state FROM open_loops WHERE id=?').get(a.id).state
  markLoopsFired(db, [a.id], T0 + 3 * D)
  const s1 = db.prepare('SELECT state FROM open_loops WHERE id=?').get(a.id).state
  const onlyOpen = pendingLoops(db, aid, { at: T0 + 3 * D, limit: 5, throttleHours: 0, onlyOpen: true })
  check('状态：提一次就转「说了一半」', s0 === 'open' && s1 === 'half_said', { s0, s1 })
  check('状态：只要没开口的事时，说了一半的不算', onlyOpen.every((x) => x.id !== a.id), onlyOpen)
  closeLoops(db, aid, [a.id], 'manual', T0 + 4 * D)
  const s2 = db.prepare('SELECT state FROM open_loops WHERE id=?').get(a.id).state
  const after = pendingLoops(db, aid, { at: T0 + 5 * D, limit: 5, throttleHours: 0 })
  check('状态：关了就再也不冒', s2 === 'closed' && after.every((x) => x.id !== a.id), { s2, after: after.map((x) => x.text) })
}

// ---------------- 8 「我特别看重」记在它自己那一行 ----------------
{
  const aid = mkAgent()
  const a = addLoop(db, aid, { text: '答应给主人修相机', kind: 'promise', at: T0 })
  check('看重：标之前是 false', isLoopImportant(db, a.id) === false)
  const on = markLoopImportant(db, aid, a.id, true)
  const rowOn = db.prepare('SELECT important FROM open_loops WHERE id=?').get(a.id)
  check('看重：标上，落在 open_loops.important', on.ok === true && on.important === true && Number(rowOn.important) === 1, { on, rowOn })
  const off = markLoopImportant(db, aid, a.id, false)
  const rowOff = db.prepare('SELECT important FROM open_loops WHERE id=?').get(a.id)
  check('看重：撤掉，回到 0', off.ok === true && off.important === false && Number(rowOff.important) === 0, { off, rowOff })
  check('看重：不借 flags 存', !db.prepare("SELECT 1 FROM flags WHERE key LIKE 'loop.important:%'").get())
  const miss = markLoopImportant(db, aid, 'lp_nope', true)
  check('看重：标一条不存在的说找不到', miss.ok === false && miss.reason === 'loop_not_found', miss)
}

// ---------------- 9 交给注入的那行字 ----------------
{
  const aid = mkAgent()
  addLoop(db, aid, { text: '把旧日志清理掉', kind: 'task', at: T0 })
  addLoop(db, aid, { text: '答应给主人换壁纸', kind: 'promise', due_at: iso(T0 + D), at: T0 })
  const line = loopLineFor(db, aid, { at: T0 + 2 * D, limit: 2, throttleHours: 0 })
  check('注入：有「- 还挂着：」那行', line.text.includes('- 还挂着：'), line.text)
  check('注入：承诺排在任务前面', line.kinds[0] === 'promise', line.kinds)

  check('注入前缀：欠账说「最在意的其实是」', loopPrefixOf(['promise']).includes('最在意的其实是'))
  check('注入前缀：普通事说「还挂着」', loopPrefixOf(['task']).includes('还挂着'))
  check('注入前缀：开关关掉回旧措辞', loopPrefixOf(['promise'], { focusOn: false }).includes('还挂着'))
}

console.log('\n通过 ' + pass + ' / ' + (pass + fail))
process.exit(fail ? 1 : 0)
