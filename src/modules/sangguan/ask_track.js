/**
 * 三观「待问」跟踪：问了几次、有没有说出口。
 * 从 inject 拆出，避免 fast → inject → liveness → fast 成环。
 */
import { getFlag, setFlag } from '../../kernel.js'

export const ASK_CAP = 3
const askKey = (aid) => 'sangguan.ask:' + aid

export function askState(db, aid) {
  try {
    const v = JSON.parse(getFlag(db, askKey(aid)) || 'null')
    if (v && typeof v === 'object') return { id: null, question: '', shown: 0, asked: false, ...v }
  } catch { /* 坏记录当空 */ }
  return { id: null, question: '', shown: 0, asked: false }
}

export function saveAsk(db, aid, st) {
  setFlag(db, askKey(aid), JSON.stringify(st))
}

/** 这问已经问出口，或已经塞进提示词 ASK_CAP 次，就不再注入。 */
export function askClosed(st, id) {
  return !!(st && st.id === id && (st.asked || st.shown >= ASK_CAP))
}

/** 助手已经把这问说出口（字面包含或足够像）就停。 */
export function noteAskSpoken(db, aid, text) {
  const st = askState(db, aid)
  if (!st.id || st.asked || !st.question) return false
  const q = String(st.question).replace(/[\s？?。！!，,、]/g, '')
  const a = String(text || '').replace(/[\s？?。！!，,、]/g, '')
  if (!q || !a.includes(q.slice(0, Math.min(q.length, 16)))) return false
  st.asked = true
  saveAsk(db, aid, st)
  return true
}

export function noteAskDelivered(db, aid, id, question) {
  const st = askState(db, aid)
  const next = st.id === id ? st : { id, question: question || '', shown: 0, asked: false }
  if (next.asked || next.shown >= ASK_CAP) return
  next.shown += 1
  if (question) next.question = question
  saveAsk(db, aid, next)
}
