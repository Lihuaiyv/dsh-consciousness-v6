/**
 * 情绪评价编排：关系边偏置 → 评价 → 咽回半句落库。
 * 从 features.js 整段搬出，行为不变；features 只 re-export。
 */
import { getParam, event, model as kernelModel } from '../kernel.js'
import { appraise, getAffect } from './affect.js'
import { computeEdgeBias } from './edges.js'
import { readAxes } from './traits.js'
import { rulesAppraise, looksNonHuman } from '../algo/appraise.js'
import { whoIsSpeaking } from './who.js'
import { listRelations } from './persona.js'
import { resolveStructureEdges, affectLabels } from './artifacts.js'
import { getCondition } from './ops.js'
import { recordMetric } from './metrics.js'
import { summarizeAffairs } from './affect_v4_shadow.js'

/** 最近两句用户话（不含当前这句）：短句要靠上下文才判得准（「我真是服了」）
 *  给 conversationId 时只取这一段：别段的上一句不是这一段的上下文。 */
export function recentUserContext(db, aid, text, conversationId = null) {
  try {
    const cur = String(text || '').trim()
    const conv = conversationId == null || String(conversationId).trim() === '' ? null : String(conversationId)
    const rows = conv
      ? db.prepare("SELECT text FROM chat_turns WHERE agent_id=? AND role='user' AND conversation_id=? ORDER BY created_at DESC, rowid DESC LIMIT 8").all(aid, conv)
      : db.prepare("SELECT text FROM chat_turns WHERE agent_id=? AND role='user' ORDER BY created_at DESC, rowid DESC LIMIT 8").all(aid)
    const out = []
    for (const r of rows) {
      const t = String(r.text || '').trim()
      if (!t || t === cur || out.includes(t)) continue
      out.push(t)
      if (out.length >= 2) break
    }
    return out.reverse().join('\n')
  } catch { return '' }
}

/**
 * 「咽回去的那半句」落库（P3，影子）。
 * 只写一行 events；不写情绪、不写记忆、不进提示词——攒够样本再谈回读。
 * @returns {boolean} 真的写了一条
 */
export function recordUnsaid(db, aid, { text = '', eventId = null, cause = '', at = Date.now() } = {}) {
  const s = String(text || '').replace(/\s+/g, ' ').trim()
  if (!s) return false
  if (String(getParam(db, aid, 'affect.unsaid') || 'on') === 'off') return false
  const payload = JSON.stringify({ text: s.slice(0, 120), event_id: eventId, cause: String(cause || '').slice(0, 120) })
  db.prepare('INSERT INTO events VALUES(?,?,?,?,?)')
    .run('evt_' + Math.random().toString(16).slice(2, 12), aid, 'unsaid.moment', payload, new Date(at).toISOString())
  return true
}

/** 编排层：注入关系边偏置后再评价。opt.conversationId：只拿这一段的上一句当短句上下文。 */
export async function appraiseWithEdges(db, aid, text, opt = {}) {
  const axes = readAxes(db, aid)
  const mode = String(getParam(db, aid, 'persona.axes.mode') || 'on')
  // 关系偏置：优先读人物账本（rel_person），退回旧表
  let ownerClose = 0.5
  let ownerTrust = 0.5
  try {
    const p = whoIsSpeaking(db, aid)
    if (p) {
      ownerClose = Number(p.closeness)
      ownerTrust = Number(p.trust)
    } else {
      const rels = listRelations(db, aid)
      const owner = rels.find((r) => r.root || r.name === '主人')
      if (owner) {
        ownerClose = Number(owner.closeness)
        ownerTrust = Number(owner.trust)
      }
    }
  } catch { /* */ }
  let load = 0
  try { load = Number(getCondition(db, aid).load || 0) } catch { /* */ }
  let arousal = 0
  try { arousal = Number(getAffect(db, aid).arousal || 0) } catch { /* */ }
  const edges = resolveStructureEdges(db, aid)
  // 模型评价只调一次：既给 S 用，也原样传下去，避免为算门槛再调一遍。
  // 口径由 affect.appraise.formula 决定：v1=旧（任务相关性），concern=关切（P1）。
  let hint = null
  const appraiseFormula = String(getParam(db, aid, 'affect.appraise.formula') || 'v1')
  /* 机器消息 / 文档块不进评价（2026-11-10 实测：它们被判出情绪，账上算成「含糊」）。
     直接给一个 none 的假 hint：不调模型、照常往下走，形状不变。 */
  let skipReason = null
  try { skipReason = looksNonHuman(text) } catch { skipReason = null }
  if (skipReason) {
    hint = { none: true, concern_relevance: 0, concern_congruence: 0, label: 'calm', source: 'skip:' + skipReason }
    try { event(db, aid, 'affect.skipped', { reason: skipReason, text: String(text || '').replace(/\s+/g, ' ').slice(0, 80) }) } catch { /* 记号失败不影响 */ }
  } else {
    try { hint = await kernelModel.appraise(text, appraiseFormula, recentUserContext(db, aid, text, opt && opt.conversationId)) } catch { hint = null }
  }
  const appraisalForS = hint && hint.label ? hint : rulesAppraise(text)
  const edgeBias = computeEdgeBias({
    sigma: axes.sensitivity, axes, text, appraisal: appraisalForS, mode,
    ownerCloseness: ownerClose, ownerTrust, load, arousal, edges,
    conditionCoef: Number(getParam(db, aid, 'condition.coef')) || 2.5,
  })
  /* 先建事帧（影子）：头必须是事帧，不是旧评价的尾巴。
     只写影子表，不参与这次旧评价；失败静默，不拖对话。 */
  const conv = opt && opt.conversationId ? String(opt.conversationId) : null
  const shadowTurnId = (opt && opt.turnId) || (conv ? `${conv}|${String(text || '').slice(0, 40)}|${Math.floor(Date.now() / 10000)}` : null)
  const res = await appraise(db, aid, text, { edgeBias, labels: affectLabels(db, aid), hint, closeness: ownerClose, formula: appraiseFormula, conversationId: opt.conversationId || null })
  // 影子期：把「本来会是多少」采样一次，不生效；切 on 之后不再采样
  try {
    if (mode === 'shadow' && edgeBias.shadowIntensityMul !== 1) {
      recordMetric(db, aid, 'axis.shadow.intensity', edgeBias.shadowIntensityMul)
    }
  } catch { /* 采样失败不影响评价 */ }
  try {
    const fired = (edgeBias && edgeBias.fired) || []
    if (res && res.label && res.label !== 'calm' && !fired.length) {
      event(db, aid, 'structure.edge_gap', { text: String(text).slice(0, 80), label: res.label })
    }
  } catch { /* 记号失败不影响评价 */ }
  /* P3：把「咽回去的那半句」落一条冷库记录。影子期——只存、不回读。
     存在 events 表（照 quote.moment），不建新表；payload 里带 affect 事件 id 方便对账。 */
  try {
    recordUnsaid(db, aid, {
      text: res && res.appraisal ? res.appraisal.unsaid : '',
      eventId: (res && res.id) || null,
      cause: String(text || '').slice(0, 120),
      at: Date.now(),
    })
  } catch { /* 落库失败不影响对话 */ }
  // 回复结束之后（异步、不挡回复）：把最近十轮的摘要收拢成一句「事」，留给下一轮拼事帧。
  // 这一轮的事帧和判断在回复前由 appraiseTurnNow 做（见 index.js preStep）。
  setImmediate(() => {
    try {
      db.prepare("INSERT OR REPLACE INTO flags(key,value) VALUES(?,?)")
        .run('affect.v4.summary.kick', JSON.stringify({ at: new Date().toISOString(), turnId: shadowTurnId }))
    } catch { /* 诊断失败不影响 */ }
    summarizeAffairs(db, aid, { conversationId: conv, waitTurnId: shadowTurnId }).catch(() => {})
  })
  return res
}
