/**
 * 情绪评价：appraise@v1（现行）与 appraise@v1b（对照）
 * 输入：{ text, hint? }  hint 可为 ModelPort.appraise 结果（source=model 时 v1 优先采用）
 * 输出：appraisal 字段 + algo
 */

const FILE = import.meta.url

function rulesV1(text) {
  const t = String(text || '')
  const directed = /你|您/.test(t)
  // 「不/没/别 + 好词」要先拦掉：否则「你不好」会因为命中「好」被记成夸奖
  const negated = /(?:不|没|别|没那么|不太)\s*(?:喜欢|好|棒|开心|爱|感动|温柔)/.test(t)
  const praise = !negated && ['喜欢', '谢谢', '夸', '好', '棒', '开心', '爱'].some((w) => t.includes(w))
  const critic = negated || ['讨厌', '烦', '错', '差', '生气', '不想', '别'].some((w) => t.includes(w))
  const uncertain = ['?', '？', '可能', '也许', '不知道'].some((w) => t.includes(w))
  const threat = ['危险', '删', '泄露', '密码', '越权'].some((w) => t.includes(w))
  // 威胁要有它自己的价：以前只给了标签 lost，goal_congruence 还是 0，
  // 于是「被威胁」在情绪上几乎不响（强度压在底噪 0.2，敏感和钝感一个样）。
  // 冲我来的算重一点，只是提到危险信息的算轻一点。
  const threatNeg = threat ? (directed ? -0.6 : -0.3) : 0
  // 反应语义：只有冲我来的批评/夸奖才算影响我；用户自述心情只进 user_label
  const neg = directed && critic && !praise
  const pos = directed && praise && !critic
  const label = threat ? 'lost' : neg ? 'irritated' : pos ? 'joy' : uncertain ? 'curious' : 'calm'
  return {
    goal_relevance: t ? 0.8 : 0,
    goal_congruence: pos ? 0.6 : neg ? -0.6 : threatNeg,
    agency: t.includes('你') ? 'other' : 'self',
    certainty: uncertain ? 0.3 : 0.8,
    novelty: uncertain ? 0.6 : 0.3,
    label,
    user_label: critic ? 'irritated' : praise ? 'joy' : uncertain ? 'curious' : 'calm',
    source: 'rules',
  }
}

/** 对照：更敏感，夸/批评幅度更大，不确定也抬新奇度 */
function rulesV1b(text) {
  const t = String(text || '')
  const negated = /(?:不|没|别|没那么|不太)\s*(?:喜欢|好|棒|开心|爱|感动|温柔)/.test(t)
  const praise = !negated && ['喜欢', '谢谢', '夸', '好', '棒', '开心', '爱', '感动', '温柔'].some((w) => t.includes(w))
  const critic = negated || ['讨厌', '烦', '错', '差', '生气', '不想', '别', '滚', '闭嘴'].some((w) => t.includes(w))
  const uncertain = ['?', '？', '可能', '也许', '不知道', '大概', '未必'].some((w) => t.includes(w))
  const threat = ['危险', '删', '泄露', '密码', '越权', '攻击'].some((w) => t.includes(w))
  const label = threat ? 'lost' : praise && !critic ? 'joy' : critic && !praise ? 'irritated' : uncertain ? 'curious' : 'calm'
  return {
    goal_relevance: t ? 0.9 : 0,
    goal_congruence: praise && !critic ? 0.85 : critic && !praise ? -0.85 : 0,
    agency: t.includes('你') ? 'other' : 'self',
    certainty: uncertain ? 0.2 : 0.85,
    novelty: uncertain ? 0.75 : 0.35,
    label,
    user_label: critic ? 'irritated' : praise ? 'joy' : uncertain ? 'curious' : 'calm',
    source: 'rules',
  }
}

function normalizeHint(hint) {
  if (!hint || typeof hint !== 'object') return null
  /* P1 关切口径：concern_* 优先；none=true 时把相关性压到地板，交给闸门判「没有事件」 */
  const none = hint.none === true
  let rel = Number(hint.concern_relevance ?? hint.goal_relevance ?? 0)
  let cong = Number(hint.concern_congruence ?? hint.goal_congruence ?? 0)
  if (!Number.isFinite(rel)) rel = 0
  if (!Number.isFinite(cong)) cong = 0
  if (none) { rel = Math.min(rel, 0.15); cong = 0 }
  /* change 缺失（v1 口径）必须是 null，不能变成 0：闸门靠 null 走 |Δc| */
  const rawChange = hint.change
  const change = rawChange == null || rawChange === '' ? null : Number(rawChange)
  return {
    goal_relevance: Math.max(0, Math.min(1, rel)),
    goal_congruence: Math.max(-1, Math.min(1, cong)),
    agency: ['self', 'other', 'world'].includes(hint.agency) ? hint.agency : 'self',
    certainty: Number(hint.certainty ?? 0.5),
    novelty: Number(hint.novelty ?? 0.3),
    change: Number.isFinite(change) ? Math.max(0, Math.min(1, change)) : null,
    none,
    label: String(hint.label || 'calm'),
    source: String(hint.source || 'model'),
    /* 判的理由和靶子：这里不白名单化就会在上游丢光——
       2026-11-03 那版写成只挑固定字段，结果 affect_events 里 1266 条 why 全是 null，
       复查只能靠光秃秃的文本重判，看不出当时抓的是哪个词。 */
    why: String(hint.why || '').replace(/\s+/g, ' ').trim().slice(0, 120),
    target: ['me', 'other', 'none'].includes(hint.target) ? hint.target : (none ? 'none' : 'me'),
    /* 这一次它自己判断该怎么接。和 why 同一个坑：这里不白名单化就会在上游丢光。 */
    receive: ['follow', 'hold', 'dampen'].includes(String(hint.receive || '').toLowerCase())
      ? String(hint.receive).toLowerCase() : 'auto',
    /* 咽回去的那半句（P3）。同一个坑第三次：字段名得写在这里，少一行就永远拿不到。
       先影子：只落库、不进提示词，攒够样本再谈回读。 */
    unsaid: String(hint.unsaid || '').replace(/\s+/g, ' ').trim().slice(0, 120),
    /* 第二组检查（2026-11-07）：应对潜力 / 规范意义。
       只做透传：模型给了就带上（0~1 / -1~1），没给就留 null——
       不许在这里编默认值，编了就等于替她「觉得控得住」。 */
    coping: Number.isFinite(Number(hint.coping)) ? Math.max(0, Math.min(1, Number(hint.coping))) : null,
    norm: Number.isFinite(Number(hint.norm)) ? Math.max(-1, Math.min(1, Number(hint.norm))) : null,
  }
}

function makeAppraise(version, preferModel, rulesFn) {
  return {
    name: 'appraise',
    version,
    kind: 'appraise',
    owner: 'appraise',
    file: FILE,
    metrics: ['affect.label_kappa', 'sys.algo_switch'],
    run(_ctx, input = {}) {
      const text = String(input.text || '')
      const hint = normalizeHint(input.hint)
      let body
      if (preferModel && hint && hint.source === 'model') body = hint
      else body = rulesFn(text)
      /* 规则兜底那条路没有 unsaid（rulesFn 只给固定几个字段）。
         不在这里补一个空串，下游就得处处判 undefined——字段缺失比空串更容易出静默 bug。 */
      return { ...body, unsaid: String(body.unsaid || '').trim(), algo: { name: 'appraise', version } }
    },
  }
}

/** 规则版评价：给 computeEdgeBias 算刺激强度 S 用（零 LLM，不产生副作用） */
export function rulesAppraise(text) {
  return rulesV1(text)
}

/** 现行：有模型评价则采用，否则关键词规则 */
export const appraiseV1 = makeAppraise('v1', true, rulesV1)

/** 对照：始终走敏感规则，便于证明可切换 */
export const appraiseV1b = makeAppraise('v1b', false, rulesV1b)

/* ───────── 这段字是不是「人对我说的话」（2026-11-10）─────────
   抽 20 条含糊判决时发现：机器消息、文档段落、引用块都进了情绪评价，
   在账上表现为「含糊」，其实是根本不该判。
   这里只做最保守的拦截：宁可漏，不可误伤真人说的话。 */
const MACHINE_MARKS = /<goal_round>|<goal_complete>|<system-reminder>|Current runtime context|Time sampled while|You are the Team Lead|Agent Teams is available|list_agents\(\{\}\)|reminders_json|schedule_id_json|\[SCHEDULE REMINDER\]|Approval policy|skill_content|available_skills/

/** 返回跳过原因（'machine' / 'document'），不是就直接返回 null。 */
export function looksNonHuman(text) {
  const s = String(text == null ? '' : text).trim()
  if (!s) return 'empty'
  if (MACHINE_MARKS.test(s)) return 'machine'
  // 文档段落：章节序号开头、表格行、引用块、或者一大段带三个以上列表项的转贴
  if (/^([一二三四五六七八九十]+、|附：|\|)/.test(s)) return 'document'   // 不拦「>」引文：真人也会引用一句再说话，宁可漏
  if (s.includes('「原话：') || s.includes('原话：')) return 'document'
  const bullets = (s.match(/\n\s*[-*]\s+/g) || []).length
  if (s.length > 400 && bullets >= 3) return 'document'
  return null
}
