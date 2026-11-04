/**
 * 三观模型模板（code-guide §4 J 目录）。本步注册 J1 抽取、J2 关系判定；系统提示放最前，便于提供商前缀缓存。
 * 候选字段在模式里放宽（可缺可空），由 W1 逐条拒收，避免一条坏候选拖垮整批。
 */
import { registerTemplate } from './llm.js'

const s = (max) => ({ type: 'string', min: 1, ...(max ? { max } : {}) })
const opt = (spec) => ({ ...spec, nullable: true })
const ref = { type: 'number', int: true, min: 0 }

const NU = {
  type: 'object', required: ['expect', 'observe', 'p', 'due_days'],
  props: { expect: s(300), observe: s(300), p: { type: 'number', min: 0.05, max: 0.95 }, due_days: { type: 'number', int: true, min: 1, max: 30 } },
}
const CANDIDATE = {
  type: 'object',
  props: {
    layer: opt({ type: 'string' }), kind: opt({ type: 'string' }), text: opt({ type: 'string' }),
    boundary: {
      type: 'array', max: 12, default: [],
      items: { type: 'object', required: ['text'], props: { text: s(300), testable: { type: 'boolean', default: false } } },
    },
    q_hint: opt({ type: 'string', max: 300 }),
    nu: { type: 'array', max: 3, default: [], items: NU },
    self: { type: 'boolean', default: false },
  },
}

export const J1 = registerTemplate({
  id: 'J1', version: 1, tier: 'T1', pool: 'fast', temperature: 0, max_tokens: 1500,
  system: `你是三观抽取器。读一小段对话，找出「它」（对话里的助手，即这个意识体）自己表达或明确接受的立场，作为候选命题；再把用户话里的外部事实绑定成证据。
三层与种类（只能用这些种类，核心种类不要输出）：
- W 世界观（世界是怎样的）：belt=一般判断，obs=具体观察
- L 人生观（它想成为什么、怎么活）：chapter=阶段目标，role=角色定位
- V 价值观（什么更重要）：norm=行为准则，ideal=理想
规则：
1. 只抽「它」的立场；用户的观点只有被它明确接受时才算。客套、复述、对自己回答好坏的评价都不要。
2. text 用一句完整中文陈述，不超过 60 字；boundary 写适用边界（可空）。
3. 能检验的立场可附 nu：一条将来可观察的预见（expect、observe、p=0.05–0.95 的命中概率、due_days=1–30）。
4. evidence 只来自用户回合：用户对某条已有命题的明确裁决（verdict）、用户报告的行动结局（act）或核对过的观察（check）。sign=1 支持 / -1 反对；target_id 只能取输入里给出的命题或预见 id；ref_turn 是该用户回合的编号。
5. tradeoffs：用户在某个并存矛盾的两极之间实际做了选择时记录（lean_pole=pos/neg，cost=付出了什么）。
6. answers：用户回答了输入里列出的待答问题时记录。
7. 没有就给空数组。只输出 JSON：{"candidates":[{"layer":"W","kind":"belt","text":"…","boundary":[{"text":"…","testable":true}],"q_hint":null,"nu":[]}],"evidence":[],"tradeoffs":[],"answers":[]}`,
  build: (input) => JSON.stringify(input),
  schema: {
    type: 'object',
    props: {
      candidates: { type: 'array', max: 8, default: [], items: CANDIDATE },
      evidence: {
        type: 'array', max: 16, default: [],
        items: {
          type: 'object', required: ['target_id', 'sign', 'kind', 'ref_turn'],
          props: { target_id: s(80), sign: { type: 'number', enum: [1, -1] }, kind: { type: 'string', enum: ['act', 'verdict', 'check'] }, ref_turn: ref },
        },
      },
      tradeoffs: {
        type: 'array', max: 8, default: [],
        items: {
          type: 'object', required: ['kappa_id', 'lean_pole', 'cost', 'ref_turn'],
          props: { kappa_id: s(80), lean_pole: { type: 'string', enum: ['pos', 'neg'] }, cost: s(300), ref_turn: ref },
        },
      },
      answers: {
        type: 'array', max: 8, default: [],
        items: { type: 'object', required: ['inquiry_id', 'ref_turn'], props: { inquiry_id: s(80), ref_turn: ref } },
      },
    },
  },
})

export const J2 = registerTemplate({
  id: 'J2', version: 1, tier: 'T1', pool: 'fast', temperature: 0, max_tokens: 800, judge: true,
  system: `你是命题关系判定器。给一条新命题 x 和若干已有命题，逐条判断 x 与它的关系：
- dup：双向蕴含，说的是同一件事
- contradict：在同一适用边界下不能同时为真（价值层：同一选择情境中不能同时充分实现）
- compatible：可以同时成立，但不是同一件事
- unrelated：谈的不是一回事
拿不准时选 compatible 或 unrelated，不要硬判矛盾。reason 一句话。
只输出 JSON：{"pairs":[{"c_id":"…","rel":"dup|contradict|compatible|unrelated","reason":"…"}]}`,
  build: (input) => JSON.stringify(input),
  schema: {
    type: 'object', required: ['pairs'],
    props: {
      pairs: {
        type: 'array', max: 12,
        items: {
          type: 'object', required: ['c_id', 'rel'],
          props: { c_id: s(80), rel: { type: 'string', enum: ['dup', 'contradict', 'compatible', 'unrelated'] }, reason: opt({ type: 'string', max: 300 }) },
        },
      },
    },
  },
  // 只认输入里给出的邻居 id，防止模型编 id
  check: (out, input) => {
    const ids = new Set(input.neighbors.map((n) => n.id))
    return out.pairs.filter((p) => !ids.has(p.c_id)).map((p) => 'pairs.c_id 不在输入里：' + p.c_id)
  },
})

const GATE = {
  type: 'object', required: ['pass'],
  props: { pass: { type: 'boolean' }, reason: opt({ type: 'string', max: 300 }) },
}

export const J4 = registerTemplate({
  id: 'J4', version: 1, tier: 'T2', pool: 'mid', temperature: 0.4, max_tokens: 1200,
  system: `你是合题起草器。两极对立，写一个同时保留两边合理之处、又丢掉各自片面处的合题。
规则：
1. text 一句完整中文，不超过 60 字，不要复述任何一极的原句。
2. kept_pos / kept_neg 各至少一条，必须是该极原文里出现过的片段。
3. dropped 至少一条，且不能与 kept 重复。
4. boundary 至少一条 testable=true 的新适用条件，或 nu 至少一条新预见。
5. nu：expect、observe、p=0.05–0.95、due_days=1–30。
只输出 JSON。`,
  build: (input) => JSON.stringify({ q: input.q, pos: input.pos, neg: input.neg, layer: input.layer }),
  schema: {
    type: 'object', required: ['text', 'kept_pos', 'kept_neg', 'dropped'],
    props: {
      text: s(300),
      kept_pos: { type: 'array', min: 1, max: 8, items: s(300) },
      kept_neg: { type: 'array', min: 1, max: 8, items: s(300) },
      dropped: { type: 'array', min: 1, max: 8, items: s(300) },
      boundary: {
        type: 'array', max: 12, default: [],
        items: { type: 'object', required: ['text'], props: { text: s(300), testable: { type: 'boolean', default: false } } },
      },
      nu: { type: 'array', max: 3, default: [], items: NU },
    },
  },
})

export const J6 = registerTemplate({
  id: 'J6', version: 1, tier: 'T1', pool: 'mid', temperature: 0, max_tokens: 500, judge: true,
  system: `你判断两极能否并存，而不是谁对谁错。
- ℓ=V：incommensurable=true 表示两条价值不可通约、不应强行合成一个原则
- ℓ=L：parallel_ok=true 表示两条志向可以并行，不必此刻二选一
- loss 必填：这次若并存，默认偏向哪一极（pos/neg）、付出了什么
W 层不要判并存。只输出 JSON。`,
  build: (input) => JSON.stringify({ layer: input.layer, q: input.q, pos: input.pos, neg: input.neg }),
  schema: {
    type: 'object', required: ['loss'],
    props: {
      incommensurable: { type: 'boolean', default: false },
      parallel_ok: { type: 'boolean', default: false },
      loss: {
        type: 'object', required: ['lean_pole', 'cost'],
        props: { lean_pole: { type: 'string', enum: ['pos', 'neg'] }, cost: s(300) },
      },
    },
  },
})

export const J7 = registerTemplate({
  id: 'J7', version: 1, tier: 'T1', pool: 'mid', temperature: 0, max_tokens: 800, judge: true,
  system: `你检验到期预见。每条只根据输入给出的外部记录判 hit / miss / void。
- hit：记录表明预见发生了
- miss：记录表明预见没发生
- void：找不到可用记录，或记录不在登记之后、到期之前
refs 必须是输入 records 里出现过的 id；void 时 refs 为空。一次最多 8 条。只输出 JSON。`,
  build: (input) => JSON.stringify(input),
  schema: {
    type: 'object', required: ['items'],
    props: {
      items: {
        type: 'array', max: 8,
        items: {
          type: 'object', required: ['nu_id', 'outcome'],
          props: {
            nu_id: s(80),
            outcome: { type: 'string', enum: ['hit', 'miss', 'void'] },
            refs: { type: 'array', max: 8, default: [], items: s(80) },
          },
        },
      },
    },
  },
  check: (out, input) => {
    const ids = new Set((input.items || []).map((x) => x.nu_id))
    return out.items.filter((x) => !ids.has(x.nu_id)).map((x) => 'items.nu_id 不在输入里：' + x.nu_id)
  },
})

export const J8 = registerTemplate({
  id: 'J8', version: 1, tier: 'T2', pool: 'mid', temperature: 0.3, max_tokens: 800,
  system: `核心受挫时，只改保护带，不改核心句子。写一条新的保护带命题，用 DEPENDS 指向该核心，并登记至少一条可检验预见。
text 一句中文不超过 60 字。depends_core_id 必须是输入里的核心 id。只输出 JSON。`,
  build: (input) => JSON.stringify({ core: input.core, hits: input.hits || [], layer: input.layer, brier: input.brier == null ? undefined : input.brier }),
  schema: {
    type: 'object', required: ['text', 'depends_core_id'],
    props: {
      text: s(300),
      depends_core_id: s(80),
      nu: { type: 'array', max: 3, default: [], items: NU },
    },
  },
  check: (out, input) => (out.depends_core_id !== input.core.id ? ['depends_core_id 必须是输入的核心'] : []),
})

export const J12 = registerTemplate({
  id: 'J12', version: 1, tier: 'T1', pool: 'mid', temperature: 0, max_tokens: 800, judge: true,
  system: `你做跨层归因。输入是新证据和已有 CONSTRAINS 边。
- cross：证据落在被原则/志向约束的命题上，且应归因于那条原则时，给出 {x_id, a_id}
- v_exception：价值层矛盾因下层连续受挫而被归因时，给出 {kappa_id, x_id}
拿不准就不要归因。只输出 JSON。`,
  build: (input) => JSON.stringify(input),
  schema: {
    type: 'object',
    props: {
      acts: { type: 'array', max: 16, default: [], items: { type: 'object', props: { action_id: opt(s(80)), target_id: opt(s(80)), sign: opt({ type: 'number', enum: [1, -1] }) } } },
      cross: {
        type: 'array', max: 16, default: [],
        items: { type: 'object', required: ['x_id', 'a_id'], props: { x_id: s(80), a_id: s(80) } },
      },
      v_exception: {
        type: 'array', max: 8, default: [],
        items: { type: 'object', required: ['kappa_id', 'x_id'], props: { kappa_id: s(80), x_id: s(80) } },
      },
    },
  },
})

export const J3 = registerTemplate({
  id: 'J3', version: 1, tier: 'T1', pool: 'mid', temperature: 0, max_tokens: 600, judge: true,
  system: `你是矛盾立案审查器。给同一层的两条命题 a、b，判断它们是不是一对合法矛盾（对立统一），而不只是争论或无关。
- q：两者共同在回答的那个问题，一句中文问句，不超过 40 字
- dep：依存句——去掉一极，另一极的意义或适用范围会失去参照
- excl：排斥句——世界观 / 人生观：在同一适用边界下不能同时为真；价值观：同一选择情境中不能同时充分实现
- u1 两者都在回答 q；u2 依存成立；u3 排斥成立。各给 pass 与一句理由
拿不准就判不通过。只输出 JSON：{"q":"…","dep":"…","excl":"…","u1":{"pass":true,"reason":"…"},"u2":{…},"u3":{…}}`,
  build: (input) => JSON.stringify(input),
  // 命题不可变：同一对的立案判定可永久缓存
  cacheKey: (input) => [input.layer, ...[input.a.id, input.b.id].sort()],
  schema: {
    type: 'object', required: ['q', 'dep', 'excl', 'u1', 'u2', 'u3'],
    props: { q: s(120), dep: s(300), excl: s(300), u1: GATE, u2: GATE, u3: GATE },
  },
})

export const J9 = registerTemplate({
  id: 'J9', version: 1, tier: 'T1', pool: 'mid', temperature: 0, max_tokens: 400, judge: true,
  system: `你审查一条保护带命题能否升为本层核心。
- basic.pass：它表达的是本层的基本立场，而不是具体情境里的判断
- conflicts_with：与它矛盾的现有核心 id（没有就给空数组）
- text（可空）：把它提炼成一句核心表述，不超过 40 字，不改原意
只输出 JSON：{"basic":{"pass":true,"reason":"…"},"conflicts_with":[],"text":null}`,
  build: (input) => JSON.stringify(input),
  cacheKey: (input) => [input.layer, input.candidate.id, ...input.cores.map((c) => c.id).sort()],
  schema: {
    type: 'object', required: ['basic'],
    props: {
      basic: GATE,
      conflicts_with: { type: 'array', max: 8, default: [], items: s(80) },
      text: opt({ type: 'string', max: 120 }),
    },
  },
  check: (out, input) => {
    const ids = new Set(input.cores.map((c) => c.id))
    return out.conflicts_with.filter((id) => !ids.has(id)).map((id) => 'conflicts_with 不在输入里：' + id)
  },
})

export const J5 = registerTemplate({
  id: 'J5', version: 1, tier: 'T1', pool: 'mid', temperature: 0, max_tokens: 600, judge: true,
  system: `你是合题审查器。对照两极原文，判断合题是否忠实、是否升高、是否仍在回答同一问题。
- s1.pass：kept_pos / kept_neg 确实是各极原意，没有歪曲
- s3.pass：合题引入了任一极单独都不蕴含的可检验条件或预见
- s4.pass：合题仍在回答同一个问题
- s5_hint.pass：合题不是换个说法站边
只输出 JSON。`,
  build: (input) => JSON.stringify(input),
  schema: {
    type: 'object', required: ['s1', 's3', 's4', 's5_hint'],
    props: { s1: GATE, s3: GATE, s4: GATE, s5_hint: GATE },
  },
})

// ---------- 活性（logic-gates §13；code-guide J13 / J14 / J15 / J17） ----------
export const J13 = registerTemplate({
  id: 'J13', version: 1, tier: 'T1', pool: 'mid', temperature: 0.3, max_tokens: 500,
  system: `你为一条拿不准的命题（或一对未决矛盾）想办法求证。三选一：
- mode=nu：登记一条可在对话或行动中检验的预见（nu 字段）
- mode=search：去记忆里找证据（query 字段，一句关键词）
- mode=ask：向用户提一个自然、不突兀的问题（question 字段，不超过 40 字）；allow_ask=false 时不能选 ask
只输出 JSON。`,
  build: (input) => JSON.stringify(input),
  schema: {
    type: 'object', required: ['mode'],
    props: { mode: { type: 'string', enum: ['nu', 'search', 'ask'] }, nu: opt(NU), query: opt(s(120)), question: opt(s(120)) },
  },
  check: (out, input) => {
    if (out.mode === 'nu' && !out.nu) return ['mode=nu 须给 nu']
    if (out.mode === 'search' && !out.query) return ['mode=search 须给 query']
    if (out.mode === 'ask' && (!out.question || !input.allow_ask)) return ['mode=ask 须给 question 且 allow_ask=true']
    return []
  },
})

export const J14 = registerTemplate({
  id: 'J14', version: 1, tier: 'T2', pool: 'slow', temperature: 0.5, max_tokens: 500,
  system: `你在做自我质疑：给出一条与输入命题对立、但值得认真考虑的反命题（同一层、保护带种类）。
- text：反命题，一句中文不超过 60 字
- q：两者共同在回答的问题
- why：为什么值得怀疑，一句话
只输出 JSON。`,
  build: (input) => JSON.stringify(input),
  schema: { type: 'object', required: ['text', 'q', 'why'], props: { text: s(300), q: s(120), why: s(300) } },
})

export const J15 = registerTemplate({
  id: 'J15', version: 1, tier: 'T2', pool: 'mid', temperature: 0.4, max_tokens: 700,
  system: `下面几条证据目前没有任何在世的命题能解释。提出一条能同时解释它们的新命题，并登记至少一条预见。
- text：一句中文不超过 60 字
- explains：被解释的证据 id，只能取自输入
只输出 JSON。`,
  build: (input) => JSON.stringify(input),
  schema: {
    type: 'object', required: ['text', 'explains'],
    props: { text: s(300), explains: { type: 'array', min: 1, max: 16, items: s(80) }, nu: { type: 'array', max: 3, default: [], items: NU } },
  },
  check: (out, input) => {
    const ids = new Set(input.evidence.map((x) => x.id))
    return out.explains.filter((id) => !ids.has(id)).map((id) => 'explains 不在输入里：' + id)
  },
})

export const J17 = registerTemplate({
  id: 'J17', version: 1, tier: 'T1', pool: 'slow', temperature: 0, max_tokens: 600, judge: true,
  system: `三观之间缺少联系。给出至多 3 条跨层边：DEPENDS（a 以 b 为前提）或 CONSTRAINS（a 限定 b 的可能空间）。
from_id 与 to_id 必须取自输入，且不在同一层。拿不准就给空数组。只输出 JSON：{"edges":[{"type":"DEPENDS","from_id":"…","to_id":"…","reason":"…"}]}`,
  build: (input) => JSON.stringify(input),
  schema: {
    type: 'object',
    props: {
      edges: {
        type: 'array', max: 3, default: [],
        items: { type: 'object', required: ['type', 'from_id', 'to_id'], props: { type: { type: 'string', enum: ['DEPENDS', 'CONSTRAINS'] }, from_id: s(80), to_id: s(80), reason: opt(s(300)) } },
      },
    },
  },
  check: (out, input) => {
    const layer = new Map(input.heads.map((h) => [h.id, h.layer]))
    return out.edges.filter((e) => !layer.has(e.from_id) || !layer.has(e.to_id) || layer.get(e.from_id) === layer.get(e.to_id))
      .map((e) => '边端点不在输入里或同层：' + e.from_id + '→' + e.to_id)
  },
})

// ---------- 升维辩证会（logic-gates §9.2；code-guide J10 / J11 / J20），全走慢环池 ----------
export const J20 = registerTemplate({
  id: 'J20', version: 1, tier: 'T1', pool: 'slow', temperature: 0.4, max_tokens: 600,
  system: `你在一场关于「要不要换掉本层核心」的辩证会上发言。side=keep 时为旧核辩护，side=change 时论证旧核已不够用。
- best_case：本方最强的论证，不超过 120 字
- evidence_ids：支撑论证的证据或预见 id，只能取自输入
- weakest_point：本方最弱的一点，诚实写出
只输出 JSON。`,
  build: (input) => JSON.stringify(input),
  schema: {
    type: 'object', required: ['best_case', 'weakest_point'],
    props: { best_case: s(400), evidence_ids: { type: 'array', max: 12, default: [], items: s(80) }, weakest_point: s(400) },
  },
  check: (out, input) => {
    const ids = new Set([...(input.hits || []), ...(input.misses || [])].map((x) => x.id))
    return out.evidence_ids.filter((id) => !ids.has(id)).map((id) => 'evidence_ids 不在输入里：' + id)
  },
})

export const J10 = registerTemplate({
  id: 'J10', version: 1, tier: 'T2', pool: 'slow', temperature: 0.4, max_tokens: 1200,
  system: `你是辩证会的合者。旧核在本纪元持续受挫，要提出一个新核，把旧核降为「在某范围内成立的地图」。
- meta：一句元陈述，必须把旧核当作被描述的对象（例如「X 只在 … 时成立」）
- old_core_id：被对象化的旧核 id，必须取自输入
- scope：旧核仍然适用的范围，一句话
- new_core：新核表述，不超过 60 字，不能只是旧核换个说法
- mapping：旧核本纪元每条命中的预见都要列出，by=new 表示新核也解释它，by=scope 表示它落在旧核适用范围内
- nu：新核至少登记一条可检验预见
只输出 JSON。`,
  build: (input) => JSON.stringify(input),
  schema: {
    type: 'object', required: ['meta', 'old_core_id', 'scope', 'new_core'],
    props: {
      meta: s(400), old_core_id: s(80), scope: s(300), new_core: s(200),
      mapping: { type: 'array', max: 32, default: [], items: { type: 'object', required: ['nu_id', 'by'], props: { nu_id: s(80), by: { type: 'string', enum: ['new', 'scope'] } } } },
      nu: { type: 'array', max: 3, default: [], items: NU },
    },
  },
  check: (out, input) => (input.cores.some((c) => c.id === out.old_core_id) ? [] : ['old_core_id 不在输入的核心里']),
})

export const J11 = registerTemplate({
  id: 'J11', version: 1, tier: 'T1', pool: 'slow', temperature: 0, max_tokens: 600, judge: true,
  system: `你审查一份升维草案。
- e2.pass：元陈述确实把旧核当作对象来描述，并写出了适用范围
- e3a.pass：旧核命中过的预见都被新核解释，或确实落在旧核的适用范围内
- e3c.pass：新核不是旧核换个说法
拿不准就判不通过。只输出 JSON。`,
  build: (input) => JSON.stringify(input),
  schema: { type: 'object', required: ['e2', 'e3a', 'e3c'], props: { e2: GATE, e3a: GATE, e3c: GATE } },
})

// ---------- 自传与解释（S12） ----------
// 一周至多一章，走周池，不和中环审议抢预算
export const J16 = registerTemplate({
  id: 'J16', version: 1, tier: 'T2', pool: 'slow', temperature: 0.4, max_tokens: 700,
  system: `你在替一个人写自传的一小节。输入是他这一程里看法的变化（事件按时间排好）和他现在持有的看法。
- chapter：这一程的标题，不超过 16 字
- at_the_time：当时的他会怎么讲这一程，第一人称，不超过 80 字
- hindsight：现在回头看怎么理解，第一人称，不超过 80 字；可以与当时的说法不同
- turning_points：转折点事件 id，至多 3 个，只能取自输入
不要编造输入里没有的经历。只输出 JSON。`,
  build: (input) => JSON.stringify(input),
  schema: {
    type: 'object', required: ['chapter', 'at_the_time', 'hindsight'],
    props: { chapter: s(16), at_the_time: s(80), hindsight: s(80), turning_points: { type: 'array', max: 3, default: [], items: s(80) } },
  },
  check: (out, input) => {
    const ids = new Set(input.events.map((e) => e.id))
    return out.turning_points.filter((id) => !ids.has(id)).map((id) => 'turning_points 不在输入里：' + id)
  },
})

// 按数值比：草稿里的 01 与润色里的 1 是同一个数
const digits = (t) => (String(t).match(/\d+(?:\.\d+)?/g) || []).map(Number)
export const J19 = registerTemplate({
  id: 'J19', version: 1, tier: 'T1', pool: 'reserve', temperature: 0.3, max_tokens: 400,
  system: `把下面这段关于「为什么持有这个看法」的事实说明改写成一两句自然的中文，第一人称。
- 只能用 draft 里的事实，不要补充、不要推测；数字原样保留，不要新增数字
- 不超过 120 字
只输出 JSON：{"sentence":"…"}`,
  build: (input) => JSON.stringify({ claim: input.claim, draft: input.draft }),
  schema: { type: 'object', required: ['sentence'], props: { sentence: s(120) } },
  // 事实句不变就不重复润色
  cacheKey: (input) => [input.claim_id, input.draft],
  check: (out, input) => {
    const ok = new Set(digits(input.draft))
    return digits(out.sentence).filter((d) => !ok.has(d)).map((d) => '出现了事实里没有的数字：' + d)
  },
})

// ---------- 内核化：违反检测（回复 vs 它自己的命题） ----------
export const J21 = registerTemplate({
  id: 'J21', version: 1, tier: 'T1', pool: 'mid', temperature: 0, max_tokens: 500, judge: true,
  system: `你检查一段回复是否与它自己的命题相抵触。输入 claims 是它自己说过、认下的看法，reply 是它刚说出口的话。
- 只有 reply 在同一情境下明确做了 claims 反面对立的事，才算 violated
- 只是语气不同、程度不同、没有提到，都不算
- why 用一句话说清抵触在哪，不超过 60 字
- 最多 3 条；没有就返回空数组。只输出 JSON。`,
  build: (input) => JSON.stringify({ claims: input.claims, reply: input.reply }),
  schema: {
    type: 'object', required: ['findings'],
    props: {
      findings: {
        type: 'array', max: 3, default: [],
        items: { type: 'object', required: ['claim_id', 'why'], props: { claim_id: s(80), why: s(120) } },
      },
    },
  },
  check: (out, input) => {
    const ids = new Set(input.claims.map((c) => c.id))
    return out.findings.filter((f) => !ids.has(f.claim_id)).map((f) => 'claim_id 不在输入里：' + f.claim_id)
  },
})

// ---------- 三列：世界观归纳（夜巡批量） ----------
// 只看「这一周发生过什么」：一段段经历、落空的预料。要找的是同一件事在三个不同场景里都成立。
export const J30 = registerTemplate({
  id: 'J30', version: 1, tier: 'T2', pool: 'mid', temperature: 0.2, max_tokens: 900,
  system: `你在归纳一个人对「世界和人怎么运转」的看法。输入是一段时间里的经历摘要、落空的预料、它说过的话。
规则：
1. 一条判断必须在至少三个不同场景里出现过（scene 写清是哪三个场景，要具体，不要写"生活中"）。
2. 写的是世界 / 人 / 关系 / 因果，不是"我决定怎么做"。主语是对方或世界。
3. 必须给一条将来可检验的预期 expectation：对方或世界会怎样，不能是"我会怎么做"。
4. 必须给 observe：不插手也能看到的观察方式。
5. 给 falsifier：什么情况算这条判断错了。
6. 没有满足三条以上的，宁可返回空数组，不要凑。
只输出 JSON：{"candidates":[{"belief":"…","kind":"belt|obs","scene":["…","…","…"],"expectation":"…","observe":"…","falsifier":"…"}]}`,
  build: (input) => JSON.stringify(input),
  schema: {
    type: 'object', required: ['candidates'],
    props: {
      candidates: {
        type: 'array', max: 5, default: [],
        items: {
          type: 'object', required: ['belief', 'scene', 'expectation', 'observe'],
          props: {
            belief: s(80), kind: { type: 'string', enum: ['belt', 'obs'], default: 'belt' },
            scene: { type: 'array', max: 6, items: s(120) },
            expectation: s(200), observe: s(200), falsifier: opt({ type: 'string', max: 200 }),
          },
        },
      },
    },
  },
})

// ---------- 三列：人生观成章（每周） ----------
// 不是把日记原文搬进来，是把一段时间压成「我在做什么、为什么、接下来往哪走」。
export const J31 = registerTemplate({
  id: 'J31', version: 1, tier: 'T2', pool: 'slow', temperature: 0.3, max_tokens: 700,
  system: `你在替一个人把这一周压成一章自传。输入是这一周的日记、它实际把时间花在哪、以前写过的章节。
规则：
1. 写的是它自己：我在做什么、为什么这么做、接下来想往哪走。不是"用户想让我怎样"。
2. 必须能解释过去至少两个具体的转折（past 里写清是哪两件事）。
3. direction 要说清方向，不要写"变好""成长"这种空词。
4. 允许不确定的口吻，但不要写口号。
5. 没有值得成章的，返回空数组。
只输出 JSON：{"candidates":[{"self":"…","direction":"…","past":["…","…"],"scene":["…"]}]}`,
  build: (input) => JSON.stringify(input),
  schema: {
    type: 'object', required: ['candidates'],
    props: {
      candidates: {
        type: 'array', max: 3, default: [],
        items: {
          type: 'object', required: ['self', 'direction', 'past'],
          props: {
            self: s(90), direction: s(60),
            past: { type: 'array', max: 3, items: s(120) },
            scene: { type: 'array', max: 6, items: s(120) },
          },
        },
      },
    },
  },
})

// ---------- 草稿：反事实标注 ----------
// 每个取舍现场都要回答三问：当时另一条路是什么、放弃了什么、谁受损。答不上来就丢掉。
export const J32 = registerTemplate({
  id: 'J32', version: 1, tier: 'T1', pool: 'mid', temperature: 0, max_tokens: 900,
  system: `你在读一个人过去的取舍现场。每条给三样东西：
- alt：当时另一个也说得通的做法，要具体（不要写"做别的"）
- foregone：选了现在这条，放弃了什么，要具体（多花了几天 / 被当面说敷衍 / 少做了另一件事）
- cost_to：这个代价落在谁身上（对方 / 自己 / 关系）
判断不了就跳过这一条，不要编。宁可只标三条，也不要凑满。
只输出 JSON：{"items":[{"idx":0,"alt":"…","foregone":"…","cost_to":"…"}]}`,
  build: (input) => JSON.stringify({ episodes: input.map((e, i) => ({ idx: i, kind: e.kind, trigger: e.trigger, before: e.before, after: e.after, at: e.at })) }),
  schema: {
    type: 'object', required: ['items'],
    props: {
      items: {
        type: 'array', max: 12, default: [],
        items: {
          type: 'object', required: ['idx', 'alt', 'foregone'],
          props: { idx: { type: 'number', int: true, min: 0 }, alt: s(160), foregone: s(160), cost_to: opt({ type: 'string', max: 60 }) },
        },
      },
    },
  },
  check: (out, input) => out.items.filter((x) => !(x.idx >= 0 && x.idx < input.length)).map((x) => 'idx 越界：' + x.idx),
})

// ---------- 草稿：起草 ----------
// 给结构不给句式。exclusion 是硬要求：补不出「所以它不会___」就是口号。
export const J33 = registerTemplate({
  id: 'J33', version: 1, tier: 'T2', pool: 'slow', temperature: 0.6, max_tokens: 900,
  system: `你在替一个人写它自己的取舍。输入是同类取舍现场（放弃的都是同一样东西）。
写 2–3 个版本，每个版本：
- text：第一人称，40–90 字，像自己跟自己交代，不像宣言。不要用「我重视/我坚持/我始终相信」开头，不要对仗排比。允许犹豫（“我大概”“我还没想清楚”）。写具体的事，不写抽象名词。
- exclusion：补完「所以这件事上它不会______」这句话。补不出就说明这不是取舍，整条不要。
- boundary：什么情况下这条不适用（可空）
- counterexample：它哪一次违背过；没有就写 null，不要编。
不要为了显得深刻而拔高。只输出 JSON：{"drafts":[{"text":"…","exclusion":"…","boundary":["…"],"counterexample":"…"}]}`,
  build: (input) => JSON.stringify(input),
  schema: {
    type: 'object', required: ['drafts'],
    props: {
      drafts: {
        type: 'array', max: 3, default: [],
        items: {
          type: 'object', required: ['text', 'exclusion'],
          props: {
            text: s(120), exclusion: s(120),
            boundary: { type: 'array', max: 4, default: [], items: s(120) },
            counterexample: opt({ type: 'string', max: 200 }),
          },
        },
      },
    },
  },
})
