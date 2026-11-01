/**
 * 想法修补批 F1–F10：逐项验收。
 * 运行：node test/thoughts-f.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, now } from '../src/db.js'
import { attachDb } from '../src/algo/index.js'
import { addMemory } from '../src/modules/memory.js'
import { seedAffect } from '../src/modules/affect.js'
import * as Rel from '../src/modules/relations.js'
import { gather as gatherSelfview } from '../src/modules/selfview.js'
import {
  pickMemories, generateNow, shouldRefresh, getThoughts,
  cooldownHours, memLimit, prompt,
} from '../src/modules/thoughts.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 700)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-thf-'))
const db = openDb(path.join(dir, 'app.db'))
attachDb(db)
const aid = 'agt_thf'
db.prepare("INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)")
  .run(aid, '修补', 'daily', 'active', now())
db.prepare('INSERT INTO persona VALUES(?,?,?,?,?)').run(aid, 'style.address', JSON.stringify('阿明'), 'manual', now())
seedAffect(db, aid)
Rel.bootstrap(db, aid)

function latest() {
  return db.prepare('SELECT * FROM thoughts WHERE agent_id=? ORDER BY created_at DESC LIMIT 1').get(aid)
}
/** 把该 agent 全部想法拨到同样年龄，避免「只改最新一条 → latest() 跳到别的新行」 */
function setThoughtAge(msAgo) {
  const at = new Date(Date.now() - msAgo).toISOString()
  db.prepare('UPDATE thoughts SET created_at=? WHERE agent_id=?').run(at, aid)
  return latest()
}

// ========== F1 冷却 ==========
{
  console.log('\n--- F1 冷却 ---')
  check('F1: 默认冷却 24h', cooldownHours() === 24, cooldownHours())

  await generateNow(db, aid)
  let row = latest()
  // 刚生成：默认不刷
  check('F1: 新鲜不刷', shouldRefresh(db, aid, row).stale === false, shouldRefresh(db, aid, row))

  // 情绪 label 变了，但在 2h 内 → 不刷
  db.prepare("UPDATE affect_state SET primary_label=? WHERE agent_id=?").run('curious', aid)
  row = setThoughtAge(2 * 3600000)
  check('F1: 冷却内 affect 不刷', shouldRefresh(db, aid, row).stale === false, shouldRefresh(db, aid, row))

  // 25h 后 → affect 刷
  row = setThoughtAge(25 * 3600000)
  const af = shouldRefresh(db, aid, row)
  check('F1: 过冷却 affect 刷', af.stale === true && af.reason === 'affect', af)

  // 恢复 calm，重新生成快照
  db.prepare("UPDATE affect_state SET primary_label=? WHERE agent_id=?").run('calm', aid)
  await generateNow(db, aid)

  // heat：冷却内不刷
  row = setThoughtAge(3 * 3600000)
  const hot = addMemory(db, aid, { text: '高热新事：约好见面', type: 'fact', importance: 0.95, salience: 0.9 })
  db.prepare('UPDATE memory_items SET created_at=? WHERE id=?')
    .run(new Date(Date.now() - 1000).toISOString(), hot.id)
  check('F1: 冷却内 heat 不刷', shouldRefresh(db, aid, latest()).stale === false, shouldRefresh(db, aid, latest()))

  row = setThoughtAge(25 * 3600000)
  const ht = shouldRefresh(db, aid, latest())
  check('F1: 过冷却 heat 刷', ht.stale === true && ht.reason === 'heat', ht)

  // address 不受冷却：刚生成后立刻改称呼仍刷
  await generateNow(db, aid)
  db.prepare("UPDATE persona SET value=? WHERE agent_id=? AND path='style.address'").run(JSON.stringify('小柯'), aid)
  const ad = shouldRefresh(db, aid, latest())
  check('F1: address 无视冷却', ad.stale === true && ad.reason === 'address', ad)
  db.prepare("UPDATE persona SET value=? WHERE agent_id=? AND path='style.address'").run(JSON.stringify('阿明'), aid)
  await generateNow(db, aid)
}

// ========== F2 关系真源 ==========
{
  console.log('\n--- F2 关系真源 ---')
  // bootstrap 已有主人；改 closeness 应改 rel_sig
  const owner = Rel.ownerPerson(db, aid)
  check('F2: 有 rel_person 主人', !!owner, owner)

  const snapRow = latest()
  const payload = JSON.parse(snapRow.payload || '{}')
  // 改活账本 closeness
  db.prepare('UPDATE rel_person SET closeness=? WHERE id=?').run(0.99, owner.id)
  const aged = setThoughtAge(25 * 3600000)
  const rel = shouldRefresh(db, aid, aged)
  check('F2: rel_person 变化可触发 relation', rel.stale === true && rel.reason === 'relation', { rel, oldSig: payload.rel_sig })

  // 冷却内 relation 不刷
  setThoughtAge(2 * 3600000)
  check('F2: 冷却内 relation 不刷', shouldRefresh(db, aid, latest()).stale === false, shouldRefresh(db, aid, latest()))

  await generateNow(db, aid) // 刷新快照
}

// ========== F3 other 收紧 ==========
{
  console.log('\n--- F3 other 收紧 ---')
  addMemory(db, aid, { text: '你今天好像很忙', type: 'fact', importance: 0.7 })
  addMemory(db, aid, { text: '阿明喜欢早起', type: 'fact', importance: 0.8 })
  const bare = pickMemories(db, aid, 30, { you: '你', relNames: [] })
  const bareOther = bare.items.filter((x) => x.bucket === 'other')
  check('F3: 裸「你」不进 other', !bareOther.some((x) => /你今天好像很忙/.test(x.text)), bareOther.map((x) => x.text))

  const named = pickMemories(db, aid, 30, { you: '阿明', relNames: ['阿明'] })
  check('F3: 具体称呼进 other', named.items.some((x) => x.bucket === 'other' && /阿明/.test(x.text)), named.items.filter((x) => x.bucket === 'other').map((x) => x.text))
}

// ========== F4 inflight 不双跑 ==========
{
  console.log('\n--- F4 inflight ---')
  db.prepare('UPDATE thoughts SET created_at=? WHERE agent_id=?')
    .run(new Date(Date.now() - 40 * 86400000).toISOString(), aid)
  const before = db.prepare('SELECT COUNT(*) c FROM thoughts WHERE agent_id=?').get(aid).c
  getThoughts(db, aid) // kick
  const out = await generateNow(db, aid) // 应复用
  const after = db.prepare('SELECT COUNT(*) c FROM thoughts WHERE agent_id=?').get(aid).c
  check('F4: POST 复用后 fresh', out.status === 'fresh' && out.items.length === 4, out)
  check('F4: 条数不暴涨', after <= Math.max(before + 1, 20), { before, after })
}

// ========== F5 locked / heat ==========
{
  console.log('\n--- F5 locked+heat ---')
  await generateNow(db, aid)
  // 只留最新一条，避免同时间戳下 latest() 抽到未冻结 payload 的旧行
  {
    const keep = latest()
    db.prepare('DELETE FROM thoughts WHERE agent_id=? AND id<>?').run(aid, keep.id)
    const persons = Rel.listPersons(db, aid) || []
    const maxC = persons.reduce((m, p) => Math.max(m, Number(p.closeness) || 0), 0)
    const snap = {
      address: '阿明',
      affect_label: 'calm',
      rel_sig: persons.length + ':' + maxC.toFixed(2),
      mem_max_created: null,
    }
    db.prepare('UPDATE thoughts SET payload=? WHERE id=?').run(JSON.stringify(snap), keep.id)
    db.prepare("UPDATE affect_state SET primary_label=? WHERE agent_id=?").run('calm', aid)
    db.prepare("UPDATE persona SET value=? WHERE agent_id=? AND path='style.address'").run(JSON.stringify('阿明'), aid)
  }
  setThoughtAge(25 * 3600000)
  const locked = addMemory(db, aid, { text: '钉住新规：别叫错名字', type: 'fact', importance: 0.2 })
  db.prepare("UPDATE memory_items SET mark='locked' WHERE id=?").run(locked.id)
  const lk = shouldRefresh(db, aid, latest())
  check('F5: 新 locked 过冷却触发 heat', lk.stale === true && lk.reason === 'heat', lk)

  // 冷却内：把想法拨到 2h 前（钉住记忆仍更新），应不刷
  setThoughtAge(2 * 3600000)
  // 钉住记忆若早于想法则不算「之后」；再拨记忆到想法之后、仍在冷却窗内
  const th = latest()
  db.prepare('UPDATE memory_items SET created_at=? WHERE id=?')
    .run(new Date(Date.parse(th.created_at) + 60000).toISOString(), locked.id)
  check('F5: 新 locked 冷却内不触发', shouldRefresh(db, aid, latest()).stale === false, shouldRefresh(db, aid, latest()))
}

// ========== F6 selfview 传 you/relNames ==========
{
  console.log('\n--- F6 selfview ---')
  let ok = false
  let detail = null
  try {
    const ctx = gatherSelfview(db, aid)
    ok = Array.isArray(ctx.mems) && ctx.memTotal >= 0
    detail = { mems: ctx.mems.length, total: ctx.memTotal, address: ctx.style && ctx.style.address }
  } catch (e) { detail = String(e && e.message || e) }
  check('F6: selfview gather 可用', ok, detail)
}

// ========== F7 只留 20 ==========
{
  console.log('\n--- F7 prune ---')
  const stamp = Date.now()
  for (let i = 0; i < 30; i++) {
    db.prepare('INSERT INTO thoughts(id,agent_id,self_text,other_text,world_text,want_text,other_label,source,created_at,payload) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run('thf_' + i, aid, 's', 'o', 'w', 't', '阿明', 'rules',
        new Date(stamp - (40 - i) * 60000).toISOString(), JSON.stringify({ address: '阿明' }))
  }
  await generateNow(db, aid)
  const n = db.prepare('SELECT COUNT(*) c FROM thoughts WHERE agent_id=?').get(aid).c
  check('F7: 最多 20 条', n <= 20, n)
}

// ========== F8 total 口径 ==========
{
  console.log('\n--- F8 total ---')
  const a = addMemory(db, aid, { text: '冲突甲：讨厌香菜', type: 'fact', importance: 0.6 })
  const b = addMemory(db, aid, { text: '冲突乙：喜欢香菜', type: 'fact', importance: 0.6 })
  db.prepare('INSERT INTO conflicts(id,agent_id,a_id,b_id,state,opened_at) VALUES(?,?,?,?,?,?)')
    .run('cf_thf', aid, a.id, b.id, 'open', now())
  const picked = pickMemories(db, aid, 22, { you: '阿明' })
  check('F8: total = scanned - banned', picked.total === picked.scanned - picked.banned, picked)
  check('F8: 冲突不在 items', !picked.items.some((x) => x.id === a.id || x.id === b.id), picked.items.map((x) => x.id).slice(0, 5))
}

// ========== F9 env 热读 ==========
{
  console.log('\n--- F9 env ---')
  const prev = process.env.DSHC_THOUGHTS_MEM
  process.env.DSHC_THOUGHTS_MEM = '11'
  check('F9: memLimit 热读', memLimit() === 11, memLimit())
  if (prev === undefined) delete process.env.DSHC_THOUGHTS_MEM
  else process.env.DSHC_THOUGHTS_MEM = prev

  const prevC = process.env.DSHC_THOUGHTS_COOLDOWN_H
  process.env.DSHC_THOUGHTS_COOLDOWN_H = '0'
  check('F9: cooldown 可关', cooldownHours() === 0, cooldownHours())
  if (prevC === undefined) delete process.env.DSHC_THOUGHTS_COOLDOWN_H
  else process.env.DSHC_THOUGHTS_COOLDOWN_H = prevC
}

// ========== F10 prompt / 文案口径 ==========
{
  console.log('\n--- F10 文案 ---')
  const p = prompt({
    name: '修补', days: 1, mode: '日常模式', you: '阿明',
    affect: null, drive: null, relations: [], mems: [], total: 0,
    diaries: [], episodes: [],
  })
  check('F10: 轻哲学在 system', /我是谁/.test(p.system) && /不要引经据典/.test(p.system), p.system.slice(0, 180))
  check('F10: 不谎称旧挑选口号', !/分层 \+ 权重 \+ 近期/.test(p.text), p.text.slice(0, 120))
}

console.log('\n' + pass + ' passed, ' + fail + ' failed')
if (fail) process.exit(1)
