/**
 * M0–M2 · 纪要 → 事实蒸馏
 *
 * 高分 / 精修 / 簇修纪要进入夜巡，过现有 applyWrite / addMemory / fact_archive。
 * 关参 memory.episode.distill=off 时整条路径空跑，行为与按轮抽取时代一致。
 */

import { getParam, getFlag, setFlag } from '../kernel.js'
import { applyWrite } from './gate.js'
import { addMemory } from './memory.js'
import { entityForText } from './entities.js'
import { llmBudgetAllow, llmBudgetBump } from './llm_budget.js'
import {
  listEpisodes,
  sampleRawForRefine,
  isPromptEcho,
  shouldRefineEpisode,
} from './archive.js'

const CLUSTER_SESSION = '__day_cluster__'
const ASSERT_RE = /(我是|我叫|我喜欢|我不喜欢|我讨厌|我偏好|记住|决定|约定|以后|不要再|别再|住在|养了)/

function distillCapKey(aid, day) {
  return 'ep.distill.cap:' + aid + ':' + String(day || '').slice(0, 10)
}

function readDistillCount(db, aid, day) {
  try { return Math.max(0, Number(getFlag(db, distillCapKey(aid, day)) || 0) || 0) } catch { return 0 }
}

function bumpDistillCount(db, aid, day, n = 1) {
  const v = readDistillCount(db, aid, day) + Math.max(1, Number(n) || 1)
  try { setFlag(db, distillCapKey(aid, day), String(v)) } catch { /* ignore */ }
  return v
}

function parseJsonish(raw) {
  const t = String(raw || '').replace(/```[a-zA-Z]*/g, '').trim()
  if (!t) return null
  try { return JSON.parse(t) } catch { /* continue */ }
  const arr = t.match(/\[[\s\S]*\]/)
  if (arr) {
    try { return JSON.parse(arr[0]) } catch { /* continue */ }
  }
  const objs = [...t.matchAll(/\{[\s\S]*?\}/g)].map((m) => m[0])
  const bag = []
  for (const o of objs) {
    try { bag.push(JSON.parse(o)) } catch { /* next */ }
  }
  return bag.length ? bag : null
}

function normalizeFact(item) {
  if (!item) return null
  if (typeof item === 'string') {
    const text = item.trim()
    if (text.length < 4) return null
    return { text, type: 'fact' }
  }
  const text = String(item.text || item.fact || item.content || '').trim()
  if (text.length < 4) return null
  if (isPromptEcho(text)) return null
  let typ = String(item.type || 'fact')
  if (!['fact', 'appraisal', 'reflection', 'conflict'].includes(typ)) typ = 'fact'
  // 禁止写入 type=episode，避免与 T2 表名撞车
  const out = { text: text.slice(0, 400), type: typ }
  if (item.key || item.fact_key) out.key = String(item.key || item.fact_key).slice(0, 120)
  if (Array.isArray(item.terms)) out.terms = item.terms.map((x) => String(x)).filter(Boolean).slice(0, 8)
  else if (typeof item.terms === 'string' && item.terms.trim()) out.terms = item.terms.trim().split(/\s+/).slice(0, 8)
  const op = String(item.op || item.action || '').toLowerCase()
  if (op === 'update' || op === 'delete' || op === 'forget' || op === 'noop' || op === 'ignore' || op === 'add') {
    out.op = op === 'forget' ? 'delete' : op
  }
  return out
}

/** U4：从句式推断轻量边类型（非双时态）。 */
function inferLinkKind(text, key) {
  const t = String(text || '')
  const k = String(key || '')
  if (/喜欢|爱喝|偏好|爱吃/.test(t) || /^likes?:/i.test(k)) return 'likes'
  if (/决定|约定|以后|一律|别再|不要再/.test(t) || /^decid/i.test(k)) return 'decided'
  return null
}

function linkMemories(db, fromId, toId, kind, confidence = 0.8) {
  if (!fromId || !toId || fromId === toId) return
  try {
    db.prepare('INSERT OR IGNORE INTO memory_links VALUES(?,?,?,?)')
      .run(fromId, toId, kind, confidence)
  } catch { /* ignore */ }
}

/**
 * M0 · 谁有资格进蒸馏。
 * 对齐 shouldRefineEpisode；排除簇修行（留给 M2）与极低分噪声。
 */
export function shouldDistillEpisode(ep, opt = {}) {
  if (!ep) return false
  if (String(ep.session_id || '') === CLUSTER_SESSION) return false
  const floor = opt.floor != null ? Number(opt.floor) : 0.22
  if (Number(ep.importance || 0) < floor && String(ep.source || '') !== 'model') return false
  const theta = opt.theta != null ? Number(opt.theta) : 0.55
  if (Number(ep.importance || 0) >= theta) return true
  if (String(ep.source || '') === 'model') return true
  return shouldRefineEpisode(ep, opt)
}

/** M0 可选：零模型从 beats / open_loops 捞硬断言。 */
export function ruleDistillCandidates(ep) {
  const beats = Array.isArray(ep?.beats) ? ep.beats : []
  const opens = Array.isArray(ep?.open_loops) ? ep.open_loops : []
  const pool = [...beats, ...opens].map((x) => String(x || '').trim()).filter(Boolean)
  const out = []
  const seen = new Set()
  for (const s of pool) {
    if (!ASSERT_RE.test(s)) continue
    if (/[?？]/.test(s)) continue
    if (s.length < 4 || s.length > 120) continue
    const key = s.replace(/\s+/g, '')
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ text: s, type: 'fact', confidence: 0.55 })
    if (out.length >= 3) break
  }
  return out
}

function episodePayload(ep) {
  return {
    episode_id: ep.id || null,
    day: ep.day || null,
    seg: ep.seg != null ? Number(ep.seg) : null,
    session_id: ep.session_id != null ? String(ep.session_id) : null,
  }
}

/**
 * 把候选事实写入 T1（门控 + 存根 + 轻量边）。
 * @returns {{written:number, merged:number, updated:number, conflict:number, dropped:number, ids:string[]}}
 */
export function writeDistilledFacts(db, aid, facts, ep, opt = {}) {
  const stats = { written: 0, merged: 0, updated: 0, conflict: 0, dropped: 0, ids: [] }
  const list = Array.isArray(facts) ? facts : []
  const batchIds = []
  for (const f of list) {
    const norm = normalizeFact(f)
    if (!norm) { stats.dropped++; continue }
    const ent = entityForText(db, aid, norm.text)
    const payload = episodePayload(ep)
    const cand = {
      text: norm.text,
      entity_id: ent ? ent.id : null,
      fact_key: norm.key || null,
      key: norm.key || null,
      op: norm.op || undefined,
    }
    const out = applyWrite(db, aid, cand, (c) => addMemory(db, aid, {
      text: c.text,
      type: norm.type,
      key: norm.key,
      terms: norm.terms,
      entity_id: c.entity_id,
      source: 'episode',
      confidence: f.confidence != null ? Number(f.confidence) : 0.75,
      importance: Math.max(0.4, Math.min(0.9, Number(ep.importance || 0.55))),
      skipConflict: true,
      payload,
      turn_id: ep.id || null,
    }), opt)
    if (out.action === 'drop' || out.action === 'noop' || out.action === 'delete') {
      if (out.action === 'drop' || out.action === 'noop') stats.dropped++
      continue
    }
    if (out.action === 'merge') { stats.merged++; if (out.id) stats.ids.push(out.id) }
    else if (out.action === 'update') { stats.updated++; if (out.id) stats.ids.push(out.id) }
    else if (out.action === 'conflict') { stats.conflict++; stats.written++; if (out.id) stats.ids.push(out.id) }
    else { stats.written++; if (out.id) stats.ids.push(out.id) }
    if (out.id) {
      batchIds.push(out.id)
      const kind = inferLinkKind(norm.text, norm.key)
      if (kind) {
        // 同实体兄弟上打 likes/decided（若有）
        try {
          if (ent) {
            const sibs = db.prepare(
              "SELECT id FROM memory_items WHERE agent_id=? AND entity_id=? AND id<>? AND status='active' AND invalid_at IS NULL LIMIT 8",
            ).all(aid, ent.id, out.id)
            for (const s of sibs) linkMemories(db, out.id, s.id, kind, 0.75)
          }
        } catch { /* ignore */ }
      }
    }
  }
  // U4：同批蒸馏事实互连 from_episode（检索一跳；纪要 id 已在 payload）
  for (let i = 0; i < batchIds.length; i++) {
    for (let j = i + 1; j < batchIds.length; j++) {
      linkMemories(db, batchIds[i], batchIds[j], 'from_episode', 0.85)
      linkMemories(db, batchIds[j], batchIds[i], 'from_episode', 0.85)
    }
  }
  return stats
}

/**
 * 单条纪要蒸馏。extractFn(turns|messages) → 事实数组或 JSON 字符串。
 */
export async function distillEpisodeFacts(db, aid, ep, extractFn, opt = {}) {
  if (!ep || !ep.id) return { ok: false, reason: 'no_episode' }
  // M2 簇修章节由 forDay 直接选入，跳过「排除 cluster」规则
  if (!opt.forceCluster && !shouldDistillEpisode(ep, opt)) return { ok: false, reason: 'not_eligible' }

  const day = String(ep.day || '').slice(0, 10)
  const cap = Math.max(0, Number(opt.dailyCap != null ? opt.dailyCap : 6) || 0)
  if (cap > 0 && readDistillCount(db, aid, day) >= cap) return { ok: false, reason: 'cap' }
  if (typeof extractFn === 'function' && !llmBudgetAllow(db, aid, day, 1).ok) {
    return { ok: false, reason: 'llm_budget' }
  }

  let candidates = []
  if (typeof extractFn === 'function') {
    const samples = sampleRawForRefine(db, aid, ep, Math.min(8, Number(opt.sampleLimit) || 8))
    const material = {
      title: ep.title,
      summary: ep.summary,
      beats: ep.beats || [],
      open_loops: ep.open_loops || [],
      samples,
    }
    let raw
    try {
      raw = await extractFn([
        {
          role: 'system',
          text: [
            '你从一段对话纪要里蒸馏长期记忆事实。只输出 JSON 数组，最多 3 条。',
            '每条：{"text":"一句完整中文事实","type":"fact|appraisal","key":"可选短键","op":"add|update|delete|noop","terms":["可选词"]}',
            '默认 op=add；改正既有断言用 update 并带上同一 key；明确作废用 delete；无信息用 noop。',
            '只写稳定偏好/身份/决定/关系断言；不要流水账、不要问句、不要编造材料没有的事。',
            '不要 Markdown、不要解释。',
          ].join('\n'),
        },
        { role: 'user', text: '材料：\n' + JSON.stringify(material) },
      ])
    } catch (e) {
      return { ok: false, reason: 'thrown:' + String((e && e.message) || e).slice(0, 60) }
    }
    if (Array.isArray(raw)) candidates = raw
    else if (raw && Array.isArray(raw.facts)) candidates = raw.facts
    else {
      const parsed = parseJsonish(raw)
      if (Array.isArray(parsed)) candidates = parsed
      else if (parsed && typeof parsed === 'object') candidates = [parsed]
    }
  } else if (opt.allowRules) {
    candidates = ruleDistillCandidates(ep)
  } else {
    return { ok: false, reason: 'no_model' }
  }

  const norms = []
  for (const c of candidates) {
    const n = normalizeFact(c)
    if (n) norms.push(n)
    if (norms.length >= 3) break
  }
  if (!norms.length) return { ok: false, reason: 'empty' }

  const stats = writeDistilledFacts(db, aid, norms, ep, opt)
  if (cap > 0) bumpDistillCount(db, aid, day, 1)
  if (typeof extractFn === 'function') {
    try { llmBudgetBump(db, aid, 'distill', day, 1) } catch { /* ignore */ }
  }
  return { ok: true, ...stats, candidates: norms.length }
}

function isCluster(ep) {
  return String(ep?.session_id || '') === CLUSTER_SESSION
}

/**
 * M1/M2 · 按天蒸馏。有簇修且 prefer_cluster 时优先章节，跳过同日普通段以减重复。
 */
export async function distillEpisodesForDay(db, aid, day, extractFn, opt = {}) {
  const d = String(day || '').slice(0, 10)
  let enabled = true
  try {
    enabled = String(getParam(db, aid, 'memory.episode.distill') || 'on') !== 'off'
  } catch { enabled = true }
  if (opt.enabled === false || opt.enabled === 'off') enabled = false
  if (opt.enabled === true || opt.enabled === 'on') enabled = true
  if (!enabled) {
    return { ok: true, skipped: true, reason: 'off', distilled: 0, written: 0, merged: 0, conflict: 0, dropped: 0, capped: false }
  }

  const theta = Number(opt.theta != null ? opt.theta : (getParam(db, aid, 'memory.episode.distill.theta') ?? 0.55))
  const dailyCap = Number(opt.dailyCap != null ? opt.dailyCap : (getParam(db, aid, 'memory.episode.distill.daily_cap') ?? 6))
  let preferCluster = true
  try {
    preferCluster = String(getParam(db, aid, 'memory.episode.distill.prefer_cluster') || 'on') !== 'off'
  } catch { preferCluster = true }
  if (opt.preferCluster === false || opt.preferCluster === 'off') preferCluster = false
  if (opt.preferCluster === true || opt.preferCluster === 'on') preferCluster = true

  const allowRules = opt.allowRules === true
    || String(getParam(db, aid, 'memory.episode.distill.rules') || 'off') === 'on'

  const distillOpt = { theta, dailyCap, allowRules, floor: 0.22 }
  const all = listEpisodes(db, aid, { day: d, limit: 80 })
  const clusters = all.filter(isCluster)
  const useCluster = preferCluster && clusters.length > 0

  let pool
  if (useCluster) {
    pool = clusters.sort((a, b) => Number(b.importance || 0) - Number(a.importance || 0))
  } else {
    pool = all
      .filter((e) => shouldDistillEpisode(e, distillOpt))
      .sort((a, b) => Number(b.importance || 0) - Number(a.importance || 0)
        || (String(b.source) === 'model' ? 1 : 0) - (String(a.source) === 'model' ? 1 : 0))
  }

  const fn = typeof extractFn === 'function' ? extractFn : null
  let distilled = 0
  let written = 0
  let merged = 0
  let conflict = 0
  let dropped = 0
  let failed = 0
  const reasons = []
  let capped = false

  for (const ep of pool) {
    if (dailyCap > 0 && readDistillCount(db, aid, d) >= dailyCap) {
      capped = true
      reasons.push('cap')
      break
    }
    const r = await distillEpisodeFacts(db, aid, ep, fn, {
      ...distillOpt,
      forceCluster: useCluster && isCluster(ep),
    })
    if (r.ok) {
      distilled++
      written += r.written || 0
      merged += r.merged || 0
      conflict += r.conflict || 0
      dropped += r.dropped || 0
    } else {
      failed++
      if (r.reason) reasons.push(r.reason)
      // 无模型时可选规则路径：整日只试一次规则捞取，避免空转
      if (r.reason === 'no_model' && allowRules && !fn) {
        const rules = ruleDistillCandidates(ep)
        if (rules.length) {
          const stats = writeDistilledFacts(db, aid, rules, ep)
          distilled++
          written += stats.written
          merged += stats.merged
          conflict += stats.conflict
          dropped += stats.dropped
          if (dailyCap > 0) bumpDistillCount(db, aid, d, 1)
        }
      }
    }
  }

  return {
    ok: true,
    distilled,
    written,
    merged,
    conflict,
    dropped,
    failed,
    candidates: pool.length,
    prefer_cluster: useCluster,
    capped,
    reasons: reasons.slice(0, 8),
  }
}

export const _test = { readDistillCount, bumpDistillCount, normalizeFact, parseJsonish, CLUSTER_SESSION }
