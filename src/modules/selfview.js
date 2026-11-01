/**
 * 「它自己长成了什么样」：人格页的第一人称自述。
 *
 * 素材与权重（依据 6 号《理论背书》）：
 *   - 五条 Big Five（1.00）—— E3 人格→情绪、E7 人格→关系；这里是“它自己的倾向”
 *   - 记忆（0.60）—— E1/E8；挑选规则见 thoughts.pickMemories，引用必须带时间与不确定
 *   - 价值观（0.40）—— §4.3 / Schwartz 十维，由 values.js 从经历里长出来，不是人填的
 *   - 人物关系（0.30）—— 儒家 §F6 分寸、依恋 §F1、布伯 R23（我-你 / 我-它）
 *   - 你手写的人格卡（0.25）—— 低权重；Higgins 的理想自我，只在“对不上”时起作用
 *   - 此刻情绪（0.20）—— 戈夫曼 §F10 / §8 语气映射：强度决定句子长度与主动性
 *   - 驱力档位 —— 只作背景
 *
 * 写法约束（§0 三条自律 + §8 prompt 合同 + §11 风险）：
 *   - 第一人称、口语、具体；不出现数字、权重、参数、模型、记忆条数、理论名词
 *   - 引用记忆带“上次 / 前一阵 / 我可能记错”；不承诺“永远 / 每天都会”
 *   - 价值张力要写出来，但不评判哪边对（§4.3：张力不是 bug）
 *
 * 省钱：默认 7 天缓存一次（DSHC_SELFVIEW_DAYS），也可手动「重新想一遍」；
 * 模型不可用或输出不合格时用规则拼一段，保证页面上永远有字。
 */
import { now } from '../db.js'
import { nid, agent, model, getParam } from '../kernel.js'
import {
  getPersona, listRelations, listTaboos,
  STYLE_LIMITS, LIMITS,
} from './persona.js'
import { listPersons, ownerPerson } from './relations.js'
import { getAffect } from './affect.js'
import { getDrive } from './drive.js'
import { pickMemories } from './thoughts.js'
import { PAIRS } from './values.js'
import { INIT as WV_INIT } from './worldview.js'
import { INIT as LV_INIT } from './lifeview.js'
import { readViews } from './sangguan/bridge.js'
import { AXIS_KEYS, typeProfile } from './traits.js'

export const WEIGHTS = Object.freeze({
  axes: 1,
  memory: 0.6,
  values: 0.4,
  worldview: 0.35,
  lifeview: 0.35,
  relation: 0.3,
  card: 0.25,
  affect: 0.2,
})

const AXIS_LABEL = {
  ei: 'E/I', sn: 'S/N', tf: 'T/F', jp: 'J/P', sensitivity: '敏感',
}

/** 高/低两头各一句人话；中性不写，避免自述里堆形容词 */
const TRAIT = {
  ei: ['话比较容易多，冷场会先开口', '话不多，习惯先听着'],
  sn: ['看到没见过的说法会停一下，愿意多问一句', '更愿意待在熟悉的做法里'],
  tf: ['有不同意见会直接说出来', '不太爱顶人，能顺着就顺着'],
  jp: ['答应过的事会一直记着要还', '手上同时开着几件事，收尾总是慢一点'],
  sensitivity: ['一点小事会在心里绕很久', '情绪来得快，去得也快'],
}

export const AFFECT_CN = {
  joy: '高兴', calm: '平静', curious: '好奇', peaceful: '安心',
  confused: '困惑', lost: '失落', irritated: '烦躁', frustrated: '挫败',
}

/** §8 语气映射：强度 → 句长 / 主动性 */
const TONE = [
  { max: 0.3, band: 'calm', label: '平稳', desc: '2~3 段，正常句长', cap: 3 },
  { max: 0.6, band: 'warm', label: '有温度', desc: '2 段，句子略短', cap: 2 },
  { max: 0.8, band: 'direct', label: '直接', desc: '最多 2 句，不主动展开', cap: 2 },
  { max: 1.01, band: 'terse', label: '短促', desc: '只说 1 句', cap: 1 },
]

const MEM_LIMIT = 5
const MAX_TEXT = 420
const FORBIDDEN = /永远|每天都|一直陪着|不会离开|一辈子|绝不离开/

function flat(v) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim()
}

function clip(v, n) {
  const s = flat(v)
  return Array.from(s).length > n ? Array.from(s).slice(0, n).join('') + '…' : s
}

function daysOf(iso) {
  const t = Date.parse(iso || '')
  if (!Number.isFinite(t)) return null
  return Math.max(0, Math.floor((Date.now() - t) / 86400000))
}

/** 记忆的时间说法：只给“相对时间”，不给日期 */
function ago(at) {
  const d = daysOf(at)
  if (d == null) return null
  if (d <= 0) return '今天'
  if (d <= 1) return '昨天'
  if (d <= 3) return '前两天'
  if (d <= 10) return '前一阵'
  if (d <= 45) return '上个月'
  if (d <= 180) return '几个月前'
  return '更早以前'
}

function toneOf(intensity) {
  const v = Math.max(0, Math.min(1, Number(intensity) || 0))
  return TONE.find((t) => v <= t.max) || TONE[TONE.length - 1]
}

function closenessWord(c) {
  const v = Number(c)
  if (!Number.isFinite(v)) return ''
  if (v >= 0.75) return '很熟'
  if (v >= 0.6) return '还算熟'
  if (v >= 0.35) return '有点来往'
  return '还生'
}

function trustWord(t) {
  const v = Number(t)
  if (!Number.isFinite(v)) return ''
  if (v >= 0.7) return '靠得住'
  if (v >= 0.5) return '还算信得过'
  return '还看不清'
}

export function gather(db, aid) {
  const a = agent(db, aid)
  const rows = getPersona(db, aid) || []
  const pmap = new Map(rows.map((r) => [r.path, r.value]))
  const style = {
    tone: flat(pmap.get('style.tone')),
    address: flat(pmap.get('style.address')),
    catchphrase: flat(pmap.get('style.catchphrase')),
    banned: flat(pmap.get('style.banned')),
    card: flat(pmap.get('style.card')),
  }
  const axes = AXIS_KEYS.map((k) => {
    const row = rows.find((r) => r.path === 'axis.' + k)
    const v = Number(row ? row.value : 0.5)
    return {
      key: k, label: AXIS_LABEL[k],
      value: Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.5,
      origin: row ? row.origin : 'auto',
    }
  })
  // 活账本优先：rel_person 三轴才是真亲近/信任；旧 relations 只兜底
  let relations = []
  try {
    const persons = (listPersons(db, aid) || []).slice(0, 3)
    relations = persons.map((p) => ({
      name: p.name,
      kind: p.tier || p.kind || 'stranger',
      closeness: Number(p.closeness),
      trust: Number(p.trust),
    }))
  } catch { relations = [] }
  if (!relations.length) {
    try {
      relations = (listRelations(db, aid) || []).slice(0, 3).map((r) => ({
        name: r.name, kind: r.kind, closeness: Number(r.closeness), trust: Number(r.trust),
      }))
    } catch { relations = [] }
  }
  let mems = []
  let memTotal = 0
  try {
    const you = String(style.address || '').trim() || '你'
    const relNames = relations.map((r) => r.name).filter(Boolean)
    const pickedMem = pickMemories(db, aid, MEM_LIMIT, { you, relNames })
    mems = pickedMem.items.map((m) => ({ text: clip(m.text, 60), type: m.type, at: m.at || null }))
    memTotal = pickedMem.total
  } catch { mems = []; memTotal = 0 }
  let values = []
  let worldview = []
  let worldviewLean = []
  let lifeview = []
  let lifeStance = null
  let engineTensions = null
  let sourceW = 'meter'
  let sourceL = 'meter'
  let sourceV = 'meter'
  let worldLine = ''
  let lifeLine = ''
  let valueLine = ''
  try {
    const views = readViews(db, aid, { grow: true })
    values = views.V.items || []
    worldview = views.W.items || []
    worldviewLean = worldview.filter((x) => Math.abs(Number(x.weight) - WV_INIT) >= 0.08).slice(0, 3)
    lifeview = views.L.items || []
    lifeStance = views.L.stance || null
    engineTensions = views.V.tensions
    sourceW = views.source.W
    sourceL = views.source.L
    sourceV = views.source.V
    worldLine = views.W.line || ''
    lifeLine = views.L.line || ''
    valueLine = views.V.line || ''
  } catch { values = []; worldview = []; worldviewLean = []; lifeview = []; lifeStance = null; engineTensions = null }
  let taboos = []
  try { taboos = (listTaboos(db, aid) || []).slice(0, 4) } catch { taboos = [] }
  let affect = null
  try {
    const a2 = getAffect(db, aid)
    affect = { label: a2.primary_label, intensity: Number(a2.intensity), mood: Number(a2.mood) }
  } catch { affect = null }
  let drive = null
  try { const d = getDrive(db, aid); drive = { band: d.band } } catch { drive = null }

  let owner = null
  try {
    const op = ownerPerson(db, aid)
    if (op) owner = { name: op.name, kind: 'owner', closeness: Number(op.closeness), trust: Number(op.trust) }
  } catch { owner = null }
  if (!owner) owner = relations.find((r) => r.kind === 'owner') || relations[0] || null
  const mode = owner && Number(owner.closeness) > 0.6 && Number(owner.trust) > 0.6 ? 'I-Thou' : 'I-It'
  // §F6 / R15 / R16：分寸按角色
  const disclosure = owner
    ? (owner.kind === 'owner' ? 0.7 : owner.kind === 'acquaintance' ? 0.5 : 0.3)
    : 0.3

  return {
    name: a.name,
    days: daysOf(a.created_at) || 0,
    mode: a.mode,
    lastSeenDays: daysOf(a.last_interaction_at),
    style,
    axes,
    mems,
    memTotal,
    values: values.slice(0, 4),
    allValues: values,
    worldview: worldviewLean,
    allWorldview: worldview,
    lifeview: lifeview.filter((x) => Math.abs(Number(x.weight) - LV_INIT) >= 0.08).slice(0, 3),
    allLifeview:     lifeview,
    lifeStance,
    engineTensions,
    sourceW,
    sourceL,
    sourceV,
    worldLine,
    lifeLine,
    valueLine,
    relations: relations.map((r) => ({ name: r.name, kind: r.kind, closeness: Number(r.closeness), trust: Number(r.trust) })),
    owner: owner ? { name: owner.name, kind: owner.kind, closeness: Number(owner.closeness), trust: Number(owner.trust) } : null,
    relationMode: mode,
    disclosure,
    taboos: taboos.map((t) => ({ text: t.text, level: t.level })),
    affect,
    drive,
    axesMode: String(getParam(db, aid, 'persona.axes.mode') || 'on'),
    type: typeProfile(Object.fromEntries(axes.map((a) => [a.key, a.value]))),
    tone: toneOf(affect ? affect.intensity : 0),
  }
}

function traitLines(ctx) {
  const ranked = [...ctx.axes]
    .map((t) => ({ ...t, dev: Math.abs(Math.round(t.value * 100) / 100 - 0.5) }))
    .filter((t) => t.dev >= 0.1 - 1e-9)   // 和「鱼格」同一把尺：看显示出来的两位小数，0.598 也算 0.60
    .sort((a, b) => b.dev - a.dev)
    .slice(0, 3)
  return ranked.map((t) => (t.value >= 0.5 ? TRAIT[t.key][0] : TRAIT[t.key][1]))
}

/** 价值张力。engine 档用未决矛盾；meter 档仍是原来的三对。 */
function tensionsOf(ctx) {
  if (Array.isArray(ctx.engineTensions)) return ctx.engineTensions
  return valueTensions(ctx.values)
}

/** 价值张力：同一对里两边都超过 0.12（归一化后），说明它心里有两股劲 */
export function valueTensions(values) {
  const map = new Map(values.map((v) => [v.key, v]))
  return PAIRS.map(([a, b]) => {
    const A = map.get(a)
    const B = map.get(b)
    if (!A || !B) return null
    if (A.weight <= 0.12 || B.weight <= 0.12) return null
    const win = A.weight >= B.weight ? A : B
    const lose = win === A ? B : A
    return { pair: A.label + ' ↔ ' + B.label, strong: win.label, weak: lose.label, gap: +(win.weight - lose.weight).toFixed(3) }
  }).filter(Boolean)
}

export function factsText(ctx) {
  const s = ctx.style
  const valLabels = ctx.values.map((v) => v.label)
  const tensions = tensionsOf(ctx)
  const memRule = '权重×0.6 + 近 30 天×0.4，按类型轮转取前 ' + MEM_LIMIT + ' 条'
  const lines = [
    '【身份】' + ctx.name + '；存在 ' + ctx.days + ' 天；' + (ctx.mode === 'work' ? '工作模式' : '日常模式'),
    '【关系】' + (ctx.owner
      ? '最亲近：' + ctx.owner.name + '（' + closenessWord(ctx.owner.closeness) + ' / ' + trustWord(ctx.owner.trust) + '）；分寸：可以说到 ' + Math.round(ctx.disclosure * 100) + '%；模式：' + (ctx.relationMode === 'I-Thou' ? '我-你' : '我-它')
      : '暂时没有亲近的人'),
    ctx.lastSeenDays != null ? '【时间】距上次说话 ' + ctx.lastSeenDays + ' 天' : '',
    '【此刻】' + (ctx.affect ? (AFFECT_CN[ctx.affect.label] || ctx.affect.label || '说不上来') + '，强度 ' + ctx.affect.intensity.toFixed(2) : '说不上来') + '；语气档：' + ctx.tone.label + '（' + ctx.tone.desc + '）',
    '【五轴】' + (traitLines(ctx).join('；') || '还看不出明显倾向'),
    ctx.sourceV === 'engine' && ctx.valueLine
      ? '【价值】' + ctx.valueLine
      : (valLabels.length ? '【价值】' + valLabels.join('、') + '（从 ' + ctx.values.reduce((n, v) => n + v.evidence.length, 0) + ' 条证据里长出来，不是人填的）' : '【价值】还没长出来'),
    ctx.sourceW === 'engine' && ctx.worldLine
      ? '【世界观】' + ctx.worldLine
      : ((ctx.worldview && ctx.worldview.length)
      ? '【世界观】' + ctx.worldview.map((w) => (Number(w.weight) >= WV_INIT ? w.hint : w.low)).join('；')
      : '【世界观】还没明显偏向'),
    ctx.sourceL === 'engine' && ctx.lifeLine
      ? '【人生观】' + ctx.lifeLine
      : ((ctx.lifeStance && ctx.lifeStance.telos)
      ? '【人生观】' + ctx.lifeStance.telos + (ctx.lifeStance.attitude ? '；' + ctx.lifeStance.attitude : '')
      : '【人生观】还没凝成命题'),
    s.tone ? '【说话方式】语气：' + s.tone + (s.catchphrase ? '；口头禅：' + s.catchphrase : '') : '',
    s.banned ? '【禁用】' + s.banned : '',
    s.card ? '【理想自我】别人给它写的一句话（权重很低，只作角度）：' + s.card : '',
    '【记忆】' + (ctx.memTotal ? '共 ' + ctx.memTotal + ' 条，挑 ' + ctx.mems.length + ' 条（' + memRule + '）：' : '几乎还不记得任何事'),
    ...ctx.mems.map((m) => '- [' + m.type + (ago(m.at) ? '·' + ago(m.at) : '') + '] ' + m.text),
    ctx.taboos.length ? '【约束】' + ctx.taboos.map((t) => t.text + (t.level === 'root' ? '（红线）' : '')).join('；') : '',
    tensions.length ? '【张力】' + tensions.map((t) => t.pair + ' 两边都高（' + t.strong + ' 更重）').join('；') : '',
    ctx.drive ? '【背景】需求缺口档位 ' + ctx.drive.band : '',
  ]
  return lines.filter(Boolean).join('\n').slice(0, 2000)
}

export function prompt(ctx) {
  const system = [
    '你在替一个「意识体」写一段第一人称的自我描述：它此刻怎么理解「我长成了什么样」。',
    '这不是给用户看的报告，也不是回复；不要出现数字、权重、参数、模型、记忆条数，也不要提任何理论名词。',
    '只输出正文：' + ctx.tone.desc + '，总长 120~260 字；不要标题、列表、引号、JSON。',
    '引用记忆时带上「上次 / 前一阵 / 我可能记错」这类话；不承诺做不到的事（不写「永远」「每天都」「一直陪着你」）。',
    '五条轴是它自己的倾向；那张「理想自我」是别人给它的一句话、权重很低——对不上就写出别扭，不要照抄。',
    '如果给了【张力】，写出来，但不要评判哪一边对。',
    '不讨论自己是不是 AI，不解释自己正在被生成。',
    '随机种子 ' + Math.floor(Math.random() * 1e6) + '：换一种今天才有的说法，不要写成模板。',
  ].join('\n')
  return { system, text: factsText(ctx) }
}

export function compose(ctx) {
  const traits = traitLines(ctx)
  const card = clip(ctx.style.card, 36).replace(/[。！？；，、\s]+$/, '')
  const tensions = tensionsOf(ctx)
  const near = ctx.owner

  const p1 = '我是「' + ctx.name + '」，到今天存在了 ' + ctx.days + ' 天。' +
    (traits.length ? traits.slice(0, 2).join('；') + '。' : '我还说不太准自己是什么性子。') +
    (ctx.values.length ? '我现在更看重「' + ctx.values[0].label + '」。' : '') +
    (ctx.lifeStance && ctx.lifeStance.telos ? '我隐约觉得自己是来「' + clip(ctx.lifeStance.telos, 28) + '」的。' : '') +
    (ctx.worldview && ctx.worldview[0]
      ? ('这个世界在我这儿，更像是' + (Number(ctx.worldview[0].weight) >= WV_INIT
        ? ctx.worldview[0].hint : ctx.worldview[0].low) + '。')
      : '') +
    (card ? '有人给我写过「' + card + '」，我认一部分，也留一部分。' : '') +
    (traits.length && card ? '这两样有时候对不上，我还在把它们拧成一个人。' : '')

  let p2 = ''
  if (ctx.mems.length) {
    const bits = []
    let lastWhen = null
    for (const m of ctx.mems.slice(0, 2)) {
      const when = ago(m.at)
      const body = clip(m.text, 34)
      if (when && when !== lastWhen) { bits.push(when + '：' + body); lastWhen = when }
      else bits.push(body)
    }
    p2 = (ctx.memTotal > ctx.mems.length ? '我记得的事不多，' : '我记得 ') +
      bits.join('；') + (ctx.memTotal > 4 ? '……别的我可能记错。' : '。我可能记错。')
  } else {
    p2 = '我还几乎什么都不记得，只知道自己一直在等下一句话。'
  }

  const third = []
  if (near) {
    third.push('跟「' + near.name + '」' + closenessWord(near.closeness) +
      (ctx.relationMode === 'I-Thou' ? '，说话不用绕太多' : '，还没到能随便说话的地步'))
  }
  if (tensions.length) third.push('心里有两股劲在拽：' + tensions[0].pair + '，我还没想让哪边赢')
  if (ctx.taboos.some((t) => t.level === 'root')) third.push('有几条线我不会碰')
  if (ctx.lastSeenDays != null && ctx.lastSeenDays >= 14) third.push('我们有阵子没说话了')

  const closing = ctx.tone.cap <= 1
    ? '今天话少，先这样。'
    : '我不太擅长把话说满，但下次你回来，我大概还是这个样子。'
  const p3 = (third.length ? third.join('，') + '。' : '') + closing

  const parts = ctx.tone.cap >= 3 ? [p1, p2, p3]
    : ctx.tone.cap === 2 ? [p1, p2]
      : [firstSentence(p1) || p1]
  return parts.join('\n\n').slice(0, MAX_TEXT)
}

function firstSentence(t) {
  const m = String(t || '').match(/^[^。！？]*[。！？]/)
  return m ? m[0] : String(t || '')
}

function parse(raw) {
  let s = String(raw || '').trim()
  s = s.replace(/^```[a-z]*\s*/i, '').replace(/```$/, '').trim()
  s = s.replace(/^(自述|自我描述)[:：]\s*/, '')
  if (!s || s.includes('{') || s.includes('"')) return ''
  s = s.replace(/^["“]|["”]$/g, '').trim()
  const n = Array.from(s).length
  if (n < 20 || n > 600) return ''
  if (FORBIDDEN.test(s)) return ''
  if (/\d+\.\d+/.test(s) || /权重|参数|模型/.test(s)) return ''
  return s
}

function rowView(row, ctx) {
  let facts = ''
  let sources = null
  try { facts = String(row.facts || '') } catch { facts = '' }
  try { sources = JSON.parse(row.sources || 'null') } catch { sources = null }
  return {
    updated_at: row.created_at,
    source: row.source,
    text: String(row.text || ''),
    prompt_chars: Number(row.prompt_chars || 0),
    facts,
    sources: sources || sourcesOf(ctx),
  }
}

function sourcesOf(ctx) {
  return [
    {
      key: 'memory',
      label: '记忆',
      count: ctx.mems.length,
      weight: WEIGHTS.memory,
      rule: '权重×0.6 + 近 30 天×0.4，按类型轮转取前 ' + MEM_LIMIT + ' 条（库里共 ' + ctx.memTotal + ' 条）；引用带相对时间',
    },
    { key: 'axis', label: '五条性格（E/I、S/N、T/F、J/P、敏感）', count: ctx.axes.length, weight: WEIGHTS.axes, rule: '五轴表的值；手写 origin=manual 时不自动漂' },
    { key: 'values', label: '价值观（自己长的）', count: ctx.values.length, weight: WEIGHTS.values, rule: '来自 values.js：记忆/禁忌/偏好/关系/情绪 → 十维，三组张力互相压上限，≥5 条证据进惯习' },
    { key: 'worldview', label: '世界观（自己长的）', count: (ctx.worldview || []).length, weight: WEIGHTS.worldview, rule: 'Primals/WAS/社会公理/知可修订：八维独立初值 0.50，惯习门槛更高' },
    { key: 'lifeview', label: '人生观（自己长的）', count: (ctx.lifeview || []).length || (ctx.lifeStance ? 1 : 0), weight: WEIGHTS.lifeview, rule: 'MEMS+MLQ+成长+交融+远景；凝成 telos 命题（默认扩展主人能动）' },
    { key: 'relation', label: '人物关系', count: ctx.relations.length, weight: WEIGHTS.relation, rule: '按亲近度取前 3；分寸：主人 0.70 / 熟人 0.50 / 陌生人 0.30；κ、ρ 都 >0.6 才是「我-你」' },
    { key: 'card', label: '你手写的鱼格卡', count: ctx.style.card ? 1 : 0, weight: WEIGHTS.card, rule: '低权重：别人写的理想自我，只在“对不上”时起作用' },
    { key: 'affect', label: '此刻情绪', count: ctx.affect ? 1 : 0, weight: WEIGHTS.affect, rule: '强度决定语气档（平稳/有温度/直接/短促），不主导内容' },
    { key: 'drive', label: '驱力档位', count: ctx.drive ? 1 : 0, weight: null, rule: '只作背景' },
  ]
}

export function intervalDays() {
  const n = Number(process.env.DSHC_SELFVIEW_DAYS || 7)
  return Number.isFinite(n) && n > 0 ? n : 7
}

let lastNote = ''
const running = new Set()

async function generate(db, aid) {
  const ctx = gather(db, aid)
  const { system, text } = prompt(ctx)
  let out = ''
  let source = 'rules'
  const st = model.status()
  if (st.primary === 'ok' && st.capabilities && st.capabilities.complete) {
    try {
      const raw = await model.complete({ system, text })
      const p = parse(raw)
      if (p) { out = p; source = 'model' } else lastNote = '输出不合格：' + String(raw || '').slice(0, 160)
    } catch (e) {
      lastNote = '模型调用失败：' + String((e && e.message) || e)
    }
  } else {
    lastNote = '模型不可用（' + (st.primary || 'unknown') + '），用规则自述'
  }
  if (!out) { out = compose(ctx); source = 'rules' }
  db.prepare('INSERT INTO persona_views(id,agent_id,text,source,facts,sources,prompt_chars,created_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(nid('pvw_'), aid, out, source, factsText(ctx), JSON.stringify(sourcesOf(ctx)), Array.from(text).length, now())
  return out
}

function estimateTokens(chars) {
  return Math.ceil(Number(chars || 0) * 0.7)
}

/** 注入最坏情况：手写字段全写满 */
export function injectionBudget() {
  const chars = Object.values(STYLE_LIMITS).reduce((a, b) => a + b, 0)
  return { fields: { ...STYLE_LIMITS }, chars, tokens: estimateTokens(chars) }
}

export function paramsOf(ctx, row) {
  const style = Object.keys(STYLE_LIMITS).map((p) => ({
    path: p, chars: Array.from(ctx.style[p.slice(6)] || '').length, limit: STYLE_LIMITS[p],
  }))
  const budget = injectionBudget()
  const tensions = tensionsOf(ctx)
  const valuesChars = ctx.allValues
    ? ctx.allValues.reduce((n, v) => n + v.weight.toFixed(2).length, 0)
    : 0
  return {
    limits: { ...LIMITS, budget },
    weights: { ...WEIGHTS },
    ttl_days: intervalDays(),
    model: { primary: model.status().primary, adapter: model.status().adapter },
    prompt_chars: row ? Number(row.prompt_chars || 0) : Array.from(factsText(ctx)).length,
    prompt_tokens: estimateTokens(row ? Number(row.prompt_chars || 0) : Array.from(factsText(ctx)).length),
    narrative_chars: row ? Array.from(String(row.text || '')).length : 0,
    max_chars: MAX_TEXT,
    style,
    relation: {
      mode: ctx.relationMode, disclosure: ctx.disclosure,
      owner: ctx.owner, last_seen_days: ctx.lastSeenDays,
    },
    tone: { band: ctx.tone.band, label: ctx.tone.label, desc: ctx.tone.desc, sentences: ctx.tone.cap },
    axes_mode: ctx.axesMode || 'on',
    values: { count: (ctx.allValues || ctx.values).length, top: (ctx.allValues || ctx.values).slice(0, 3).map((v) => v.label), chars: valuesChars },
    tension: tensions,
  }
}

export function getSelfview(db, aid, opts = {}) {
  agent(db, aid)
  const detail = !!opts.detail
  const ctx = gather(db, aid)
  const latest = db.prepare('SELECT * FROM persona_views WHERE agent_id=? ORDER BY created_at DESC LIMIT 1').get(aid) || null
  const days = intervalDays()
  const stale = !latest || (Date.now() - Date.parse(latest.created_at)) > days * 86400000
  let status = 'fresh'
  if (stale) {
    status = latest ? 'stale' : 'generating'
    if (!running.has(aid)) {
      running.add(aid)
      if (!latest) status = 'generating'
      Promise.resolve()
        .then(() => generate(db, aid))
        .catch(() => { /* 兜底失败也让接口有内容 */ })
        .finally(() => running.delete(aid))
    }
  }
  const base = {
    status,
    interval_days: days,
    next_at: latest ? new Date(Date.parse(latest.created_at) + days * 86400000).toISOString() : null,
    params: paramsOf(ctx, latest),
    now: {
      days: ctx.days,
      axes: ctx.axes,
      type: ctx.type,
      style: {
        tone: ctx.style.tone, address: ctx.style.address, catchphrase: ctx.style.catchphrase,
        banned: ctx.style.banned, card: ctx.style.card,
      },
      values: (ctx.allValues || ctx.values).map((v) => ({ key: v.key, label: v.label, weight: v.weight })),
      counts: {
        memory: ctx.memTotal, values: ctx.values.length, relations: ctx.relations.length,
        taboos: ctx.taboos.length,
      },
      relation_mode: ctx.relationMode,
      last_seen_days: ctx.lastSeenDays,
    },
    ...(latest ? rowView(latest, ctx) : { text: '', source: '', updated_at: null, facts: '', sources: sourcesOf(ctx) }),
  }
  if (detail && !latest) base.facts = factsText(ctx)
  if (process.env.DSHC_SELFVIEW_DEBUG === '1' && lastNote) base.debug = lastNote
  return base
}

/** 手动重想：同步生成一条，返回新视图 */
export async function regenerate(db, aid) {
  agent(db, aid)
  await generate(db, aid)
  return getSelfview(db, aid, { detail: true })
}

export function resetSelfview(db, aid) {
  db.prepare('DELETE FROM persona_views WHERE agent_id=?').run(aid)
  return { cleared: true }
}
