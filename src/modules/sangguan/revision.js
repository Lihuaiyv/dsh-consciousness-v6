/**
 * 会改主意（P4）：改可以，但要付两样东西——代价，和额度。
 *
 *   - 改一条保护带：必须写下这次放弃/付出什么（cost），30 天最多 3 次
 *   - 换一层核心：只能走升维审批，30 天最多 1 次
 * 改完旧命题留在账本里进先例，不删；注入里说一轮「我改了一个看法」。
 */
import { append, readEvents, newId } from './ledger.js'
import { loadState } from './projection.js'
import { isTerminal, isCoreKind } from './catalog.js'
import { SangguanError } from './errors.js'

const DAY = 86400000
const BELT_LIMIT = 3
const CORE_LIMIT = 1

function since(at, days = 30) {
  return new Date(Date.parse(at) - days * DAY).toISOString()
}

/** 30 天额度：核心 1 次，保护带 3 次。 */
export function revisionBudget(db, aid, layer, at) {
  const from = since(at)
  const evs = readEvents(db, aid, { types: ['REV', 'ELEV_COMMIT'] }).filter((e) => e.layer === layer && e.at >= from)
  const core = evs.filter((e) => e.type === 'ELEV_COMMIT').length
  const belt = evs.filter((e) => e.type === 'REV').length
  return {
    core_left: Math.max(0, CORE_LIMIT - core),
    belt_left: Math.max(0, BELT_LIMIT - belt),
    core_ok: core < CORE_LIMIT,
    belt_ok: belt < BELT_LIMIT,
  }
}

/**
 * 改一条保护带命题。cost 必填：说清这次放弃什么。
 * @returns {{ id, old_id, text }}
 */
export function reviseClaim(db, aid, body = {}, at = new Date().toISOString()) {
  const s = loadState(db, aid)
  const old = s.claims[body.id]
  if (!old) throw new SangguanError('INVALID', '没有这条命题')
  if (isTerminal(old.status)) throw new SangguanError('INVALID', '这条已经不在用了')
  if (isCoreKind(old.layer, old.kind)) throw new SangguanError('INVALID', '核心只能走升维审批，不能直接改')
  // 承诺不是看法：改承诺要走确认 / 结算，不能当价值命题改写
  if (old.kind === 'commit') throw new SangguanError('INVALID', '承诺不是看法，别当价值观改；到期结算或确认即可')
  const text = String(body.text || '').trim()
  if (text.length < 4 || text.length > 200) throw new SangguanError('INVALID', '新说法一句 4–200 字')
  const cost = String(body.cost || '').trim()
  if (cost.length < 4) throw new SangguanError('INVALID', '改主意要说清放弃/付出了什么（cost）')
  const budget = revisionBudget(db, aid, old.layer, at)
  if (!budget.belt_ok) throw new SangguanError('INVALID', '这一层 30 天已经改了 ' + BELT_LIMIT + ' 次，先别急')
  const id = newId('claims', at)
  const r = append(db, aid, [{
    type: 'REV', layer: old.layer, actor: 'user', at,
    payload: {
      claims: [{ id, layer: old.layer, kind: old.kind, text, origin: 'user', pred: [old.id] }],
      old_id: old.id,
      cost,
    },
  }])
  return { id: r.entities.claims[0], old_id: old.id, text, cost }
}
