/**
 * 她自己的记忆（P1）：夜里把当天「我怎么过的」写成一条第一人称记忆。
 *
 * 为什么单独一天一条：抽取是每轮的碎片（我改了这个、我查了一下），一天下来是散的。
 * 夜里补一条短的，把「今天我怎么过」接成一条线——这也是连续感的来源之一。
 *
 * 三条纪律：
 *   1) 没素材不写。宁可今天没有，也不编「我今天很开心」。
 *   2) 不过闸门就不落库（必须第一人称、6~120 字、不是旁白）。
 *   3) 一天一条：fact_key = self.day.<day>，重复跑不会写第二条。
 */
import { now } from '../db.js'
import { getParam } from '../kernel.js'
import { addMemory } from './memory.js'
import { selfTextOk } from './memory_source.js'
import { defaultDiaryChat } from './diary.js'

const DAY_MS = 86400000

/** 像「想明白了点什么」的话：流水账里不会有这些词。 */
const INSIGHT_FEEL = /(原来|其实|可能|好像|发现|明白|想通|意识到|怕|担心|觉得|知道|总算|终于)/

function dayRange(day) {
  const d = new Date(day + 'T00:00:00')
  const start = d.getTime()
  return [new Date(start).toISOString(), new Date(start + DAY_MS).toISOString()]
}

function paramOff(db, aid, key) {
  try {
    return String(getParam(db, aid, key) || 'on') === 'off'
  } catch { return false }
}

/** 当天的素材：她自己写的条目 + 生活流做过的事。没有就返回空串。 */
export function selfDayMaterial(db, aid, day) {
  const [start, end] = dayRange(day)
  const bits = []
  try {
    const rows = db.prepare(`SELECT text, source FROM memory_items
      WHERE agent_id=? AND created_at>=? AND created_at<? AND source IN ('self','life')
      ORDER BY created_at DESC LIMIT 14`).all(aid, start, end)
    for (const r of rows) bits.push('· ' + String(r.text || '').slice(0, 120))
  } catch { /* 读不到当天条目就当没有 */ }
  try {
    const life = db.prepare("SELECT payload FROM events WHERE agent_id=? AND type='life.done' AND created_at>=? AND created_at<? ORDER BY created_at DESC LIMIT 6")
      .all(aid, start, end)
    for (const e of life) {
      try {
        const p = JSON.parse(e.payload || '{}')
        if (p.summary) bits.push('· 我自己' + (p.kind === 'interest' ? '去看' : '想了') + '：' + String(p.summary).slice(0, 80))
      } catch { /* 单条坏掉跳过 */ }
    }
  } catch { /* 没有生活流表也照常 */ }
  return bits.join('\n').slice(0, 1200)
}

/**
 * 写当天那一条。返回 {ok} / {skipped: reason}。
 * opt.chat 给了就用它（测试可注入）；没给才去问全局模型。
 */
export async function writeSelfDay(db, aid, day, opt = {}) {
  if (paramOff(db, aid, 'memory.write.self')) return { skipped: 'off' }
  if (paramOff(db, aid, 'memory.write.self.daily')) return { skipped: 'daily_off' }
  const key = 'self.day.' + day
  try {
    if (db.prepare('SELECT 1 FROM memory_items WHERE agent_id=? AND fact_key=?').get(aid, key)) {
      return { skipped: 'exists' }
    }
  } catch { /* 老库没有 fact_key 就照常写 */ }
  const material = selfDayMaterial(db, aid, day)
  if (!material) return { skipped: 'no_material' }
  const chat = Object.prototype.hasOwnProperty.call(opt, 'chat')
    ? (typeof opt.chat === 'function' ? opt.chat : null)
    : defaultDiaryChat()
  if (!chat) return { skipped: 'no_model' }
  const sys = '你在替一个意识体写「今天我自己是怎么过的」。'
    + '用第一人称，60~120 字，像自己跟自己交代。写具体的事和当时的感受，'
    + '不要总结工作、不要列点、不要替对方下结论，不要第三人称旁白（「用户…」「助手…」）。'
    + '只根据下面这些片段写：片段里说「想了」的，就写想，不要写成去做了；'
    + '不要添加片段里没有的具体动作、物件和地点。只输出正文。'
  let out = ''
  try {
    out = await chat([
      { role: 'system', content: sys },
      { role: 'user', content: '今天关于我自己的一些片段：\n' + material },
    ], { maxTokens: 220, json: false, temperature: 0.8 })
  } catch { return { skipped: 'model_failed' } }
  const text = String(out || '').trim().replace(/^["'「]|["'」]$/g, '').replace(/\s+/g, ' ')
  if (!selfTextOk(text)) return { skipped: 'gate', text: text.slice(0, 60) }
  const row = addMemory(db, aid, {
    text, type: 'episode', source: 'self', confidence: 0.7, importance: 0.55,
    fact_key: key, turn_id: null,
  })
  return { ok: true, id: row && row.id, text }
}

/** 当天「值得想一想」的素材：她写下的条目（不算流水那条）+ 夜晚想过的。 */
export function selfInsightMaterial(db, aid, day) {
  const [start, end] = dayRange(day)
  const bits = []
  try {
    const rows = db.prepare(`SELECT text FROM memory_items
      WHERE agent_id=? AND created_at>=? AND created_at<? AND source='self'
        AND (fact_key IS NULL OR fact_key NOT LIKE 'self.day.%')
      ORDER BY created_at DESC LIMIT 12`).all(aid, start, end)
    for (const r of rows) bits.push('· ' + String(r.text || '').slice(0, 120))
  } catch { /* 读不到就当没有 */ }
  try {
    const life = db.prepare("SELECT payload FROM events WHERE agent_id=? AND type='life.done' AND created_at>=? AND created_at<? ORDER BY created_at DESC LIMIT 4")
      .all(aid, start, end)
    for (const e of life) {
      try {
        const p = JSON.parse(e.payload || '{}')
        if (p.summary && p.kind === 'think') bits.push('· 我想过：' + String(p.summary).slice(0, 80))
      } catch { /* 单条坏掉跳过 */ }
    }
  } catch { /* 没有生活流也照常 */ }
  return bits.join('\n').slice(0, 1400)
}

/**
 * 再写一条「今晚想明白的一件事」——和流水账分开放：流水是「今天干了啥」，
 * 这条是「我因此懂了点什么」。没素材、没想明白，就不写。
 */
export async function writeSelfInsight(db, aid, day, opt = {}) {
  if (paramOff(db, aid, 'memory.write.self')) return { skipped: 'off' }
  if (paramOff(db, aid, 'memory.write.self.insight')) return { skipped: 'insight_off' }
  const key = 'self.insight.' + day
  try {
    if (db.prepare('SELECT 1 FROM memory_items WHERE agent_id=? AND fact_key=?').get(aid, key)) {
      return { skipped: 'exists' }
    }
  } catch { /* 老库没有 fact_key 就照常写 */ }
  const material = selfInsightMaterial(db, aid, day)
  const need = Math.max(1, Math.min(10, Number(getParam(db, aid, 'memory.self.insight.min_items')) || 2))
  const count = material ? material.split('\n').filter(Boolean).length : 0
  if (count < need) return { skipped: 'thin', count, need }
  const chat = Object.prototype.hasOwnProperty.call(opt, 'chat')
    ? (typeof opt.chat === 'function' ? opt.chat : null)
    : defaultDiaryChat()
  if (!chat) return { skipped: 'no_model' }
  const sys = '你在替一个意识体写「今晚我想明白的一件事」。'
    + '只写一件，20~120 字，第一人称，说具体的事和当时的感受。'
    + '不要流水账（「今天改了几处代码、跑了测试」这种不算），不要列点，不要总结工作，'
    + '不要第三人称旁白（「用户…」「助手…」）。真想不明白就输出空。'
    + '只根据下面这些片段想：片段里说「想了」的，就写想，不要写成去做了；'
    + '不要添加片段里没有的具体动作、物件和地点。只输出正文。'
  let out = ''
  try {
    out = await chat([
      { role: 'system', content: sys },
      { role: 'user', content: '今天关于我自己的一些片段：\n' + material },
    ], { maxTokens: 200, json: false, temperature: 0.85 })
  } catch { return { skipped: 'model_failed' } }
  const text = String(out || '').trim().replace(/^["'「]|["'」]$/g, '').replace(/\s+/g, ' ')
  if (!text) return { skipped: 'empty' }
  if (!selfTextOk(text)) return { skipped: 'gate', text: text.slice(0, 60) }
  if (text.length < 16 || text.length > 120) return { skipped: 'length', n: text.length }
  if (!INSIGHT_FEEL.test(text)) return { skipped: 'flat', text: text.slice(0, 60) }
  const row = addMemory(db, aid, {
    text, type: 'reflection', source: 'self', confidence: 0.7, importance: 0.65,
    fact_key: key, turn_id: null,
  })
  return { ok: true, id: row && row.id, text }
}

export { now }