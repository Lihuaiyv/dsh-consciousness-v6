/**
 * 切事件 v4 流水线（2026-11-18）：读碎片 → 粗切 → 记叙 → 判缝 → 出件。
 *
 * 从 `scratch/v2/run-v4.mjs` 搬进来的，逻辑一比一；差别只有两处：
 *   1. 模型调用改成注入（`complete` / `embed`），worker 用本地队列（不花 API）；
 *   2. 不写 markdown、不碰缓存，只返回 `events`，由调用方决定写哪张表。
 *
 * 隔离：只读 `fragments`；不 import `event_split.js`；不写 `cold_events`/`hot_events`。
 * 出件交给 `writeEventsV2`（同一模块族）。
 */

import fs from 'node:fs'
import { loadRows, groupBySession, embedRows, windowCurve, findValleys } from './event_split_v2.js'

const NARR_SYS = [
  '你在读一段对话，用记叙文的样子把这段写清。别评价，只写发生了什么。',
  '过日子和干活一样写：吃饭、散步、拌嘴、改代码、跑脚本，都用同一套写法。',
  '',
  '【标题】这件事叫什么，人话，带一个具体对象、带一个结果，≤20 字',
  '【专名】这段里反复出现（至少两次）的 1-3 个词，必须给，不许空。连问两句，都过才算：一、换一件事，还会不会用到它？不会才算（时间、方向、模型、心情、窗口这类，每件事都能用，不算）。二、听到这个词，能不能把这件事认出来？能才算。人、地方、物、一个说法、一个数字、一句最扎的原话都行，工作和日子同一个标准。只写词，不写半句话、不写短语。只许抄原文里出现过的词，不许造。如果反复想都找不到出现两次的，就放宽：挑一个只出现一次、但听到就能认出这件事的专名放进来——宁可放宽频率，也不许空。',
  '【起因】为什么起头，一句话',
  '【经过】中间做了什么，一两句话',
  '【结果】最后停在哪，一句话',
  '【地点】≤8 字（家里、路上、厨房、聊天里、终端里、文件里……）',
  '【人物】我 / 主人 / 其他人（写名字）',
  '【归属】生活 / 工作 / 两边都有',
  '',
  '只输出 JSON：',
  '{"title":"","anchors":["",""],"cause":"","process":"","result":"","place":"","who":["我","主人"],"realm":""}',
].join('\n')

// 2026-11-19：件标题后置——等这件事各段都记叙完了，单独叫一次模型综合写标题+专名。
// 不再捡第一段的标题（那只是「这一段在干嘛」，不是整件事的名字）。
const TITLE_SYS = [
  '你在给「一件事」起名字，并写一句整件摘要。这件事由几段组成，每段已经写好了记叙，开头和结尾的原话也给你了。',
  '只输出 JSON：',
  '{"title":"","summary":"","process":"","anchors":["",""]}',
  '',
  '【标题】≤20 字，人话，带一个具体对象（专名）和一个结果。别用「汇报」「讨论」「继续」这种过程词开头；也别把几段的标题硬拼成一句。',
  '【摘要】整件事一句话，≤60 字，说清做了什么、做到哪了。看整件写，不许只抄第一段。',
  '【经过】整件事中间做的一两句话，覆盖各段。',
  '【专名】1-3 个，必须在这件事的原文里出现过。连问两句，都过才算：一、换一件事，还会不会用到它？不会才算。二、听到这个词，能不能把这件事认出来？能才算。',
].join('\n')

const JOIN_SYS = [
  '你在看同一天里前后相邻的两段生活记录。前一段已经过去了，后一段紧跟着发生。',
  '要判断的是：这两段是不是同一件事的两截。',
  '',
  '  same —— 同一件事还在进行：前一段那件事没有收尾（话没说完、事没办完、人还悬着），后一段还在里头。',
  '  next —— 前一段那件事收了尾，后一段是这件事的下一步（同一条线上下来的，能并成一件）。',
  '  new  —— 后一段起了另一件事，和前一段没有承接。',
  '',
  '可用证据按可信度从高到低排。靠前的权重更大，但不否决后面的；几条同向，结论更硬；互相打架，以权重高的为准。',
  '',
  '  1 后一段自己成不成一件事（最硬）。一段要有起头、经过、收尾。只有一句汇报、一句确认、一句顺口的接话——既没有经过也没有结果——它撑不起一件独立的事，要并进前段；same 还是 next 看前一段收没收尾，不能判 new。',
  '  2 两段的专名是不是同一个东西（强）。人、地方、文件、模块、版本号、项目名这类具体东西重合，或者是同一个东西的不同叫法（「app.db」/「那个库」、「D46」/「D46 报错」、「情绪链」/「情绪链那套」），这是同一件事的强证据；一个都沾不上，是换了件事的较强证据。但换个说法也会让专名看起来不沾，所以这条只推倾向，不单独定案。',
  '  3 前一段的事收没收尾（中）。有收尾（做完了、说完了、人走了）→ 后一段更可能是这件事的下一步或者另一件事；还悬着（等结果、没说完、话头断在半截）→ 后一段更可能还在同一件事里。',
  '  4 机器量的落差、新词率（弱）。只用来微调，不能反转 2、3 的结论——人换个说法，新词率一样会很高。',
  '  5 中间隔了多久（很弱）。时间只是旁证：隔得近不排斥同一件，隔得远也不证明换了事，只在打平时轻轻推一下。',
  '',
  '怎么合：',
  '  默认倾向 next（同一天里相邻两段，最常是同一段生活接着往下走）。',
  '  1 号成立 → 并（same 或 next，看 3 号）。',
  '  2 号同指 + 3 号悬着 → same；2 号同指 + 3 号收尾 → next。',
  '  2 号不沾 + 3 号收尾 + 后段自成一件事 → new。',
  '  4、5 号只在这几项打平时改倾向，不单独翻案。',
  '',
  '工作和日子同一套判法：',
  '  你刚定完周末去哪，接着聊周末带什么 → next',
  '  你刚吃完饭，转头说起明天上班 → new',
  '  你在改提示词，接着问某一行怎么改 → same',
  '  你在说心里闷，接着聊为什么闷 → same',
  '  你在修一个 bug，修完顺手去看另一个报错 → next',
  '  一起坐着谁也没说话，过一会儿你轻声说「困了」 → same',
  '  你发了一下午呆，晚上忽然说「我饿了」 → next',
  '',
  '下面可能附了「边界的形状数据」（落差、新词率、间隔、谁先说），那是机器量的，只作参考。',
  '',
  '「why」要回指上面哪条证据（例如「专名同指：D46」「后段只有一句汇报，撑不起一件」「前段已收尾，专名不沾」）。',
  '只输出 JSON：{"verdict":"","why":""}',
].join('\n')

/** 泛词：每件事都能用，当专名等于没专名（run-v4 的 GENERIC，一字未改）。 */
const GENERIC = new Set([
  '我', '你', '他', '她', '大家', '主人', '这边', '那边', '这里', '那里',
  '时间', '方向', '层级', '规则', '模型', '情绪', '检索', '浮现', '边界', '异步',
  '窗口', '样本', '模板', '语境', '摘要', '总括', '生存', '主轴', '交接', '事情', '问题',
  '代码', '功能', '结果', '原因', '经过', '现状', '计划', '任务', '工作', '生活',
  '上一句', '下一句', '正文', '工作区', '生活区', '有点', '重载', '接线', '重启',
  '原话', '复核', '脊梁', '变化', '一刀', '热度', '提示词', '两法', '第一个', '第二个',
])
const HALF_SENTENCE = /[的着了过还是都也又再没很太把被在是不一之间有]/

function filterAnchors(list, src, minCount) {
  const out = []
  for (const a0 of Array.isArray(list) ? list : []) {
    const a = String(a0 || '').trim()
    if (a.length < 2) continue
    if (GENERIC.has(a)) continue
    if (HALF_SENTENCE.test(a)) continue
    if (/[「」『』，。？！；：、\s]/.test(a)) continue
    if (!out.includes(a) && src.split(a).length - 1 >= minCount) out.push(a)
    if (out.length >= 3) break
  }
  return out
}
function checkAnchors(list, src) {
  const strict = filterAnchors(list, src, 2)
  return strict.length ? strict : filterAnchors(list, src, 1)
}

/** 2026-11-18：标题至少要带一个对象（专名）；同一天重名时用第二个专名区分。 */
function titleOf(head, tail, anchors, seen) {
  let base = String((head && head.title) || (tail && tail.title) || '').trim().slice(0, 40)
  if (!base) base = '一件没命名的事'
  if (anchors.length && !anchors.some((a) => base.includes(a))) base = (base + '·' + anchors[0]).slice(0, 40)
  let t = base
  let i = 1
  while (seen.has(t)) {
    const extra = anchors[i]
    i++
    const stem = base.length > 34 ? base.slice(0, 34) : base
    t = extra ? (stem + '·' + extra).slice(0, 40) : (base.length > 30 ? base.slice(0, 30) : base) + '（' + i + '）'
    if (i > 6) break
  }
  seen.add(t)
  return t
}

/** 2026-11-19：件有没有了结——只三值：挂着 / 收起 / 空。不判「阶段还是完全」，只看还要不要管。 */
const STATUS_CLOSED = /(完成|完了|做完|修好|绿了|通过|归档|定了|收工|已修|已验|跑通|落地|搞定|换好|落了|上线|成功|就绪|Ready)/
const STATUS_OPEN = /(还等|待验|等重启|还没|没跑通|没生效|没加载|悬着|明天再|后续再|先这样|暂不|要继续|继续讨论|继续做|讨论中)/
function statusOf(text) {
  const t = String(text || '').trim()
  if (!t) return null
  // 挂起词优先：写着「还等着」的件，哪怕前面有「修好了」，也还是挂着
  if (STATUS_OPEN.test(t)) return '挂着'
  if (STATUS_CLOSED.test(t)) return '收起'
  return null
}

/** 2026-11-19：合并后的地点——各段去重，最多 3 个。 */
const placeOf = (ev) => [...new Set(ev.map((x) => x.n.place).filter(Boolean))].slice(0, 3).join(' / ')
/** 2026-11-19：合并后的归属——各段不同就算两边都有。 */
function realmOf(ev) {
  const set = new Set(ev.map((x) => x.n.realm).filter(Boolean))
  if (set.size > 1 || set.has('两边都有')) return '两边都有'
  return [...set][0] || ''
}

/** 补线索时挡掉的词：称呼、语气、泛词。宁可这件少一个线索，也不要拿语气词当锚。 */
const CUE_STOP = new Set([
  '宝宝', '主人', '你', '我', '她', '他', '你们', '我们', '好的', '行了', '谢谢', '明白', '收到', '继续',
  '测试', '文档', '代码', '改代码', '根子', '事情', '问题', '东西', '时间', '工作', '生活', '你说得对',
  '其实', '所以', '因为', '可以', '不是', '没有', '就是', '然后', '现在', '刚才', '之前', '上面', '下面',
  '一个', '自己', '这样', '那样', '行', '好', '嗯', '对', '是', '不',
])
const CUE_BAN = /[吗呢吧呀啊哦嘛哟]/

/** 2026-11-18：线索至少两个（一个太容易撞）；不够就从这件原文里挑像专名的词补，仍不够就留现有的，不造假。 */
function cuesOf(anchors, rows) {
  // 模型给的锚也要洗：称呼（宝宝）、泛词（文档/测试）、语气词都不当线索
  const raw = (Array.isArray(anchors) ? anchors : [])
    .filter((a) => a && !CUE_STOP.has(a) && !CUE_BAN.test(a))
  const out = [...new Set(raw)]
  if (out.length >= 2) return out.slice(0, 3)
  const src = rows.map((r) => String(r.text || '')).join('\n')
  for (const m of src.matchAll(/([A-Za-z][A-Za-z0-9_.:-]{2,20}|[\u4e00-\u9fa5]{2,6})/g)) {
    if (out.length >= 2) break
    const w = m[1]
    if (w.length < 2 || CUE_STOP.has(w) || CUE_BAN.test(w) || GENERIC.has(w) || HALF_SENTENCE.test(w)) continue
    if (!src.includes(w) || out.includes(w)) continue
    // 拉丁词（TextTiling / ES-Mem / 14B）本来就可能只出现一次，放宽到 1 次；
    // 汉字词仍要出现两次，否则多半是半句碎片。
    const isLatin = /^[A-Za-z][A-Za-z0-9_.:-]+$/.test(w)
    if (!isLatin && src.split(w).length - 1 < 2) continue
    out.push(w)
  }
  return out.slice(0, 3)
}

const bigrams = (text) => {
  const t = String(text || '').replace(/[\s，。、；：？！「」『』（）()\-—…`*|#]/g, '')
  const out = new Set()
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2))
  return out
}
const meanVec = (list) => {
  const m = new Float64Array(list[0].length)
  for (const v of list) for (let k = 0; k < m.length; k++) m[k] += v[k]
  for (let k = 0; k < m.length; k++) m[k] /= list.length
  return m
}
const cosVec = (a, b) => {
  let d = 0, na = 0, nb = 0
  for (let k = 0; k < a.length; k++) { d += a[k] * b[k]; na += a[k] * a[k]; nb += b[k] * b[k] }
  return d / (Math.sqrt(na * nb) + 1e-12)
}

/** 边界形状数据：只作参考，帮判缝看清「掉得有多深」。 */
function boundaryFeature(g, i) {
  const gv = g._gv, w = g._w || 2
  const simAt = (j) => {
    if (j - w < 0 || j + w > gv.length) return null
    return cosVec(meanVec(gv.slice(j - w, j)), meanVec(gv.slice(j, j + w)))
  }
  const sim = simAt(i) ?? simAt(i - 1) ?? simAt(i + 1) ?? null
  const base = sim ?? 0
  let lPeak = base, rPeak = base
  for (let j = Math.max(w, i - 2 * w); j < i; j++) { const v = simAt(j); if (v !== null) lPeak = Math.max(lPeak, v) }
  for (let j = i + 1; j <= Math.min(gv.length - w, i + 2 * w); j++) { const v = simAt(j); if (v !== null) rPeak = Math.max(rPeak, v) }
  const before = g.rows.slice(Math.max(0, i - 8), i)
  const after = g.rows.slice(i, i + 4)
  const A = new Set(), B = new Set()
  for (const r of before) for (const x of bigrams(r.text)) A.add(x)
  for (const r of after) for (const x of bigrams(r.text)) B.add(x)
  let nw = 0
  for (const x of B) if (!A.has(x)) nw++
  return {
    sim: sim ?? NaN, ld: lPeak - base, rd: rPeak - base, depth: (lPeak - base) + (rPeak - base),
    nw: B.size ? nw / B.size : 0,
    role: g.rows[i].role, lenPrev: g.rows[i - 1].text.length, lenNext: g.rows[i].text.length,
    dt: (Date.parse(g.rows[i].created_at) - Date.parse(g.rows[i - 1].created_at)) / 1000,
  }
}

const fmtLine = (r) => (r.role === 'user' ? '主人：' : '我：') + String(r.text).replace(/\s+/g, ' ').slice(0, 120)
const narrText = (rows) => rows.map((r) => (r.role === 'user' ? '主人：' : '我：') + String(r.text).slice(0, 150)).join('\n').slice(0, 5000)
const segText = (rows) => rows.map((r) => r.text).join('\n')

/**
 * 跑一天。
 * @param {object} opts
 * @param {Function} opts.complete   ({system,text,maxTokens}) => Promise<string>
 * @param {Function} opts.embed      (list) => Promise<number[][]>
 * @param {Function} [opts.onProgress] ({stage,done,total}) => void
 * @returns {Promise<{events:object[], stats:object, rows:number}>}
 */
/** 2026-11-18：这一轮的「事」（事帧里的 summary）。查不到就空——历史天没有事帧也不报错。 */
function frameSummaryOf(db, turnId) {
  if (!turnId) return ''
  try {
    const row = db.prepare('SELECT frame_json FROM affect_v4_shadow WHERE turn_id=? ORDER BY rowid DESC LIMIT 1').get(String(turnId))
    if (!row) return ''
    const f = JSON.parse(row.frame_json || '{}')
    const s = String(f.summary || '').replace(/\s+/g, ' ').trim()
    if (!s || s === '（新事）') return ''
    return s.slice(0, 120)
  } catch { return '' }
}

export async function cutDayV4(db, aid, day, { complete, embed, onProgress = () => {}, withFrame = false, withFeat = true, wideCtx = true, titleSynth = true, cacheFile = '', valleyQuantile = 0.23, minGap = 4 } = {}) {
  if (typeof complete !== 'function' || typeof embed !== 'function') throw new Error('cutDayV4 需要注入 complete / embed')
  // 2026-11-18：断点缓存。进程被杀/DSH 重启后，已写好的记叙和判了缝的不重跑。
  // 键按「段的首末碎片 id」+ 开关组合，换天/换变体各用一个文件，不会串。
  let cache = {}
  if (cacheFile) { try { cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) } catch { cache = {} } }
  const saveCache = () => { if (!cacheFile) return; try { fs.writeFileSync(cacheFile, JSON.stringify(cache)) } catch { /* 写不进去下次重跑 */ } }
  const { clean } = loadRows(db, aid, day)
  if (!clean.length) return { events: [], stats: { rows: 0, segments: 0, events: 0, calls: 0 }, rows: 0 }
  const vecs = await embedRows(clean, (list) => embed(list))
  const idxOf = new Map(clean.map((r, i) => [r.id, i]))
  const groups = groupBySession(clean)
  let calls = 0

  // ── 第一层：粗切。固定窗口（不按会话长度缩），刀口只落在轮与轮之间
  const W = 5
  const segs = []
  for (const g of groups) {
    const gv = g.rows.map((r) => vecs[idxOf.get(r.id)])
    const w = Math.min(W, Math.floor(gv.length / 3))
    g._gv = gv
    g._w = w
    if (gv.length < 8) { segs.push({ rows: g.rows, sess: g.session_id, g, start: 0, end: gv.length }); continue }
    const curve = windowCurve(gv, { w })
    const deep = findValleys(curve, { quantile: valleyQuantile, smooth: 1 })
    const turnEdge = new Set()
    const hardCuts = []
    for (let i = 1; i < g.rows.length; i++) {
      const a = g.rows[i - 1].turn_id, b = g.rows[i].turn_id
      if ((a || 'x:' + i) !== (b || 'y:' + i)) turnEdge.add(i)
      if (Date.parse(g.rows[i].created_at) - Date.parse(g.rows[i - 1].created_at) >= 6 * 3600 * 1000) hardCuts.push(i)
    }
    const edges = [...turnEdge].sort((a, b) => a - b)
    if (!edges.length) { segs.push({ rows: g.rows, sess: g.session_id, g, start: 0, end: gv.length }); continue }
    const snap = (i) => edges.reduce((best, e) => (Math.abs(e - i) < Math.abs(best - i) ? e : best), edges[0])
    const cuts = []
    for (const d of deep) {
      const e = snap(d.i)
      if (!e || e < 4 || e > gv.length - 4) continue
      if (cuts.some((c) => Math.abs(c - e) < minGap)) continue
      cuts.push(e)
    }
    for (const h of hardCuts) {
      if (h >= 4 && h <= gv.length - 4 && !cuts.some((c) => Math.abs(c - h) < 2)) cuts.push(h)
    }
    cuts.sort((a, b) => a - b)
    const bounds = [0, ...cuts, gv.length]
    const pieces = []
    for (let k = 0; k < bounds.length - 1; k++) {
      pieces.push({ rows: g.rows.slice(bounds[k], bounds[k + 1]), start: bounds[k], end: bounds[k + 1] })
    }
    // 2026-11-18：原来「不足 4 句整段丢掉」——11-17 真库跑下来有 3 条碎片没进任何件（D82）。
    // 改成并进相邻段：优先并到前一段；它是第一段就并到后一段。一片都不丢。
    for (let i = pieces.length - 1; i >= 0; i--) {
      if (pieces[i].rows.length >= 4) continue
      if (i > 0) {
        pieces[i - 1].rows.push(...pieces[i].rows)
        pieces[i - 1].end = pieces[i].end
        pieces.splice(i, 1)
      } else if (pieces.length > 1) {
        pieces[1].rows.unshift(...pieces[0].rows)
        pieces[1].start = pieces[0].start
        pieces.splice(0, 1)
      }
    }
    for (const p of pieces) segs.push({ rows: p.rows, sess: g.session_id, g, start: p.start, end: p.end })
  }
  onProgress({ stage: 'cut', done: segs.length, total: segs.length })

  // ── 第二层：每段写记叙
  for (const [k, s] of segs.entries()) {
    const ck = 'n|' + s.rows[0].id + '|' + s.rows[s.rows.length - 1].id
    if (cache[ck]) { s.n = cache[ck]; onProgress({ stage: 'narr', done: k + 1, total: segs.length }); continue }
    try {
      const d = JSON.parse(String(await complete({ system: NARR_SYS, text: narrText(s.rows), maxTokens: 340 })))
      calls++
      s.n = {
        title: String(d.title || d.thread || '').trim().slice(0, 40),
        cause: String(d.cause || '').trim(), process: String(d.process || '').trim(),
        result: String(d.result || '').trim(), place: String(d.place || '').trim(),
        who: Array.isArray(d.who) ? d.who.map(String).slice(0, 6) : [],
        realm: String(d.realm || '').trim(),
        anchors: checkAnchors(d.anchors, segText(s.rows)),
      }
    } catch (e) {
      s.n = { title: '', cause: '', process: '', result: '', place: '', who: [], realm: '', anchors: [], err: String((e && e.message) || e).slice(0, 40) }
    }
    cache[ck] = s.n
    saveCache()
    onProgress({ stage: 'narr', done: k + 1, total: segs.length })
  }

  // ── 第三层：判缝（看原文 + 形状数据）
  const joins = []
  for (let k = 0; k < segs.length - 1; k++) {
    const a = segs[k], b = segs[k + 1]
    if (a.sess !== b.sess) { joins.push({ k, verdict: 'new', why: '换会话' }); continue }
    // 2026-11-19 主人定：隔多久只是「提示」，不是判据——硬断只保留「换会话」。
    // 专名不靠字面相等判，交给模型整体比：「潮水」和「那条环」这种近似叫法也算像。
    // 2026-11-19：同会话长讨论被切开时，只给两边最近两句，模型认不出是同一件事的下半截。
    // wideCtx 开（默认）时各喂 4 句，关时回退 2 句；缓存键带这个位，换开关必须换缓存文件。
    const WIDE = wideCtx ? 4 : 2
    const before = a.rows.slice(-WIDE).map(fmtLine).join('\n')
    const after = b.rows.slice(0, WIDE).map(fmtLine).join('\n')
    const f = boundaryFeature(a.g, a.end)
    const gapStr = f.dt >= 3600 ? `${(f.dt / 3600).toFixed(1)} 小时` : `${Math.round(f.dt)} 秒`
    const gapHint = f.dt > 6 * 3600 ? `\n注意：中间隔了 ${(f.dt / 3600).toFixed(1)} 个小时；隔得这么久，别默认两段是接着办的。` : ''
    // 2026-11-18 主人定：判缝只留五个侧面——两边落差、新词率、间隔、谁先说、事帧。
    // 相似度、左右最像、两边句长都砍了：同源数据，写多了反而让模型顺着数字判。
    const feat = `【机器量的边界形状】（只作参考，不替你判断）\n两边落差合起来 ${f.depth.toFixed(2)}，掉得越多越像换了事；\n后一段有 ${Math.round(f.nw * 100)}% 的词是前一段没出现过的；\n中间隔了 ${gapStr}；\n后一段第一句是${f.role === 'user' ? '主人' : '我'}先说的。${gapHint}`
    const aNameStr = (a.n.anchors || []).join('、') || '（没给）'
    const bNameStr = (b.n.anchors || []).join('、') || '（没给）'
    const hm = (r) => String(r.created_at || '').slice(11, 16)
    const aSpan = `共 ${a.rows.length} 句，${hm(a.rows[0])}–${hm(a.rows[a.rows.length - 1])}`
    const bSpan = `共 ${b.rows.length} 句，${hm(b.rows[0])}–${hm(b.rows[b.rows.length - 1])}`
    let text = `【前一段】（${aSpan}）最近${WIDE}句原话：\n${before}\n线索：${a.n.title}\n专名：${aNameStr}\n起因：${a.n.cause}\n经过：${a.n.process}\n结果：${a.n.result}\n\n【后一段】（${bSpan}）最前${WIDE}句原话：\n${after}\n线索：${b.n.title}\n专名：${bNameStr}\n起因：${b.n.cause}\n经过：${b.n.process}\n结果：${b.n.result}\n\n${withFeat ? feat : ''}`
    // 2026-11-18：可选——把两段各自那一轮的事帧「事」附上，当第二份参考。
    // 只作参考，不替代原文；查不到（历史天没有事帧）就不加。
    if (withFrame) {
      const aFrame = frameSummaryOf(db, a.rows[a.rows.length - 1].turn_id)
      const bFrame = frameSummaryOf(db, b.rows[0].turn_id)
      if (aFrame) text += `\n\n【前段最后那一轮在干什么】（事帧，只作参考）：${aFrame}`
      if (bFrame) text += `\n【后段第一轮在干什么】（事帧，只作参考）：${bFrame}`
    }
    const jk = 'j|' + a.rows[a.rows.length - 1].id + '|' + b.rows[0].id + '|' + (withFeat ? 1 : 0) + (withFrame ? 1 : 0) + (wideCtx ? 1 : 0) + '|n4'
    if (cache[jk]) {
      joins.push({ k, ...cache[jk] })
      onProgress({ stage: 'join', done: k + 1, total: segs.length - 1 })
      continue
    }
    try {
      const d = JSON.parse(String(await complete({ system: JOIN_SYS, text, maxTokens: 100 })))
      calls++
      const v = ['same', 'next', 'new'].includes(String(d.verdict)) ? String(d.verdict) : 'new'
      const jj = { verdict: v, why: String(d.why || '').slice(0, 40) }
      cache[jk] = jj
      saveCache()
      joins.push({ k, ...jj })
    } catch {
      joins.push({ k, verdict: 'new', why: 'err' })
    }
    onProgress({ stage: 'join', done: k + 1, total: segs.length - 1 })
  }

  // ── 合并
  const merged = []
  let cur = [segs[0]]
  for (const j of joins) {
    const b = segs[j.k + 1]
    if (j.verdict === 'same' || j.verdict === 'next') cur.push(b)
    else { merged.push(cur); cur = [b] }
  }
  merged.push(cur)

  const pick = (allRows, role, n) => allRows
    .filter((r) => r.role === role && r.text.length >= 10 && r.text.length <= 120)
    .slice(0, n).map((r) => String(r.text).replace(/\s+/g, ' '))

  const seenTitles = new Set()
  const events = []
  let titleCalls = 0
  for (const ev of merged) {
    const head = ev[0].n, tail = ev[ev.length - 1].n
    const allRows = ev.flatMap((x) => x.rows)
    const src = allRows.map((r) => r.text).join('\n')
    const allAnchors = [...new Set(ev.flatMap((x) => x.n.anchors || []))]
    // 2026-11-19：抓手和专名看**所有段**，不再只取头尾——中间段的专名不能漏
    const cues = cuesOf(allAnchors, allRows)
    const anchorPool = [...new Set(allAnchors.concat(cues))].filter(Boolean)

    // 2026-11-19：标题后置——件定形后单独调一次模型，看整件事写标题+摘要+经过+专名（缓存键按件成员算）
    let title = ''
    let titleAnchors = []
    let synthSummary = ''
    let synthProcess = ''
    if (titleSynth) {
      const tk = 't|' + allRows[0].id + '|' + allRows[allRows.length - 1].id + '|2'
      if (cache[tk]) {
        title = cache[tk].title
        titleAnchors = cache[tk].anchors || []
        synthSummary = cache[tk].summary || ''
        synthProcess = cache[tk].process || ''
      } else {
        const lines = ev.map((x, i) => `[${i + 1}] ${x.n.title}｜起因 ${x.n.cause}｜经过 ${x.n.process}｜结果 ${x.n.result}${x.n.anchors && x.n.anchors.length ? '｜专名 ' + x.n.anchors.join('/') : ''}`).join('\n')
        const headText = allRows.slice(0, 2).map(fmtLine).join('\n')
        const tailText = allRows.slice(-2).map(fmtLine).join('\n')
        const input = `【这件事由 ${ev.length} 段组成】\n${lines}\n\n【开头两句原话】\n${headText}\n\n【结尾两句原话】\n${tailText}`
        try {
          const d = JSON.parse(String(await complete({ system: TITLE_SYS, text: input, maxTokens: 200 })))
          titleCalls++
          title = String(d.title || '').trim().slice(0, 40)
          titleAnchors = checkAnchors(d.anchors, src)
          synthSummary = String(d.summary || '').trim().slice(0, 120)
          synthProcess = String(d.process || '').trim().slice(0, 160)
          cache[tk] = { title, anchors: titleAnchors, summary: synthSummary, process: synthProcess }
          saveCache()
        } catch { titleCalls++ }
      }
    }

    const finalAnchors = titleAnchors.length ? titleAnchors : (anchorPool.length ? anchorPool.slice(0, 3) : checkAnchors([], src))
    events.push({
      // 兜底：综合标题没写出来就用段标题；titleOf 仍保证标题带一个专名、重名加第二个专名
      title: titleOf({ title: title || head.title }, tail, finalAnchors, seenTitles),
      // 2026-11-19：摘要和经过都用整件综合（标题那次看各段写），不再只取第一段
      summary: String(synthSummary || head.process || head.title || tail.process || tail.title || '').slice(0, 160),
      // 2026-11-19：件有没有了结，从整件的收尾（结果）读；读不出就空着
      status: statusOf(tail.result || head.result || ''),
      quotes: [...pick(allRows, 'assistant', 2), ...pick(allRows, 'user', 2)],
      cues,
      fragmentIds: allRows.map((r) => r.id),
      cause: head.cause, process: synthProcess || head.process, result: tail.result,
      place: placeOf(ev), realm: realmOf(ev),
      who: [...new Set(ev.flatMap((x) => x.n.who || []))],
      anchors: finalAnchors,
      joined: ev.length,
      // 2 时不写库，只给排序/验收用
      sessionId: ev[0].sess || '',
      _sess: ev[0].sess || '',
      _at: String(allRows[0]?.created_at || ''),
      _start: String(allRows[0]?.created_at || ''),
      _end: String(allRows[allRows.length - 1]?.created_at || ''),
    })
  }

  // 2026-11-22（主人定的“回头合并”）：判完缝再回头看一眼碎片。
  // 5 分钟以内的件，不管几行，都当“上一件事的前半截/一句确认”：
  //   先并回同会话的前一件；它要是这个会话的第一件，就并进后面的下一件（并到开头）；
  //   跨会话但时间紧挨着（10 分钟内）也允许并。这样 1 分钟的“下一步干什么”不会再单独成件。
  for (let i = events.length - 1; i >= 0; i--) {
    const cur = events[i]
    const mins = (Date.parse(cur._end) - Date.parse(cur._start)) / 60000
    if (!(mins < 5)) continue
    const near = (a, b) => Math.abs(Date.parse(a._start) - Date.parse(b._start)) <= 15 * 60000
    const prev = i > 0 ? events[i - 1] : null
    const next = i + 1 < events.length ? events[i + 1] : null
    const canPrev = prev && ((prev._sess || '') === (cur._sess || '') || near(prev, cur))
    const canNext = !canPrev && next && ((next._sess || '') === (cur._sess || '') || near(cur, next))
    if (!canPrev && !canNext) continue
    const tgt = canPrev ? prev : next
    tgt.fragmentIds = canPrev ? [...tgt.fragmentIds, ...cur.fragmentIds] : [...cur.fragmentIds, ...tgt.fragmentIds]
    tgt.quotes = [...new Set([...tgt.quotes, ...cur.quotes])].slice(0, 4)
    tgt.cues = [...new Set([...(tgt.cues || []), ...(cur.cues || [])])].slice(0, 6)
    tgt.anchors = [...new Set([...(tgt.anchors || []), ...(cur.anchors || [])])].slice(0, 4)
    if (canPrev) tgt._end = cur._end
    else tgt._start = cur._start
    tgt.status = tgt.status || cur.status
    tgt.joined = (tgt.joined || 1) + (cur.joined || 1)
    tgt.mergedShort = (tgt.mergedShort || 0) + 1
    events.splice(i, 1)
  }

  // 2026-11-19：一天多会话并行时，按 groups 顺序出件会让时间来回跳（16:00→16:41→00:28）。
  // 排法：会话分组、组内按时间、组间按各组首件时间；读故事才顺着一条线走。
  const sessOrder = []
  const bySess = new Map()
  for (const e of events) {
    const key = e._sess || ''
    if (!bySess.has(key)) { bySess.set(key, []); sessOrder.push(key) }
    bySess.get(key).push(e)
  }
  sessOrder.sort((s1, s2) => Date.parse(bySess.get(s1)[0]._at) - Date.parse(bySess.get(s2)[0]._at))
  const ordered = sessOrder.flatMap((s) => bySess.get(s)
    .slice().sort((x, y) => Date.parse(x._at) - Date.parse(y._at))
    .map(({ _at, _sess, _start, _end, ...rest }) => rest))

  return {
    events: ordered,
    rows: clean.length,
    // 2026-11-19：质量指标改口径——单段比例会把正常长件算成毛病，看「3 句以下」才像碎件。
    stats: {
      rows: clean.length, segments: segs.length, events: ordered.length, calls, titleCalls,
      tiny: ordered.filter((e) => e.fragmentIds.length <= 3).length,
      oneSeg: ordered.filter((e) => e.joined === 1).length,
    },
  }
}
