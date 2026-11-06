/**
 * 说话分寸 · 模型判断（影子）
 *
 * 规则档（expressionFrom / expressionState）先算出这一轮「说几句、多暖」。
 * 这里在它旁边再问一次模型：按这一刻的具体情形，该不该说得更收一点、或者（低落时）不许更展开。
 *
 * 三条硬规矩（不改就是错的）：
 *   1) 模型的建议只能缩、不能把「低落档」往上抬——低落压过一切，别借模型把人逼得多说。
 *   2) 句数 / 主动性都不许超过规则档；档位最多挪一档。
 *   3) 先影子：只写事件、不进提示词。等攒够分歧再谈生效。
 *
 * 纯函数（clampProposal / parseJudge / buildPrompt）可单测；judgeSpeech 要注入 complete。
 */

export const LEVEL_ORDER = ['quiet', 'brief', 'normal', 'warm']
const RANK = { quiet: 0, brief: 1, normal: 2, warm: 3 }
export const TONES = ['cool', 'plain', 'warm', 'short']

const num = (v, d) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : d
}
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x))

/** 模型输出的宽松解析：剥 ``` 围栏，再从第一个 { 截到最后一个 }。 */
export function parseJudge(out) {
  const raw = String(out == null ? '' : out).trim()
  if (!raw) return { ok: false, reason: 'empty' }
  const bare = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()
  const tryParse = (s) => {
    try { return JSON.parse(s) } catch { return null }
  }
  let obj = tryParse(bare)
  if (!obj) {
    const a = bare.indexOf('{')
    const b = bare.lastIndexOf('}')
    if (a >= 0 && b > a) obj = tryParse(bare.slice(a, b + 1))
  }
  if (!obj || typeof obj !== 'object') return { ok: false, reason: 'bad-json' }
  const level = LEVEL_ORDER.includes(String(obj.level || '')) ? String(obj.level) : null
  if (!level) return { ok: false, reason: 'bad-level' }
  const sentences = num(obj.sentences, null)
  const proactive = num(obj.proactive, null)
  const tone = TONES.includes(String(obj.tone || '')) ? String(obj.tone) : null
  return {
    ok: true,
    verdict: {
      level,
      sentences: sentences == null ? null : clamp(Math.round(sentences), 1, 4),
      proactive: proactive == null ? null : clamp(Math.round(proactive), 0, 2),
      tone,
      why: String(obj.why || '').slice(0, 80),
      confidence: clamp(num(obj.confidence, 0.5), 0, 1),
    },
  }
}

/**
 * 把模型建议夹进规则档允许的范围内。
 * @param {{level:string,sentences:number,proactive:number,tone:string}} rule 规则档
 * @param {{level:string,sentences:?number,proactive:?number,tone:?string}} v 模型建议
 * @param {{allowUp?:boolean}} [opt] allowUp=false 时一律不许往上抬
 */
export function clampProposal(rule = {}, v = {}, opt = {}) {
  const ruleLevel = LEVEL_ORDER.includes(String(rule.level)) ? String(rule.level) : 'normal'
  const ri = RANK[ruleLevel]
  const ruleSentences = clamp(Math.round(num(rule.sentences, 3)), 1, 4)
  const ruleProactive = clamp(Math.round(num(rule.proactive, 1)), 0, 2)
  const ruleTone = TONES.includes(String(rule.tone)) ? String(rule.tone) : 'plain'

  const wantLevel = LEVEL_ORDER.includes(String(v.level)) ? String(v.level) : ruleLevel
  let pi = RANK[wantLevel]
  const lowMood = ri <= 1 // quiet / brief：低落档不许借模型往上抬
  const allowUp = opt.allowUp !== false
  const clamped = []

  if (pi > ri && (lowMood || !allowUp)) { pi = ri; clamped.push('level-up') }
  if (pi > ri + 1) { pi = ri + 1; clamped.push('level+2') }
  if (pi < ri - 1) { pi = ri - 1; clamped.push('level-2') }
  const level = LEVEL_ORDER[pi]

  const wantSentences = v.sentences == null ? ruleSentences : clamp(Math.round(num(v.sentences, ruleSentences)), 1, 4)
  const wantProactive = v.proactive == null ? ruleProactive : clamp(Math.round(num(v.proactive, ruleProactive)), 0, 2)
  if (wantSentences > ruleSentences) clamped.push('sentences')
  if (wantProactive > ruleProactive) clamped.push('proactive')
  const sentences = Math.min(wantSentences, ruleSentences)
  const proactive = Math.min(wantProactive, ruleProactive)
  const tone = v.tone && TONES.includes(String(v.tone)) ? String(v.tone) : ruleTone

  return { level, sentences, proactive, tone, clamped }
}

const JUDGE_SYS = '你现在只做一件事：看一个人此刻的状态，判断她这一轮会怎么说。'
  + '只输出 JSON，不要解释、不要代码围栏：'
  + '{"level":"quiet|brief|normal|warm","sentences":1~4,"proactive":0~2,"tone":"cool|plain|warm|short","why":"十个字以内","confidence":0~1}。'
  + '规矩：低落到不想说话，就只给一句；别为了显得热情而多说；拿不准就给和参考档一样的值。'

/** 给模型的那条用户消息：只给状态，不给原话里的隐私细节。 */
export function buildPrompt({ label = 'calm', intensity = 0.4, warmth = 0.5, rule = {}, lastUser = '', lastReply = '' } = {}) {
  const state = '此刻：' + String(label) + '，强度 ' + (Math.round(num(intensity, 0.4) * 100) / 100)
    + '；对这个人说话的温度 ' + (Math.round(num(warmth, 0.5) * 100) / 100)
  const before = '参考档（规则算的）：' + String(rule.level || 'normal') + '，' + String(rule.sentences || 3) + ' 句，主动 ' + String(rule.proactive || 0)
  const usr = String(lastUser || '').slice(0, 120)
  const rep = String(lastReply || '').slice(0, 120)
  return [
    { role: 'system', content: JUDGE_SYS },
    { role: 'user', content: [state, before, usr ? '对方刚说：' + usr : '', rep ? '她刚回：' + rep : ''].filter(Boolean).join('\n') },
  ]
}

function withTimeout(p, ms) {
  let t = null
  const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new Error('timeout')), Math.max(200, num(ms, 6000))) })
  return Promise.race([p, timeout]).finally(() => { if (t) clearTimeout(t) })
}

/**
 * 问一次模型（影子用；失败一律返回 ok:false，调用方回退规则档）。
 * @param {{complete:Function, rule:object, label?:string, intensity?:number, warmth?:number, lastUser?:string, lastReply?:string, timeoutMs?:number}} opt
 */
export async function judgeSpeech(opt = {}) {
  const t0 = Date.now()
  const { complete, rule = {}, timeoutMs = 6000 } = opt
  if (typeof complete !== 'function') return { ok: false, reason: 'no-model', ms: 0 }
  let raw = ''
  try {
    const messages = buildPrompt(opt)
    raw = await withTimeout(Promise.resolve(complete(messages)), timeoutMs)
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || 'model-error') === 'timeout' ? 'timeout' : 'model-error', raw, ms: Date.now() - t0 }
  }
  const parsed = parseJudge(raw)
  if (!parsed.ok) return { ok: false, reason: parsed.reason, raw: String(raw || '').slice(0, 300), ms: Date.now() - t0 }
  const verdict = clampProposal(rule, parsed.verdict, opt)
  return { ok: true, verdict, raw: String(raw || '').slice(0, 300), ms: Date.now() - t0 }
}

/** 影子落账：只写事件，不进提示词。失败不影响这一轮。 */
export function recordShadow(db, aid, { rule = {}, verdict = {}, ms = 0, model = null, at = Date.now() } = {}) {
  try {
    const id = 'evt_' + Date.now().toString(36) + Math.random().toString(16).slice(2, 10)
    const payload = JSON.stringify({
      rule: { level: rule.level, sentences: rule.sentences, proactive: rule.proactive, tone: rule.tone },
      suggest: { level: verdict.level, sentences: verdict.sentences, proactive: verdict.proactive, tone: verdict.tone, why: verdict.why, confidence: verdict.confidence },
      clamped: verdict.clamped || [],
      ms: Math.round(num(ms, 0)),
      model: model || null,
    })
    db.prepare('INSERT INTO events VALUES(?,?,?,?,?)').run(id, aid, 'expr.shadow', payload, new Date(at).toISOString())
    return { id, payload }
  } catch { return null }
}

// ---------------- 评委：两版分寸哪版更像 ----------------

const COMPARE_SYS = '你在比较两版「她这一轮会怎么说」的推断，只判断哪一版更像一个真人在这个状态下会做的事。'
  + '只输出 JSON，不要解释、不要代码围栏：{"pick":"A|B|same","why":"十个字以内","confidence":0~1}。'
  + '两版没有对错，只问「哪版更像人」；分不出来就 same。'

/** 把两版分寸排成 A/B（默认 A=规则、B=模型）。 */
export function buildComparePrompt({ rule = {}, suggest = {}, label = 'calm', intensity = 0.4, lastUser = '', lastReply = '' } = {}) {
  const fmt = (x) => '档位 ' + String(x.level) + '，' + String(x.sentences) + ' 句，主动 ' + String(x.proactive) + '，语气 ' + String(x.tone)
  const state = '状态：' + String(label) + '，强度 ' + (Math.round(num(intensity, 0.4) * 100) / 100)
  const usr = String(lastUser || '').slice(0, 100)
  const rep = String(lastReply || '').slice(0, 100)
  return [
    { role: 'system', content: COMPARE_SYS },
    { role: 'user', content: [state, usr ? '对方刚说：' + usr : '', rep ? '她刚回：' + rep : '', 'A：' + fmt(rule), 'B：' + fmt(suggest)].filter(Boolean).join('\n') },
  ]
}

export function parseCompare(out) {
  const raw = String(out == null ? '' : out).trim()
  if (!raw) return { ok: false, reason: 'empty' }
  const bare = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()
  let obj = null
  try { obj = JSON.parse(bare) } catch { /* 往下试 */ }
  if (!obj) {
    const a = bare.indexOf('{')
    const b = bare.lastIndexOf('}')
    if (a >= 0 && b > a) { try { obj = JSON.parse(bare.slice(a, b + 1)) } catch { /* 真坏了 */ } }
  }
  if (!obj || typeof obj !== 'object') return { ok: false, reason: 'bad-json' }
  const p = String(obj.pick || '').toUpperCase()
  const pick = p === 'A' ? 'rule' : p === 'B' ? 'model' : p === 'SAME' ? 'same' : null
  if (!pick) return { ok: false, reason: 'bad-pick' }
  return { ok: true, pick, why: String(obj.why || '').slice(0, 80), confidence: clamp(num(obj.confidence, 0.5), 0, 1) }
}

/** 问一次评委；失败一律 ok:false（调用方当没这回事）。 */
export async function judgeCompare(opt = {}) {
  const t0 = Date.now()
  const { complete, timeoutMs = 6000 } = opt
  if (typeof complete !== 'function') return { ok: false, reason: 'no-model', ms: 0 }
  let raw = ''
  try {
    raw = await withTimeout(Promise.resolve(complete(buildComparePrompt(opt))), timeoutMs)
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || '') === 'timeout' ? 'timeout' : 'model-error', raw, ms: Date.now() - t0 }
  }
  const parsed = parseCompare(raw)
  return parsed.ok
    ? { ok: true, pick: parsed.pick, why: parsed.why, confidence: parsed.confidence, raw: String(raw || '').slice(0, 300), ms: Date.now() - t0 }
    : { ok: false, reason: parsed.reason, raw: String(raw || '').slice(0, 300), ms: Date.now() - t0 }
}

/** 评委落账：只写事件。 */
export function recordCompare(db, aid, { rule = {}, suggest = {}, pick = 'same', why = '', confidence = null, ms = 0, at = Date.now() } = {}) {
  try {
    const id = 'evt_' + Date.now().toString(36) + Math.random().toString(16).slice(2, 10)
    const payload = JSON.stringify({
      rule: { level: rule.level, sentences: rule.sentences },
      suggest: { level: suggest.level, sentences: suggest.sentences },
      pick, why: String(why || '').slice(0, 80), confidence, ms: Math.round(num(ms, 0)),
    })
    db.prepare('INSERT INTO events VALUES(?,?,?,?,?)').run(id, aid, 'expr.judge', payload, new Date(at).toISOString())
    return { id, payload }
  } catch { return null }
}
