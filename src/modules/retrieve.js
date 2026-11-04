/**
 * P1a 检索骨架：场景路由 → 分区内证据门 → RRF 融合
 *
 * 三件事各管一段，互不越界：
 *   路由   决定「这次问的是哪一类」：S1 每轮 / S2 回看 / S3 深检索
 *   证据门 决定「这条够不够格进来」，只看相关度 E，不看热度（两门分离）
 *   RRF    决定「进来之后谁排前面」，只混名次、不混原始分
 *
 * 现在的 E 是词法版：max(FTS 词价, 2-gram 覆盖率)。
 * 向量与实体两路留给 P1b 的混合检索，接口不变（evidenceOf 里加一路即可）。
 */

import { recentRounds } from './buffer.js'
import { searchRaw, searchFactArchive } from './archive.js'
import { normalizeName } from './entities.js'
import { vectorize, cosine } from './fingerprint.js'
import { retrievability } from './tiers.js'
import { run as registryRun, has as registryHas } from '../algo/registry.js'
import { normalizeTerms } from './terms.js'

/** 证据门：每个场景的准入线（E 的尺度，0~1）。 */
export const GATE = { S1: 0.35, S2: 0.30, S3: 0.20 }

/** S1 门控前最高分低于这个值 → 自动升级深检索。 */
export const S1_UPGRADE = 0.25

export const RRF_K = 60

/** 场景权重：谁优先。没列的分区在这个场景里不挂载。 */
export const SCENE_WEIGHTS = {
  S1: { T1: 1.0, T3: 0.6 },           // P4 起日记挂进每轮召回：权重 0.6，排在事实之后
  S2: { T2: 1.0, T4: 0.7 },
  S3: { T1: 1, T2: 1, T3: 1, T4: 1 },
}

const S2_RE = /(上次|上回|之前|那天|前面聊过|接着上次|还记得|以前说)/
const S3_RE = /(想不起来|是不是说过|有没有提过|记不记得|到底说过)/

// ---------------------------------------------------------------- 路由

/** 规则关键词表；分类器不可用时的退化路径也是它。 */
export function routeScene(query) {
  const q = String(query || '')
  if (S3_RE.test(q)) return { scene: 'S3', why: '关键词：深检索' }
  if (S2_RE.test(q)) return { scene: 'S2', why: '关键词：回看' }
  return { scene: 'S1', why: '默认' }
}

// ---------------------------------------------------------------- 证据分

/** 虚词：含这些字的 2-gram 不进分母（「这只」「了没」这类不算证据）。 */
const STOP_CHAR = new Set([
  ...'的了是我你他她它们在这那有个吗呢吧啊就都也还和与要会能可很太更最把被让给从对向已经过嘛呀哦嗯一不没等只',
])

function grams(text, n = 2) {
  const out = new Set()
  const runs = String(text || '').match(/[\u4e00-\u9fff]+|[a-zA-Z0-9]{2,}/g) || []
  for (const run of runs) {
    if (/^[a-zA-Z0-9]+$/.test(run)) { out.add(run.toLowerCase()); continue }
    for (let i = 0; i + n <= run.length; i++) out.add(run.slice(i, i + n))
  }
  return out
}

/** 只留有实义的 gram：任一字符是虚词就丢掉。 */
function contentGrams(text, n = 2) {
  return [...grams(text, n)].filter((g) => ![...g].some((c) => STOP_CHAR.has(c)))
}

/**
 * 查询的实义 n-gram 有多大比例出现在正文里（0~1）。
 * 分母只数实义 gram：否则「这只」「了没」会把一句很短的有效查询稀释成 0.25。
 */
export function overlap(query, text, n = 2) {
  const A = contentGrams(query, n)
  const B = grams(text, n)
  if (!A.length || !B.size) return 0
  let hit = 0
  for (const g of A) if (B.has(g)) hit++
  return hit / A.length
}

/** 场景触发词：它们只用来「认场景」，不参与检索——否则「你上次说的那个检索骨架」里
 *  一半的 gram 是「上次 / 说的 / 那个」，把真正的关键词淹没掉。 */
const SCENE_NOISE = /(上次|上回|之前|那天|前面聊过|接着上次|还记得|以前说|想不起来|是不是说过|有没有提过|记不记得|到底说过|说的|那个|这个)/g

/** 去掉场景触发词，剩下的才是真查询。全被去掉时退回原文。 */
export function stripSceneWords(query) {
  const q = String(query || '')
    .replace(SCENE_NOISE, ' ')
    .replace(/^[你我他她它]\s+/u, '') // 「你 检索骨架」：被挖空后剩下的孤立主语
    .replace(/\s+/g, ' ')
    .trim()
  return q || String(query || '').trim()
}

/** 指纹路：同一轮里 query 只算一次向量，候选逐条算（单条 <0.1ms）。 */
let _qCache = { q: null, v: null }
function queryVector(q) {
  if (_qCache.q !== q) _qCache = { q, v: vectorize(q) }
  return _qCache.v
}

/**
 * 3-gram 确认：查询能切出 3-gram 时，正文里一个都没重合，说明只是零散二字巧合。
 * 典型：「库没上去」被拆成「上去」，于是命中「没更新上去」——三字连着看根本不成立。
 * 返回 true/false；查询太短切不出 3-gram 时返回 null（不改判）。
 */
function confirm3(query, text) {
  const A = grams(query, 3)
  if (!A.size) return null
  const B = grams(text, 3)
  for (const g of A) if (B.has(g)) return true
  return false
}

/** 证据分 E：max(FTS 词价, 2-gram 覆盖率, 指纹余弦)。实体路再补一档。 */
export function evidenceOf(item, query) {
  const fts = Number(item.fts || 0)
  const raw = overlap(query, item.text, 2)
  const ok3 = confirm3(query, item.text)
  // 3-gram 对不上：2-gram 的重合打三折，FTS 的整词命中同样不可信（分词器会把词拆碎）
  const lex = ok3 === false ? raw * 0.3 : raw
  // 一个实义词都撞不上时，FTS 命中多半来自「是不是 / 后来」这类套话——打折，别让它冒充证据
  const ftsE = ok3 === false ? fts * 0.2 : (raw > 0 ? fts : fts * 0.4)
  let e = Math.min(1, Math.max(ftsE, lex))
  // 指纹：字面有交集但说法不同 / 长短不对称时补一档；纯同义（喝啥 vs 咖啡）它不懂，交给 expand.js
  try {
    e = Math.max(e, cosine(queryVector(query), vectorize(item.text)) * 0.6)
  } catch { /* 指纹失败不影响词法分 */ }
  e = Math.min(1, Math.round(e * 1e4) / 1e4)
  // 实体路：查询里点名了这个实体，这条记忆就挂在它名下——字面不重合也算证据。
  // 0.55 是经验值：高于 S1 门（0.35），低于字面完全命中（1.0），排序上仍让字面重合的靠前。
  if (item.via === 'entity' && item.entity && String(query || '').includes(item.entity)) {
    e = Math.max(e, 0.55)
  }
  // 图扩散：邻居实体同一批事，但没直接提到——给一档较低的证据（二跳再打折，见 expandByLinks）
  if (item.via === 'link') e = Math.max(e, Number(item._linkE) > 0 ? Number(item._linkE) : 0.45)
  // 检索卡：写入时让模型留的同义词 / 别名。查询里出现了卡片上的词，说明这条记的就是它。
  // 取「哪个词最能解释这句查询」：term 的实义 gram 有多少落在查询里，再乘 0.85，
  // 保证原文逐字命中（1.0）永远压过同义命中，排序不会被卡片带偏。
  if (item.terms) {
    let best = 0
    for (const t of String(item.terms).split(/\s+/)) {
      if (!t) continue
      const o = overlap(t, query, 2)
      if (o > best) best = o
    }
    if (best > 0) e = Math.max(e, best * 0.85)
  }
  // 扩词通道：这条是被模型给的检索词捞上来的。一个词 ≈ 0.49、两个 ≈ 0.60，压不过逐字命中。
  if (Number(item._termE) > 0) e = Math.max(e, Number(item._termE))
  // 向量通道：余弦已经折算成证据分，直接参与 max。
  if (Number(item._vecE) > 0) e = Math.max(e, Number(item._vecE))
  return Math.min(1, Math.round(e * 1e4) / 1e4)
}

// ---------------------------------------------------------------- 分区检索

/** 老库可能还没有 temp_state 列：查一次缓存住，别每条 SQL 都赌它存在。 */
const TEMP_COL = new Map()
function hasTempCol(db) {
  const key = db
  if (TEMP_COL.has(key)) return TEMP_COL.get(key)
  let ok = false
  try { ok = db.prepare('PRAGMA table_info(memory_items)').all().some((c) => c.name === 'temp_state') } catch { ok = false }
  TEMP_COL.set(key, ok)
  return ok
}

/** 检索卡列同样是增量迁移：只读打开老库（评测脚本）时可能还没有。 */
const CARD_COL = new Map()
function hasCardCol(db) {
  const key = db
  if (CARD_COL.has(key)) return CARD_COL.get(key)
  let ok = false
  try { ok = db.prepare('PRAGMA table_info(memory_items)').all().some((c) => c.name === 'terms') } catch { ok = false }
  CARD_COL.set(key, ok)
  return ok
}

/** 事实失效列（P2）：老库没有就当成「没有失效机制」，一切照旧。 */
const SUP_COL = new Map()
function hasSupCol(db) {
  const key = db
  if (SUP_COL.has(key)) return SUP_COL.get(key)
  let ok = false
  try { ok = db.prepare('PRAGMA table_info(memory_items)').all().some((c) => c.name === 'superseded_by') } catch { ok = false }
  SUP_COL.set(key, ok)
  return ok
}

/**
 * T1 召回。includeCold=false 时排除 cold / archived —— 这就是「遗忘区只影响 S1」的落点，
 * S2 回看、S3 深查传 true，照样捞得到。
 */
export function searchFacts(db, aid, query, opt = {}) {
  const q = String(query || '').trim()
  if (!q) return []
  const found = new Map()
  const coldFilter = (opt.includeCold || !hasTempCol(db)) ? '' : " AND (m.temp_state IS NULL OR m.temp_state IN ('hot','warm'))"
  const coldFilterBare = (opt.includeCold || !hasTempCol(db)) ? '' : " AND (temp_state IS NULL OR temp_state IN ('hot','warm'))"
  const terms = [...grams(q, 3)].slice(0, 12)
  const cardCols = hasCardCol(db) ? ', m.terms, m.fact_key' : ''
  // 事实失效（P2）：S1 不带旧说法，S2/S3（回看、深查）带，但标 stale 让它排在后面。
  const supOn = hasSupCol(db)
  const supCols = supOn ? ', m.invalid_at, m.superseded_by' : ''
  const supFilter = (opt.includeSuperseded || !supOn) ? '' : ' AND m.invalid_at IS NULL'
  const supFilterBare = (opt.includeSuperseded || !supOn) ? '' : ' AND invalid_at IS NULL'
  if (terms.length) {
    try {
      const fts = terms.map((t) => '"' + t.replace(/"/g, '""') + '"').join(' OR ')
      const rows = db.prepare(`SELECT m.id, m.text, m.type, m.band, m.mark, m.created_at,
          m.last_decay_at, m.stability, m.valence, m.heat, m.source, m.confidence${cardCols}${supCols}, bm25(memory_fts) AS rank
        FROM memory_fts JOIN memory_items m ON m.id=memory_fts.id
        WHERE memory_fts MATCH ? AND m.agent_id=? AND m.status='active'${supFilter}${coldFilter}
        ORDER BY rank LIMIT 50`).all(fts, aid)
      for (const r of rows) {
        found.set(r.id, { ...r, fts: 1 / (1 + Math.max(0, -Number(r.rank || 0))) })
      }
    } catch { /* 回退到 LIKE */ }
  }
  // trigram 对两字查询基本召不回，按 2-gram LIKE 兜底；有检索卡时连卡片一起匹配——
  // 否则「忌口」这种两字同义词永远进不了候选（trigram 要三个字才生效）。
  const byCard = hasCardCol(db)
  for (const g of [...grams(q, 2)].slice(0, 8)) {
    const like = '%' + g + '%'
    const rows = byCard
      ? db.prepare(`SELECT id,text,type,band,mark,created_at,heat,last_decay_at,stability,valence,source,confidence,terms,fact_key${supOn ? ',invalid_at,superseded_by' : ''} FROM memory_items
        WHERE agent_id=? AND status='active'${supFilterBare} AND (text LIKE ? OR terms LIKE ?)${coldFilterBare} LIMIT 20`).all(aid, like, like)
      : db.prepare(`SELECT id,text,type,band,mark,created_at,heat,last_decay_at,stability,valence,source,confidence${supOn ? ',invalid_at,superseded_by' : ''} FROM memory_items
        WHERE agent_id=? AND status='active'${supFilterBare} AND text LIKE ?${coldFilterBare} LIMIT 20`).all(aid, like)
    for (const r of rows) if (!found.has(r.id)) found.set(r.id, { ...r, fts: 0 })
  }
  return [...found.values()].map((r) => ({
    partition: 'T1', id: r.id, text: String(r.text || ''), ...r, fts: Number(r.fts || 0),
    stale: !!r.invalid_at,
  }))
}

// ---------------------------------------------------------------- 实体路

/**
 * 查询里点到的已知实体。长名优先（「记忆仓库」先于「记忆」），最多 5 个。
 * 名字短于 2 字的不收，否则「猫」「好」这种会把整库都认成同一个实体。
 */
export function entitiesInQuery(db, aid, query) {
  const src = String(query || '')
  if (!src) return []
  const out = []
  try {
    const rows = db.prepare('SELECT id,name,aliases FROM entities WHERE agent_id=? ORDER BY LENGTH(name) DESC LIMIT 300').all(aid)
    for (const r of rows) {
      if (!r.name || r.name.length < 2) continue
      if (src.includes(r.name)) { out.push(r); continue }
      let list = []
      try { list = JSON.parse(r.aliases || '[]') } catch { list = [] }
      if (Array.isArray(list) && list.some((a) => a && src.includes(normalizeName(a)))) out.push(r)
      if (out.length >= 5) break
    }
  } catch { /* 老库没有实体表时按没有实体处理 */ }
  return out.slice(0, 5)
}

/**
 * 围着实体找：这条记忆挂在实体名下，就算字面一个词都不重合也算相关。
 * 这是「小周」→「他喜欢篮球」唯一的入口——字面检索永远接不上。
 */
export function searchByEntity(db, aid, query, opt = {}) {
  const ents = entitiesInQuery(db, aid, query)
  if (!ents.length) return []
  const coldFilter = (opt.includeCold || !hasTempCol(db)) ? '' : " AND (m.temp_state IS NULL OR m.temp_state IN ('hot','warm'))"
  const supOn = hasSupCol(db)
  const supFilter = (opt.includeSuperseded || !supOn) ? '' : ' AND m.invalid_at IS NULL'
  const supCols = supOn ? ', m.invalid_at, m.superseded_by' : ''
  const out = []
  const seen = new Set()
  for (const e of ents) {
    try {
      const rows = db.prepare(`SELECT m.id,m.text,m.type,m.band,m.mark,m.created_at,m.heat,m.last_decay_at,m.stability,m.valence,m.source,m.confidence${supCols} FROM memory_items m
        WHERE m.agent_id=? AND m.entity_id=? AND m.status='active'${supFilter}${coldFilter}
        ORDER BY m.heat DESC, m.created_at DESC LIMIT 15`).all(aid, e.id)
      for (const r of rows) {
        if (seen.has(r.id)) continue
        seen.add(r.id)
        out.push({ partition: 'T1', id: r.id, via: 'entity', entity: e.name, text: String(r.text || ''), stale: !!r.invalid_at, ...r, fts: 0 })
      }
    } catch { /* 单个实体失败不影响其余 */ }
  }
  return out
}

/**
 * 扩词通道：模型给的检索词各自去库里捞一遍。
 *
 * 为什么不拼成 `q + ' ' + terms`：overlap 的分母是查询的实义 gram 数，
 * 塞进去的每个词都会把分母撑大；只要扩展词没在这条记忆里全中，E 反而更低，
 * 原本刚过门的候选会被挤出门外。所以扩展必须单独成路、单独算分、按 max 合并。
 *
 * 打分：命中词数 / 总词数的平方根 × 0.85 —— 一个词约 0.49、两个约 0.60，
 * 单靠它也能过 S1 门，但永远低于逐字命中（1.0）。
 */
export function searchByTerms(db, aid, terms, opt = {}) {
  const list = normalizeTerms(terms, 8)
  if (!list.length) return []
  const coldFilter = (opt.includeCold || !hasTempCol(db)) ? '' : " AND (temp_state IS NULL OR temp_state IN ('hot','warm'))"
  const card = hasCardCol(db)
  const hits = new Map()
  for (const term of list) {
    try {
      const like = '%' + term + '%'
      const rows = card
        ? db.prepare(`SELECT id,text,type,band,mark,created_at,heat,last_decay_at,stability,valence,source,confidence,terms,fact_key
          FROM memory_items WHERE agent_id=? AND status='active' AND invalid_at IS NULL
            AND (text LIKE ? OR terms LIKE ?)${coldFilter}
          ORDER BY heat DESC, created_at DESC LIMIT 15`).all(aid, like, like)
        : db.prepare(`SELECT id,text,type,band,mark,created_at,heat,last_decay_at,stability,valence,source,confidence
          FROM memory_items WHERE agent_id=? AND status='active' AND invalid_at IS NULL
            AND text LIKE ?${coldFilter}
          ORDER BY heat DESC, created_at DESC LIMIT 15`).all(aid, like)
      for (const r of rows) {
        const rec = hits.get(r.id) || { row: r, viaTerms: new Set() }
        rec.viaTerms.add(term)
        hits.set(r.id, rec)
      }
    } catch { /* 单个词失败不影响其余 */ }
  }
  const out = []
  for (const [id, rec] of hits) {
    // 覆盖率按「正文或检索卡里真出现了几个词」算，不按「被几个词捞到」算。
    let covered = 0
    for (const t of list) if (String(rec.row.text || '').includes(t) || String(rec.row.terms || '').includes(t)) covered++
    const e = Math.round(0.85 * Math.sqrt(covered / list.length) * 1e4) / 1e4
    out.push({
      partition: 'T1', id, via: 'term', text: String(rec.row.text || ''),
      ...rec.row, fts: 0, _termE: e, matched: [...rec.viaTerms],
    })
  }
  return out.sort((a, b) => b._termE - a._termE).slice(0, 30)
}

// ---------------------------------------------------------------- 向量通道

/** 每实例一份归一化向量缓存：写入向量后 30 秒内自动失效，够用且不用写失效逻辑。 */
const VEC_CACHE = new Map()
const VEC_TTL = 30 * 1000

function toF32(blob) {
  try {
    if (blob instanceof Float32Array) return blob
    // 调用方可以直接给数组（测试 / 预取），也可以给数据库里的 BLOB 字节。
    if (Array.isArray(blob)) return Float32Array.from(blob.map((x) => Number(x) || 0))
    if (ArrayBuffer.isView(blob) && !(blob instanceof Uint8Array)) {
      const f = new Float32Array(blob.length)
      for (let i = 0; i < blob.length; i++) f[i] = Number(blob[i]) || 0
      return f
    }
    const u8 = blob instanceof Uint8Array ? blob : new Uint8Array(blob)
    const ab = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength)
    return new Float32Array(ab)
  } catch { return null }
}

/** 读某个实例的全部记忆向量（只读已存的，不在检索里调模型）。 */
export function loadVectors(db, aid) {
  const key = aid
  const hit = VEC_CACHE.get(key)
  if (hit && Date.now() - hit.at < VEC_TTL) return hit.list
  const list = []
  try {
    const rows = db.prepare(`SELECT v.memory_id, v.vec, m.text, m.type, m.source, m.confidence, m.created_at
      FROM memory_vec v JOIN memory_items m ON m.id=v.memory_id
      WHERE v.agent_id=? AND m.status='active' AND m.invalid_at IS NULL`).all(aid)
    for (const r of rows) {
      const v = toF32(r.vec)
      if (!v || !v.length) continue
      let norm = 0
      for (let i = 0; i < v.length; i++) norm += v[i] * v[i]
      norm = Math.sqrt(norm) || 1
      for (let i = 0; i < v.length; i++) v[i] /= norm
      list.push({ id: r.memory_id, text: String(r.text || ''), type: r.type, source: r.source, confidence: r.confidence, created_at: r.created_at, vec: v })
    }
  } catch { /* 老库没有 memory_vec 就当归零 */ }
  VEC_CACHE.set(key, { at: Date.now(), list })
  return list
}

export function clearVectorCache() { VEC_CACHE.clear() }

/**
 * 向量召回：查询向量由调用方算好传进来（预取），这里只做同步余弦。
 * 余弦 0.5 ≈ 证据 0.36（刚过 S1 门），0.7 ≈ 0.66，0.9 ≈ 0.95。
 */
export function searchByVector(db, aid, queryVec, opt = {}) {
  const q = toF32(queryVec)
  if (!q || !q.length) return []
  let qn = 0
  for (let i = 0; i < q.length; i++) qn += q[i] * q[i]
  qn = Math.sqrt(qn) || 1
  const limit = Math.max(1, Math.min(50, Number(opt.limit) || 20))
  const out = []
  for (const row of loadVectors(db, aid)) {
    if (row.vec.length !== q.length) continue
    let dot = 0
    for (let i = 0; i < q.length; i++) dot += q[i] * row.vec[i]
    const cos = dot / qn
    if (cos < 0.35) continue
    const e = Math.round(Math.min(0.95, Math.max(0, (cos - 0.25) / 0.65)) * 0.95 * 1e4) / 1e4
    out.push({ partition: 'T1', id: row.id, via: 'vec', text: row.text, type: row.type, source: row.source, confidence: row.confidence, created_at: row.created_at, fts: 0, _vecE: e, cos: Math.round(cos * 1e4) / 1e4 })
  }
  return out.sort((a, b) => b._vecE - a._vecE).slice(0, limit)
}

/**
 * 图扩散（HippoRAG 的简化版）：已召回的记忆，把「同实体」邻居也捞上来。
 *
 * 一跳：分 0.45（高于 S1 门 0.35，但压不过字面命中）；
 * 二跳：分 0.45 × decay（默认 0.65 ≈ 0.29），只有 S2/S3 放宽门槛时才用得上——
 * S1 那 0.29 过不了 0.35 的绝对门，等于自动关掉，不会往每轮注入里塞远亲。
 *
 * opt.hops 1–3，opt.decay 0.2–1；每跳只往前推「这一跳新发现」的节点，避免来回绕。
 */
export function expandByLinks(db, aid, items, opt = {}) {
  const ids = [...new Set((items || []).filter((x) => x.partition === 'T1' && x.id).map((x) => x.id))]
  if (!ids.length) return []
  const hops = Math.max(1, Math.min(3, Number(opt.hops) || 1))
  const decay = Math.max(0.2, Math.min(1, Number(opt.decay) || 0.65))
  const base = Math.max(0, Math.min(1, Number(opt.strength) || 0.45))
  const limit = Math.max(1, Math.min(30, Number(opt.limit) || 8))
  const coldFilter = (opt.includeCold || !hasTempCol(db)) ? '' : " AND (m.temp_state IS NULL OR m.temp_state IN ('hot','warm'))"
  const seen = new Set(ids)
  const out = []
  let frontier = ids
  for (let hop = 1; hop <= hops; hop++) {
    if (!frontier.length || out.length >= limit) break
    const ph = frontier.map(() => '?').join(',')
    let rows = []
    try {
      rows = db.prepare(`SELECT DISTINCT m.id,m.text,m.type,m.band,m.mark,m.created_at,m.heat,m.last_decay_at,m.stability,m.source,m.confidence
        FROM memory_links l JOIN memory_items m ON m.id = l.to_id
        WHERE l.from_id IN (${ph}) AND m.agent_id=? AND m.status='active' AND m.invalid_at IS NULL${coldFilter}
        ORDER BY m.heat DESC LIMIT ?`).all(...frontier, aid, limit * 2)
    } catch { break }
    const fresh = []
    for (const r of rows) {
      if (seen.has(r.id)) continue
      seen.add(r.id)
      fresh.push(r)
      out.push({
        partition: 'T1', id: r.id, via: 'link', hop, text: String(r.text || ''),
        _linkE: Math.round(base * Math.pow(decay, hop - 1) * 1e4) / 1e4, ...r, fts: 0,
      })
      if (out.length >= limit) break
    }
    frontier = fresh.map((r) => r.id)
  }
  return out.sort((a, b) => Number(b._linkE || 0) - Number(a._linkE || 0))
}

export function searchEpisodes(db, aid, query) {
  const q = String(query || '').trim()
  if (!q) return []
  const found = new Map()
  for (const g of [...grams(q, 2)].slice(0, 8)) {
    const rows = db.prepare(`SELECT id,day,title,summary,topics,open_loops FROM episodes
      WHERE agent_id=? AND (title LIKE ? OR summary LIKE ? OR topics LIKE ?)
      ORDER BY day DESC LIMIT 20`).all(aid, `%${g}%`, `%${g}%`, `%${g}%`)
    for (const r of rows) if (!found.has(r.id)) found.set(r.id, r)
  }
  return [...found.values()].map((r) => ({
    partition: 'T2', id: r.id,
    text: [r.day, r.title, r.summary].filter(Boolean).join(' · ').slice(0, 400),
    day: r.day,
  }))
}

export function searchDiaries(db, aid, query, days = 60) {
  const q = String(query || '').trim()
  if (!q) return []
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10)
  const found = new Map()
  for (const g of [...grams(q, 2)].slice(0, 8)) {
    const rows = db.prepare(`SELECT id,day,text FROM diaries WHERE agent_id=? AND day>=? AND text LIKE ?
      ORDER BY day DESC LIMIT 10`).all(aid, since, `%${g}%`)
    for (const r of rows) if (!found.has(r.id)) found.set(r.id, r)
  }
  return [...found.values()].map((r) => ({ partition: 'T3', id: r.id, text: String(r.text || '').slice(0, 600), day: r.day }))
}

/**
 * T4 冷层：对话原文（raw_turns）+ 事实存根（fact_archive）。
 *
 * 事实存根是「这条事实出生时的原样」，跟抽屉里那条通常同文——同文时交给
 * pack.dedupe 按优先级留 T1，不重复占预算。它有增量的场合只有一个：抽屉那条
 * 已经被推翻 / 衰减 / 软删，T1 召不回来，这里是唯一还能翻到的地方。
 *
 * 台阶（S3 深查，别的库都想不起来）：先翻小账本——213 条短事实比 1070 轮原文
 * 好命中，有一条过门就不查原文，省一次扫描。S2 回看仍两路并查：「那天我们聊的」
 * 要的是原文的场景感，不能被一句存根挡掉。
 *
 * 每条都先算好 e，方便「过没过门」当场判断；scoreAll 之后会再算一遍同值，无副作用。
 */
export function searchArchive(db, aid, query, opt = {}) {
  const q = String(query || '').trim()
  const scene = opt.scene || 'S3'
  const gate = Number(GATE[scene] || GATE.S1)
  const factFirst = opt.factFirst != null ? !!opt.factFirst : scene === 'S3'

  const facts = []
  try {
    for (const f of (searchFactArchive(db, aid, q, 8) || [])) {
      const item = {
        partition: 'T4', id: f.id, via: 'fact', memory_id: f.memory_id || null,
        text: String(f.text || '').replace(/\s+/g, ' ').slice(0, 120),
        created_at: f.created_at,
      }
      item.e = Math.round(evidenceOf(item, q) * 1e4) / 1e4
      facts.push(item)
    }
  } catch { /* 存根查询失败就当没有 */ }

  // 先小账本：有一条存根过门，就不再翻原文
  if (factFirst && facts.some((x) => x.e >= gate)) {
    return facts.filter((x) => x.e >= gate)
  }

  const out = []
  let rows = []
  try { rows = searchRaw(db, aid, q, 12, opt.since ? { since: opt.since } : {}) } catch { rows = [] }
  for (const r of (rows || [])) {
    out.push({
      partition: 'T4', id: r.id, via: 'raw',
      text: String(r.text || '').replace(/\s+/g, ' ').slice(0, 120),
      role: r.role, created_at: r.created_at,
    })
  }
  return out.concat(facts)
}

// ---------------------------------------------------------------- 配额浮现

/**
 * 重要度锚点：不管这句话在问什么，这几条都该被想起（身份 / 承诺 / 边界）。
 * 它不过证据门——「今天天气不错」永远召不回「你答应周末修脚本」，
 * 但「答应」这件事不该因此消失。
 *
 * 只认「钉住的」和「事实 / 冲突」：线上真实库里 reflection 有一大半是每日摘要，
 * importance 被顶到 0.95 也是流水账；让它们占锚点位，等于每轮都把摘要复读一遍。
 *
 * B3 轮转：以前取的是「importance 最高的那两条」，集合恒定，于是每轮都在复读同两句。
 * 现在第一个名额仍然给最重的那条（身份 / 承诺该稳），其余名额在候选池里挑
 * **最久没被想起**的——last_hit_at 由 touch() 在召回时拨新，所以轮转不需要新表、
 * 也不需要新状态，自己就会转起来。
 */
export function importanceAnchors(db, aid, opt = {}) {
  const limit = Math.max(1, Math.min(5, Number(opt.limit) || 2))
  const floor = Math.max(0, Math.min(1, Number(opt.floor ?? 0.7)))
  // 候选池：名额的 3 倍（至少 4 条），够轮、又不至于把冷门货翻上来
  const pool = Math.max(limit, Math.min(12, limit * 3, limit + 6))
  try {
    const rows = db.prepare(`SELECT id,text,type,band,mark,created_at,last_hit_at,heat,last_decay_at,stability,valence,importance,source,confidence
      FROM memory_items WHERE agent_id=? AND status='active' AND invalid_at IS NULL
        AND importance>=? AND (mark='locked' OR type IN ('fact','conflict'))
      ORDER BY (mark='locked') DESC, importance DESC, heat DESC, created_at DESC LIMIT ?`)
      .all(aid, floor, pool)
      .map((r) => ({ partition: 'T1', via: 'anchor', e: 0, ...r, text: String(r.text || '') }))
    if (rows.length <= limit) return rows
    const stamp = (r) => Date.parse(r.last_hit_at || r.created_at || '') || 0
    const [head, ...rest] = rows
    rest.sort((a, b) => (stamp(a) - stamp(b)) || String(a.id).localeCompare(String(b.id)))
    return [head, ...rest].slice(0, limit)
  } catch { return [] }
}

/** 24 小时内的新近：今天刚发生的事，不靠相关性也该被想起来。摘要不算「今天发生的」。 */
export function freshFacts(db, aid, opt = {}) {
  const limit = Math.max(1, Math.min(5, Number(opt.limit) || 2))
  const hours = Math.max(1, Math.min(24 * 30, Number(opt.hours) || 24))
  const since = new Date(Date.now() - hours * 3600000).toISOString()
  // 冷层不进「今天刚发生」：旁白闸判下来的第三人称转述也落冷层，
  // 不挡的话它们会从这个后门重新回到注入里。
  const cold = (opt.includeCold || !hasTempCol(db)) ? '' : " AND (temp_state IS NULL OR temp_state IN ('hot','warm'))"
  try {
    return db.prepare(`SELECT id,text,type,band,mark,created_at,heat,last_decay_at,stability,valence,importance,source,confidence
      FROM memory_items WHERE agent_id=? AND status='active' AND invalid_at IS NULL AND created_at>=?
        AND type<>'reflection'${cold}
      ORDER BY created_at DESC LIMIT ?`)
      .all(aid, since, limit)
      .map((r) => ({ partition: 'T1', via: 'fresh', e: 0, ...r, text: String(r.text || '') }))
  } catch { return [] }
}

/** 跨分区去重用的「是不是同一句话」：只在配额补位时用，不引 pack 以免反向依赖。 */
function sameText(a, b) {
  const n = (x) => String(x || '').replace(/[\s\p{P}]/gu, '')
  return n(a) === n(b)
}

/** 给已选的相关条目补上配额位；总数不超过 k。 */
export function addQuotaItems(items, extra, k) {
  const out = [...items]
  for (const x of extra) {
    if (out.length >= k) break
    if (out.some((y) => y.id === x.id || sameText(y.text, x.text))) continue
    out.push(x)
  }
  return out
}

// ---------------------------------------------------------------- 融合

/**
 * 类型权重（P4）：事实比自省更该占注入名额。
 * 只在「排先后」时乘上去，不动 e——门控（GATE）看的还是证据本身，
 * 否则 0.5 分的自省 ×0.55 = 0.275 会被直接挡在门外，等于删记忆。
 */
export const TYPE_WEIGHT = { fact: 1, conflict: 1, episode: 0.9, appraisal: 0.8, reflection: 0.75 }

/**
 * RRF：score = Σ w_p / (k + rank_p)。只混名次，不混原始分——
 * 否则 T2 的百分比分和 T1 的 bm25 词价会直接打架。
 */
export function fuseRRF(per, weights, k = RRF_K) {
  const score = new Map()
  const byKey = new Map()
  for (const [part, arr] of Object.entries(per || {})) {
    const w = Number((weights || {})[part] || 0)
    if (!w || !arr || !arr.length) continue
    const ranked = [...arr].sort((a, b) => (Number(b.e) * Number(b.tw || 1)) - (Number(a.e) * Number(a.tw || 1)))
    ranked.forEach((item, i) => {
      const key = part + ':' + item.id
      score.set(key, (score.get(key) || 0) + w / (k + i + 1))
      if (!byKey.has(key)) byKey.set(key, item)
    })
  }
  return [...score.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([key, s]) => ({ ...byKey.get(key), rrf: Math.round(s * 1e6) / 1e6 }))
}

/**
 * 融合之后的重排：RRF 只按证据分名次混，对「想起来过几次」一无所知。
 * 这里用乘法微调（不动量纲）：证据接近的两条，热度高、可提取性高的排前面。
 * 为什么乘法：rrf 的量级是 1/60，加法要一个很小的常数、还不能解释；乘法天然按比例放大。
 */
export function rerank(items, opt = {}) {
  const heatW = Number.isFinite(Number(opt.heat)) ? Number(opt.heat) : 0.35
  const recW = Number.isFinite(Number(opt.recency)) ? Number(opt.recency) : 0.25
  // 她自己的事：48 小时内算「还热」，不然刚写的也挤不过陈年旧事。
  const selfBoost = Math.max(0, Math.min(1, Number(opt.selfFreshBoost == null ? 0.5 : opt.selfFreshBoost)))
  return (items || []).map((x) => {
    let h = Math.max(0, Math.min(1, Number(x.heat || 0)))
    if (selfBoost > 0 && String(x.source || '') === 'self') {
      const t = Date.parse(x.created_at || '')
      if (Number.isFinite(t) && Date.now() - t < 48 * 3600000) h = Math.max(h, selfBoost)
    }
    const R = x.partition === 'T1' ? retrievability(x) : 1
    const mul = 1 + heatW * h + recW * (R - 0.5)
    return { ...x, _score: Math.round(x.rrf * mul * 1e6) / 1e6 }
  }).sort((a, b) => b._score - a._score || b.e - a.e)
}

/**
 * MMR：最大边际相关 —— 6 条里不要三条说同一件事。
 * score = λ·rel − (1−λ)·max(已有条目的相似度)，相似度用指纹向量算。
 * λ=0.75：相关性为主，重复度只做惩罚，不会为了多样把不相关的塞进来。
 */
export function mmrSelect(items, k, lambda = 0.75) {
  const list = [...(items || [])]
  if (list.length <= k) return list
  const vecs = list.map((x) => vectorize(x.text || ''))
  const top = Math.max(...list.map((x) => Number(x._score || x.rrf || x.e || 0))) || 1
  const picked = []
  while (picked.length < k && list.length) {
    let best = 0
    let bestScore = -Infinity
    for (let i = 0; i < list.length; i++) {
      const rel = Math.max(0, Number(list[i]._score || list[i].rrf || list[i].e || 0)) / top
      let sim = 0
      for (const p of picked) sim = Math.max(sim, cosine(vecs[i], p.vec))
      const s = lambda * rel - (1 - lambda) * sim
      if (s > bestScore) { bestScore = s; best = i }
    }
    const item = list.splice(best, 1)[0]
    picked.push({ ...item, vec: vecs.splice(best, 1)[0] })
  }
  return picked.map(({ vec, ...rest }) => rest)
}

/**
 * 打分：evidence 是字面/实体证据分；关系加成由调用方算好 relMap 传进来
 * （memory.recall.weights.relation → opt.relation），不在这里读库，保持纯函数。
 */
function scoreAll(lists, query, opt = {}) {
  const relW = Math.max(0, Math.min(1, Number(opt.relation) || 0))
  const relMap = opt.relMap instanceof Map ? opt.relMap : null
  const typeW = opt.typeWeights === false ? null : TYPE_WEIGHT
  /* 心情一致加成（mood-congruent recall）：心情与记忆出生效价同号 → 加分。
     mood / moodW 由调用方注入（affect.moodValenceOf），这里不读库。 */
  const mood = Math.max(-1, Math.min(1, Number(opt.mood) || 0))
  const moodW = Math.max(0, Math.min(1, Number(opt.moodW) || 0))
  const out = {}
  for (const [part, arr] of Object.entries(lists || {})) {
    out[part] = (arr || []).map((x) => {
      const bonus = relMap && relW ? relW * (relMap.get(x.id) || 0) : 0
      const valence = Math.max(-1, Math.min(1, Number(x.valence) || 0))
      const moodBonus = moodW && mood ? moodW * mood * valence : 0
      // 被取代的旧说法：只在回看时露脸，且分数打七折——新说法永远排在它前面。
      const staleCut = x.stale ? 0.7 : 1
      // tw 只用来排先后（fuseRRF 里乘），不进 e，免得把低权类型直接挡在门外。
      const tw = typeW ? (typeW[x.type] != null ? typeW[x.type] : 1) : 1
      return { ...x, tw, e: Math.round((evidenceOf(x, query) * staleCut + bonus + moodBonus) * 1e4) / 1e4 }
    })
  }
  return out
}

function maxEvidence(scored) {
  let top = 0
  for (const arr of Object.values(scored)) for (const x of arr) if (x.e > top) top = x.e
  return top
}

/**
 * 她自己的事（P2）：召回结果里一条都没有时，硬补 1 条。
 *
 * 为什么必须硬补：用户条目 1200+ 条、自我条目几十条，同分竞争下自我条目永远挤不进前 6。
 * 先按字面相关，再按新鲜；没有就给最近的，别给「三个月前的一条」。
 */
export function selfCandidates(db, aid, query, want = 1, opt = {}) {
  const n = Math.max(1, Math.min(3, Number(want) || 1))
  try {
    const rows = db.prepare(`SELECT id,text,type,band,mark,created_at,last_decay_at,stability,valence,importance,heat,source,confidence,fact_key
      FROM memory_items WHERE agent_id=? AND status='active' AND invalid_at IS NULL
        AND source IN ('self','life')
      ORDER BY created_at DESC LIMIT 24`).all(aid)
    if (!rows.length) return []
    const target = stripSceneWords(String(query || ''))
    const isPattern = (r) => String(r.fact_key || '').startsWith('self.pattern.')
    const scored = rows.map((r) => ({ ...r, e: evidenceOf(r, target) }))
    // 模式排在流水账前面：那是「我是谁」的结论，不该跟「今天干了啥」抢同一次露脸。
    scored.sort((a, b) => (Number(isPattern(b)) - Number(isPattern(a)))
      || (Number(b.e) - Number(a.e))
      || (Date.parse(b.created_at || '') - Date.parse(a.created_at || '')))
    // 防祥林嫂：最近露太多次的先让开；一条都不剩时挑露得最少的兜底（不能一条不给）。
    const shown = opt.selfShown instanceof Map ? opt.selfShown : null
    const cap = Math.max(0, Math.min(10, Number(opt.selfRepeatMax) || 0))
    let ranked = scored
    if (shown && cap > 0) {
      const under = scored.filter((r) => (shown.get(String(r.id)) || 0) < cap)
      ranked = under.length
        ? under
        : [...scored].sort((a, b) => (shown.get(String(a.id)) || 0) - (shown.get(String(b.id)) || 0))
    }
    return ranked.slice(0, n).map((r) => ({ partition: 'T1', via: 'self', text: String(r.text || ''), ...r, fts: 0 }))
  } catch { return [] }
}

/**
 * 「我好像就是这样」的那一层（第二阶段 P1）：只取模式条目，按见过的次数和重要度排。
 * 它不进证据门：模式是结论，本来就不会跟某一句查询字面重合。
 */
export function patternCandidates(db, aid, want = 1) {
  const n = Math.max(1, Math.min(2, Number(want) || 1))
  try {
    return db.prepare(`SELECT id, text, type, confidence, importance, created_at, source, fact_key
      FROM memory_items WHERE agent_id=? AND status='active' AND invalid_at IS NULL
        AND source='self' AND fact_key LIKE 'self.pattern.%'
      ORDER BY importance DESC, created_at DESC LIMIT ?`).all(aid, n).map((r) => ({
      partition: 'T1', via: 'pattern', text: String(r.text || ''), ...r, e: 0.55, rrf: 0.02,
    }))
  } catch { return [] }
}

/**
 * 历史第三人称旁白（source='summary'）要不要进常规注入（P0）。
 * 默认 off：那 789 条「用户正在…」不往提示里塞，但仍在库里，回看 / 深查照样翻得到。
 * 开关在调用方读（index.js / api.js）；retrieve 不碰 agent_params，保持纯检索层。
 */
const dropSummary = (list) => (list || []).filter((x) => String(x.source || '') !== 'summary')


function collect(db, aid, query, scene, opt = {}) {
  const w = SCENE_WEIGHTS[scene] || SCENE_WEIGHTS.S1
  const out = {}
  // 遗忘区只挡 S1：回看与深查要能穿透到 cold / archived
  if (w.T1) {
    const includeCold = scene !== 'S1'
    // 旧说法（被新说法取代的）只在回看/深查时带出来：S1 不能同时想起两个版本。
    const includeSuperseded = scene !== 'S1'
    // 两条路并进 T1：先按实体圈出这个人名下的事，再按字面兜底；同 id 只留一次。
    const byEntity = searchByEntity(db, aid, query, { includeCold, includeSuperseded })
    const byLex = searchFacts(db, aid, query, { includeCold, includeSuperseded })
    const byId = new Map(byEntity.map((x) => [x.id, x]))
    for (const x of byLex) if (!byId.has(x.id)) byId.set(x.id, x)
    // 补充通道（可选）：模型扩词、向量。同 id 只把对应那一路的分补上，不覆盖已有候选。
    const absorb = (list, field) => {
      for (const t of list || []) {
        const old = byId.get(t.id)
        if (!old) { byId.set(t.id, t); continue }
        const score = Math.max(Number(old[field] || 0), Number(t[field] || 0))
        if (score > 0) byId.set(t.id, { ...old, [field]: score, terms: old.terms || t.terms })
      }
    }
    if (Array.isArray(opt.terms) && opt.terms.length) absorb(searchByTerms(db, aid, opt.terms, { includeCold }), '_termE')
    if (opt.queryVec) absorb(searchByVector(db, aid, opt.queryVec, { limit: 20 }), '_vecE')
    out.T1 = [...byId.values()]
    // S1 不塞历史旁白：它们是「用户关心什么」的转述，不是「我记得的事」。
    if (scene === 'S1' && !opt.summaryInjected) out.T1 = dropSummary(out.T1)
  }
  if (w.T2) out.T2 = searchEpisodes(db, aid, query)
  if (w.T3) out.T3 = searchDiaries(db, aid, query)
  if (w.T4) {
    // 原文层分龄（P4）：默认只翻最近 N 天；查询里明说要翻旧账就放开。
    // 目的不是省空间，是别让三个月前的一句原话被当成现状讲出来。
    // 注意：翻旧账的判断要用「原句」——stripSceneWords 会把「很久以前」这类词先洗掉。
    const askOld = opt.oldAccount != null ? !!opt.oldAccount : oldAccountQuery(query)
    const days = askOld ? 0 : Math.max(0, Math.min(3650, Number(opt.archiveDays) || 0))
    const since = days > 0 ? new Date(Date.now() - days * 86400000).toISOString() : null
    // 工具查询（keepAll）要原话，就跳过「先小账本」的短路，别被一条事实存根挡住。
    out.T4 = searchArchive(db, aid, query, { scene, since, factFirst: opt.keepAll ? false : undefined })
  }
  return out
}

/** collect + 一跳图扩散：已召回的 T1 记忆，把「同实体」的邻居一并带上。 */
function collectAll(db, aid, query, scene, opt = {}) {
  const lists = collect(db, aid, query, scene, opt)
  if (lists.T1 && lists.T1.length) {
    const seen = new Set(lists.T1.map((x) => x.id))
    // S1 只走一跳（二跳那 0.29 过不了绝对门，白算）；回看/深查才按参数放二跳。
    const hops = scene === 'S1' ? 1 : Math.max(1, Math.min(3, Number(opt.linkHops) || 2))
    const extra = expandByLinks(db, aid, lists.T1, {
      includeCold: scene !== 'S1',
      hops,
      decay: opt.linkDecay,
      strength: opt.linkStrength,
    }).filter((x) => !seen.has(x.id))
    if (extra.length) lists.T1 = lists.T1.concat(extra)
    if (scene === 'S1' && !opt.summaryInjected) lists.T1 = dropSummary(lists.T1)
  }
  // 候选池：memory.inject.pool。不传就不动（测试/旧调用保持原样），传了才截断。
  // 截断前必须先按证据分排序：直接 slice 是按「通道插入顺序」砍的，向量/扩词补进来的
  // 高相关条目排在最后，池子一小就被砍掉——评测里 gold 排向量榜第 1 却进不了候选就是这么来的。
  const pool = opt.pool == null ? 0 : Math.max(10, Math.min(200, Number(opt.pool) || 0))
  if (pool) {
    for (const part of Object.keys(lists)) {
      const arr = lists[part]
      if (!arr || arr.length <= pool) continue
      lists[part] = arr
        .map((x) => ({ x, e: evidenceOf(x, query) }))
        .sort((a, b) => b.e - a.e)
        .slice(0, pool)
        .map((r) => r.x)
    }
  }
  return lists
}

/** 指代词：出现它们时，单看这一句不可能找回上下文。 */
const PRONOUN_RE = /(那个|这个|它|他|她|上面|刚才|前面|那件|这事|这事儿|那个库|那个页面|那个插件)/

/** 「翻旧账」：这句查询本身在要很久以前的东西，原文层就别只翻最近 N 天。 */
const OLD_ACCOUNT_RE = /(最早|最开始|一开始|最初|很久以前|好早|老早|以前那|当时|那天|当年|第一天|从头|历史)/

/** 「我去翻翻」：这句在问记不记得，值得往深里翻一次。 */
const DEEP_RE = /(记得|还记不记得|忘没忘|你忘了|以前|那时候|上次说|翻旧账|想不起来|不记得)/

export function wantsDeep(query) {
  return DEEP_RE.test(String(query || ''))
}

/**
 * 深翻一次（第二阶段 P2）：常规注入一条都没有、或她在问「记不记得」时，
 * 往纪要 / 日记 / 原文老账里翻一遍。结果带 via='deep'，注入时会被标注成「刚翻出来的」。
 * 不在这里读参数：开关由调用方判断，这层只做检索。
 */
export function deepRecall(db, aid, q, opt = {}) {
  const k = Math.max(1, Math.min(5, Number(opt.k) || 3))
  try {
    const r = retrieve(db, aid, q, {
      scene: 'S3', k: Math.max(6, k + 3), noUpgrade: true, archiveDays: 0, keepAll: false,
    })
    // 优先翻纪要 / 日记 / 原文（T2/T3/T4），不够再用 T1 兜底：
    // 冷掉的事实本身也在 T1，只翻非 T1 会把它漏掉。
    const all = r.items || []
    const pool = all.filter((x) => x.partition !== 'T1')
    const rest = all.filter((x) => x.partition === 'T1')
    return pool.concat(rest).slice(0, k).map((x) => ({ ...x, via: 'deep' }))
  } catch { return [] }
}

export function oldAccountQuery(query) {
  return OLD_ACCOUNT_RE.test(String(query || ''))
}

/**
 * 指代消解（轻量版）：这句话里有指代词，就和上一句用户话拼起来当查询。
 * 不做真正的共指消解（那要模型），但「那个库 → 上句说的 app.db」这一档，
 * 拼接就够用了，而且零成本。
 */
export function contextualQuery(prev, cur) {
  const q = String(cur || '').trim()
  if (!q) return ''
  if (!PRONOUN_RE.test(q) || !prev) return q
  const p = String(prev || '').trim()
  if (!p) return q
  return p.slice(-60) + ' ' + q
}

/**
 * 一次检索：给场景、给带证据分的候选、给融合结果。
 * @param {{scene?:string, k?:number, noUpgrade?:boolean}} [opt]
 */
export function retrieve(db, aid, query, opt = {}) {
  const q = String(query || '').trim()
  const auto = routeScene(q)
  let scene = opt.scene || auto.scene
  const why = [auto.why]
  const k = Math.max(1, Math.min(50, Number(opt.k) || 6))
  const buffer = recentRounds(aid, 2)
  if (!q) {
    // 空查询（「嗯」「好」）：没有相关度可算，但配额位照样该翻出来——
    // 这就是「我没问你，你自己想起来」在空话轮里的版本。
    const on = opt.float !== false && !opt.keepAll
    const na = on ? Math.max(0, Math.min(3, Number(opt.anchor == null ? 1 : opt.anchor))) : 0
    const nf = on ? Math.max(0, Math.min(3, Number(opt.fresh == null ? 1 : opt.fresh))) : 0
    const extra = []
    if (na) extra.push(...importanceAnchors(db, aid, { limit: na + 1, floor: opt.anchorFloor }))
    if (nf) extra.push(...freshFacts(db, aid, { limit: nf + 1, hours: opt.freshHours }))
    // 她自己的事：空话轮也该有一条「我自己的」，不然「没问你就想不起来」永远是空话。
    const wantSelf0 = on ? Math.max(0, Math.min(2, Number(opt.selfQuota == null ? 1 : opt.selfQuota))) : 0
    if (wantSelf0) extra.push(...selfCandidates(db, aid, '', wantSelf0 + 1, opt))
    // 「我好像就是这样」：空话轮里也该有一句关于我是谁的话。
    const wantPat0 = on ? Math.max(0, Math.min(1, Number(opt.patternQuota == null ? 1 : opt.patternQuota))) : 0
    if (wantPat0) extra.push(...patternCandidates(db, aid, 1))
    return {
      scene, why: why.concat('空查询'), buffer,
      items: addQuotaItems([], extra, k),
      debug: { scene, gate: GATE[scene], counts: {}, kept: {} },
    }
  }

  // 检索用的是「去掉触发词」的查询；场景判定与解释仍用原句
  const qs = stripSceneWords(q)
  // 翻旧账要看原句（触发词可能刚被 stripSceneWords 洗掉）
  const optQ = opt.oldAccount != null ? opt : { ...opt, oldAccount: oldAccountQuery(q) }
  let scored = scoreAll(collectAll(db, aid, qs, scene, optQ), qs, optQ)
  // S1 兜底：门控前最高分太低、或一条都过不了门 → 升级深检索（放宽门槛 + 全分区）
  // 记住「是被自动升级的」：这种情况恰恰是「这句话什么都没命中」，
  // 更要靠配额位把重要的东西翻出来，否则最该浮现的轮次反而什么都没有。
  let upgraded = false
  if (scene === 'S1' && !opt.noUpgrade) {
    const top = maxEvidence(scored)
    const keptS1 = Object.values(scored).reduce((n, arr) => n + arr.filter((x) => x.e >= GATE.S1).length, 0)
    if (top < S1_UPGRADE || keptS1 === 0) {
      why.push(top < S1_UPGRADE ? `S1 最高分 ${top.toFixed(2)} < ${S1_UPGRADE} → 升级 S3` : 'S1 召回区为空 → 升级 S3')
      scene = 'S3'
      upgraded = true
      scored = scoreAll(collectAll(db, aid, qs, scene, opt), qs, opt)
    }
  }

  const gate = (lists) => {
    const kept = {}
    // keepAll（检索工具）：门槛压到 0.05，只要沾边就交回去——工具是「我要查」，
    // 由调用方自己判断要不要用，不该由注入用的绝对门替它筛掉。
    const gateVal = opt.keepAll ? 0.05 : GATE[scene]
    const debug = { scene, gate: gateVal, counts: {}, kept: {}, top: 0 }
    for (const [part, arr] of Object.entries(lists)) {
      debug.counts[part] = arr.length
      kept[part] = arr.filter((x) => x.e >= gateVal)
      debug.kept[part] = kept[part].length
    }
    debug.top = maxEvidence(lists)
    return { kept, debug }
  }
  let { kept, debug } = gate(scored)
  // S2 兜底：纪要 + 原文一条都没过门 → 说明「回看」找不到，改走深检索（放宽 + 全分区）
  if (scene === 'S2' && !opt.noUpgrade && Object.values(kept).every((arr) => arr.length === 0)) {
    why.push('S2 无命中 → 升级 S3')
    scene = 'S3'
    ;({ kept, debug } = gate(scoreAll(collectAll(db, aid, qs, scene, opt), qs, opt)))
  }

  const fused = fuseRRF(kept, SCENE_WEIGHTS[scene], RRF_K)
  // 遗忘阈值对 v3 路径同样生效：T1 事实的可提取性低于门槛就不再被想起。
  // 参数由调用方传进来（opt.floor / decayVersion / decayScale），这里不读库。
  const floor = Math.max(0, Math.min(0.9, Number(opt.floor) || 0))
  let items = fused
  if (floor > 0 && opt.decayVersion && registryHas('decay', opt.decayVersion)) {
    items = fused.filter((it) => {
      if (it.partition !== 'T1') return true
      try {
        const R = Number(registryRun('decay', opt.decayVersion, {}, { row: it, scale: opt.decayScale }).R)
        return !Number.isFinite(R) || R >= floor
      } catch { return true }
    })
  }
  // 配额：相关度照旧，但给「重要度锚点」「24h 新近」各留一个名额。
  // 只给每轮注入用；工具查询 keepAll 要的是原样结果，不掺配额。
  // 自动升级到 S3 的轮次也算「每轮注入」——那正是这句话什么都没命中的时候，
  // 最需要把重要、新近的东西翻出来。
  const floatOn = opt.float !== false && !opt.keepAll && (scene === 'S1' || upgraded)
  const wantAnchor = floatOn ? Math.max(0, Math.min(3, Number(opt.anchor == null ? 1 : opt.anchor))) : 0
  const wantFresh = floatOn ? Math.max(0, Math.min(3, Number(opt.fresh == null ? 1 : opt.fresh))) : 0
  const relatedK = Math.max(1, k - wantAnchor - wantFresh)
  // 顺序：融合 → 忘掉该忘的 → 按「熟不熟」重排 → 挑不重复的 → 截 k。
  items = mmrSelect(rerank(items, { selfFreshBoost: opt.selfFreshBoost }), relatedK)
  // 相对门槛：只留跟最高分接近的。绝对门（GATE）只挡「完全无关」，
  // 挡不住「沾到一点边就全进来」——6 条凑满反而把真正相关的那条冲淡。
  // 实体点名（via=entity）例外：字面不重合也是真相关。
  const topE = items.reduce((m, it) => Math.max(m, Number(it.e) || 0), 0)
  // opt.keepAll：给「检索工具」用。注入要的是「只留最相关的几条」，工具要的是「我要查的那层都给我」，
  // 否则一查原文，最高分那条记忆一压，原文就被相对门筛掉了。
  if (topE > 0 && !opt.keepAll) {
    items = items.filter((it) => (Number(it.e) || 0) >= topE * 0.7 || it.via === 'entity' || it.via === 'term' || it.via === 'vec'
      // 一跳邻居（同实体）是真相关，值得留；二跳只在高分邻居不够时才靠相对门放进来。
      || (it.via === 'link' && Number(it.hop || 1) <= 1))
  }
  // 上限回到 k：硬砍 4 条会把第 5、6 条本来能想起的记忆一起扔掉。
  if (items.length > relatedK) items = items.slice(0, relatedK)
  // 补配额位：锚点与今日新近。它们不过证据门，所以放在相对门之后才不会被筛掉。
  if (floatOn && (wantAnchor || wantFresh)) {
    let extra = []
    if (wantAnchor) extra.push(...importanceAnchors(db, aid, { limit: wantAnchor + 1, floor: opt.anchorFloor }))
    if (wantFresh) extra.push(...freshFacts(db, aid, { limit: wantFresh + 1, hours: opt.freshHours }))
    // 遗忘阈值对配额位同样生效。配额是「补漏」，不是「把已经忘掉的重新捞回来」的后门：
    // 阈值调到 0.8 时，一条 R 已经归零的旧记忆不该借 via='fresh' 回来。
    if (floor > 0 && opt.decayVersion && registryHas('decay', opt.decayVersion)) {
      extra = extra.filter((it) => {
        if (it.partition !== 'T1') return true
        try {
          const R = Number(registryRun('decay', opt.decayVersion, {}, { row: it, scale: opt.decayScale }).R)
          return !Number.isFinite(R) || R >= floor
        } catch { return true }
      })
    }
    items = addQuotaItems(items, extra, k)
  }
  // 她自己的事（P2）：一条都没有时硬补 1 条（k>=8 时最多 2 条）。
  // 不抢已有名额，只在「这次全是你的事」时补一条「我自己的」；紧预算（<4 条）不补。
  const wantSelf = floatOn ? Math.max(0, Math.min(2, Number(opt.selfQuota == null ? 1 : opt.selfQuota))) : 0
  if (wantSelf) {
    const hasSelf = items.some((x) => x.source === 'self' || x.source === 'life')
    const need = items.length >= 4 ? (k >= 8 ? Math.min(2, wantSelf) : Math.min(1, wantSelf)) : 0
    if (!hasSelf && need > 0) {
      const cap = Math.min(k + need, items.length + need)
      items = addQuotaItems(items, selfCandidates(db, aid, qs, need + 1, opt), cap)
    }
  }
  // 模式位（P1）：一句「我好像就是这样」单独留一格，不跟流水账抢名额。
  const wantPattern = floatOn ? Math.max(0, Math.min(2, Number(opt.patternQuota == null ? 1 : opt.patternQuota))) : 0
  if (wantPattern > 0) {
    const hasPattern = items.some((x) => String(x.fact_key || '').startsWith('self.pattern.'))
    if (!hasPattern) {
      const pc = patternCandidates(db, aid, 1)
      if (pc.length) items = addQuotaItems(items, pc, Math.min(k + 1, items.length + 1))
    }
  }
  // 防「祥林嫂」兜底（第二阶段 P4）：配额位（锚点 / 新近 / 自己的 / 模式）带进来的自己 的事
  // 也受同一个上限约束——不然刚写的事会被「新近」通道反复带进来，自我通道的过滤形同虚设。
  // 只挡配额通道：字面 / 实体命中的那条是真相关，她在问这件事，就该出现。
  const shownMap = opt.selfShown instanceof Map ? opt.selfShown : null
  const repCap = Math.max(0, Math.min(10, Number(opt.selfRepeatMax) || 0))
  if (shownMap && repCap > 0) {
    const isMine = (x) => x.source === 'self' || x.source === 'life'
    const isPat = (x) => String(x.fact_key || '').startsWith('self.pattern.')
    const quotaVia = new Set(['anchor', 'fresh', 'self', 'pattern'])
    const keep = (x) => !(quotaVia.has(String(x.via)) && isMine(x) && (shownMap.get(String(x.id)) || 0) >= repCap)
    const next = items.filter(keep)
    // 这一轮原本有自己的事、但全被挡住了：补回露得最少的一条（流水账可以换，模式不补）。
    if (!next.some(isMine)) {
      const blocked = items.filter((x) => isMine(x) && !isPat(x) && quotaVia.has(String(x.via))
        && (shownMap.get(String(x.id)) || 0) >= repCap)
      if (blocked.length) {
        const least = [...blocked].sort((a, b) => (shownMap.get(String(a.id)) || 0) - (shownMap.get(String(b.id)) || 0))[0]
        items = [...next, least]
      } else {
        items = next
      }
    } else {
      items = next
    }
  }
  return { scene, why, items, buffer, debug }
}
