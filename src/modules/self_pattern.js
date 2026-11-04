/**
 * 她自己的模式（第二阶段 P1）：把反复出现的事攒成一句「我好像就是这样」。
 *
 * 为什么单独一层：抽取和夜间流水记的都是「哪一个时刻」，不是「我是一个什么样的人」。
 * 「我总先道歉再解释」这种话，只有把几十天的条文摊开、看见同一个形状反复出现，才说得出来。
 *
 * 四条纪律：
 *   1) 至少 min_days 个不同日期都出现过才准写——一次巧合不算模式。
 *   2) 宁缺毋滥：模型给空、或过不了闸门，就不写。
 *   3) 幂等：同一个 key 再出现不是新增，是给原来那条加分（importance/confidence 缓慢上涨）。
 *   4) 换个说法（cosine 高）也算同一模式，并进旧条目，别让库里堆十条意思一样的话。
 */
import { now } from '../db.js'
import { getParam } from '../kernel.js'
import { addMemory } from './memory.js'
import { selfTextOk } from './memory_source.js'
import { defaultDiaryChat } from './diary.js'
import { vectorize, cosine } from './fingerprint.js'

const DAY_MS = 86400000
/** 同一个模式换了说法：向量相似到这个程度就并进旧条目。 */
const SIM_MERGE = 0.78

function paramOff(db, aid, key) {
  try {
    return String(getParam(db, aid, key) || 'on') === 'off'
  } catch { return false }
}

/** 一条记忆的「那一天」（按写入时的本地日期近似取 ISO 前十位）。 */
export function dayOf(iso) {
  const s = String(iso || '')
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : ''
}

/** 最近 windowDays 天里她自己写的事，按「日期 · 正文」排；同时给出覆盖到几个不同日期。 */
export function patternMaterial(db, aid, windowDays = 30) {
  const n = Math.max(7, Math.min(180, Number(windowDays) || 30))
  const since = new Date(Date.now() - n * DAY_MS).toISOString()
  const bits = []
  const days = new Set()
  try {
    const rows = db.prepare(`SELECT text, created_at FROM memory_items
      WHERE agent_id=? AND status='active' AND invalid_at IS NULL AND source='self' AND created_at>=?
      ORDER BY created_at DESC LIMIT 160`).all(aid, since)
    for (const r of rows) {
      const d = dayOf(r.created_at)
      if (!d) continue
      days.add(d)
      bits.push(d + ' · ' + String(r.text || '').slice(0, 100))
    }
  } catch { /* 读不到就当没有素材 */ }
  return { text: bits.join('\n').slice(0, 2400), days }
}

/** key 归一化成 fact_key 的一段：只留中英文数字，长度封顶。 */
export function normKey(s) {
  return String(s || '').toLowerCase().replace(/[^\u4e00-\u9fffa-z0-9]/g, '').slice(0, 20)
}

/** 已有同 key / 同意思的模式就加分，不然新增。返回 {action:'bump'|'new', id}。 */
export function upsertPattern(db, aid, { key, text }) {
  const fk = 'self.pattern.' + normKey(key)
  try {
    const old = db.prepare(`SELECT id FROM memory_items
      WHERE agent_id=? AND fact_key=? AND status='active' AND invalid_at IS NULL LIMIT 1`).get(aid, fk)
    if (old) return { action: 'bump', id: old.id }
  } catch { /* 老库没有 fact_key 就往下走 */ }
  // 换了说法的同一个模式：并进旧条目
  try {
    const rows = db.prepare(`SELECT id, text FROM memory_items
      WHERE agent_id=? AND source='self' AND fact_key LIKE 'self.pattern.%'
        AND status='active' AND invalid_at IS NULL`).all(aid)
    const v = vectorize(text)
    for (const r of rows) {
      if (cosine(v, vectorize(String(r.text || ''))) >= SIM_MERGE) return { action: 'bump', id: r.id }
    }
  } catch { /* 相似度算不了就当没匹配 */ }
  const row = addMemory(db, aid, {
    text, type: 'reflection', source: 'self', confidence: 0.65, importance: 0.6,
    fact_key: fk, turn_id: null,
  })
  return { action: 'new', id: row && row.id }
}

/** 又见到一次：importance/confidence 缓慢上涨，封顶，别让一条模式变成万能解释。 */
function bumpPattern(db, aid, id) {
  try {
    db.prepare(`UPDATE memory_items SET
      importance=MIN(0.9, importance+0.05),
      confidence=MIN(0.85, confidence+0.03),
      last_hit_at=?
      WHERE id=?`).run(now(), id)
  } catch {
    try {
      db.prepare(`UPDATE memory_items SET
        importance=MIN(0.9, importance+0.05),
        confidence=MIN(0.85, confidence+0.03)
        WHERE id=?`).run(id)
    } catch { /* 加不上分就算了，条目还在 */ }
  }
}

/**
 * 每晚认一次自己。返回 {ok, written, merged, skipped}。
 * opt.chat 给了就用它（测试可注入）；没给才问全局模型。
 */
export async function writeSelfPattern(db, aid, opt = {}) {
  if (paramOff(db, aid, 'memory.self.pattern')) return { skipped: 'off' }
  const minDays = Math.max(2, Math.min(10, Number(getParam(db, aid, 'memory.pattern.min_days')) || 3))
  const perNight = Math.max(1, Math.min(5, Number(getParam(db, aid, 'memory.pattern.per_night')) || 2))
  const windowDays = Math.max(7, Math.min(180, Number(getParam(db, aid, 'memory.pattern.window_days')) || 30))
  const mat = patternMaterial(db, aid, windowDays)
  if (mat.days.size < minDays) return { skipped: 'few_days', days: mat.days.size, need: minDays }
  const chat = Object.prototype.hasOwnProperty.call(opt, 'chat')
    ? (typeof opt.chat === 'function' ? opt.chat : null)
    : defaultDiaryChat()
  if (!chat) return { skipped: 'no_model' }
  const sys = '你在帮一个意识体认自己：从她最近写过的事里，找出反复出现的模式。'
    + '只输出 JSON：{"patterns":[{"key":"一个 2~12 字的动作短语","text":"一句第一人称的话","days":["YYYY-MM-DD"]}]}。'
    + '规则：至少 ' + minDays + ' 个不同日期都出现过才算；key 不要含「用户」「对方」「助手」；'
    + 'text 用第一人称「我」，16~120 字，写具体的样子，不要总结、不要列点；'
    + '宁缺毋滥，一条都不确定就输出 {"patterns":[]}。'
  let out = ''
  try {
    out = await chat([
      { role: 'system', content: sys },
      { role: 'user', content: '最近我写过的事：\n' + mat.text },
    ], { maxTokens: 420, json: true, temperature: 0.5 })
  } catch { return { skipped: 'model_failed' } }
  let parsed = null
  try { parsed = typeof out === 'string' ? JSON.parse(out) : out } catch { return { skipped: 'bad_json' } }
  const list = Array.isArray(parsed && parsed.patterns) ? parsed.patterns : []
  const written = []
  const merged = []
  for (const p of list) {
    if (written.length + merged.length >= perNight) break
    const key = String((p && p.key) || '').trim()
    const text = String((p && p.text) || '').trim().replace(/\s+/g, ' ')
    const ds = Array.isArray(p && p.days)
      ? [...new Set(p.days.map(String).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)))]
      : []
    if (key.length < 2 || key.length > 12) continue
    if (/用户|对方|助手|他|她/.test(key)) continue
    if (!selfTextOk(text)) continue
    if (text.length < 16 || text.length > 120) continue
    if (ds.length < minDays) continue
    const r = upsertPattern(db, aid, { key, text })
    if (!r || !r.id) continue
    if (r.action === 'new') written.push(r.id)
    else { merged.push(r.id); bumpPattern(db, aid, r.id) }
  }
  const total = written.length + merged.length
  return { ok: total > 0, written: written.length, merged: merged.length, skipped: total ? null : 'no_pattern' }
}
