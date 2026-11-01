/**
 * P4 夜间巩固
 *
 * 每天 23:00 跑一次，把当天的原始对话压成能用的东西：
 *   ① 给当天各会话补纪要（T2）
 *   ② 用纪要给当天写日记（T3，第二天就是「昨天的日记」）
 *   ③ 重算热度与档位（T1 的 short/mid/long）
 *   ④ 顺手清理过期日志与队列
 *
 * 23:00 准点跑。关机 / 休眠 / 进程被挂起错过的，不丢：
 * dueDiaryDays() 会在下次启动或每半小时的兜底检查里，把「到点没写、但还有原料」
 * 的那几天按天补上，补的那几篇标 late=1（前端显示「补写」）。
 * 没有模型也能跑：纪要/日记的模板版本来就是确定性的。
 */

import { now, localDay as localDayOf, localDayBounds } from '../db.js'
import { nid, getFlag, setFlag, getParam } from '../kernel.js'
import { buildEpisodes, buildDiary, refineEpisodesForDay, clusterRefineForDay } from './archive.js'
import { distillEpisodesForDay } from './episode_distill.js'
import { llmBudgetSnapshot, shouldDeferExtract, deferExtractForDay } from './llm_budget.js'
import { refreshHeat } from './tiers.js'
import { tickTemps } from './temps.js'
import { pruneRetrievalLog } from './retrieval_log.js'
import { pruneQueue } from './extract_queue.js'
import { consolidatePending, canConsolidate } from './consolidate.js'
import { resolveEntitiesForDay } from './entity_resolve.js'
import { auditTimeline } from './timeline.js'
import { addEvidence, flush as flushAxisEvidence, prune as pruneAxisEvidence } from './axis_evidence.js'
import { growValues } from './values.js'
import { growWorldview } from './worldview.js'
import { growLifeview } from './lifeview.js'

/** 本地日期（不要用 toISOString，那是 UTC，跨零点会错一天）。 */
export function localDay(d = new Date()) {
  return localDayOf(d)
}

/** 这天有没有写日记的原料：原文 / 纪要 / 当天记下的事实。 */
export function hasDiaryMaterial(db, aid, day) {
  try {
    if (db.prepare('SELECT 1 FROM raw_turns WHERE agent_id=? AND day=? LIMIT 1').get(aid, day)) return true
  } catch { /* 老库还没有原文层 */ }
  try {
    if (db.prepare('SELECT 1 FROM episodes WHERE agent_id=? AND day=? LIMIT 1').get(aid, day)) return true
  } catch { /* 老库还没有纪要层 */ }
  try {
    const { start, end } = localDayBounds(day)
    return !!db.prepare(`SELECT 1 FROM memory_items
      WHERE agent_id=? AND status='active' AND invalid_at IS NULL
        AND created_at>=? AND created_at<? LIMIT 1`).get(aid, start, end)
  } catch { return false }
}

/**
 * 到点但还没写的日子（升序）。
 * 今天要过了 hour 才算到期；更早的每天都算。最多回看 backfillDays 天
 * （0 = 不补，只在到点那一刻写当天）。
 */
export function dueDiaryDays(db, aid, opt = {}) {
  const t = new Date(Number(opt.from) || Date.now())
  const hour = Math.min(23, Math.max(0, Number(opt.hour ?? 23)))
  const backfill = Math.min(30, Math.max(0, Number(opt.backfillDays ?? 7)))
  const out = []
  for (let i = backfill; i >= 0; i--) {
    if (i === 0 && t.getHours() < hour) continue
    const day = localDay(new Date(t.getFullYear(), t.getMonth(), t.getDate() - i))
    if (db.prepare('SELECT 1 FROM diaries WHERE agent_id=? AND day=?').get(aid, day)) continue
    out.push(day)
  }
  return out
}

export function lastConsolidation(db, aid) {
  try {
    return db.prepare('SELECT * FROM consolidation_log WHERE agent_id=? ORDER BY day DESC LIMIT 1').get(aid) || null
  } catch { return null }
}

export function consolidationLog(db, aid, days = 14) {
  const since = localDay(new Date(Date.now() - Math.max(1, Number(days) || 14) * 86400000))
  try {
    return db.prepare('SELECT * FROM consolidation_log WHERE agent_id=? AND day>=? ORDER BY day DESC LIMIT 60')
      .all(aid, since)
      .map((r) => {
        let steps = []
        try { steps = JSON.parse(r.steps || '[]') } catch { steps = [] }
        return { ...r, steps, ok: Number(r.ok) === 1 }
      })
  } catch { return [] }
}

/**
 * 巩固某一天。已经做过就跳过（除非 force）。
 * @returns {Promise<{day:string, skipped?:boolean, steps:Array}>}
 */
export async function runNightly(db, aid, opt = {}) {
  const day = String(opt.day || localDay(new Date(Date.now() - 86400000)))
  let repairOnly = false
  if (!opt.force) {
    const done = db.prepare('SELECT 1 FROM consolidation_log WHERE agent_id=? AND day=?').get(aid, day)
    if (done) {
      const hasDiary = db.prepare('SELECT 1 FROM diaries WHERE agent_id=? AND day=?').get(aid, day)
      // 账做过但日记丢了：只补日记，不整日 skip
      if (hasDiary) return { day, skipped: true, steps: [], reason: '这天已经做过' }
      repairOnly = true
    }
  }
  const t0 = Date.now()
  const steps = []
  const push = (name, extra = {}) => steps.push({ step: name, ...extra })

  let episodes = 0
  let episodesUpdated = 0
  let chapters = null

  if (!repairOnly) {
    // ① 当天各会话纪要：按 E0 切段重算（滤噪 / 打分抽样 / 多 seg）
    try {
      const sessions = db.prepare('SELECT DISTINCT session_id FROM raw_turns WHERE agent_id=? AND day=?').all(aid, day)
      for (const s of sessions) {
        try {
          const list = buildEpisodes(db, aid, { session: s.session_id, day })
          for (const ep of list) {
            if (ep.updated) episodesUpdated++
            else episodes++
          }
        } catch { /* 单会话失败不影响别的 */ }
      }
      push('episodes', { ok: true, count: episodes, updated: episodesUpdated })
    } catch (e) {
      push('episodes', { ok: false, error: String(e && e.message) })
    }

    // ①b L1 金标精修（少次、有日限额；无模型则跳过）
    try {
      const r = await refineEpisodesForDay(db, aid, day, opt.summarize || null)
      push('episode_refine', { ok: true, ...r })
    } catch (e) {
      push('episode_refine', { ok: false, error: String(e && e.message) })
    }

    // ①c L2 忙天簇修（纪要很多时一天最多一次模型）
    try {
      const c = await clusterRefineForDay(db, aid, day, opt.summarize || null)
      if (c.ok && c.chapters) chapters = c.chapters
      push('episode_cluster', { ok: !!c.ok, skipped: !!c.skipped, reason: c.reason, n: c.chapters ? c.chapters.length : 0 })
    } catch (e) {
      push('episode_cluster', { ok: false, error: String(e && e.message) })
    }

    // ①d M1/M2 纪要→事实（L2 后、日记前，使当天日记能看见新事实）
    try {
      const extractFn = typeof opt.extract === 'function'
        ? opt.extract
        : (typeof opt.summarize === 'function' ? opt.summarize : null)
      const d = await distillEpisodesForDay(db, aid, day, extractFn, opt.distill || {})
      const budget = llmBudgetSnapshot(db, aid, day)
      let extractSkipped = 0
      try {
        const def = shouldDeferExtract(db, aid, day)
        if (def.defer) extractSkipped = deferExtractForDay(db, aid, day, def.reason || 'budget')
      } catch { extractSkipped = 0 }
      push('episode_distill', {
        ok: true,
        skipped: !!d.skipped,
        reason: d.reason,
        distilled: d.distilled || 0,
        written: d.written || 0,
        merged: d.merged || 0,
        conflict: d.conflict || 0,
        dropped: d.dropped || 0,
        capped: !!d.capped,
        prefer_cluster: !!d.prefer_cluster,
        candidates: d.candidates || 0,
        budget_used: budget.used,
        budget_cap: budget.cap,
        extract_skipped: extractSkipped,
      })
    } catch (e) {
      push('episode_distill', { ok: false, error: String(e && e.message) })
    }
  } else {
    push('repair', { ok: true, reason: 'consolidation_done_missing_diary' })
  }

  // ② 写这一天的日记（补写时 late=1；force / 修复时允许覆盖重写）
  let diary = null
  const late = localDay(new Date()) === day ? 0 : 1
  try {
    const has = db.prepare('SELECT 1 FROM diaries WHERE agent_id=? AND day=?').get(aid, day)
    if (!has || opt.force || repairOnly) {
      diary = await buildDiary(db, aid, day, {
        summarize: opt.summarize || null,
        late: repairOnly ? 1 : late,
        force: !!(opt.force || repairOnly),
        chapters: chapters || undefined,
      })
    }
    const pack = diary && diary.pack
    push('diary', {
      ok: true,
      built: diary && !diary.skipped ? diary.day : null,
      skipped: !diary || !!diary.skipped,
      late: repairOnly ? 1 : late,
      repaired: !!repairOnly,
      source: diary && diary.source,
      fail_reason: diary && diary.fail_reason,
      mood_source: diary && diary.mood_source,
      pack: pack ? {
        n_cluster: pack.n_cluster, n_model: pack.n_model, n_rules: pack.n_rules,
        prefer_cluster: pack.prefer_cluster, skipped_low: pack.skipped_low,
        dropped_episodes: pack.dropped_episodes, chars: pack.chars,
        retry_of: pack.retry_of,
      } : null,
    })
  } catch (e) {
    push('diary', { ok: false, error: String(e && e.message) })
  }

  if (repairOnly) {
    const ok = steps.every((s) => s.ok !== false)
    const ms = Date.now() - t0
    try {
      db.prepare(`INSERT INTO consolidation_log(id,agent_id,day,at,steps,ok,ms) VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(agent_id,day) DO UPDATE SET at=excluded.at, steps=excluded.steps, ok=excluded.ok, ms=excluded.ms`)
        .run(nid('csl_'), aid, day, now(), JSON.stringify(steps).slice(0, 2000), ok ? 1 : 0, ms)
    } catch { /* ignore */ }
    return { day, skipped: false, repaired: true, steps, ok, ms, episodes: 0, late: 1, diary_day: diary ? diary.day : null }
  }

  // ③ 重算热度档位 + 推进温度状态机（P5）
  try {
    const counts = refreshHeat(db, aid)
    const moved = tickTemps(db, aid)
    push('heat', { ok: true, counts, temps: moved.length })
  } catch (e) {
    push('heat', { ok: false, error: String(e && e.message) })
  }

  // ④ 清理过期日志与队列
  try {
    const logs = pruneRetrievalLog(db, aid)
    const queued = pruneQueue(db, aid)
    push('prune', { ok: true, retrieval_log: logs, extract_queue: queued })
  } catch (e) {
    push('prune', { ok: false, error: String(e && e.message) })
  }

  // ⑤a U3 实体别名合并 + 当日事实补挂 entity_id（规则底 + 可选 1 次模型）
  try {
    const er = await resolveEntitiesForDay(db, aid, day, opt.summarize || null, opt.entityResolve || {})
    push('entity_resolve', {
      ok: !!er.ok, skipped: !!er.skipped, reason: er.reason,
      merged: er.merged || 0, backfilled: er.backfilled || 0, rule: er.rule || 0,
    })
  } catch (e) {
    push('entity_resolve', { ok: false, error: String(e && e.message) })
  }

  // ⑤ 合并重复自省；U3 同时规则合并同 key/同实体事实（无模型也能合事实）
  try {
    if (opt.merge === false) {
      push('memory_merge', { ok: true, skipped: true, reason: 'off' })
    } else {
      const m = await consolidatePending(db, aid, {
        limit: Math.max(1, Math.min(10, Number(opt.mergeLimit) || 3)),
        factLimit: Math.max(1, Math.min(10, Number(opt.factLimit) || 5)),
      })
      push('memory_merge', {
        ok: !!m.ok, merged: m.done || 0, dropped: m.dropped || 0, failed: m.failed || 0, left: m.left || 0,
        facts: m.facts ? m.facts.done : 0, reason: m.reason,
      })
    }
  } catch (e) {
    push('memory_merge', { ok: false, error: String(e && e.message) })
  }

  // ⑤b G1 时效索引对账：漏记的作废 / 隐藏补一条 SYNC，没事件的老记忆补录
  try {
    const a = auditTimeline(db, aid, { limit: Number(opt.timelineLimit) || 200 })
    push('timeline_audit', { ok: a.ok !== false, checked: a.checked, fixed: a.fixed, missing: a.missing })
  } catch (e) {
    push('timeline_audit', { ok: false, error: String(e && e.message) })
  }

  // ⑥ 叙事一致性：最近三天的日记口吻 → 一条低强度证据（每 3 天最多一次）。
  //    「我最近很沉」是它自己的叙事，属于慢漂，不该和单轮聊天的证据同权。
  try {
    const n = narrativeEvidence(db, aid)
    push('narrative', { ok: true, ...n })
  } catch (e) {
    push('narrative', { ok: false, error: String(e && e.message) })
  }

  // ⑦ 证据表清理（60 天前的）
  try {
    const pruned = pruneAxisEvidence(db, aid)
    push('axis_evidence', { ok: true, pruned })
  } catch (e) {
    push('axis_evidence', { ok: false, error: String(e && e.message) })
  }

  // ⑧ 价值观重长（参数 persona.values.nightly，默认 on）
  try {
    const cleaned = String(getFlag(db, 'sangguan.cleaned') || '') === '1'
    const on = !cleaned && String(getParam(db, aid, 'persona.values.nightly') || 'on') !== 'off'
    if (on) {
      const vals = growValues(db, aid, { force: true })
      push('values', { ok: true, n: Array.isArray(vals) ? vals.length : 0 })
    } else {
      push('values', { ok: true, skipped: true, reason: cleaned ? 'cleaned' : 'off' })
    }
  } catch (e) {
    push('values', { ok: false, error: String(e && e.message) })
  }

  // ⑧b 世界观重长（Primals / WAS / Social Axioms 拼装；默认 on）
  try {
    const cleaned = String(getFlag(db, 'sangguan.cleaned') || '') === '1'
    const on = !cleaned && String(getParam(db, aid, 'persona.worldview.nightly') || 'on') !== 'off'
    if (on) {
      const rows = growWorldview(db, aid, { force: true })
      push('worldview', { ok: true, n: Array.isArray(rows) ? rows.length : 0 })
    } else {
      push('worldview', { ok: true, skipped: true, reason: cleaned ? 'cleaned' : 'off' })
    }
  } catch (e) {
    push('worldview', { ok: false, error: String(e && e.message) })
  }

  // ⑧c 人生观重长（MEMS / MLQ / Ryff；默认 on；宜在价值观之后以便弱耦合）
  try {
    const cleaned = String(getFlag(db, 'sangguan.cleaned') || '') === '1'
    const on = !cleaned && String(getParam(db, aid, 'persona.lifeview.nightly') || 'on') !== 'off'
    if (on) {
      const rows = growLifeview(db, aid, { force: true })
      push('lifeview', { ok: true, n: Array.isArray(rows) ? rows.length : 0 })
    } else {
      push('lifeview', { ok: true, skipped: true, reason: cleaned ? 'cleaned' : 'off' })
    }
  } catch (e) {
    push('lifeview', { ok: false, error: String(e && e.message) })
  }

  // ⑧c2 三观种子：旧仪表刚重算完，只种一次。空仪表留到下一夜。
  try {
    const { isEnabled } = await import('./sangguan/config.js')
    if (isEnabled(db, aid)) {
      const { seedFromMeters } = await import('./sangguan/seed.js')
      const seeded = seedFromMeters(db, aid, now())
      push('sangguan_seed', { ok: true, seeded: seeded.seeded })
    }
  } catch (e) {
    push('sangguan_seed', { ok: true, skipped: true, error: String(e && e.message) })
  }

  // ⑧d 三观中环（默认关；先过 isEnabled；失败不影响记忆巩固）
  try {
    const { isEnabled } = await import('./sangguan/config.js')
    if (isEnabled(db, aid)) {
      const { runMid } = await import('./sangguan/night.js')
      const mid = await runMid(db, aid, now(), { day })
      push('sangguan', { ok: true, status: mid.status })
    }
  } catch (e) {
    push('sangguan', { ok: true, skipped: true, error: String(e && e.message) })
  }

  const ok = steps.every((s) => s.ok !== false)
  const ms = Date.now() - t0
  try {
    db.prepare(`INSERT INTO consolidation_log(id,agent_id,day,at,steps,ok,ms) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(agent_id,day) DO UPDATE SET at=excluded.at, steps=excluded.steps, ok=excluded.ok, ms=excluded.ms`)
      .run(nid('csl_'), aid, day, now(), JSON.stringify(steps).slice(0, 2000), ok ? 1 : 0, ms)
  } catch { /* 记账失败不影响巩固结果 */ }

  return { day, skipped: false, steps, ok, ms, episodes, late, diary_day: diary ? diary.day : null }
}

// 日记口吻词表：只认字面，不做语义判断（模型不可用时的确定性兜底）
const NEG_NARR = /累|沉|没劲|烦|难|闷|空|后悔|不想动/g
const POS_NARR = /开心|有劲|想做|喜欢|期待|踏实|亮/g

/**
 * 最近三天日记 → 一条 E/I 低强度证据（每 3 天最多一次）。
 * 理由：低能量 / 退缩的叙事 → 偏内向；有劲 / 期待的叙事 → 偏外向。
 * 这是它对自己的叙述，属于慢漂：强度低、频率低，和单轮聊天证据不同权。
 */
export function narrativeEvidence(db, aid) {
  let last = NaN
  try { last = Date.parse(getFlag(db, 'axis.narr:' + aid) || '') } catch { last = NaN }
  if (Number.isFinite(last) && Date.now() - last < 3 * 86400000) return { skipped: 'cooldown' }
  let rows = []
  try { rows = db.prepare('SELECT text FROM diaries WHERE agent_id=? ORDER BY day DESC LIMIT 3').all(aid) } catch { rows = [] }
  const body = rows.map((r) => String(r.text || '')).join('\n')
  if (!body) return { skipped: 'no-diary' }
  const neg = (body.match(NEG_NARR) || []).length
  const pos = (body.match(POS_NARR) || []).length
  if (neg === pos) return { skipped: 'flat', neg, pos }
  const dir = neg > pos ? -1 : 1
  const strength = Math.min(0.4, 0.15 + Math.abs(neg - pos) * 0.05)
  addEvidence(db, aid, { axis: 'ei', dir, strength, source: 'narrative' })
  try { setFlag(db, 'axis.narr:' + aid, now()) } catch { /* ignore */ }
  const moved = flushAxisEvidence(db, aid)
  return { dir, neg, pos, moved: moved.length }
}
