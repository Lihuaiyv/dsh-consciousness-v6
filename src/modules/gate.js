/**
 * 写入门控（P2）
 *
 * 抽取出来的候选事实，先判「该不该写、写成什么」，再落库：
 *   同义（≥0.92，或同实体 + ≥0.80）→ **合并**：只强化旧条，不新增，避免「同一件事记十遍」
 *   相近但极性相反（≥0.50）→ **冲突**：交给 addMemory 的冲突流程，两条都留
 *   其余（<0.50）→ **新增**
 *   太短 / 运行时噪音 → **丢弃**
 *
 * 为什么不在 addMemory 里改：手动写的记忆（你亲手让我记）不该被门控改写；
 * 门控只作用于「模型自己抽出来的」那批。
 */

import { askAboutConflict } from './conflict_ask.js'
import { attrConflict } from './contradict.js'
import { buildSearchText, conflictPairExists } from './memory.js'
import { hasNegation, isPositiveCompoundAt } from './negation.js'
import { reviseMemory, invalidateMemory, deleteMemoryByGate, disputeOpen } from './timeline.js'
import { tx } from '../kernel.js'

export const GATE = Object.freeze({
  MERGE: 0.92,
  MERGE_WITH_ENTITY: 0.80,
  CONFLICT: 0.50,
  MIN_LEN: 4,
})

const NOISE = /^(Time sampled|Approval prompts|##|\{|<)/

export function polarity(text) {
  return hasNegation(text, '不没别无取消换改') ? -1 : 1
}

function charSet(text) {
  return new Set(String(text || '').match(/[\u4e00-\u9fff]|[a-zA-Z0-9]/g) || [])
}

/** 字面相似度：字符集 Jaccard（没有向量时的替代）。 */
export function similarity(a, b) {
  const A = charSet(a)
  const B = charSet(b)
  if (!A.size || !B.size) return 0
  let inter = 0
  for (const c of A) if (B.has(c)) inter++
  return inter / (A.size + B.size - inter)
}

/** 两句话里有没有一段 ≥4 字的公共片段（「喜欢喝美式咖啡」这种）。 */
/* 否定词：不/没/未/无/别。但「别」是两义的：
 *   「别的东西 / 别人 / 别处」里的 别 = 其他，不是否定；
 *   真的否定是「别去 / 别想」这种 别+动词。
 * 所以 别 后面跟这些字时不算否定词——否则「优化别的东西」会被当成否定句。
 */
const NEG_ONE = new Set([...'不没未无别'])
const NOT_NEG_AFTER_BIE = new Set([...'的人处样边个'])

/* 这类公共片段只是虚词尾巴：撞上了不代表在说同一件事。 */
const TAIL_NOISE = new Set(['的东西', '的时候', '的地方', '的事情', '的问题', '这样的', '一样的', '一个人'])

function isNegationAt(text, i) {
  const c = text[i]
  if (!c || !NEG_ONE.has(c)) return false
  // 「无误 / 无疑」这类正向否定式整块不算否定：确认无误 ≠ 否认
  if (isPositiveCompoundAt(text, i)) return false
  if (c === '别') {
    const next = text[i + 1] || ''
    if (!next || NOT_NEG_AFTER_BIE.has(next)) return false
  }
  return true
}

/** 公共片段前面 2 个字里有没有否定词（否定词本来就该贴在被否定的那截前面）。 */
function negationBefore(text, pos) {
  for (let k = 1; k <= 2; k++) {
    const i = pos - k
    if (i < 0) break
    if (isNegationAt(text, i)) return true
  }
  return false
}

/**
 * 判断两句话是不是「同一件事、但极性相反」。
 *
 * 不用「整句里有没有不」：那会把「不加糖」当成否定命题，把「喜欢咖啡，不加糖」和
 * 「不喜欢咖啡了」判成同极性。正确做法是看**共享片段前面**有没有否定词：
 *   「喜欢喝美式咖啡」 vs 「不喜欢喝美式咖啡」→ 一边有不、一边没有 → 翻转。
 *
 * 但共享片段太短时几乎必然是巧合（「…的东西」「…的时候」这种虚词尾巴），
 * 所以要求公共片段 ≥4 字，并且挡掉几个纯虚词尾巴：
 *   「快情绪…喜欢的东西」 vs「情绪…优化别的东西」只有「的东西」3 字 + 别（其他）
 *   不该被当成同一件事的两个相反说法。
 */
export function polarityFlip(a, b, minRun = 4) {
  const A = String(a || '')
  const B = String(b || '')
  const short = A.length <= B.length ? A : B
  const long = A.length <= B.length ? B : A
  if (!short || short.length < minRun) return false
  for (let n = Math.min(6, short.length); n >= minRun; n--) {
    for (let i = 0; i + n <= short.length; i++) {
      const run = short.slice(i, i + n)
      if (TAIL_NOISE.has(run)) continue
      const pos = long.indexOf(run)
      if (pos < 0) continue
      const negLong = negationBefore(long, pos)
      const negShort = negationBefore(short, i)
      if (negLong !== negShort) return true
    }
  }
  return false
}

/**
 * 判定一个候选该怎么写。
 * @param {{text:string, entity_id?:string|null, fact_key?:string|null, op?:string}} cand
 * @returns {{action:'new'|'merge'|'conflict'|'update'|'delete'|'drop', score:number, target?:object, reason?:string}}
 */
export function decideWrite(db, aid, cand = {}) {
  const text = String(cand.text || '').trim()
  const factKey = String(cand.fact_key || '').trim()
  // 明确的删除指令：找到同 key 的现行条目，交给 DELETE 分支
  if (String(cand.op || '') === 'delete') {
    if (!factKey) return { action: 'new', score: 0, reason: 'delete_no_key' }
    let row = null
    try {
      row = db.prepare(`SELECT * FROM memory_items WHERE agent_id=? AND fact_key=? AND status='active' AND invalid_at IS NULL ORDER BY created_at DESC LIMIT 1`).get(aid, factKey)
    } catch { row = null }
    return row ? { action: 'delete', score: 1, target: row } : { action: 'new', score: 0, reason: 'delete_no_target' }
  }
  if (text.length < GATE.MIN_LEN) return { action: 'drop', score: 0, reason: '太短' }
  if (NOISE.test(text)) return { action: 'drop', score: 0, reason: '运行时噪音' }

  let rows = []
  try {
    rows = db.prepare(`SELECT id,text,entity_id,weight FROM memory_items
      WHERE agent_id=? AND status='active' AND invalid_at IS NULL AND type IN ('fact','appraisal')
      ORDER BY created_at DESC LIMIT 200`).all(aid)
  } catch { rows = [] }

  let best = null
  for (const r of rows) {
    let s = similarity(text, r.text)
    const sameEntity = !!(cand.entity_id && r.entity_id && cand.entity_id === r.entity_id)
    if (sameEntity) s += 0.08
    if (s > 1) s = 1
    if (!best || s > best.score) best = { row: r, score: s, sameEntity }
  }
  if (!best) return { action: 'new', score: 0 }

  const mergeLine = best.sameEntity ? GATE.MERGE_WITH_ENTITY : GATE.MERGE
  // 同一件事、极性相反：先判矛盾再判合并（「不喜欢喝美式咖啡了」vs「喜欢喝美式咖啡，不加糖」）
  const flip = polarityFlip(text, best.row.text)
  if (flip) return { action: 'conflict', score: best.score, target: best.row }
  // 没有否定词、但同一骨架取了互斥的值（「咖啡是热的」vs「…是冰的」）也算
  const attr = attrConflict(text, best.row.text)
  if (attr) return { action: 'conflict', score: best.score, target: best.row, attr }
  if (best.score >= mergeLine) return { action: 'merge', score: best.score, target: best.row }
  // 同一个 fact_key：换了说法，还是同一件事 → 原地改写（旧句先留底，不能直接覆盖）
  if (factKey) {
    let row = null
    try {
      row = db.prepare(`SELECT * FROM memory_items WHERE agent_id=? AND fact_key=? AND status='active' AND invalid_at IS NULL ORDER BY created_at DESC LIMIT 1`).get(aid, factKey)
    } catch { row = null }
    if (row && String(row.text).trim() !== text) return { action: 'update', score: best.score, target: row }
  }
  if (best.score >= GATE.CONFLICT) {
    // 相近但没到合并线、极性也一样：可能是换了说法，也可能只是用词接近 → 新增
    return { action: 'new', score: best.score, reason: '相近但不确定' }
  }
  return { action: 'new', score: best.score }
}

/**
 * 原地改写：旧句先存进冷库（`<id>:hist:<version>`），再改正文。
 * 存根写不进去（槽位被占 / 老库）就整笔回滚、退回「新增一行」——宁可多一条，不能丢旧句。
 */
function commitUpdate(db, aid, target, cand, write) {
  const oldText = String(target.text || '')
  const ver = Number(target.version || 1)
  const histId = target.id + ':hist:' + ver
  const at = new Date().toISOString()
  const text = String(cand.text || '')
  const key = cand.fact_key || target.fact_key || null
  const searchText = buildSearchText(text, key, cand.terms)
  let ok = false
  try {
    tx(db, () => {
      const ins = db.prepare(`INSERT OR IGNORE INTO fact_archive(id,agent_id,memory_id,text,type,mark,fact_key,source,payload,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
        histId, aid, histId, oldText, target.type || 'fact', 'normal', key,
        'update_history', JSON.stringify({ at, actor: 'gate' }), at,
      )
      if (!Number(ins.changes)) throw new Error('hist_slot_taken')
      reviseMemory(db, aid, target.id, text, { textRef: histId, at, actor: 'gate' })
      db.prepare('UPDATE memory_items SET search_text=?, fact_key=COALESCE(?, fact_key) WHERE id=?').run(searchText, key, target.id)
      try {
        db.prepare('DELETE FROM memory_fts WHERE id=?').run(target.id)
        db.prepare('INSERT INTO memory_fts(id,text) VALUES(?,?)').run(target.id, searchText)
      } catch { /* 老库没有 FTS 就跳过 */ }
    })
    ok = true
  } catch { ok = false }
  if (ok) return { action: 'update', id: target.id, score: 1 }
  // 留底失败：不覆盖正文，退回新增
  const r = write(cand)
  return { action: 'new', id: r && r.id, score: 0, fallback: 'update_failed' }
}

/**
 * 按判定落库。write 由调用方注入（通常是 addMemory），避免本模块直接碰记忆写入。
 * @param {(cand:{text:string,entity_id?:string|null})=>{id?:string}} write
 */
export function applyWrite(db, aid, cand, write, opt = {}) {
  const d = decideWrite(db, aid, cand)
  if (d.action === 'drop') return { action: 'drop', reason: d.reason, score: d.score }
  if (d.action === 'merge') {
    try {
      db.prepare('UPDATE memory_items SET hits=hits+1, last_hit_at=?, weight=MIN(1, COALESCE(weight,0.5)+?), version=version+1 WHERE id=?')
        .run(new Date().toISOString(), Number(opt.strengthen || 0.02), d.target.id)
    } catch { /* 强化失败不影响判定 */ }
    return { action: 'merge', id: d.target.id, score: d.score }
  }
  if (d.action === 'update') return commitUpdate(db, aid, d.target, cand, write)
  if (d.action === 'delete') {
    deleteMemoryByGate(db, aid, d.target.id, { reason: 'gate', actor: 'gate' })
    return { action: 'delete', id: d.target.id, score: d.score }
  }

  const r = write(cand)
  if (d.action !== 'conflict') return { action: 'new', id: r && r.id, score: d.score }

  // addMemory 自己也可能判出同一条冲突：它已经开过案、排过问句了，就别重复开第二份
  if (r && r.conflict && r.conflict_id) {
    return { action: 'conflict', id: r.id, conflict_id: r.conflict_id, score: d.score, dedup: 'addMemory' }
  }

  // 这一对记忆之间已经开过案（开着的，或者你之前拍过板的）：别再开第二张卡。
  // 否则每抽到一个新说法就重新弹一张同样的冲突，判完还会再来。
  if (r && r.id && conflictPairExists(db, aid, d.target.id, r.id)) {
    return { action: 'new', id: r.id, score: d.score, dedup: 'existing-conflict' }
  }

  // 门控判了冲突，就必须落一条可追溯的冲突记录：
  // 不能让 addMemory 自己的相似度判定（可能更低、可能被「不加糖」这类词带偏）把它放过。
  const cid = 'cfl_' + Date.now().toString(36) + Math.random().toString(16).slice(2, 8)
  const at = new Date().toISOString()
  const kind = d.attr ? 'attribute' : 'polarity'
  try {
    invalidateMemory(db, aid, d.target.id, { at, reason: 'conflict', causeId: r.id, actor: 'gate' })
    disputeOpen(db, aid, [d.target.id, r.id], cid, { at, actor: 'gate' })
    db.prepare(`INSERT INTO conflicts(id,agent_id,a_id,b_id,state,opened_at,severity,kind,evidence,escalation_level)
      VALUES(?,?,?,?, 'open', ?, 'high',?,?,0)`).run(
      cid, aid, d.target.id, r.id, at, kind,
      JSON.stringify({
        similarity: d.score, via: 'gate', kind,
        attribute: d.attr || null,
        a_text: String(d.target.text || '').slice(0, 120), b_text: String(cand.text || '').slice(0, 120),
      }).slice(0, 800),
    )
    db.prepare('INSERT INTO events VALUES(?,?,?,?,?)').run('evt_' + Date.now().toString(36) + Math.random().toString(16).slice(2, 8), aid,
      'memory.conflict', JSON.stringify({ conflict_id: cid, a: d.target.id, b: r.id, via: 'gate' }), at)
    db.prepare('INSERT INTO alerts VALUES(?,?,?,?,?,?,?)').run('alr_' + Date.now().toString(36) + Math.random().toString(16).slice(2, 8), aid,
      'data', 2, '有一条记忆冲突未处理', 'open', at)
    // 开案之后真的开口问（跟 addMemory 共用同一个问句出口）；
    // attr 的 sentence_a 是候选（新），sentence_b 是旧条——按时间顺序摆
    askAboutConflict(db, aid, {
      cid, aId: d.target.id, bId: r.id,
      aText: (d.attr && d.attr.sentence_b) || d.target.text,
      bText: (d.attr && d.attr.sentence_a) || cand.text,
    })
  } catch { /* 记录失败也要把新的事实留下来 */ }
  return { action: 'conflict', id: r && r.id, conflict_id: cid, score: d.score }
}
