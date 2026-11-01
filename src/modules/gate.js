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

import { heatOf, bandOf } from './tiers.js'
import { getParam, savepoint } from '../kernel.js'
import { archiveFact } from './archive.js'
import { reviseMemory, invalidateMemory, deleteMemoryByGate, disputeOpen } from './timeline.js'

const NEG = new Set([...'不没别无取消换改'])

export const GATE = Object.freeze({
  MERGE: 0.92,
  MERGE_WITH_ENTITY: 0.80,
  UPDATE: 0.72, // 同实体高相似同极性 → 改写而非堆新行
  CONFLICT: 0.50,
  MIN_LEN: 4,
})

const NOISE = /^(Time sampled|Approval prompts|##|\{|<)/

export function polarity(text) {
  return [...String(text || '')].some((c) => NEG.has(c)) ? -1 : 1
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
export function sharedRun(a, b, n = 4) {
  const A = String(a || '')
  const B = String(b || '')
  const short = A.length <= B.length ? A : B
  const long = A.length <= B.length ? B : A
  if (short.length < n) return false
  for (let i = 0; i + n <= short.length; i++) {
    if (long.includes(short.slice(i, i + n))) return true
  }
  return false
}

/**
 * 判断两句话是不是「同一件事、但极性相反」。
 *
 * 不用「整句里有没有不」：那会把「不加糖」当成否定命题，把「喜欢咖啡，不加糖」和
 * 「不喜欢咖啡了」判成同极性。正确做法是看**共享片段前面**有没有否定词：
 *   「喜欢喝美式咖啡」 vs 「不喜欢喝美式咖啡」→ 一边有不、一边没有 → 翻转。
 */
export function polarityFlip(a, b) {
  const A = String(a || '')
  const B = String(b || '')
  const short = A.length <= B.length ? A : B
  const long = A.length <= B.length ? B : A
  if (!short) return false
  for (let n = Math.min(6, short.length); n >= 3; n--) {
    for (let i = 0; i + n <= short.length; i++) {
      const run = short.slice(i, i + n)
      const pos = long.indexOf(run)
      if (pos < 0) continue
      const negLong = /[不没别]/.test(long.slice(Math.max(0, pos - 2), pos))
      const negShort = /[不没别]/.test(short.slice(Math.max(0, i - 2), i))
      if (negLong !== negShort) return true
    }
  }
  return false
}

function reconcileOn(db, aid) {
  try { return String(getParam(db, aid, 'memory.write.reconcile') || 'on') !== 'off' } catch { return true }
}

/**
 * 改口（极性翻转）策略：
 *   conflict（默认）→ 开冲突案，两条都留，等人裁决
 *   update → 静默改写旧条（仅当显式想「改口即覆盖」时）
 * U6：默认黄灯，禁止被 UPDATE/merge 悄悄吃掉。
 */
function flipPolicy(db, aid) {
  try {
    const v = String(getParam(db, aid, 'memory.write.flip_policy') || 'conflict').toLowerCase()
    return v === 'update' ? 'update' : 'conflict'
  } catch { return 'conflict' }
}

/** 极性翻转时的动作：默认 conflict；flip_policy=update 且 reconcile 开着才允许静默改写。 */
function actionOnFlip(db, aid, target, score, reason = 'polarity_flip') {
  if (flipPolicy(db, aid) === 'update' && reconcileOn(db, aid) && target) {
    return { action: 'update', score, target, reason: reason + ':flip_update' }
  }
  return { action: 'conflict', score, target, reason }
}

/**
 * 判定一个候选该怎么写。
 * @param {{text:string, entity_id?:string|null, fact_key?:string|null, key?:string|null, op?:string}} cand
 * @returns {{action:'new'|'merge'|'update'|'conflict'|'drop'|'noop', score:number, target?:object, reason?:string}}
 */
export function decideWrite(db, aid, cand = {}) {
  const text = String(cand.text || '').trim()
  const op = String(cand.op || '').toLowerCase()
  if (op === 'noop' || op === 'ignore') return { action: 'noop', score: 1, reason: 'op=noop' }
  if (op === 'delete' || op === 'forget') {
    // 删除交给 applyWrite 找目标；这里先按相似找
  }
  if (text.length < GATE.MIN_LEN && op !== 'delete') return { action: 'drop', score: 0, reason: '太短' }
  if (NOISE.test(text)) return { action: 'drop', score: 0, reason: '运行时噪音' }

  const factKey = String(cand.fact_key || cand.key || '').trim().slice(0, 120) || null
  let rows = []
  try {
    rows = db.prepare(`SELECT id,text,entity_id,weight,fact_key FROM memory_items
      WHERE agent_id=? AND status='active' AND invalid_at IS NULL AND type IN ('fact','appraisal')
      ORDER BY created_at DESC LIMIT 200`).all(aid)
  } catch { rows = [] }

  // 同 fact_key 优先：UPDATE / delete 的锚点
  if (factKey) {
    const byKey = rows.find((r) => String(r.fact_key || '') === factKey)
    if (byKey) {
      if (op === 'delete' || op === 'forget') return { action: 'delete', score: 1, target: byKey }
      const flip = polarityFlip(text, byKey.text)
      if (flip) return actionOnFlip(db, aid, byKey, 0.9, 'same_fact_key_flip')
      if (reconcileOn(db, aid) && text !== String(byKey.text || '')) {
        return { action: 'update', score: 1, target: byKey, reason: 'same_fact_key' }
      }
      return { action: 'merge', score: 1, target: byKey, reason: 'same_fact_key_identical' }
    }
  }

  let best = null
  for (const r of rows) {
    let s = similarity(text, r.text)
    const sameEntity = !!(cand.entity_id && r.entity_id && cand.entity_id === r.entity_id)
    if (sameEntity) s += 0.08
    if (s > 1) s = 1
    if (!best || s > best.score) best = { row: r, score: s, sameEntity }
  }
  if (!best) {
    if (op === 'delete' || op === 'forget') return { action: 'drop', score: 0, reason: 'delete_miss' }
    return { action: 'new', score: 0 }
  }

  if (op === 'delete' || op === 'forget') {
    if (best.score >= GATE.CONFLICT) return { action: 'delete', score: best.score, target: best.row }
    return { action: 'drop', score: best.score, reason: 'delete_miss' }
  }

  const mergeLine = best.sameEntity ? GATE.MERGE_WITH_ENTITY : GATE.MERGE
  // 同一件事、极性相反：先于 merge / UPDATE（U6 黄灯默认）
  const flip = polarityFlip(text, best.row.text)
  if (flip) return actionOnFlip(db, aid, best.row, best.score, 'polarity_flip')
  if (best.score >= mergeLine) return { action: 'merge', score: best.score, target: best.row }
  // U2：同实体 + 较高相似 + 同极性 → UPDATE 改写（可关参）
  if (reconcileOn(db, aid) && best.sameEntity && best.score >= GATE.UPDATE
    && text !== String(best.row.text || '')) {
    return { action: 'update', score: best.score, target: best.row, reason: 'entity_paraphrase' }
  }
  if (best.score >= GATE.CONFLICT) {
    return { action: 'new', score: best.score, reason: '相近但不确定' }
  }
  return { action: 'new', score: best.score }
}

/**
 * 按判定落库。write 由调用方注入（通常是 addMemory），避免本模块直接碰记忆写入。
 * @param {(cand:{text:string,entity_id?:string|null})=>{id?:string}} write
 */
export function applyWrite(db, aid, cand, write, opt = {}) {
  const d = decideWrite(db, aid, cand)
  if (d.action === 'drop' || d.action === 'noop') {
    return { action: d.action, reason: d.reason, score: d.score }
  }
  if (d.action === 'delete' && d.target) {
    try { deleteMemoryByGate(db, aid, d.target.id) } catch { /* ignore */ }
    return { action: 'delete', id: d.target.id, score: d.score }
  }
  if (d.action === 'merge') {
    try {
      const stamp = new Date().toISOString()
      db.prepare('UPDATE memory_items SET hits=hits+1, last_hit_at=?, weight=MIN(1, COALESCE(weight,0.5)+?), version=version+1 WHERE id=?')
        .run(stamp, Number(opt.strengthen || 0.02), d.target.id)
      const row = db.prepare('SELECT * FROM memory_items WHERE id=?').get(d.target.id)
      if (row) {
        const h = heatOf(row)
        db.prepare('UPDATE memory_items SET heat=?, band=? WHERE id=?').run(h, bandOf(row, h), d.target.id)
      }
    } catch { /* 强化失败不影响判定 */ }
    return { action: 'merge', id: d.target.id, score: d.score }
  }
  if (d.action === 'update' && d.target) {
    const at = new Date().toISOString()
    const newText = String(cand.text || '').trim()
    try {
      // 旧句入冷库 + 改正文 + 改索引是一笔：旧句存不进去就整笔回退，宁可多一行也不丢旧版本
      savepoint(db, () => {
        const old = db.prepare('SELECT * FROM memory_items WHERE id=?').get(d.target.id)
        if (!old) throw new Error('update_target_gone')
        const histId = old.id + ':hist:' + Number(old.version || 1)
        const ar = archiveFact(db, aid, {
          memory_id: histId,
          text: old.text,
          type: old.type,
          importance: old.importance,
          source: 'update_history',
          payload: { superseded_by_update: true, parent_id: old.id, version: Number(old.version || 1), at },
        })
        let histRef = ar && ar.id
        if (ar && ar.duplicate) {
          const kept = db.prepare('SELECT id,text FROM fact_archive WHERE agent_id=? AND memory_id=?').get(aid, histId)
          histRef = kept && kept.text === old.text ? kept.id : null
        }
        if (!histRef) throw new Error('update_history_not_archived')
        reviseMemory(db, aid, old.id, newText, { at, textRef: histRef, reason: d.reason || 'gate' })
        try {
          db.prepare('UPDATE memory_fts SET text=? WHERE id=?').run(newText, old.id)
        } catch {
          db.prepare('DELETE FROM memory_fts WHERE id=?').run(old.id)
          db.prepare('INSERT INTO memory_fts(id,text) VALUES(?,?)').run(old.id, newText)
        }
        const row = db.prepare('SELECT * FROM memory_items WHERE id=?').get(old.id)
        if (row) {
          const h = heatOf(row)
          db.prepare('UPDATE memory_items SET heat=?, band=? WHERE id=?').run(h, bandOf(row, h), old.id)
        }
      })
    } catch { /* 改写失败则退回 new */ return { action: 'new', id: write(cand)?.id, score: d.score, fallback: 'update_failed' } }
    return { action: 'update', id: d.target.id, score: d.score, reason: d.reason }
  }

  const r = write(cand)
  if (d.action !== 'conflict') return { action: 'new', id: r && r.id, score: d.score }

  // 门控判了冲突，就必须落一条可追溯的冲突记录：
  // 不能让 addMemory 自己的相似度判定（可能更低、可能被「不加糖」这类词带偏）把它放过。
  // 回调没传 skipConflict 时 addMemory 可能已经给同一对开了案：复用，否则一边裁决完另一边永远挂着
  let dup = null
  try {
    dup = r && db.prepare(`SELECT id FROM conflicts WHERE agent_id=? AND state='open'
      AND ((a_id=? AND b_id=?) OR (a_id=? AND b_id=?)) LIMIT 1`).get(aid, d.target.id, r.id, r.id, d.target.id)
  } catch { dup = null }
  if (dup) return { action: 'conflict', id: r.id, conflict_id: dup.id, score: d.score }
  const cid = 'cfl_' + Date.now().toString(36) + Math.random().toString(16).slice(2, 8)
  const at = new Date().toISOString()
  try {
    invalidateMemory(db, aid, d.target.id, { at, reason: 'conflict', causeId: r && r.id })
    db.prepare(`INSERT INTO conflicts(id,agent_id,a_id,b_id,state,opened_at,severity,kind,evidence,escalation_level)
      VALUES(?,?,?,?, 'open', ?, 'high','polarity',?,0)`).run(
      cid, aid, d.target.id, r.id, at,
      JSON.stringify({ similarity: d.score, via: 'gate', a_text: String(d.target.text || '').slice(0, 120), b_text: String(cand.text || '').slice(0, 120) }).slice(0, 800),
    )
    disputeOpen(db, aid, [d.target.id, r && r.id], cid, { at })
    db.prepare('INSERT INTO events VALUES(?,?,?,?,?)').run('evt_' + Date.now().toString(36) + Math.random().toString(16).slice(2, 8), aid,
      'memory.conflict', JSON.stringify({ conflict_id: cid, a: d.target.id, b: r.id, via: 'gate' }), at)
    db.prepare('INSERT INTO alerts VALUES(?,?,?,?,?,?,?)').run('alr_' + Date.now().toString(36) + Math.random().toString(16).slice(2, 8), aid,
      'data', 2, '有一条记忆冲突未处理', 'open', at)
  } catch { /* 记录失败也要把新的事实留下来 */ }
  return { action: 'conflict', id: r && r.id, conflict_id: cid, score: d.score }
}
