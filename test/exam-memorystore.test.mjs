/**
 * 记忆存储零件 · 考卷
 *
 * 管的是「一条记忆怎么写进抽屉」：校验 → 去重 / 同键取代 / 冲突 → 落库（FTS / 热度和层 / 事实出生照）
 * → 软删与恢复；外加列表和统计的读口。
 *
 * 不管「这句话值不值得记」（记忆写入闸）、不管「变淡沉层」（记忆衰减与分层）、
 * 不管「怎么召回来」（召回）、不管「夜里怎么压」（记忆整理）。
 *
 * 运行：node test/exam-memorystore.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import {
  addMemory, softDelete, restoreMemory, listActiveMemories, memoryStats,
  setMemoryMark, setMemoryEntity, setFeelProvider, supersedeMany, flushConflictJudges,
} from '../src/modules/memory.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)) }
}
const throws = (fn, code) => {
  try { fn(); return false } catch (e) { return code ? e.status === code : true }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-exam-mem-'))
const db = openDb(path.join(dir, 'app.db'))
const aid = 'agt_exam_mem'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid, '考卷存储', 'daily', 'active', new Date().toISOString())

const byId = (id) => db.prepare('SELECT * FROM memory_items WHERE id=?').get(id)
const ftsOf = (id) => db.prepare('SELECT text FROM memory_fts WHERE id=?').get(id)
const archiveOf = (mid) => db.prepare('SELECT id,text FROM fact_archive WHERE memory_id=?').get(mid)

// ================================================================ 入口校验
{
  check('空正文：拒', throws(() => addMemory(db, aid, { text: '' }), 400))
  check('超长：拒', throws(() => addMemory(db, aid, { text: 'x'.repeat(4001) }), 400))
  check('类型非法：拒', throws(() => addMemory(db, aid, { text: '一句正常的话', type: 'nope' }), 400))
  check('拒掉的没落库', db.prepare('SELECT COUNT(*) n FROM memory_items WHERE agent_id=?').get(aid).n === 0)
}

// ================================================================ 写一条：字段、检索卡、出生照、事件
{
  const out = addMemory(db, aid, {
    text: '主人喝咖啡只喝美式，不加糖。', type: 'fact', source: 'manual',
    importance: 0.7, salience: 0.1, confidence: 0.9, fact_key: 'pref.coffee', turn_id: 'turn_1',
  })
  check('写成功，拿到 id', !!out.id, out)
  const row = byId(out.id)
  check('状态 active、类型/来源对', row && row.status === 'active' && row.type === 'fact' && row.source === 'manual', row)
  check('重要度 / 显著度 / 置信按给的来', row && Number(row.importance) === 0.7 && Number(row.salience) === 0.1 && Number(row.confidence) === 0.9, row)
  check('来源轮次记下了', row && row.source_turn_id === 'turn_1', row)
  check('检索卡：键 + 检索文本', row && row.fact_key === 'pref.coffee' && String(row.search_text || '').length > 0, row)
  check('热度 / 层算过', row && Number.isFinite(Number(row.heat)) && !!row.band, row && { heat: row.heat, band: row.band })
  check('FTS 里有一条', !!ftsOf(out.id), ftsOf(out.id))
  check('事实出生照留了一份', !!archiveOf(out.id), archiveOf(out.id))
  check('写了 memory.written 事件', !!db.prepare("SELECT 1 FROM events WHERE agent_id=? AND type='memory.written'").get(aid))
  check('没有多出冲突', !out.conflict && !out.conflict_id, out)
}

// ================================================================ 重复：同一条不再新建
{
  const again = addMemory(db, aid, { text: '主人喝咖啡只喝美式，不加糖。', type: 'fact' })
  check('完全重复：认出 duplicate', again.duplicate === true, again)
  check('重复时返回原来那条的 id', !!byId(again.id), again)
  check('库里还是一条', db.prepare("SELECT COUNT(*) n FROM memory_items WHERE agent_id=? AND text=?").get(aid, '主人喝咖啡只喝美式，不加糖。').n === 1)
}

// ================================================================ 同键取代：旧说法退场，不删
{
  const old = addMemory(db, aid, { text: '主人住在北京。', type: 'fact', fact_key: 'home.city' })
  const fresh = addMemory(db, aid, { text: '主人搬到上海了。', type: 'fact', fact_key: 'home.city' })
  const o = byId(old.id)
  check('同键旧说法退场', !!o.invalid_at, o)
  check('旧说法指向新条', o.superseded_by === fresh.id, { old: o, fresh: fresh.id })
  check('返回值报出被取代的 id', Array.isArray(fresh.superseded_ids) && fresh.superseded_ids.includes(old.id), fresh)
  check('新说法还活着', byId(fresh.id).status === 'active' && !byId(fresh.id).invalid_at)
}

// ================================================================ 冷 / 软删 / 恢复
{
  const cold = addMemory(db, aid, { text: '这是一条只该深查才想起的旁白。', type: 'episode', cold: true })
  check('cold：落冷层', byId(cold.id).temp_state === 'cold', byId(cold.id))

  const tmp = addMemory(db, aid, { text: '一条用来试软删的话。', type: 'episode' })
  check('软删前在活跃列表里', listActiveMemories(db, aid).some((m) => m.id === tmp.id))
  softDelete(db, tmp.id)
  check('软删：deleted_at 有了', !!byId(tmp.id).deleted_at, byId(tmp.id))
  check('软删后不在活跃列表', !listActiveMemories(db, aid).some((m) => m.id === tmp.id))
  restoreMemory(db, tmp.id)
  check('恢复：deleted_at 清掉', !byId(tmp.id).deleted_at, byId(tmp.id))
  check('恢复后回到活跃列表', listActiveMemories(db, aid).some((m) => m.id === tmp.id))
}

// ================================================================ 标记、实体连边、feel 挂载
{
  const m = addMemory(db, aid, { text: '一条带标记的记忆。', type: 'fact' })
  setMemoryMark(db, m.id, { mark: 'high' })
  check('标记改得动，版本加一', byId(m.id).mark === 'high' && Number(byId(m.id).version) >= 2, byId(m.id))

  const a = addMemory(db, aid, { text: '小周喜欢篮球。', type: 'fact', entity_id: 'ent_zhou' })
  const b = addMemory(db, aid, { text: '小周周末常去球场。', type: 'fact', entity_id: 'ent_zhou' })
  const links = db.prepare('SELECT * FROM memory_links WHERE (from_id=? AND to_id=?) OR (from_id=? AND to_id=?)').all(a.id, b.id, b.id, a.id)
  check('同实体：互连两条边', links.length === 2, links)

  setFeelProvider(() => 'afe_test_1')
  const f = addMemory(db, aid, { text: '写这条的时候正看着窗外。', type: 'episode' })
  check('出生时挂上了 feel 的 id', byId(f.id).feel_id === 'afe_test_1', byId(f.id))
  setFeelProvider(null)
}

// ================================================================ 冲突：同一个人两句话对不上
{
  const yes = addMemory(db, aid, { text: '主人喜欢喝茶。', type: 'fact' })
  const no = addMemory(db, aid, { text: '主人不喜欢喝茶。', type: 'fact' })
  check('第二条判成冲突', no.conflict === true && !!no.conflict_id, { yes: yes.id, no })
  const c = no.conflict_id ? db.prepare('SELECT * FROM conflicts WHERE id=?').get(no.conflict_id) : null
  // 11-10 起「先判后动」：不再当场开卡、不再先作废旧条、不再先挂告警。
  // 考卷里没有模型 → 判官给不出结论，就停在 pending，等人/夜里再判。
  await flushConflictJudges()
  const fresh = no.conflict_id ? db.prepare('SELECT * FROM conflicts WHERE id=?').get(no.conflict_id) : null
  check('不当场开卡（停在 pending）', fresh && fresh.state !== 'open', fresh)
  check('判成取代之前不收旧条', c && c.state === 'pending' ? !byId(yes.id).invalid_at : (fresh && fresh.resolution === 'supersede' ? !!byId(yes.id).invalid_at : true), { c, inv: byId(yes.id).invalid_at })
  check('判之前不催人（没告警）', !db.prepare("SELECT 1 FROM alerts WHERE agent_id=? AND kind='data'").get(aid))
}

// ================================================================ 统计与列表
{
  const stats = memoryStats(db, aid)
  check('统计有总数 / 活跃数', stats && typeof stats === 'object' && ('total' in stats || 'active' in stats || 'count' in stats), stats)
  check('列表带 id 和正文', listActiveMemories(db, aid).every((m) => m.id && typeof m.text === 'string'))
}

console.log('\n通过 ' + pass + ' / ' + (pass + fail))
if (fail) process.exitCode = 1
