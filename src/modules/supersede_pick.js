/**
 * S3：有界指认式 supersede（M1）。
 *
 * 不再让模型自由判「像不像同一件事」，只让它从候选旧条里选：
 * 「哪几条被这条新事实否定 / 取代了」——没有就返回空数组。
 *
 * 输入是有界列表（最多 3 条），输出是编号数组；规则闸和短文本先筛，
 * 失败（超时 / 非法 JSON / 没模型）一律不指认，宁可不改。
 */
import { ruleGate } from './pair_judge.js'

export const PICK_SYS = [
  '你在判断一条新事实是否让旧事实不再成立。',
  '从候选旧条里选出「被新事实否定、改口或取代」的条目；没有就返回空数组。',
  '每一条都必须附一句新事实里的原文作为证据（quote），不能是解释，要原文。',
  '只输出 JSON：{"invalidate":[{"i":1,"quote":"新事实里否定了它的那句原文"}]} 或 {"invalidate":[]}。',
  '注意：只是同一个话题、同一个专有名词，不算；旧条被新条明确否定、改口、或值变了才算。',
  '两条都只是在描述情绪 / 感受 / 状态，不算取代。',
].join('\n')

const MIN_LEN = 12

function withTimeoutMs(promise, ms) {
  let timer = null
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('pick timeout'), { code: 'timeout' })), Math.max(1, Number(ms) || 6000))
  })
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => { if (timer) clearTimeout(timer) })
}

export function pickPrompt(oldCandidates, newer) {
  const list = (Array.isArray(oldCandidates) ? oldCandidates : [])
    .map((r, i) => (i + 1) + '. ' + String((r && r.text) || '').replace(/\s+/g, ' ').slice(0, 140) + '（' + String((r && r.created_at) || '').slice(0, 10) + '）')
  return '新事实（' + String((newer && newer.created_at) || '').slice(0, 10) + '）：'
    + String((newer && newer.text) || '').replace(/\s+/g, ' ').slice(0, 200)
    + '\n候选旧条：\n' + list.join('\n')
}

/** 解析 {"invalidate":[..]} 或 [..]；非法返回 ok:false。 */
export function parsePick(raw, n) {
  let t = String(raw || '').trim()
  t = t.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  let obj = null
  try { obj = JSON.parse(t) } catch { /* 再抠花括号/方括号 */ }
  if (!obj) {
    const m = t.match(/\{[\s\S]*\}/) || t.match(/\[[\s\S]*\]/)
    if (m) { try { obj = JSON.parse(m[0]) } catch { obj = null } }
  }
  if (!obj) return { ok: false, invalidate: [], quotes: {} }
  const arr = Array.isArray(obj) ? obj : (Array.isArray(obj.invalidate) ? obj.invalidate : null)
  if (!arr) return { ok: false, invalidate: [], quotes: {} }
  const out = []
  const quotes = {}
  for (const x of arr) {
    let k = 0
    let q = ''
    if (typeof x === 'number') k = x
    else if (x && typeof x === 'object') { k = Number(x.i); q = String(x.quote || '') }
    else continue
    if (!Number.isInteger(k) || k < 1 || k > n || out.includes(k)) continue
    out.push(k)
    if (q) quotes[k] = q
  }
  return { ok: true, invalidate: out, quotes }
}

/**
 * 指认。永远 resolve，不抛。
 * @returns {Promise<{invalidate:number[], ok:boolean, skipped:string|null, raw:string, ms:number}>}
 */
export async function pickSuperseded(opt = {}) {
  const { oldCandidates, newer, complete, timeoutMs = 6000, minLen = MIN_LEN } = opt
  const t0 = Date.now()
  const cands = (Array.isArray(oldCandidates) ? oldCandidates : []).filter((r) => r && r.id)
  const done = (extra) => ({ invalidate: [], ok: false, skipped: null, raw: '', ms: Date.now() - t0, ...extra })
  if (!cands.length) return done({ ok: true, skipped: 'no-candidates' })

  // 短文本：没有上下文，模型也容易乱指认
  if (String((newer && newer.text) || '').trim().length < minLen) return done({ skipped: 'too-short' })

  // 专名闸：共享专名但主题不同 → 这条候选不可指认
  const gated = new Set()
  cands.forEach((r, i) => {
    try {
      const g = ruleGate(r, newer)
      if (g && g.verdict === 'unrelated') gated.add(i + 1)
    } catch { /* 闸失败就不闸 */ }
  })
  const usable = cands.filter((_, i) => !gated.has(i + 1))
  if (!usable.length) return done({ skipped: 'rule' })

  if (typeof complete !== 'function') return done({ skipped: 'no-model' })

  let raw = ''
  try {
    raw = await withTimeoutMs(complete({ system: PICK_SYS, text: pickPrompt(cands, newer) }), timeoutMs)
  } catch {
    return done({ skipped: 'timeout' })
  }
  const parsed = parsePick(raw, cands.length)
  if (!parsed.ok) return done({ skipped: 'bad-json', raw: String(raw).slice(0, 120) })
  // 引文校验：必须能指出一句出现在新事实里的原文，指不出来就不认。
  // 这是对「QQ 通联记录 / 图库分布被判取代」那两次误判的修正——没有原文证据就不动手。
  const norm = (x) => String(x || '').replace(/[\s\p{P}]/gu, '')
  const newerNorm = norm(newer && newer.text)
  const final = []
  let noQuote = 0
  for (const k of parsed.invalidate) {
    if (gated.has(k)) continue
    const q = norm(parsed.quotes[k])
    if (!q || q.length < 2 || !newerNorm.includes(q)) { noQuote++; continue }
    final.push(k)
  }
  return { invalidate: final, ok: true, skipped: noQuote ? 'no-quote' : null, raw: String(raw).slice(0, 200), ms: Date.now() - t0 }
}
