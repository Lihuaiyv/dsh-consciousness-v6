/**
 * 「今天的她」攒成一条线（P7）。
 *
 * 以前只存一份 flag，明天就把今天覆盖——那层永远是「只有今天的人」。
 * 现在按天存，保留最近七天；注入读今天 + 往前两天，多出来的用一行摘要带过。
 *
 * 为什么不建表：建表要同时动 db.js、导入导出白名单、清理任务、INV10 归属四处。
 * 先走 flags（KV），功能先跑通；要升表时这个模块是唯一入口，换实现不影响调用方。
 */
import { now } from '../db.js'

const KEY = (aid) => 'self_note.' + aid
const KEEP = 7

function readRaw(db, aid) {
  try {
    const r = db.prepare('SELECT value FROM flags WHERE key=?').get(KEY(aid))
    if (!r || !r.value) return []
    const v = JSON.parse(r.value)
    if (Array.isArray(v)) return v
    // 老格式：单个 { day, text, at }
    if (v && v.day && v.text) return [v]
    return []
  } catch { return [] }
}

/** 按天倒序的笔记数组：[{day, text, at}] */
export function readNotes(db, aid) {
  return readRaw(db, aid)
    .filter((x) => x && x.day && x.text)
    .map((x) => ({ day: String(x.day), text: String(x.text), at: x.at || '' }))
    .sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0))
}

/** 写一天（同一天覆盖），只留最近七天。返回写入后的条数。 */
export function writeNote(db, aid, day, text) {
  const clean = String(text || '').trim()
  if (!clean || !day) return readNotes(db, aid).length
  const map = new Map(readNotes(db, aid).map((x) => [x.day, x]))
  map.set(String(day), { day: String(day), text: clean.slice(0, 400), at: now() })
  const list = [...map.values()]
    .sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0))
    .slice(0, KEEP)
  db.prepare('INSERT INTO flags(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(KEY(aid), JSON.stringify(list))
  return list.length
}

/** 清空（整删意识体 / 测试用）。 */
export function clearNotes(db, aid) {
  db.prepare('DELETE FROM flags WHERE key=?').run(KEY(aid))
}

const clip = (s, n) => {
  const a = Array.from(String(s || '').replace(/\s+/g, ' ').trim())
  return a.length > n ? a.slice(0, n).join('') + '…' : a.join('')
}
const shortDay = (d) => String(d || '').slice(5)

/**
 * 注入用的那几行。
 * 今天是「早些时候我写下的」，往前两天合并成一行，别一句占一大段。
 * @returns {string[]}
 */
export function selfNoteLines(db, aid, opt = {}) {
  const today = opt.today || now().slice(0, 10)
  const notes = readNotes(db, aid)
  if (!notes.length) return []
  const todayNote = notes.find((x) => x.day === today)
  const older = notes.filter((x) => x.day !== today).slice(0, 2)
  const out = []
  if (todayNote) out.push('早些时候我写下的（现在看可能已经不一样了）：' + clip(todayNote.text, 200))
  if (older.length) {
    out.push('前两天写下的：' + older.map((x) => shortDay(x.day) + '：' + clip(x.text, 90)).join('；'))
  }
  return out
}
