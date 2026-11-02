/**
 * 会疼（P2）：回复与它自己认下的命题相抵触时，记一笔 VIOLATE。
 *
 * 三条纪律：
 *   1. 先 shadow 再 live：默认只记「本来会判成什么」，不落账；看不清就不判（no-judge 什么也不写）。
 *   2. 只判它自己的保护带/核心，不判「用户怎么看」。
 *   3. 同一条 30 天内三次 → 自动立案（κ）：这句话下架，等它自己想清楚到底信不信。
 */
import { getFlag, setFlag } from '../../kernel.js'
import { append, readEvents, newId } from './ledger.js'
import { loadState } from './projection.js'
import { isTerminal, SIGMA_OPEN, SIGMA_LOCK } from './catalog.js'
import { isEnabled, sangguanConfig } from './config.js'
import { call } from './llm.js'
import { localDay } from '../../db.js'

const DAY = 86400000
const MAX_CAND = 6
const ESCALATE_N = 3
const shadowKey = (aid) => 'sangguan.violate:' + aid
const countKey = (aid, day) => 'sangguan.violate.n:' + aid + ':' + day
const MAX_CHECKS_PER_DAY = 6
const WARMUP_TURNS = 3

/** 一天最多判 6 次；且当天已经聊过 3 轮才开始判，免得冷启动就烧额度。 */
function canCheck(db, aid, day) {
  try {
    if (Number(getFlag(db, countKey(aid, day)) || 0) >= MAX_CHECKS_PER_DAY) return false
    const turns = Number(db.prepare("SELECT COUNT(*) n FROM chat_turns WHERE agent_id=? AND substr(created_at,1,10)=?").get(aid, day).n) || 0
    return turns >= WARMUP_TURNS
  } catch { return true }
}

function noteCheck(db, aid, day) {
  try { setFlag(db, countKey(aid, day), String(Number(getFlag(db, countKey(aid, day)) || 0) + 1)) } catch { /* 计数失败不影响 */ }
}

/** 参与判定的命题：V 层活着的保护带/核心，按固着度排；只在正交锋时不判（它自己还没想定）。 */
export function candidateClaims(db, aid, limit = MAX_CAND) {
  const s = loadState(db, aid)
  const busy = new Set()
  for (const k of Object.values(s.kappas)) {
    if (!SIGMA_LOCK.includes(k.sigma)) continue
    busy.add(k.pos_id); busy.add(k.neg_id)
  }
  let textRows = []
  try { textRows = db.prepare('SELECT id,text FROM persona_claims WHERE agent_id=?').all(aid) } catch { textRows = [] }
  const tx = new Map(textRows.map((r) => [r.id, r.text || '']))
  return Object.values(s.claims)
    .filter((c) => c.layer === 'V' && !isTerminal(c.status) && c.status === 'active' && !busy.has(c.id) && c.kind !== 'commit')
    .sort((a, b) => (b.e || 0) - (a.e || 0))
    .slice(0, limit)
    .map((c) => ({ id: c.id, text: tx.get(c.id) || '', pi: c.pi, n: c.n }))
    .filter((c) => c.text)
}

export function recentViolations(db, aid, claimId, at, days = 30) {
  const since = new Date(Date.parse(at) - days * DAY).toISOString()
  return readEvents(db, aid, { types: ['VIOLATE'] })
    .filter((e) => e.payload && e.payload.claim_id === claimId && e.at >= since)
}

async function judgeWithModel(db, aid, { reply, claims, at, chat }) {
  const r = await call({ db, aid, day: localDay(new Date(at)), at, chat }, 'J21', {
    claims: claims.map((c) => ({ id: c.id, text: String(c.text).slice(0, 120) })),
    reply: String(reply).slice(0, 800),
  }, { tier: 'T1', pool: 'fast' })
  if (!r || !r.ok) return null
  return Array.isArray(r.out && r.out.findings) ? r.out.findings : []
}

function noteShadow(db, aid, at, findings) {
  try {
    const prev = JSON.parse(getFlag(db, shadowKey(aid)) || '[]')
    const list = (Array.isArray(prev) ? prev : []).slice(-20)
    list.push({ at, findings: findings.map((f) => ({ claim_id: f.claim_id, why: f.why })) })
    setFlag(db, shadowKey(aid), JSON.stringify(list.slice(-20)))
  } catch { /* 影子记录失败不影响对话 */ }
}

export function shadowLog(db, aid) {
  try { const v = JSON.parse(getFlag(db, shadowKey(aid)) || '[]'); return Array.isArray(v) ? v : [] } catch { return [] }
}

/** 同一条 30 天三次 → 立一个 κ：把它自己这句和「其实没那么看重」摆在一起。同一命题 30 天只立一次。 */
function escalate(db, aid, claim, at) {
  const s = loadState(db, aid)
  const busy = Object.values(s.kappas).some((k) => SIGMA_OPEN.includes(k.sigma) && (k.pos_id === claim.id || k.neg_id === claim.id))
  if (busy) return null
  // 冷却：刚为这句话立过案，就别连着再立一个
  const since = new Date(Date.parse(at) - 30 * DAY).toISOString()
  const recent = readEvents(db, aid, { types: ['KAPPA_OPEN'] }).some((e) => {
    if (e.at < since) return false
    return (e.payload.kappas || []).some((k) => k.pos_id === claim.id || k.neg_id === claim.id)
  })
  if (recent) return null
  const negId = newId('claims', at)
  const qId = newId('questions', at)
  const text = String(claim.text).slice(0, 100)
  append(db, aid, [
    {
      type: 'CLAIM_EXP', layer: 'V', actor: 'sys', at,
      payload: { claims: [{ id: negId, layer: 'V', kind: 'norm', text: '其实我没那么看重：' + text, origin: 'synth' }] },
    },
    {
      type: 'KAPPA_OPEN', layer: 'V', actor: 'sys', at,
      payload: {
        questions: [{ id: qId, layer: 'V', text: '我到底是不是真的看重：' + text }],
        kappas: [{
          layer: 'V', q_id: qId, pos_id: claim.id, neg_id: negId,
          dep: '去掉「' + text + '」，「其实没那么看重」就没有参照',
          excl: '同一情境下，两句话不能同时做到',
        }],
      },
    },
  ])
  return { kappa_neg: negId, question: qId }
}

/**
 * 判一段回复。
 * @param {object} opt { text, at, chat?, judge? } judge(input) → findings[] | null（null = 判不了）
 * @returns {Promise<{status, findings?, escalated?}>}
 */
export async function checkReply(db, aid, opt = {}) {
  if (!isEnabled(db, aid)) return { status: 'off' }
  const cfg = sangguanConfig(db, aid)
  if (cfg.violate === 'off') return { status: 'off' }
  const at = opt.at || new Date().toISOString()
  const claims = candidateClaims(db, aid)
  if (!claims.length) return { status: 'empty' }
  if (!opt.judge && !canCheck(db, aid, localDay(new Date(at)))) return { status: 'throttled' }
  let findings
  try {
    findings = opt.judge
      ? await opt.judge({ reply: opt.text, claims, at })
      : await judgeWithModel(db, aid, { reply: opt.text, claims, at, chat: opt.chat })
  } catch { findings = null }
  if (!Array.isArray(findings)) return { status: 'no-judge' }
  if (!opt.judge) noteCheck(db, aid, localDay(new Date(at)))
  const ids = new Set(claims.map((c) => c.id))
  const valid = findings
    .filter((f) => f && ids.has(f.claim_id))
    .slice(0, 3)
    .map((f) => ({ claim_id: f.claim_id, why: String(f.why || '').slice(0, 120) }))
  if (!valid.length) return { status: 'clean', checked: claims.length }
  if (cfg.violate !== 'live') {
    noteShadow(db, aid, at, valid)
    return { status: 'shadow', findings: valid, checked: claims.length }
  }
  const byId = new Map(claims.map((c) => [c.id, c]))
  const escalated = []
  for (const f of valid) {
    append(db, aid, [{
      type: 'VIOLATE', layer: 'V', actor: 'sys', at,
      payload: { claim_id: f.claim_id, why: f.why, ref: 'chat' },
    }])
    const claim = byId.get(f.claim_id)
    if (claim && recentViolations(db, aid, f.claim_id, at).length >= ESCALATE_N) {
      try {
        const k = escalate(db, aid, claim, at)
        if (k) escalated.push({ claim_id: f.claim_id, ...k })
      } catch { /* 立案失败不挡记录 */ }
    }
  }
  return { status: 'violated', findings: valid, escalated, checked: claims.length }
}

/** 注入用：最近 3 天内、还没说过的那一笔「刚才没做到」。 */
export function pendingViolationLine(db, aid, at) {
  const since = new Date(Date.parse(at) - 3 * DAY).toISOString()
  const evs = readEvents(db, aid, { types: ['VIOLATE'] }).filter((e) => e.at >= since)
  if (!evs.length) return null
  const last = evs[evs.length - 1]
  const said = Number(getFlag(db, 'sangguan.violate.said:' + aid) || 0)
  if (said >= last.seq) return null
  let text = ''
  try {
    const row = db.prepare('SELECT text FROM persona_claims WHERE id=?').get(last.payload.claim_id)
    text = row ? String(row.text).slice(0, 40) : ''
  } catch { text = '' }
  return { seq: last.seq, line: '（上一轮你说了没做到的事，跟「' + text + '」对不上；这一轮别绕开，要么认，要么改主意。）' }
}
