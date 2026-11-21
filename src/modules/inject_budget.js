/**
 * 注入预算表（P3，2026-11-15）：一处读额度，先做到「值不变、来源唯一」。
 *   memory：检索注入（token）
 *   event ：自己想起那行（字）
 * 行为变更（让额度）不在这一刀里；这一刀只是把散落的 `|| 800 / || 400` 收过来。
 */
import { getParam } from '../kernel.js'

export const DEFAULTS = { memory: 800, event: 400 }

const PARAM = { memory: 'memory.inject.budget', event: 'event.inject.budget' }

export function budgetOf(db, aid, key) {
  const dflt = DEFAULTS[key] || DEFAULTS.memory
  const param = PARAM[key]
  if (!param) return dflt
  try {
    const n = Number(getParam(db, aid, param))
    return Number.isFinite(n) && n > 0 ? n : dflt
  } catch { return dflt }
}

/** 一张表：调用方一次拿全，避免各自再读参数。 */
export function budgetTable(db, aid) {
  return { memory: budgetOf(db, aid, 'memory'), event: budgetOf(db, aid, 'event') }
}
