/**
 * 关系域：人物账本（Person Ledger）。
 *
 * 一条铁律：`rel_event` 是主数据，其余表都是投影。
 * 所有改动先落一笔账（kind/source/text/payload.mutations），再按账目改投影；
 * `rebuild()` 清空投影、按 rowid 重放，用来修复和自证。
 *
 * 分类（tier）只有三行策略，永远不是人物；人物是节点，一人一行。
 * 五-关系统筹-v2.md §3–§7 是这份实现的说明书。
 */
import crypto from 'node:crypto'
import { now } from '../db.js'
import { err, nid, agent, active, tx } from '../kernel.js'
import { applyEvent, habitOf, weightOf, stimulusKey, repairTrust, REL_DEFAULTS } from '../algo/reldyn.js'
import { setCooldown, cooldownActive } from './drive.js'

/** 三档策略表：代码是唯一来源，启动时 upsert（用户改值会在下次启动被覆盖）。 */
export const TIERS = Object.freeze([
  {
    tier: 'owner', label: '主人',
    warmth: 0.85, formality: 0.15, initiative: 0.75, disclosure: 0.70,
    detail_level: 3,
    init_closeness: 0.55, init_trust: 0.60, init_dependence: 0.20,
    half_life_days: null, forget_after_days: null,
    promote_to: null, demote_to: null, sort: 0,
  },
  {
    tier: 'acquaintance', label: '熟人',
    warmth: 0.55, formality: 0.60, initiative: 0.30, disclosure: 0.50,
    detail_level: 2,
    init_closeness: 0.25, init_trust: 0.40, init_dependence: 0.05,
    half_life_days: 30, forget_after_days: 180,
    promote_to: 'owner', demote_to: 'stranger', sort: 1,
  },
  {
    tier: 'stranger', label: '生人',
    warmth: 0.25, formality: 0.85, initiative: 0.05, disclosure: 0.30,
    detail_level: 1,
    init_closeness: 0.10, init_trust: 0.30, init_dependence: 0.00,
    half_life_days: 2, forget_after_days: 14,
    promote_to: 'acquaintance', demote_to: null, sort: 2,
  },
])

export const TIER_KEYS = ['owner', 'acquaintance', 'stranger']
const LABEL = Object.fromEntries(TIERS.map((t) => [t.tier, t.label]))
const BY_KEY = Object.fromEntries(TIERS.map((t) => [t.tier, t]))

/** 分类名和真人同名时的判定（迁移旧表用）。 */
const CATEGORY_NAMES = new Set(['主人', '熟人', '陌生人'])

function fmt3(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return '0.00'
  return n.toFixed(2)
}

function clamp01(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(1, n))
}

function dayMs() { return 86400000 }

/** 名字归一：只留字和数字，去掉称呼里的标点与空白。 */
export function normalizeName(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .replace(/[\s·・.。,，、!！?？"'“”‘’「」『』()（）\-_~～]/g, '')
}

function fpOf(parts) {
  return crypto.createHash('sha1').update(JSON.stringify(parts)).digest('hex').slice(0, 24)
}

function charLen(s) { return Array.from(String(s == null ? '' : s)).length }

export function seedTiers(db) {
  const st = db.prepare(`INSERT INTO rel_tier(
    tier,label,warmth,formality,initiative,disclosure,detail_level,
    init_closeness,init_trust,init_dependence,half_life_days,forget_after_days,promote_to,demote_to,sort)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(tier) DO UPDATE SET
      label=excluded.label, warmth=excluded.warmth, formality=excluded.formality,
      initiative=excluded.initiative, disclosure=excluded.disclosure, detail_level=excluded.detail_level,
      init_closeness=excluded.init_closeness, init_trust=excluded.init_trust, init_dependence=excluded.init_dependence,
      half_life_days=excluded.half_life_days, forget_after_days=excluded.forget_after_days,
      promote_to=excluded.promote_to, demote_to=excluded.demote_to, sort=excluded.sort`)
  for (const t of TIERS) {
    st.run(t.tier, t.label, t.warmth, t.formality, t.initiative, t.disclosure, t.detail_level,
      t.init_closeness, t.init_trust, t.init_dependence, t.half_life_days, t.forget_after_days,
      t.promote_to, t.demote_to, t.sort)
  }
  return TIERS.length
}

export function tierRow(db, tier) {
  try {
    const row = db.prepare('SELECT * FROM rel_tier WHERE tier=?').get(String(tier))
    if (row) return row
  } catch { /* 表还没建时回退代码默认 */ }
  return BY_KEY[tier] || BY_KEY.stranger
}

// ---------------- 账本 ----------------

/**
 * 指纹里带上 mutations 的「语义」（去掉随机 id 和时刻）：
 * 「删 A」「删 B」是两笔账，不能被同一条 text 折叠成同一笔。
 */
function fpMutations(muts) {
  if (!muts || !muts.length) return ''
  return muts.map((m) => {
    const o = {}
    for (const k of Object.keys(m).sort()) {
      // id / at 是每次生成或每次发生的，跟「这笔账干了什么」无关
      if (k === 'op' || k === 'at' || k === 'id') continue
      o[k] = m[k]
    }
    if (o.person) o.person = { ...o.person, id: undefined }
    if (o.edge) o.edge = { ...o.edge, id: undefined }
    return o
  })
}

function insertEvent(db, aid, ev) {
  const at = ev.at || now()
  const payload = { ...(ev.payload || {}) }
  if (ev.mutations && ev.mutations.length) payload.mutations = ev.mutations
  const fingerprint = ev.fingerprint || fpOf([ev.kind, ev.source, ev.session_id || '', ev.turn_id || '', ev.speaker_id || '', ev.text || '', fpMutations(ev.mutations)])
  const r = db.prepare(`INSERT OR IGNORE INTO rel_event(
    id,agent_id,kind,source,session_id,turn_id,speaker_id,text,payload,at,fingerprint,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    ev.id || nid('rev_'), aid, String(ev.kind || 'utterance'), String(ev.source || 'chat'),
    ev.session_id || null, ev.turn_id || null, ev.speaker_id || null,
    ev.text == null ? null : String(ev.text), JSON.stringify(payload), at, fingerprint, at)
  const id = db.prepare('SELECT id FROM rel_event WHERE agent_id=? AND fingerprint=?').get(aid, fingerprint).id
  return { id, dup: Number(r.changes) === 0, at }
}

/** 只入账，不动投影（原文级日志 / 归因留痕 / 模型回复）。 */
export function observe(db, aid, ev = {}) {
  agent(db, aid)
  return insertEvent(db, aid, ev)
}

/**
 * 入账 + 落投影，一个事务。
 * mutations 里的 id 必须在这一步定下来（写进 payload），重放才能逐字节复现。
 */
export function commit(db, aid, ev = {}) {
  agent(db, aid)
  return tx(db, () => {
    const muts = (ev.mutations || []).map((m) => materialize(m))
    const row = insertEvent(db, aid, { ...ev, mutations: muts })
    if (!row.dup) for (const m of muts) applyMutation(db, aid, m, row.id, row.at)
    return { id: row.id, dup: row.dup, mutations: row.dup ? 0 : muts.length, at: row.at }
  })
}

/** 给需要 id 的 mutation 补一个；已给的原样保留（重放/幂等靠它）。 */
function materialize(m) {
  if (!m || !m.op) throw err(400, 'INVALID_ARGUMENT', '关系变更缺少 op')
  const out = { ...m }
  if (out.op === 'person.create' && !(out.person && out.person.id)) {
    out.person = { ...(out.person || {}), id: nid('rpr_') }
  }
  if (out.op === 'edge.upsert' && !(out.edge && out.edge.id)) {
    out.edge = { ...(out.edge || {}), id: nid('red_') }
  }
  if (out.op === 'mention.add' && !out.id) out.id = nid('rmt_')
  if (out.op === 'evidence.add' && !out.id) out.id = nid('revi_')
  if (out.op === 'channel.register' && !out.id) out.id = nid('rch_')
  if (out.op === 'review.add' && !out.id) out.id = nid('rrv_')
  return out
}

// ---------------- 投影 ----------------

function getPerson(db, aid, pid) {
  return db.prepare('SELECT * FROM rel_person WHERE id=? AND agent_id=?').get(pid, aid)
}

function needPerson(db, aid, pid) {
  const p = getPerson(db, aid, pid)
  if (!p) err(404, 'NOT_FOUND', '人物不存在')
  return p
}

function createPerson(db, aid, m, eventId, at) {
  const p = m.person || {}
  const name = String(p.name || '').trim()
  if (!name) err(400, 'INVALID_ARGUMENT', '名字必填')
  const tier = tierRow(db, p.tier || 'stranger')
  const seen = p.first_seen_at || at
  if (tier.tier === 'owner') {
    const other = db.prepare("SELECT id FROM rel_person WHERE agent_id=? AND tier='owner' AND status='active'").get(aid)
    if (other && other.id !== p.id) err(409, 'RED_LINE', '主人只能有一个（先改旧主人再提升）')
  }
  db.prepare(`INSERT OR IGNORE INTO rel_person(
    id,agent_id,name,aliases,tier,graph_visible,summary,profile,closeness,trust,dependence,warmth,salience,
    first_seen_at,last_seen_at,last_talk_at,talk_count,status,source,last_event_id,version,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)`).run(
    p.id, aid, name, JSON.stringify(p.aliases || []), tier.tier,
    p.graph_visible == null ? (tier.tier === 'owner' ? 1 : 0) : (p.graph_visible ? 1 : 0),
    p.summary || null, JSON.stringify(p.profile || {}),
    p.closeness == null ? tier.init_closeness : clamp01(p.closeness),
    p.trust == null ? tier.init_trust : clamp01(p.trust),
    p.dependence == null ? tier.init_dependence : clamp01(p.dependence),
    p.warmth == null ? null : clamp01(p.warmth),
    p.salience == null ? 1 : clamp01(p.salience),
    seen, seen, p.last_talk_at || null, Number(p.talk_count) || 0,
    String(p.status || 'active'), String(p.source || 'chat'), eventId, seen, seen)
  return p.id
}

function touchPerson(db, aid, m, eventId, at) {
  const p = needPerson(db, aid, m.person_id)
  const talkAt = m.at || at
  db.prepare(`UPDATE rel_person SET last_seen_at=?, last_talk_at=?, talk_count=talk_count+1,
    salience=1, status=CASE WHEN status='faded' THEN 'active' ELSE status END,
    last_event_id=?, version=version+1, updated_at=? WHERE id=?`).run(talkAt, talkAt, eventId, talkAt, p.id)
}

const PERSON_PATCH = ['name', 'tier', 'graph_visible', 'summary', 'profile', 'closeness', 'trust',
  'dependence', 'warmth', 'salience', 'status', 'source', 'aliases']

function updatePerson(db, aid, m, eventId, at) {
  const p = needPerson(db, aid, m.person_id)
  const patch = m.patch || {}
  const sets = []
  const vals = []
  for (const k of PERSON_PATCH) {
    if (!(k in patch)) continue
    let v = patch[k]
    if (k === 'tier') {
      const t = tierRow(db, v).tier
      if (t === 'owner' && p.tier !== 'owner') {
        const other = db.prepare("SELECT id FROM rel_person WHERE agent_id=? AND tier='owner' AND status='active' AND id<>?").get(aid, p.id)
        if (other) err(409, 'RED_LINE', '主人只能有一个（先改旧主人再提升）')
      }
      v = t
    }
    if (k === 'aliases') v = JSON.stringify(Array.isArray(v) ? v : [])
    if (k === 'profile') v = JSON.stringify(v && typeof v === 'object' ? v : {})
    if (k === 'graph_visible') v = v ? 1 : 0
    if (['closeness', 'trust', 'dependence', 'warmth', 'salience'].includes(k) && v != null) v = clamp01(v)
    sets.push(k + '=?')
    vals.push(v)
  }
  if (!sets.length) return p.id
  sets.push('last_event_id=?', 'version=version+1', 'updated_at=?')
  vals.push(eventId, at, p.id)
  db.prepare('UPDATE rel_person SET ' + sets.join(',') + ' WHERE id=?').run(...vals)
  return p.id
}

function archivePerson(db, aid, m, eventId, at) {
  const p = needPerson(db, aid, m.person_id)
  if (p.tier === 'owner') err(409, 'RED_LINE', '主人不能归档')
  db.prepare("UPDATE rel_person SET status='archived', last_event_id=?, version=version+1, updated_at=? WHERE id=?")
    .run(eventId, at, p.id)
  return p.id
}

function mergePersonRows(db, aid, m, eventId, at) {
  const from = needPerson(db, aid, m.from_id)
  const into = needPerson(db, aid, m.into_id)
  if (from.id === into.id) err(400, 'INVALID_ARGUMENT', '不能合并到自己')
  if (from.tier === 'owner') err(409, 'RED_LINE', '主人不能被合并')
  // 边：先让位（唯一索引只允许一条有效边），再搬
  for (const e of db.prepare('SELECT * FROM rel_edge WHERE agent_id=? AND valid_to IS NULL AND (from_id=? OR to_id=?)').all(aid, from.id, from.id)) {
    const nf = e.from_id === from.id ? into.id : e.from_id
    const nt = e.to_id === from.id ? into.id : e.to_id
    if (nf === nt) { db.prepare('UPDATE rel_edge SET valid_to=? WHERE id=?').run(at, e.id); continue }
    const clash = db.prepare(`SELECT id FROM rel_edge WHERE agent_id=? AND from_id=? AND to_id=? AND kind=? AND valid_to IS NULL AND id<>?`)
      .get(aid, nf, nt, e.kind, e.id)
    if (clash) { db.prepare('UPDATE rel_edge SET valid_to=? WHERE id=?').run(at, e.id); continue }
    db.prepare('UPDATE rel_edge SET from_id=?, to_id=?, last_event_id=?, updated_at=? WHERE id=?').run(nf, nt, eventId, at, e.id)
  }
  db.prepare('UPDATE rel_evidence SET person_id=? WHERE agent_id=? AND person_id=?').run(into.id, aid, from.id)
  db.prepare('UPDATE rel_mention SET state=? WHERE agent_id=? AND state=? AND candidate_ids LIKE ?').run('linked', aid, 'unresolved', '%"' + from.id + '"%')
  db.prepare('UPDATE rel_channel SET person_id=? WHERE agent_id=? AND person_id=?').run(into.id, aid, from.id)
  // 合并时不要把「叫小花」这种引称残片记成别名：剥掉动词后就是对方的名字。
  const intoNames = new Set([into.name, ...(JSON.parse(into.aliases || '[]'))].map(normalizeName))
  const fromBare = stripNameLead(from.name)
  const leadJunk = normalizeName(fromBare) !== normalizeName(from.name) && intoNames.has(normalizeName(fromBare))
  const aliases = new Set([...(JSON.parse(into.aliases || '[]'))])
  if (!leadJunk) aliases.add(from.name)
  for (const a of JSON.parse(from.aliases || '[]')) if (a) aliases.add(a)
  db.prepare('UPDATE rel_person SET aliases=?, last_event_id=?, version=version+1, updated_at=? WHERE id=?')
    .run(JSON.stringify([...aliases]), eventId, at, into.id)
  db.prepare("UPDATE rel_person SET status='archived', last_event_id=?, version=version+1, updated_at=? WHERE id=?")
    .run(eventId, at, from.id)
  return into.id
}

function upsertEdge(db, aid, m, eventId, at) {
  const e = m.edge || {}
  if (!e.from_id || !e.to_id) err(400, 'INVALID_ARGUMENT', '边需要两端')
  if (e.from_id === e.to_id) err(400, 'INVALID_ARGUMENT', '边不能指向自己')
  needPerson(db, aid, e.from_id)
  needPerson(db, aid, e.to_id)
  const old = db.prepare(`SELECT * FROM rel_edge WHERE agent_id=? AND from_id=? AND to_id=? AND kind=? AND valid_to IS NULL`)
    .get(aid, e.from_id, e.to_id, String(e.kind || 'relation'))
  if (old) {
    db.prepare(`UPDATE rel_edge SET role_label=COALESCE(?,role_label), closeness=COALESCE(?,closeness),
      trust=COALESCE(?,trust), tension=COALESCE(?,tension), power=COALESCE(?,power),
      confidence=?, evidence_count=evidence_count+1, last_event_id=?, updated_at=? WHERE id=?`).run(
      e.role_label ?? null, e.closeness ?? null, e.trust ?? null, e.tension ?? null, e.power ?? null,
      e.confidence == null ? old.confidence : clamp01(e.confidence), eventId, at, old.id)
    return old.id
  }
  db.prepare(`INSERT INTO rel_edge(id,agent_id,from_id,to_id,kind,role_label,closeness,trust,tension,power,
    confidence,source,evidence_count,valid_from,valid_to,last_event_id,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,1,?,NULL,?,?,?)`).run(
    e.id, aid, e.from_id, e.to_id, String(e.kind || 'relation'), e.role_label || null,
    e.closeness ?? null, e.trust ?? null, e.tension ?? null, e.power ?? null,
    e.confidence == null ? 0.7 : clamp01(e.confidence), String(e.source || 'chat'), at,
    eventId, at, at)
  return e.id
}

function addMention(db, aid, m, eventId, at) {
  db.prepare(`INSERT OR IGNORE INTO rel_mention(id,agent_id,event_id,surface,normalized,how,context,
    candidate_ids,state,confidence,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    m.id, aid, eventId, String(m.surface || ''), String(m.normalized || normalizeName(m.surface)),
    String(m.how || 'name'), m.context || null, JSON.stringify(m.candidate_ids || []),
    String(m.state || 'unresolved'), m.confidence == null ? null : clamp01(m.confidence), at, at)
  return m.id
}

function linkMention(db, aid, m, eventId, at) {
  const row = db.prepare('SELECT * FROM rel_mention WHERE id=? AND agent_id=?').get(m.mention_id, aid)
  if (!row) err(404, 'NOT_FOUND', '提及不存在')
  if (m.person_id) needPerson(db, aid, m.person_id)
  db.prepare('UPDATE rel_mention SET state=?, confidence=?, updated_at=? WHERE id=?').run(
    m.person_id ? 'linked' : 'ignored',
    m.confidence == null ? (m.person_id ? 0.9 : 0) : clamp01(m.confidence), at, row.id)
  return row.id
}

function addEvidence(db, aid, m, eventId, at) {
  db.prepare(`INSERT OR IGNORE INTO rel_evidence(id,agent_id,person_id,edge_id,memory_id,turn_id,event_id,kind,text,weight,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
    m.id, aid, m.person_id || null, m.edge_id || null, m.memory_id || null, m.turn_id || null,
    eventId, String(m.kind || 'utterance'), String(m.text || ''), m.weight == null ? 1 : Number(m.weight), at)
  return m.id
}

function registerChannelRow(db, aid, m, eventId, at) {
  if (!m.person_id || !m.channel || !m.handle) err(400, 'INVALID_ARGUMENT', '渠道绑定需要 person/channel/handle')
  needPerson(db, aid, m.person_id)
  db.prepare(`INSERT INTO rel_channel(id,agent_id,person_id,channel,handle,confidence,created_at)
    VALUES(?,?,?,?,?,?,?) ON CONFLICT(agent_id,channel,handle) DO UPDATE SET
    person_id=excluded.person_id, confidence=excluded.confidence`).run(
    m.id, aid, m.person_id, String(m.channel), String(m.handle),
    m.confidence == null ? 1 : clamp01(m.confidence), at)
  return m.person_id
}

function applyMutation(db, aid, m, eventId, at) {
  const ts = at || now()
  switch (m.op) {
    case 'person.create': return createPerson(db, aid, m, eventId, ts)
    case 'person.touch': return touchPerson(db, aid, m, eventId, ts)
    case 'person.update': return updatePerson(db, aid, m, eventId, ts)
    case 'person.archive': return archivePerson(db, aid, m, eventId, ts)
    case 'person.merge': return mergePersonRows(db, aid, m, eventId, ts)
    case 'edge.upsert': return upsertEdge(db, aid, m, eventId, ts)
    case 'edge.invalidate':
      db.prepare('UPDATE rel_edge SET valid_to=?, last_event_id=?, updated_at=? WHERE id=? AND agent_id=? AND valid_to IS NULL')
        .run(m.at || ts, eventId, ts, m.edge_id, aid)
      return m.edge_id
    case 'mention.add': return addMention(db, aid, m, eventId, ts)
    case 'mention.link': return linkMention(db, aid, m, eventId, ts)
    case 'mention.cleanup':
      // 一次性清扫：宿主塞进对话流的系统消息被误当成人话时，把那些提及标成忽略
      for (const pat of m.patterns || []) {
        db.prepare(`UPDATE rel_mention SET state='ignored', updated_at=? WHERE agent_id=? AND state='unresolved'
          AND event_id IN (SELECT id FROM rel_event WHERE agent_id=? AND text LIKE ?)`)
          .run(ts, aid, aid, '%' + String(pat) + '%')
      }
      return 'cleanup'
    case 'evidence.add': return addEvidence(db, aid, m, eventId, ts)
    case 'channel.register': return registerChannelRow(db, aid, m, eventId, ts)
    case 'review.add':
      db.prepare(`INSERT OR IGNORE INTO rel_review(id,agent_id,event_id,kind,person_id,edge_id,payload,confidence,state,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(m.id, aid, eventId, String(m.kind || 'person'),
        m.person_id || null, m.edge_id || null, JSON.stringify(m.payload || {}),
        m.confidence == null ? 0.5 : clamp01(m.confidence), String(m.state || 'pending'), ts, ts)
      return m.id
    default: throw err(500, 'INTERNAL', '未知的关系变更：' + String(m.op))
  }
}

// ---------------- 认人 ----------------

/** 名字候选：先便宜（精确/别名），再贵（包含/称呼）。不做自动合并。 */
export function resolve(db, aid, query, opts = {}) {
  const q = normalizeName(query)
  if (!q) return { query: '', candidates: [] }
  const rows = db.prepare("SELECT * FROM rel_person WHERE agent_id=? AND status<>'archived'").all(aid)
  const ctx = normalizeName(opts.context || '')
  const out = []
  for (const p of rows) {
    const names = [p.name, ...JSON.parse(p.aliases || '[]')].filter(Boolean)
    let score = 0
    let why = ''
    for (const n of names) {
      const nn = normalizeName(n)
      if (!nn) continue
      if (nn === q) { if (score < 1) { score = 1; why = '名字一致' } continue }
      if (q.length >= 2 && (nn.includes(q) || q.includes(nn))) {
        const s = 0.78
        if (s > score) { score = s; why = '名字相近（' + n + '）' }
        continue
      }
      if (q.length >= 2 && commonPrefix(nn, q) >= 2) {
        const s = 0.6
        if (s > score) { score = s; why = '开头相同（' + n + '）' }
      }
    }
    if (!score) continue
    if (ctx && names.some((n) => ctx.includes(normalizeName(n)))) score = Math.min(1, score + 0.05)
    const tier = p.tier
    out.push({ id: p.id, name: p.name, tier, tier_label: LABEL[tier] || tier, score: +score.toFixed(3), why, status: p.status })
  }
  out.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
  // 同名并列不算确定：模糊分打平的时候只给候选
  if (out.length > 1 && out[0].score === out[1].score && out[0].score < 1) out[0].ambiguous = true
  return { query: String(query), candidates: out.slice(0, 8) }
}

function commonPrefix(a, b) {
  let i = 0
  const n = Math.min(a.length, b.length)
  while (i < n && a[i] === b[i]) i++
  return i
}

export function lookup(db, aid, query, opts = {}) {
  const r = resolve(db, aid, query, opts)
  const best = r.candidates[0]
  const sure = best && best.score >= 0.6 && !best.ambiguous
  if (!sure) return { card: '', confidence: best ? best.score : 0, candidates: r.candidates }
  return {
    card: cardText(db, aid, best.id),
    confidence: best.score,
    candidates: r.candidates,
    person: publicPerson(db, aid, best.id),
  }
}

// ---------------- 投影：卡片 / 提示词 ----------------

export function graphEdges(db, aid, pid) {
  return db.prepare(`SELECT e.*,
      CASE WHEN e.from_id=? THEN e.to_id ELSE e.from_id END AS other_id,
      p.name AS other_name, p.tier AS other_tier
    FROM rel_edge e JOIN rel_person p
      ON p.id = CASE WHEN e.from_id=? THEN e.to_id ELSE e.from_id END
    WHERE e.agent_id=? AND (e.from_id=? OR e.to_id=?) AND e.valid_to IS NULL
    ORDER BY e.kind, p.name`).all(pid, pid, aid, pid, pid)
}

export function evidenceOf(db, aid, pid, limit = 5) {
  return db.prepare('SELECT id,text,kind,created_at FROM rel_evidence WHERE agent_id=? AND person_id=? ORDER BY created_at DESC LIMIT ?')
    .all(aid, pid, Math.max(1, Math.min(50, Number(limit) || 5)))
}

export function publicPerson(db, aid, pid) {
  const p = needPerson(db, aid, pid)
  const aliases = JSON.parse(p.aliases || '[]')
  const profile = JSON.parse(p.profile || '{}')
  return {
    id: p.id, name: p.name, aliases, tier: p.tier, tier_label: LABEL[p.tier] || p.tier,
    graph_visible: !!p.graph_visible, summary: p.summary, profile,
    closeness: p.closeness, trust: p.trust, dependence: p.dependence,
    salience: p.salience, status: p.status, source: p.source,
    first_seen_at: p.first_seen_at, last_seen_at: p.last_seen_at, last_talk_at: p.last_talk_at,
    talk_count: p.talk_count, version: p.version, last_event_id: p.last_event_id,
  }
}

function humanAgo(at) {
  if (!at) return '还没说过话'
  const ms = Date.now() - Date.parse(at)
  if (!Number.isFinite(ms) || ms < 0) return '刚刚'
  const min = Math.floor(ms / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return min + ' 分钟前'
  const h = Math.floor(min / 60)
  if (h < 24) return h + ' 小时前'
  const d = Math.floor(h / 24)
  if (d < 60) return d + ' 天前'
  return Math.floor(d / 30) + ' 个月前'
}

function shortDate(at) {
  if (!at) return ''
  const d = new Date(at)
  if (Number.isNaN(d.getTime())) return ''
  return (d.getMonth() + 1) + '-' + d.getDate()
}

/** §8.1 人物卡：人话版，只写有证据的东西。 */
export function cardText(db, aid, pid) {
  const p = needPerson(db, aid, pid)
  const lines = [p.name + '（' + (LABEL[p.tier] || p.tier) + '）']
  const facts = evidenceOf(db, aid, pid, 3)
  const head = []
  if (p.summary) head.push(p.summary)
  else if (facts.length) head.push(facts[0].text)
  if (head.length) lines.push(head[0])
  if (facts.length > 1 || !p.summary) {
    const rest = facts.slice(p.summary ? 0 : 1).map((f) => f.text + (f.created_at ? '（' + shortDate(f.created_at) + '）' : ''))
    if (rest.length) lines.push(rest.join('；'))
  }
  const edges = graphEdges(db, aid, pid)
  if (edges.length) {
    lines.push('我还知道：' + edges.map((e) => {
      const label = e.role_label || e.kind
      return '和' + e.other_name + (label ? '是' + label : '有关系')
    }).join('；'))
  }
  lines.push('上次说话：' + humanAgo(p.last_talk_at))
  lines.push('我记得的就这些，可能不全。')
  return lines.join('\n')
}

/**
 * §8.2 提示词块：当前对象 + 温度 + 我和 TA；他-他边只在被提及时给。
 * 预算按 tier 分档（主人 120 / 熟人 70 / 生人 40 字），从最不重要的行开始丢。
 */
export function promptBlock(db, aid, opts = {}) {
  let person = null
  if (opts.personId) {
    try { person = getPerson(db, aid, opts.personId) } catch { person = null }
  }
  if (!person) person = personByChannel(db, aid, { channel: opts.channel || 'ui', handle: opts.handle || 'local' })
  if (!person) person = ownerPerson(db, aid)
  if (!person) return ''
  const tier = tierRow(db, person.tier)
  const limit = Math.max(40, Number(opts.maxChars) || (person.tier === 'owner' ? 120 : person.tier === 'acquaintance' ? 70 : 40))
  const kappa = fmt3(person.closeness)
  const rho = fmt3(person.trust)
  const delta = fmt3(person.dependence)
  const tone = person.tier === 'owner'
    ? '温度：热情（warmth ' + fmt3(tier.warmth) + ' / formality ' + fmt3(tier.formality) + '）；可以主动关心、提共同经历'
    : person.tier === 'acquaintance'
      ? '温度：礼貌（先回应再延展，不主动探私事）'
      : '温度：疏离（只回答被问到的，不主动展开）'
  // 三行是底线（对象 + 温度），「我和 TA」和「TA 身边的人」按预算往里塞
  const out = ['## 关系', '当前对话对象：' + (LABEL[person.tier] || person.tier), tone]
  const meLine = '我和 TA：亲近 ' + kappa + ' / 信任 ' + rho + ' / 依赖 ' + delta
    + (person.last_talk_at ? '；上次说话 ' + humanAgo(person.last_talk_at) : '；还没单独说过话')
  const extra = [meLine]
  const others = db.prepare(`SELECT p.*, e.role_label, e.kind AS edge_kind FROM rel_person p
      JOIN rel_edge e ON (e.from_id=? AND e.to_id=p.id) OR (e.to_id=? AND e.from_id=p.id)
    WHERE p.agent_id=? AND p.status='active' AND e.valid_to IS NULL
    ORDER BY p.salience DESC LIMIT 3`).all(person.id, person.id, aid)
  if (others.length) {
    extra.push('TA 身边的人（只在相关时提）：' + others.map((o) => o.name + '（' + (o.role_label || o.edge_kind) + '）').join('、'))
  }
  extra.push('（有人问「这是谁 / 我不记得了」，只按人物卡回答；卡里没有就说不知道。）')
  for (const line of extra) {
    if (charLen(out.concat([line]).join('\n')) > limit) continue
    out.push(line)
  }
  // 主人不能没有「我和 TA」：宁可超几个字
  if (person.tier === 'owner' && !out.includes(meLine)) out.push(meLine)
  return out.join('\n')
}

// ---------------- 人物 / 边 / 提及 查询 ----------------

export function ownerPerson(db, aid) {
  return db.prepare("SELECT * FROM rel_person WHERE agent_id=? AND tier='owner' AND status='active'").get(aid) || null
}

export function personByChannel(db, aid, { channel = 'ui', handle = 'local' } = {}) {
  const row = db.prepare(`SELECT p.* FROM rel_channel c JOIN rel_person p ON p.id=c.person_id
    WHERE c.agent_id=? AND c.channel=? AND c.handle=?`).get(aid, String(channel), String(handle))
  return row || null
}

export function listPersons(db, aid, opts = {}) {
  const where = ['agent_id=?']
  const vals = [aid]
  if (opts.tier) { where.push('tier=?'); vals.push(String(opts.tier)) }
  if (opts.status) { where.push('status=?'); vals.push(String(opts.status)) }
  else where.push("status<>'archived'")
  const rows = db.prepare(`SELECT * FROM rel_person WHERE ${where.join(' AND ')} ORDER BY
    CASE tier WHEN 'owner' THEN 0 WHEN 'acquaintance' THEN 1 ELSE 2 END, salience DESC, last_seen_at DESC`).all(...vals)
  const q = normalizeName(opts.q || '')
  return rows
    .filter((p) => !q || [p.name, ...JSON.parse(p.aliases || '[]')].some((n) => normalizeName(n).includes(q)))
    .map((p) => publicPerson(db, aid, p.id))
}

export function personDetail(db, aid, pid) {
  const p = publicPerson(db, aid, pid)
  return {
    person: p,
    card: cardText(db, aid, pid),
    evidence: evidenceOf(db, aid, pid, 10),
    edges: graphEdges(db, aid, pid).map((e) => ({
      id: e.id, kind: e.kind, role_label: e.role_label,
      other: { id: e.other_id, name: e.other_name, tier: e.other_tier },
      closeness: e.closeness, trust: e.trust, confidence: e.confidence,
    })),
  }
}

export function listMentions(db, aid, opts = {}) {
  const state = opts.state ? String(opts.state) : 'unresolved'
  return db.prepare(`SELECT * FROM rel_mention WHERE agent_id=? AND state=? ORDER BY created_at DESC LIMIT ?`)
    .all(aid, state, Math.max(1, Math.min(200, Number(opts.limit) || 50)))
    .map((m) => ({ ...m, candidate_ids: JSON.parse(m.candidate_ids || '[]') }))
}

/** 最近入账：界面上「最近变化」读这个，不读旧 changes 表。 */
/** 一笔账干了什么：把 mutations 翻成人话，界面上就不用看 JSON 了。 */
function eventSummary(db, aid, ev) {
  let muts = []
  try { muts = (JSON.parse(ev.payload || '{}').mutations) || [] } catch { muts = [] }
  const nameOf = (id) => {
    if (!id) return '某人'
    try { return (db.prepare('SELECT name FROM rel_person WHERE id=?').get(id) || {}).name || '某人' } catch { return '某人' }
  }
  const out = []
  for (const m of muts) {
    if (!m || typeof m !== 'object') continue
    if (m.op === 'person.create' && m.person) {
      out.push('记下「' + m.person.name + '」（' + (LABEL[m.person.tier] || m.person.tier || '生人') + '）')
    } else if (m.op === 'person.archive') {
      out.push('删掉「' + nameOf(m.person_id) + '」')
    } else if (m.op === 'person.update') {
      const patch = m.patch || {}
      const who = nameOf(m.person_id)
      if (patch.status === 'active') out.push('把「' + who + '」加回来')
      else if (patch.tier) out.push('「' + who + '」换到「' + (LABEL[patch.tier] || patch.tier) + '」')
      else if ('graph_visible' in patch) out.push(patch.graph_visible ? '把「' + who + '」放进关系图' : '把「' + who + '」移出关系图')
      else if ('summary' in patch) out.push('改了「' + who + '」的一句话')
      else out.push('改了「' + who + '」的卡')
    } else if (m.op === 'edge.upsert' && m.edge) {
      out.push('记下「' + nameOf(m.edge.from_id) + '」和「' + nameOf(m.edge.to_id) + '」的关系'
        + (m.edge.role_label ? '：' + m.edge.role_label : ''))
    } else if (m.op === 'mention.add') {
      out.push('听到一个名字「' + (m.surface || '') + '」')
    }
  }
  if (out.length) return out.join('；')
  // 老账没有 payload 时，至少把「名字|{...}」拆成人话
  const raw = String(ev.text || '')
  const m = raw.match(/^(.+?)\|(\{[\s\S]*\})$/)
  if (m) {
    try {
      const patch = JSON.parse(m[2])
      if (patch.tier) return '「' + m[1] + '」换到「' + (LABEL[patch.tier] || patch.tier) + '」'
    } catch { /* 不是 JSON 就按原文 */ }
  }
  return raw
}

/**
 * 三轴走势：不另建表，直接从账本里重放 person.update 的 patch（只读）。
 * 返回的点是「事件之后的三轴」；没事件的时间段就是平线。
 */
export function axesSeries(db, aid, pid, days = 30) {
  agent(db, aid)
  const p = getPerson(db, aid, pid)
  if (!p) return { person_id: pid, name: null, days: 0, points: [] }
  const d = Math.max(1, Math.min(365, Number(days) || 30))
  const since = new Date(Date.now() - d * 86400000).toISOString()
  let rows = []
  try {
    rows = db.prepare('SELECT at, kind, payload FROM rel_event WHERE agent_id=? AND at>=? ORDER BY rowid').all(aid, since)
  } catch { rows = [] }
  let c = null, t = null, dp = null
  const points = []
  for (const r of rows) {
    let pay = {}
    try { pay = JSON.parse(r.payload || '{}') } catch { pay = {} }
    const muts = Array.isArray(pay.mutations) ? pay.mutations : []
    let touched = false
    for (const m of muts) {
      if (!m || m.op !== 'person.update' || m.person_id !== pid) continue
      const patch = m.patch || {}
      if (patch.closeness != null) c = Number(patch.closeness)
      if (patch.trust != null) t = Number(patch.trust)
      if (patch.dependence != null) dp = Number(patch.dependence)
      touched = true
    }
    if (touched && c != null) {
      points.push({ at: Date.parse(r.at) || Date.now(), c: +c.toFixed(3), t: +t.toFixed(3), d: +dp.toFixed(3), kind: r.kind })
    }
  }
  const last = points[points.length - 1]
  if (!last || last.c !== Number(p.closeness)) {
    points.push({ at: Date.now(), c: Number(p.closeness), t: Number(p.trust), d: Number(p.dependence), kind: 'now' })
  }
  return { person_id: pid, name: p.name, days: d, points }
}

export function listEvents(db, aid, limit = 20) {
  agent(db, aid)
  return db.prepare(`SELECT id,kind,source,text,at,speaker_id,session_id,payload FROM rel_event
    WHERE agent_id=? ORDER BY rowid DESC LIMIT ?`).all(aid, Math.max(1, Math.min(100, Number(limit) || 20)))
    .map((r) => ({
      id: r.id, kind: r.kind, source: r.source, text: r.text, at: r.at,
      speaker_id: r.speaker_id, session_id: r.session_id,
      summary: eventSummary(db, aid, r),
    }))
}

export function listReview(db, aid, opts = {}) {  const state = opts.state ? String(opts.state) : 'pending'
  return db.prepare('SELECT * FROM rel_review WHERE agent_id=? AND state=? ORDER BY created_at DESC LIMIT ?')
    .all(aid, state, Math.max(1, Math.min(200, Number(opts.limit) || 50)))
    .map((r) => ({ ...r, payload: JSON.parse(r.payload || '{}') }))
}

// ---------------- 写入：人 / 边 / 提及 ----------------

/**
 * 旧 relations / 导入行 → 活账本。写权威在 rel_person；同名合并，第二主人降为熟人。
 * 指纹按数值去重，相同三轴重放不算新账。
 */
export function syncLegacyToLedger(db, aid, row = {}) {
  agent(db, aid)
  seedTiers(db)
  const name = String(row.name || '').trim()
  if (!name) return null
  let tier = TIER_KEYS.includes(row.kind) ? row.kind : 'acquaintance'
  const closeness = clamp01(row.closeness == null ? 0.2 : row.closeness)
  const trust = clamp01(row.trust == null ? 0.2 : row.trust)
  const dependence = clamp01(row.dependence == null ? 0 : row.dependence)
  const summary = row.notes == null ? null : String(row.notes).slice(0, 200)
  const found = db.prepare("SELECT * FROM rel_person WHERE agent_id=? AND status<>'archived'").all(aid)
    .find((p) => [p.name, ...JSON.parse(p.aliases || '[]')].some((n) => normalizeName(n) === normalizeName(name)))
  const owner = ownerPerson(db, aid)
  if (tier === 'owner' && owner && (!found || found.id !== owner.id)) tier = 'acquaintance'
  if (found && found.tier === 'owner') tier = 'owner' // 主人卡不因旧表 kind 被降级
  const fp = 'legacy-sync:' + normalizeName(name) + ':' + [tier, closeness, trust, dependence, summary || ''].join('|')
  if (found) {
    const patch = { closeness, trust, dependence }
    if (summary != null && summary !== found.summary) patch.summary = summary
    if (tier !== found.tier && found.tier !== 'owner') patch.tier = tier
    commit(db, aid, {
      kind: 'import', source: 'import', text: name, fingerprint: fp,
      mutations: [{ op: 'person.update', person_id: found.id, patch }],
    })
    return found.id
  }
  const gone = archivedByName(db, aid, name)
  if (gone) {
    commit(db, aid, {
      kind: 'import', source: 'import', text: name + '|revive', fingerprint: fp + ':revive',
      mutations: [{
        op: 'person.update', person_id: gone.id,
        patch: { status: 'active', tier, closeness, trust, dependence, ...(summary != null ? { summary } : {}) },
      }],
    })
    return gone.id
  }
  const pid = nid('rpr_')
  commit(db, aid, {
    kind: 'import', source: 'import', text: name, fingerprint: fp,
    mutations: [{
      op: 'person.create',
      person: {
        id: pid, name, tier, graph_visible: true, summary,
        closeness, trust, dependence, source: 'import',
      },
    }],
  })
  return pid
}

/** 同名但已经归档的人：再加回来时复用同一张卡，而不是被同名事件指纹吞掉。 */
function archivedByName(db, aid, name) {
  const q = normalizeName(name)
  return db.prepare("SELECT * FROM rel_person WHERE agent_id=? AND status='archived'").all(aid)
    .find((p) => [p.name, ...JSON.parse(p.aliases || '[]')].some((n) => normalizeName(n) === q)) || null
}

export function remember(db, aid, body = {}, meta = {}) {
  active(db, aid)
  seedTiers(db)
  const name = String(body.name || '').trim()
  if (!name) err(400, 'INVALID_ARGUMENT', '名字必填')
  if (charLen(name) > 24) err(400, 'INVALID_ARGUMENT', '名字最多 24 字')
  // 给错了层就报错，别悄悄换成生人：界面上选的和落库的必须是一个
  if (body.tier != null && !TIER_KEYS.includes(body.tier)) err(400, 'INVALID_ARGUMENT', 'tier 只能是 owner / acquaintance / stranger')
  const found = db.prepare('SELECT * FROM rel_person WHERE agent_id=? AND status<>\'archived\'').all(aid)
    .find((p) => [p.name, ...JSON.parse(p.aliases || '[]')].some((n) => normalizeName(n) === normalizeName(name)))
  const gone = found ? null : archivedByName(db, aid, name)
  // 主人不能被手记改层：否则「添加同名的人」会把它从主人列里挪走
  if (found && found.tier === 'owner' && body.tier && body.tier !== 'owner') {
    err(409, 'RED_LINE', '主人不能在列表里被改写；先降旧主人，再提升新的')
  }
  // 没给 tier 就沿用原来的；手动改一句话不该把人从熟人打回生人
  const tier = TIER_KEYS.includes(body.tier) ? body.tier : (found ? found.tier : (gone ? gone.tier : 'stranger'))
  if (tier === 'owner' && !found && !gone) {
    const other = ownerPerson(db, aid)
    if (other) err(409, 'RED_LINE', '主人只能有一个（先改旧主人再提升）')
  }
  // id 先定下来：事件里存的就是它，重放才能对上同一个人
  const pid = found ? found.id : (gone ? gone.id : nid('rpr_'))
  const patch = found
    ? { tier, summary: body.summary ?? found.summary, ...(body.aliases ? { aliases: body.aliases } : {}) }
    : gone
      ? { status: 'active', tier, summary: body.summary ?? gone.summary, ...(body.aliases ? { aliases: body.aliases } : {}) }
      : null
  commit(db, aid, {
    kind: 'manual',
    source: meta.source || 'ui',
    text: found || gone ? name + '|' + JSON.stringify(patch) : name,
    // 手记是「用户点了一次」：版本进指纹，同样的内容改两次也不会被当成重复事件吞掉
    fingerprint: found
      ? 'edit:' + pid + ':' + Number(found.version || 0)
      : gone
        ? 'revive:' + pid + ':' + Number(gone.version || 0)
        : 'person:' + normalizeName(name),
    mutations: patch
      ? [{ op: 'person.update', person_id: pid, patch }]
      : [{ op: 'person.create', person: { id: pid, name, tier, aliases: body.aliases || [], summary: body.summary || null, source: meta.source || 'chat' } }],
  })
  if (body.relation || body.other) {
    const other = ensurePerson(db, aid, String(body.other || body.relation || ''), meta)
    if (other && other !== pid) {
      commit(db, aid, {
        kind: 'manual', source: meta.source || 'ui', text: body.relation || '',
        fingerprint: 'edge:' + fpOf([pid, other, 'relation', String(body.relation || '')]),
        mutations: [{ op: 'edge.upsert', edge: { from_id: pid, to_id: other, kind: 'relation', role_label: String(body.relation || ''), source: 'manual', confidence: 1 } }],
      })
    }
  }
  return { ok: true, id: pid, created: !found && !gone }
}

function ensurePerson(db, aid, name, meta = {}) {
  const n = String(name || '').trim()
  if (!n) return null
  const row = db.prepare("SELECT id FROM rel_person WHERE agent_id=? AND status<>'archived'").all(aid)
    .find((p) => p.name === n)
  if (row) return row.id
  const gone = archivedByName(db, aid, n)
  if (gone) {
    commit(db, aid, {
      kind: 'manual', source: meta.source || 'ui', text: n + '|revive',
      mutations: [{ op: 'person.update', person_id: gone.id, patch: { status: 'active' } }],
    })
    return gone.id
  }
  const pid = nid('rpr_')
  commit(db, aid, {
    kind: 'manual', source: meta.source || 'ui', text: n, fingerprint: 'person:' + normalizeName(n),
    mutations: [{ op: 'person.create', person: { id: pid, name: n, tier: 'stranger' } }],
  })
  return pid
}

export function setTier(db, aid, pid, tier, meta = {}) {
  active(db, aid)
  if (!TIER_KEYS.includes(tier)) err(400, 'INVALID_ARGUMENT', 'tier 只能是 owner / acquaintance / stranger')
  const before = needPerson(db, aid, pid)
  commit(db, aid, {
    kind: 'tier', source: meta.source || 'ui', text: 'tier ' + before.tier + '→' + tier,
    mutations: [{ op: 'person.update', person_id: pid, patch: { tier } }],
  })
  return publicPerson(db, aid, pid)
}

export function removePerson(db, aid, pid, meta = {}) {
  active(db, aid)
  const p = needPerson(db, aid, pid)
  if (p.tier === 'owner') err(409, 'RED_LINE', '主人不能删除')
  // 已经归档就是幂等：重复点不落账
  if (p.status === 'archived') return { id: pid, archived: true, dup: true }
  commit(db, aid, {
    kind: 'correction', source: meta.source || 'ui', text: 'archive',
    // 版本进指纹：同一个人「删了又加、再加再删」时，第二次删不会被当成重复事件吞掉
    fingerprint: 'archive:' + pid + ':' + Number(p.version || 0),
    mutations: [{ op: 'person.archive', person_id: pid }],
  })
  return { id: pid, archived: true }
}

export function promotePerson(db, aid, pid) {
  active(db, aid)
  commit(db, aid, {
    kind: 'manual', source: 'ui', text: 'promote',
    mutations: [{ op: 'person.update', person_id: pid, patch: { graph_visible: true } }],
  })
  return publicPerson(db, aid, pid)
}

/**
 * 改称呼：名字是人对人的叫法，会跟着关系走（「小小尼」→「小小尼姑」）。
 * 旧名字不丢，进 aliases：以后聊天里再提旧名字，仍然认得是同一个人。
 * 改成一个已经属于别人的名字会被挡下 —— 同名就该合并，不该悄悄顶掉一张卡。
 */
export function renamePerson(db, aid, pid, rawName, meta = {}) {
  active(db, aid)
  const p = needPerson(db, aid, pid)
  const name = String(rawName == null ? '' : rawName).trim()
  if (!name) err(400, 'INVALID_ARGUMENT', '称呼不能为空')
  if (charLen(name) > 24) err(400, 'INVALID_ARGUMENT', '称呼最多 24 字')
  if (name.includes('\uFFFD')) err(400, 'INVALID_ARGUMENT', '称呼里有编码损坏的字符，请重新输入')
  if (normalizeName(name) === normalizeName(p.name)) return publicPerson(db, aid, pid)
  const others = db.prepare("SELECT id,name,aliases FROM rel_person WHERE agent_id=? AND status<>'archived' AND id<>?").all(aid, pid)
  const clash = others.find((r) => [r.name, ...JSON.parse(r.aliases || '[]')].some((n) => normalizeName(n) === normalizeName(name)))
  if (clash) err(409, 'NAME_TAKEN', '已经有一个叫「' + (clash.name || name) + '」的人了；先合并，再改称呼')
  const aliases = Array.from(new Set([p.name, ...JSON.parse(p.aliases || '[]')].filter(Boolean)))
  commit(db, aid, {
    kind: 'correction', source: meta.source || 'ui', text: '称呼 ' + p.name + ' → ' + name,
    // 版本进指纹：改过去再改回来，也是一笔新账
    fingerprint: 'rename:' + pid + ':' + Number(p.version || 0),
    mutations: [{ op: 'person.update', person_id: pid, patch: { name, aliases } }],
  })
  return publicPerson(db, aid, pid)
}

export function mergePersons(db, aid, fromId, intoId) {
  active(db, aid)
  commit(db, aid, {
    kind: 'merge', source: 'ui', text: fromId + '→' + intoId,
    mutations: [{ op: 'person.merge', from_id: fromId, into_id: intoId }],
  })
  return personDetail(db, aid, intoId)
}

export function upsertEdgeApi(db, aid, body = {}) {
  active(db, aid)
  const fromId = body.from_id
  const toId = body.to_id
  if (!fromId || !toId) err(400, 'INVALID_ARGUMENT', '边需要 from_id / to_id')
  commit(db, aid, {
    kind: 'manual', source: 'ui', text: body.role_label || body.kind || 'edge',
    mutations: [{
      op: 'edge.upsert',
      edge: {
        from_id: fromId, to_id: toId, kind: body.kind || 'relation', role_label: body.role_label || null,
        closeness: body.closeness, trust: body.trust, tension: body.tension, power: body.power,
        confidence: body.confidence == null ? 0.9 : body.confidence, source: 'manual',
      },
    }],
  })
  return { ok: true }
}

export function invalidateEdge(db, aid, eid) {
  active(db, aid)
  const row = db.prepare('SELECT id FROM rel_edge WHERE id=? AND agent_id=?').get(eid, aid)
  if (!row) err(404, 'NOT_FOUND', '关系边不存在')
  commit(db, aid, {
    kind: 'correction', source: 'ui', text: 'invalidate edge',
    mutations: [{ op: 'edge.invalidate', edge_id: eid }],
  })
  return { id: eid, invalidated: true }
}

export function linkMentionApi(db, aid, mid, personId) {
  active(db, aid)
  if (personId) needPerson(db, aid, personId)
  commit(db, aid, {
    kind: 'correction', source: 'ui', text: 'link mention',
    mutations: [{ op: 'mention.link', mention_id: mid, person_id: personId || null, confidence: personId ? 1 : 0 }],
  })
  return { id: mid, state: personId ? 'linked' : 'ignored' }
}

// ---------------- 入账：一句话 → 一笔账 ----------------

const RE_NAMED = /(?:叫|名叫|名字是|名字叫)\s*([\u4e00-\u9fa5A-Za-z]{2,4})/g
const RE_HONOR = /([\u4e00-\u9fa5]{1,2}(?:哥|姐|总|老师|老板|叔|姨|同学|医生))/g
const ROLE_LIST = '同事|朋友|老板|同学|室友|闺蜜|兄弟|姐妹|邻居|客户|领导|老婆|老公|对象|丈夫|妻子|男友|女友|儿子|女儿|妈妈|爸爸|哥哥|姐姐|弟弟|妹妹'
/** 「我同事小周」：称呼后紧跟 2–4 个字，且像名字才认（P1 规则只求准）。
 *  4 字是为了「小小尼姑」这种四字昵称不被截成「小小尼」；pickName 里还有一层像名字的过滤。 */
const RE_ROLE_NAME = new RegExp('(?:' + ROLE_LIST + ')([\\u4e00-\\u9fa5]{2,4})', 'g')
/** 「小周是我朋友」：名字在前、关系在后（「就是我」也算）。 */
const RE_COPULA = new RegExp('(?:是我|就是我)(?:的)?(?:' + ROLE_LIST + ')', 'g')
/** 「我朋友是小周」：关系在前、名字在后。 */
const RE_ROLE_IS = new RegExp('(?:我|我的)?(?:' + ROLE_LIST + ')(?:是|叫|名字叫)([\\u4e00-\\u9fa5A-Za-z]{2,4})', 'g')
/**
 * 「我有个同学叫小花」：关系词后面的捕获会连「叫」一起吞进来（叫小花）。
 * 先剥掉这些引称动词，再当名字用 —— 否则同一个人会落成「小花」和「叫小花」两张卡。
 */
const NAME_LEAD = /^(?:叫做?|名叫|名字叫|名字是|是)/
function stripNameLead(raw) {
  const s = String(raw == null ? '' : raw).trim()
  const out = s.replace(NAME_LEAD, '')
  return out.length >= 2 ? out : s
}

/** 名字里出现这些字，多半是「我朋友很忙」而不是一个人。 */
const NOT_NAME_CHARS = new Set(Array.from('很挺也都说是 在不没有会要想让把帮给跟和这那他她我你们个就又才已刚今昨明上下前后里外家去来最更好多太真然呢啊吧呀哦嗯吗与对被其该每各另某表堂亲们些的'))
/** 界面词不是人：「叫手动添加关系」不能建出一个叫「手动添加」的人。 */
const NOT_PERSON_WORDS = /添加|删除|关系|菜单|设置|功能|页面|按钮|下拉|收起|展开|导入|导出|刷新|保存|取消/
const ROLE_WORDS = new RegExp('(?:' + ROLE_LIST + ')')
/** 带这些称呼建出来的人，按「熟人候选」落（分类不是节点，tier 只是策略）。 */
const FRIEND_ROLES = new RegExp('^(?:' + ROLE_LIST + ')$')

function looksLikeName(s) {
  const chars = Array.from(String(s || ''))
  if (chars.length < 2 || chars.length > 4) return false
  return chars.every((c) => /[\u4e00-\u9fa5]/.test(c) && !NOT_NAME_CHARS.has(c))
}

/** 正则抓到的常常多吞一个字（「小周昨天」），从长到短试，取第一个像名字的前缀。 */
function pickName(raw) {
  const s = String(raw || '')
  for (let n = Math.min(4, Array.from(s).length); n >= 2; n--) {
    const cand = Array.from(s).slice(0, n).join('')
    if (looksLikeName(cand)) return cand
  }
  return ''
}

/** 「然后小周是我朋友」：名字紧挨着「是我」，所以从尾巴往前取最长的像名字的片段。 */
function pickSuffixName(raw) {
  const chars = Array.from(String(raw || ''))
  for (let n = Math.min(4, chars.length); n >= 2; n--) {
    const cand = chars.slice(-n).join('')
    if (looksLikeName(cand)) return cand
  }
  return ''
}

/** 规则抽取（P1 只用规则；模型抽取在 P2 接 rel_extract_queue）。 */
export function extractMentions(db, aid, text) {
  const s = String(text || '')
  const found = []
  const seen = new Set()
  const persons = db.prepare("SELECT id,name,aliases FROM rel_person WHERE agent_id=? AND status<>'archived'").all(aid)
  const push = (surface, how, personId, score, create, tier) => {
    const normalized = normalizeName(surface)
    if (!normalized || seen.has(normalized)) return null
    seen.add(normalized)
    const item = { surface: String(surface).trim(), normalized, how, personId: personId || null, score: score || null }
    if (create) { item.create = true; item.tier = tier || 'stranger' }
    found.push(item)
    return item
  }
  /** 建人前最后一道闸：界面词 / 「很忙」这种短语，宁可不建。 */
  const badName = (name) => !name || CATEGORY_NAMES.has(name) || NOT_PERSON_WORDS.test(name)
  // 1) 已知的人：出现即算一次提及
  for (const p of persons) {
    const names = [p.name, ...JSON.parse(p.aliases || '[]')].filter(Boolean)
    for (const n of names) {
      if (n.length >= 2 && s.includes(n)) { push(n, 'name', p.id, 0.95); break }
    }
  }
  const has = (name) => found.some((f) => f.normalized === normalizeName(name))
  /** 同一句里「叫小花」被剥成「小花」后撞上了：只把不认识的升成熟人候选，不再建第二张卡。 */
  const bumpTier = (name, tier) => {
    const norm = normalizeName(name)
    const item = found.find((f) => f.normalized === norm)
    const rank = { stranger: 0, acquaintance: 1, owner: 2 }
    if (item && item.create && rank[tier] > rank[item.tier]) item.tier = tier
  }
  // 2) 明确说出名字：建生人（「他叫小周」；但「叫手动添加关系」不是人）
  for (const m of s.matchAll(RE_NAMED)) {
    const name = pickName(m[1])
    if (badName(name) || has(name)) continue
    push(name, 'name', null, 0.8, true, 'stranger')
  }
  // 3) 「我同事小周」：称呼后面点名的，按熟人候选建
  for (const m of s.matchAll(RE_ROLE_NAME)) {
    const name = pickName(stripNameLead(m[1]))
    if (badName(name)) continue
    if (has(name)) { bumpTier(name, 'acquaintance'); continue }
    push(name, 'role', null, 0.7, true, 'acquaintance')
  }
  // 4) 「小周是我朋友」：名字在前、关系在后 —— 这是最自然的说法，不能漏
  for (const m of s.matchAll(RE_COPULA)) {
    const name = pickSuffixName(s.slice(Math.max(0, m.index - 4), m.index))
    if (badName(name) || has(name)) continue
    push(name, 'relation', null, 0.75, true, 'acquaintance')
  }
  // 5) 「我朋友是小周」：关系在前、名字在后
  for (const m of s.matchAll(RE_ROLE_IS)) {
    const name = pickName(stripNameLead(m[1]))
    if (badName(name)) continue
    if (has(name)) { bumpTier(name, 'acquaintance'); continue }
    push(name, 'relation', null, 0.7, true, 'acquaintance')
  }
  // 6) 称呼（周哥 / 王老师）：候选，不建人
  for (const m of s.matchAll(RE_HONOR)) {
    const name = pickName(stripNameLead(m[1]))
    if (badName(name)) continue
    push(name, 'role', null, 0.5)
  }
  return found
}

/** 宿主塞进对话流的系统消息（压缩摘要 / 后台任务通报 / 审批提示）：不是人说的话，不入账。 */
const NOT_SPEECH = /automatically generated checkpoint|condensing an earlier span of the conversation|^#{1,3}\s|^background (?:job|subagent)\b|^Approval prompts are |^The following is a system reminder|^Current runtime context\.|^You are an? (?:AI|coding) agent powered by/im

function looksLikeSystemMessage(text) {
  return NOT_SPEECH.test(text) || charLen(text) > 1200
}

/**
 * 聊天入口：一句用户原话 → 一笔账 + 投影（说话人 touch / 提及 / 新手建生人）。
 * 同一个 turn 重复调用由指纹挡掉，状态不会重复。
 */
export function ingest(db, aid, opts = {}) {
  agent(db, aid)
  const text = String(opts.text == null ? '' : opts.text).trim()
  if (!text) return { skipped: 'empty' }
  if (looksLikeSystemMessage(text)) return { skipped: 'system-message' }
  seedTiers(db)
  const speaker = opts.speaker
    ? getPerson(db, aid, opts.speaker)
    : (personByChannel(db, aid, { channel: opts.channel || 'ui', handle: opts.handle || 'local' }) || ownerPerson(db, aid))
  const muts = []
  if (speaker) muts.push({ op: 'person.touch', person_id: speaker.id, at: opts.at })
  const mentions = extractMentions(db, aid, text)
  for (const m of mentions) {
    let pid = m.personId
    if (!pid && m.create) {
      // 删过的人又被提起：复用原来那张卡，别再建一个同名的
      const gone = archivedByName(db, aid, m.surface)
      if (gone) {
        pid = gone.id
        muts.push({ op: 'person.update', person_id: pid, patch: { status: 'active', tier: m.tier || gone.tier } })
      } else {
        // id 先定，写在事件里：重放才能把 mention 指回同一张人物卡
        pid = nid('rpr_')
        muts.push({ op: 'person.create', person: { id: pid, name: m.surface, tier: m.tier || 'stranger', source: 'chat' } })
      }
    }
    muts.push({
      op: 'mention.add', surface: m.surface, normalized: m.normalized, how: m.how,
      context: text.slice(0, 200), candidate_ids: pid ? [pid] : [],
      state: pid ? 'linked' : 'unresolved', confidence: pid ? 0.95 : (m.score || null),
    })
    if (pid) {
      muts.push({ op: 'evidence.add', person_id: pid, kind: 'mention', text: text.slice(0, 160), weight: 1 })
    }
  }
  const out = commit(db, aid, {
    kind: 'utterance',
    source: opts.source || 'chat',
    session_id: opts.sessionId || null,
    // 宿主没给 turn id 时按 5 秒一档兜底：重复事件会被挡住，真重复的「嗯」还是各算一次
    turn_id: opts.turnId || ('m' + Math.floor((opts.at ? Date.parse(opts.at) : Date.now()) / 5000)),
    speaker_id: speaker ? speaker.id : null,
    text,
    at: opts.at,
    // 同一 turn 只入一笔：这里必须显式给指纹，否则 mutations 里新生成的
    // 人物 / 提及 id 会让每次调用看起来都不同，重发就变成两笔账。
    fingerprint: 'utter:' + fpOf([
      opts.source || 'chat', opts.sessionId || '',
      opts.turnId || ('m' + Math.floor((opts.at ? Date.parse(opts.at) : Date.now()) / 5000)),
      speaker ? speaker.id : '', text,
    ]),
    mutations: muts,
  })
  // 新建的人在本事件里：把 mention 补成 linked（回放时同样执行到这里，结果一致）
  return { id: out.id, dup: out.dup, person_id: speaker ? speaker.id : null, mentions: mentions.length }
}

// ---------------- 初始化 / 迁移 ----------------

function legacyRelations(db, aid) {
  try { return db.prepare('SELECT * FROM relations WHERE agent_id=?').all(aid) } catch { return [] }
}

function isCategoryRow(r) {
  if (!CATEGORY_NAMES.has(r.name)) return false
  return (r.name === '主人' && r.kind === 'owner')
    || (r.name === '熟人' && r.kind === 'acquaintance')
    || (r.name === '陌生人' && r.kind === 'stranger')
}

/**
 * 幂等启动：种三档、迁旧表、保证有一个主人、绑 ui/local。
 * 每一步都是一笔账（指纹去重），所以重跑不会重复建人。
 */
export function bootstrap(db, aid) {
  agent(db, aid)
  seedTiers(db)
  const legacy = legacyRelations(db, aid)
  const rootRow = legacy.find((r) => Number(r.root) === 1 && !isCategoryRow(r)) || legacy.find((r) => r.name === '主人') || null
  const owner = ownerPerson(db, aid)
  if (!owner) {
    const seed = rootRow && isCategoryRow(rootRow)
      ? { closeness: rootRow.closeness, trust: rootRow.trust, dependence: rootRow.dependence }
      : {}
    const name = (rootRow && !isCategoryRow(rootRow) ? rootRow.name : null) || '主人'
    // 出生时间 / 上次互动从 agents 行继承：主人一进来就有「上次说话」而不是一张空卡
    const a = agent(db, aid)
    const born = a.created_at || undefined
    const talked = a.last_interaction_at || null
    commit(db, aid, {
      kind: 'seed', source: 'system', text: 'owner', fingerprint: 'seed:owner',
      mutations: [{
        op: 'person.create',
        person: {
          name, tier: 'owner', graph_visible: true, summary: null, source: 'system',
          first_seen_at: born, last_talk_at: talked, ...seed,
        },
      }],
    })
  }
  const o = ownerPerson(db, aid)
  if (o) {
    commit(db, aid, {
      kind: 'seed', source: 'system', text: 'channel', fingerprint: 'seed:channel:ui:local',
      mutations: [{ op: 'channel.register', person_id: o.id, channel: 'ui', handle: 'local', confidence: 1 }],
    })
    // 一次性清扫：早期把「压缩摘要」当人话抽出来的提及，全部标忽略（重放也一致）
    commit(db, aid, {
      kind: 'seed', source: 'system', text: 'cleanup', fingerprint: 'seed:cleanup:v1',
      mutations: [{
        op: 'mention.cleanup',
        patterns: ['automatically generated checkpoint', 'condensing an earlier span'],
      }],
    })
    // 旧表里其它人：搬进人物账本（分类三行不搬）。
    // 同名的人如果已经被聊天侧认出来了，就只补信息、不再建第二个——
    // 以前这里无条件 create，同一句话会落成两张卡，图上也是两个点。
    const live = db.prepare("SELECT * FROM rel_person WHERE agent_id=? AND status<>'archived'").all(aid)
    for (const r of legacy) {
      if (isCategoryRow(r)) continue
      if (Number(r.root) === 1 && o.name === r.name) continue
      const tier = TIER_KEYS.includes(r.kind) ? r.kind : 'acquaintance'
      const twin = live.find((p) => normalizeName(p.name) === normalizeName(r.name))
      if (twin) {
        const patch = {}
        if (r.notes && !twin.summary) patch.summary = r.notes
        if (Number(r.closeness) > Number(twin.closeness)) patch.closeness = Number(r.closeness)
        if (Number(r.trust) > Number(twin.trust)) patch.trust = Number(r.trust)
        if (!twin.graph_visible) patch.graph_visible = true
        if (Object.keys(patch).length) {
          commit(db, aid, {
            kind: 'import', source: 'import', text: r.name, fingerprint: 'legacy:rel:merge:' + r.id,
            mutations: [{ op: 'person.update', person_id: twin.id, patch }],
          })
        }
        continue
      }
      commit(db, aid, {
        kind: 'import', source: 'import', text: r.name, fingerprint: 'legacy:rel:' + r.id,
        mutations: [{
          op: 'person.create',
          person: {
            name: r.name, tier: tier === 'owner' ? 'acquaintance' : tier, graph_visible: true,
            summary: r.notes || null, closeness: r.closeness, trust: r.trust, dependence: r.dependence,
            source: 'import', first_seen_at: r.created_at,
          },
        }],
      })
      // 同批里还有同名的旧行时，也认得出来（不然两张旧行会各建一张卡）
      live.push({ name: r.name, summary: r.notes || null, closeness: r.closeness, trust: r.trust, graph_visible: 1 })
    }
    // 一次性清扫：早期规则把「同学叫小花」拆成「叫小花」「小花」两张卡。
    // 名字以引称动词开头、剥掉后对得上一个活人的，并进那张卡（只做一次，指纹去重）。
    const liveNow = db.prepare("SELECT id,name,tier FROM rel_person WHERE agent_id=? AND status<>'archived'").all(aid)
    const byNorm = new Map(liveNow.map((p) => [normalizeName(p.name), p]))
    const merges = []
    for (const p of liveNow) {
      const bare = stripNameLead(p.name)
      if (bare === p.name || !bare) continue
      const twin = byNorm.get(normalizeName(bare))
      if (!twin || twin.id === p.id || p.tier === 'owner') continue
      merges.push({ op: 'person.merge', from_id: p.id, into_id: twin.id })
    }
    if (merges.length) {
      // 指纹按「这一批要并谁」算，不按版本号锁死：
      // 早先写成 seed:name-lead-merge:v1 只跑一次，之后新冒出来的「叫XX」就再也清不掉。
      // 现在每次 bootstrap 都扫，扫到脏卡就并；同一批并完指纹相同，不会重复记账。
      commit(db, aid, {
        kind: 'correction', source: 'system', text: 'name-lead-merge',
        fingerprint: 'name-lead-merge:' + fpOf(merges), mutations: merges,
      })
    }
  }
  return health(db, aid)
}

// ---------------- 遗忘 / 重建 / 体检 ----------------

const RITUAL_DAYS = 14

/**
 * R09（涂尔干）：14 天没有共同活动 → 主人亲近 −0.02，每 14 天最多一次。
 * 活账本是 rel_person；旧 relations 表只做镜像，给还没切完的读方。
 */
export function tickRitual(db, aid) {
  agent(db, aid)
  let owner = ownerPerson(db, aid)
  if (!owner) {
    try { bootstrap(db, aid) } catch { /* ignore */ }
    owner = ownerPerson(db, aid)
  }
  // 老库还没迁完：退回旧表
  if (!owner) {
    const legacy = db.prepare('SELECT * FROM relations WHERE agent_id=? AND root=1').get(aid)
      || db.prepare('SELECT * FROM relations WHERE agent_id=? ORDER BY closeness DESC LIMIT 1').get(aid)
    if (!legacy) return null
    const row = db.prepare('SELECT last_interaction_at FROM agents WHERE id=?').get(aid)
    const last = row && row.last_interaction_at
    if (!last) return null
    const idle = (Date.now() - Date.parse(last)) / 86400000
    if (!(idle >= RITUAL_DAYS)) return null
    if (cooldownActive(db, aid, 'ritual', legacy.id)) return null
    const before = Number(legacy.closeness)
    const after = Math.max(0, +(before - 0.02).toFixed(3))
    db.prepare('UPDATE relations SET closeness=?, updated_at=? WHERE id=?').run(after, now(), legacy.id)
    setCooldown(db, aid, 'ritual', legacy.id, RITUAL_DAYS, '14 天没有共同活动')
    return { relation: legacy.name, before, after, idle_days: +idle.toFixed(1), rule: 'R09', ledger: 'relations' }
  }
  const row = db.prepare('SELECT last_interaction_at FROM agents WHERE id=?').get(aid)
  const last = row && row.last_interaction_at
  if (!last) return null
  const idle = (Date.now() - Date.parse(last)) / 86400000
  if (!(idle >= RITUAL_DAYS)) return null
  if (cooldownActive(db, aid, 'ritual', owner.id)) return null
  const before = Number(owner.closeness)
  const after = Math.max(0, +(before - 0.02).toFixed(3))
  commit(db, aid, {
    kind: 'ritual', source: 'system', text: 'R09',
    fingerprint: 'ritual:' + owner.id + ':' + new Date().toISOString().slice(0, 10),
    mutations: [{ op: 'person.update', person_id: owner.id, patch: { closeness: after } }],
  })
  // 镜像旧表：同名 / root 行跟着改，面板旧读方不打架
  try {
    db.prepare('UPDATE relations SET closeness=?, updated_at=? WHERE agent_id=? AND (root=1 OR name=?)')
      .run(after, now(), aid, owner.name)
  } catch { /* 旧表没有也不要紧 */ }
  setCooldown(db, aid, 'ritual', owner.id, RITUAL_DAYS, '14 天没有共同活动')
  return { relation: owner.name, before, after, idle_days: +idle.toFixed(1), rule: 'R09', ledger: 'rel_person' }
}

/** 夜间衰减：R 曲线 + 降级 + 归档。主人不走时间；只让人物卡退场，不删原文。 */
export function tick(db, aid, opts = {}) {
  agent(db, aid)
  const at = opts.at ? Date.parse(opts.at) : Date.now()
  if (!Number.isFinite(at)) return { changed: 0 }
  const rows = db.prepare("SELECT * FROM rel_person WHERE agent_id=? AND tier<>'owner' AND status<>'archived'").all(aid)
  const muts = []
  for (const p of rows) {
    const tier = tierRow(db, p.tier)
    const half = Number(tier.half_life_days) || 30
    const last = Date.parse(p.last_seen_at || p.first_seen_at) || at
    const idle = Math.max(0, (at - last) / dayMs())
    const R = Math.pow(0.5, idle / half)
    const salience = +(R * (0.5 + 0.5 * Number(p.closeness))).toFixed(4)
    const patch = {}
    if (Math.abs(salience - Number(p.salience)) > 0.001) patch.salience = salience
    // 三轴回归基线（9 号 §5.2）：越久没见，越回到「你们本来该有的位置」，不是归零。
    // 亲近按档位半衰期；信任慢 1.5 倍；依赖 14 天半衰（依赖是「最近还在靠你」）。
    const baseC = Number(tier.init_closeness)
    const baseT = Number(tier.init_trust)
    const baseD = Number(tier.init_dependence)
    const back = (cur, base, halfD) => base + (Number(cur) - base) * Math.pow(0.5, idle / halfD)
    const nc = +back(p.closeness, baseC, half).toFixed(4)
    const nt = +back(p.trust, baseT, half * 1.5).toFixed(4)
    const nd = +back(p.dependence, baseD, 14).toFixed(4)
    if (Math.abs(nc - Number(p.closeness)) > 0.001) patch.closeness = clamp01(nc)
    if (Math.abs(nt - Number(p.trust)) > 0.001) patch.trust = clamp01(nt)
    if (Math.abs(nd - Number(p.dependence)) > 0.001) patch.dependence = clamp01(nd)
    const forget = Number(tier.forget_after_days)
    if (Number.isFinite(forget) && idle >= forget) {
      patch.status = 'archived'
    } else if (R < 0.25 && p.tier === 'acquaintance') {
      patch.tier = 'stranger'
      if (patch.salience == null) patch.salience = salience
    } else if (R < 0.5 && p.status === 'active') {
      patch.status = 'faded'
    } else if (R >= 0.5 && p.status === 'faded') {
      patch.status = 'active'
    }
    if (Object.keys(patch).length) muts.push({ op: 'person.update', person_id: p.id, patch })
  }
  if (!muts.length) return { changed: 0, at: new Date(at).toISOString() }
  const out = commit(db, aid, {
    kind: 'decay', source: 'system', text: 'tick',
    at: new Date(at).toISOString(),
    // 同一小时重复跑、且结论一样 → 只留一笔；结论变了就是新账
    fingerprint: 'decay:' + new Date(at).toISOString().slice(0, 13) + ':' + fpOf(muts),
    mutations: muts,
  })
  return { changed: muts.length, event: out.id, at: new Date(at).toISOString() }
}

/** 清空投影，按 rowid 重放账本。用于修复、迁移自检、测试「账本是主数据」。 */
export function rebuild(db, aid) {
  agent(db, aid)
  return tx(db, () => {
    db.prepare('DELETE FROM rel_mention WHERE agent_id=?').run(aid)
    db.prepare('DELETE FROM rel_evidence WHERE agent_id=?').run(aid)
    db.prepare('DELETE FROM rel_edge WHERE agent_id=?').run(aid)
    db.prepare('DELETE FROM rel_channel WHERE agent_id=?').run(aid)
    db.prepare('DELETE FROM rel_person WHERE agent_id=?').run(aid)
    const rows = db.prepare('SELECT id,at,payload FROM rel_event WHERE agent_id=? ORDER BY rowid').all(aid)
    let n = 0
    for (const r of rows) {
      let p = {}
      try { p = JSON.parse(r.payload || '{}') } catch { p = {} }
      for (const m of p.mutations || []) { applyMutation(db, aid, m, r.id, r.at); n++ }
    }
    return { events: rows.length, mutations: n, ...counts(db, aid) }
  })
}

function counts(db, aid) {
  const one = (sql, ...args) => Number(db.prepare(sql).get(aid, ...args).n)
  return {
    persons: one('SELECT COUNT(*) n FROM rel_person WHERE agent_id=?'),
    edges: one('SELECT COUNT(*) n FROM rel_edge WHERE agent_id=? AND valid_to IS NULL'),
    mentions: one('SELECT COUNT(*) n FROM rel_mention WHERE agent_id=?'),
    review: one("SELECT COUNT(*) n FROM rel_review WHERE agent_id=? AND state='pending'"),
  }
}

export function health(db, aid) {
  try { agent(db, aid) } catch { return null }
  const tiers = Number(db.prepare('SELECT COUNT(*) n FROM rel_tier').get().n)
  const byTier = db.prepare('SELECT tier, status, COUNT(*) n FROM rel_person WHERE agent_id=? GROUP BY tier, status').all(aid)
  const last = db.prepare('SELECT at FROM rel_event WHERE agent_id=? ORDER BY rowid DESC LIMIT 1').get(aid)
  return {
    schema: 10,
    tiers,
    persons: {
      active: byTier.filter((r) => r.status === 'active').reduce((a, r) => a + Number(r.n), 0),
      faded: byTier.filter((r) => r.status === 'faded').reduce((a, r) => a + Number(r.n), 0),
      archived: byTier.filter((r) => r.status === 'archived').reduce((a, r) => a + Number(r.n), 0),
      by_tier: Object.fromEntries(byTier.map((r) => [r.tier + '.' + r.status, Number(r.n)])),
    },
    edges: Number(db.prepare('SELECT COUNT(*) n FROM rel_edge WHERE agent_id=? AND valid_to IS NULL').get(aid).n),
    unresolved_mentions: Number(db.prepare("SELECT COUNT(*) n FROM rel_mention WHERE agent_id=? AND state='unresolved'").get(aid).n),
    pending_review: Number(db.prepare("SELECT COUNT(*) n FROM rel_review WHERE agent_id=? AND state='pending'").get(aid).n),
    events: Number(db.prepare('SELECT COUNT(*) n FROM rel_event WHERE agent_id=?').get(aid).n),
    last_event_at: last ? last.at : null,
  }
}

// ---------------- 关系动力学（9 号文档 §4–§5） ----------------

function recentViolation(db, aid, pid, at) {
  try {
    const r = db.prepare('SELECT ceiling, at FROM rel_violation WHERE agent_id=? AND person_id=?').get(aid, pid)
    if (!r) return null
    if (at - Date.parse(r.at) > 7 * 86400000) return null
    return { ceiling: Number(r.ceiling), at: r.at }
  } catch { return null }
}

function recordViolation(db, aid, pid, ceiling, at) {
  const cur = db.prepare('SELECT ceiling FROM rel_violation WHERE agent_id=? AND person_id=?').get(aid, pid)
  const next = cur ? Math.min(Number(cur.ceiling), Number(ceiling)) : Number(ceiling)
  db.prepare('INSERT OR REPLACE INTO rel_violation(agent_id, person_id, ceiling, at) VALUES(?,?,?,?)')
    .run(aid, pid, next, new Date(at).toISOString())
}

/**
 * 一次事件 → 三轴（亲近 / 信任 / 依赖）。
 * 效价 v 由调用方算好（情绪域已经评过一次，不在这里重判）；落账 + 改投影一个事务。
 * 没有绑定人物时返回 skipped，不动任何东西。
 */
export function bumpRelation(db, aid, {
  personId = null, v = 0, kind = 'chat', label = 'calm',
  source = 'chat', reason = '', at = Date.now(),
} = {}) {
  agent(db, aid)
  let p = personId ? getPerson(db, aid, personId) : (ownerPerson(db, aid) || personByChannel(db, aid))
  // 懒启动：新实例可能还没打开过关系页，账本里还没主人。第一次动关系时补种一次。
  if (!p && !personId) {
    try { bootstrap(db, aid) } catch { /* 种不出来就算了 */ }
    p = ownerPerson(db, aid) || personByChannel(db, aid)
  }
  if (!p) return { changed: [], skipped: 'no-person' }
  const vv = Math.max(-1, Math.min(1, Number(v) || 0))

  // 习惯化：同一个人 + 同一种事，越刷越淡（隔久了自己恢复）
  const key = stimulusKey(label, kind)
  let h = null
  try { h = db.prepare('SELECT n, at FROM rel_habit WHERE agent_id=? AND person_id=? AND key=?').get(aid, p.id, key) } catch { /* 老库没表 */ }
  const hf = habitOf({ count: h ? Number(h.n) : 0, lastAt: h && h.at ? Date.parse(h.at) : null, now: at })
  try {
    db.prepare('INSERT OR REPLACE INTO rel_habit(agent_id, person_id, key, n, at) VALUES(?,?,?,?,?)')
      .run(aid, p.id, key, hf.nextCount, new Date(hf.nextAt).toISOString())
  } catch { /* 记不上就算了 */ }

  const w = weightOf({ source, habit: hf.factor })
  if (Math.abs(vv) * w < REL_DEFAULTS.noise && kind !== 'boundary') {
    return { changed: [], skipped: 'noise', v: vv, w, kind, person_id: p.id }
  }
  const before = { closeness: Number(p.closeness), trust: Number(p.trust), dependence: Number(p.dependence) }
  let after
  if (kind === 'repair') {
    // 修复（F7 / 9 号 §5.3）：只回信任，不回亲近；受损后只能补回这次损失的 90%
    const vio = recentViolation(db, aid, p.id, at)
    const cap = vio && vio.ceiling > before.trust
      ? before.trust + (vio.ceiling - before.trust) * 0.9
      : null
    const rep = repairTrust(before, { strength: 0.6, w, ceiling: cap })
    after = {
      closeness: before.closeness,
      trust: rep.trust,
      dependence: before.dependence,
      delta: { closeness: 0, trust: rep.delta, dependence: 0 },
    }
  } else {
    after = applyEvent(before, { v: vv, w, kind })
  }
  // 伤害留痕：被批评 / 越界时记住「受伤前的信任」，修复只能补回这次损失的 90%
  if (kind === 'boundary' || (vv <= -0.2 && kind !== 'repair')) {
    try { recordViolation(db, aid, p.id, before.trust, at) } catch { /* 记不上就算了 */ }
  }
  if (!after.delta.closeness && !after.delta.trust && !after.delta.dependence) {
    return { changed: [], skipped: 'flat', v: vv, w, kind, person_id: p.id }
  }
  const atIso = new Date(at).toISOString()
  const out = commit(db, aid, {
    kind: 'appraisal',
    source: String(source || 'system'),
    speaker_id: p.id,
    text: String(reason || '').slice(0, 200),
    at: atIso,
    // 同一毫秒 + 同一效价才算同一笔；指纹只挡真正的重放
    fingerprint: 'bump:' + p.id + ':' + at + ':' + fpOf([vv, w, kind]),
    mutations: [{
      op: 'person.update',
      person_id: p.id,
      patch: { closeness: after.closeness, trust: after.trust, dependence: after.dependence },
    }],
  })
  return {
    changed: [{
      field: 'relations.' + p.name,
      before,
      after: { closeness: after.closeness, trust: after.trust, dependence: after.dependence },
      kind, v: vv, w,
    }],
    event_id: out.id, dup: out.dup, person_id: p.id, person: p.name,
    v: vv, w, kind, before, after,
  }
}
