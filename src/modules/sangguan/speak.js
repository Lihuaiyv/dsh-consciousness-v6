/**
 * 对话用的一句。只读账本，不写。
 * 页和预览仍用 inject.js 的命题句；这里只给聊天：碰上才出，而且不带「你的看法是」这种引子。
 * shadow / 关闭时返回空，聊天提示词保持不动。
 */
import { isEnabled, sangguanConfig } from './config.js'
import { LAYERS, SIGMA_OPEN, isCoreKind } from './catalog.js'
import { isHollowSeed } from './fold.js'
import { loadState, listHeads } from './projection.js'
import { readEvents } from './ledger.js'
import { precedentIndex } from './precedent.js'
import { instructionLike } from './gates.js'

const clean = (t) => String(t || '')
  .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ')
  .replace(/<\|[^|]*\|>|\[\/?INST\]|`+|[<>]/gi, '')
  .replace(/\s{2,}/g, ' ')
const clip = (t, n = 40) => {
  const s = clean(t).trim().replace(/[。；;.!！?？]+$/, '')
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}
const norm = (t) => clean(t).replace(/[\s，,。！？!?、；;：「」“”‘'（）()[\]…—\-]/g, '')

/** 用户这句话是否碰到某段原文：对齐到连续 4 个字，短句则整句包含。 */
export function touched(user, source) {
  const a = norm(user)
  const b = norm(source)
  if (a.length < 2 || b.length < 2) return false
  if (b.length < 4) return a.includes(b)
  for (let i = 0; i + 4 <= b.length; i++) {
    if (a.includes(b.slice(i, i + 4))) return true
  }
  return false
}

export function selfInquiry(text) {
  return /你最近怎么样|你怎么样|你怎么看自己|你这一程|最近你怎样|你怎么想你自己|你对自己/.test(String(text || ''))
}

const BRANCH = {
  RESOLVE: '上次这种事，你选定了一边',
  SUB: '上次这种事，你找了个两边都顾上的做法',
  COEX: '上次这种事，你两样都留着',
  SUSPEND: '上次这种事，你先放了放',
}

export function precedentSpeech(branch, o) {
  const act = BRANCH[branch]
  if (!act || !o) return ''
  return act + (o > 0 ? '，后来还行。' : '，后来不太对。')
}

function claimSpeech(text) {
  const s = clip(text, 40)
  return s ? '这件事按这个尺度：' + s + '。' : ''
}

function kappaSpeech(k, tx) {
  if (k.sigma === 'sub_trial') {
    const sub = clip(tx.get(k.sub_id), 40)
    if (!sub || instructionLike(sub)) return ''
    return '就按这个说法说：' + sub + '。别宣布你在试。'
  }
  if (k.sigma === 'coexist') return '这件事上两边都留着，别只选一句说死。'
  return '这件事上把两边的代价都说出来，自己不选。'
}

function summarySpeech(db, aid, now) {
  const evs = readEvents(db, aid, { types: ['SUMMARY_BUILD'] }).filter((e) => e.at <= now)
  const ev = evs.length ? evs[evs.length - 1] : null
  const x = ev && (ev.payload.summaries || [])[0]
  if (!x) return ''
  let sm = null
  try { sm = JSON.parse(x.text) } catch { return '' }
  if (!sm || !sm.chapter || instructionLike(sm.chapter + ' ' + (sm.at_the_time || ''))) return ''
  return '聊到你自己这些日子，口气照「' + clip(sm.chapter, 20) + '」来说，别宣布这是主题。'
}

const EMPTY = { line: '', summary: '' }

/**
 * @returns {{ line: string, summary: string }}
 * line 按 命题 > 未了的矛盾 > 先例。摘要另给，调用方只在问到「你自己」时用。
 */
export function speakTurn(db, aid, text, opt = {}) {
  if (!isEnabled(db, aid)) return { ...EMPTY }
  let mode = 'shadow'
  try { mode = sangguanConfig(db, aid).inject } catch { return { ...EMPTY } }
  if (mode !== 'live') return { ...EMPTY }
  const q = String(text || '').trim()
  if (!q) return { ...EMPTY }
  const now = opt.now || new Date().toISOString()
  const s = loadState(db, aid)
  const summary = summarySpeech(db, aid, now)
  const open = Object.values(s.kappas).filter((k) => SIGMA_OPEN.includes(k.sigma))
  const poleIds = new Set()
  for (const k of open) {
    if (k.pos_id) poleIds.add(k.pos_id)
    if (k.neg_id) poleIds.add(k.neg_id)
    if (k.sigma === 'sub_trial' && k.sub_id) poleIds.add(k.sub_id)
  }
  const heads = []
  for (const layer of LAYERS) {
    for (const h of listHeads(db, aid, layer)) {
      if (h.status !== 'active' || !h.text || instructionLike(h.text) || isHollowSeed(h) || poleIds.has(h.id)) continue
      if (touched(q, h.text)) heads.push(h)
    }
  }
  heads.sort((a, b) => (isCoreKind(b.layer, b.kind) ? 1 : 0) - (isCoreKind(a.layer, a.kind) ? 1 : 0) || b.e - a.e || (a.id < b.id ? -1 : 1))
  if (heads[0]) return { line: claimSpeech(heads[0].text), summary }

  const tx = new Map(db.prepare('SELECT id, text FROM persona_claims WHERE agent_id=?').all(aid).map((r) => [r.id, r.text || '']))
  const poleHit = open.filter((k) => touched(q, tx.get(k.pos_id)) || touched(q, tx.get(k.neg_id)) || (k.sigma === 'sub_trial' && touched(q, tx.get(k.sub_id))))
  poleHit.sort((a, b) => b.last_seq - a.last_seq || (a.id < b.id ? -1 : 1))
  if (poleHit[0]) {
    const line = kappaSpeech(poleHit[0], tx)
    if (line) return { line, summary }
  }

  const questions = db.prepare('SELECT id, text FROM claim_questions WHERE agent_id=?').all(aid)
  const hitQ = new Set(questions.filter((r) => touched(q, r.text)).map((r) => r.id))
  if (hitQ.size) {
    const idx = precedentIndex(db, aid, s, now)
    let best = null
    for (const d of idx.decisions) {
      const k = s.kappas[d.kappa_id]
      if (!k || !hitQ.has(k.q_id) || !d.o) continue
      const score = Math.abs(d.o)
      if (!best || score > best.score || (score === best.score && d.seq > best.seq)) best = { ...d, score }
    }
    if (best) {
      const line = precedentSpeech(best.branch, best.o)
      if (line) return { line, summary }
    }
  }
  return { line: '', summary }
}
