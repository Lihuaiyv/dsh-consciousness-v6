/**
 * 自我框架 v1 的漏洞修复回归：来源徽章 / persona 回滚 / changes 指标 / 冲突去重 / pending TTL / events 索引。
 * 运行：node test/selfhood-fixes.test.mjs
 */
import { makeWorld } from './eval-persona/setup.mjs'
import { memoryTag } from '../src/modules/memory_tag.js'
import { restorePersonaFromChange, rollbackChange, metricSnapshot } from '../src/modules/selfmod.js'
import { askAboutConflict } from '../src/modules/conflict_ask.js'
import { purgeExpired } from '../src/modules/ops.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) } else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)) }
}
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString()

// ---- 1. memoryTag：她自己看到的事，不能混成「你之前说」
{
  const now = Date.now()
  check('life 记忆带「我自己看到的」', memoryTag({ source: 'life', created_at: new Date(now).toISOString() }, now).includes('我自己看到的'))
  check('chat 记忆照旧，不加来源', memoryTag({ source: 'chat', created_at: new Date(now).toISOString() }, now) === '')
  check('老来源 + 老年龄，逐字不变', memoryTag({ source: 'extract', created_at: new Date(now - 40 * 86400000).toISOString() }, now) === '（1 个月前，有点糊）')
  check('life + 老年龄，来源在前', memoryTag({ source: 'life', created_at: new Date(now - 40 * 86400000).toISOString() }, now) === '（我自己看到的，1 个月前，有点糊）')
}

// ---- 2. persona 回滚：改语气 → 回滚 → 读回原值
{
  const w = makeWorld()
  try {
    const cur = JSON.parse(w.db.prepare("SELECT value FROM persona WHERE agent_id=? AND path='style.tone'").get(w.aid).value)
    check('先有原语气', cur === '可爱粘人', cur)

    const ch = { id: 'chg_test_persona', proposal_id: null, agent_id: w.aid, field: 'persona.style.tone', before: JSON.stringify(cur), after: JSON.stringify('冷淡') }
    w.db.prepare('INSERT INTO changes VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(ch.id, null, w.aid, ch.field, ch.before, ch.after, iso(1000), 'user', 'self', 'self-authorship', null, null)
    // 模拟「她改了」：写入新值
    w.db.prepare('INSERT OR REPLACE INTO persona VALUES(?,?,?,?,?)').run(w.aid, 'style.tone', JSON.stringify('冷淡'), 'auto', iso(1000))
    check('改动后是新值', JSON.parse(w.db.prepare("SELECT value FROM persona WHERE agent_id=? AND path='style.tone'").get(w.aid).value) === '冷淡')

    check('restorePersonaFromChange 认得 persona 字段', restorePersonaFromChange(w.db, ch) === true)
    check('回滚后读回原语气', JSON.parse(w.db.prepare("SELECT value FROM persona WHERE agent_id=? AND path='style.tone'").get(w.aid).value) === '可爱粘人')

    // rollbackChange 老路径也要带上 persona
    const ch2 = { id: 'chg_test_persona2', agent_id: w.aid, field: 'persona.style.tone', before: JSON.stringify('温柔'), after: JSON.stringify('可爱粘人') }
    w.db.prepare('INSERT INTO changes VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(ch2.id, null, w.aid, ch2.field, ch2.before, ch2.after, iso(500), 'user', 'self', 'self-authorship', null, null)
    w.db.prepare('INSERT OR REPLACE INTO persona VALUES(?,?,?,?,?)').run(w.aid, 'style.tone', JSON.stringify('可爱粘人'), 'auto', iso(500))
    rollbackChange(w.db, ch2.id, 'user')
    check('rollbackChange 也恢复 persona', JSON.parse(w.db.prepare("SELECT value FROM persona WHERE agent_id=? AND path='style.tone'").get(w.aid).value) === '温柔')
  } finally { w.close() }
}

// ---- 3. changes 指标：她自己改样子，不背 selfmod 的回滚率
{
  const w = makeWorld()
  try {
    w.db.prepare('INSERT INTO changes VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
      .run('chg_m1', null, w.aid, 'memory.inject.pool', '50', '55', iso(3000), 'system', 'system', 'auto', null, null)
    w.db.prepare('INSERT INTO changes VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
      .run('chg_m2', null, w.aid, 'persona.style.tone', '"a"', '"b"', iso(2000), 'user', 'self', 'self-authorship', iso(1000), null)
    const snap = metricSnapshot(w.db, w.aid)
    check('指标只算 selfmod 的 changes（1 条，回滚 0）', snap['self.rollback_rate'] === 0, snap)
  } finally { w.close() }
}

// ---- 4. 冲突去重：同一对说法、不同 conflict id，7 天只问一次
{
  const w = makeWorld()
  try {
    const ev = JSON.stringify({ attribute: { sentence_a: '咖啡是酸的', sentence_b: '咖啡是热的' } })
    const ins = w.db.prepare(`INSERT INTO conflicts(id,agent_id,a_id,b_id,state,opened_at,evidence)
      VALUES(?,?,?,?,?,?,?)`)
    ins.run('cfl_1', w.aid, 'm1', 'm2', 'open', iso(1000), ev)
    const first = askAboutConflict(w.db, w.aid, { cid: 'cfl_1', aId: 'm1', bId: 'm2', aText: '咖啡是酸的', bText: '咖啡是热的' })
    check('第一对冲突会问', !!first && first.text.includes('咖啡是酸的'), first)

    // 同义改写：标点不同、语序对调
    ins.run('cfl_2', w.aid, 'm3', 'm4', 'open', iso(500), JSON.stringify({ attribute: { sentence_a: '咖啡是热的。', sentence_b: '咖啡，是酸的' } }))
    const second = askAboutConflict(w.db, w.aid, { cid: 'cfl_2', aId: 'm3', bId: 'm4', aText: '咖啡是热的。', bText: '咖啡，是酸的' })
    check('同一对说法 7 天内不再问', second === null, second)

    ins.run('cfl_3', w.aid, 'm5', 'm6', 'open', iso(500), JSON.stringify({ attribute: { sentence_a: '他喜欢猫', sentence_b: '他对猫过敏' } }))
    const third = askAboutConflict(w.db, w.aid, { cid: 'cfl_3', aId: 'm5', bId: 'm6', aText: '他喜欢猫', bText: '他对猫过敏' })
    check('不同的一对仍然会问', !!third, third)
  } finally { w.close() }
}

// ---- 5. 陈年 pending 清理
{
  const w = makeWorld()
  try {
    const ins = w.db.prepare('INSERT INTO proactive(id,agent_id,text,reason,dim,state,created_at,delivered_at) VALUES(?,?,?,?,?,?,?,?)')
    ins.run('prc_old', w.aid, '很久以前的问候', 'test', 'R', 'pending', iso(8 * 86400000), null)
    ins.run('prc_new', w.aid, '刚排的问候', 'test', 'R', 'pending', iso(1000), null)
    const out = purgeExpired(w.db)
    check('清理返回 staleProactive', out.staleProactive >= 1, out)
    check('8 天前的 pending 作废', w.db.prepare("SELECT state FROM proactive WHERE id='prc_old'").get().state === 'expired')
    check('刚排的还在', w.db.prepare("SELECT state FROM proactive WHERE id='prc_new'").get().state === 'pending')
  } finally { w.close() }
}

// ---- 6. events 索引
{
  const w = makeWorld()
  try {
    const names = w.db.prepare("PRAGMA index_list('events')").all().map((r) => r.name)
    check('events 有 agent+时间索引', names.includes('idx_event_agent'), names)
  } finally { w.close() }
}

console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exit(1)
