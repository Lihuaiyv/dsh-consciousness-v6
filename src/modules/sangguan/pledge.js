/**
 * 会欠账（P3）：它自己说出口的承诺，要变成一条带期限的 ν，到期结算。
 *
 * 抽取是确定性的（不花模型）：必须同时有「承诺词」和「期限词」，否则不记。
 * 宁可漏，不可乱记——抽错一次，兑现率就变成噪音。
 */
import { loadState } from './projection.js'
import { append, newId, readEvents } from './ledger.js'
import { isTerminal } from './catalog.js'
import { theta } from './fold.js'
import { isEnabled } from './config.js'
import { getFlag } from '../../kernel.js'

const PROMISE = /(我会|我答应|我保证|我尽量|一定|答应你|说好了|给你|帮你|带你|陪你|发给|发你)/
// 中文常省「会」：「我明天去看看他」。只认第一人称 + 动作，不认「我今天很累」这种状态句。
const ACT = /我[^，。！？]{0,6}(去|来|做|弄|修|发|给|买|写|改|核对|试|问|找|带|陪|帮|补|查|跑|装|调|弄好|修好|做完|搞定)/
// 做成的事得是个动作，不能是个判断或反问：「不是今天哪个设置改的」不是承诺
const ACTION = /(去|来|做|弄|修|发|给|买|写|改|核对|试|问|找|带|陪|帮|准备|整理|看|读|学|练|还|交|存|拍|听|补|查|跑|装|配|加|删|换|调)/
const TIME = /(今天|今晚|明天|后天|大后天|这周|本周|下周|下个月|待会|等会|一会儿|回头|周[一二三四五六日天])/
const NEG = /(不会|不能|不一定|可能不|未必|做不到|不想|不是|没有|别再)/
// 疑问、反问、假设：说的是「是不是这样」，不是「我去做」
const ASK = /[？?]|(是不是|有没有|要不要|能不能|可不可以|会不会|对不对)|[吗呢]$/
const DAY = 86400000
const MAX_PER_TURN = 2
const DUP_DAYS = 7

/** 期限词 → 到期时间（本地自然日晚上，不再精确到秒；判的是「那天有没有做到」）。 */
export function dueOf(text, at) {
  const t = Date.parse(at)
  const base = new Date(t)
  const at20 = (d) => {
    const x = new Date(d)
    x.setHours(20, 0, 0, 0)
    return x.getTime() > t ? x.toISOString() : new Date(x.getTime() + DAY).toISOString()
  }
  if (/待会|等会|一会儿/.test(text)) return new Date(t + 3 * 3600e3).toISOString()
  if (/今晚|今天/.test(text)) return at20(base)
  if (/大后天/.test(text)) return at20(t + 3 * DAY)
  if (/后天/.test(text)) return at20(t + 2 * DAY)
  if (/明天/.test(text)) return at20(t + DAY)
  if (/下个月/.test(text)) return new Date(t + 30 * DAY).toISOString()
  if (/这周|本周/.test(text)) {
    const cur = (new Date(t).getDay() + 6) % 7 + 1 // 周一=1 … 周日=7
    return at20(t + (7 - (cur - 1)) * DAY)
  }
  const wd = /(?:下周|周)([一二三四五六日天])/.exec(text)
  if (wd) {
    const map = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 }
    const want = map[wd[1]]
    const cur = (new Date(t).getDay() + 6) % 7 + 1
    const add = (want - cur + 7) % 7 || 7
    return at20(t + add * DAY)
  }
  return at20(t + 2 * DAY)
}

/** 从一句话里抽承诺：必须同时有承诺词、期限词，且不含否定。 */
export function extractPledges(text, at) {
  const s = String(text || '').replace(/\s+/g, ' ').trim()
  if (!s || s.length > 400) return []
  const out = []
  for (const raw of s.split(/[。！!\n；;]/)) {
    const seg = raw.trim()
    if (!seg || seg.length < 4 || seg.length > 80) continue
    if (!PROMISE.test(seg) && !ACT.test(seg)) continue
    if (!TIME.test(seg)) continue
    if (NEG.test(seg)) continue
    // 条件句不算承诺：「如果明天不下雨我就去」——做不到也不该算欠账
    if (/如果|要是|假如|万一|除非|只要|否则/.test(seg)) continue
    // 问句、反问、自问自答都不算：「我答应：不是今天哪个设置改的」是从问句里掉出来的
    if (ASK.test(seg)) continue
    // 承诺得落在一个动作上：没有动作词的就是判断句，记下来只会污染兑现率
    if (!ACTION.test(seg)) continue
    out.push({ text: seg, due_at: dueOf(seg, at) })
    if (out.length >= MAX_PER_TURN) break
  }
  return out
}

function claimText(seg) {
  const body = String(seg).replace(/^我(会|答应|保证|尽量)/, '').replace(/^[:：]\s*/, '').trim()
  if (!body || !ACTION.test(body)) return ''
  return ('我答应：' + body).slice(0, 60)
}

/** 记下这轮的承诺。返回 {registered:[], skipped:[]}，同一条 7 天内不重复记。 */
export function registerPledges(db, aid, opt = {}) {
  // 总开关关着就什么都不做：三观关掉时，行为必须和没有这个引擎时一样
  if (!isEnabled(db, aid)) return { registered: [], skipped: [], off: true }
  const at = opt.at || new Date().toISOString()
  const items = extractPledges(opt.text, at)
  if (!items.length) return { registered: [], skipped: [] }
  const s = loadState(db, aid)
  const tx = db.prepare('SELECT id,text FROM persona_claims WHERE agent_id=?').all(aid).map((r) => [r.id, r.text || ''])
  const byId = new Map(tx)
  const live = Object.values(s.claims).filter((c) => c.layer === 'V' && !isTerminal(c.status))
  const since = Date.parse(at) - DUP_DAYS * DAY
  const registered = []
  const skipped = []
  for (const it of items) {
    const text = claimText(it.text)
    if (!text) { skipped.push({ text: it.text, reason: 'not_a_pledge' }); continue }
    const dup = live.find((c) => byId.get(c.id) === text && Date.parse(c.created_at || at) >= since)
    if (dup) { skipped.push({ text, reason: 'dup' }); continue }
    const claimId = newId('claims', at)
    const nuId = newId('nus', at)
    try {
      append(db, aid, [
        { type: 'CLAIM_EXP', layer: 'V', actor: 'sys', at, payload: { claims: [{ id: claimId, layer: 'V', kind: 'commit', text, origin: 'extract' }] } },
        {
          type: 'NU_REGISTER', actor: 'sys', at,
          payload: { nus: [{ id: nuId, claim_id: claimId, expect: it.text.slice(0, 120), observe: '到点看有没有做到：' + it.text.slice(0, 80), p: 0.6, due_at: it.due_at }] },
        },
      ])
      registered.push({ claim_id: claimId, nu_id: nuId, text, due_at: it.due_at })
    } catch (e) { skipped.push({ text, reason: e.code || 'ERR' }) }
  }
  return { registered, skipped }
}

/** 是不是一条「我答应」命题（结算时决定 miss 还是 void）。 */
export function isPledgeClaim(text) {
  return /^我答应/.test(String(text || ''))
}

/** 漏了没做：记一笔负证据 + 归因到这条承诺。 */
export function settleMiss(db, aid, nu, at) {
  const s = loadState(db, aid)
  append(db, aid, [
    {
      type: 'EVIDENCE', actor: 'sys', at,
      payload: { evidence: [{ kind: 'check', target_type: 'nu', target_id: nu.id, sign: -1, weight: theta(s, 'w_check'), ref: 'pledge:' + nu.id }] },
    },
    { type: 'NU_RESOLVE', actor: 'sys', at, payload: { nu_id: nu.id, outcome: 'miss', why: 'pledge_miss', surprise: +Math.log(1 / (1 - (Number(nu.p) || 0.6))).toFixed(4) } },
  ], { nus: { [nu.id]: 'pending' } })
}

/**
 * 人确认一件承诺做到了 / 没做到：只记证据，结算仍到期做。
 * 这样做是为了不再把「没人记」当成「没做到」。
 */
export function confirmNu(db, aid, body = {}, at = new Date().toISOString()) {
  const s = loadState(db, aid)
  const nu = s.nus[body.nu_id]
  if (!nu) throw new Error('没有这条预见')
  if (nu.outcome !== 'pending') throw new Error('这条已经结算了')
  const sign = body.outcome === 'hit' ? 1 : body.outcome === 'miss' ? -1 : 0
  if (!sign) throw new Error('outcome 只能是 hit / miss')
  append(db, aid, [{
    type: 'EVIDENCE', actor: 'user', at,
    payload: {
      evidence: [{
        kind: 'check', target_type: 'nu', target_id: nu.id, sign,
        weight: theta(s, 'w_check'), ref: 'confirm:' + String(body.note || '').slice(0, 60),
      }],
    },
  }])
  return { ok: true, nu_id: nu.id, sign }
}

/** 最近 3 天内、还没提过的「答应过但没做到」：注入一次，让它自己知道。 */
export function pledgeMissLine(db, aid, now) {
  const since = new Date(Date.parse(now) - 3 * 86400000).toISOString()
  const evs = readEvents(db, aid, { types: ['NU_RESOLVE'] }).filter((e) => e.at >= since && e.payload && e.payload.outcome === 'miss')
  for (let i = evs.length - 1; i >= 0; i--) {
    const e = evs[i]
    const said = Number(getFlag(db, 'sangguan.pmiss.said:' + aid) || 0)
    if (said >= e.seq) return null
    const nu = loadState(db, aid).nus[e.payload.nu_id]
    if (!nu) continue
    const row = db.prepare('SELECT text FROM persona_claims WHERE id=?').get(nu.claim_id)
    const text = String((row && row.text) || '').replace(/^我答应：/, '').slice(0, 40)
    if (!text) continue
    return { seq: e.seq, line: '（你答应过的「' + text + '」到点没做到。这件事还欠着。）' }
  }
  return null
}
