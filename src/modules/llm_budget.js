/**
 * U0 · 日模型调用硬顶
 *
 * 计入：L1 refine / L2 cluster / 日记成文 / 纪要蒸馏 / 按轮 extract。
 * distill 达日限额或总顶见底时，同日 extract 应降载（skip / 延后）。
 */

import { localDay } from '../db.js'
import { getParam, getFlag, setFlag } from '../kernel.js'

const KINDS = ['refine', 'cluster', 'diary', 'distill', 'extract']

function dayKey(day) {
  return String(day || localDay()).slice(0, 10)
}

function usedKey(aid, day) {
  return 'llm.budget.used:' + aid + ':' + dayKey(day)
}

function detailKey(aid, day) {
  return 'llm.budget.detail:' + aid + ':' + dayKey(day)
}

function parseDetail(raw) {
  try {
    const o = JSON.parse(String(raw || '{}'))
    const out = {}
    for (const k of KINDS) out[k] = Math.max(0, Number(o[k]) || 0)
    return out
  } catch {
    const out = {}
    for (const k of KINDS) out[k] = 0
    return out
  }
}

export function llmDailyCap(db, aid) {
  try {
    const n = Number(getParam(db, aid, 'memory.llm.daily_cap'))
    if (!Number.isFinite(n) || n <= 0) return 0 // 0 = 不限额
    return Math.max(1, Math.min(64, Math.round(n)))
  } catch { return 16 }
}

export function llmBudgetSnapshot(db, aid, day = localDay()) {
  const d = dayKey(day)
  const cap = llmDailyCap(db, aid)
  let used = 0
  try { used = Math.max(0, Number(getFlag(db, usedKey(aid, d)) || 0) || 0) } catch { used = 0 }
  let detail = parseDetail(null)
  try { detail = parseDetail(getFlag(db, detailKey(aid, d))) } catch { /* keep */ }
  const left = cap > 0 ? Math.max(0, cap - used) : Infinity
  return { day: d, cap, used, left, detail }
}

/** 是否还能再记一次模型调用（cap=0 表示不限）。 */
export function llmBudgetAllow(db, aid, day = localDay(), need = 1) {
  const snap = llmBudgetSnapshot(db, aid, day)
  if (!snap.cap) return { ok: true, ...snap }
  const n = Math.max(1, Number(need) || 1)
  return { ok: snap.used + n <= snap.cap, ...snap }
}

/** 记账一次成功的模型调用。 */
export function llmBudgetBump(db, aid, kind, day = localDay(), n = 1) {
  const d = dayKey(day)
  const k = KINDS.includes(kind) ? kind : 'extract'
  const add = Math.max(1, Number(n) || 1)
  const snap = llmBudgetSnapshot(db, aid, d)
  const used = snap.used + add
  const detail = { ...snap.detail, [k]: (snap.detail[k] || 0) + add }
  try {
    setFlag(db, usedKey(aid, d), String(used))
    setFlag(db, detailKey(aid, d), JSON.stringify(detail))
  } catch { /* ignore */ }
  return { day: d, cap: snap.cap, used, left: snap.cap ? Math.max(0, snap.cap - used) : Infinity, detail }
}

/**
 * 同日 extract 是否应降载：
 * - distill 已达自身 daily_cap，或
 * - 总顶剩余不足以再跑 extract
 */
export function shouldDeferExtract(db, aid, day = localDay()) {
  const d = dayKey(day)
  const snap = llmBudgetSnapshot(db, aid, d)
  if (snap.cap && snap.left < 1) {
    return { defer: true, reason: 'daily_cap', ...snap }
  }
  let distillOn = true
  try {
    distillOn = String(getParam(db, aid, 'memory.episode.distill') || 'on') !== 'off'
  } catch { distillOn = true }
  if (distillOn) {
    let distillCap = 6
    try {
      distillCap = Math.max(0, Number(getParam(db, aid, 'memory.episode.distill.daily_cap') ?? 6) || 0)
    } catch { distillCap = 6 }
    if (distillCap > 0 && (snap.detail.distill || 0) >= distillCap) {
      return { defer: true, reason: 'distill_cap', ...snap }
    }
  }
  return { defer: false, reason: '', ...snap }
}

/**
 * 把同日仍 pending 的 extract 延后到次日 00:05（本地），并记 skip 原因到 last_error。
 * @returns {number} 改写条数
 */
export function deferExtractForDay(db, aid, day = localDay(), reason = 'budget') {
  const d = dayKey(day)
  const [y, m, dd] = d.split('-').map(Number)
  const next = new Date(y, m - 1, dd + 1, 0, 5, 0)
  const nextAt = next.toISOString()
  const msg = ('deferred:' + reason).slice(0, 300)
  try {
    // 只推迟「今天创建队、还没跑」的：用 created_at 的本地日不好查，改用更新窗口——
    // 简化：该 agent 全部 pending 一律延到 nextAt（忙天降载；明天会再跑）
    return Number(db.prepare(`UPDATE extract_queue SET next_at=?, last_error=?, updated_at=?
      WHERE agent_id=? AND state='pending'`).run(nextAt, msg, new Date().toISOString(), aid).changes || 0)
  } catch { return 0 }
}
