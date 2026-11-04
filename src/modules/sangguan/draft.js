/**
 * 三观草稿：把「取舍现场」变成一句能锚住人的话。
 *
 * 四步：反事实标注（J32）→ 按「放弃了什么」聚类 → 起草（J33）→ 五道闸。
 * 只产出草稿，不写账本；写账本要走 commitDraft，且必须 human=true。
 *
 * 设计约束（见 docs/sangguan-draft-generator-v1.md）：
 * - 结构卡死，语言放开：不规定句式，只要求「有另一条路、有代价、能排除、不是任务、有重复证据」
 * - 同一取舍方向算一条，不按字面相似度合并
 * - 宁可一条都不长
 */
import { append, newId } from './ledger.js'
import { call } from './llm.js'

const DAY = 86400000

/** 放弃物的六个类：聚类按它，不按话题。 */
export const FOREGONE_KINDS = Object.freeze(['时间', '准确', '被喜欢', '省事', '安心', '面子'])

const KIND_HINT = [
  [/时间|慢|等|拖|跑|熬|加班|两天|三天/, '时间'],
  [/准确|对|准|真|假|核|验|证/, '准确'],
  [/喜欢|讨厌|生气|失望|高兴|哄|讨好|心软|敷衍|糊弄|觉得我不行/, '被喜欢'],
  [/省事|简单|直接|顺手|快/, '省事'],
  [/安心|放心|安全|稳|怕/, '安心'],
  [/面子|难看|承认|认错|丢人|尴尬/, '面子'],
]

// 判「是不是任务说明」用的词要窄：数据、测试、功能这类词在日常取舍里也会出现，
// 拿它们一票否决会把「数据不对就重跑」这种真取舍误杀。
const TASK_WORD = /(接口|部署|日志|报错|版本|分支|仓库|配置|线上|插件|脚本|数据库|服务器|端口|进程|编译|打包|页面|需求|文档)/

export function kindOfForegone(text) {
  const t = String(text || '')
  for (const [re, k] of KIND_HINT) if (re.test(t)) return k
  return '其他'
}

/** 一天之差也算跨天：用日期字符串比，不用毫秒。 */
const dayOf = (iso) => String(iso || '').slice(0, 10)

/**
 * 聚类：按放弃物归类；同类里至少两条、跨两天才成簇。
 * 返回 [{kind, items:[…]}]，items 里的每条都带 at/alt/foregone/cost_to。
 */
export function clusterByForegone(ann) {
  const buckets = new Map()
  for (const a of ann) {
    if (!a || !a.foregone) continue
    const k = kindOfForegone(a.foregone)
    if (!buckets.has(k)) buckets.set(k, [])
    buckets.get(k).push(a)
  }
  const out = []
  for (const [kind, items] of buckets) {
    const days = new Set(items.map((x) => dayOf(x.at)))
    if (items.length < 2 || days.size < 2) continue
    out.push({ kind, items })
  }
  return out.sort((a, b) => b.items.length - a.items.length)
}

/**
 * 五道闸：G1 有另一条路 / G2 有代价 / G3 能排除 / G4 不是任务 / G5 有重复证据。
 *
 * 力度按来源分档（opt.source，默认 llm）：
 * - 自动稿：判据是「从偶发里猜出来的」，所以 G5 要两条、跨两天（由聚类保证）。
 * - 手写稿：人自己担保的，G5 降成「一条带日期的真事 + 人勾了『我认』」；
 *   其余四闸一分不松——另一条路、代价、排除、不是任务，是判断与口号的分界。
 */
export function gatesOf(d, cluster, opt = {}) {
  const manual = opt.source === 'manual'
  const items = (cluster && cluster.items) || []
  const g1 = !!(d.alt && String(d.alt).trim())
  const fore = String(d.foregone || '').trim()
  const g2 = !!fore && !/^(没什么|没有|无)$/.test(fore)
  const g3 = !!(d.exclusion && String(d.exclusion).trim())
  const text = String(d.text || '')
  const g4 = !TASK_WORD.test(text) && !/^\d{4}-\d{2}-\d{2}/.test(text)
  let g5
  if (manual) {
    const ev = Array.isArray(d.evidence) ? d.evidence : []
    const dated = ev.some((x) => x && /^\d{4}-\d{2}-\d{2}/.test(String(x.at || '')))
    g5 = dated && d.vouch === true
  } else {
    const days = new Set(items.map((x) => dayOf(x.at)))
    g5 = items.length >= 2 && days.size >= 2
  }
  return { g1, g2, g3, g4, g5, pass: g1 && g2 && g3 && g4 && g5 }
}

function pickStr(list, key) {
  for (const x of list) if (x && x[key]) return String(x[key])
  return null
}

/**
 * 起草：一簇出 2–3 版。ask 可注入（测试用），默认走 J33。
 * 返回 [{id, text, alt, foregone, cost_to, exclusion, boundary, counterexample, kind, evidence, gates, status:'draft'}]
 */
export async function buildDrafts(db, aid, clusters, opt = {}) {
  const at = opt.at || new Date().toISOString()
  const ask = opt.ask || ((input) => call({ db, aid, day: dayOf(at), at }, 'J33', input))
  const out = []
  for (const c of clusters) {
    const r = await ask({ kind: c.kind, items: c.items.slice(0, 6) })
    if (!r || !r.ok) continue
    for (const d of (r.out && r.out.drafts) || []) {
      const alt = d.alt || pickStr(c.items, 'alt')
      const foregone = d.foregone || pickStr(c.items, 'foregone')
      const draft = {
        id: 'dr_' + Math.random().toString(36).slice(2, 10),
        kind: c.kind,
        text: String(d.text || '').trim(),
        alt: alt ? String(alt).trim() : null,
        foregone: foregone ? String(foregone).trim() : null,
        cost_to: pickStr(c.items, 'cost_to'),
        exclusion: String(d.exclusion || '').trim() || null,
        boundary: Array.isArray(d.boundary) ? d.boundary.filter(Boolean).slice(0, 4) : [],
        counterexample: d.counterexample ? String(d.counterexample).slice(0, 200) : null,
        evidence: c.items.map((x) => ({ ref: x.ref || null, at: x.at || null, quote: String(x.trigger || x.before || '').slice(0, 120) })),
        status: 'draft',
        created_at: at,
      }
      draft.gates = gatesOf(draft, c)
      if (!draft.text) continue
      out.push(draft)
    }
  }
  return out
}

/**
 * 只有人批过的草稿才能入库：写成 V 层 norm，带取舍与代价，origin=user（人手写的东西不再被自动清）。
 */
export function commitDraft(db, aid, d, opt = {}) {
  if (!opt.human) throw new Error('草稿必须由人批过才能入库')
  if (!d || !d.text) throw new Error('缺正文')
  if (!d.gates || !d.gates.pass) throw new Error('五道闸没过，不能入库')
  const at = opt.at || new Date().toISOString()
  const id = newId('claims', at)
  const meta = {
    scene: Array.isArray(d.scene) ? d.scene.slice(0, 6) : [],
    foregone: d.foregone || null,
    variants: [{ text: d.text, claim_id: null, at }],
    lane_phase: 'V-draft',
  }
  append(db, aid, [{
    type: 'CLAIM_EXP', layer: 'V', actor: 'user', at,
    gate_report: { lane: 'V', gates: d.gates },
    payload: { claims: [{ id, layer: 'V', kind: 'norm', text: d.text, origin: 'user', boundary: (d.boundary || []).map((b) => ({ text: b, testable: false })), meta }], q_hint: null },
  }])
  return id
}
