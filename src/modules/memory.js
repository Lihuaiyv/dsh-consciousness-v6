import { journalIntent, journalDone, now } from '../db.js'
import { run as runAlgo, has as algoHas, runBound, resolveVersion } from '../algo/index.js'
import { err, nid, tx, agent, active, event, getParam, model } from '../kernel.js'
import { judgePair } from './pair_judge.js'
import { bandOf, heatOf, nowRow } from './tiers.js'
import { archiveFact } from './archive.js'
import {
  logAdd, invalidateMemory, reactivateMemory, hideMemory, unhideMemory,
  disputeOpen, disputeClose,
} from './timeline.js'
import { syncClaims, claimEnabled } from './claim_state.js'
import { parseTimeRange } from './timeparse.js'
import { normalizeTerms } from './terms.js'
import { attrConflict } from './contradict.js'
import { askAboutConflict } from './conflict_ask.js'
import { dropPendingByReason } from './proactive.js'
import { maskPositive } from './negation.js'
import { feelsByIds } from './feel.js'
export { normalizeTerms }

/**
 * 出生时挂 feel 的取数口：由装配层注入（index.js），memory 模块不直接读 affect_feel（INV10）。
 * 没注入就返回 null——不挂，不编。
 */
let feelProvider = null
export function setFeelProvider(fn) { feelProvider = typeof fn === 'function' ? fn : null }

/**
 * 出生时的慢情绪背景：同样由装配层注入（index.js 交的是 affect.moodValenceOf）。
 * 没注入就写 NULL——不编一个 0 出来冒充「当时中性」。
 */
let slowProvider = null
export function setSlowProvider(fn) { slowProvider = typeof fn === 'function' ? fn : null }

const SECRET = /(sk-[A-Za-z0-9]{8,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,})/g
const NEG = new Set([...'不没别无取消换改'])
const CONFLICT_TYPES = new Set(['fact', 'appraisal'])
const IDENTITY = /(姓名|名字|称呼|主人|生日|禁忌|禁止|住在|住址|电话|年龄|工作)/

function redact(text) { return String(text).replace(SECRET, '[REDACTED]') }
function chars(text) { return new Set(String(text).match(/[\u4e00-\u9fff]|[a-zA-Z0-9]/g) || []) }

/** 检索文本＝原文 + 去重键 + 同义词。只进 FTS 索引，注入时仍用原文。 */
export function buildSearchText(text, key, terms) {
  const parts = [String(text || '').trim()]
  const k = String(key || '').trim()
  if (k) parts.push(k)
  for (const t of normalizeTerms(terms)) parts.push(t)
  return parts.filter(Boolean).join(' ')
}
function sim(a, b) {
  const A = chars(a), B = chars(b)
  let inter = 0
  for (const c of A) if (B.has(c)) inter++
  return inter / Math.max(1, new Set([...A, ...B]).size)
}
function hasNeg(text) { return [...maskPositive(text)].some((c) => NEG.has(c)) }

/**
 * 这一对记忆之间有没有冲突记录（不论开没开完）。
 * 开案前查一次：判过的别再弹，否则每抽到一个新说法就重新开一张同样的卡。
 * opt.openOnly：只认还开着的案——低风险已结案的记录不该挡门控再开一张。
 */
export function conflictPairExists(db, aid, aId, bId, opt = {}) {
  if (!aId || !bId) return false
  try {
    const extra = opt && opt.openOnly ? " AND state='open'" : ''
    return !!db.prepare(`SELECT 1 FROM conflicts WHERE agent_id=?${extra} AND
      ((a_id=? AND b_id=?) OR (a_id=? AND b_id=?)) LIMIT 1`).get(aid, aId, bId, bId, aId)
  } catch { return false }
}

/** 去掉模板句、时间戳、角色前缀，只留下真正的内容再比 */
function coreText(text) {
  return String(text)
    .replace(/Time sampled[^\n]*/gi, ' ')
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.+-]+Z?/g, ' ')
    .replace(/\[Asia\/[^\]]*\]/g, ' ')
    .replace(/^(user|assistant|system|我|你)[:：]\s*/gim, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function detectConflict(db, aid, text, typ = 'fact') {
  const probe = coreText(text)
  if (!probe) return [null, null, null, null]
  let rows = []
  try {
    rows = db.prepare("SELECT * FROM memory_items WHERE agent_id=? AND status='active' AND invalid_at IS NULL ORDER BY created_at DESC LIMIT 200").all(aid)
  } catch { rows = [] }

  // ① 属性矛盾：不靠否定词。摘要（「1. 事实：…」）也算，它本来就是事实的载体——
  //    「咖啡是热的」和「咖啡是冰的」整句没有一个否定词，只有同一骨架下的取值不同。
  //    情景（episode）是流水账，句子长、细节多，不拿它比，免得把两件事里各自出现的词撞成一对。
  for (const m of rows) {
    if (!CONFLICT_TYPES.has(m.type) && m.type !== 'reflection') continue
    const hit = attrConflict(probe, m.text)
    if (!hit) continue
    // 只有双方都是事实/评价时才让旧的退场；两段流水账都留，只挂一条等人拍的冲突。
    const invalidate = CONFLICT_TYPES.has(typ) && CONFLICT_TYPES.has(m.type)
    return ['conflict', { ...m, sim: Number(sim(probe, coreText(m.text)).toFixed(3)), attr: hit }, 'high',
      { invalidate, via: 'attribute', attr: hit }]
  }

  // 反思/经历是流水账，不承担事实断言，不参与否定词判决
  if (!CONFLICT_TYPES.has(typ)) return [null, null, null, null]
  /* 11-10：先找「极性相反」，再判「重复」。
     以前重复判定先跑（s ≥ 0.9 直接 return），最像的那批对立句——
     比如「生日是十月三日」对「生日不是十月三日」，只差一个「不」——会被当成同一句话合并掉，
     连冲突都不会记。现在只有「重复的那条不是同一对矛盾」时才合并。 */
  let hit = null
  let dup = null
  for (const m of rows) {
    if (!CONFLICT_TYPES.has(m.type)) continue
    const other = coreText(m.text)
    const s = sim(probe, other)
    if (!dup && s >= 0.9) dup = { m, s }
    if (!hit && s >= 0.5 && hasNeg(probe) !== hasNeg(other)) hit = { m, s }
  }
  if (dup && (!hit || dup.m.id !== hit.m.id)) return ['duplicate', dup.m, null, null]
  if (!hit) return [null, null, null, null]
  const risky = IDENTITY.test(probe + ' ' + hit.m.text) || Number(hit.m.weight || 0) >= 0.8
  // 带上相似度，冲突留痕里要能回答「凭什么判成冲突」
  return ['conflict', { ...hit.m, sim: Number(hit.s.toFixed(3)) }, risky ? 'high' : 'low',
    { invalidate: true, via: 'polarity' }]
}

/**
 * 事实失效（P2）：同一个 fact_key 来了新说法，就把旧说法标成「已被取代」。
 *
 *   - 只动 fact / appraisal：自省、情景是流水账，不该被同 key 的新说法顶掉；
 *   - 旧记录不删：invalid_at + superseded_by 留痕，深查（S3）还查得到，注入时标「（已更新）」；
 *   - 默认召回（S1）不带它，避免「你改口之后它同时想起两个版本」；
 *   - 一次最多退场 5 条：防一个泛 key 把一整类记忆全判死。
 *
 * 只给「抽取时明确写下这个 key」的写入用（addMemory）。检索卡补出来的 key 是猜的，
 * 不拿它判生死——否则回填一遍就可能把一整类有效记忆标成过期。
 *
 * 返回被取代的 id 列表（没 key / 没旧条目就是空数组）。
 */
export function supersedeByKey(db, aid, mid, factKey, typ = 'fact') {
  const key = String(factKey || '').trim()
  if (!key || !CONFLICT_TYPES.has(typ)) return []
  let rows = []
  try {
    rows = db.prepare(`SELECT id FROM memory_items
      WHERE agent_id=? AND fact_key=? AND id<>? AND status='active' AND invalid_at IS NULL
      ORDER BY created_at DESC LIMIT 5`).all(aid, key, mid)
  } catch { return [] }
  if (!rows.length) return []
  const at = now()
  for (const r of rows) {
    // G1：旧说法退场也记一笔——「什么时候被谁取代的」不能只靠被覆盖的 invalid_at 单列
    invalidateMemory(db, aid, r.id, { at, supersededBy: mid, bumpVersion: true, reason: 'supersede', causeId: mid, actor: 'extract' })
  }
  try { event(db, aid, 'memory.fact_superseded', { by: mid, old: rows.map((r) => r.id), key }) } catch { /* 事件失败不影响写入 */ }
  return rows.map((r) => r.id)
}

/**
 * 按 id 批量退场：给「整理/合并」用（consolidate.js）。
 * 合并稿写进来之后，被合并的那几条 invalid_at + superseded_by 指向它——
 * 默认召回不见了，深查还能顺着指针找回原文。
 */
export function supersedeMany(db, aid, mid, ids = [], reason = 'merged') {
  const list = [...new Set((ids || []).filter(Boolean))].filter((x) => x !== mid)
  if (!list.length) return []
  const at = now()
  const done = []
  for (const id of list) {
    try {
      invalidateMemory(db, aid, id, { at, supersededBy: mid, bumpVersion: true, agentScoped: true, reason, causeId: mid, actor: 'consolidate' })
      done.push(id)
    } catch { /* 单条失败不影响其余 */ }
  }
  if (done.length) {
    try { event(db, aid, 'memory.superseded_many', { by: mid, old: done, reason }) } catch { /* 事件失败不影响写入 */ }
  }
  return done
}

export function addMemory(db, aid, body) {
  active(db, aid)
  const text = String(body.text || '').trim()
  if (!text || text.length > 4000) err(400, 'INVALID_ARGUMENT', 'text 必填，1–4000 字')
  const typ = body.type || 'fact'
  if (!['fact', 'episode', 'appraisal', 'reflection', 'conflict'].includes(typ)) err(400, 'INVALID_ARGUMENT', 'type 非法')
  const safe = redact(text)
  const [kind, old, risk, opt] = detectConflict(db, aid, safe, typ)
  if (kind === 'duplicate') {
    // 完全重复：不新建，也不写自环（旧代码写的是 from_id=to_id 的自环，等于没连）。
    return { id: old.id, duplicate: true }
  }
  const mid = nid('mem_')
  // 「发生时间」：调用方给的第一优先；没给就从文本里规则解析「昨天/上周三/11月5日」。
  // 解析不出就留空——空表示「不知道」，绝不能默认成现在（那会把去年的事记成今天）。
  const occurredAt = (() => {
    const given = body.valid_at || body.occurred_at
    if (given) { const d = new Date(given); return Number.isNaN(+d) ? null : d.toISOString() }
    try { const r = parseTimeRange(text); return r && r.from ? r.from : null } catch { return null }
  })()
  const importance = Math.max(0, Math.min(1, Number(body.importance ?? body.weight ?? 0.5) || 0.5))
  const salience = Math.max(0, Math.min(1, Number(body.salience ?? 0) || 0))
  /* 出生时的情绪效价：调用方给了就用给的（对话里就是这一下的愉悦），
     没给就是 0（中性）——记忆模块不直接读情绪表（INV10），要加成由调用方注入。 */
  const valence = Math.max(-1, Math.min(1, body.valence != null ? Number(body.valence) || 0 : 0))
  /* 出生那一刻自己写下的 feel：取数口由装配层注入（memory 模块不直接读 affect_feel，INV10）。
     只存 id，正文仍留在 feel 自己那边，查记忆时顺着 id 翻。 */
  const feelId = (() => {
    try { return body.feel_id || (feelProvider ? feelProvider(db, aid) : null) || null } catch { return null }
  })()
  /* 出生这一刻的慢情绪背景：调用方给了就用给的，没给就问装配层注入的口。
     两处都拿不到就写 NULL——「没记过」和「当时正好中性」在加成上一样，在读数上不一样。 */
  const slowAt = (() => {
    const given = body.slow_at_creation
    if (given != null && Number.isFinite(Number(given))) return Math.max(-1, Math.min(1, Number(given)))
    try {
      const v = slowProvider ? slowProvider(db, aid) : null
      // Number(null) 是 0——先挡掉空值，不然「拿不到数」会被写成「正好中性」。
      if (v == null) return null
      const num = Number(v)
      return Number.isFinite(num) ? Math.max(-1, Math.min(1, num)) : null
    } catch { return null }
  })()
  const terms = normalizeTerms(body.terms)
  const factKey = String(body.fact_key || body.key || '').trim().slice(0, 120) || null
  const searchText = buildSearchText(safe, factKey, terms)
  const seq = journalIntent(db, aid, 'insert_memory', { memory_id: mid }, body.turn_id)
  let superseded = []
  let conflictId = null
  tx(db, () => {
    db.prepare(`INSERT INTO memory_items(id,agent_id,type,mark,text,source,w0,weight,stability,difficulty,
        last_decay_at,valid_at,invalid_at,status,created_at,deleted_at,version,feel_id,slow_at_creation)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(mid, aid, typ, 'normal', safe, String(body.source || 'manual').slice(0, 24), 0.5, 0.5, 1.0, 5.0,
        now(), occurredAt, null, 'active', now(), null, 1, feelId, slowAt)
    // 分层账本：重要度 / 情绪显著度 / 来源轮次；热度先按默认算一遍
    // 检索卡：fact_key + terms + search_text（写进 FTS 的是 search_text，不是原文）
    db.prepare('UPDATE memory_items SET importance=?, salience=?, valence=?, confidence=?, source_turn_id=?, entity_id=?, fact_key=?, terms=?, search_text=?, feel_id=? WHERE id=?')
      .run(importance, salience, valence, body.confidence != null ? Number(body.confidence) : 0.8, body.turn_id || null,
        body.entity_id || null, factKey, terms.length ? terms.join(' ') : null, searchText, feelId, mid)
    // 图关系：同一实体下的记忆互连（双向）。检索时一跳扩散靠它，
    // 之前只有自环、等于没有图；这里补上真正有意义的边。
    if (body.entity_id) {
      try {
        const sibs = db.prepare("SELECT id FROM memory_items WHERE agent_id=? AND entity_id=? AND id<>? ORDER BY created_at DESC LIMIT 20").all(aid, body.entity_id, mid)
        const link = db.prepare('INSERT OR IGNORE INTO memory_links VALUES(?,?,?,?)')
        for (const s of sibs) {
          link.run(mid, s.id, 'same_entity', 1.0)
          link.run(s.id, mid, 'same_entity', 1.0)
        }
      } catch { /* 连边失败不影响写入 */ }
    }
    try {
      const row = db.prepare('SELECT * FROM memory_items WHERE id=?').get(mid)
      const h = heatOf(row)
      db.prepare('UPDATE memory_items SET heat=?, band=? WHERE id=?').run(h, bandOf(row, h), mid)
    } catch { /* 热度失败不影响写入 */ }
    // 写入侧闸门（P4）：判出来「不值得每轮想起」的东西，落库但放进深查层（cold），不进 S1。
    if (body.cold) {
      try { db.prepare("UPDATE memory_items SET temp_state='cold', state_since=? WHERE id=?").run(now(), mid) } catch { /* 老库没有温度列 */ }
    }
    db.prepare('INSERT INTO memory_fts(id,text) VALUES(?,?)').run(mid, searchText)
    /* 署名：这句是谁的。只在调用方带了 speaker 时写——老入口不传就是 unknown，
       不写一行，免得把「没标」和「不属于任何人」混成一件事。 */
    const provSpeaker = body.speaker ? String(body.speaker).trim().slice(0, 12) : ''
    if (provSpeaker) {
      try {
        db.prepare(`INSERT OR REPLACE INTO memory_provenance(memory_id,agent_id,speaker,quote,inferred,turn_id,via,created_at)
          VALUES(?,?,?,?,?,?,?,?)`).run(
          mid, aid, provSpeaker,
          body.quote != null ? String(body.quote).trim().slice(0, 160) || null : null,
          body.inferred ? 1 : 0,
          body.turn_id || null,
          String(body.source || 'model').slice(0, 24),
          now(),
        )
      } catch { /* 署名失败不影响记忆本身 */ }
    }
    // 事实失效：同一个 fact_key 的旧说法当场退场（不删，只标记被谁取代）
    superseded = supersedeByKey(db, aid, mid, factKey, typ)
    // T4 事实存根：这条事实「出生时」长什么样，永远留一份（只追加，之后衰减/推翻/合并都不动它）
    let birthRef = null
    try {
      const fa = archiveFact(db, aid, {
        memory_id: mid, text: safe, type: typ, mark: 'normal',
        importance, salience, confidence: body.confidence != null ? Number(body.confidence) : 0.8,
        fact_key: factKey, source_turn_id: body.turn_id || null,
        source: body.source || 'model', feel_id: feelId,
      })
      birthRef = fa && fa.id ? fa.id : null
    } catch {
      try { event(db, aid, 'memory.archive_failed', { memory_id: mid }) } catch { /* 连事件都失败就只剩写入 */ }
    }
    // G1：出生事件。text_ref 指向出生照；valid_from 认来源原话/纪要的说话时间
    logAdd(db, aid, mid, {
      sourceTurnId: body.turn_id || null,
      validAt: occurredAt,   // 发生时间；空则回落「说话时间/入库时间」
      textRef: birthRef,
      actor: String(body.source || 'model').slice(0, 24),
    })
    event(db, aid, 'memory.written', { memory_id: mid })
    if (kind === 'conflict') {
      const cid = nid('cfl_')
      // P3：把判定依据一起存下来，半年后还能回答「当时凭什么判成冲突」
      const evidence = JSON.stringify({
        similarity: old.sim != null ? Number(old.sim) : null,
        a_text: String(old.text || '').slice(0, 120),
        b_text: safe.slice(0, 120),
        risk, type: typ,
        via: (opt && opt.via) || 'polarity',
        attribute: (opt && opt.attr) || null,
      })
      if (risk === 'low') {
        // 低风险：两条都保留，不算“待处理”
        db.prepare(`INSERT INTO conflicts(id,agent_id,a_id,b_id,state,resolution,reason,resolved_at,opened_at,
            severity,kind,source_turn_id,evidence) VALUES(?,?,?,?, 'resolved', 'superseded', ?, ?, ?, 'low','polarity',?,?)`)
          .run(cid, aid, old.id, mid, '模板相似/否定词差异，两条都保留', now(), now(), body.turn_id || null, evidence)
        event(db, aid, 'memory.conflict_superseded', { conflict_id: cid, a: old.id, b: mid })
      } else if (conflictJudgeOn(db, aid)) {
        // 先判后动（11-10）：抽取判出来的冲突也不再直接开卡/作废旧条。
        // 先落一条 pending，判官回来才动手；判之前不打扰、不问。
        const kindCol = opt && opt.attr ? 'attribute' : 'polarity'
        db.prepare(`INSERT INTO conflicts(id,agent_id,a_id,b_id,state,opened_at,severity,kind,source_turn_id,evidence)
          VALUES(?,?,?,?, 'pending', ?, 'high',?,?,?)`)
          .run(cid, aid, old.id, mid, now(), kindCol, body.turn_id || null, evidence)
        disputeOpen(db, aid, [old.id, mid], cid, { actor: 'extract' })
        event(db, aid, 'memory.conflict.pending', { conflict_id: cid, a: old.id, b: mid, via: (opt && opt.via) || 'polarity' })
        try {
          const complete = typeof body.complete === 'function' ? body.complete : ((req) => model.complete(req))
          queueConflictJudge(db, aid, {
            cid,
            oldRow: old,
            newRow: { id: mid, text: safe, created_at: now(), fact_key: body.fact_key || null },
            complete,
          })
        } catch { /* 排不进队列就留 pending，等夜里重判 */ }
        conflictId = cid
      } else {
        // 属性矛盾只顶掉事实/评价；两段摘要（流水账）都留，别把整段纪要判死
        if (!opt || opt.invalidate !== false) {
          invalidateMemory(db, aid, old.id, { reason: 'conflict', causeId: mid, actor: 'extract' })
        }
        const kindCol = opt && opt.attr ? 'attribute' : 'polarity'
        db.prepare(`INSERT INTO conflicts(id,agent_id,a_id,b_id,state,opened_at,severity,kind,source_turn_id,evidence)
          VALUES(?,?,?,?, 'open', ?, 'high',?,?,?)`)
          .run(cid, aid, old.id, mid, now(), kindCol, body.turn_id || null, evidence)
        // G1：争议区间。两条都记开案，投影才知道「那段时间它们有争议」
        disputeOpen(db, aid, [old.id, mid], cid, { actor: 'extract' })
        event(db, aid, 'memory.conflict', { conflict_id: cid, a: old.id, b: mid, via: (opt && opt.via) || 'polarity' })
        db.prepare('INSERT INTO alerts VALUES(?,?,?,?,?,?,?)')
          .run(nid('alr_'), aid, 'data', 2, '有一条记忆冲突未处理', 'open', now())
        // 开案之后真的开口问：排一条待发的主动消息（同一个冲突只问一次）
        // attr 的 sentence_a 是「这句」（新），sentence_b 是「旧那条」——问句要按时间顺序说
        askAboutConflict(db, aid, {
          cid, aId: old.id, bId: mid,
          aText: (opt && opt.attr && opt.attr.sentence_b) || old.text,
          bText: (opt && opt.attr && opt.attr.sentence_a) || safe,
        })
        conflictId = cid
      }
    }
  })
  journalDone(db, seq)
  // v3：出生时用规则标一次 claim（pending/done）；标注失败不影响记忆本身。
  try { if (claimEnabled(db, aid)) syncClaims(db, aid, { id: mid, text: safe }) } catch { /* 标注失败不算写入失败 */ }
  return { id: mid, conflict: kind === 'conflict' && risk === 'high', conflict_id: conflictId, superseded: kind === 'conflict' && risk === 'low', superseded_ids: superseded }
}

/**
 * 把一条记忆挂到实体上（entities 回填用）：只动 entity_id。
 * 写权收口：entities 不再直接写 memory_items。
 */
export function setMemoryEntity(db, id, entityId) {
  db.prepare('UPDATE memory_items SET entity_id=? WHERE id=?').run(entityId, id)
}

/**
 * 写检索卡片（enrich 用）：fact_key 只在原来空着时补，terms / search_text 覆盖，版本 +1。
 * 写权收口：enrich 不再直接写 memory_items。
 */
export function setMemorySearchFields(db, id, { key = null, terms = [], searchText = null } = {}) {
  const t = Array.isArray(terms) && terms.length ? terms.join(' ') : null
  db.prepare('UPDATE memory_items SET fact_key=COALESCE(?,fact_key), terms=?, search_text=?, version=version+1 WHERE id=?')
    .run(key, t, searchText, id)
  return { id, key, terms }
}

/**
 * 自我模式又见到一次：重要度 / 信心缓慢上涨，封顶；记一次命中。
 * 只给 self_pattern 用——把原来它直接写 memory_items 的那两句 SQL 收回记忆模块。
 */
export function bumpSelfPattern(db, id, at = null) {
  try {
    db.prepare(`UPDATE memory_items SET
      importance=MIN(0.9, importance+0.05),
      confidence=MIN(0.85, confidence+0.03),
      last_hit_at=?
      WHERE id=?`).run(at || now(), id)
  } catch {
    try {
      db.prepare(`UPDATE memory_items SET
        importance=MIN(0.9, importance+0.05),
        confidence=MIN(0.85, confidence+0.03)
        WHERE id=?`).run(id)
    } catch { /* 老库没有 confidence 列之类，加不上分就算了，条目还在 */ }
  }
}

/**
 * 开一条「待处理」的冲突记录：抽取和门控两处共用。
 * - 抽取带 source_turn_id；门控带 escalation_level。两边写法保持原样，不强行合并成一列。
 */
export function openConflict(db, aid, o = {}) {
  const stamp = o.at || now()
  const state = o.state || 'open'
  if (o.turnId !== undefined) {
    db.prepare(`INSERT INTO conflicts(id,agent_id,a_id,b_id,state,opened_at,severity,kind,source_turn_id,evidence)
      VALUES(?,?,?,?, ?, ?, ?,?,?,?)`)
      .run(o.id, aid, o.aId, o.bId, state, stamp, o.severity || 'high', o.kind || 'polarity', o.turnId || null, o.evidence == null ? null : o.evidence)
    return
  }
  db.prepare(`INSERT INTO conflicts(id,agent_id,a_id,b_id,state,opened_at,severity,kind,evidence,escalation_level)
    VALUES(?,?,?,?, ?, ?, ?,?,?,?)`)
    .run(o.id, aid, o.aId, o.bId, state, stamp, o.severity || 'high', o.kind || 'polarity', o.evidence == null ? null : o.evidence, o.escalation == null ? 0 : o.escalation)
}

/**
 * 把一条冲突压回「待判」：先判后动时重用的那张卡不能还开着。
 * （写 conflicts 的口径收在记忆模块里，门控只调这个函数）
 */
export function markConflictPending(db, aid, { cid, evidence = null } = {}) {
  if (!cid) return false
  try {
    db.prepare("UPDATE conflicts SET state='pending', resolution=NULL, resolved_at=NULL, evidence=COALESCE(?,evidence) WHERE id=? AND agent_id=?")
      .run(evidence, cid, aid)
    return true
  } catch { return false }
}

/**
 * 判官给出结论之后，按结论把冲突了结（11-10：先判后动）。
 *
 * 取代 → 旧条收起来、记一笔 resolved（不开「等你拍板」的卡、不排问句）
 * 补充 / 无关 → 两条都留着，记一笔 resolved
 * 不确定 / 没判出来 → 留在 pending：面板上挂着，但不冒泡、不开口
 *
 * @returns {'supersede'|'supplement'|'unrelated'|'pending'}
 */
export function settleConflictByVerdict(db, aid, { cid, verdict, reason = null, oldId = null, at = null } = {}) {
  if (!cid) return 'pending'
  const stamp = at || now()
  const note = String(reason || '').slice(0, 160)
  let pair = null
  try { pair = db.prepare('SELECT a_id, b_id FROM conflicts WHERE id=? AND agent_id=?').get(cid, aid) } catch { pair = null }
  const closeDispute = () => {
    if (!pair || !pair.a_id || !pair.b_id) return
    try { disputeClose(db, aid, [pair.a_id, pair.b_id], cid, { at: stamp, actor: 'judge' }) } catch { /* 老的争议区间收不掉就算了 */ }
  }
  try {
    if (verdict === 'supersede') {
      if (oldId) {
        try { invalidateMemory(db, aid, oldId, { reason: 'judge_supersede', causeId: cid, actor: 'gate' }) } catch { /* 单条失败不连累 */ }
      }
      db.prepare("UPDATE conflicts SET state='resolved', resolution='supersede', reason=?, resolved_at=? WHERE id=? AND agent_id=?")
        .run(note || '判官：取代', stamp, cid, aid)
      closeDispute()
      return 'supersede'
    }
    if (verdict === 'supplement' || verdict === 'unrelated') {
      db.prepare("UPDATE conflicts SET state='resolved', resolution=?, reason=?, resolved_at=? WHERE id=? AND agent_id=?")
        .run(verdict, note || ('判官：' + verdict), stamp, cid, aid)
      closeDispute()
      return verdict
    }
    db.prepare('UPDATE conflicts SET reason=? WHERE id=? AND agent_id=?')
      .run('待判：' + (note || verdict || '不确定'), cid, aid)
  } catch { /* 结案失败就留着，别把结论吞掉 */ }
  return 'pending'
}

/** 门控 / 抽取共用的开关：判官先判，再动手。 */
export function conflictJudgeOn(db, aid) {
  try { return String(getParam(db, aid, 'memory.conflict.judge') || 'on') !== 'off' } catch { return true }
}

// 抽取是同步的，判官是异步的：先记 pending，判完回来结案。
// 这里存的就是「还没判完的那几件」，夜里对账 / 测试都靠它等一遍。
const judgeQueue = new Set()

/** 等所有在飞的判官跑完（测试与夜里对账用）。永远不抛。 */
export function flushConflictJudges() {
  return Promise.allSettled([...judgeQueue])
}

/** 给一对「待判」冲突排一次判官。判完按结论结案；判不出来就留在 pending。 */
export function queueConflictJudge(db, aid, { cid, oldRow, newRow, complete, timeoutMs = 20000 } = {}) {
  if (!cid || !oldRow || !newRow) return null
  const p = (async () => {
    let verdict = 'uncertain'
    let reason = 'no-model'
    try {
      if (typeof complete === 'function') {
        const r = await judgePair({ db, aid, oldRow, newerRow: newRow, complete, timeoutMs, via: 'extract' })
        verdict = r.verdict
        reason = r.reason || ''
      }
    } catch (e) {
      reason = 'error:' + String((e && e.message) || e).slice(0, 60)
    }
    try { settleConflictByVerdict(db, aid, { cid, verdict, reason, oldId: oldRow.id }) } catch { /* 结案失败就留 pending */ }
    return verdict
  })().catch(() => null)
  judgeQueue.add(p)
  p.finally(() => { judgeQueue.delete(p) })
  return p
}

/**
 * 夜里把白天没判出结论的「待判」再问一遍（11-10）。
 *
 * 白天判官可能：没模型、超时、回空、或自己说拿不准 —— 那些都停在 pending。
 * 夜里重问一次；仍然判不出来的，超过 retireAfterMs（默认 7 天）就作废退场，
 * 免得 pending 越积越多、永远没人看。
 *
 * 只判「已经放了 olderThanMs 的」，刚写入的那批留给白天那条异步链，不抢它。
 */
export async function rejudgePendingConflicts(db, aid, {
  complete, limit = 10, olderThanMs = 3600000, retireAfterMs = 7 * 86400000, timeoutMs = 20000,
} = {}) {
  const n = Math.max(1, Math.min(100, Number(limit) || 10))
  let rows = []
  try {
    rows = db.prepare("SELECT * FROM conflicts WHERE agent_id=? AND state='pending' ORDER BY opened_at ASC LIMIT ?").all(aid, n)
  } catch { return { checked: 0, settled: 0, retired: 0, skipped: 'no-table' } }
  const nowMs = Date.now()
  const one = (id) => { try { return db.prepare('SELECT * FROM memory_items WHERE id=?').get(id) || null } catch { return null } }
  let settled = 0
  let retired = 0
  let skipped = 0
  for (const c of rows) {
    const age = nowMs - (Date.parse(c.opened_at || '') || 0)
    if (age < olderThanMs) { skipped++; continue }
    if (age > retireAfterMs) {
      try {
        db.prepare("UPDATE conflicts SET state='resolved', resolution='unknown', reason='待判超期，作废', resolved_at=? WHERE id=? AND agent_id=?")
          .run(now(), c.id, aid)
        retired++
      } catch { /* 退场失败就算了 */ }
      continue
    }
    const a = one(c.a_id)
    const b = one(c.b_id)
    if (!a || !b) {
      try {
        db.prepare("UPDATE conflicts SET state='resolved', resolution='unknown', reason='两侧记忆都不在了', resolved_at=? WHERE id=? AND agent_id=?")
          .run(now(), c.id, aid)
        retired++
      } catch { /* 同上 */ }
      continue
    }
    let verdict = 'uncertain'
    let reason = 'no-model'
    try {
      if (typeof complete === 'function') {
        const r = await judgePair({ db, aid, oldRow: a, newerRow: b, complete, timeoutMs, via: 'nightly-pending' })
        verdict = r.verdict
        reason = r.reason || ''
      }
    } catch (e) {
      reason = 'error:' + String((e && e.message) || e).slice(0, 60)
    }
    // 旧条 = 出生更早的那条（judgePair 内部也按时间排，这里保持一致）
    const older = String(a.created_at || '') <= String(b.created_at || '') ? a : b
    const out = settleConflictByVerdict(db, aid, { cid: c.id, verdict, reason, oldId: older.id })
    if (out !== 'pending') settled++
  }
  return { checked: rows.length, settled, retired, skipped }
}

/** 冲突落库时顺手挂一条数据告警（同一句提示）。 */
export function openConflictAlert(db, aid, at = null) {
  db.prepare('INSERT INTO alerts VALUES(?,?,?,?,?,?,?)')
    .run(nid('alr_'), aid, 'data', 2, '有一条记忆冲突未处理', 'open', at || now())
}

/**
 * 同一对说法刚被另一条写入路径记过一次（典型的：addMemory 顺手记了张
 * 「低风险·自动结案」的卡，1 毫秒后门控又判成要开案）。
 *
 * 这张自动结案的卡从没问过人，它只是「同一对已被记过」。再开第二张，
 * 库里就会躺着「一开一关」两张卡——11-08 那对 get 冲突就是这么来的，
 * 而且后面排问句时，去重会误把那张死卡当成「问过了」。
 *
 * 所以这里不新开：把那张自动结案的翻成 open，身份不变，只用门控的判定覆盖。
 * 只看最近 windowMs；你亲手拍过板的结案不翻（那是决定，不是重复记录）。
 *
 * @returns {string|null} 复用/翻新的冲突 id；该新开一张时返回 null
 */
export function promoteAutoClosedConflict(db, aid, { aId, bId, windowMs = 300000, kind = 'polarity', evidence = null } = {}) {
  if (!aId || !bId) return null
  const since = new Date(Date.now() - Math.max(0, Number(windowMs) || 0)).toISOString()
  let row = null
  try {
    row = db.prepare(`SELECT id, state, resolution, opened_at FROM conflicts
      WHERE agent_id=? AND opened_at>=?
        AND ((a_id=? AND b_id=?) OR (a_id=? AND b_id=?))
      ORDER BY opened_at DESC LIMIT 1`).get(aid, since, aId, bId, bId, aId)
  } catch { return null }
  if (!row) return null
  if (row.state === 'open') return row.id
  if (String(row.resolution || '') !== 'superseded') return null
  try {
    db.prepare(`UPDATE conflicts SET state='open', resolution=NULL, reason=NULL, resolved_at=NULL,
      severity='high', kind=?, evidence=COALESCE(?,evidence), opened_at=?, escalation_level=0, escalated_at=NULL
      WHERE id=?`).run(kind, evidence, now(), row.id)
  } catch { return null }
  return row.id
}

export function listMemory(db, aid, includeDeleted = false) {
  agent(db, aid)
  const sql = "SELECT * FROM memory_items WHERE agent_id=?" + (includeDeleted ? '' : " AND status='active'") + ' ORDER BY created_at DESC LIMIT 100'
  // 面板上看到的热度按此刻现算（库里的是上次巡检的快照），写库不在这里做
  const at = Date.now()
  const rows = db.prepare(sql).all(aid)
  /* 出生那一刻的 feel：一次批量查（不 N+1），查记忆时旁边就带着。
     没有就 null——不拿最近的 feel 顶上，那是编。 */
  const feelMap = feelsByIds(db, rows.map((r) => r.feel_id))
  return rows.map((r) => {
    const row = nowRow(r, at)
    return { ...row, feel: r.feel_id ? (feelMap.get(r.feel_id) || null) : null }
  })
}

export function setMemoryMark(db, mid, body) {
  const m = db.prepare('SELECT * FROM memory_items WHERE id=?').get(mid)
  if (!m) err(404, 'NOT_FOUND', '记忆不存在')
  const mark = String(body.mark || '')
  if (!['normal', 'high', 'decay', 'locked'].includes(mark)) err(400, 'INVALID_ARGUMENT', 'mark 只能是 normal / high / decay / locked')
  db.prepare('UPDATE memory_items SET mark=?, version=version+1 WHERE id=?').run(mark, mid)
  return { id: mid, mark }
}

export function softDeleteAgent(db, aid) {
  agent(db, aid)
  db.prepare("UPDATE agents SET status='soft_deleted', deleted_at=? WHERE id=?").run(now(), aid)
  event(db, aid, 'agent.soft_deleted', { agent_id: aid })
  return { id: aid, status: 'soft_deleted', restorable_until: new Date(Date.now() + 7 * 86400000).toISOString() }
}

export function restoreAgent(db, aid) {
  const row = db.prepare('SELECT * FROM agents WHERE id=?').get(aid)
  if (!row) err(404, 'NOT_FOUND', 'agent 不存在')
  if (row.status !== 'soft_deleted') err(409, 'CONFLICT', '只有软删的意识体可以恢复')
  const t = row.deleted_at ? Date.parse(row.deleted_at) : Date.now()
  if (Date.now() - t > 7 * 86400000) err(410, 'GONE', '已超过 7 天恢复期')
  db.prepare("UPDATE agents SET status='active', deleted_at=NULL WHERE id=?").run(aid)
  return { id: aid, status: 'active' }
}

export function softDelete(db, mid) {
  const row = db.prepare('SELECT * FROM memory_items WHERE id=?').get(mid)
  if (!row) err(404, 'NOT_FOUND', '记忆不存在')
  // G1：软删 = HIDE；恢复 = UNHIDE。时光机靠这两条判断「那天看不看得见」
  hideMemory(db, row.agent_id, mid, { reason: 'user', actor: 'user' })
  return { id: mid, status: 'soft_deleted' }
}

export function restoreMemory(db, mid) {
  const row = db.prepare('SELECT * FROM memory_items WHERE id=?').get(mid)
  if (!row || row.status !== 'soft_deleted') err(404, 'NOT_FOUND', '没有可恢复的记忆')
  if (Date.now() - Date.parse(row.deleted_at) > 7 * 86400000) err(410, 'GONE', '恢复窗口已过')
  unhideMemory(db, row.agent_id, mid, { reason: 'user', actor: 'user' })
  return { id: mid, status: 'active' }
}

/** memory.decay.lambda（基准 0.02）→ 时间倍数：lambda 越大，R 掉得越快（倍数越小） */
function decayScaleOf(db, aid) {
  const lambda = Number(getParam(db, aid, 'memory.decay.lambda'))
  return Number.isFinite(lambda) && lambda > 0 ? Math.max(0.1, Math.min(10, 0.02 / lambda)) : 1
}

/** memory.recall.floor：可提取性低于它就不再召回；0 = 不设门槛 */
function recallFloorOf(db, aid) {
  const f = Number(getParam(db, aid, 'memory.recall.floor'))
  return Number.isFinite(f) ? Math.max(0, Math.min(0.9, f)) : 0
}

/** memory.inject.pool：每轮先取多少条候选再打分（10–200） */
function recallPoolOf(db, aid) {
  const n = Number(getParam(db, aid, 'memory.inject.pool'))
  return Number.isFinite(n) && n > 0 ? Math.max(10, Math.min(200, Math.round(n))) : 50
}

/**
 * 关系加成：每条记忆挂在谁名下、那个人现在多亲近（取最大亲近度）。
 * 只读 rel_evidence / rel_person；memory.recall.weights.relation = 0 时不查。
 */
function relationMapOf(db, aid) {
  try {
    const rows = db.prepare(`SELECT e.memory_id AS id, MAX(p.closeness) AS c
      FROM rel_evidence e JOIN rel_person p ON p.id = e.person_id
      WHERE e.agent_id=? AND e.memory_id IS NOT NULL
      GROUP BY e.memory_id`).all(aid)
    return new Map(rows.map((r) => [r.id, Number(r.c) || 0]))
  } catch { return null }
}

/**
 * 召回：走算法注册表（INV11）。
 * 默认版本来自实例绑定，否则实例参数 memory.recall.formula（须已登记）。
 * opt.mood（-1~+1）由调用方注入（affect.moodValenceOf）：记忆模块不直接读情绪表（INV10）。
 */
export function recall(db, aid, query, k = 8, budget = 512, opt = {}) {
  agent(db, aid)
  const fallback = String(getParam(db, aid, 'memory.recall.formula') || 'v2')
  const decayVersion = resolveVersion(aid, 'decay', String(getParam(db, aid, 'memory.decay.formula') || 'v1'))
  const relation = Math.max(0, Math.min(1, Number(getParam(db, aid, 'memory.recall.weights.relation')) || 0))
  const moodW = Math.max(0, Math.min(1, Number(getParam(db, aid, 'memory.recall.weights.mood')) || 0))
  const mood = Math.max(-1, Math.min(1, Number(opt.mood) || 0))
  return runBound('recall', aid, { db, aid }, {
    query, k, budget, decayVersion,
    decayScale: decayScaleOf(db, aid),
    floor: recallFloorOf(db, aid),
    pool: recallPoolOf(db, aid),
    relation,
    relMap: relation > 0 ? relationMapOf(db, aid) : null,
    mood: moodW > 0 ? mood : 0,
    moodW,
  }, fallback)
}

/** 指定版本或临时权重跑召回（影子 / 测试）；未登记版本会抛错 */
export function recallWithAlgo(db, aid, query, opt = {}) {
  agent(db, aid)
  const ver = opt.version || resolveVersion(aid, 'recall', String(getParam(db, aid, 'memory.recall.formula') || 'v2'))
  if (!algoHas('recall', ver)) err(409, 'ALGO_UNREGISTERED', '算法未登记：recall@' + ver, { name: 'recall', version: ver })
  const decayVersion = opt.decayVersion || resolveVersion(aid, 'decay', String(getParam(db, aid, 'memory.decay.formula') || 'v1'))
  return runAlgo('recall', ver, { db, aid }, {
    query, k: opt.k, budget: opt.budget, rel: opt.rel, retr: opt.retr, weight: opt.weight, decayVersion,
    decayScale: opt.decayScale != null ? Number(opt.decayScale) : decayScaleOf(db, aid),
    floor: opt.floor != null ? Number(opt.floor) : recallFloorOf(db, aid),
    // touch:false 必须透传：影子/测试要能在不改账本的前提下看召回结果。
    touch: opt.touch,
  })
}

export function listConflicts(db, aid) {
  agent(db, aid)
  const rows = db.prepare('SELECT * FROM conflicts WHERE agent_id=? ORDER BY rowid DESC').all(aid)
  const one = (id) => {
    try { return db.prepare('SELECT id,text,type,weight,invalid_at FROM memory_items WHERE id=?').get(id) || null } catch { return null }
  }
  return rows.map((c) => ({ ...c, a: one(c.a_id), b: one(c.b_id) }))
}

/** 处理冲突：keep=a 保留旧 / b 保留新 / both 两条都保留（判它理解错了时用，可带一句 reason） */
export function resolveConflict(db, aid, cid, body = {}) {
  agent(db, aid)
  const c = db.prepare('SELECT * FROM conflicts WHERE id=? AND agent_id=?').get(cid, aid)
  if (!c) err(404, 'NOT_FOUND', '冲突不存在')
  if (c.state !== 'open' && c.state !== 'pending') err(409, 'CONFLICT', '该冲突已经处理过')
  const keep = String(body.keep || '')
  if (!['a', 'b', 'both'].includes(keep)) err(400, 'INVALID_ARGUMENT', 'keep 只能是 a / b / both')
  const reason = body.reason == null ? null : String(body.reason).slice(0, 160)
  // G1：拍板也是一次「生效/作废」变更——复活记 REACTIVATE，再作废记 INVALIDATE，双方都记结案
  const inv = (id, on) => on
    ? invalidateMemory(db, aid, id, { reason: 'resolve', causeId: cid, actor: 'user' })
    : reactivateMemory(db, aid, id, { reason: 'resolve', causeId: cid, actor: 'user' })
  if (keep === 'a') { inv(c.a_id, false); inv(c.b_id, true) }
  else if (keep === 'b') { inv(c.a_id, true); inv(c.b_id, false) }
  else { inv(c.a_id, false); inv(c.b_id, false) }
  disputeClose(db, aid, [c.a_id, c.b_id], cid, { actor: 'user' })
  db.prepare("UPDATE conflicts SET state='resolved', resolution=?, reason=?, resolved_at=? WHERE id=?").run(keep, reason, now(), cid)
  try { db.prepare("UPDATE alerts SET state='resolved' WHERE agent_id=? AND kind='data' AND title LIKE '%冲突%' AND state='open'").run(aid) } catch { /* 老库没有告警表 */ }
  // 已经拍板了，就别再把「到底是哪个」的问句排着队发出去
  try { dropPendingByReason(db, aid, 'conflict:' + cid) } catch { /* 老库没有主动消息表 */ }
  event(db, aid, 'memory.conflict_resolved', { conflict_id: cid, keep, reason })
  return { id: cid, state: 'resolved', keep, reason }
}

/** query：活跃记忆（供影子/概览，禁止外域直读 memory_items） */
export function listActiveMemories(db, aid) {
  return db.prepare("SELECT * FROM memory_items WHERE agent_id=? AND status='active' AND invalid_at IS NULL").all(aid)
}

/**
 * 活跃条数。外域（开口证据门等）只许走这里，不许自己 COUNT memory_items。
 * since 有值时只数 created_at>=since 的。
 */
export function memoryCount(db, aid, since = null) {
  try {
    if (since) {
      const r = db.prepare("SELECT COUNT(*) n FROM memory_items WHERE agent_id=? AND status='active' AND invalid_at IS NULL AND created_at>=?").get(aid, since)
      return Number(r?.n || 0)
    }
    const r = db.prepare("SELECT COUNT(*) n FROM memory_items WHERE agent_id=? AND status='active' AND invalid_at IS NULL").get(aid)
    return Number(r?.n || 0)
  } catch { return 0 }
}

/** 按权重取前几条（开口生成用）。外域不许自己 SELECT memory_items。 */
export function listTopMemories(db, aid, limit = 6) {
  const n = Math.max(0, Math.min(50, Number(limit) || 0))
  try {
    return db.prepare("SELECT id,text FROM memory_items WHERE agent_id=? AND status='active' ORDER BY weight DESC LIMIT ?").all(aid, n)
  } catch { return [] }
}

export function memoryStats(db, aid) {
  const mem = db.prepare("SELECT COALESCE(SUM(LENGTH(text)/2),0) tok, COUNT(*) n FROM memory_items WHERE agent_id=? AND status='active' AND invalid_at IS NULL").get(aid)
  const conflicts = db.prepare("SELECT COUNT(*) n FROM conflicts WHERE agent_id=? AND state='open'").get(aid).n
  const last = db.prepare("SELECT id,text,type,created_at FROM memory_items WHERE agent_id=? AND status='active' AND invalid_at IS NULL ORDER BY created_at DESC LIMIT 1").get(aid) || null
  return { tokens: mem.tok, count: mem.n, open_conflicts: conflicts, last_memory: last }
}

/**
 * 词法兜底召回：FTS trigram 对两字以内的中文查询基本召不回，
 * 按二字词做 LIKE，保证「我喜欢什么」这类问句也能碰到记忆。
 */
export function softRecall(db, aid, text, k = 5) {
  const runs = String(text).replace(/[^\u4e00-\u9fa5a-zA-Z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean)
  const grams = new Set()
  for (const r of runs) {
    if (r.length <= 2) grams.add(r)
    else for (let i = 0; i + 2 <= r.length; i++) grams.add(r.slice(i, i + 2))
  }
  const out = []
  const seen = new Set()
  for (const g of [...grams].slice(0, 10)) {
    const rows = db.prepare(`SELECT id,text,weight FROM memory_items
      WHERE agent_id=? AND status='active' AND invalid_at IS NULL
        AND text NOT LIKE '%？' AND text NOT LIKE '%?'
        AND text LIKE ?
      ORDER BY CASE type WHEN 'fact' THEN 0 WHEN 'appraisal' THEN 1 ELSE 2 END, created_at DESC
      LIMIT ?`).all(aid, `%${g}%`, k)
    for (const r of rows) {
      if (seen.has(r.id)) continue
      seen.add(r.id)
      out.push({ id: r.id, text: r.text, score: Number(r.weight || 0.5) })
      if (out.length >= k) return { items: out, tokens: 0, count: out.length }
    }
  }
  if (!out.length && String(text).trim().length >= 4) {
    try { event(db, aid, 'memory.recall_miss', { text: String(text).slice(0, 80) }) } catch { /* 记号失败不影响召回 */ }
  }
  return { items: out, tokens: 0, count: out.length }
}

// ---------------- 冲突悬置的代价（6 号 R05 / 佛家：条件没解决，结论就还是悬的） ----------------

const CONFLICT_DAYS = 7

/**
 * R05：冲突超过 7 天未解 → 涉及的两条记忆权重 ×0.8（只罚一次）。
 * 已在 7 天内 resolve 的、以及还年轻的冲突不动；衰减留痕走 events（记忆域不写 changes）。
 */
export function tickConflicts(db, aid) {
  const cutoff = new Date(Date.now() - CONFLICT_DAYS * 86400000).toISOString()
  let rows = []
  try {
    rows = db.prepare(
      "SELECT * FROM conflicts WHERE agent_id=? AND state='open' AND penalized_at IS NULL AND opened_at IS NOT NULL AND opened_at <= ?",
    ).all(aid, cutoff)
  } catch {
    try {
      rows = db.prepare("SELECT * FROM conflicts WHERE agent_id=? AND state='open' AND penalized_at IS NULL").all(aid)
    } catch { rows = [] }
  }
  const out = []
  for (const c of rows) {
    const changed = []
    for (const mid of [c.a_id, c.b_id]) {
      const m = db.prepare('SELECT id,weight FROM memory_items WHERE id=? AND agent_id=?').get(mid, aid)
      if (!m) continue
      const before = Number(m.weight)
      const after = Math.max(0.05, +(before * 0.8).toFixed(3))
      if (after === before) continue
      db.prepare('UPDATE memory_items SET weight=?, version=version+1 WHERE id=?').run(after, mid)
      changed.push({ id: mid, before, after })
    }
    db.prepare('UPDATE conflicts SET penalized_at=? WHERE id=?').run(now(), c.id)
    if (changed.length) {
      try { event(db, aid, 'memory.conflict_decay', { conflict_id: c.id, changes: changed, rule: 'R05' }) } catch { /* 事件失败不影响衰减 */ }
      out.push({ conflict_id: c.id, changes: changed })
    }
  }
  return out
}