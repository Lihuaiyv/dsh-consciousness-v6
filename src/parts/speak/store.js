/**
 * 主动开口 · 存储与结局追踪（零件内）
 *
 * 管 proactive 三张表：proactive（待发/已发）、proactive_decisions（每次判断留一条）、
 * proactive_stats（按维度的发/答/忽略/冷却）。
 * proactive 的写归 modules/proactive.js（队列单写手）；这个文件只写 decisions / stats，别的零件只读。
 *
 * 共享件只 import：db 的 now、core 的 nid/agent/err。
 */
import { now } from '../../db.js'
import { nid, agent, err } from '../../core.js'
import { markAnswered, markIgnored, dismissProactive } from '../../modules/proactive.js'

const DECISION_KEEP = 120

/**
 * 每次「该不该说」都留一条：门槛结论、收益/成本、引用了哪条记忆、输入快照。
 * 同一个判断（will/reason/dim 都一样）不新开行，只更新时间和次数。
 */
export function recordProactiveDecision(db, aid, d, { text = null, source = null, memories = null } = {}) {
  try {
    const at = d.at || now()
    const reason = d.reason || 'ok'
    const dim = (d.intent && d.intent.dim) || null
    const gates = Array.isArray(d.gates) ? d.gates : []
    const chain = {
      explain: d.explain || '',
      benefit: d.benefit_parts || null,
      cost: d.cost_parts || null,
      evidence: d.evidence || null,
      input_snapshot: d.input || null,
      memory_used: (memories || []).map((m) => ({ id: m.id, text: String(m.text || '').slice(0, 120) })),
      hours_since: d.hours_since, idle_need_hours: d.idle_need_hours,
      source: source || null,
    }
    const last = db.prepare('SELECT * FROM proactive_decisions WHERE agent_id=? ORDER BY at DESC, rowid DESC LIMIT 1').get(aid)
    if (last && Number(last.will) === (d.will ? 1 : 0) && last.reason === reason && (last.dim || '') === (dim || '')) {
      db.prepare('UPDATE proactive_decisions SET at=?, repeats=repeats+1, text=COALESCE(?,text), source=COALESCE(?,source), benefit=?, cost=?, gates=?, chain=? WHERE id=?')
        .run(at, text, source, d.benefit ?? null, d.cost ?? null, JSON.stringify(gates), JSON.stringify(chain), last.id)
      return last.id
    }
    const id = nid('pdc_')
    db.prepare('INSERT INTO proactive_decisions(id,agent_id,at,will,reason,dim,source,text,benefit,cost,gates,chain,repeats) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,1)')
      .run(id, aid, at, d.will ? 1 : 0, reason, dim, source, text, d.benefit ?? null, d.cost ?? null, JSON.stringify(gates), JSON.stringify(chain))
    db.prepare('DELETE FROM proactive_decisions WHERE agent_id=? AND id NOT IN (SELECT id FROM proactive_decisions WHERE agent_id=? ORDER BY at DESC, rowid DESC LIMIT ?)')
      .run(aid, aid, DECISION_KEEP)
    return id
  } catch { return null }
}

export function listProactiveDecisions(db, aid, limit = 20) {
  agent(db, aid)
  const n = Math.max(1, Math.min(100, Number(limit) || 20))
  let rows = []
  try { rows = db.prepare('SELECT * FROM proactive_decisions WHERE agent_id=? ORDER BY at DESC, rowid DESC LIMIT ?').all(aid, n) } catch { rows = [] }
  return rows.map((r) => {
    let gates = []
    let chain = {}
    try { gates = JSON.parse(r.gates || '[]') } catch { gates = [] }
    try { chain = JSON.parse(r.chain || '{}') } catch { chain = {} }
    return { ...r, will: !!r.will, gates, chain }
  })
}

export function lastProactiveDecision(db, aid) {
  try { return listProactiveDecisions(db, aid, 1)[0] || null } catch { return null }
}

export function listProactive(db, aid) {
  agent(db, aid)
  return db.prepare("SELECT * FROM proactive WHERE agent_id=? AND state='pending' ORDER BY created_at DESC LIMIT 5").all(aid)
}

// ---------------- 主动开口的结局追踪（状态放库，不放模型脑子） ----------------

export function bumpStat(db, aid, dim, field) {
  try {
    db.prepare('INSERT OR IGNORE INTO proactive_stats(agent_id,dim) VALUES(?,?)').run(aid, dim)
    db.prepare('UPDATE proactive_stats SET ' + field + '=' + field + '+1, last_sent_at=? WHERE agent_id=? AND dim=?').run(now(), aid, dim)
  } catch { /* ignore */ }
}

/** 用户真的回了一句：把「已投递、还没回应」的主动消息标成被回应 */
export function settleProactiveAnswered(db, aid) {
  let n = 0
  try {
    const rows = db.prepare("SELECT id,dim FROM proactive WHERE agent_id=? AND state='delivered' AND answered=0 AND ignored=0").all(aid)
    for (const r of rows) {
      markAnswered(db, r.id)
      bumpStat(db, aid, r.dim || 'R', 'answered')
      n++
    }
  } catch { /* ignore */ }
  return n
}

/** 24 小时没回应 → 记一次忽略；同一维度两次忽略且零回应 → 该维度冷却 7 天 */
export function markProactiveIgnored(db, aid) {
  let n = 0
  try {
    const cutoff = new Date(Date.now() - 24 * 3600000).toISOString()
    const rows = db.prepare("SELECT id,dim FROM proactive WHERE agent_id=? AND state='delivered' AND answered=0 AND ignored=0 AND delivered_at<?").all(aid, cutoff)
    for (const r of rows) {
      const dim = r.dim || 'R'
      markIgnored(db, r.id)
      bumpStat(db, aid, dim, 'ignored')
      const s = db.prepare('SELECT * FROM proactive_stats WHERE agent_id=? AND dim=?').get(aid, dim)
      if (s && Number(s.ignored) >= 2 && Number(s.answered) === 0) {
        db.prepare('UPDATE proactive_stats SET cooldown_until=? WHERE agent_id=? AND dim=?')
          .run(new Date(Date.now() + 7 * 86400000).toISOString(), aid, dim)
      }
      n++
    }
  } catch { /* ignore */ }
  return n
}

export function proactiveStats(db, aid) {
  agent(db, aid)
  return db.prepare('SELECT * FROM proactive_stats WHERE agent_id=? ORDER BY dim').all(aid)
}

export function ackProactive(db, aid, pid) {
  const r = db.prepare('SELECT * FROM proactive WHERE id=? AND agent_id=?').get(pid, aid)
  if (!r) err(404, 'NOT_FOUND', '这条主动消息不存在')
  dismissProactive(db, pid)
  return { id: pid, state: 'dismissed' }
}
