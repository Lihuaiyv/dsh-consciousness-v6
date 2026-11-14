/**
 * 那件事浮现：拼一次真的提示词，看账是不是只在「这句话还留着」时才写。
 *   node test/emotion-surface-sim.mjs
 *
 * 不调模型。验的是：
 *   挤掉 → 不记账，放宽预算后还能再冒
 *   留住 → 只记一笔，而且带 kept
 *   清掉进程内的表（当重启）→ 不再冒
 *   旧账没有 kept → 不挡这辈子，但算进今天三次
 *   不够强 / 刚说完 / 机器消息 / 开关关掉 → 不冒
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { writeParam } from '../src/kernel.js'
import { clampInjection } from '../src/modules/pack.js'
import { consciousnessBlock, resetEventSurfaceMemory } from '../index.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name + '  ' + JSON.stringify(detail === undefined ? '' : detail).slice(0, 500)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-surf-'))
const db = openDb(path.join(dir, 'app.db'))
const now = Date.now()
const iso = (ms) => new Date(ms).toISOString()
const MIN = 60000

function mkAgent(name) {
  const aid = 'agt_' + name
  db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
    .run(aid, name, 'daily', 'active', iso(now))
  db.prepare(`INSERT INTO affect_state(agent_id,primary_label,secondary_label,intensity,mood,pleasure,arousal,dominance,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(aid, 'frustrated', null, 0.6, 0.4, -0.2, 0.3, 0.2, iso(now))
  return aid
}
function addEp(aid, id, o = {}) {
  db.prepare(`INSERT INTO affect_episodes(id, agent_id, cause, appraisal, label, intensity, resolution, started_at, ended_at, renewals, rise_from, rise_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, aid, o.cause, null, 'frustrated', o.intensity ?? 0.62,
    null, o.startedAt ?? iso(now - 40 * MIN), null, 0, 0.2, iso(now - 30 * MIN),
  )
}
function surfaces(aid) {
  return db.prepare("SELECT payload FROM events WHERE agent_id=? AND type='affect.surface' ORDER BY created_at").all(aid)
    .map((r) => JSON.parse(r.payload))
}
function run(aid) {
  resetEventSurfaceMemory()
  return consciousnessBlock(db, aid)
}

// 预算认得出三种「自己冒上来」的开头，整行丢掉，不剪半句。
{
  const filler = '关于这句话，你能想起的事：\n' + '- 一件无关的旧事。'.repeat(8)
  const long = '你说得太重了'.repeat(30)
  const lines = [
    '## 意识体：小汐',
    filler,
    { text: '（那件事还没过去，忽然又浮上来）：\n- ' + long, key: 'spontaneous' },
  ]
  const tight = clampInjection(lines, 40)
  check('预算紧：那件事整行丢掉', tight.dropped.includes('spontaneous') && !tight.text.includes('你说得太重了'), { dropped: tight.dropped, head: tight.text.slice(0, 80) })
  check('预算紧：丢掉的不算留住', tight.kept.has('spontaneous') === false)
  const echo = clampInjection([
    '## 意识体：小汐',
    { text: '（你想起了他那天说过的一句——是引用，不是你此刻的念头）：\n- ' + '原话'.repeat(40), key: 'spontaneous' },
  ], 40)
  check('预算紧：引用那句也整行丢', !echo.text.includes('原话') && echo.kept.has('spontaneous') === false, { dropped: echo.dropped, head: echo.text.slice(0, 80) })
}

// 挤掉之后不记账；放宽之后才记一笔。
{
  const aid = mkAgent('squeeze')
  addEp(aid, 'ep_sq', { cause: '你说得太重了让我缓一缓' })
  writeParam(db, aid, 'memory.inject.budget', 40)
  const dropped = run(aid)
  const afterDrop = surfaces(aid)
  check('挤掉时提示词里没有那句', !dropped.includes('你说得太重了'), dropped.slice(0, 120))
  check('挤掉时不记账', afterDrop.length === 0, afterDrop)
  writeParam(db, aid, 'memory.inject.budget', 4000)
  const kept = run(aid)
  const afterKeep = surfaces(aid)
  check('放宽后那句在', kept.includes('你说得太重了') && kept.includes('忽然又浮上来'), kept.includes('忽然又浮上来'))
  check('放宽后只记一笔且标了真留住', afterKeep.length === 1 && afterKeep[0].kept === true && afterKeep[0].episode_id === 'ep_sq', afterKeep)
  const again = run(aid)
  check('再拼一次不再出现', !again.includes('你说得太重了'))
  check('再拼一次不加第二笔', surfaces(aid).length === 1)
  resetEventSurfaceMemory()
  const restarted = consciousnessBlock(db, aid)
  check('清掉内存再拼（当重启）仍不冒', !restarted.includes('你说得太重了'))
  check('重启后账还是一笔', surfaces(aid).length === 1)
}

// 旧账没有 kept：不挡这辈子，但三笔占满今天。
{
  const aid = mkAgent('legacy')
  addEp(aid, 'ep_old', { cause: '这件事还挂着没说完' })
  const ins = db.prepare('INSERT INTO events(id,agent_id,type,payload,created_at) VALUES(?,?,?,?,?)')
  for (let i = 0; i < 3; i++) {
    ins.run('leg_' + i, aid, 'affect.surface', JSON.stringify({ episode_id: 'ep_other_' + i }), iso(now))
  }
  writeParam(db, aid, 'memory.inject.budget', 4000)
  const text = run(aid)
  check('今天已有三笔旧账就不再冒', !text.includes('这件事还挂着没说完'))
  check('旧账本身没有被改成 kept', surfaces(aid).every((p) => p.kept !== true))
}
{
  const aid = mkAgent('legacy_one')
  addEp(aid, 'ep_one', { cause: '只记过一笔但没留住' })
  db.prepare('INSERT INTO events(id,agent_id,type,payload,created_at) VALUES(?,?,?,?,?)')
    .run('leg_one', aid, 'affect.surface', JSON.stringify({ episode_id: 'ep_one' }), iso(now))
  writeParam(db, aid, 'memory.inject.budget', 4000)
  const text = run(aid)
  check('没标真留住的旧账不挡这件再冒', text.includes('只记过一笔但没留住'), text.includes('忽然又浮上来'))
  const rows = surfaces(aid)
  check('再冒之后新账带 kept，旧账还在', rows.length === 2 && rows.some((p) => p.kept === true) && rows.some((p) => p.kept !== true), rows)
}

// 门槛没过：不冒、不记账。
{
  const aid = mkAgent('weak')
  addEp(aid, 'ep_w', { cause: '轻得不该冒出来', intensity: 0.2 })
  writeParam(db, aid, 'memory.inject.budget', 4000)
  check('不够强不冒', !run(aid).includes('轻得不该冒出来') && surfaces(aid).length === 0)
}
{
  const aid = mkAgent('fresh')
  addEp(aid, 'ep_f', { cause: '刚说完不该复读', startedAt: iso(now - 5 * MIN), })
  writeParam(db, aid, 'memory.inject.budget', 4000)
  check('刚说完不冒', !run(aid).includes('刚说完不该复读') && surfaces(aid).length === 0)
}
{
  const aid = mkAgent('machine')
  addEp(aid, 'ep_m', { cause: 'system-reminder 这不是人话' })
  writeParam(db, aid, 'memory.inject.budget', 4000)
  check('机器消息不冒', !run(aid).includes('system-reminder') && surfaces(aid).length === 0)
}
{
  const aid = mkAgent('off')
  addEp(aid, 'ep_off', { cause: '开关关掉就安静' })
  writeParam(db, aid, 'memory.inject.budget', 4000)
  writeParam(db, aid, 'affect.event.surface', 'off')
  check('开关关掉不冒', !run(aid).includes('开关关掉就安静') && surfaces(aid).length === 0)
}

console.log('')
console.log('通过 ' + pass + ' / ' + (pass + fail))
process.exit(fail ? 1 : 0)
