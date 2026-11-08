/**
 * S1：claim 规则标注单测。
 * 运行：node test/claim-state.test.mjs
 */
import { makeWorld } from './eval-persona/setup.mjs'
import { addMemory } from '../src/modules/memory.js'
import { writeParam } from '../src/kernel.js'
import { classifyClaim, syncClaims, setClaimState, claimOf, pendingClaims, claimStats } from '../src/modules/claim_state.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) } else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 300)) }
}
const ago = (days) => new Date(Date.now() - days * 86400000).toISOString()

// ① 规则样本
const samples = [
  ['还没做完，先记一笔', 'pending'],
  ['做完了，可以收了', 'done'],
  ['已完成了', 'done'],
  ['已经上线了', 'done'],
  ['还没上线', 'pending'],
  ['我打算趁对方休息，把躯干拆成清单', 'pending'],
  ['我记着两项未完成的事：躯干还没收尾', 'pending'],
  ['用户喜欢冰美式', 'na'],
  ['用户要求每一步都先测试', 'na'],
  ['计划要改三个文件', 'pending'],
  ['下周要提交', 'pending'],
  ['等这版定下来再说', 'pending'],
  ['修好了', 'done'],
  ['搞定了', 'done'],
  ['没提交', 'pending'],
  ['可以了', 'done'],
  ['短', 'na'],
  ['用户问语气这块怎么调', 'na'],
  ['已经改好了', 'done'],
  ['之后要做两件事', 'pending'],
]
for (const [text, want] of samples) {
  const got = classifyClaim(text)
  check('分类：' + text.slice(0, 12), got.state === want, { got: got.state, want })
}

// ② DB 行为
{
  const w = makeWorld()
  try {
    writeParam(w.db, w.aid, 'memory.claim.enable', 'shadow')
    const a = addMemory(w.db, w.aid, { text: '这件事还没做完，先记一笔', type: 'episode' })
    const b = addMemory(w.db, w.aid, { text: '用户喜欢冰美式，不加糖', type: 'fact' })
    const c = addMemory(w.db, w.aid, { text: '这件事已经做完了', type: 'episode' })

    check('addMemory 自动标 pending', claimOf(w.db, w.aid, a.id) && claimOf(w.db, w.aid, a.id).state === 'pending', claimOf(w.db, w.aid, a.id))
    const ca = syncClaims(w.db, w.aid, w.db.prepare('SELECT * FROM memory_items WHERE id=?').get(a.id))
    syncClaims(w.db, w.aid, w.db.prepare('SELECT * FROM memory_items WHERE id=?').get(b.id))
    const cc = syncClaims(w.db, w.aid, w.db.prepare('SELECT * FROM memory_items WHERE id=?').get(c.id))

    check('pending 落了行', ca && ca.state === 'pending', ca)
    check('na 不落行', claimOf(w.db, w.aid, b.id) === null)
    check('done 落了行', cc && cc.state === 'done', cc)

    setClaimState(w.db, w.aid, a.id, 'done', { via: 'test', evidenceId: c.id })
    const after = claimOf(w.db, w.aid, a.id)
    check('setClaimState 改状态', after && after.state === 'done', after)
    check('setClaimState 带 evidence', after && after.evidence_id === c.id, after && after.evidence_id)

    setClaimState(w.db, w.aid, a.id, 'na')
    check('setClaimState(na) 删行', claimOf(w.db, w.aid, a.id) === null)

    const stats = claimStats(w.db, w.aid)
    check('claimStats 统计', stats.pending === 0 && stats.done === 1, stats)
  } finally { w.close() }
}

// ③ pendingClaims 过滤（active / pending / 年龄）
{
  const w = makeWorld()
  try {
    const old = addMemory(w.db, w.aid, { text: '旧事：还没做完，等通知', type: 'episode' })
    w.db.prepare('UPDATE memory_items SET created_at=? WHERE id=?').run(ago(5), old.id)
    setClaimState(w.db, w.aid, old.id, 'pending', { via: 'test' })
    const fresh = addMemory(w.db, w.aid, { text: '新事：还没做完，刚记的', type: 'episode' })
    setClaimState(w.db, w.aid, fresh.id, 'pending', { via: 'test' })

    const all = pendingClaims(w.db, w.aid, { minAgeDays: 0 })
    check('pendingClaims 含两条', all.length === 2, all.map((x) => x.text))
    const aged = pendingClaims(w.db, w.aid, { minAgeDays: 1 })
    check('pendingClaims 按年龄过滤', aged.length === 1 && aged[0].memory_id === old.id, aged.map((x) => x.text))

    const dead = addMemory(w.db, w.aid, { text: '这条已作废：还没做完', type: 'episode' })
    setClaimState(w.db, w.aid, dead.id, 'pending', { via: 'test' })
    w.db.prepare('UPDATE memory_items SET invalid_at=? WHERE id=?').run(ago(1), dead.id)
    const alive = pendingClaims(w.db, w.aid, { minAgeDays: 0 })
    check('pendingClaims 排除已作废', !alive.some((x) => x.memory_id === dead.id), alive.map((x) => x.memory_id))
  } finally { w.close() }
}

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
