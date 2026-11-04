/**
 * 关系余量：她自己那句话说得偏冷 / 偏软，留下一点痕迹。
 *
 * 为什么不是直接改三轴：越哄越亲近、越亲近越哄，会自锁。
 * 这里只做两件事：
 *   1) 当轮记一条 rel.self_residue（偏离她自己的表达基准才记）；
 *   2) 下一轮最多给一句「上一句有点硬」的材料，只影响语气，不判分。
 * 三轴结算放在夜巡，默认关（relation.selfresidue.settle=off），先 shadow 观察。
 */

import { getParam, nid } from '../kernel.js'
import { localDay, localDayBounds } from '../db.js'
import { readReplyTone } from './self_read.js'
import { bumpRelation } from './relations.js'

const DAY = 86400000
const TTL_HOURS = 6
const COLD = '（上一句你说得有点硬，自己知道；不用解释，下一句会自然收一点。）'
const WARM = '（上一句你比平时软，自己有点意外。）'

function flag(db, aid, key, dflt = 'on') {
  try { return String(getParam(db, aid, key) ?? dflt) !== 'off' } catch { return dflt !== 'off' }
}
const r3 = (x) => Math.round((Number(x) || 0) * 1000) / 1000

/** 一句话的温度 vs 当轮表达基准：偏离够大才记。纯函数，方便单测。 */
export function residueDirFor(toneWarmth, expectedWarmth) {
  const tone = Number(toneWarmth)
  const exp = Number(expectedWarmth)
  if (!Number.isFinite(tone) || !Number.isFinite(exp)) return ''
  const delta = tone - exp
  if (delta <= -0.45) return 'cold'
  if (delta >= 0.45) return 'warm'
  return ''
}

/**
 * 她最近在这个会话里自己说话的「温度中位数」。
 * QQ 通道没有 expressionState 的当轮基准，用她自己的历史当基准，比拍一个 0 稳。
 * 少于 min 条不返回：先攒样本，别用两句话定她的常态。
 */
export function ownToneBaseline(db, aid, conv = null, { at = Date.now(), limit = 20, min = 5 } = {}) {
  let rows = []
  try {
    rows = db.prepare(`SELECT text FROM chat_turns
      WHERE agent_id=? AND role='agent' AND conversation_id IS ?
      ORDER BY created_at DESC LIMIT ?`).all(aid, conv, Math.max(1, Math.min(50, limit)))
  } catch { return null }
  const vals = rows
    .map((r) => readReplyTone(r.text))
    .filter((t) => t && !t.flat && Number.isFinite(t.warmth))
    .map((t) => t.warmth)
  if (vals.length < Math.max(1, min)) return null
  vals.sort((a, b) => a - b)
  return vals[Math.floor(vals.length / 2)]
}

/** 通道无关的「回话余量」：用她自己的历史基准判偏离，记一笔。 */
export function recordReplyResidue(db, aid, text, { conv = null, at = Date.now(), minSamples = 5 } = {}) {
  const tone = readReplyTone(text)
  if (!tone || tone.flat) return null
  const expected = ownToneBaseline(db, aid, conv, { at, min: minSamples })
  if (expected == null) return null
  const dir = residueDirFor(tone.warmth, expected)
  if (!dir) return null
  return recordSelfResidue(db, aid, {
    dir, delta: tone.warmth - expected, warmth: tone.warmth, expected,
    replyLen: tone.len, at,
  })
}

export function recordSelfResidue(db, aid, {
  personId = null, dir = '', delta = 0, warmth = 0, expected = 0, replyLen = 0, at = Date.now(),
} = {}) {
  if (dir !== 'cold' && dir !== 'warm') return null
  if (!flag(db, aid, 'relation.selfresidue')) return null
  const payload = {
    person_id: personId || null,
    dir,
    delta: r3(delta),
    warmth: r3(warmth),
    expected: r3(expected),
    reply_len: Number(replyLen) || 0,
  }
  const id = nid('evt_')
  try {
    db.prepare('INSERT INTO events VALUES(?,?,?,?,?)')
      .run(id, aid, 'rel.self_residue', JSON.stringify(payload), new Date(at).toISOString())
  } catch { return null }
  return { id, ...payload }
}

/** 只读候选：6 小时内、还没提示过的最近一条。 */
export function residueCandidate(db, aid, at = Date.now()) {
  if (!flag(db, aid, 'relation.selfresidue')) return { id: null, line: '', dir: '' }
  const since = new Date(at - TTL_HOURS * 3600000).toISOString()
  let rows = []
  try {
    rows = db.prepare("SELECT id,payload,created_at FROM events WHERE agent_id=? AND type='rel.self_residue' AND created_at>=? ORDER BY created_at DESC LIMIT 20")
      .all(aid, since)
  } catch { return { id: null, line: '', dir: '' } }
  if (!rows.length) return { id: null, line: '', dir: '' }
  const shown = new Set()
  try {
    for (const r of db.prepare("SELECT payload FROM events WHERE agent_id=? AND type='rel.self_residue.shown' AND created_at>=?").all(aid, since)) {
      try { shown.add(JSON.parse(r.payload).residue_id) } catch { /* 坏 payload 跳过 */ }
    }
  } catch { /* 老库没有这种事件就按没提示过 */ }
  let row = null
  let dir = ''
  for (const r of rows) {
    if (shown.has(r.id)) continue
    let p = {}
    try { p = JSON.parse(r.payload) } catch { p = {} }
    const d = String(p.dir || '')
    if (d !== 'cold' && d !== 'warm') continue
    row = r
    dir = d
    break
  }
  if (!row) return { id: null, line: '', dir: '' }
  return { id: row.id, line: dir === 'cold' ? COLD : WARM, dir, committed: false }
}

/** 真的进了注入文本才记「提示过」；被预算丢掉时下一轮还能再出。 */
export function commitResidue(db, aid, cand, at = Date.now()) {
  if (!cand || !cand.id || !cand.line || cand.committed) return false
  try {
    db.prepare('INSERT INTO events VALUES(?,?,?,?,?)')
      .run(nid('evt_'), aid, 'rel.self_residue.shown', JSON.stringify({ residue_id: cand.id }), new Date(at).toISOString())
    cand.committed = true
    return true
  } catch { return false }
}

/** 兼容旧调用：取到就落账。 */
export function residueLine(db, aid, at = Date.now()) {
  const c = residueCandidate(db, aid, at)
  if (c.line) commitResidue(db, aid, c, at)
  return c.line
}

/**
 * 夜巡结算：同方向余量 ≥3 条、冷的方向累计 ≤ -1.2，才小步动一次三轴。
 * 默认关；同一天只结算一次；正向上限更低，且冷的方向优先。
 */
export function settleSelfResidue(db, aid, { at = Date.now() } = {}) {
  if (!flag(db, aid, 'relation.selfresidue')) return { skipped: 'off' }
  if (!flag(db, aid, 'relation.selfresidue.settle', 'off')) return { skipped: 'settle-off' }
  const day = localDay(at)
  try {
    const bounds = localDayBounds(day)
    const done = db.prepare("SELECT 1 FROM events WHERE agent_id=? AND type='rel.self_residue.settled' AND created_at>=? AND created_at<?").get(aid, bounds.start, bounds.end)
    if (done) return { skipped: 'already' }
  } catch { /* 查询失败就往下走，重放由事件指纹兜底 */ }
  const since = new Date(at - DAY).toISOString()
  let rows = []
  try {
    rows = db.prepare("SELECT id,payload FROM events WHERE agent_id=? AND type='rel.self_residue' AND created_at>=? ORDER BY created_at ASC").all(aid, since)
  } catch { return { skipped: 'read-failed' } }
  const cold = []
  const warm = []
  // 已经被结算过的余量不能跨零点再算一遍：按 id 去重，不靠「今天有没有结算过」。
  const settledIds = new Set()
  try {
    const cut = new Date(at - 7 * DAY).toISOString()
    for (const r of db.prepare("SELECT payload FROM events WHERE agent_id=? AND type='rel.self_residue.settled' AND created_at>=?").all(aid, cut)) {
      try {
        const p = JSON.parse(r.payload)
        for (const id of (Array.isArray(p.ids) ? p.ids : [])) settledIds.add(id)
      } catch { /* 坏 payload 跳过 */ }
    }
  } catch { /* 老库没有结算事件就按没结算过 */ }
  for (const r of rows) {
    if (settledIds.has(r.id)) continue
    try {
      const p = JSON.parse(r.payload)
      if (p.dir === 'cold') cold.push({ id: r.id, delta: Number(p.delta) || 0 })
      else if (p.dir === 'warm') warm.push({ id: r.id, delta: Number(p.delta) || 0 })
    } catch { /* 坏 payload 跳过 */ }
  }
  const coldSum = cold.reduce((s, x) => s + x.delta, 0)
  let dir = ''
  let v = 0
  let ids = []
  if (cold.length >= 3 && coldSum <= -1.2) { dir = 'cold'; v = -0.08; ids = cold.map((x) => x.id) }
  else if (warm.length >= 3) { dir = 'warm'; v = 0.04; ids = warm.map((x) => x.id) }
  if (!dir) return { settled: 0, skipped: 'below', cold: cold.length, warm: warm.length }
  let changed = 0
  try {
    const res = bumpRelation(db, aid, {
      v, kind: 'self', source: 'selfread',
      reason: dir === 'cold' ? '今天有几句话说得硬' : '今天有几句话比平时软',
      at,
    })
    changed = (res && res.changed && res.changed.length) || 0
  } catch { return { settled: 0, skipped: 'bump-failed', dir } }
  try {
    db.prepare('INSERT INTO events VALUES(?,?,?,?,?)').run(
      nid('evt_'), aid, 'rel.self_residue.settled',
      JSON.stringify({ ids, dir, v, changed }), new Date(at).toISOString(),
    )
  } catch { /* 记账失败不影响已经发生的结算 */ }
  return { settled: ids.length, dir, v, changed }
}

/** 给报告 / 面板用：最近 N 天记了几条、提示过几条、结算过几次。 */
export function residueStats(db, aid, { days = 7, at = Date.now() } = {}) {
  const since = new Date(at - Math.max(1, days) * DAY).toISOString()
  const one = (type) => {
    try { return Number(db.prepare('SELECT COUNT(*) n FROM events WHERE agent_id=? AND type=? AND created_at>=?').get(aid, type, since).n || 0) } catch { return 0 }
  }
  return {
    days,
    recorded: one('rel.self_residue'),
    shown: one('rel.self_residue.shown'),
    settled: one('rel.self_residue.settled'),
  }
}

/**
 * Shadow 观测：只读聚合，给页面 / 接口 / CLI 用。
 * 不新表、不写状态；读的是 events + memory_items + 当前参数。
 */
export function shadowReport(db, aid, { days = 7, at = Date.now() } = {}) {
  const d = Math.max(1, Math.min(90, Number(days) || 7))
  const since = new Date(at - d * DAY).toISOString()
  const one = (type) => {
    try { return Number(db.prepare('SELECT COUNT(*) n FROM events WHERE agent_id=? AND type=? AND created_at>=?').get(aid, type, since).n || 0) } catch { return 0 }
  }
  const byDir = { cold: 0, warm: 0 }
  const last = []
  try {
    for (const r of db.prepare("SELECT id,payload,created_at FROM events WHERE agent_id=? AND type='rel.self_residue' AND created_at>=? ORDER BY created_at DESC LIMIT 8").all(aid, since)) {
      let p = {}
      try { p = JSON.parse(r.payload) } catch { p = {} }
      if (p.dir === 'cold' || p.dir === 'warm') byDir[p.dir]++
      last.push({ id: r.id, at: r.created_at, dir: p.dir || '', delta: Number(p.delta) || 0, warmth: Number(p.warmth) || 0 })
    }
  } catch { /* 老库没有这类事件就空着 */ }
  let settleInfo = null
  try {
    const r = db.prepare("SELECT payload,created_at FROM events WHERE agent_id=? AND type='rel.self_residue.settled' ORDER BY created_at DESC LIMIT 1").get(aid)
    if (r) { try { settleInfo = { at: r.created_at, ...JSON.parse(r.payload) } } catch { settleInfo = { at: r.created_at } } }
  } catch { /* ignore */ }

  const byKey = {}
  let committed = 0
  let dropped = 0
  try {
    for (const r of db.prepare("SELECT type,payload FROM events WHERE agent_id=? AND type IN ('inject.mind_committed','inject.mind_dropped') AND created_at>=?").all(aid, since)) {
      let key = 'unknown'
      try { key = String(JSON.parse(r.payload).key || 'unknown') } catch { /* ignore */ }
      const k = byKey[key] || (byKey[key] = { committed: 0, dropped: 0 })
      if (r.type === 'inject.mind_committed') { k.committed++; committed++ } else { k.dropped++; dropped++ }
    }
  } catch { /* ignore */ }

  const bySource = []
  let totalMem = 0
  let lowConf = 0
  try {
    for (const r of db.prepare(`SELECT source, COUNT(*) n,
        SUM(CASE WHEN confidence IS NOT NULL AND confidence < 0.55 THEN 1 ELSE 0 END) low
      FROM memory_items WHERE agent_id=? AND status='active' AND invalid_at IS NULL
      GROUP BY source ORDER BY n DESC`).all(aid)) {
      const n = Number(r.n) || 0
      const low = Number(r.low) || 0
      totalMem += n
      lowConf += low
      bySource.push({ source: String(r.source || '') || '(空)', n, low })
    }
  } catch { /* ignore */ }

  return {
    agent_id: aid,
    generated_at: new Date(at).toISOString(),
    window_days: d,
    residue: {
      recording: flag(db, aid, 'relation.selfresidue'),
      settling: flag(db, aid, 'relation.selfresidue.settle', 'off'),
      recorded: one('rel.self_residue'),
      shown: one('rel.self_residue.shown'),
      settled: one('rel.self_residue.settled'),
      by_dir: byDir,
      last,
      last_settle: settleInfo,
    },
    mind: {
      committed,
      dropped,
      dropped_rate: committed + dropped ? Math.round((dropped / (committed + dropped)) * 1000) / 1000 : null,
      by_key: byKey,
    },
    memory: {
      total: totalMem,
      low_confidence: lowConf,
      by_source: bySource,
    },
    params: {
      'memory.inject.commit_after_pack': String(getParam(db, aid, 'memory.inject.commit_after_pack') ?? 'on'),
      'memory.inject.provenance': String(getParam(db, aid, 'memory.inject.provenance') ?? 'on'),
      'relation.selfresidue': String(getParam(db, aid, 'relation.selfresidue') ?? 'on'),
      'relation.selfresidue.settle': String(getParam(db, aid, 'relation.selfresidue.settle') ?? 'off'),
    },
  }
}
