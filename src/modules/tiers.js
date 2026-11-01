/**
 * 分层记忆 · 热度账本
 *
 * 五个分区（逻辑分区，同一个 app.db）：
 *   T0 自我     persona / relations / taboos / values   —— 热，每轮必带
 *   T1 事实     memory_items（蒸馏出来的语义记忆）       —— 温
 *   T2 纪要     episodes（一次会话 / 一天的压缩）        —— 温
 *   T3 日记     diaries（一天一篇第一人称）              —— 温偏冷
 *   T4 原文     raw_turns（完整对话，只追加）            —— 冷，平时不碰
 *   T4 存根     fact_archive（事实出生时的原样，只追加）  —— 冷不删，只在「翻旧账」时查
 *
 * 短期 / 中期 / 长期不是三张表，而是**每个条目自己的热度 band**：
 *   heat = 0.40·重要度 + 0.22·新鲜度 + 0.18·强化次数 + 0.10·钉住 + 0.10·情绪显著度
 *   新鲜度按半衰期衰减，半衰期随重要度拉长（重要的淡得慢）
 *   被召回一次 → hits+1、时钟拨回、热度重算（强化）
 *
 * band 只影响**排序和配额**，不影响「进不进」——准入仍然看证据。
 */

import { now } from '../db.js'
import { tempStats, targetTemp } from './temps.js'

const DAY_MS = 86400000
const clamp01 = (x) => Math.max(0, Math.min(1, Number(x) || 0))

/** 半衰期（天）：基准 30 天，重要度每 +1 拉长 2 倍。 */
export function halfLifeDays(importance) {
  return 30 * (1 + 2 * clamp01(importance))
}

/**
 * 记忆出生时定下两个热度初值：
 *   importance 看它「是什么」——边界 / 承诺最重，偏好次之，日常一次对话最轻；
 *   salience 看它出生那一刻有多激动——取那一轮的情绪强度（0–1），情绪平就低。
 * 两个都是 0–1；addMemory 里照样可以用显式值覆盖。
 */
export function seedScores(text, type, affectIntensity, valence) {
  const t = String(text || '')
  const base = type === 'episode' ? 0.45 : type === 'reflection' ? 0.6 : type === 'appraisal' ? 0.55 : 0.5
  const boost = /答应|承诺|约定|边界|底线|禁忌|不要|必须|永远|再也|记住|别再/.test(t) ? 0.35
    : /喜欢|讨厌|偏好|习惯|介意|最怕|最爱|想要/.test(t) ? 0.15 : 0
  const out = {
    importance: Math.max(0, Math.min(1, base + boost)),
    salience: Math.max(0, Math.min(1, Number(affectIntensity) || 0)),
  }
  // 出生时的情绪效价（有就带上，没有让 addMemory 记当前心情）
  if (Number.isFinite(Number(valence))) out.valence = Math.max(-1, Math.min(1, Number(valence)))
  return out
}

/**
 * 一条记忆现在的热度。纯函数：同样的行 + 同样的时间 → 同样的数。
 * @param {object} row memory_items 行（或任何带 created_at / importance / hits 的对象）
 * @param {number} [at] 毫秒时间戳
 */
export function heatOf(row, at = Date.now()) {
  if (!row) return 0
  const imp = clamp01(row.importance ?? row.weight ?? 0.5)
  const hits = Math.max(0, Number(row.hits || 0))
  const strength = Math.min(1, Math.log1p(hits) / Math.log1p(8))
  const anchor = Date.parse(row.last_hit_at || row.created_at || '')
  const age = Number.isFinite(anchor) ? Math.max(0, (at - anchor) / DAY_MS) : 0
  const recency = Math.pow(0.5, age / halfLifeDays(imp))
  const pin = row.mark === 'locked' ? 1 : 0
  const salience = clamp01(row.salience || 0)
  return Math.round(clamp01(0.40 * imp + 0.22 * recency + 0.18 * strength + 0.10 * pin + 0.10 * salience) * 10000) / 10000
}

/** 热度 → 档位。钉住的一律短期（它必须每轮都在）。 */
export function bandOf(row, heat = heatOf(row)) {
  if (!row) return 'mid'
  if (row.mark === 'locked') return 'short'
  const anchor = Date.parse(row.last_hit_at || row.created_at || '')
  const age = Number.isFinite(anchor) ? Math.max(0, (Date.now() - anchor) / DAY_MS) : 0
  // 档位是「优先级」，不是「价值」：最近两天的东西天然在短期，90 天没被碰过的落到长期。
  if (heat >= 0.52 || age <= 2) return 'short'
  if (heat >= 0.30 || age <= 60) return 'mid'
  return 'long'
}

/** 档位在召回分上的乘数：短期优先，但不把长期一棍子打死。 */
/**
 * 面板要的「此刻那条记忆的账」：热度、档位按请求时刻现算，温度按状态机现算。
 *
 * 库里的 heat/band/temp_state 是**上一次巡检的快照**（夜巡 23:00 推进一次），
 * 而热度里的新鲜度是按秒在衰减的，只读存档的话，页面上的数字会一整天不动。
 * 所以读接口统一走这里：现算一份给眼睛看，写库仍然只由夜巡 / 召回强化 / 手动重算负责。
 *
 * temp_now 不覆盖 temp_state —— 注入那边按存档的 temp_state 判 cold/archived，
 * 这里只是让人看到「按现在的状态它应该是什么温度」。
 */
export function nowRow(row, at = Date.now()) {
  if (!row) return row
  const heat = heatOf(row, at)
  return { ...row, heat, band: bandOf(row, heat), temp_now: targetTemp(row, at) }
}

/** 重算一个意识体的全部热度与档位。返回各档条数。 */
export function refreshHeat(db, aid, at = Date.now()) {
  const rows = db.prepare("SELECT * FROM memory_items WHERE agent_id=? AND status='active' AND invalid_at IS NULL").all(aid)
  const up = db.prepare('UPDATE memory_items SET heat=?, band=? WHERE id=?')
  const counts = { short: 0, mid: 0, long: 0 }
  db.exec('BEGIN IMMEDIATE')
  try {
    for (const r of rows) {
      const h = heatOf(r, at)
      const b = bandOf(r, h)
      counts[b]++
      up.run(h, b, r.id)
    }
    db.exec('COMMIT')
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* ignore */ }
    throw e
  }
  return counts
}

/**
 * 可提取性 R：和 decay@v1 同一套公式（R = 1/(1 + t/9S)），但用 last_decay_at 当锚点。
 * 复习成功会把锚点拨回现在，所以 R 回到 1；时间越久 R 越低。
 */
export function retrievability(row, at = Date.now()) {
  if (!row) return 1
  const s = Math.max(0.1, Number(row.stability || 1))
  const anchor = Date.parse(row.last_decay_at || row.created_at || '')
  const age = Number.isFinite(anchor) ? Math.max(0, (at - anchor) / DAY_MS) : 0
  return 1 / (1 + age / (9 * s))
}

/**
 * 强化：这几条刚被想起来。
 *
 * 关键的一步是稳定性：越「费劲」想起来（R 低），这条记忆的稳定度涨得越多，
 * 下次忘得更慢；刚想起过又立刻想起（R≈1），几乎不涨。这就是 FSRS 的闭环——
 * 公式 v1 之前只用来算 R，从没回写过 stability，等于复习不生效。
 *
 * S' = S · (1 + 0.25·(1 − R))，夹在 [0.5, 60] 天。
 */
export function touch(db, ids, at = Date.now()) {
  const list = [...new Set((ids || []).filter(Boolean))]
  if (!list.length) return 0
  const sel = db.prepare('SELECT * FROM memory_items WHERE id=?')
  const up = db.prepare('UPDATE memory_items SET hits=hits+1, last_hit_at=?, last_decay_at=?, stability=?, heat=?, band=? WHERE id=?')
  const stamp = new Date(at).toISOString()
  let n = 0
  for (const id of list) {
    const row = sel.get(id)
    if (!row) continue
    const s0 = Math.max(0.1, Number(row.stability || 1))
    const R = retrievability(row, at)
    const s1 = Math.min(60, Math.max(0.5, s0 * (1 + 0.25 * (1 - R))))
    const next = { ...row, hits: Number(row.hits || 0) + 1, last_hit_at: stamp, last_decay_at: stamp, stability: s1 }
    const h = heatOf(next, at)
    up.run(stamp, stamp, Math.round(s1 * 1000) / 1000, h, bandOf(next, h), id)
    n++
  }
  return n
}

/** 分档统计 + 最热几条，给面板/验收看。 */
export function tierStats(db, aid, at = Date.now()) {
  const rows = db.prepare("SELECT id,text,type,importance,salience,hits,last_hit_at,heat,band,mark,created_at FROM memory_items WHERE agent_id=? AND status='active' AND invalid_at IS NULL").all(aid)
  const counts = { short: 0, mid: 0, long: 0 }
  for (const r of rows) counts[bandOf(r, heatOf(r, at))]++
  const hot = rows
    .map((r) => ({ ...r, heat: heatOf(r, at) }))
    .sort((a, b) => b.heat - a.heat)
    .slice(0, 10)
    .map((r) => ({ id: r.id, text: String(r.text).slice(0, 60), band: bandOf(r, r.heat), heat: r.heat, hits: Number(r.hits || 0) }))
  const raw = db.prepare('SELECT COUNT(*) n FROM raw_turns WHERE agent_id=?').get(aid)?.n || 0
  const days = db.prepare('SELECT COUNT(*) n FROM diaries WHERE agent_id=?').get(aid)?.n || 0
  const eps = db.prepare('SELECT COUNT(*) n FROM episodes WHERE agent_id=?').get(aid)?.n || 0
  const arch = db.prepare('SELECT COUNT(*) n FROM fact_archive WHERE agent_id=?').get(aid)?.n || 0
  return {
    at: new Date(at).toISOString(),
    facts: { total: rows.length, ...counts },
    episodes: Number(eps), diaries: Number(days), raw_turns: Number(raw), facts_archived: Number(arch),
    temps: tempStats(db, aid),
    hot,
  }
}

/**
 * 迁移用：给还没算过热度的老库补一遍。
 * 只跑一次（写 flags），不阻塞启动。
 */
export function ensureHeatBootstrapped(db) {
  try {
    const done = db.prepare("SELECT value FROM flags WHERE key='tiers.bootstrapped'").get()
    if (done) return 0
    const agents = db.prepare("SELECT id FROM agents WHERE status!='soft_deleted'").all()
    for (const a of agents) refreshHeat(db, a.id)
    db.prepare("INSERT INTO flags(key,value) VALUES('tiers.bootstrapped',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(now())
    return agents.length
  } catch { return 0 }
}
