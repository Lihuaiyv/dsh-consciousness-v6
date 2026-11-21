/**
 * 留一句：白天我自己决定「这句值得留」，当场落库（D59）。
 *
 * 背景：记忆原来只能等夜里切事来扫，白天插不上手；有些话当时就知道该留，
 * 但夜里会被摘要吞成一句「工作段：…」。这里给 Assistant 一个显式的口：
 * 在回复里某句前面写 `〔留〕`，写盘时就把那句原话（连 turn、会话、当时 mood）单独存一条。
 *
 * 存法沿用 events 表，不新建表：
 *   quote.pin  {text, turn_id, session, mood, at}
 *
 * 和 quote.moment 的区别：moment 是系统判「这一轮值得回放」；
 * pin 是「我自己点名要留」，夜里切事时会被当成该段的证据带着走。
 */

export const PIN_MARK = '〔留〕'

const MAX_PIN = 200

/** 从一段回复里把〔留〕标出来的句子摘出来，并返回去掉标记的正文。 */
export function extractPins(text) {
  const src = String(text == null ? '' : text)
  const pins = []
  const clean = src
    .split('\n')
    .map((line) => {
      const m = line.match(/^\s*〔留〕\s*(.+?)\s*$/)
      if (m) {
        const body = String(m[1] || '').trim()
        if (body) pins.push(Array.from(body).length > MAX_PIN ? Array.from(body).slice(0, MAX_PIN).join('') : body)
        return ''
      }
      return line
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { clean, pins }
}

/**
 * 一串〔留〕句子落库。返回落下的条目（含 id）。
 * 失败不抛：留不下来不该连累这一轮回话。
 *
 * 2026-11-15：来源里记「我当时自己写的 feel」，不记系统贴的情绪标签。
 * feel 是可选的——没有就不写这个字段（不拿别的东西顶替）。
 */
export function recordPins(db, aid, { pins = [], turnId = null, session = null, feel = null, at = Date.now() } = {}) {
  const out = []
  if (!pins || !pins.length) return out
  let stmt = null
  try {
    stmt = db.prepare('INSERT INTO events VALUES(?,?,?,?,?)')
  } catch { return out }
  const stamp = new Date(Number(at) || Date.now()).toISOString()
  const myFeel = String(feel == null ? '' : feel).trim()
  for (const text of pins) {
    const body = String(text || '').trim()
    if (!body) continue
    const id = 'qpin_' + Math.random().toString(16).slice(2, 12)
    const payload = { text: body, turn_id: turnId || null, session: session || null, at: stamp }
    if (myFeel) payload.feel = myFeel
    try {
      stmt.run(id, aid, 'quote.pin', JSON.stringify(payload), stamp)
      out.push({ id, ...payload })
    } catch { /* 一条失败不影响别的 */ }
  }
  return out
}

/** 取某个时间窗里留过的句子（夜里切事用）。 */
export function pinsBetween(db, aid, fromISO, toISO, limit = 6) {
  return pinsWithTime(db, aid, fromISO, toISO, limit).map((p) => p.text)
}

/** 同上，但带时间（日常段按事件区间分给对应那件时要用）。 */
export function pinsWithTime(db, aid, fromISO, toISO, limit = 6) {
  try {
    return db.prepare("SELECT payload FROM events WHERE agent_id=? AND type='quote.pin' AND created_at>=? AND created_at<=? ORDER BY created_at LIMIT ?")
      .all(aid, fromISO, toISO, limit)
      .map((r) => {
        try {
          const p = JSON.parse(r.payload || '{}')
          return { text: String(p.text || ''), at: String(p.at || '') }
        } catch { return null }
      })
      .filter((p) => p && p.text)
  } catch { return [] }
}
