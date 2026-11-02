/**
 * 反刍：选被反复想起的旧事、再看一眼、不改记忆、不写情绪、防螺旋。
 * 运行：node test/selfhood-reap.test.mjs
 */
import { makeWorld } from './eval-persona/setup.mjs'
import { pickReappraiseTarget, reappraiseTick, reappraiseLine, reappraiseChanges, REAP } from '../src/modules/reappraise.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) } else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 500)) }
}
const at = new Date(2026, 10, 2, 15, 0, 0).getTime()
const modelOk = { chat: async () => '现在再看，没那么堵了，但还有点不甘心。' }

function boost(w, textLike, { hits = 4, lastHit = at - 3600000, mark = 'normal', importance = 0.5, created = at - 20 * 86400000 } = {}) {
  const row = w.db.prepare("SELECT id FROM memory_items WHERE agent_id=? AND text LIKE ?").get(w.aid, textLike)
  w.db.prepare('UPDATE memory_items SET hits=?, last_hit_at=?, mark=?, importance=?, created_at=? WHERE id=?')
    .run(hits, new Date(lastHit).toISOString(), mark, importance, new Date(created).toISOString(), row.id)
  return row.id
}

// ---- 1. 不够热不选
{
  const w = makeWorld()
  try {
    w.db.prepare("UPDATE memory_items SET hits=1, last_hit_at=? WHERE agent_id=?").run(new Date(at - 3600000).toISOString(), w.aid)
    check('hits<3 不选', pickReappraiseTarget(w.db, w.aid, at) === null)
  } finally { w.close() }
}

// ---- 2. 热 + 近期被想起 → 选中
{
  const w = makeWorld()
  try {
    const id = boost(w, '%喝咖啡%')
    const target = pickReappraiseTarget(w.db, w.aid, at)
    check('选中被反复想起的那条', !!target && target.id === id, target)
  } finally { w.close() }
}

// ---- 3. 钉住的 / 冲突中的不碰
{
  const w = makeWorld()
  try {
    const id = boost(w, '%喝咖啡%', { mark: 'locked' })
    check('locked 不选', pickReappraiseTarget(w.db, w.aid, at) === null, id)
    w.db.prepare("UPDATE memory_items SET mark='normal' WHERE id=?").run(id)
    w.db.prepare('INSERT INTO conflicts(id,agent_id,a_id,b_id,state,opened_at) VALUES(?,?,?,?,?,?)')
      .run('cfl_reap_1', w.aid, id, 'other', 'open', new Date(at).toISOString())
    check('冲突中不选', pickReappraiseTarget(w.db, w.aid, at) === null)
  } finally { w.close() }
}

// ---- 4. 30 天内反刍过不再选
{
  const w = makeWorld()
  try {
    const id = boost(w, '%喝咖啡%')
    w.db.prepare("INSERT INTO events(id,agent_id,type,payload,created_at) VALUES(?,?,?,?,?)")
      .run('evt_reap_seed', w.aid, 'memory.reappraise', JSON.stringify({ memory_id: id, text: '看过一次', changed: true }), new Date(at - 2 * 86400000).toISOString())
    check('30 天内看过 → 不选', pickReappraiseTarget(w.db, w.aid, at) === null)
  } finally { w.close() }
}

// ---- 5. 螺旋：连续两次没变淡 → 停 90 天
{
  const w = makeWorld()
  try {
    const id = boost(w, '%喝咖啡%')
    for (let i = 0; i < 2; i++) {
      w.db.prepare("INSERT INTO events(id,agent_id,type,payload,created_at) VALUES(?,?,?,?,?)")
        .run('evt_flat_' + i, w.aid, 'memory.reappraise', JSON.stringify({ memory_id: id, text: '还是难受', changed: false }), new Date(at - (40 + i) * 86400000).toISOString())
    }
    check('两次没变淡 → 90 天不碰', pickReappraiseTarget(w.db, w.aid, at) === null)
  } finally { w.close() }
}

// ---- 6. 没模型：跳过，不写空话
{
  const w = makeWorld()
  try {
    boost(w, '%喝咖啡%')
    const out = await reappraiseTick(w.db, w.aid, { at, model: null })
    check('没模型 skip no_model', out.ok === false && out.skipped === 'no_model', out)
    check('没有写事件', w.db.prepare("SELECT COUNT(*) n FROM events WHERE agent_id=? AND type='memory.reappraise'").get(w.aid).n === 0)
  } finally { w.close() }
}

// ---- 7. 正常反刍：变淡判定 + 不改记忆
{
  const w = makeWorld()
  try {
    const id = boost(w, '%喝咖啡%', { created: at - 20 * 86400000 })
    // 当时的情绪：有点难受
    w.db.prepare('INSERT INTO affect_samples(id,agent_id,at,label,intensity,fast,slow) VALUES(?,?,?,?,?,?,?)')
      .run('as_before', w.aid, new Date(at - 19 * 86400000).toISOString(), 'sad', 0.8, '0', '0')
    // 现在：淡了
    w.db.prepare('UPDATE affect_state SET primary_label=?, intensity=? WHERE agent_id=?').run('calm', 0.25, w.aid)
    const beforeText = w.db.prepare('SELECT text, hits FROM memory_items WHERE id=?').get(id)
    const out = await reappraiseTick(w.db, w.aid, { at, model: modelOk })
    check('反刍成功', out.ok === true && out.memory_id === id, out)
    check('判定变淡', out.changed === true, out.changed)
    check('事件写进库', w.db.prepare("SELECT COUNT(*) n FROM events WHERE agent_id=? AND type='memory.reappraise'").get(w.aid).n === 1)
    const afterText = w.db.prepare('SELECT text, hits FROM memory_items WHERE id=?').get(id)
    check('记忆原文没被改', afterText.text === beforeText.text && afterText.hits === beforeText.hits, afterText)
    const line = reappraiseLine(w.db, w.aid, at)
    check('注入说「后来再看」', line.includes('后来再看') && line.includes('不甘心'), line)
    check('自述能拿到变化', reappraiseChanges(w.db, w.aid, at).length === 1)
  } finally { w.close() }
}

// ---- 8. 开关
{
  const w = makeWorld()
  try {
    boost(w, '%喝咖啡%')
    w.db.prepare('INSERT OR REPLACE INTO agent_params(agent_id,key,value,updated_at) VALUES(?,?,?,?)')
      .run(w.aid, 'reappraise.enabled', JSON.stringify('off'), new Date(at).toISOString())
    check('关掉后不选', pickReappraiseTarget(w.db, w.aid, at) === null)
    check('关掉后注入为空', reappraiseLine(w.db, w.aid, at) === '')
  } finally { w.close() }
}

console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exit(1)
