/**
 * 内核仪表盘（P1）：只读，不改任何账本。
 *
 * 三个数回答「它有没有为哪句话付过账」：
 *   违背 violated —— 说了没做到，被记下来的次数
 *   兑现率 kept_rate —— 许过的 ν 里，到期结算成 hit 的比例（分母是已结算的）
 *   改主意 changed —— REV / 升维 / 合题确认 / 收回 的次数
 *
 * 再加几个底数：κ、活命题、进料、注入模式。数字全从账本与投影现算，不落缓存。
 */
import { readEvents } from './ledger.js'
import { loadState, listHeads } from './projection.js'
import { isTerminal, SIGMA_OPEN } from './catalog.js'
import { isEnabled, sangguanConfig } from './config.js'
import { injectLog, liveReady, injectView } from './inject.js'
import { getFlag, setFlag } from '../../kernel.js'

const DAY = 86400000
// 「它自己改的主意」：改写、升维、合题确认
const CHANGE_SELF = ['REV', 'ELEV_COMMIT', 'SUB_CONFIRM']
// 「人替它收的」：清退 / 收回。不算它改主意，否则一次清库就能把闸门骗开
const CHANGE_OWNER = ['CLAIM_RETIRE', 'CLAIM_WITHDRAW']

export function scorecard(db, aid, opt = {}) {
  const now = opt.now || new Date().toISOString()
  const days = Number(opt.days) > 0 ? Number(opt.days) : 30
  const since = new Date(Date.parse(now) - days * DAY).toISOString()
  const evs = readEvents(db, aid)
  const s = loadState(db, aid)
  const inWin = (e) => e.at >= since && e.at <= now
  const count = (types) => evs.filter((e) => types.includes(e.type)).length
  const countWin = (types) => evs.filter((e) => types.includes(e.type) && inWin(e)).length

  const claims = Object.values(s.claims).filter((c) => !isTerminal(c.status))
  const byLayer = { W: 0, L: 0, V: 0 }
  for (const c of claims) if (byLayer[c.layer] != null) byLayer[c.layer]++
  const kappas = Object.values(s.kappas)
  // 「在争」只算真正交锋中的；suspended 是放下、coexist 是两样都要，都不该冒充在争
  const openKappa = kappas.filter((k) => k.sigma === 'struggle' || k.sigma === 'sub_trial').length
  const suspendedKappa = kappas.filter((k) => k.sigma === 'suspended').length

  const nus = Object.values(s.nus)
  const settled = nus.filter((n) => n.outcome === 'hit' || n.outcome === 'miss')
  const hit = settled.filter((n) => n.outcome === 'hit').length
  const miss = settled.filter((n) => n.outcome === 'miss').length
  const pending = nus.filter((n) => n.outcome === 'pending').length

  const violated = count(['VIOLATE'])
  const violatedWin = countWin(['VIOLATE'])
  const changedSelf = count(CHANGE_SELF)
  const changedOwner = count(CHANGE_OWNER)
  const changed = changedSelf
  const changedWin = countWin(CHANGE_SELF)

  let inject = { mode: 'off', tokens: 0, shadow_days: 0, ready: false }
  try {
    const cfg = sangguanConfig(db, aid)
    const log = injectLog(db, aid)
    const ready = liveReady(db, aid)
    inject = {
      mode: isEnabled(db, aid) ? cfg.inject : 'off',
      tokens: (log.last && log.last.tokens) || 0,
      days: (log.days || []).length,
      shadow_days: ready.shadow_days,
      need_days: ready.need,
      ready: ready.ready,
      last_change_at: log.last ? log.last.at : null,
    }
  } catch { /* 老库没有开关 */ }

  const keptRate = settled.length ? +(hit / settled.length).toFixed(3) : null
  const kernel = {
    pain: violated > 0,
    debt: settled.length > 0,
    revision: changed > 0,
    tension: openKappa > 0,
  }
  kernel.ready = kernel.pain && kernel.debt && kernel.revision && kernel.tension

  return {
    at: now,
    days,
    claims: { total: claims.length, by_layer: byLayer, v_active: listHeads(db, aid, 'V').filter((h) => h.status === 'active').length },
    kappa: { open: openKappa, suspended: suspendedKappa, total: kappas.length },
    nu: { pending, hit, miss, voided: nus.filter((n) => n.outcome === 'void').length, settled: settled.length, kept_rate: keptRate },
    violated: { total: violated, window: violatedWin },
    changed: { total: changed, self: changedSelf, owner: changedOwner, window: changedWin },
    intake: {
      offered: count(['CLAIM_EXP']),
      dup: count(['DUP']),
      rejected: count(['REJECT']),
      pending_judge: count(['PENDING_JUDGE']),
    },
    inject,
    kernel,
  }
}

const blindKey = (aid) => 'sangguan.blind:' + aid

/** 盲拆结果（由 scripts/blind-diff.mjs 写入；没测过就没有）。 */
export function readBlind(db, aid) {
  try {
    const v = JSON.parse(getFlag(db, blindKey(aid)) || 'null')
    return v && typeof v === 'object' && Number.isFinite(Number(v.rate)) ? v : null
  } catch { return null }
}

export function recordBlind(db, aid, res) {
  const out = { rate: Number(res.rate), n: Number(res.n) || 0, at: res.at || new Date().toISOString() }
  setFlag(db, blindKey(aid), JSON.stringify(out))
  return out
}

/**
 * 切 live 的闸：四条件 + 盲拆。
 * 缺一条都不行；理由按可修的顺序给。
 */
export function liveGate(db, aid, opt = {}) {
  const sc = scorecard(db, aid, opt)
  const blind = readBlind(db, aid)
  const reasons = []
  if ((sc.inject.days || 0) < (sc.inject.need_days || 7)) reasons.push('shadow_days')
  if (!sc.kernel.pain) reasons.push('no_violation')
  if (!sc.kernel.debt) reasons.push('no_settled_nu')
  if (!sc.kernel.revision) reasons.push('no_revision')
  if (!sc.kernel.tension) reasons.push('no_kappa')
  // 注入里得有东西：四条件全满但一句都注不进去，切 live 等于开关了个空气
  let content = 0
  try { content = injectView(db, aid, { now: opt.now || new Date().toISOString(), cache: false, mark: false }).lines.length } catch { content = 0 }
  if (!content) reasons.push('no_content')
  if (!blind) reasons.push('no_blind')
  else if (!(blind.rate > 0)) reasons.push('blind_zero')
  else if ((Number(blind.n) || 0) < 10) reasons.push('blind_low_n')
  return { ok: reasons.length === 0, reasons, scorecard: sc, blind, content }
}
