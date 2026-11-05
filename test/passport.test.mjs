/**
 * S1 护照测试：给一条记忆算「四时间 + 来源」；只有旧/有更新的行才显示。
 *
 * 要保证：
 *   1) 同主题更晚说法 → 旧条护照显示「有更新的说法」；
 *   2) 新条不显示；无 fact_key 不显示；
 *   3) 只读：不 touch（hits 不涨）；
 *   4) 注入（consciousnessBlock / packMemoryBlock）里能看到那一小句。
 *
 * 运行：node test/passport.test.mjs
 */
import { makeWorld } from './eval-persona/setup.mjs'
import { addMemory } from '../src/modules/memory.js'
import { stampRow, passportLine, topicOfFactKey } from '../src/modules/passport.js'
import { consciousnessBlock, packMemoryBlock } from '../index.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) } else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)) }
}

// ① 主题段提取
check('fact_key 主题段', topicOfFactKey('用户.情绪快照.待完成') === '情绪快照', topicOfFactKey('用户.情绪快照.待完成'))
check('无 fact_key 返回空', topicOfFactKey('') === '' && topicOfFactKey(null) === '')

// ② 旧条 → 有更新；新条 → 不显示
{
  const w = makeWorld()
  try {
    const old = addMemory(w.db, w.aid, { text: '用户有一个「情绪快照」的事还没做完，被提醒后仍在等其完成', type: 'fact', fact_key: '用户.情绪快照.待完成' })
    w.db.prepare('UPDATE memory_items SET created_at=? WHERE id=?')
      .run(new Date(Date.now() - 3 * 3600000).toISOString(), old.id)
    const fresh = addMemory(w.db, w.aid, { text: '好像是做好了情绪快照，还做了点别的', type: 'fact', fact_key: '助手.情绪快照.完成' })

    const oldRow = w.db.prepare('SELECT * FROM memory_items WHERE id=?').get(old.id)
    const freshRow = w.db.prepare('SELECT * FROM memory_items WHERE id=?').get(fresh.id)
    const stamp = stampRow(w.db, w.aid, oldRow)
    check('旧条护照有失效时间', !!stamp.validUntil && stamp.topic === '情绪快照', stamp)
    const line = passportLine(w.db, w.aid, oldRow)
    // 阶段 B：不同 key、只靠「还没→做好了」判出来的，降级为状态词对——说得出当时怎样，但不挤。
    check('旧条显示「当时还没做完」', line.includes('当时还没做完') && line.includes('已经做完了'), line)
    check('新条不显示', passportLine(w.db, w.aid, freshRow) === '', passportLine(w.db, w.aid, freshRow))

    const noKey = addMemory(w.db, w.aid, { text: '一条没有 fact_key 的旧记忆', type: 'fact' })
    w.db.prepare('UPDATE memory_items SET created_at=? WHERE id=?').run(new Date(Date.now() - 5 * 3600000).toISOString(), noKey.id)
    const noKeyRow = w.db.prepare('SELECT * FROM memory_items WHERE id=?').get(noKey.id)
    check('无 fact_key 不显示', passportLine(w.db, w.aid, noKeyRow) === '')
  } finally { w.close() }
}

// ②b 同一个 key 的确定更新：仍显示「有更新的说法」（阶段 B 回归）
{
  const w = makeWorld()
  try {
    const a = addMemory(w.db, w.aid, { text: '咖啡的偏好还没定下来，等之后再说', type: 'fact', fact_key: '用户.咖啡.偏好' })
    const b = addMemory(w.db, w.aid, { text: '咖啡的偏好已经定下来了', type: 'fact', fact_key: '用户.咖啡.偏好' })
    // 写入时会把 a 作废；复活它，模拟「同 key 两条并存」的历史数据
    w.db.prepare('UPDATE memory_items SET invalid_at=NULL, superseded_by=NULL WHERE id=?').run(a.id)
    w.db.prepare('UPDATE memory_items SET created_at=? WHERE id=?').run(new Date(Date.now() - 2 * 3600000).toISOString(), a.id)
    w.db.prepare('UPDATE memory_items SET created_at=? WHERE id=?').run(new Date(Date.now() - 3600000).toISOString(), b.id)
    const rowA = w.db.prepare('SELECT * FROM memory_items WHERE id=?').get(a.id)
    const line = passportLine(w.db, w.aid, rowA)
    check('同 key 更新：显示「有更新的说法」', line.includes('有更新的说法'), line)
    check('同 key 更新：不是状态词对文案', !line.includes('当时还没做完'), line)
  } finally { w.close() }
}

// ③ 注入里能看到
{
  const w = makeWorld()
  try {
    // 清掉 makeWorld 铺的三条 fact，确保旧条进得了兜底块前四条
    w.db.prepare('DELETE FROM memory_items WHERE agent_id=?').run(w.aid)
    // S1 只测「标注」：先把 S3 的挤出关掉，否则旧条会被挤出去
    w.db.prepare('INSERT OR REPLACE INTO agent_params(agent_id,key,value,updated_at) VALUES(?,?,?,?)')
      .run(w.aid, 'memory.stale.eject', JSON.stringify('off'), new Date().toISOString())
    const old = addMemory(w.db, w.aid, { text: '用户有一个「情绪快照」的事还没做完，被提醒后仍在等其完成', type: 'fact', fact_key: '用户.情绪快照.待完成' })
    w.db.prepare('UPDATE memory_items SET created_at=? WHERE id=?')
      .run(new Date(Date.now() - 3 * 3600000).toISOString(), old.id)
    addMemory(w.db, w.aid, { text: '好像是做好了情绪快照，还做了点别的', type: 'fact', fact_key: '助手.情绪快照.完成' })

    const block = consciousnessBlock(w.db, w.aid)
    check('兜底记忆块里有护照', block.includes('当时还没做完'), block.slice(0, 260))

    const row = w.db.prepare('SELECT * FROM memory_items WHERE id=?').get(old.id)
    const packed = packMemoryBlock(w.db, w.aid, [{ ...row, partition: 'T1' }], 400)
    check('检索块里有护照', packed.text.includes('当时还没做完'), packed.text)
  } finally { w.close() }
}

// ④ 只读：调用前后 hits 不变
{
  const w = makeWorld()
  try {
    const old = addMemory(w.db, w.aid, { text: '用户有一个「情绪快照」的事还没做完', type: 'fact', fact_key: '用户.情绪快照.待完成' })
    const before = w.db.prepare('SELECT id, hits FROM memory_items WHERE agent_id=? ORDER BY id').all(w.aid)
    w.db.prepare('SELECT * FROM memory_items WHERE id=?').get(old.id)
    const row = w.db.prepare('SELECT * FROM memory_items WHERE id=?').get(old.id)
    passportLine(w.db, w.aid, row)
    const after = w.db.prepare('SELECT id, hits FROM memory_items WHERE agent_id=? ORDER BY id').all(w.aid)
    check('护照不加热记忆', JSON.stringify(before) === JSON.stringify(after), { before, after })
  } finally { w.close() }
}

// ⑤ 弱标默认不显示；打开才显示
{
  const w = makeWorld()
  try {
    w.db.prepare('DELETE FROM memory_items WHERE agent_id=?').run(w.aid)
    const old = addMemory(w.db, w.aid, { text: '用户给猫买了猫粮，牌子是冠能', type: 'fact', fact_key: '用户.喂养.猫' })
    w.db.prepare('UPDATE memory_items SET created_at=? WHERE id=?')
      .run(new Date(Date.now() - 3 * 3600000).toISOString(), old.id)
    addMemory(w.db, w.aid, { text: '用户给猫买了新的猫粮，还换了碗', type: 'fact', fact_key: '用户.喂养.猫粮' })
    const row = w.db.prepare('SELECT * FROM memory_items WHERE id=?').get(old.id)
    check('弱标默认不显示', passportLine(w.db, w.aid, row) === '', passportLine(w.db, w.aid, row))
    const weak = passportLine(w.db, w.aid, row, { weak: 'on' })
    check('打开弱标才显示', weak.includes('同主题后面'), weak)
  } finally { w.close() }
}

console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exitCode = 1
