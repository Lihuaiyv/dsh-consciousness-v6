/**
 * 整 agent 清除（拍板 2）：账本只增的唯一例外，只在 agent 被硬删时由 ops.purgeExpired 调用。
 * 同一事务：插标记 → 删该 agent 的 L0 / 投影 / 三观 flags → 撤标记。任何一步失败整体回滚，标记不残留。
 */
import { savepoint } from '../../kernel.js'
import { L0_TABLES, PROJ_TABLES } from './schema.js'
import { dropInjectCache } from './inject.js'
import { dropVecCache } from './fast.js'

// 精确键；预算是前缀键（按日 / 周 / 月），用 substr 比较，不用 LIKE（id 里的 _ 是通配符）
const FLAG_KEYS = (aid) => ['sangguan:' + aid, 'sangguan.judge:' + aid, 'sangguan.fast.buf:' + aid, 'sangguan.inject:' + aid, 'sangguan.ask:' + aid]
const FLAG_PREFIX = (aid) => 'sangguan.budget:' + aid + ':'

export function purgeAgent(db, aid) {
  if (typeof aid !== 'string' || !aid) throw new Error('purgeAgent 需要 agent id')
  return savepoint(db, () => {
    db.prepare('INSERT OR IGNORE INTO claim_purge(agent_id) VALUES(?)').run(aid)
    const rows = {}
    for (const t of [...L0_TABLES, ...PROJ_TABLES]) {
      rows[t] = Number(db.prepare(`DELETE FROM ${t} WHERE agent_id=?`).run(aid).changes || 0)
    }
    const keys = FLAG_KEYS(aid)
    const pre = FLAG_PREFIX(aid)
    rows.flags = Number(db.prepare(`DELETE FROM flags WHERE key IN (${keys.map(() => '?').join(',')}) OR substr(key,1,?)=?`)
      .run(...keys, pre.length, pre).changes || 0)
    rows.claim_llm_cache = Number(db.prepare('DELETE FROM claim_llm_cache WHERE agent_id=?').run(aid).changes || 0)
    db.prepare('DELETE FROM claim_purge WHERE agent_id=?').run(aid)
    try { dropInjectCache(db, aid); dropVecCache() } catch { /* 缓存清不掉不影响账本 */ }
    return rows
  })
}

/** agents 表里已经没有、三观数据还在的 agent（上次清除失败留下的），逐个补清；单个失败不挡其余。 */
export function purgeOrphans(db) {
  const ids = new Set(db.prepare('SELECT DISTINCT agent_id FROM claim_events WHERE agent_id NOT IN (SELECT id FROM agents)').all().map((r) => r.agent_id))
  for (const r of db.prepare("SELECT substr(key,10) aid FROM flags WHERE substr(key,1,9)='sangguan:'").all()) {
    if (!db.prepare('SELECT 1 FROM agents WHERE id=?').get(r.aid)) ids.add(r.aid)
  }
  const done = []
  for (const aid of ids) {
    try { purgeAgent(db, aid); done.push(aid) } catch { /* 下次清除再试 */ }
  }
  return done
}
