/**
 * S3：有界指认式 supersede 测试。
 * 运行：node test/supersede-pick.test.mjs
 */
import { makeWorld } from './eval-persona/setup.mjs'
import { addMemory } from '../src/modules/memory.js'
import { writeParam } from '../src/kernel.js'
import { applyWrite, flushJudges, resetJudgeState } from '../src/modules/gate.js'
import { parsePick, pickSuperseded, PICK_SYS } from '../src/modules/supersede_pick.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) } else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)) }
}
const ago = (min) => new Date(Date.now() - min * 60000).toISOString()
const rowOf = (w, id) => w.db.prepare('SELECT * FROM memory_items WHERE id=?').get(id)

// ① 解析
check('解析：标准 JSON', JSON.stringify(parsePick('{"invalidate":[1,2]}', 3).invalidate) === '[1,2]')
check('解析：数组形式', JSON.stringify(parsePick('[2]', 3).invalidate) === '[2]')
check('解析：空数组', parsePick('{"invalidate":[]}', 2).invalidate.length === 0 && parsePick('{"invalidate":[]}', 2).ok)
check('解析：越界过滤', JSON.stringify(parsePick('{"invalidate":[1,5,0]}', 2).invalidate) === '[1]')
check('解析：去重', JSON.stringify(parsePick('{"invalidate":[1,1]}', 2).invalidate) === '[1]')
check('解析：markdown 包裹', parsePick('```json\n{"invalidate":[1]}\n```', 2).invalidate[0] === 1)
check('解析：非法 → ok=false', parsePick('我觉得是第一条', 2).ok === false)
check('解析：JSON 里没有 invalidate → ok=false', parsePick('{"foo":1}', 2).ok === false)
check('提示词明确空数组合法', PICK_SYS.includes('空数组'))

// ② 规则闸：短文本、专名
{
  const short = await pickSuperseded({
    oldCandidates: [{ id: 'a', text: '嗯嗯很好了' }], newer: { text: '这样有点暴力' },
    complete: async () => '{"invalidate":[1]}',
  })
  check('短文本不调模型', short.skipped === 'too-short' && short.invalidate.length === 0, short)

  let calls = 0
  const gated = await pickSuperseded({
    oldCandidates: [{ id: 'a', text: '考试正式环境数据库为 `204/knowledge_inner`', fact_key: '用户.考试.环境', created_at: '2026-11-01' }],
    newer: { text: '删除 `204/knowledge_inner` 里今天建的考试', fact_key: '用户.项目.配置', created_at: '2026-11-06' },
    complete: async () => { calls++; return '{"invalidate":[1]}' },
  })
  check('专名闸 → 不调模型', gated.skipped === 'rule' && calls === 0, { gated, calls })
}

// ③ 正常指认
{
  let calls = 0
  const r = await pickSuperseded({
    oldCandidates: [
      { id: 'a', text: '用户咖啡偏好是冰美式，不加糖', created_at: '2026-11-01' },
      { id: 'b', text: '用户住杭州滨江，周末才回市区', created_at: '2026-11-02' },
    ],
    newer: { text: '用户咖啡偏好改成手冲了，不加糖', created_at: '2026-11-06' },
    complete: async () => { calls++; return '{"invalidate":[1]}' },
  })
  check('指认第一条', r.ok && JSON.stringify(r.invalidate) === '[1]' && calls === 1, r)
  check('空数组也是合法答案', true)
}

// ④ gate 集成：shadow 只记事件
{
  const w = makeWorld()
  try {
    resetJudgeState()
    writeParam(w.db, w.aid, 'memory.judge.enable', 'on')
    writeParam(w.db, w.aid, 'memory.judge.gate', 'shadow')
    writeParam(w.db, w.aid, 'memory.judge.mode', 'pick')
    writeParam(w.db, w.aid, 'memory.judge.min_interval_ms', 0)
    const old = addMemory(w.db, w.aid, { text: '检索方案还在比较甲和乙两种做法', type: 'appraisal', fact_key: '用户.检索P.方案' })
    w.db.prepare('UPDATE memory_items SET created_at=? WHERE id=?').run(ago(120), old.id)
    const out = applyWrite(w.db, w.aid, { text: '检索最后定成乙方案了，下周开始执行', fact_key: '用户.检索P.升级' }, (c) => addMemory(w.db, w.aid, {
      text: c.text, type: 'appraisal', fact_key: c.fact_key || c.key || '',
    }), { complete: async () => '{"invalidate":[1]}' })
    await flushJudges()
    const evs = w.db.prepare("SELECT payload FROM events WHERE agent_id=? AND type='memory.judge.pick'").all(w.aid).map((e) => JSON.parse(e.payload))
    check('shadow：写了指认事件', evs.length === 1, evs)
    check('shadow：指认到旧条', evs[0] && evs[0].picked && evs[0].picked[0] === old.id, evs[0])
    check('shadow：旧条没被作废', rowOf(w, old.id).invalid_at === null)
    check('shadow：写入本身是 new', out.action === 'new', out)
  } finally { w.close() }
}

// ⑤ gate 集成：on 才作废
{
  const w = makeWorld()
  try {
    resetJudgeState()
    writeParam(w.db, w.aid, 'memory.judge.enable', 'on')
    writeParam(w.db, w.aid, 'memory.judge.gate', 'on')
    writeParam(w.db, w.aid, 'memory.judge.mode', 'pick')
    writeParam(w.db, w.aid, 'memory.judge.min_interval_ms', 0)
    const old = addMemory(w.db, w.aid, { text: '检索方案还在比较甲和乙两种做法', type: 'appraisal', fact_key: '用户.检索Q.方案' })
    w.db.prepare('UPDATE memory_items SET created_at=? WHERE id=?').run(ago(120), old.id)
    applyWrite(w.db, w.aid, { text: '检索最后定成乙方案了，下周开始执行', fact_key: '用户.检索Q.升级' }, (c) => addMemory(w.db, w.aid, {
      text: c.text, type: 'appraisal', fact_key: c.fact_key || c.key || '',
    }), { complete: async () => '{"invalidate":[1]}' })
    await flushJudges()
    check('on：旧条被作废', rowOf(w, old.id).invalid_at !== null)
    const sup = w.db.prepare("SELECT COUNT(*) n FROM events WHERE agent_id=? AND type='memory.judge.superseded'").get(w.aid).n
    check('on：写了取代事件', sup === 1, sup)
  } finally { w.close() }
}

// ⑥ 空数组：on 也不动
{
  const w = makeWorld()
  try {
    resetJudgeState()
    writeParam(w.db, w.aid, 'memory.judge.enable', 'on')
    writeParam(w.db, w.aid, 'memory.judge.gate', 'on')
    writeParam(w.db, w.aid, 'memory.judge.mode', 'pick')
    writeParam(w.db, w.aid, 'memory.judge.min_interval_ms', 0)
    const old = addMemory(w.db, w.aid, { text: '用户喜欢安静的环境，人一多就累', type: 'appraisal', fact_key: '用户.环境R.偏好' })
    w.db.prepare('UPDATE memory_items SET created_at=? WHERE id=?').run(ago(120), old.id)
    applyWrite(w.db, w.aid, { text: '用户改口了，现在觉得热闹更好', fact_key: '用户.环境R.改口' }, (c) => addMemory(w.db, w.aid, {
      text: c.text, type: 'appraisal', fact_key: c.fact_key || c.key || '',
    }), { complete: async () => '{"invalidate":[]}' })
    await flushJudges()
    check('空指认：旧条不动', rowOf(w, old.id).invalid_at === null)
  } finally { w.close() }
}

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
