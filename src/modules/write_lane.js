/**
 * 记忆写入闸 · 落库车道
 *
 * 判决在 memory_source（gateSelfText 等）；这里只管「怎么落」：
 * 自我额度 / 窗口 / 按分量换人 / writeExtractedItem。
 * 从 features.js 整段搬出，行为不变；features 只 re-export。
 */
import { now } from '../db.js'
import { event, getParam } from '../kernel.js'
import { addMemory } from './memory.js'
import { seedScores } from './tiers.js'
import { setMemoryTemp } from './memory_fields.js'
import { entityForText } from './entities.js'
import { applyWrite } from './gate.js'
import { narrationOnly, classifySelf, scoreSelf, gateSelfText } from './memory_source.js'

/** 今天已经写了多少条「我自己」——按本地日界算，和她的「今天」一致。
 *  冷层不算：那几条退到深查层了，不该占平常的名额。 */
export function selfCountToday(db, aid, at = Date.now()) {
  try {
    const d = new Date(at)
    d.setHours(0, 0, 0, 0)
    const since = d.toISOString()
    return Number(db.prepare("SELECT COUNT(*) n FROM memory_items WHERE agent_id=? AND source='self' AND created_at>=? AND (temp_state IS NULL OR temp_state<>'cold')")
      .get(aid, since).n || 0)
  } catch { return 0 }
}

/** 这一小段时间还能留几条：别让早上的话把一整天的额度一次用完。 */
export function selfWindowState(db, aid, at = Date.now()) {
  try {
    const winH = Math.max(1, Math.min(24, Number(getParam(db, aid, 'self.window_hours')) || 3))
    const dayCap = selfQuotaToday(db, aid, at)
    const want = Math.max(1, Number(getParam(db, aid, 'self.per_window')) || Math.ceil(dayCap / 4))
    const cap = Math.max(1, Math.min(30, want))
    const since = new Date(at - winH * 3600 * 1000).toISOString()
    const n = Number(db.prepare("SELECT COUNT(*) n FROM memory_items WHERE agent_id=? AND source='self' AND created_at>=? AND (temp_state IS NULL OR temp_state<>'cold')")
      .get(aid, since).n || 0)
    return { cap, winH, used: n, left: Math.max(0, cap - n) }
  } catch { return { cap: 2, winH: 3, used: 0, left: 2 } }
}

/** 当天额度：安静的日子保底，聊得多、被挡得多就往上浮。
 *  缓存一小时，别每写一句都数一遍事件。 */
const quotaCache = new Map()
export function selfQuotaToday(db, aid, at = Date.now()) {
  try {
    const auto = String(getParam(db, aid, 'self.quota.auto') || 'on') !== 'off'
    const base = Math.max(1, Math.min(30, Number(getParam(db, aid, 'self.quota.base')) || 4))
    const max = Math.max(base, Math.min(40, Number(getParam(db, aid, 'self.quota.max')) || 16))
    if (!auto) return Math.max(1, Math.min(30, Number(getParam(db, aid, 'self.per_day')) || 8))
    const hourKey = Math.floor(at / 3600000)
    const hit = quotaCache.get(aid)
    if (hit && hit.hour === hourKey) return hit.quota
    const d = new Date(at)
    d.setHours(0, 0, 0, 0)
    const since = d.toISOString()
    const turns = Number(db.prepare("SELECT COUNT(*) n FROM events WHERE agent_id=? AND type='chat.turn' AND created_at>=?").get(aid, since).n || 0)
    const blocked = Number(db.prepare("SELECT COUNT(*) n FROM events WHERE agent_id=? AND type IN ('memory.self_rejected','memory.self_cold') AND created_at>=?").get(aid, since).n || 0)
    const q = Math.round(base + turns / 15 + blocked / 25)
    const quota = Math.max(base, Math.min(max, q))
    quotaCache.set(aid, { hour: hourKey, quota })
    return quota
  } catch { return 8 }
}

/** 按分量换人：拿当天冷层里分最高的，跟热层里分最低的比，差够了才换。
 *  每 3 小时跑一次（由 ingest 顺带触发），单次最多换两条，防一天大搬家。 */
export function settleSelfHot(db, aid, at = Date.now()) {
  try {
    if (String(getParam(db, aid, 'self.settle') || 'on') === 'off') return { moved: 0, skipped: 'off' }
    const d = new Date(at)
    d.setHours(0, 0, 0, 0)
    const since = d.toISOString()
    const gap = Math.max(0.05, Math.min(0.5, Number(getParam(db, aid, 'self.settle.gap')) || 0.15))
    const maxMove = Math.max(1, Math.min(3, Number(getParam(db, aid, 'self.settle.max_move')) || 2))
    const base = "FROM memory_items WHERE agent_id=? AND source='self' AND status='active' AND deleted_at IS NULL AND created_at>=?"
    const cold = db.prepare('SELECT id,text,importance ' + base + " AND temp_state='cold' ORDER BY importance DESC, created_at ASC LIMIT ?").all(aid, since, maxMove)
    const hot = db.prepare('SELECT id,text,importance ' + base + " AND (temp_state IS NULL OR temp_state IN ('hot','warm')) ORDER BY importance ASC, created_at ASC LIMIT ?").all(aid, since, maxMove)
    let moved = 0
    const used = new Set()
    for (const c of cold) {
      const h = hot.find((x) => !used.has(x.id))
      if (!h) break
      const up = Number(c.importance) || 0
      const down = Number(h.importance) || 0
      if (up - down <= gap) break
      setMemoryTemp(db, h.id, 'cold', now())
      setMemoryTemp(db, c.id, 'hot', now())
      used.add(h.id)
      moved++
      try { event(db, aid, 'memory.self.settle', { up: c.id, down: h.id, up_score: up, down_score: down }) } catch { /* 忽略 */ }
    }
    return { moved, cold: cold.length, hot: hot.length, gap }
  } catch { return { moved: 0, error: true } }
}

const lastSettle = new Map()
/** ingest 里顺带触发：不到间隔就不跑，别每轮都算一遍。 */
export function maybeSettleSelf(db, aid, at = Date.now()) {
  try {
    if (String(getParam(db, aid, 'self.settle') || 'on') === 'off') return
    const every = Math.max(1, Math.min(24, Number(getParam(db, aid, 'self.settle.every_hours')) || 3))
    const last = Number(lastSettle.get(aid) || 0)
    if (at - last < every * 3600 * 1000) return
    lastSettle.set(aid, at)
    settleSelfHot(db, aid, at)
  } catch { /* 结算失败不影响这一轮 */ }
}

/** 落冷层：addMemory 的 cold 分支在「撞到重复、改走合并」时不会生效，这里补一刀。 */
function forceCold(db, id) {
  if (!id) return
  try {
    setMemoryTemp(db, id, 'cold', now(), { onlyIfChanged: true })
  } catch { /* 老库没温度列就当热的 */ }
}

/**
 * 一条抽出来的记忆落库（P0 / P1 共用）。
 *
 * 三件事在这里一次做完：
 *   1) 旁白闸：主语是「用户 / 对方 / 助手」的转述句不丢，落冷层——它是真事实，
 *      只是不该冒充「我记得的事」；S2/S3 深查仍捞得到，confidence 也压低。
 *   2) 写入门控：新增 / 合并 / 冲突 / 丢弃 由 applyWrite 判，这条函数只管「怎么落」。
 *   3) 合并进旧条时 addMemory 那条路没走，冷层要单独补一次。
 */
export function writeExtractedItem(db, aid, m, opt = {}) {
  const text = String((m && m.text) || '').trim()
  if (!text) return { action: 'drop', reason: 'empty' }
  // ---- P1 她自己的车道 ----
  if (String((m && m.who) || '') === 'self') {
    if (String(getParam(db, aid, 'memory.write.self') || 'on') === 'off') return { action: 'drop', reason: 'self_off' }
    /* 三档：ok 直接留；drop 明显不要；unsure 交给调用方先问模型（opt.selfDecision）。
       判不了 / 模型超时 / 没配额 → 落冷层，不丢：丢掉的话，那件事就真没了。
       判决本身在 memory_source.gateSelfText（纯函数，考卷能单独喂数据）。 */
    const cls = classifySelf(text)
    const body = cls.text || text
    // 场景分：规则分打底；拿不准的让模型补一句（六成规则、四成模型），只有模型给了分才混。
    const ruleScore = scoreSelf(body)
    const modelHay = typeof opt.selfDecision === 'function' ? opt.selfDecision(text) : null
    // 按分量选人：低分的不占热层名额，直接落冷（还能结算上来）。
    const admission = String(getParam(db, aid, 'self.admission') || 'time')
    const minScore = Math.max(0, Math.min(1, Number(getParam(db, aid, 'self.admission.min_score')) || 0.35))
    const gate = gateSelfText({ cls, ruleScore, modelHay, admission, minScore })
    const score = gate.score
    const verdict = { keep: gate.keep, cold: gate.cold, why: gate.why }
    if (!verdict.keep) {
      try { event(db, aid, 'memory.self_rejected', { reason: 'gate', why: verdict.why, score, len: body.length, head: body.slice(0, 40) }) } catch { /* 事件失败不影响写入 */ }
      let id = null
      if (verdict.cold) {
        try {
          const row = addMemory(db, aid, {
            text: body, type: 'episode', mark: (m && m.mark) || 'normal',
            source: 'self', confidence: 0.5, importance: score, cold: true, turn_id: opt.turnId || null,
            speaker: 'self', quote: (m && m.quote) || null, inferred: (m && m.inferred) || 0,
          })
          id = row && row.id
          forceCold(db, id)
          try { event(db, aid, 'memory.self_cold', { why: verdict.why, score, head: body.slice(0, 40) }) } catch { /* 忽略 */ }
        } catch { /* 冷层写失败就当没写 */ }
      }
      return { action: 'drop', reason: 'self_gate', cold: !!id, id, score }
    }
    // 配额两道：一天总量（跟着实际浮动）+ 每窗口量。超了落冷，不丢。
    // 为什么分软硬：日额度是「今天大概记几条」的目标，不是硬闸——硬闸是窗口（每 3 小时 2 条），
    // 否则早上写满 6 条，下午再想到什么都进不来。auto 关掉时回到旧的硬日闸。
    const dayCap = selfQuotaToday(db, aid)
    const win = selfWindowState(db, aid)
    const usedToday = selfCountToday(db, aid)
    const autoOn = String(getParam(db, aid, 'self.quota.auto') || 'on') !== 'off'
    const hardMax = Math.max(dayCap, Math.min(40, Number(getParam(db, aid, 'self.quota.max')) || 16))
    const dayLimit = (admission === 'score' && autoOn) ? hardMax : dayCap
    const bypass = Math.max(0, Math.min(1, Number(getParam(db, aid, 'self.admission.bypass_score')) || 0.7))
    const allowBypass = admission === 'score' && score >= bypass && usedToday < hardMax + 2
    if ((usedToday >= dayLimit || win.left <= 0) && !allowBypass) {
      const reason = usedToday >= dayLimit ? 'per_day' : 'per_window'
      // 带上头部：不然「被上限挡掉的是流水账还是真事」永远答不上来（体检脚本要用）。
      try { event(db, aid, 'memory.self_rejected', { reason, cap: dayCap, window_hours: win.winH, score, len: body.length, head: body.slice(0, 40) }) } catch { /* 事件失败不影响写入 */ }
      let id = null
      try {
        const row = addMemory(db, aid, {
          text: body, type: 'episode', mark: (m && m.mark) || 'normal',
          source: 'self', confidence: 0.5, importance: score, cold: true, turn_id: opt.turnId || null,
          speaker: 'self', quote: (m && m.quote) || null, inferred: (m && m.inferred) || 0,
        })
        id = row && row.id
        forceCold(db, id)
        try { event(db, aid, 'memory.self_cold', { why: reason, score, head: body.slice(0, 40) }) } catch { /* 忽略 */ }
      } catch { /* 冷层写失败就当没写 */ }
      return { action: 'cold', reason: 'self_' + reason, cold: true, id, score }
    }
    if (allowBypass && (usedToday >= dayCap || win.left <= 0)) {
      try { event(db, aid, 'memory.self.bypass', { score, cap: dayCap, used: usedToday, head: body.slice(0, 40) }) } catch { /* 忽略 */ }
    }
    const row = addMemory(db, aid, {
      text: body, type: 'episode', mark: (m && m.mark) || 'normal',
      source: 'self', confidence: 0.75, importance: score, turn_id: opt.turnId || null,
      speaker: 'self', quote: (m && m.quote) || null, inferred: (m && m.inferred) || 0,
    })
    return { action: row && row.duplicate ? 'merge' : 'new', id: row && row.id, self: true, score }
  }
  const type = (m && m.type) || 'fact'
  /* 署名的兜底：模型没给 speaker 时按 who 推——who=user 是对方的话，who=self 是我的。
     有总比没有强；两边都没标就留空，不硬安一个「可能」。 */
  const who = String((m && m.who) || '')
  const speaker = (m && m.speaker) || (who === 'self' ? 'self' : who === 'user' ? 'user' : null)
  const seedFn = typeof opt.seed === 'function' ? opt.seed : (t, ty) => seedScores(t, ty, 0)
  const ent = (() => { try { return entityForText(db, aid, text) } catch { return null } })()
  const narr = narrationOnly(text)
  // 这个 key 要同时喂给两层：gate 的判定读 cand.fact_key（决定「同 key 原地改写」），
  // addMemory 的落库读 cand.key / cand.fact_key。以前只传了 key，门控拿到的 factKey 永远空，
  // 「同 key 更新」分支在提取路径上从没生效过——旧条全靠 addMemory 的 supersedeByKey 兜底。
  const factKey = String((m && (m.key || m.fact_key)) || '').trim()
  const out = applyWrite(db, aid, {
    text, entity_id: ent ? ent.id : null, fact_key: factKey, key: factKey, terms: (m && m.terms) || [],
  }, (cand) => addMemory(db, aid, {
    text: cand.text, type, mark: (m && m.mark) || 'normal',
    entity_id: cand.entity_id || null, source: 'extract', confidence: narr ? 0.5 : 0.7,
    cold: narr, turn_id: opt.turnId || null, ...seedFn(cand.text, type),
    fact_key: cand.fact_key || cand.key || '', terms: cand.terms || [],
    speaker, quote: (m && m.quote) || null, inferred: (m && m.inferred) || 0,
  }))
  if (narr && out.id && out.action !== 'new') {
    try {
      setMemoryTemp(db, out.id, 'cold', now(), { onlyIfChanged: true })
    } catch { /* 老库没有温度列就算了 */ }
  }
  return out
}
