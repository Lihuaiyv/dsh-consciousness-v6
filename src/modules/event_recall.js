/**
 * 联想：从事件热库里，看哪一件会被此刻这句话带出来。
 *
 * 设计见 docs/设计-联想-人类版-2026-11-12.md，三条来自「人是怎么想起的」：
 *   1. 线索是模糊的——完整命中算 1 分，沾边（连续 3 字重叠）算 0.5 分，不是精确匹配
 *   2. 一条线索同时碰到好几件时：**排序取第一条，不丢弃**（丢弃等于把人的常态判成错误）
 *   3. 情绪只当乘数，不当触发器——试过让它单独触发，「明天要早起」也捞出一堆重事，那不是联想是乱想
 *
 * 另外两条老规矩照旧：
 *   - 诞生 30 分钟内的命中不算（用**事件结束时间**判，不是入库时间——夜里补切昨天的事不算「刚发生」）
 *   - 越久没想起的，越容易被勾起（时间衰减）
 */
import { now } from '../db.js'

const NEG = new Set(['irritated', 'sad', 'angry', 'anxious', 'fear', 'disgust', 'frustrated', 'lonely', 'tired', 'upset'])
const POS = new Set(['joy', 'calm', 'happy', 'grateful', 'relieved', 'excited', 'content', 'proud'])
const MIN_AGE_MIN = 30
const MIN_SCORE = 0.08

/**
 * 把一条事件拼成进提示词的那一段。
 *
 * 事件单开额度（默认 400「字」≈400 token），不占记忆那 800，也不跟身份段抢。
 * 超了只砍「经过」：名字和出口半句永远留着——
 * 名字砍了就不知道想起的是哪件事；出口半句没了，放下又没由头。
 */
export function buildEventLine(hit, budget = 400) {
  if (!hit || !hit.title) return { text: '', chars: 0, budget: 0, cut: false }
  const b = Math.max(120, Math.min(1200, Number(budget) || 400))
  // 出口半句只留「可以不提」——不再承诺「在 feel 里带 settle」。
  // 那个 settle 只管一句话的情绪，碰不到事（2026-11-12 承认过：那是空话）。
  const tail = '\n（可以不提它。）'
  const head = `（忽然想起：${hit.title}——`
  const room = Math.max(40, b - head.length - tail.length)
  const full = String(hit.story || '')
  const cut = full.length > room
  const body = cut ? full.slice(0, room).replace(/[，、；\s]+$/, '') + '…' : full
  return {
    text: `${head}${body}）${tail}`,
    chars: head.length + body.length + tail.length + 1,
    budget: b,
    cut,
  }
}

/** 此刻的情绪：标签来自 affect_state，慢分来自 affect_v3（只做参考，极性看标签）。 */
export function currentMood(db, aid) {
  let label = null, slow = 0
  try {
    const a = db.prepare('SELECT primary_label FROM affect_state WHERE agent_id=?').get(aid)
    if (a) label = a.primary_label
  } catch { /* 没情绪数据 */ }
  try {
    const v = db.prepare('SELECT slow FROM affect_v3 WHERE agent_id=?').get(aid)
    if (v) slow = Number(v.slow) || 0
  } catch { /* 老库没有 v3 */ }
  const l = String(label || '').toLowerCase()
  return { label, slow, negative: NEG.has(l), positive: POS.has(l) }
}

/**
 * 词命中分：完整命中 1 分；沾边（连续 3 字重叠）0.5 分。
 *
 * 去重：同一句话里，两条指同一件事的抓手（「双层麦辣鸡」和它的别名「麦辣鸡」）
 * 只算一次。原来两条各加 1 分，同一件事的分数会翻倍，把别的事压下去——
 * 这不是更贴切，是记账重复。长的优先，短的若被长的包含就不再加分。
 */
export function wordScore(text, cues) {
  let score = 0
  const hits = []
  const fuzzy = []
  const full = []
  for (const c of cues) {
    const cue = String(c || '').trim()
    if (cue && text.includes(cue)) full.push(cue)
  }
  full.sort((a, b) => b.length - a.length)
  for (const cue of full) {
    if (hits.some((h) => h.includes(cue))) continue
    score += 1
    hits.push(cue)
  }
  for (const c of cues) {
    const cue = String(c || '').trim()
    if (!cue || text.includes(cue)) continue
    if (cue.length < 3) continue
    if (hits.some((h) => h.includes(cue))) continue
    for (let i = 0; i + 3 <= cue.length; i++) {
      const frag = cue.slice(i, i + 3)
      if (text.includes(frag)) { score += 0.5; fuzzy.push(cue + '~' + frag); break }
    }
  }
  return { score, hits, fuzzy }
}

/**
 * 给一句话找会被带出来的事件，按贴合度排序。
 * @returns {{ ok:boolean, text:string, mood:object, items:any[] }}
 */
export function recallEvents(db, aid, text, { limit = 3, minScore = MIN_SCORE, nowMs = Date.now() } = {}) {
  const q = String(text || '').trim()
  const mood = currentMood(db, aid)
  if (!q) return { ok: true, text: '', mood, items: [] }

  let rows = []
  try {
    rows = db.prepare(`SELECT h.id, h.title, h.story, h.cues, h.want, h.ceiling, h.state,
      (SELECT c.end_at FROM cold_events c WHERE c.id = json_extract(h.source_cold_ids,'$[0]')) AS event_end,
      (SELECT c.status FROM cold_events c WHERE c.id = json_extract(h.source_cold_ids,'$[0]')) AS status,
      (SELECT c.weight FROM cold_events c WHERE c.id = json_extract(h.source_cold_ids,'$[0]')) AS weight
      FROM hot_events h WHERE h.agent_id=? AND h.active=1 AND h.state='待联想'`).all(aid)
  } catch { return { ok: false, reason: 'no-event-tables', text: q, mood, items: [] } }

  const items = []
  for (const r of rows) {
    let cues = []
    try { cues = JSON.parse(r.cues || '[]') } catch { cues = [] }
    if (!cues.length) continue

    const ws = wordScore(q, cues)
    if (ws.score <= 0) continue   // 情绪不单独触发：没有词撞上，就什么也不想

    const born = r.event_end || null
    if (born) {
      const ageMin = (nowMs - Date.parse(born)) / 60000
      if (!Number.isFinite(ageMin) || ageMin < MIN_AGE_MIN) continue   // 刚发生的不算「想起」，那是复述
    }

    const w = Number(r.weight) || 0.5
    const ageH = born ? (nowMs - Date.parse(born)) / 3600000 : 0
    // 这是「越久以前的事，越难被随手带出来」——防的是老事霸占台面。
    // 「很久没被想起」那套沉浮在 event_drift 的天花板里，不是这里，两者别混。
    const decay = 1 / (1 + Math.max(0, ageH) / 24 / 7)
    let moodMul = 1
    if (mood.negative && String(r.status) === '没过去') moodMul = 1.35
    else if (mood.positive && String(r.status) === '过去了') moodMul = 1.15

    const raw = ws.score * 0.65 + w * 0.15 + Number(r.want || 0) * 0.2
    const score = raw * decay * moodMul
    if (score < minScore) continue

    items.push({
      id: r.id, title: r.title, story: r.story,
      score: Number(score.toFixed(3)),
      hits: ws.hits, fuzzy: ws.fuzzy,
      weight: w, want: Number(r.want || 0), status: r.status,
      ageHours: Number((ageH || 0).toFixed(1)),
      moodMul,
    })
  }

  // 排序：分数优先；分数接近的，重的事先、想头高的先
  items.sort((a, b) => (b.score - a.score) || (b.weight - a.weight) || (b.want - a.want))
  return { ok: true, at: now(), text: q, mood, items: items.slice(0, limit), candidates: items.length }
}
