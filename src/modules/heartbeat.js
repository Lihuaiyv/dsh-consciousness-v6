/**
 * 每实例心跳（schema 12）。
 *
 * 以前是「一个 10 分钟的全局 tick，遍历所有 active」：看不出谁停了，多实例会一起撞车，
 * 失败也没有退避。现在改成：
 *
 *   一个 30 秒的扫描器 → 看 heartbeats.next_at 到期没有 → 每人跑一次
 *   ├─ light（零模型，必跑，目标 <20ms）：情绪墙钟衰减 / 浮现候选 / 开环到期 /
 *   │        驱力日结与休眠判定 / 在场状态刷新
 *   └─ deep（可能调模型，节流 + 全局并发闸）：主动开口入队与推送 / 长偏好
 *
 * 三条约束：
 *   1. light 绝不许调模型（测试里显式断言：light 期间 deep=0 次模型调用）。
 *   2. 失败退避：连续 3 次 → 间隔 ×2（上限 30 分钟）；成功一次就回落。
 *   3. 抖动：下一次到期 = 现在 + 间隔 × U(0.9, 1.1)，避免所有实例同一秒醒。
 */
import { now } from '../db.js'

export const LIGHT_MS = 5 * 60 * 1000
export const DEEP_MS = 15 * 60 * 1000
export const MAX_INTERVAL_MS = 30 * 60 * 1000
/** 连续失败几次开始退避 */
export const BACKOFF_AFTER = 3

function jitter(ms, rand = Math.random) {
  return Math.round(ms * (0.9 + 0.2 * rand()))
}

/** 让每个活着的实例都有一行心跳账（新实例首批错开，不在同一秒醒）。 */
export function ensureRows(db, at = Date.now(), rand = Math.random) {
  const ids = db.prepare("SELECT id FROM agents WHERE status='active'").all().map((r) => r.id)
  for (const aid of ids) {
    const row = db.prepare('SELECT agent_id FROM heartbeats WHERE agent_id=?').get(aid)
    if (row) continue
    const offset = Math.floor(LIGHT_MS * rand())
    db.prepare(`INSERT INTO heartbeats(agent_id,interval_ms,next_at,deep_at,deep_ms,failures,skips,mode)
      VALUES(?,?,?,?,?,0,0,'auto')`)
      .run(aid, LIGHT_MS, at + offset, at + offset + DEEP_MS, DEEP_MS)
  }
  return ids.length
}

/** 到期的实例（按到期时间先后；公平：先醒的先跑）。 */
export function dueRows(db, at = Date.now()) {
  return db.prepare(`SELECT h.* FROM heartbeats h JOIN agents a ON a.id = h.agent_id
    WHERE a.status='active' AND h.mode='auto' AND h.next_at <= ?
    ORDER BY h.next_at ASC`).all(at)
}

/**
 * 一次扫描。
 * @param {object} p
 * @param {() => any} p.light 纯函数式轻活（同步、零模型）
 * @param {(aid:string) => Promise<any>} [p.deep] 重活（可能调模型）
 * @param {(msg:string)=>void} [p.log]
 * @returns {Promise<{ran:number, deep:number, failed:number}>}
 */
export async function heartbeatTick(db, at = Date.now(), { light, deep, log = () => {}, maxDeep = 2 } = {}) {
  ensureRows(db, at)
  const due = dueRows(db, at)
  const out = { ran: 0, deep: 0, failed: 0 }

  // 全局并发闸：一次扫描里同时跑的 deep 不超过 maxDeep，其余排队到下轮（不堆积）
  const deepQueue = []
  const deepRan = new Set()
  for (const row of due) {
    const t0 = Date.now()
    let err = null
    try {
      if (typeof light === 'function') light(row.agent_id)
    } catch (e) {
      err = e
    }
    out.ran++

    const wantDeep = row.deep_at != null && row.deep_at <= at
    if (wantDeep && typeof deep === 'function') {
      if (out.deep < maxDeep) {
        out.deep++
        try { await deep(row.agent_id); deepRan.add(row.agent_id) } catch (e) { err = err || e; deepRan.add(row.agent_id) }
      } else {
        deepQueue.push(row.agent_id) // 这一轮跳过，下轮再来（不累计，不报复）
        try { db.prepare('UPDATE heartbeats SET skips=skips+1 WHERE agent_id=?').run(row.agent_id) } catch { /* ignore */ }
      }
    }

    const ms = Date.now() - t0
    try {
      if (err) {
        out.failed++
        const failures = Number(row.failures || 0) + 1
        const interval = failures >= BACKOFF_AFTER
          ? Math.min(MAX_INTERVAL_MS, Math.max(row.interval_ms || LIGHT_MS, LIGHT_MS) * 2)
          : (row.interval_ms || LIGHT_MS)
        db.prepare(`UPDATE heartbeats SET last_at=?, last_ms=?, last_error=?, failures=?,
          interval_ms=?, next_at=?, deep_at=? WHERE agent_id=?`)
          .run(at, ms, String((err && err.message) || err).slice(0, 200), failures, interval,
            at + jitter(interval), deepRan.has(row.agent_id) ? at + (row.deep_ms || DEEP_MS) : row.deep_at, row.agent_id)
        db.prepare('UPDATE agents SET last_heartbeat_at=? WHERE id=?').run(new Date(at).toISOString(), row.agent_id)
      } else {
        const interval = row.interval_ms || LIGHT_MS
        db.prepare(`UPDATE heartbeats SET last_at=?, last_ms=?, last_error=NULL, failures=0,
          interval_ms=?, next_at=?, deep_at=? WHERE agent_id=?`)
          .run(at, ms, interval, at + jitter(interval),
            deepRan.has(row.agent_id) ? at + (row.deep_ms || DEEP_MS) : row.deep_at, row.agent_id)
        db.prepare('UPDATE agents SET last_heartbeat_at=? WHERE id=?').run(new Date(at).toISOString(), row.agent_id)
      }
    } catch (e) {
      log('heartbeat-update-failed: ' + ((e && e.message) || e))
    }
  }
  if (due.length) log(`heartbeat ran=${out.ran} deep=${out.deep} failed=${out.failed}`)
  return out
}

/** 前台关闭 / 调试用：这个实例不再自动跳。 */
export function setHeartbeatMode(db, aid, mode) {
  db.prepare('UPDATE heartbeats SET mode=? WHERE agent_id=?').run(mode === 'off' ? 'off' : 'auto', aid)
  return db.prepare('SELECT * FROM heartbeats WHERE agent_id=?').get(aid) || null
}

/** 手动立刻跳一次（「现在就看它醒一下」），不动长期节律。 */
export function poke(db, aid, at = Date.now()) {
  db.prepare('UPDATE heartbeats SET next_at=? WHERE agent_id=?').run(at, aid)
}

export function heartbeatStats(db) {
  const rows = db.prepare('SELECT * FROM heartbeats').all()
  const nowMs = Date.now()
  return {
    total: rows.length,
    off: rows.filter((r) => r.mode === 'off').length,
    failing: rows.filter((r) => Number(r.failures || 0) > 0).length,
    overdue: rows.filter((r) => Number(r.next_at) <= nowMs).length,
    items: rows.sort((a, b) => Number(a.next_at) - Number(b.next_at)),
  }
}

/** 事件里那句人话（界面直接用，不用再拼）。 */
export function describeHeartbeat(row) {
  if (!row) return '还没心跳过'
  const ago = row.last_at ? Math.round((Date.now() - Number(row.last_at)) / 1000) : null
  const next = Math.round((Number(row.next_at) - Date.now()) / 1000)
  const head = ago == null ? '还没跳过' : `${ago}s 前跳过（${row.last_ms || 0}ms）`
  const tail = row.failures ? ` · 连续失败 ${row.failures} 次` : ''
  return `${head} · 下次 ${next > 0 ? next + 's 后' : '已到期'}${tail}`
}

/** 统一的「现在」——测试要能注入假时间。 */
export function stamp(at) {
  return new Date(at || Date.now()).toISOString()
}

export { now }
