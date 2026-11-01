/**
 * §8.8 规则工件：版本库 + 实例四指针绑定。
 * 本切片覆盖 structure / taxonomy；C3/C4 仍走 algo_bindings / agent_params，后续迁入。
 */
import { now } from '../db.js'
import { err, nid, agent, active } from '../kernel.js'
import { MODULE_EDGES } from './edges.js'

export const RULE_KINDS = Object.freeze(['structure', 'taxonomy'])

/** 不可变出生模板（代码常量；拷贝进库后按实例版本化） */
export function structureTemplate() {
  return { edges: MODULE_EDGES.map((e) => ({ ...e })) }
}

export function taxonomyTemplate() {
  return {
    memory_tiers: ['T0', 'T1', 'T2', 'T3', 'T4'],
    memory_marks: ['normal', 'pinned', 'sensitive'],
    persona_paths: [
      'axis.ei', 'axis.sn', 'axis.tf',
      'axis.jp', 'axis.sensitivity',
    ],
    affect_labels: ['joy', 'peaceful', 'curious', 'calm', 'confused', 'lost', 'irritated', 'frustrated'],
    action_ports: ['send_message', 'browse', 'remind'],
    relation_kinds: ['owner', 'acquaintance', 'stranger'],
  }
}

function templateFor(kind) {
  if (kind === 'structure') return structureTemplate()
  if (kind === 'taxonomy') return taxonomyTemplate()
  err(400, 'INVALID_ARGUMENT', '未知 kind：' + kind)
}

function nextVersion(db, kind) {
  const row = db.prepare('SELECT MAX(version) v FROM rule_artifacts WHERE kind=?').get(kind)
  return Number(row?.v || 0) + 1
}

/** 只增派生；发布后 payload 只读 */
export function insertArtifact(db, { kind, payload, status = 'available' }) {
  if (!RULE_KINDS.includes(kind)) err(400, 'INVALID_ARGUMENT', 'kind 须为 structure|taxonomy')
  const id = nid('art_')
  const version = nextVersion(db, kind)
  const payload_json = typeof payload === 'string' ? payload : JSON.stringify(payload)
  db.prepare(
    'INSERT INTO rule_artifacts(id,kind,version,payload_json,status,created_at,retired_at) VALUES(?,?,?,?,?,?,?)',
  ).run(id, kind, version, payload_json, status, now(), null)
  return { id, kind, version, payload_json, status }
}

export function getArtifact(db, id) {
  const row = db.prepare('SELECT * FROM rule_artifacts WHERE id=?').get(id)
  if (!row) err(404, 'NOT_FOUND', '工件不存在')
  return row
}

export function parsePayload(row) {
  try { return JSON.parse(row.payload_json) } catch { return null }
}

export function getBinding(db, aid, kind) {
  return db.prepare('SELECT * FROM agent_bindings WHERE agent_id=? AND kind=?').get(aid, kind) || null
}

export function listBindings(db, aid) {
  agent(db, aid)
  return db.prepare('SELECT * FROM agent_bindings WHERE agent_id=? ORDER BY kind').all(aid)
}

export function listArtifacts(db, aid, kind = null) {
  agent(db, aid)
  const binds = listBindings(db, aid)
  const ids = new Set()
  for (const b of binds) {
    if (kind && b.kind !== kind) continue
    for (const k of ['active_id', 'previous_id', 'pinned_id', 'v0_id']) if (b[k]) ids.add(b[k])
  }
  // 本实例提案 fork 也可见
  const forks = db.prepare(
    "SELECT fork_artifact_id FROM proposals WHERE agent_id=? AND fork_artifact_id IS NOT NULL",
  ).all(aid)
  for (const f of forks) if (f.fork_artifact_id) ids.add(f.fork_artifact_id)

  if (!ids.size) return []
  const all = db.prepare('SELECT * FROM rule_artifacts ORDER BY kind, version').all()
  return all.filter((r) => ids.has(r.id) && (!kind || r.kind === kind))
}

/** 解析本实例某 kind 的线上工件；禁止回落「库内最大 version」 */
export function resolveActiveArtifact(db, aid, kind) {
  const b = getBinding(db, aid, kind)
  if (!b?.active_id) return null
  return db.prepare('SELECT * FROM rule_artifacts WHERE id=?').get(b.active_id) || null
}

export function resolveStructureEdges(db, aid) {
  const art = resolveActiveArtifact(db, aid, 'structure')
  if (art) {
    const p = parsePayload(art)
    if (p && Array.isArray(p.edges) && p.edges.length) return p.edges
  }
  return MODULE_EDGES
}

/** 出生：从不可变模板拷贝，冻 v0 = active */
export function seedRuleBindings(db, aid) {
  for (const kind of RULE_KINDS) {
    if (getBinding(db, aid, kind)) continue
    const art = insertArtifact(db, { kind, payload: templateFor(kind) })
    db.prepare(
      `INSERT INTO agent_bindings(agent_id,kind,active_id,previous_id,pinned_id,v0_id,updated_at)
       VALUES(?,?,?,?,?,?,?)`,
    ).run(aid, kind, art.id, null, null, art.id, now())
  }
  return listBindings(db, aid)
}

/** 提案侧：为候选载荷建 fork 工件（未晋升不改 active） */
export function createForkArtifact(db, aid, kind, payload) {
  active(db, aid)
  const b = getBinding(db, aid, kind)
  if (!b?.active_id) err(409, 'CONFLICT', '实例尚未绑定 ' + kind)
  return insertArtifact(db, { kind, payload })
}

export function pinArtifact(db, aid, artId) {
  active(db, aid)
  const art = getArtifact(db, artId)
  const b = getBinding(db, aid, art.kind)
  if (!b) err(409, 'CONFLICT', '实例未绑定 ' + art.kind)
  const owned = [b.active_id, b.previous_id, b.pinned_id, b.v0_id].includes(artId)
  const forkHit = db.prepare(
    'SELECT 1 FROM proposals WHERE agent_id=? AND fork_artifact_id=?',
  ).get(aid, artId)
  if (!owned && !forkHit) err(403, 'FORBIDDEN', '只能钉本实例可见的工件')
  db.prepare('UPDATE agent_bindings SET pinned_id=?, updated_at=? WHERE agent_id=? AND kind=?')
    .run(artId, now(), aid, art.kind)
  return getBinding(db, aid, art.kind)
}

/** 晋升：active←候选，previous←旧 active */
export function activateBinding(db, aid, kind, artId) {
  active(db, aid)
  if (!RULE_KINDS.includes(kind)) err(400, 'INVALID_ARGUMENT', '未知 kind')
  const art = getArtifact(db, artId)
  if (art.kind !== kind) err(400, 'INVALID_ARGUMENT', '工件 kind 与绑定不一致')
  if (art.status === 'retired') err(409, 'CONFLICT', '已退役工件不可晋升')
  const b = getBinding(db, aid, kind)
  if (!b) err(409, 'CONFLICT', '实例未绑定 ' + kind)
  db.prepare(
    'UPDATE agent_bindings SET previous_id=?, active_id=?, updated_at=? WHERE agent_id=? AND kind=?',
  ).run(b.active_id, artId, now(), aid, kind)
  return getBinding(db, aid, kind)
}

/** restore-v0：默认只动规则绑定，不清记忆 */
export function restoreV0(db, aid, kind) {
  active(db, aid)
  const b = getBinding(db, aid, kind)
  if (!b?.v0_id) err(409, 'CONFLICT', '无 v0')
  if (b.active_id === b.v0_id) return b
  db.prepare(
    'UPDATE agent_bindings SET previous_id=?, active_id=?, updated_at=? WHERE agent_id=? AND kind=?',
  ).run(b.active_id, b.v0_id, now(), aid, kind)
  return getBinding(db, aid, kind)
}

function protectedRefs(db, artId) {
  const refs = []
  const binds = db.prepare(
    `SELECT agent_id, kind, active_id, previous_id, pinned_id, v0_id FROM agent_bindings
     WHERE active_id=? OR previous_id=? OR pinned_id=? OR v0_id=?`,
  ).all(artId, artId, artId, artId)
  for (const b of binds) {
    if (b.active_id === artId) refs.push({ type: 'active', agent_id: b.agent_id, kind: b.kind })
    if (b.previous_id === artId) refs.push({ type: 'previous', agent_id: b.agent_id, kind: b.kind })
    if (b.pinned_id === artId) refs.push({ type: 'pinned', agent_id: b.agent_id, kind: b.kind })
    if (b.v0_id === artId) refs.push({ type: 'v0', agent_id: b.agent_id, kind: b.kind })
  }
  const forks = db.prepare(
    `SELECT id FROM proposals WHERE fork_artifact_id=? AND state IN ('shadowed','screened','committed')`,
  ).all(artId)
  for (const p of forks) refs.push({ type: 'fork', proposal_id: p.id })
  return refs
}

/** 硬删：受保护指针或进行中影子引用 → 拒绝 */
export function hardDeleteArtifact(db, artId) {
  getArtifact(db, artId)
  const refs = protectedRefs(db, artId)
  if (refs.length) err(409, 'PROTECTED', '受保护引用禁止硬删', { refs })
  db.prepare('DELETE FROM rule_artifacts WHERE id=?').run(artId)
  return { id: artId, deleted: true }
}

export function retireArtifact(db, artId) {
  const art = getArtifact(db, artId)
  const refs = protectedRefs(db, artId).filter((r) => r.type !== 'previous')
  // previous 可标 retired，但仍不可硬删直至冷静期且无引用
  if (refs.some((r) => r.type === 'active' || r.type === 'v0' || r.type === 'pinned' || r.type === 'fork')) {
    err(409, 'PROTECTED', '仍被保护指针或影子引用，不可退役')
  }
  db.prepare("UPDATE rule_artifacts SET status='retired', retired_at=? WHERE id=?")
    .run(now(), artId)
  return getArtifact(db, artId)
}


// 当前生效的情绪标签表：读绑定的 taxonomy 工件，读不到就用默认 8 类
export const DEFAULT_AFFECT_LABELS = Object.freeze(['joy', 'peaceful', 'curious', 'calm', 'confused', 'lost', 'irritated', 'frustrated'])
export function affectLabels(db, aid) {
  try {
    const art = resolveActiveArtifact(db, aid, 'taxonomy')
    const payload = art ? parsePayload(art) : null
    const labels = payload && payload.affect_labels
    if (Array.isArray(labels) && labels.length) return labels.map(String)
  } catch { /* 老库或未绑定 */ }
  return DEFAULT_AFFECT_LABELS.slice()
}

/** 版本清理：无引用的候选转 retired；退休满冷静期且无引用才硬删（v0/pinned/previous/active 受保护） */
export function gcArtifacts(db, { softDays = 7, hardDays = 7 } = {}) {
  const softCut = new Date(Date.now() - softDays * 86400000).toISOString()
  const refs = `NOT EXISTS (SELECT 1 FROM agent_bindings b WHERE b.active_id=a.id OR b.previous_id=a.id OR b.pinned_id=a.id OR b.v0_id=a.id)
    AND NOT EXISTS (SELECT 1 FROM proposals p WHERE p.fork_artifact_id=a.id AND p.state NOT IN ('rejected','expired','rolled_back','settled'))`
  let retired = 0
  try {
    const rows = db.prepare(`SELECT a.id FROM rule_artifacts a WHERE a.status='available' AND a.created_at<? AND ${refs}`).all(softCut)
    for (const r of rows) { db.prepare("UPDATE rule_artifacts SET status='retired', retired_at=? WHERE id=?").run(now(), r.id); retired++ }
  } catch { retired = 0 }
  let deleted = 0
  try {
    const hardCut = new Date(Date.now() - hardDays * 86400000).toISOString()
    const rows = db.prepare(`SELECT a.id FROM rule_artifacts a WHERE a.status='retired' AND a.retired_at<? AND ${refs}`).all(hardCut)
    for (const r of rows) { db.prepare('DELETE FROM rule_artifacts WHERE id=?').run(r.id); deleted++ }
  } catch { deleted = 0 }
  return { retired, deleted }
}
