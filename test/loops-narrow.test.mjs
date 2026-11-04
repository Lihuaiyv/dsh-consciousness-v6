/**
 * 开环修正（P4）：病根是虚词太宽 + 字符集重合太松。
 * 运行：node test/loops-narrow.test.mjs
 *
 * 实测背景（2026-11-03）：44 条开环全是 closed、open 为 0；
 * 抽出来的句子是「模型版本更新之后你还在吗」这种——不是待办。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { detectLoop, addLoop, markLoopsFired, settleLoopsFromUser, pendingLoops } from '../src/modules/loops.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name + '  ' + JSON.stringify(detail === undefined ? '' : detail).slice(0, 400)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-loops-'))
const db = openDb(path.join(dir, 'app.db'))
const now = () => new Date().toISOString()
const T0 = Date.parse('2026-11-03T22:00:00.000Z')
let seq = 0
function mkAgent() {
  seq++
  const id = 'agt_loop_' + seq
  db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
    .run(id, '测试' + seq, 'chat', 'active', now())
  return id
}

// ---------------- 1 问句 / 虚词：不该挂 ----------------
const NOT_LOOP = [
  '你觉得模型版本更新之后，你还在吗',
  '重载之后',
  '更新之后再说',
  '今晚你没开的话是不是明天醒来的时候你也会跑？',
  '好了，你的小圈是不是还没画',
  '第三遍：重载之后',
  '好吧那之后吧',
]
for (const t of NOT_LOOP) {
  check('不挂：' + t.slice(0, 18), detectLoop(t, T0) === null, detectLoop(t, T0))
}

// ---------------- 2 真待办：还得挂 ----------------
const IS_LOOP = [
  '明天提醒我交水电费',
  '你明天能不能提醒我一下体检',
  '答应过主人把那版配色改一下',
  '下周把那份合同改完',
  '回头再修那个脚本',
]
for (const t of IS_LOOP) {
  check('要挂：' + t.slice(0, 18), detectLoop(t, T0) !== null, detectLoop(t, T0))
}

// ---------------- 3 关闭：连续 4 字才算同一件事 ----------------
{
  const aid = mkAgent()
  const a = addLoop(db, aid, { text: '下周三前把那份合同改完', at: T0 })
  // 没被浮现过 + 只说「好了」→ 不该关（以前字符集重合会误关）
  const n0 = settleLoopsFromUser(db, aid, [{ role: 'user', text: '好了' }], { at: T0 + 3600000 })
  const row = db.prepare('SELECT state FROM open_loops WHERE id=?').get(a.id)
  check('「好了」不再乱关', n0 === 0 && row.state === 'open', { n0, state: row.state })

  // 真的点到了那件事（连续 4 字）→ 关
  const n1 = settleLoopsFromUser(db, aid, [{ role: 'user', text: '那份合同搞定了' }], { at: T0 + 7200000 })
  const row2 = db.prepare('SELECT state, closed_by FROM open_loops WHERE id=?').get(a.id)
  check('点到同一件事就关', n1 === 1 && row2.state === 'closed' && row2.closed_by === 'user_done', { n1, row2 })
}

// ---------------- 4 关闭：两小时内浮现过的仍然关 ----------------
{
  const aid = mkAgent()
  const l = addLoop(db, aid, { text: '记得提醒我交水电费', kind: 'reminder', at: T0 })
  markLoopsFired(db, [l.id], T0)
  const n = settleLoopsFromUser(db, aid, [{ role: 'user', text: '好了，交完了' }], { at: T0 + 600000 })
  check('浮现过 + 说好了 → 关（旧行为保住）', n === 1, n)
}

// ---------------- 5 去重：同一件事只挂一条 ----------------
{
  const aid = mkAgent()
  const a = addLoop(db, aid, { text: '把那个备份脚本修一下', at: T0 })
  const b = addLoop(db, aid, { text: '把那个备份脚本修一下', at: T0 + 1000 })
  check('去重：字面一样不重复挂', b.created === false && b.id === a.id, b)
  const c = addLoop(db, aid, { text: '那个备份脚本还没弄完', at: T0 + 2000 })
  check('去重：连续 4 字重合算同一件事', c.created === false && c.id === a.id, c)
  const d = addLoop(db, aid, { text: '明天要早起体检', at: T0 + 3000 })
  check('去重：不相干的两件事各挂各的', d.created === true && d.id !== a.id, d)
  const open = pendingLoops(db, aid, { at: T0 + 4 * 86400000, limit: 10, throttleHours: 0 })
  check('去重后仍能浮出来', open.length >= 1, open.map((x) => x.text))
}

console.log('\n通过 ' + pass + ' / ' + (pass + fail))
process.exit(fail ? 1 : 0)
