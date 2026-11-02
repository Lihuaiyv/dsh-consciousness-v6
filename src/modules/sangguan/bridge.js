/**
 * 三观读口。下游只从这里拿三行提示词、telos 和十维权重。
 * source 为 meter 时，算法与改读口之前各处直接读旧表相同，不写账本。
 */
import { DIMS, PAIRS } from '../values.js'
import { listWorldviewRich, growWorldview, explainWorldview, worldviewPromptLine, INIT as WV_INIT } from '../worldview.js'
import { listLifeviewRich, growLifeview, explainLifeview, lifeviewPromptLine } from '../lifeview.js'
import { getFlag, setFlag } from '../../kernel.js'
import { isEnabled, sangguanConfig } from './config.js'
import { loadState, listHeads } from './projection.js'
import { readEvents } from './ledger.js'
import { SIGMA_OPEN, isTerminal, isCoreKind } from './catalog.js'
import { isHollowSeed } from './fold.js'
import { rJOf } from './verdict.js'
import { assignDims, foldDims, shadowPush, shadowVerdict } from './tags.js'
import { foldValueWeights } from './vweights.js'

function weightsOf(items) {
  const out = {}
  for (const r of items || []) {
    const v = Number(r.weight)
    if (Number.isFinite(v)) out[r.key] = v
  }
  return out
}

function valueLine(items) {
  const all = [...(items || [])].sort((a, b) => Number(b.weight) - Number(a.weight))
  const ws = all.map((v) => Number(v.weight) || 0)
  const spread = ws.length > 1 ? Math.max(...ws) - Math.min(...ws) : 0
  // 只说「抬起来的」：折算后低于均值的维不撑这句话，否则会出现「看重：仁善、普世…」里混进 0.06 的怪句子
  const rows = all.filter((v) => Number(v.weight) > 0.1 + 0.005)
  if (!rows.length || spread < 0.03) return ''
  return '你看重：' + rows.slice(0, 3).map((v) => ((DIMS.find((d) => d[0] === v.key) || [0, v.key])[1])).join('、') + '。'
}

function worldLineOf(items) {
  const rows = items || []
  const lean = rows.filter((x) => Math.abs(Number(x.weight) - WV_INIT) >= 0.08)
  return lean.length ? worldviewPromptLine(rows) : ''
}

/**
 * @returns {{ source: {W:string,L:string,V:string}, W: object, L: object, V: object }}
 */
export function readViews(db, aid, opt = {}) {
  if (isCleaned(db) && !isEnabled(db, aid)) {
    const frozen = frozenView(db, aid)
    if (frozen) return frozen
  }
  const grow = opt.grow === true && !isCleaned(db)
  const force = opt.force ? { force: true } : {}
  const only = opt.only || null
  const want = (k) => !only || only === k
  const worldview = want('W') ? (grow ? (growWorldview(db, aid, force) || []) : (listWorldviewRich(db, aid) || [])) : []
  const lifeview = want('L') ? (grow ? (growLifeview(db, aid, force) || []) : (listLifeviewRich(db, aid) || [])) : []
  const lifeEx = want('L') ? explainLifeview(db, aid) : null
  const worldEx = want('W') ? explainWorldview(db, aid) : null
  const stance = lifeEx && lifeEx.derived ? lifeEx.derived.stance : null
  const view = {
    source: { W: 'meter', L: 'meter', V: 'meter' },
    W: { items: worldview, line: worldLineOf(worldview), explain: worldEx },
    L: { items: lifeview, line: lifeviewPromptLine(lifeview, stance), stance, derived: lifeEx && lifeEx.derived, explain: lifeEx },
    V: { items: [], line: '', weights: {}, tensions: [] },
  }
  if (want('V')) {
    // 只折算，不再从任何旧表迁：迁移器已随旧价值观一起删掉
    applyValueFold(db, aid, view)
  }
  let cfg = null
  try { cfg = sangguanConfig(db, aid) } catch { cfg = null }
  if (cfg && cfg.enabled) {
    if (want('W') && cfg.replace.W === 'engine') applyEngineLine(db, aid, view, 'W', '你对世界的基本看法：')
    if (want('L') && cfg.replace.L === 'engine') applyEngineLine(db, aid, view, 'L', '你的人生观：')
    if (want('V')) view.V.shadow = noteShadow(db, aid, opt.at)
  }
  return view
}

const shadowKey = (aid) => 'sangguan.shadow:' + aid

function uniformValues(view) {
  const items = DIMS.map(([key, label, hint]) => ({
    key, label, hint, weight: 0.1, evidence: [], habit: false, origin: 'engine',
  }))
  view.V.items = items
  view.V.weights = weightsOf(items)
  view.V.line = ''
  view.source.V = 'engine'
}

function applyValueFold(db, aid, view) {
  uniformValues(view)
  try {
    const s = loadState(db, aid)
    const tx = new Map(db.prepare('SELECT id, text FROM persona_claims WHERE agent_id=?').all(aid).map((r) => [r.id, r.text || '']))
    const open = Object.values(s.kappas).filter((k) => SIGMA_OPEN.includes(k.sigma))
    view.V.tensions = open.map((k) => ({
      pair: (tx.get(k.pos_id) || '') + ' ↔ ' + (tx.get(k.neg_id) || ''),
      strong: tx.get(k.pos_id) || '',
      weak: tx.get(k.neg_id) || '',
      gap: 0,
    }))
    const folded = foldValueWeights(db, aid)
    if (!folded) return
    // 折叠时会按三组张力压对侧；这里把「确实偏出」的对报出来，页面/自述/提示词都有话可说。
    // 未决矛盾（κ）也并进来：那是「两句话还没分出高下」，和「哪一维更重」是两种张力。
    const pairTensions = []
    for (const [a, b] of PAIRS) {
      const gap = Math.abs(Number(folded.weights[a] || 0) - Number(folded.weights[b] || 0))
      if (gap < 0.02) continue
      const strongKey = Number(folded.weights[a] || 0) >= Number(folded.weights[b] || 0) ? a : b
      const weakKey = strongKey === a ? b : a
      const label = (k) => (DIMS.find((d) => d[0] === k) || [0, k])[1]
      pairTensions.push({ pair: label(a) + ' ↔ ' + label(b), strong: label(strongKey), weak: label(weakKey), gap: +gap.toFixed(4) })
    }
    view.V.tensions = pairTensions.concat(view.V.tensions || [])
    const items = DIMS.map(([key, label, hint]) => ({
      key, label, hint, weight: folded.weights[key], evidence: [], habit: false, origin: 'engine',
    })).sort((a, b) => b.weight - a.weight)
    view.V.items = items
    view.V.weights = folded.weights
    view.V.line = valueLine(items)
    view.V.fold = folded
    view.source.V = 'engine'
  } catch { /* 折算失败就留在初值 */ }
}

/** 技术视图：价值观从命题折算的过程，不读旧表。 */
export function explainValues(db, aid, opt = {}) {
  const view = readViews(db, aid, { only: 'V', at: opt.at })
  const folded = view.V.fold
  return {
    source: 'engine',
    claims: folded ? folded.claims : 0,
    max: folded ? folded.max : null,
    items: view.V.items,
    tensions: view.V.tensions,
    initial: 0.1,
    floor: 0.02,
    total: +Object.values(view.V.weights).reduce((a, b) => a + b, 0).toFixed(4),
  }
}

export function shadowOf(db, aid) {  try { return shadowVerdict(JSON.parse(getFlag(db, shadowKey(aid)) || '[]')) } catch { return shadowVerdict([]) }
}

const frozenKey = (aid) => 'sangguan.frozen:' + aid
const CLEANED = 'sangguan.cleaned'

export function isCleaned(db) {
  try { return getFlag(db, CLEANED) === '1' } catch { return false }
}

export function markCleaned(db) {
  setFlag(db, CLEANED, '1')
  return { cleaned: true }
}

function headsLine(db, aid, layer, lead) {
  const heads = listHeads(db, aid, layer).filter((h) => h.status === 'active' && h.kind !== 'commit' && h.text && !isHollowSeed(h))
  if (!heads.length) return ''
  const core = (h) => (isCoreKind(layer, h.kind) ? 1 : 0)
  const pick = [...heads].sort((a, b) => core(b) - core(a) || (b.e || 0) - (a.e || 0)).slice(0, 3)
  return lead + pick.map((h) => String(h.text).replace(/\s+/g, ' ').slice(0, 40)).join('；') + '。'
}

function applyEngineLine(db, aid, view, layer, lead) {
  const line = headsLine(db, aid, layer, lead)
  if (!line) return
  view[layer].line = line
  view.source[layer] = 'engine'
}

/** 还没切过去之前，也记下「若今天就切，驱力会看到什么」。同一天只留最后一次。 */
export function noteShadow(db, aid, at) {
  if (!isEnabled(db, aid)) return shadowOf(db, aid)
  try {
    const s = loadState(db, aid)
    const tx = new Map(db.prepare('SELECT id, text FROM persona_claims WHERE agent_id=?').all(aid).map((r) => [r.id, r.text || '']))
    const claims = Object.values(s.claims)
      .filter((c) => c.layer === 'V' && !isTerminal(c.status) && c.kind !== 'commit')
      .map((c) => ({ id: c.id, text: tx.get(c.id) || '', pi: c.pi, n: c.n }))
    const assigned = assignDims(claims)
    if (!assigned || !assigned.length) return shadowOf(db, aid)
    const folded = foldDims(assigned)
    const day = String(at || new Date().toISOString()).slice(0, 10)
    let prev = []
    try { prev = JSON.parse(getFlag(db, shadowKey(aid)) || '[]') } catch { prev = [] }
    const next = shadowPush(prev, day, folded.weights)
    if (JSON.stringify(next) !== JSON.stringify(prev)) setFlag(db, shadowKey(aid), JSON.stringify(next))
    return shadowVerdict(next)
  } catch { return shadowOf(db, aid) }
}

function hasRealCore(db, aid, layer) {
  const established = readEvents(db, aid, { types: ['CORE_ESTABLISH'] }).some((e) => e.layer === layer)
  if (established) return true
  const s = loadState(db, aid)
  return Object.values(s.claims).some((c) => c.layer === layer && isCoreKind(layer, c.kind) && !isTerminal(c.status) && !isHollowSeed(c) && (c.pi > 0 || c.n > 0))
}

/** 人点切换之前看的条件。r_J 还没有裁决时不拦。 */
export function replaceReady(db, aid, layer, now) {
  const cfg = sangguanConfig(db, aid)
  const reasons = []
  if (cfg.inject !== 'live') reasons.push('inject')
  const shadow = shadowOf(db, aid)
  if (!shadow.ok) reasons.push(shadow.reason || 'shadow')
  if (!hasRealCore(db, aid, layer)) reasons.push('core')
  const rj = rJOf(db, aid, now || new Date().toISOString())
  if (typeof rj === 'number' && rj < 0.8) reasons.push('r_J')
  return { ok: reasons.length === 0, reasons, shadow, r_J: rj == null ? '尚无裁决' : rj }
}

function frozenView(db, aid) {
  try {
    const snap = JSON.parse(getFlag(db, frozenKey(aid)) || 'null')
    if (!snap || !snap.V) return null
    return {
      source: { W: 'frozen', L: 'frozen', V: 'frozen' },
      W: { items: (snap.W && snap.W.items) || [], line: (snap.W && snap.W.line) || '', explain: null },
      L: { items: (snap.L && snap.L.items) || [], line: (snap.L && snap.L.line) || '', stance: snap.L && snap.L.stance, derived: null, explain: null },
      V: { items: (snap.V && snap.V.items) || [], line: (snap.V && snap.V.line) || '', weights: (snap.V && snap.V.weights) || {}, tensions: null },
    }
  } catch { return null }
}

/** 清理前把当时的三行和十维冻住。之后开关关闭就读这份，不再重算。 */
export function freezeViews(db, aid, at) {
  const view = readViews(db, aid, { at })
  const snap = {
    at: at || new Date().toISOString(),
    W: { line: view.W.line, items: view.W.items },
    L: { line: view.L.line, items: view.L.items, stance: view.L.stance },
    V: { line: view.V.line, items: view.V.items, weights: view.V.weights },
  }
  setFlag(db, frozenKey(aid), JSON.stringify(snap))
  return snap
}
