/**
 * U5 · 来源徽章
 * extract / episode / consolidate / manual / update_history …
 */

export const SOURCE_BADGE = Object.freeze({
  extract: { label: '抽取', tone: 'extract' },
  episode: { label: '纪要', tone: 'episode' },
  consolidate: { label: '合并', tone: 'consolidate' },
  manual: { label: '手记', tone: 'manual' },
  remember: { label: '手记', tone: 'manual' },
  summary: { label: '摘要', tone: 'summary' },
  model: { label: '模型', tone: 'model' },
  update_history: { label: '旧版', tone: 'history' },
  ui: { label: '手记', tone: 'manual' },
})

export function sourceBadge(source) {
  const key = String(source || '').trim().toLowerCase() || 'manual'
  const hit = SOURCE_BADGE[key]
  if (hit) return { key, ...hit }
  return { key, label: key.slice(0, 8) || '其他', tone: 'other' }
}

/** 从 payload / source_turn 拼一条人话溯源。 */
export function sourceHint(row = {}) {
  const badge = sourceBadge(row.source)
  let episode = null
  try {
    const p = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload
    if (p && p.episode_id) episode = { id: p.episode_id, day: p.day, seg: p.seg }
  } catch { /* ignore */ }
  return {
    badge,
    episode,
    turn_id: row.source_turn_id || null,
  }
}
