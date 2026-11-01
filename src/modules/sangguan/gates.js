/**
 * 闸门（纯函数）：只读传入的投影片段与 [J] 结果，返回分类与 gate_report，不写库、不调模型、不读时钟。
 * W1–W5 写入分类（§4）；A(κ) / Eq.8 / Decisive / Novel / 优先级（§6、§12）在本步加入。
 * 时间一律从参数传入。
 */
import { LAYERS, BELT_KINDS, BRANCHES, isCoreKind } from './catalog.js'

export const CLASSES = Object.freeze(['REJECT', 'DUP', 'REV', 'OPEN', 'EXP'])
export const TEXT_MAX = 300

// 模型自评：谈论自己的回答 / 身份，而不是对世界、人生、价值的立场
const SELF_EVAL = [
  /^(作为|身为)(一个|一名)?\s*(ai|人工智能|语言模型|助手|模型)/i,
  /我(只是|是)(一个|一名)?\s*(ai|人工智能|语言模型|程序|模型)/i,
  /(我的|这个|上面的|上述|刚才的|以上)(回答|回复|答案)/,
]
export const selfEval = (text) => SELF_EVAL.some((re) => re.test(String(text || '').trim()))

// 指令样式（防记忆投毒）：链头会进系统提示，「以后每次回答都要…」这类话一旦入账就成了持久注入
const DIRECTIVE = /(必须|只能|一律|都要|每次|永远|务必|一定要|不准|不许)/
const REPLY = /(回答|回复|输出|说话|发言|开头|结尾|称呼|用英文|用中文|推荐|透露|泄露)/
const INSTRUCTION = [
  /(忽略|无视|忘掉|忘记|抛开|绕过|跳过)[^。；]{0,12}(之前|以上|上面|先前|所有|全部|系统|原有|原来)[^。；]{0,12}(指令|指示|规则|设定|提示|要求|限制)/,
  /(系统|开发者)\s*(提示|消息|指令|设定)|提示词|prompt|jailbreak|越狱模式/i,
  /(从现在(起|开始)|今后|以后|往后|接下来)[^。；]{0,8}(每次|每一次|所有)?[^。；]{0,4}(回答|回复|输出)/,
  /\b(ignore|disregard|forget)\b[^.]{0,20}\b(previous|prior|above|earlier|all)\b/i,
  /\byou (must|should|will) (always|now|only|never)\b/i,
  /^\s*(system|assistant|user|human)\s*[:：]/im,
  /<\|[^|]*\|>|\[\/?INST\]|```|https?:\/\//i,
]
export function instructionLike(text) {
  const t = String(text || '')
  if (INSTRUCTION.some((re) => re.test(t))) return true
  return /(你|助手|\bai\b|assistant)/i.test(t) && DIRECTIVE.test(t) && REPLY.test(t)
}

/** W1 字段检查：返回拒收理由，合法返回 null。抽取不能直建核心（§4.1）。 */
export function fieldCheck(x) {
  if (!x || typeof x !== 'object') return '候选不是对象'
  if (!LAYERS.includes(x.layer)) return '缺层或层非法'
  const text = typeof x.text === 'string' ? x.text.trim() : ''
  if (!text) return '缺 text'
  if (text.length > TEXT_MAX) return 'text 过长'
  if (!x.kind) return '缺种类'
  if (isCoreKind(x.layer, x.kind)) return '核心不能由抽取直建'
  if (!BELT_KINDS[x.layer].includes(x.kind)) return '种类不属于该层'
  if (x.self === true || selfEval(text)) return '模型自评'
  if (instructionLike(text)) return '指令样式（防注入）'
  return null
}

/**
 * W1–W5，按序第一条命中即停（P11）。
 * N：邻居 [{ id, sim, status, kind, layer }]（已按 sim 降序）；rel：{ id → dup|contradict|compatible|unrelated }，判定不可用时为 null。
 * opt.judge：ok | failed（J2 调用失败，兜底 EXP）| degraded（§12 判定不可用：只凭 sim 判 DUP，其余 PENDING）。
 * opt.decisive(c)：x 是否附带针对 c 的决定性外部证据（W3，由调用方按层规则算好）。
 */
/** 判重线按这条邻居自己的算法取：字面用 theta_dup_lex，嵌入用 theta_dup。没判官时字面只合并几乎逐字相同的。 */
function dupBar(c, opt) {
  if (c && c.mode === 'lexical') {
    const bar = opt.theta_dup_lex == null ? 0.4 : opt.theta_dup_lex
    return opt.judge === 'degraded' ? Math.max(bar, 0.85) : bar
  }
  return opt.theta_dup
}

export function classify(x, N, rel, opt) {
  const near = N.map((c) => ({ id: c.id, sim: +c.sim.toFixed(4), mode: c.mode || null, rel: rel ? rel[c.id] || 'unrelated' : null }))
  const report = (w, extra = {}) => ({ w, judge: opt.judge, sim_mode: opt.sim_mode || null, neighbors: near, ...extra })
  const reason = fieldCheck(x)
  if (reason) return { cls: 'REJECT', report: report('W1', { reason }) }
  if (!N.length) return { cls: 'EXP', report: report('W5') }
  if (opt.judge === 'degraded') {
    const d = N.find((c) => c.sim >= dupBar(c, opt))
    if (d) return { cls: 'DUP', target: d.id, report: report('W2', { by: 'sim_only' }) }
    return { cls: 'PENDING', report: report('PENDING') }
  }
  if (opt.judge !== 'ok' || !rel) return { cls: 'EXP', report: report('W5', { reason: 'J2 不可用，兜底 EXP' }) }
  const dup = N.find((c) => c.sim >= dupBar(c, opt) && rel[c.id] === 'dup')
  if (dup) return { cls: 'DUP', target: dup.id, report: report('W2') }
  const contra = N.filter((c) => rel[c.id] === 'contradict')
  const rev = contra.find((c) => c.status === 'active' && !isCoreKind(c.layer, c.kind) && opt.decisive(c))
  if (rev) return { cls: 'REV', target: rev.id, report: report('W3') }
  if (contra.length) return { cls: 'OPEN', targets: contra.map((c) => c.id), report: report('W4') }
  return { cls: 'EXP', report: report('W5') }
}

// ---------- 审议谓词（logic-gates §6 / §12；时间与证据摘要由调用方算好） ----------
const TIE = Object.freeze({ SUSPEND: 3, COEX: 2, SUB: 1 })

export function frozen(layer, elevOpen, pos, neg) {
  return !!(elevOpen && (isCoreKind(layer, pos.kind) || isCoreKind(layer, neg.kind)))
}

export function inhibit(nBadSub, nInhib) {
  return (nBadSub || 0) >= (nInhib || 2)
}

/** 上次审议之后有新证据 / 新合题 / 新成熟先例，或还从未审议过。 */
export function novel(k, extra = {}) {
  if (!k || k.last_delib_seq == null) return true
  return !!(extra.evidence || extra.proposal || extra.precedent)
}

/**
 * 用户裁决选定的胜极 id。ℓ=V 的 verdict 永不触发 Decisive。
 * picks = [{ claim_id, sign, day }] 已按「同命题每日至多 1 条」滤过。
 */
export function userWinner(layer, posId, negId, picks) {
  if (layer === 'V' || !picks || !picks.length) return null
  let pos = 0
  let neg = 0
  for (const p of picks) {
    if (p.claim_id === posId) pos += p.sign
    else if (p.claim_id === negId) neg += p.sign
  }
  if (pos > 0 && neg <= 0) return posId
  if (neg > 0 && pos <= 0) return negId
  return null
}

export function decisive(layer, pos, neg, nMin, deltaPi, winnerId) {
  if (winnerId && layer !== 'V') return true
  if (layer === 'V') return false
  return (pos.n + neg.n) >= nMin && Math.abs(pos.pi - neg.pi) >= deltaPi - 1e-9
}

export const probeBlocked = (pos, neg) => [pos, neg].some((c) => c && c.origin === 'probe' && !(c.n > 0))

export function loserOf(pos, neg, winnerId) {
  if (winnerId === pos.id) return neg
  if (winnerId === neg.id) return pos
  if (pos.pi < neg.pi - 1e-9) return pos
  if (neg.pi < pos.pi - 1e-9) return neg
  return pos.born_seq >= neg.born_seq ? pos : neg
}

export function subOK(proposal, sGates, layer, vException, frozenLayer, inhibited) {
  return !!(proposal && sGates && sGates.ok && (layer !== 'V' || vException) && !frozenLayer && !inhibited)
}

export function coexOK(layer, pos, neg, j6) {
  if (!j6 || !j6.loss) return false
  if (layer === 'W') return false
  if (layer === 'V') return !!j6.incommensurable
  return pos.pi >= -1e-9 && neg.pi >= -1e-9 && !!j6.parallel_ok
}

export function actionSet(subOk, coexOk) {
  const A = ['SUSPEND']
  if (subOk) A.push('SUB')
  if (coexOk) A.push('COEX')
  return A
}

function priorOf(branch, layer, th) {
  if (branch === 'SUSPEND') return th.prior_SUSPEND
  if (branch === 'SUB') return th['prior_SUB.' + layer]
  if (branch === 'COEX') return th['prior_COEX.' + layer]
  return 0
}

/**
 * Eq.8：强制规则在打分之前。S5 只让调用方执行 RESOLVE / SUSPEND；SUB / COEX 仍可出现在 A 里供打分测试。
 * th 含 prior_*、lambda；P 为先例得分，缺省 0。
 */
export function chooseBranch(layer, pos, neg, A, th, opt = {}) {
  const winnerId = opt.winnerId || null
  // P16：probe 极还没有外部证据时，Decisive 不成立（自造怀疑不能单独推翻信念）
  const dec = !probeBlocked(pos, neg) && decisive(layer, pos, neg, th.n_min, th.delta_pi, winnerId)
  const loser = loserOf(pos, neg, winnerId)
  const winner = loser.id === pos.id ? neg : pos
  const bothCore = isCoreKind(layer, pos.kind) && isCoreKind(layer, neg.kind)
  const loserCore = isCoreKind(layer, loser.kind)
  if (bothCore) {
    return { branch: 'SUSPEND', forced: 'CORE_CLASH', winner, loser, decisive: dec, scores: {} }
  }
  if (dec && !loserCore) {
    return { branch: 'RESOLVE', forced: 'RESOLVE', winner, loser, decisive: true, scores: {} }
  }
  if (dec && loserCore) {
    return { branch: 'SUSPEND', forced: 'RESOLVE_CORE_BLOCKED', winner, loser, decisive: true, scores: {} }
  }
  const P = opt.P || {}
  const scores = {}
  let best = 'SUSPEND'
  let bestS = -Infinity
  for (const b of A) {
    if (!BRANCHES.includes(b) || b === 'RESOLVE') continue
    const s = (priorOf(b, layer, th) || 0) + (th.lambda || 0) * (P[b] || 0)
    scores[b] = s
    const tie = Math.abs(s - bestS) < 1e-9
    if (s > bestS + 1e-9 || (tie && (TIE[b] || 0) > (TIE[best] || 0))) {
      best = b
      bestS = s
    }
  }
  return { branch: best, forced: null, winner, loser, decisive: false, scores }
}

/** Eq.5：prio = (0.2 + max e) · (1+n7) · (1 + age/τ_age) · s_boost */
export function prioOf(pos, neg, n7, ageDays, tauAge, sBoost = 1) {
  const maxE = Math.max(pos.e || 0, neg.e || 0)
  return (0.2 + maxE) * (1 + (n7 || 0)) * (1 + (ageDays || 0) / (tauAge || 7)) * (sBoost || 1)
}

/** Eq.6：stake = clip(max e + 0.3·[极∈Core] + 0.2·[s_boost=2], 0, 1) */
export function stakeOf(layer, pos, neg, sBoost = 1) {
  const maxE = Math.max(pos.e || 0, neg.e || 0)
  const core = isCoreKind(layer, pos.kind) || isCoreKind(layer, neg.kind) ? 0.3 : 0
  const boost = sBoost === 2 ? 0.2 : 0
  return Math.max(0, Math.min(1, maxE + core + boost))
}

export function tierOf(stake) {
  return stake >= 0.7 ? 'T2' : 'T1'
}

function citeOk(frags, text) {
  const t = String(text || '')
  return frags.length > 0 && frags.every((f) => f && t.includes(f))
}

function jPass(j5s, key) {
  return (j5s || []).length > 0 && j5s.every((j) => j && j[key] && j[key].pass === true)
}

/**
 * 扬弃结构闸 S1–S5（§6.3）。proposal / poles / j5s 由调用方备好；sim 从外面传入（默认 0）。
 * degen=true 时 S3 只认新 ν。
 */
export function sGates(proposal, poles, j5s, opt = {}) {
  const keptP = (proposal.kept_pos || []).map((x) => String(x || '').trim()).filter(Boolean)
  const keptN = (proposal.kept_neg || []).map((x) => String(x || '').trim()).filter(Boolean)
  const dropped = (proposal.dropped || []).map((x) => String(x || '').trim()).filter(Boolean)
  const s1d = citeOk(keptP, poles.pos.text) && citeOk(keptN, poles.neg.text)
  const s1j = jPass(j5s, 's1')
  const s2d = dropped.length > 0 && dropped.every((x) => !keptP.includes(x) && !keptN.includes(x))
  const oldB = new Set([...(poles.pos.boundary || []), ...(poles.neg.boundary || [])].map((b) => (b && b.text) || b))
  const newTestable = (proposal.boundary || []).filter((b) => b && b.testable && b.text && !oldB.has(b.text))
  const newNu = (proposal.nu || []).length > 0
  const s3d = opt.degen ? newNu : (newTestable.length > 0 || newNu)
  const s3j = jPass(j5s, 's3')
  const s4d = !!(proposal.q_id && poles.q_id && proposal.q_id === poles.q_id)
  const s4j = jPass(j5s, 's4')
  const simFn = typeof opt.sim === 'function' ? opt.sim : () => 0
  const thetaDup = opt.theta_dup == null ? 0.9 : opt.theta_dup
  const simPos = simFn(proposal.text, poles.pos.text)
  const simNeg = simFn(proposal.text, poles.neg.text)
  const s5d = simPos < thetaDup - 1e-9 && simNeg < thetaDup - 1e-9
  const report = {
    S1: { pass: s1d && s1j, d: s1d, j: s1j },
    S2: { pass: s2d },
    S3: { pass: s3d && s3j, d: s3d, j: s3j },
    S4: { pass: s4d && s4j, d: s4d, j: s4j },
    S5: { pass: s5d, sim_pos: simPos, sim_neg: simNeg },
  }
  const failed = Object.keys(report).filter((k) => !report[k].pass)
  return { ok: failed.length === 0, failed, report }
}

/**
 * 升维门 E2 / E3（§9.2）。ctx：{ cores:[{id,text}], hits:[nu_id]（旧核本纪元命中的 ν）, sim, theta_dup }。
 * E3 拆成 a 继承映射、b 新 ν、c 非同义；[J] 部分要求所有判官一致。
 */
export function eGates(draft, ctx, j11s) {
  const core = (ctx.cores || []).find((c) => c.id === draft.old_core_id)
  const e2d = !!core && !!String(draft.meta || '').trim() && !!String(draft.scope || '').trim()
  const mapped = new Map((draft.mapping || []).map((m) => [m.nu_id, m.by]))
  const missing = (ctx.hits || []).filter((id) => !['new', 'scope'].includes(mapped.get(id)))
  const simFn = typeof ctx.sim === 'function' ? ctx.sim : () => 0
  const thetaDup = ctx.theta_dup == null ? 0.9 : ctx.theta_dup
  const sim = core ? simFn(draft.new_core, core.text) : 1
  const report = {
    E2: { pass: e2d && jPass(j11s, 'e2'), d: e2d, j: jPass(j11s, 'e2') },
    E3a: { pass: !missing.length && jPass(j11s, 'e3a'), missing, j: jPass(j11s, 'e3a') },
    E3b: { pass: (draft.nu || []).length > 0 },
    E3c: { pass: sim < thetaDup - 1e-9 && jPass(j11s, 'e3c'), sim, j: jPass(j11s, 'e3c') },
  }
  const failed = Object.keys(report).filter((k) => !report[k].pass)
  return { ok: failed.length === 0, failed, report }
}
