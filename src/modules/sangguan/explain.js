/**
 * 「为什么持有这个看法」（S12，J19）：事实全部取自账本与投影，先拼出模板句；模型只润色，
 * 润色里出现模板没有的数字即拒收；没模型 / 没预算 / 不合格 → 直接给模板句。只读，不写账本。
 */
import { loadState } from './projection.js'
import { readEvents } from './ledger.js'
import { isTerminal } from './catalog.js'
import { call } from './llm.js'
import './templates.js'

const ORIGIN_WORD = {
  extract: '在对话里慢慢总结出来', seed: '从原先的性格倾向推出来', synth: '把两种说法合在一起得来',
  elev: '在换掉旧核心时立起来', user: '你直接告诉我的', probe: '在自我质疑时冒出来', abduce: '为了解释说不通的事提出来',
}
const SIGMA_WORD = {
  struggle: '还在拉扯', suspended: '先放着没定', sub_trial: '正在试一个合起来的说法', coexist: '决定两样都要',
  resolved: '已经分出了高下', sublated: '已经合成了新说法',
}
const STATUS_WORD = {
  active: '', contested: '眼下它正被质疑。', provisional: '它还在试用期。',
  superseded: '后来它被新说法取代了。', falsified: '后来它被事实推翻了。', sublated: '后来它被合进了新说法。',
  demoted: '后来它从核心降了下来。', withdrawn: '后来我把它收回了。',
}

const q = (t) => '「' + String(t || '').slice(0, 40) + '」'

/** 事实清单：来源、前身、证据正反、预见对错、矛盾、引用它的先例。 */
export function factsOf(db, aid, claimId) {
  const s = loadState(db, aid)
  const c = s.claims[claimId]
  const row = db.prepare('SELECT text, created_at FROM persona_claims WHERE agent_id=? AND id=?').get(aid, claimId)
  if (!c || !row) return null
  const text = (id) => (db.prepare('SELECT text FROM persona_claims WHERE agent_id=? AND id=?').get(aid, id) || {}).text || ''
  const ev = db.prepare('SELECT sign, kind FROM claim_evidence WHERE agent_id=? AND target_type=\'claim\' AND target_id=?').all(aid, claimId)
  const nus = Object.values(s.nus).filter((n) => n.claim_id === claimId)
  const kappas = Object.values(s.kappas).filter((k) => k.pos_id === claimId || k.neg_id === claimId)
    .map((k) => ({ id: k.id, sigma: k.sigma, other_id: k.pos_id === claimId ? k.neg_id : k.pos_id }))
  const kIds = new Set(kappas.map((k) => k.id))
  const delib = readEvents(db, aid, { types: ['DELIBERATE'] }).filter((e) => kIds.has(e.payload.kappa_id))
  return {
    id: claimId, layer: c.layer, kind: c.kind, status: c.status, origin: c.origin, pi: c.pi, n: c.n,
    text: row.text, born: row.created_at.slice(0, 10),
    pred: c.pred.map((id) => ({ id, text: text(id) })),
    evidence: { pro: ev.filter((x) => x.sign > 0).length, con: ev.filter((x) => x.sign < 0).length, verdict: ev.filter((x) => x.kind === 'verdict').length },
    nu: { hit: nus.filter((n) => n.outcome === 'hit').length, miss: nus.filter((n) => n.outcome === 'miss').length, pending: nus.filter((n) => n.outcome === 'pending').length },
    kappas: kappas.map((k) => ({ ...k, other: text(k.other_id) })),
    deliberations: delib.length,
    precedents: delib.reduce((n, e) => n + (e.precedent_ids || []).length, 0),
  }
}

/** 模板句：只用事实清单里的东西。 */
export function draftOf(f) {
  const p = []
  p.push('我会这样看' + q(f.text) + '，是因为它' + (ORIGIN_WORD[f.origin] || '慢慢形成') + '（' + f.born + '）。')
  if (f.pred.length) p.push('它是从' + f.pred.map((x) => q(x.text)).join('和') + '改过来的。')
  const { pro, con } = f.evidence
  if (pro || con) p.push('之后有 ' + pro + ' 件事支持它、' + con + ' 件事和它相反。')
  else p.push('到现在还没有实际的事来检验它。')
  const { hit, miss } = f.nu
  if (hit || miss) p.push('用它做过的预料，对了 ' + hit + ' 次、错了 ' + miss + ' 次。')
  for (const k of f.kappas.slice(0, 2)) p.push('它和' + q(k.other) + '有过冲突，' + (SIGMA_WORD[k.sigma] || '还没有结论') + '。')
  if (f.precedents) p.push('想这些冲突时参考过 ' + f.precedents + ' 回以前类似的事。')
  if (STATUS_WORD[f.status]) p.push(STATUS_WORD[f.status])
  return p.join('')
}

/** opt：{ now, chat, polish=true }。返回 { claim_id, facts, draft, sentence, polished, code? }；命题不存在返回 null。 */
export async function explain(db, aid, claimId, opt = {}) {
  const facts = factsOf(db, aid, claimId)
  if (!facts) return null
  const draft = draftOf(facts)
  const base = { claim_id: claimId, facts, draft, sentence: draft, polished: false, terminal: isTerminal(facts.status) }
  if (opt.polish === false) return base
  const now = opt.now || new Date().toISOString()
  const r = await call({ db, aid, day: String(now).slice(0, 10), at: now, chat: opt.chat }, 'J19', { claim_id: claimId, claim: facts.text, draft })
  if (!r.ok) return { ...base, code: r.code }
  return { ...base, sentence: r.out.sentence, polished: true, cached: !!r.cached }
}
