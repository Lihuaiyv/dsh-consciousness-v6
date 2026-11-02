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

import { now } from '../db.js'
import { nid, getParam, getFlag } from '../kernel.js'
import { growValues } from './values.js'
import { growWorldview } from './worldview.js'
import { growLifeview } from './lifeview.js'
import { buildEpisode, buildDiary } from './archive.js'
import { refreshHeat } from './tiers.js'
import { tickTemps } from './temps.js'
import { pruneRetrievalLog } from './retrieval_log.js'
import { pruneQueue } from './extract_queue.js'
import { pruneSurfaced } from './surfacing.js'
import { consolidatePending, canConsolidate, reflectFrom, reflectCursor } from './consolidate.js'
import { prune as pruneAxisEvidence } from './axis_evidence.js'
import { scan as scanPersona } from './self_scan.js'
import { run as runPersonaJudge } from './persona_judge.js'
import { run as runProbes } from './persona_probe.js'

/** 本地日期（不要用 toISOString，那是 UTC，跨零点会错一天）。 */
export function localDay(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
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
    return !!db.prepare(`SELECT 1 FROM memory_items
      WHERE agent_id=? AND status='active' AND invalid_at IS NULL AND substr(created_at,1,10)=? LIMIT 1`).get(aid, day)
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
  if (!opt.force) {
    const done = db.prepare('SELECT 1 FROM consolidation_log WHERE agent_id=? AND day=?').get(aid, day)
    if (done) return { day, skipped: true, steps: [], reason: '这天已经做过' }
  }
  const t0 = Date.now()
  const steps = []
  const push = (name, extra = {}) => steps.push({ step: name, ...extra })

  // ① 当天各会话补纪要
  let episodes = 0
  try {
    const sessions = db.prepare('SELECT DISTINCT session_id FROM raw_turns WHERE agent_id=? AND day=?').all(aid, day)
    for (const s of sessions) {
      const has = db.prepare('SELECT 1 FROM episodes WHERE agent_id=? AND day=? AND session_id IS ?').get(aid, day, s.session_id)
      if (has) continue
      try {
        const ep = buildEpisode(db, aid, { session: s.session_id, day })
        if (ep) episodes++
      } catch { /* 单会话失败不影响别的 */ }
    }
    push('episodes', { ok: true, count: episodes })
  } catch (e) {
    push('episodes', { ok: false, error: String(e && e.message) })
  }

  // ② 写这一天的日记（补写时 late=1：写的时候已经不是那一天了）
  let diary = null
  const late = localDay(new Date()) === day ? 0 : 1
  try {
    const has = db.prepare('SELECT 1 FROM diaries WHERE agent_id=? AND day=?').get(aid, day)
    if (!has) diary = await buildDiary(db, aid, day, { summarize: opt.summarize || null, late })
    push('diary', { ok: true, built: diary ? diary.day : null, skipped: !diary, late })
  } catch (e) {
    push('diary', { ok: false, error: String(e && e.message) })
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
    const surfaced = pruneSurfaced(db, 60)
    push('prune', { ok: true, retrieval_log: logs, extract_queue: queued, surfaced })
  } catch (e) {
    push('prune', { ok: false, error: String(e && e.message) })
  }

  // ⑤ 用模型把重复的自省/摘要合并掉（没有模型就跳过，不拖慢巩固）
  try {
    if (opt.merge !== false && canConsolidate()) {
      const m = await consolidatePending(db, aid, { limit: Math.max(1, Math.min(10, Number(opt.mergeLimit) || 3)) })
      push('memory_merge', { ok: !!m.ok, merged: m.done || 0, dropped: m.dropped || 0, failed: m.failed || 0, left: m.left || 0 })
    } else {
      push('memory_merge', { ok: true, skipped: true, reason: opt.merge === false ? 'off' : 'no model' })
    }
  } catch (e) {
    push('memory_merge', { ok: false, error: String(e && e.message) })
  }

  // ⑤b 累计重要性到线：白天没来得及压的流水账，这里补一次反思
  try {
    const need = Math.max(0.5, Math.min(50, Number(getParam(db, aid, 'memory.reflect.acc')) || 5))
    const cur = reflectCursor(db, aid)
    const acc = Number(cur.acc || 0)
    if (opt.merge !== false && acc >= need && canConsolidate()) {
      const r = await reflectFrom(db, aid)
      push('memory_reflect', { ok: !!r.ok, keep: r.keep, members: r.members || 0, superseded: r.superseded || 0, reason: r.reason })
    } else {
      push('memory_reflect', { ok: true, skipped: true, acc, need, reason: opt.merge === false ? 'off' : (acc < need ? 'below' : 'no model') })
    }
  } catch (e) {
    push('memory_reflect', { ok: false, error: String(e && e.message) })
  }

  // ⑥ 叙事证据：v2 起并入 persona_scan（它自己也读日记，避免同一篇日记被算两遍）。
  push('narrative', { ok: true, skipped: true, reason: 'v2 并入 persona_scan' })

  // ⑦ 证据表清理（60 天前的）
  try {
    const pruned = pruneAxisEvidence(db, aid)
    push('axis_evidence', { ok: true, pruned })
  } catch (e) {
    push('axis_evidence', { ok: false, error: String(e && e.message) })
  }

  // ⑧ 性格拔河：扫「她自己这一段时间的行为」→ 左右两个拉力池 → 该动才动。
  //    时间窗从上次扫到的地方开始（挂机/关机都靠这里补），不依赖当天正好醒着。
  try {
    const p = scanPersona(db, aid)
    push('persona_scan', { ok: true, since: p.since, until: p.until, evidence: p.evidence, moved: (p.moved || []).length, skipped: p.skipped })
  } catch (e) {
    push('persona_scan', { ok: false, error: String(e && e.message) })
  }

  // ⑨ 第二判：词表没认出来的轮次交给模型判，但每条都要被她回复里的原文核对过。
  //    没配模型就跳过，不算失败——这层是锦上添花，不能拖垮夜间巩固。
  try {
    const j = await runPersonaJudge(db, aid, { limit: 16 })
    push('persona_judge', { ok: true, ...j })
  } catch (e) {
    push('persona_judge', { ok: true, error: String(e && e.message) })
  }

  // ⑩ 每周情境探针：只做校准（拿她的选择跟当前字母对一对），不进拉力池。
  try {
    const pr = await runProbes(db, aid)
    push('persona_probe', { ok: true, ...pr })
  } catch (e) {
    push('persona_probe', { ok: true, error: String(e && e.message) })
  }

  // ⑪ 价值观 / 世界观 / 人生观 重长（三观引擎的旧仪表；sangguan.cleaned 之后跳过）
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
  // ⑪b 三观种子：旧仪表刚重算完，只种一次。空仪表留到下一夜。
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
  // ⑪c 三观中环（默认关；先过 isEnabled；失败不影响记忆巩固）
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

// 日记口吻词表已经随 narrativeEvidence 一起删掉（v2 起并入 persona_scan）。

/**
 * 最近三天日记 → 一条 E/I 低强度证据（每 3 天最多一次）。
 * 理由：低能量 / 退缩的叙事 → 偏内向；有劲 / 期待的叙事 → 偏外向。
 * 这是它对自己的叙述，属于慢漂：强度低、频率低，和单轮聊天证据不同权。
 */
