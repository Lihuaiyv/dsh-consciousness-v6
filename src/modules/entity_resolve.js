/**
 * U3 · 夜巡实体解析（轻量）
 * 规则 NER 仍是底；这里用 1 次模型（或纯规则）合并别名、回填 entity_id。
 */

import { getParam } from '../kernel.js'
import { localDay, localDayBounds } from '../db.js'
import { listEntities, resolveEntity, normalizeName } from './entities.js'
import { llmBudgetAllow, llmBudgetBump } from './llm_budget.js'

function parseJson(raw) {
  const t = String(raw || '').replace(/```[a-zA-Z]*/g, '').trim()
  try { return JSON.parse(t) } catch { /* */ }
  const m = t.match(/\[[\s\S]*\]/) || t.match(/\{[\s\S]*\}/)
  if (m) try { return JSON.parse(m[0]) } catch { /* */ }
  return null
}

/** 规则侧：名字互相包含 → 合并到较短规范名 */
export function ruleMergeAliases(entities) {
  const list = [...(entities || [])].sort((a, b) => String(a.name).length - String(b.name).length)
  const merges = [] // { fromId, intoId, intoName }
  const gone = new Set()
  for (let i = 0; i < list.length; i++) {
    if (gone.has(list[i].id)) continue
    for (let j = i + 1; j < list.length; j++) {
      if (gone.has(list[j].id)) continue
      const a = String(list[i].name)
      const b = String(list[j].name)
      if (a.length >= 2 && b.includes(a) && a !== b) {
        merges.push({ fromId: list[j].id, intoId: list[i].id, intoName: a })
        gone.add(list[j].id)
      }
    }
  }
  return merges
}

export function applyEntityMerges(db, aid, merges) {
  let n = 0
  for (const m of merges) {
    try {
      db.prepare('UPDATE memory_items SET entity_id=? WHERE agent_id=? AND entity_id=?').run(m.intoId, aid, m.fromId)
      // 把旧名写进 aliases
      const row = db.prepare('SELECT name,aliases FROM entities WHERE id=?').get(m.intoId)
      let aliases = []
      try { aliases = JSON.parse(row?.aliases || '[]') } catch { aliases = [] }
      const old = db.prepare('SELECT name FROM entities WHERE id=?').get(m.fromId)
      if (old?.name && !aliases.includes(old.name)) aliases.push(old.name)
      db.prepare('UPDATE entities SET aliases=?, updated_at=? WHERE id=?')
        .run(JSON.stringify(aliases).slice(0, 2000), new Date().toISOString(), m.intoId)
      db.prepare('DELETE FROM entities WHERE id=? AND agent_id=?').run(m.fromId, aid)
      n++
    } catch { /* 单条失败跳过 */ }
  }
  return n
}

/** 给当日无实体的活跃事实补挂已知实体名 */
export function backfillEntityIdsForDay(db, aid, day) {
  const { start, end } = localDayBounds(day)
  let rows = []
  try {
    rows = db.prepare(`SELECT id,text FROM memory_items
      WHERE agent_id=? AND status='active' AND invalid_at IS NULL AND entity_id IS NULL
        AND created_at>=? AND created_at<? LIMIT 80`).all(aid, start, end)
  } catch { return 0 }
  const ents = listEntities(db, aid, 200)
  let n = 0
  for (const r of rows) {
    const text = String(r.text || '')
    const hit = ents.find((e) => e.name && text.includes(e.name))
    if (!hit) continue
    try {
      db.prepare('UPDATE memory_items SET entity_id=? WHERE id=?').run(hit.id, r.id)
      n++
    } catch { /* ignore */ }
  }
  return n
}

/**
 * @param {Function|null} completeFn  (messages) => string JSON
 */
export async function resolveEntitiesForDay(db, aid, day, completeFn, opt = {}) {
  const d = String(day || localDay()).slice(0, 10)
  let enabled = true
  try { enabled = String(getParam(db, aid, 'memory.entity.resolve') || 'on') !== 'off' } catch { enabled = true }
  if (opt.enabled === false || opt.enabled === 'off') enabled = false
  if (!enabled) return { ok: true, skipped: true, reason: 'off', merged: 0, backfilled: 0 }

  const ents = listEntities(db, aid, 200)
  const ruleMerges = ruleMergeAliases(ents)
  let merged = applyEntityMerges(db, aid, ruleMerges)

  let modelMerges = 0
  const cap = Math.max(0, Number(opt.dailyCap != null ? opt.dailyCap : (getParam(db, aid, 'memory.entity.resolve.daily_cap') ?? 2)) || 0)
  if (typeof completeFn === 'function' && ents.length >= 2 && llmBudgetAllow(db, aid, d, 1).ok && (cap <= 0 || modelMerges < cap)) {
    try {
      const raw = await completeFn([
        {
          role: 'system',
          text: '你合并实体别名。只输出 JSON 数组，每项 {"keep":"规范名","aliases":["别名"]}。不要发明材料没有的名字。',
        },
        { role: 'user', text: JSON.stringify(ents.slice(0, 40).map((e) => e.name)) },
      ])
      try { llmBudgetBump(db, aid, 'extract', d, 1) } catch { /* 记在 extract 桶 */ }
      const parsed = parseJson(raw)
      if (Array.isArray(parsed)) {
        for (const row of parsed.slice(0, 10)) {
          const keep = normalizeName(row.keep || row.canonical || '')
          const aliases = Array.isArray(row.aliases) ? row.aliases.map(normalizeName).filter(Boolean) : []
          if (!keep || keep.length < 2) continue
          const canon = resolveEntity(db, aid, keep)
          if (!canon) continue
          for (const al of aliases) {
            if (!al || al === keep) continue
            const other = ents.find((e) => e.name === al)
            if (other && other.id !== canon.id) {
              modelMerges += applyEntityMerges(db, aid, [{ fromId: other.id, intoId: canon.id, intoName: keep }])
            } else {
              try { resolveEntity(db, aid, al) } catch { /* ignore */ }
            }
          }
        }
      }
    } catch { /* 模型失败不挡规则合并 */ }
  }

  const backfilled = backfillEntityIdsForDay(db, aid, d)
  return { ok: true, merged: merged + modelMerges, backfilled, rule: ruleMerges.length }
}
