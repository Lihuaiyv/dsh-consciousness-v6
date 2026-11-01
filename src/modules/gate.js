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

const NEG = new Set([...'不没别无取消换改'])

export const GATE = Object.freeze({
  MERGE: 0.92,
  MERGE_WITH_ENTITY: 0.80,
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
 * @param {{text:string, entity_id?:string|null}} cand
 * @returns {{action:'new'|'merge'|'conflict'|'drop', score:number, target?:object, reason?:string}}
 */
export function decideWrite(db, aid, cand = {}) {
  const text = String(cand.text || '').trim()
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
  if (best.score >= mergeLine) return { action: 'merge', score: best.score, target: best.row }
  if (best.score >= GATE.CONFLICT) {
    // 相近但没到合并线、极性也一样：可能是换了说法，也可能只是用词接近 → 新增
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
  if (d.action === 'drop') return { action: 'drop', reason: d.reason, score: d.score }
  if (d.action === 'merge') {
    try {
      db.prepare('UPDATE memory_items SET hits=hits+1, last_hit_at=?, weight=MIN(1, COALESCE(weight,0.5)+?), version=version+1 WHERE id=?')
        .run(new Date().toISOString(), Number(opt.strengthen || 0.02), d.target.id)
    } catch { /* 强化失败不影响判定 */ }
    return { action: 'merge', id: d.target.id, score: d.score }
  }

  const r = write(cand)
  if (d.action !== 'conflict') return { action: 'new', id: r && r.id, score: d.score }

  // 门控判了冲突，就必须落一条可追溯的冲突记录：
  // 不能让 addMemory 自己的相似度判定（可能更低、可能被「不加糖」这类词带偏）把它放过。
  const cid = 'cfl_' + Date.now().toString(36) + Math.random().toString(16).slice(2, 8)
  const at = new Date().toISOString()
  try {
    db.prepare('UPDATE memory_items SET invalid_at=? WHERE id=?').run(at, d.target.id)
    db.prepare(`INSERT INTO conflicts(id,agent_id,a_id,b_id,state,opened_at,severity,kind,evidence,escalation_level)
      VALUES(?,?,?,?, 'open', ?, 'high','polarity',?,0)`).run(
      cid, aid, d.target.id, r.id, at,
      JSON.stringify({ similarity: d.score, via: 'gate', a_text: String(d.target.text || '').slice(0, 120), b_text: String(cand.text || '').slice(0, 120) }).slice(0, 800),
    )
    db.prepare('INSERT INTO events VALUES(?,?,?,?,?)').run('evt_' + Date.now().toString(36) + Math.random().toString(16).slice(2, 8), aid,
      'memory.conflict', JSON.stringify({ conflict_id: cid, a: d.target.id, b: r.id, via: 'gate' }), at)
    db.prepare('INSERT INTO alerts VALUES(?,?,?,?,?,?,?)').run('alr_' + Date.now().toString(36) + Math.random().toString(16).slice(2, 8), aid,
      'data', 2, '有一条记忆冲突未处理', 'open', at)
  } catch { /* 记录失败也要把新的事实留下来 */ }
  return { action: 'conflict', id: r && r.id, conflict_id: cid, score: d.score }
}
