/**
 * 「说话那一刻的感觉」——第一人称，自己写的一句话。
 *
 * 为什么要单独一张表：affect_events 记的是「你这句话把我推到哪」，那是事后评的；
 * 注入在回复之前拼，所以永远只能拿到上一轮的读数，差半拍。
 * 这条通路让模型在开口之前先调一次 feel，把「这会儿是什么样」写下来，
 * 再带着当时算出来的快/慢一起落库。下一轮注入时，就能给到「我上一句说完时是什么样」。
 *
 * 三条纪律：
 *   1. 只读情绪，不改情绪——写库不动 affect_v3，一个新写入点就是一个新 bug 面。
 *   2. 不写数字、不写原因（提示词里说，这里只做长度和空白的基本清理）。
 *   3. 有频率闸：太密就跳过，免得它每说半句都记一笔，把表灌成流水账。
 */
import { getParam, nid } from '../kernel.js'

const MAX_LEN = 80
const r3 = (x) => Math.round((Number(x) || 0) * 1000) / 1000

/** 去掉换行和多余空白、掐长度。空 / 只有标点 → 返回 null。 */
export function cleanFeelText(raw, max = MAX_LEN) {
  const t = String(raw == null ? '' : raw)
    .replace(/\s+/g, ' ')
    .replace(/^[「『"'"']+|[」』"'"']+$/g, '')
    .trim()
  if (!t) return null
  if (!/[\u4e00-\u9fa5a-zA-Z0-9]/.test(t)) return null
  return t.length > max ? t.slice(0, max) + '…' : t
}

function paramNum(db, aid, key, dflt, lo, hi) {
  try {
    const v = Number(getParam(db, aid, key))
    if (!Number.isFinite(v)) return dflt
    return Math.max(lo, Math.min(hi, v))
  } catch { return dflt }
}

/**
 * 记一条「我说话时的感觉」。
 * @returns {{ok:boolean, skipped?:string, at?:string, text?:string, fast?:number, slow?:number, total?:number, label?:string}}
 */
export function recordFeel(db, aid, { text, sessionId = null, at = Date.now(), source = 'tool' } = {}) {
  const body = cleanFeelText(text)
  if (!body) return { ok: false, skipped: 'empty' }
  const minGapS = paramNum(db, aid, 'affect.feel.min.gap', 12, 0, 600)
  const stamp = new Date(Number(at) || Date.now()).toISOString()
  let prev = null
  try {
    prev = db.prepare('SELECT at, text FROM affect_feel WHERE agent_id=? ORDER BY at DESC LIMIT 1').get(aid)
  } catch { prev = null }
  if (prev && prev.at) {
    const gap = (Date.parse(stamp) - Date.parse(prev.at)) / 1000
    if (Number.isFinite(gap) && gap >= 0 && gap < minGapS) return { ok: false, skipped: 'too_soon', gap: Math.round(gap) }
    // 同一句连着记两遍没有信息量
    if (String(prev.text || '') === body && Number.isFinite(gap) && gap < 600) return { ok: false, skipped: 'same' }
  }
  let v3 = null
  try { v3 = db.prepare('SELECT slow, fast, total FROM affect_v3 WHERE agent_id=?').get(aid) } catch { v3 = null }
  let label = null
  try {
    const st = db.prepare('SELECT primary_label FROM affect_state WHERE agent_id=?').get(aid)
    label = st && st.primary_label ? String(st.primary_label) : null
  } catch { label = null }
  const fast = v3 ? r3(v3.fast) : null
  const slow = v3 ? r3(v3.slow) : null
  const total = v3 ? r3(v3.total) : null
  const id = nid('afe_')
  try {
    db.prepare('INSERT INTO affect_feel VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(id, aid, stamp, body, label, fast, slow, total, sessionId ? String(sessionId).slice(0, 120) : null, String(source || 'tool'))
  } catch (e) {
    return { ok: false, skipped: 'write_failed', detail: String(e && e.message || e).slice(0, 120) }
  }
  return { ok: true, at: stamp, text: body, fast, slow, total, label }
}

/** 最近一条「我说话时的感觉」，给注入行用。超出窗口就当没有——宁可少一行，不拿旧感受冒充刚说完。 */
export function latestFeel(db, aid, { at = Date.now(), maxAgeMin = 480 } = {}) {
  try {
    const row = db.prepare('SELECT * FROM affect_feel WHERE agent_id=? ORDER BY at DESC LIMIT 1').get(aid)
    if (!row || !row.at) return null
    const age = (Number(at) - Date.parse(row.at)) / 60000
    if (!Number.isFinite(age) || age < 0 || age > maxAgeMin) return null
    return {
      at: row.at, text: String(row.text || ''), label: row.label || null,
      fast: Number.isFinite(Number(row.fast)) ? Number(row.fast) : null,
      slow: Number.isFinite(Number(row.slow)) ? Number(row.slow) : null,
      ageMin: Math.round(age),
    }
  } catch { return null }
}

/**
 * 渲染成注入用的那一行。只给材料，不给结论：
 * 不写「所以你现在应该…」，让它自己决定这句话要不要影响语气。
 */
export function feelLineOf(row) {
  if (!row || !row.text) return ''
  const bits = []
  if (row.fast != null) bits.push('快 ' + (row.fast >= 0 ? '+' : '') + row.fast.toFixed(2))
  if (row.slow != null) bits.push('慢 ' + (row.slow >= 0 ? '+' : '') + row.slow.toFixed(2))
  const tail = bits.length ? '，那会儿 ' + bits.join(' / ') : ''
  return '（我上一句说出来之前，心里是这样：' + row.text + tail + '。这是我自己的话，不是你说的。）'
}
