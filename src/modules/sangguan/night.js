/**
 * 中环一夜（code-guide N1–N8）：检验 ν → 跨层归因 → 结算试用 / CON → 核心确立 → 退化与修补 → 升维超时 → 立案
 * → 审议（L3 惊奇加成）→ 求证 / 溯因 → 反复横跳 → 体征 Qi → 自传摘要 → JOB_DONE。
 * 幂等（I16 / P19）：sg:night:YYYY-MM-DD 已完成则直接返回；每周第一夜顺带跑慢环 sg:week:YYYY-Www（L5 / L2 / L10 / 升维）。
 * 开关关闭直接返回；失败由调用方吞掉，不影响记忆巩固。判定不可用（§12 降级）时暂停 SUB、立案、核心确立与升维。
 */
import { isEnabled } from './config.js'
import { settleTrials } from './trial.js'
import { runNight } from './deliberate.js'
import { judgeHealth } from './llm.js'
import { append, hasJob, readEvents } from './ledger.js'
import { lastSeq } from './ledger.js'
import { isoWeek } from './budget.js'
import { loadState } from './projection.js'
import { checkDue, conCheck, degenCheck, repairHurt, deriveCross, attributeCross } from './practice.js'
import { establishCores } from './core.js'
import { openCandidates } from './open.js'
import { elevTimeouts, runElev } from './elev.js'
import { outcomes } from './precedent.js'
import { buildSummary } from './summary.js'
import { rJOf } from './verdict.js'
import { surpriseBoost, inquire, abduce, flipCheck, qiOf, moveOf, homeostasis, selfDoubt, balance } from './liveness.js'

const nightKey = (day) => 'sg:night:' + day
const weekKey = (day) => 'sg:week:' + isoWeek(day)
const dayOf = (now, opt) => String(opt.day || now).slice(0, 10)

function lastNight(db, aid) {
  return readEvents(db, aid, { types: ['JOB_DONE'] }).filter((e) => String(e.job_key).startsWith('sg:night:')).pop() || null
}

/** 慢环一周（W1–W4）。opt.job === false 时不写幂等键（测试单步）。 */
export async function runWeek(db, aid, now, opt = {}) {
  const day = dayOf(now, opt)
  const key = weekKey(day)
  if (opt.job !== false && hasJob(db, aid, key)) return { status: 'dup', job_key: key }
  const degraded = opt.degraded != null ? opt.degraded : judgeHealth(db, aid, Date.parse(now)).degraded
  const s = loadState(db, aid)
  const rJ = opt.rJ !== undefined ? opt.rJ : rJOf(db, aid, now)
  const l5 = homeostasis(db, aid, now, { ...opt, rJ, outcomes: outcomes(db, aid, s, now) })
  const allowProbe = Object.fromEntries(Object.entries(l5.info).map(([l, v]) => [l, !!v.allowProbe]))
  const move = opt.move != null ? opt.move : readEvents(db, aid, { types: ['JOB_DONE'] }).some((e) => String(e.job_key).startsWith('sg:night:') && e.payload.move && e.at > new Date(Date.parse(now) - 7 * 86400000).toISOString())
  const doubt = opt.doubt === false ? { did: [] } : await selfDoubt(db, aid, now, { ...opt, allowProbe, move })
  const bal = opt.balance === false ? { did: [] } : await balance(db, aid, now, opt)
  const elev = opt.elev === false ? { did: [], skipped: [] } : await runElev(db, aid, now, { ...opt, degraded })
  const summary = { theta: l5.adjust.length, probe: doubt.did.length, edge_adds: bal.did.length, elev: elev.did.length }
  if (opt.job !== false) append(db, aid, [{ type: 'JOB_DONE', actor: 'sys', at: now, job_key: key, payload: { week: isoWeek(day), ...summary } }])
  return { status: 'done', job_key: key, l5, doubt: doubt.did, balance: bal.did, elev, summary }
}

function stepError(e) {
  return String((e && e.message) || e).slice(0, 200)
}

/** 一步失败只记下，不让整夜停掉。fallback 是后面还要用的空结果。 */
async function trap(errors, name, fn, fallback) {
  try { return await fn() } catch (e) {
    errors.push({ step: name, error: stepError(e) })
    return fallback
  }
}

export async function runMid(db, aid, now, opt = {}) {
  if (opt.requireEnabled !== false && !isEnabled(db, aid) && !opt.force) return { status: 'off' }
  const day = dayOf(now, opt)
  const key = nightKey(day)
  if (opt.job !== false && hasJob(db, aid, key)) return { status: 'dup', job_key: key }
  const prev = lastNight(db, aid)
  const degraded = judgeHealth(db, aid, Date.parse(now)).degraded
  const errors = []
  const n1 = await trap(errors, 'n1', () => checkDue(db, aid, now, opt), { did: [], postponed: false })
  let cross = { did: [] }
  const vxIds = {}
  if (opt.cross !== false) {
    // [J] 归因失败 = 闸不通过：今夜不派生（元规则 1）
    const attr = await trap(errors, 'cross', () => attributeCross(db, aid, now, opt), null)
    if (attr) {
      try {
        cross = deriveCross(db, aid, now, { attributed: attr.attributed || {} })
        for (const v of attr.v_exception || []) (vxIds[v.kappa_id] ||= []).push(v.x_id)
      } catch (e) { errors.push({ step: 'derive', error: stepError(e) }) }
    }
  }
  const settle = opt.settle === false ? { did: [] } : await trap(errors, 'settle', () => settleTrials(db, aid, now), { did: [] })
  const con = await trap(errors, 'con', () => conCheck(db, aid, now), { did: [] })
  const core = opt.core === false || degraded ? { did: [] } : await trap(errors, 'core', () => establishCores(db, aid, now, opt), { did: [] })
  const repair = opt.repair === false ? { did: [] } : await trap(errors, 'repair', () => repairHurt(db, aid, now, opt), { did: [] })
  const degen = await trap(errors, 'degen', () => degenCheck(db, aid, now), { did: [] })
  // 升维提案超过 T_approve 视为拒绝，解除 Frozen（零模型）
  const elev = await trap(errors, 'elev', () => elevTimeouts(db, aid, now), { did: [] })
  const open = opt.open === false || degraded ? { did: [] } : await trap(errors, 'open', () => openCandidates(db, aid, now, opt), { did: [] })
  const sBoostMap = await trap(errors, 'surprise', () => surpriseBoost(db, aid, loadState(db, aid), now), {})
  const night = opt.deliberate === false
    ? null
    : await trap(errors, 'deliberate', () => runNight(db, aid, now, {
      allowSub: !degraded, allowCoex: true, judgedVx: true, vxIds, sBoostMap,
      ...opt, ...(degraded ? { allowSub: false } : {}), settle: false, requireEnabled: false,
    }), null)
  // N8 体征先算：动静决定今夜求证力度。这一步坏了，求证按没动静继续
  const qi = await trap(errors, 'qi', () => qiOf(db, aid, now), null)
  const move = await trap(errors, 'move', () => (qi ? moveOf(db, aid, now, qi.qi, opt) : false), false)
  const live = opt.liveness === false
  const inq = live ? { did: [] } : await trap(errors, 'inquire', () => inquire(db, aid, now, { ...opt, boost: move }), { did: [] })
  const abd = live || degraded ? { did: [] } : await trap(errors, 'abduce', () => abduce(db, aid, now, opt), { did: [] })
  const flip = await trap(errors, 'flip', () => flipCheck(db, aid, now, prev ? prev.payload.last_seq || 0 : 0), { did: [] })
  const week = live || opt.week === false ? null : await trap(errors, 'week', () => runWeek(db, aid, now, { ...opt, degraded, move: move || undefined }), null)
  // N7 自传摘要放最后：只吃前面各步剩下的中环预算
  const sum = opt.summary === false ? { did: [] } : await trap(errors, 'summary', () => buildSummary(db, aid, now, opt), { did: [] })
  const res = {
    status: n1.postponed ? 'budget' : 'done', degraded, job_key: key, errors,
    n1, cross, settle: settle.did, con: con.did, core: core.did, repair: repair.did, degen: degen.did, elev: elev.did, open: open.did, night,
    inquiry: inq.did, abduce: abd.did, flip: flip.did, qi, move, week, summary: sum.did,
  }
  if (opt.job !== false) {
    try {
      append(db, aid, [{
        type: 'JOB_DONE', actor: 'sys', at: now, job_key: key,
        payload: {
          day, degraded, qi, move, last_seq: lastSeq(db, aid),
          counts: { delib: night ? night.did.length : 0, open: open.did.length, inquiry: inq.did.length, flip: flip.did.length, con: con.did.length },
          ...(errors.length ? { errors } : {}),
        },
      }])
    } catch (e) {
      errors.push({ step: 'job', error: stepError(e) })
      res.status = 'error'
    }
  }
  return res
}
