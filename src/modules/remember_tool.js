/**
 * U5 · remember 工具：模型主动写入一条事实（走 gate，配对 memory_search）。
 */

import { applyWrite } from './gate.js'
import { addMemory } from './memory.js'
import { entityForText } from './entities.js'
import { sourceBadge } from './memory_source.js'

export function rememberFact(db, aid, args = {}) {
  const text = String(args.text || args.fact || '').trim()
  if (text.length < 4) return { ok: false, reason: '太短' }
  if (text.length > 400) return { ok: false, reason: '太长' }
  const typ = ['fact', 'appraisal', 'reflection'].includes(String(args.type || ''))
    ? String(args.type)
    : 'fact'
  const key = args.key || args.fact_key ? String(args.key || args.fact_key).slice(0, 120) : null
  const op = String(args.op || 'add').toLowerCase()
  const ent = entityForText(db, aid, text)
  const out = applyWrite(db, aid, {
    text,
    entity_id: ent ? ent.id : null,
    fact_key: key,
    key,
    op: op === 'forget' ? 'delete' : op,
  }, (cand) => addMemory(db, aid, {
    text: cand.text,
    type: typ,
    key,
    entity_id: cand.entity_id,
    source: 'remember',
    importance: Math.max(0.4, Math.min(0.95, Number(args.importance) || 0.75)),
    confidence: Math.max(0.5, Math.min(1, Number(args.confidence) || 0.9)),
    skipConflict: false,
  }))
  const badge = sourceBadge('remember')
  return {
    ok: out.action !== 'drop' && out.action !== 'noop',
    action: out.action,
    id: out.id || null,
    score: out.score,
    reason: out.reason || null,
    badge: badge.label,
  }
}
