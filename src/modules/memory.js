import { journalIntent, journalDone, now } from '../db.js'
import { run as runAlgo, has as algoHas, runBound, resolveVersion } from '../algo/index.js'
import { err, nid, tx, agent, active, event, getParam } from '../kernel.js'
import { bandOf, heatOf, nowRow } from './tiers.js'
import { archiveFact } from './archive.js'
import { normalizeTerms } from './terms.js'
import { polarityFlip } from './gate.js'
import { scheduleEmbed } from './vector.js'
import { sourceBadge, sourceHint } from './memory_source.js'
import {
  logAdd, invalidateMemory, reactivateMemory, hideMemory, unhideMemory, disputeOpen, disputeClose,
} from './timeline.js'
export { normalizeTerms }

const SECRET = /(sk-[A-Za-z0-9]{8,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,})/g
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

/** U7：习惯 / 节律类断言——要稳进 T1，不能日子一久就只躺在日记里。 */
const HABIT_RE = /(每周|每天|每日|每晚|每早|每周[一二三四五六日天]|总是|经常|常常|习惯于|有个习惯|固定去|每周两次|每周一次)/

export function isHabitText(text) {
  return HABIT_RE.test(String(text || ''))
}

/** 习惯类重要度地板（调用方显式更高则保留）。 */
export function habitImportanceFloor(text, importance) {
  const base = Math.max(0, Math.min(1, Number(importance) || 0))
  if (!isHabitText(text)) return base
  return Math.max(base, 0.72)
}

/** 无 key 时给习惯一条稳定 fact_key，方便合并与冷层穿透识别。 */
export function habitFactKey(text, existing) {
  const cur = String(existing || '').trim()
  if (cur) return cur.slice(0, 120)
  if (!isHabitText(text)) return null
  const t = String(text || '')
  const tip = (t.match(/[\u4e00-\u9fff]{2,6}/) || ['habit'])[0]
  return ('habit.' + tip).slice(0, 120)
}
function sim(a, b) {
  const A = chars(a), B = chars(b)
  let inter = 0
  for (const c of A) if (B.has(c)) inter++
  return inter / Math.max(1, new Set([...A, ...B]).size)
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
  // 反思/经历是流水账，不承担事实断言，不参与冲突检测
  if (!CONFLICT_TYPES.has(typ)) return [null, null, null]
  const probe = coreText(text)
  if (!probe) return [null, null, null]
  const rows = db.prepare("SELECT * FROM memory_items WHERE agent_id=? AND status='active' AND invalid_at IS NULL ORDER BY created_at DESC LIMIT 200").all(aid)
  let hit = null
  for (const m of rows) {
    if (!CONFLICT_TYPES.has(m.type)) continue
    const other = coreText(m.text)
    const s = sim(probe, other)
    if (s >= 0.9) return ['duplicate', m, null]
    // 与写入门控同一套极性：看共享片段前有没有否定，避免「不加糖」整句 hasNeg 误判
    if (!hit && s >= 0.5 && polarityFlip(probe, other)) hit = { m, s }
  }
  if (!hit) return [null, null, null]
  const risky = IDENTITY.test(probe + ' ' + hit.m.text) || Number(hit.m.weight || 0) >= 0.8
  // 带上相似度，冲突留痕里要能回答「凭什么判成冲突」
  return ['conflict', { ...hit.m, sim: Number(hit.s.toFixed(3)) }, risky ? 'high' : 'low']
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
  for (const r of rows) invalidateMemory(db, aid, r.id, { at, supersededBy: mid, bumpVersion: true, reason: 'supersede' })
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
      invalidateMemory(db, aid, id, { at, supersededBy: mid, bumpVersion: true, agentScoped: true, reason: String(reason || 'merged') })
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
  // skipConflict：门控 applyWrite 已独占冲突判定与留痕，这里再跑会双行 conflicts / 双告警
  const [kind, old, risk] = body.skipConflict ? [null, null, null] : detectConflict(db, aid, safe, typ)
  if (kind === 'duplicate') {
    // 完全重复：不新建，也不写自环（旧代码写的是 from_id=to_id 的自环，等于没连）。
    return { id: old.id, duplicate: true }
  }
  const mid = nid('mem_')
  const rawImp = Math.max(0, Math.min(1, Number(body.importance ?? body.weight ?? 0.5) || 0.5))
  // U7：习惯类抬重要度地板（不碰日记事实源；只在落 T1 时加温）
  const importance = typ === 'fact' ? habitImportanceFloor(safe, rawImp) : rawImp
  const salience = Math.max(0, Math.min(1, Number(body.salience ?? 0) || 0))
  /* 出生时的情绪效价：调用方给了就用给的（对话里就是这一下的愉悦），
     没给就是 0（中性）——记忆模块不直接读情绪表（INV10），要加成由调用方注入。 */
  const valence = Math.max(-1, Math.min(1, body.valence != null ? Number(body.valence) || 0 : 0))
  const terms = normalizeTerms(body.terms)
  const factKey = typ === 'fact'
    ? habitFactKey(safe, body.fact_key || body.key)
    : (String(body.fact_key || body.key || '').trim().slice(0, 120) || null)
  const searchText = buildSearchText(safe, factKey, terms)
  const seq = journalIntent(db, aid, 'insert_memory', { memory_id: mid }, body.turn_id)
  let superseded = []
  const bornAt = now()
  tx(db, () => {
    db.prepare(`INSERT INTO memory_items(id,agent_id,type,mark,text,source,w0,weight,stability,difficulty,
        last_decay_at,valid_at,invalid_at,status,created_at,deleted_at,version)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(mid, aid, typ, 'normal', safe, String(body.source || 'manual').slice(0, 24), 0.5, 0.5, 1.0, 5.0,
        now(), null, null, 'active', now(), null, 1)
    // 分层账本：重要度 / 情绪显著度 / 来源轮次；热度先按默认算一遍
    // 检索卡：fact_key + terms + search_text（写进 FTS 的是 search_text，不是原文）
    db.prepare('UPDATE memory_items SET importance=?, salience=?, valence=?, confidence=?, source_turn_id=?, entity_id=?, fact_key=?, terms=?, search_text=? WHERE id=?')
      .run(importance, salience, valence, body.confidence != null ? Number(body.confidence) : 0.8, body.turn_id || null,
        body.entity_id || null, factKey, terms.length ? terms.join(' ') : null, searchText, mid)
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
    // T4 事实存根：这条事实「出生时」长什么样，永远留一份（只追加，之后衰减/推翻/合并都不动它）
    let payload = body.payload
    if (payload && typeof payload === 'string') {
      try { payload = JSON.parse(payload) } catch { payload = { raw: String(payload).slice(0, 200) } }
    }
    let birthRef = null
    try {
      birthRef = archiveFact(db, aid, {
        memory_id: mid, text: safe, type: typ, mark: 'normal',
        importance, salience, confidence: body.confidence != null ? Number(body.confidence) : 0.8,
        fact_key: factKey, source_turn_id: body.turn_id || null,
        source: body.source || 'model',
        payload: payload && typeof payload === 'object' ? payload : null,
      }).id
    } catch {
      try { event(db, aid, 'memory.archive_failed', { memory_id: mid }) } catch { /* 连事件都失败就只剩写入 */ }
    }
    // 时效索引：出生事件先记，取代链的「新事实说话时刻 = 旧事实失效时刻」要查它
    logAdd(db, aid, mid, {
      at: bornAt, validAt: body.valid_at || null, sourceTurnId: body.turn_id || null,
      episodeId: payload && typeof payload === 'object' ? payload.episode_id : null,
      textRef: birthRef, actor: String(body.source || 'manual').slice(0, 24),
    })
    // 事实失效：同一个 fact_key 的旧说法当场退场（不删，只标记被谁取代）
    superseded = supersedeByKey(db, aid, mid, factKey, typ)
    event(db, aid, 'memory.written', { memory_id: mid })
    if (kind === 'conflict') {
      const cid = nid('cfl_')
      // P3：把判定依据一起存下来，半年后还能回答「当时凭什么判成冲突」
      const evidence = JSON.stringify({
        similarity: old.sim != null ? Number(old.sim) : null,
        a_text: String(old.text || '').slice(0, 120),
        b_text: safe.slice(0, 120),
        risk, type: typ,
      })
      if (risk === 'low') {
        // 低风险：两条都保留，不算“待处理”
        db.prepare(`INSERT INTO conflicts(id,agent_id,a_id,b_id,state,resolution,reason,resolved_at,opened_at,
            severity,kind,source_turn_id,evidence) VALUES(?,?,?,?, 'resolved', 'superseded', ?, ?, ?, 'low','polarity',?,?)`)
          .run(cid, aid, old.id, mid, '模板相似/否定词差异，两条都保留', now(), now(), body.turn_id || null, evidence)
        event(db, aid, 'memory.conflict_superseded', { conflict_id: cid, a: old.id, b: mid })
      } else {
        invalidateMemory(db, aid, old.id, { reason: 'conflict', causeId: mid })
        db.prepare(`INSERT INTO conflicts(id,agent_id,a_id,b_id,state,opened_at,severity,kind,source_turn_id,evidence)
          VALUES(?,?,?,?, 'open', ?, 'high','polarity',?,?)`)
          .run(cid, aid, old.id, mid, now(), body.turn_id || null, evidence)
        disputeOpen(db, aid, [old.id, mid], cid)
        event(db, aid, 'memory.conflict', { conflict_id: cid, a: old.id, b: mid })
        db.prepare('INSERT INTO alerts VALUES(?,?,?,?,?,?,?)')
          .run(nid('alr_'), aid, 'data', 2, '有一条记忆冲突未处理', 'open', now())
      }
    }
  })
  journalDone(db, seq)
  // 向量通道：有 embedding 时异步补一条；失败静默（INV10：本文件不写 memory_vec SQL）
  try { scheduleEmbed(db, aid, mid, safe) } catch { /* ignore */ }
  return { id: mid, conflict: kind === 'conflict' && risk === 'high', superseded: kind === 'conflict' && risk === 'low', superseded_ids: superseded }
}

export function listMemory(db, aid, includeDeleted = false) {
  agent(db, aid)
  const sql = "SELECT * FROM memory_items WHERE agent_id=?" + (includeDeleted ? '' : " AND status='active'") + ' ORDER BY created_at DESC LIMIT 100'
  // 面板上看到的热度按此刻现算（库里的是上次巡检的快照），写库不在这里做
  const at = Date.now()
  return db.prepare(sql).all(aid).map((r) => {
    const row = nowRow(r, at)
    const badge = sourceBadge(row.source)
    const hint = sourceHint(row)
    return { ...row, source_badge: badge.label, source_tone: badge.tone, source_hint: hint }
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
  // 先摘掉软删标成 paused；真正变 active 由调用方走排他激活（避免多 active）
  db.prepare("UPDATE agents SET status='paused', deleted_at=NULL WHERE id=?").run(aid)
  return { id: aid, status: 'paused', needs_activate: true }
}

export function softDelete(db, mid) {
  const row = db.prepare('SELECT * FROM memory_items WHERE id=?').get(mid)
  if (!row) err(404, 'NOT_FOUND', '记忆不存在')
  hideMemory(db, row.agent_id, mid)
  return { id: mid, status: 'soft_deleted' }
}

export function restoreMemory(db, mid) {
  const row = db.prepare('SELECT * FROM memory_items WHERE id=?').get(mid)
  if (!row || row.status !== 'soft_deleted') err(404, 'NOT_FOUND', '没有可恢复的记忆')
  if (Date.now() - Date.parse(row.deleted_at) > 7 * 86400000) err(410, 'GONE', '恢复窗口已过')
  unhideMemory(db, row.agent_id, mid)
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

/** 处理冲突：keep=a 保留旧 / b 保留新 / both 两条都保留 */
export function resolveConflict(db, aid, cid, body = {}) {
  agent(db, aid)
  const c = db.prepare('SELECT * FROM conflicts WHERE id=? AND agent_id=?').get(cid, aid)
  if (!c) err(404, 'NOT_FOUND', '冲突不存在')
  if (c.state !== 'open') err(409, 'CONFLICT', '该冲突已经处理过')
  const keep = String(body.keep || '')
  if (!['a', 'b', 'both'].includes(keep)) err(400, 'INVALID_ARGUMENT', 'keep 只能是 a / b / both')
  // 时效索引里「冲突期间谁作废过」照留：复活记 REACTIVATE，不靠清空 invalid_at 抹历史
  const at = now()
  const inv = (id, on) => (on
    ? invalidateMemory(db, aid, id, { at, reason: 'resolve', causeId: cid })
    : reactivateMemory(db, aid, id, { at, reason: 'resolve', causeId: cid }))
  if (keep === 'a') { inv(c.a_id, false); inv(c.b_id, true) }
  else if (keep === 'b') { inv(c.a_id, true); inv(c.b_id, false) }
  else { inv(c.a_id, false); inv(c.b_id, false) }
  db.prepare("UPDATE conflicts SET state='resolved', resolution=?, resolved_at=? WHERE id=?").run(keep, at, cid)
  disputeClose(db, aid, [c.a_id, c.b_id], cid, { at })
  try { db.prepare("UPDATE alerts SET state='resolved' WHERE agent_id=? AND kind='data' AND title LIKE '%冲突%' AND state='open'").run(aid) } catch { /* 老库没有告警表 */ }
  event(db, aid, 'memory.conflict_resolved', { conflict_id: cid, keep })
  return { id: cid, state: 'resolved', keep }
}

/** query：活跃记忆（供影子/概览，禁止外域直读 memory_items） */
export function listActiveMemories(db, aid) {
  return db.prepare("SELECT * FROM memory_items WHERE agent_id=? AND status='active' AND invalid_at IS NULL").all(aid)
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