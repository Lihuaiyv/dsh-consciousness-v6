/**
 * 动机与计划（plan）：P0 只做"能看见"的那一半。
 *
 * 现在这里只有三样东西：建表、两个写事件的函数。没有任何检查、没有强制、不改行为。
 * 这样后面接上工具和判定时，记账的地方已经在了，比先写逻辑再补观测可靠。
 *
 * 一张表 plan，只追加不改写；每轮可有多版，seq 递增：
 *   motive        这一版为什么值得做（未变写「同前」）
 *   source        动机挂在哪：user / doc / self
 *   items_json    台上待办（最多 3 条）：[{ id, text, done }]
 *   deferred_json 台下延后池（不限条数）：[{ id, text, reason }]
 *   note          这版改了什么、为什么（一句话）
 *   diff_json     代码算的改动明细，不是我填的
 *
 * 两个事件（只记账，给后面判定用）：
 *   plan.submit   交了一版：谁、第几版、几条待办、动机变没变
 *   plan.check    查了一次：查了什么、判定落后没有
 */

// 不引 kernel：db.js 会引本模块，kernel 又经 algo 引回 db，引进 kernel 就成环。
const now = () => new Date().toISOString()
const nid = (prefix) => prefix + Date.now().toString(36) + Math.random().toString(16).slice(2, 8)

const TABLE = 'plan'

/** 建表（幂等）。挂在 openDb 里，和别的模块一样开库就补。 */
export function ensureMotivationSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS ${TABLE}(
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    motive TEXT,
    source TEXT,
    items_json TEXT NOT NULL DEFAULT '[]',
    deferred_json TEXT NOT NULL DEFAULT '[]',
    note TEXT,
    diff_json TEXT,
    submitted_at TEXT NOT NULL
  )`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_plan_turn ON ${TABLE}(agent_id, turn_id, seq)`)
}

function writeEvent(db, agentId, type, payload) {
  try {
    db.prepare('INSERT INTO events VALUES(?,?,?,?,?)')
      .run(nid('evt_'), agentId, type, JSON.stringify(payload), now())
  } catch { /* 记账失败不影响主流程 */ }
}

/** 记一版提交。P0 里没人调它；接上工具后由工具在写表后顺手调。 */
export function logSubmit(db, agentId, { turnId = null, seq = 1, motive = '', items = [], deferred = [], motiveChanged = false } = {}) {
  writeEvent(db, agentId, 'plan.submit', {
    turnId,
    seq: Number(seq) || 1,
    items: Array.isArray(items) ? items.length : 0,
    deferred: Array.isArray(deferred) ? deferred.length : 0,
    motiveChanged: !!motiveChanged,
    motiveLen: String(motive || '').length,
    at: now(),
  })
}

/** 记一次检查。P0 里也没人调它；接上判定后每步调用一次。 */
export function logCheck(db, agentId, { turnId = null, step = null, stale = false, reason = '' } = {}) {
  writeEvent(db, agentId, 'plan.check', {
    turnId, step, stale: !!stale, reason: String(reason || '').slice(0, 120), at: now(),
  })
}

/** 读这一轮最新一版（后面判定/页面要用）。没有就返回 null。 */
export function latestPlan(db, agentId, turnId) {
  try {
    return db.prepare(`SELECT * FROM ${TABLE} WHERE agent_id=? AND turn_id=? ORDER BY seq DESC LIMIT 1`)
      .get(String(agentId), String(turnId)) || null
  } catch { return null }
}
