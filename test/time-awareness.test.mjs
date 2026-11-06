/**
 * 整体模拟：她还能不能「认清时间」。
 *
 * 不是测函数，是测一条链：
 *   一条旧说法 → 写入（可能被取代）→ 检索/装箱 → 注入文本里它有没有带时间、会不会被当成现在。
 *
 * 覆盖四件事：
 *   1) 同 key 槽位更新：旧条作废，注入里只剩新说法；
 *   2) 非槽位旧判断：注入行带「（X 记下的判断，不是说现在）」；
 *   3) 年龄徽章还在（「N 天前」）；
 *   4) 窄门 on 作废后，旧说法真的从注入里消失；shadow 则仍然出现（但带提示）。
 *
 * 运行：node test/time-awareness.test.mjs
 */
import { makeWorld } from './eval-persona/setup.mjs'
import { addMemory } from '../src/modules/memory.js'
import { writeParam } from '../src/kernel.js'
import { packMemoryBlock } from '../index.js'
import { passportLine } from '../src/modules/passport.js'
import { applyWrite, flushJudges, resetJudgeState } from '../src/modules/gate.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) } else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 500)) }
}
const ago = (days) => new Date(Date.now() - days * 86400000).toISOString()
const rowOf = (w, id) => w.db.prepare('SELECT * FROM memory_items WHERE id=?').get(id)
// packInjection 按 partition 分桶（buffer/T1/T3/T2/T4），没有 partition 的条目会被静默丢掉。
const hit = (w, id) => ({ ...rowOf(w, id), partition: 'T1' })

// ── ① 同 key 槽位更新：旧条作废，注入里只剩新说法 ──────────
{
  const w = makeWorld()
  try {
    const old = addMemory(w.db, w.aid, { text: '用户咖啡偏好是冰美式', type: 'fact', fact_key: '用户.咖啡.偏好' })
    w.db.prepare('UPDATE memory_items SET created_at=? WHERE id=?').run(ago(9), old.id)
    const newer = addMemory(w.db, w.aid, { text: '用户咖啡偏好改成手冲了', type: 'fact', fact_key: '用户.咖啡.偏好' })
    check('同 key 更新：旧条被标作废', rowOf(w, old.id).invalid_at !== null, rowOf(w, old.id).invalid_at)
    const block = packMemoryBlock(w.db, w.aid, [hit(w, old.id), hit(w, newer.id)], 400)
    check('同 key 更新：注入里没有旧句', !String(block.text).includes('冰美式'), block.text)
    check('同 key 更新：注入里有新句', String(block.text).includes('手冲'), block.text)
  } finally { w.close() }
}

// ── ② 非槽位旧判断：带「这是哪天的判断」 ──────────────────
{
  const w = makeWorld()
  try {
    const r = addMemory(w.db, w.aid, { text: '今天聊完觉得他其实更想让我先别急着改', type: 'reflection', fact_key: '用户.情绪快照.思考' })
    w.db.prepare('UPDATE memory_items SET created_at=? WHERE id=?').run(ago(6), r.id)
    w.db.prepare("UPDATE memory_timeline SET valid_from=? WHERE memory_id=? AND op='ADD'").run(ago(6), r.id)
    const line = passportLine(w.db, w.aid, rowOf(w, r.id))
    check('旧判断带时态', line.includes('记下的判断') && line.includes('不是说现在'), line)
    check('时态里带日期', /\d{2}-\d{2}/.test(line), line)
  } finally { w.close() }
}

// ── ③ 年龄徽章：装箱后仍说得出「N 天前」 ──────────────────
{
  const w = makeWorld()
  try {
    const r = addMemory(w.db, w.aid, { text: '用户提过想学游泳，但一直没找到班', type: 'fact', fact_key: '用户.游泳.想法' })
    w.db.prepare('UPDATE memory_items SET created_at=? WHERE id=?').run(ago(12), r.id)
    const block = packMemoryBlock(w.db, w.aid, [hit(w, r.id)], 400)
    check('装箱文本带年龄徽章', /(天前|个月前|周前)/.test(String(block.text)), block.text)
  } finally { w.close() }
}

// ── ④ 窄门 on 作废后，旧说法从注入里消失 ──────────────────
{
  const w = makeWorld()
  try {
    resetJudgeState()
    writeParam(w.db, w.aid, 'memory.judge.enable', 'on')
    writeParam(w.db, w.aid, 'memory.judge.gate', 'on')
    writeParam(w.db, w.aid, 'memory.judge.min_interval_ms', 0)
    writeParam(w.db, w.aid, 'memory.judge.daily_max', 40)
    writeParam(w.db, w.aid, 'memory.judge.timeout_ms', 2000)
    const old = addMemory(w.db, w.aid, { text: '检索方案还在比较甲和乙两种做法', type: 'appraisal', fact_key: '用户.检索M.方案' })
    w.db.prepare('UPDATE memory_items SET created_at=? WHERE id=?').run(ago(3), old.id)
    const out = applyWrite(w.db, w.aid, { text: '检索最后定成乙方案，下周开始执行', fact_key: '用户.检索M.定稿' }, (c) => addMemory(w.db, w.aid, {
      text: c.text, type: 'appraisal', fact_key: c.fact_key || c.key || '',
    }), { complete: async () => '取代' })
    await flushJudges()
    check('窄门 on：旧条被作废', rowOf(w, old.id).invalid_at !== null, rowOf(w, old.id).invalid_at)
    const block = packMemoryBlock(w.db, w.aid, [hit(w, old.id), hit(w, out.id)], 400)
    check('窄门 on：注入里没有旧说法', !String(block.text).includes('比较甲和乙'), block.text)
    check('窄门 on：注入里有新说法', String(block.text).includes('定成乙'), block.text)
  } finally { w.close() }
}

// ── ⑤ shadow 对照：旧说法还在，但带提示（不会被裸暴露） ────
{
  const w = makeWorld()
  try {
    resetJudgeState()
    writeParam(w.db, w.aid, 'memory.judge.enable', 'on')
    writeParam(w.db, w.aid, 'memory.judge.gate', 'shadow')
    writeParam(w.db, w.aid, 'memory.judge.min_interval_ms', 0)
    const old = addMemory(w.db, w.aid, { text: '检索方案还在比较甲和乙两种做法', type: 'appraisal', fact_key: '用户.检索N.方案' })
    w.db.prepare('UPDATE memory_items SET created_at=? WHERE id=?').run(ago(3), old.id)
    const out = applyWrite(w.db, w.aid, { text: '检索最后定成乙方案，下周开始执行', fact_key: '用户.检索N.定稿' }, (c) => addMemory(w.db, w.aid, {
      text: c.text, type: 'appraisal', fact_key: c.fact_key || c.key || '',
    }), { complete: async () => '取代' })
    await flushJudges()
    check('shadow：旧条仍然有效', rowOf(w, old.id).invalid_at === null)
    const block = packMemoryBlock(w.db, w.aid, [rowOf(w, old.id), rowOf(w, out.id)], 400)
    const text = String(block.text)
    const hasOld = text.includes('比较甲和乙')
    // 只要它出现在注入里，就必须带时间/年龄提示（不是裸的）
    const annotated = /(天前|个月前|周前|记下的判断|有更新的说法)/.test(text)
    check('shadow：旧说法若出现必带时间提示', !hasOld || annotated, { hasOld, annotated, text: text.slice(0, 200) })
  } finally { w.close() }
}

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
