/**
 * 判官回放：拿库里的冲突喂给判官，只读、不污染缓存。
 * 运行：node test/judge-replay.test.mjs
 */
import { makeWorld } from './eval-persona/setup.mjs'
import { replayConflicts } from '../src/modules/judge_replay.js'
import { addMemory } from '../src/modules/memory.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)) }
}
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString()

function seed(w) {
  const a = addMemory(w.db, w.aid, {
    text: '我好像没有get到你说的那个点，能再说一遍吗', type: 'fact', source: 'test', skipConflict: true,
  })
  const b = addMemory(w.db, w.aid, {
    text: '哦，我我好像能get到了，你把开关交出去那段我明白了', type: 'fact', source: 'test', skipConflict: true,
  })
  w.db.prepare('UPDATE memory_items SET created_at=? WHERE id=?').run(iso(300000), a.id)
  w.db.prepare('UPDATE memory_items SET created_at=? WHERE id=?').run(iso(120000), b.id)
  w.db.prepare(`INSERT INTO conflicts(id,agent_id,a_id,b_id,state,opened_at,severity,kind,evidence)
    VALUES(?,?,?,?, 'open', ?, 'high', 'polarity', ?)`)
    .run('cfl_r1', w.aid, a.id, b.id, iso(60000), '{"via":"gate","similarity":0.62}')
  return { aId: a.id, bId: b.id }
}

// ---- 1. 模型判「补充」：回放如实给出来，且不改冲突状态
{
  const w = makeWorld()
  try {
    seed(w)
    const seen = []
    const out = await replayConflicts(w.db, w.aid, {
      complete: async (req) => { seen.push(req); return '补充' },
      limit: 5,
    })
    check('回放了一对', out.count === 1, out.count)
    check('判官拿到的是两条原话 + 日期', /我好像没有get到/.test(seen[0].text) && /开关交出去/.test(seen[0].text) && !!/旧（/.test(seen[0].text), seen[0])
    check('判定是补充', out.items[0].verdict === 'supplement', out.items[0])
    check('冲突状态没被动', w.db.prepare("SELECT state FROM conflicts WHERE id='cfl_r1'").get().state === 'open')
    check('默认不写判官缓存', Number(w.db.prepare('SELECT COUNT(*) n FROM memory_pair_judge').get().n) === 0)
  } finally { w.close() }
}

// ---- 2. 判「取代」要复核两次（judgePair 的规矩），两次都一致才算
{
  const w = makeWorld()
  try {
    seed(w)
    let n = 0
    const out = await replayConflicts(w.db, w.aid, { complete: async () => { n++; return '取代' }, limit: 5 })
    check('取代要问两次', n === 2, n)
    check('判定是取代', out.items[0].verdict === 'supersede', out.items[0])
  } finally { w.close() }
}

// ---- 3. 没有判官就给明确错误，不假装判过
{
  const w = makeWorld()
  try {
    seed(w)
    const out = await replayConflicts(w.db, w.aid, { complete: null, limit: 5 })
    check('没判官时返回错误码', out.error && out.error.code === 'JUDGE_UNAVAILABLE', out)
  } finally { w.close() }
}

// ---- 4. limit 生效
{
  const w = makeWorld()
  try {
    seed(w)
    const out = await replayConflicts(w.db, w.aid, { complete: async () => '无关', limit: 1 })
    check('limit=1 只回放一条', out.count === 1, out.count)
  } finally { w.close() }
}

console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exitCode = 1
