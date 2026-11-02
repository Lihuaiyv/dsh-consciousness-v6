import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const RULES = {
  praise: ['喜欢', '谢谢', '夸', '好', '棒', '开心', '爱'],
  critic: ['讨厌', '烦', '错', '差', '生气', '不想', '别'],
  uncertain: ['?', '？', '可能', '也许', '不知道'],
  threat: ['危险', '删', '泄露', '密码', '越权'],
}

// 情绪不再「一句话定一个标签」：给 8 类打分，标签只是其中一种投影。
const SIGNALS = {
  joy: ['喜欢', '谢谢', '开心', '太好了', '真棒', '棒', '终于', '骄傲', '爽', '满意', '不错', '夸', '嘿嘿', '笑', '顺利', '好听', '好看', '有意思', '没翻车', '一路绿灯'],
  peaceful: ['挺好', '舒服', '踏实', '放心', '慢慢', '不忙', '散步', '泡了杯茶', '晴天', '没事', '安静', '休息', '歇', '安心', '按计划'],
  curious: ['为什么', '怎么', '是什么', '什么是', '有没有', '能不能', '可以吗', '吗？', '吗?', '呢？', '呢?', '哪', '多少', '后来', '具体', '例子', '文档', '展开', '复现'],
  confused: ['没看懂', '看不懂', '没听懂', '听不懂', '不明白', '没明白', '跟不上', '什么意思', '矛盾', '是哪个', '懵', '没抓到', '重说', '逻辑', '反了', '少了一步', '对不上'],
  lost: ['失望', '难过', '伤心', '走了', '离开', '没通过', '挂了', '失败', '落空', '被忽略', '忽略', '没人', '算了', '不想说', '提不起', '空了', '怀疑自己', '撑不住', '没参与感', '被换掉', '不怪', '挺累', '没劲', '被落下', '没人记得', '空荡荡'],
  frustrated: ['不行', '搞不定', '卡住', '卡在', '跑不通', '改了一天', '试了', '崩溃', '超出', '白干', '死循环', '不会', '越改越乱', '反复', '推倒重来', '方向错', '爬不出来', '折腾'],
  irritated: ['烦', '讨厌', '别', '催', '又改', '又崩', '又卡', '破', '吵', '打断', '加班', '受不了', '够了', '说了多少', '多少次', '抱怨', '塞', '别在群里'],
}
const ORDER = ['joy', 'peaceful', 'curious', 'calm', 'confused', 'lost', 'irritated', 'frustrated']

/**
 * 返回 scores（8 类，和为 1）与 label（argmax）。
 * scores 才是真状态；label 只是给人看的投影。
 */
export function appraiseRules(text) {
  const t = String(text || '')
  const raw = {}
  for (const label of ORDER) raw[label] = 1 // 底噪：没有任何信号时八类接近均分
  for (const [label, words] of Object.entries(SIGNALS)) {
    let hit = 0
    for (const w of words) if (t.includes(w)) hit++
    if (hit) raw[label] += 2 + Math.min(3, hit - 1) * 0.5
  }
  // 问句：好奇 +，但不淹没明显的困惑/挫败
  if (/[?？]/.test(t) || /(吗|呢)$/.test(t.trim())) raw.curious += 1.5
  // 很短的中性回应：平静更合理
  if (t.trim().length <= 6 && !/[?？!！]/.test(t)) raw.calm += 0.8

  const total = ORDER.reduce((s, k) => s + raw[k], 0)
  const scores = {}
  for (const k of ORDER) scores[k] = +(raw[k] / total).toFixed(4)
  const userLabel = ORDER.reduce((best, k) => (scores[k] > scores[best] ? k : best), 'calm')
  // 反应语义：只有冲意识体来的话才算影响它；用户自述心情只进 user_label
  const directed = /你|您/.test(t)
  let label = userLabel
  if (!directed && ['irritated', 'frustrated', 'lost'].includes(label)) label = 'curious'
  if (!directed && ['joy', 'peaceful'].includes(label)) label = 'calm'

  const confused = scores.confused + scores.curious
  return {
    scores,
    goal_relevance: t ? 0.8 : 0,
    goal_congruence: directed ? (scores.joy + scores.peaceful) - (scores.lost + scores.frustrated + scores.irritated) : 0,
    agency: directed ? 'other' : 'self',
    certainty: 1 - Math.min(1, confused * 2),
    novelty: confused,
    label,
    user_label: userLabel,
    user_scores: scores,
    source: 'rules',
  }
}


export function extractRules(turns) {
  const out = []
  const fact = /(我|本人)(喜欢|讨厌|养了|住在|在.*工作|习惯|通常|一般|叫)/g
  const pref = /(我喜欢|我不喜欢|我讨厌|我偏好|别给我|不要)/g
  for (const turn of turns) {
    const text = String(turn.text || turn.content || '').trim()
    if (!text) continue
    const role = turn.role || 'user'
    if (role !== 'user') continue
    for (const s of text.split(/[。！？!?\n]/)) {
      const sentence = s.trim()
      if (sentence.length < 4) continue
      // 问句不是事实：别把「我喜欢什么？」存成「我喜欢什么」。
      if (/[?？]/.test(sentence) || /(什么|怎么|为什么|哪[个些]|吗|呢)/.test(sentence)) continue
      if (pref.test(sentence)) out.push({ text: sentence, type: 'fact', mark: 'normal', source: 'auto_extract' })
      else if (fact.test(sentence)) out.push({ text: sentence, type: 'fact', mark: 'normal', source: 'auto_extract' })
      else if (RULES.praise.some((w) => sentence.includes(w)) || RULES.critic.some((w) => sentence.includes(w)))
        out.push({ text: sentence, type: 'appraisal', mark: 'normal', source: 'auto_extract' })
    }
  }
  return out.slice(0, 30)
}

function parseJson(text) {
  const t = String(text).replace(/```[a-zA-Z]*/g, '').trim()
  try { return JSON.parse(t) } catch { /* 继续找 */ }
  const objs = [...t.matchAll(/\{[\s\S]*?\}/g)].map((m) => m[0])
  for (let i = objs.length - 1; i >= 0; i--) {
    try { return JSON.parse(objs[i]) } catch { /* 下一个 */ }
  }
  const arr = t.match(/\[[\s\S]*\]/)
  if (arr) return JSON.parse(arr[0])
  throw new Error('model returned non-json')
}

const MOOD_LINE = {
  joy: '我现在心情不错。', calm: '我挺平静的。', curious: '我有点好奇。',
  peaceful: '我挺安心的。', confused: '我有点没跟上。', lost: '我有点慌。',
  irritated: '说实话我有点烦。', frustrated: '我有点挫败。',
}

/**
 * 没有模型时的回复：只用状态（情绪 + 召回到的记忆 + 语气设定）拼出来。
 * 它不假装会说人话——句子短、可解释，接上模型后由模型接管。
 */
export function composeRulesReply(ctx) {
  const text = String(ctx.text || '').trim()
  const pack = Array.isArray(ctx.pack) ? ctx.pack : []
  const style = ctx.style || {}
  const tone = style.tone || ''
  const isOwner = ctx.isOwner !== false
  const address = isOwner ? (style.address || '') : ''
  const mood = MOOD_LINE[(ctx.affect && ctx.affect.label) || ''] || ''
  const cite = pack[0] ? String(pack[0].text).slice(0, 60) : ''
  const greet = /^(你好|您好|在吗|早|早安|晚上好|嗨|hi|hello)/i.test(text)
  const question = /[?？]/.test(text) || /(吗|呢)$/.test(text)
  const toneText = String(tone || '')
  const short = /简洁|简短|话少|直接|利落|干脆|冷淡|冷静/.test(toneText)
  const warm = /温和|温柔|耐心|慢慢|亲切|体贴/.test(toneText)
  const snark = /毒舌|损|讽|刺/.test(toneText)
  let body
  if (!isOwner) {
    // 陌生人：不叫主人、不承诺记住，也不引用主人的记忆
    if (greet) body = '你好呀，我在。' + (short ? '' : mood)
    else if (question) body = '我可能没听明白，你再说说？' + (short ? '' : mood)
    else body = '嗯，我听到了。' + (short ? '' : mood)
  } else if (greet) body = (address ? address + '，' : '') + '我在。' + (short ? '' : mood)
  else if (question && cite) body = '我记得「' + cite + '」。' + (short ? '' : mood)
  else if (question) body = '这个我还不知道。' + (short ? '' : mood)
  // 没有模型时她拼不出一句像样的回应：直说在听，不拿「记下了」假装听懂了
  else body = '嗯，我在听。' + (short ? '' : mood)
  if (snark) body = '行吧，' + body
  if (warm && !short) body += '你慢慢说，我不急。'
  const cp = String(style.catchphrase || '').trim()
  if (cp) body = body.replace(/[\s。！？，、]+$/, '') + '，' + cp + '。'
  return body.slice(0, 400)
}

class RulesAdapter {
  constructor() { this.name = 'rules' }
  available() { return true }
  async appraise(text) { return appraiseRules(text) }
  async complete() { return JSON.stringify({ overlap: 'unknown', key: '', name: '', definition: '' }) }
  async extract(turns) { return extractRules(turns) }
  async reply(ctx) { return composeRulesReply(ctx) }
  async chat() { return '{}' }
  async embed() { return [] }
  async summarize(turns) {
    const lines = turns.map((t) => `${t.role || 'user'}: ${String(t.text || '').slice(0, 80)}`).join('\n')
    return lines.slice(0, 1200)
  }
}

/**
 * 回话的 system：网页端和 QQ 端共用同一份意识体包（ctx.contextBlock）。
 * 没有包时行为和以前完全一致。
 *
 * 有包的时候这张「便签」只写通道规矩：包里面已经有人设、语气、称呼、口头禅、
 * 情绪、需求、记忆了，这里再抄一遍会让同一件事有两个说法，模型不知道该听哪句。
 */
export function buildReplySystem(ctx = {}) {
  const style = ctx.style || {}
  const isOwner = ctx.isOwner !== false
  const block = String(ctx.contextBlock || '').trim()
  const hasBlock = !!block
  const mem = (ctx.pack || []).map((m) => '- ' + m.text).join('\n')
  // 宿主模型不能吃「assistant 消息」（会报 replayState），所以把历史压成文本塞进 system。
  // 其它适配器走 messages（见 replyMessages），这里默认不重复。
  const hist = ctx.historyInSystem && Array.isArray(ctx.history) ? ctx.history.filter((m) => m && m.text) : []
  return [
    hasBlock && isOwner ? '【你此刻的意识体上下文，按真实状态写，不要逐条复述】\n' + block + '\n【上下文结束】' : '',
    hasBlock && !isOwner ? '【以下是你的状态上下文，只用于保持人格，不要当成本次对话对象的经历】\n' + block + '\n【上下文结束】' : '',
    hist.length ? '【你们刚才说的（越靠后越近），只用来接话，不要逐条复述】\n'
      + hist.map((m) => (m.role === 'assistant' ? '我：' : '你：') + String(m.text).slice(0, 300)).join('\n') : '',
    hasBlock ? '' : '你就是这个意识体本人，用第一人称说话。',
    isOwner ? '' : '注意：当前说话的人不是主人，只是普通联系人。不要称呼「主人」，不要承诺记住他的私事，也不要把主人的事当成他的事。',
    !hasBlock && style.tone ? '语气：' + style.tone + '。' : '',
    !hasBlock && isOwner && style.address ? '你称呼对方为「' + style.address + '」。' : '',
    !hasBlock && style.catchphrase ? '你的口头禅：' + style.catchphrase + '。' : '',
    !hasBlock && style.card ? '你给自己写过（只作语气参考）：' + style.card : '',
    !hasBlock && ctx.affect ? '你现在的主情绪是 ' + ctx.affect.label + '，强度 ' + Number(ctx.affect.intensity || 0).toFixed(2) + '。' : '',
    !hasBlock && ctx.drive ? '你的需求缺口档位是 ' + ctx.drive.band + '。' : '',
    !hasBlock && isOwner && mem ? '下面是你这次能想起了的记忆，只在相关时引用，不要编造：\n' + mem : '',
    isOwner
      ? '规则：按你自己的分寸说，长短都行；不要声称自己有人类身体；不确定就说「我可能记错」。'
      : '规则：按你自己的分寸说，长短都行；不要声称自己有人类身体；不确定就说「我可能记错」。对方不是主人：不要用主人的称呼，不要承诺替他记住任何事。',
  ].filter(Boolean).join('\n')
}

/**
 * 一次回话的完整消息序列：system（便签 + 意识体包）→ 前几轮历史 → 当前这句。
 * 历史按 user / assistant 交替；单条封顶 300 字，防一条长粘贴挤掉别的。
 */
export function replyMessages(ctx = {}) {
  const out = [{ role: 'system', content: buildReplySystem(ctx) }]
  for (const m of Array.isArray(ctx.history) ? ctx.history : []) {
    if (!m || !m.text) continue
    out.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.text).slice(0, 300) })
  }
  out.push({ role: 'user', content: String(ctx.text || '').slice(0, 2000) })
  return out
}

class OpenAIAdapter {
  constructor(cfg) {
    this.name = 'openai_compatible'
    this.url = cfg.url.replace(/\/$/, '')
    this.key = cfg.key
    this.model = cfg.model || 'deepseek-chat'
    this.embedModel = cfg.embedModel || cfg.embeddingModel || 'text-embedding-3-small'
    // 只用于向量的适配器：链上挑方法时要跳过它，否则它会冒充聊天模型。
    this.embedOnly = !!cfg.embedOnly
    this.timeout = Number(process.env.DSHC_MODEL_TIMEOUT || cfg.timeout || 15000)
  }
  available() {
    if (!this.url) return false
    if (this.key) return true
    try {
      const h = new URL(this.url).hostname
      return h === '127.0.0.1' || h === 'localhost' || h === '::1'
    } catch { return false }
  }
  async chat(messages, maxTokens = 600, json = false, temperature = 0.2) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), this.timeout)
    const headers = { 'Content-Type': 'application/json' }
    if (this.key) headers.Authorization = 'Bearer ' + this.key
    try {
      const r = await fetch(this.url + '/chat/completions', {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: this.model, messages, temperature, max_tokens: maxTokens, ...(json ? { response_format: { type: 'json_object' } } : {}) }),
        signal: ctrl.signal,
      })
      if (!r.ok) throw new Error('model http ' + r.status)
      const d = await r.json()
      return d.choices?.[0]?.message?.content || ''
    } finally { clearTimeout(timer) }
  }
  async appraise(text, formula = 'v1', context = '') {
    const user = context
      ? '前几句：\n' + String(context).slice(0, 600) + '\n\n现在这句：' + String(text).slice(0, 2000)
      : String(text).slice(0, 2000)
    /* P1：关切口径。旧口径原样保留，用参数 affect.appraise.formula 切 */
    if (String(formula) === 'concern') {
      const raw2 = await this.chat([
        { role: 'system', content: promptFor('concern') },
        { role: 'user', content: user },
      ], 400, true)
      return finalizeAppraisal(parseJson(raw2) || {})
    }
    const raw = await this.chat([
      { role: 'system', content: "你是 OCC 情绪评价器。判断这句话对『接收它的意识体』的影响与反应，而不是判断说话人自己的情绪。scores 表示意识体的反应分布；另给一份 user_label/user_scores 表示说话人情绪（只供共情参考）。只输出 JSON：{\"scores\":{\"joy\":0.1,\"peaceful\":0.1,\"curious\":0.1,\"calm\":0.3,\"confused\":0.1,\"lost\":0.1,\"irritated\":0.1,\"frustrated\":0.1},\"goal_relevance\":0.5,\"goal_congruence\":0,\"agency\":\"self|other\",\"certainty\":0.6,\"novelty\":0.4,\"user_label\":\"joy|peaceful|curious|calm|confused|lost|irritated|frustrated\",\"user_scores\":{\"joy\":0.1,\"peaceful\":0.1,\"curious\":0.1,\"calm\":0.3,\"confused\":0.1,\"lost\":0.1,\"irritated\":0.1,\"frustrated\":0.1}}。scores 八个键都必须有，值为 0-1，和为 1。agency：self=意识体做了什么，other=对方做了什么。" },
      { role: 'user', content: String(text).slice(0, 2000) },
    ], 400, true)
    const d = parseJson(raw) || {}
    const KEYS = ['joy', 'peaceful', 'curious', 'calm', 'confused', 'lost', 'irritated', 'frustrated']
    let scores = d.scores && typeof d.scores === 'object' ? d.scores : null
    if (scores) {
      const sum = KEYS.reduce((s, k) => s + Math.max(0, Number(scores[k]) || 0), 0)
      const norm = {}
      for (const k of KEYS) norm[k] = sum > 0 ? +(Math.max(0, Number(scores[k]) || 0) / sum).toFixed(4) : 1 / 8
      scores = norm
    }
    const unknown = d.label === 'unknown' || d.label === 'none' || d.label === 'other'
    const label = unknown ? 'unknown' : (scores
      ? KEYS.reduce((best, k) => (scores[k] > scores[best] ? k : best), 'calm')
      : (KEYS.includes(d.label) ? d.label : 'calm'))
    const userScores = normalizeScores({ scores: d.user_scores })
    const userLabel = KEYS.includes(d.user_label) ? d.user_label
      : (userScores ? KEYS.reduce((best, k) => (userScores[k] > userScores[best] ? k : best), 'calm') : null)
    return { ...d, scores, label, user_label: userLabel, user_scores: userScores, raw_name: unknown ? String(d.raw || d.name || '') : undefined, source: 'model' }
  }
  async complete({ system, text }) {
    return this.chat([{ role: 'system', content: system }, { role: 'user', content: text }], 500, true)
  }
  /** 向量：OpenAI 兼容的 /embeddings。批量优先，失败按批退给上层重试。 */
  async embed(texts) {
    const list = (Array.isArray(texts) ? texts : [texts]).map((t) => String(t || '').slice(0, 2000)).slice(0, 64)
    if (!list.length) return []
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), this.timeout)
    const headers = { 'Content-Type': 'application/json' }
    if (this.key) headers.Authorization = 'Bearer ' + this.key
    try {
      const r = await fetch(this.url + '/embeddings', {
        method: 'POST', headers, signal: ctrl.signal,
        body: JSON.stringify({ model: this.embedModel, input: list }),
      })
      if (!r.ok) throw new Error('embedding http ' + r.status)
      const d = await r.json()
      const data = Array.isArray(d.data) ? [...d.data].sort((a, b) => (a.index || 0) - (b.index || 0)) : []
      return data.map((x) => x.embedding)
    } finally { clearTimeout(timer) }
  }
  async extract(turns) {
    const raw = await this.chat([
      { role: 'system', content: '从对话抽取值得长期记住的事实/偏好/边界。只输出 JSON 数组：[{"text":"","type":"fact|episode|appraisal","mark":"normal|sensitive","key":"","terms":[""]}]，最多 20 条。' +
        'text 用一句客观陈述，写清实体与属性；key 是稳定的去重键（如「用户.咖啡.偏好」），同一件事换个说法必须给同一个 key，拿不准就给空；' +
        'terms 是 3~6 个「以后用户可能怎么问这件事」的词：同义词、别名、上位词、口语说法（例：咖啡 → 咖啡、美式、喝什么、饮品）。' +
        'terms 只写词，不要句子，不要解释；没有就留空数组。' },
      { role: 'user', content: JSON.stringify(turns).slice(0, 6000) },
    ], 700, true)
    const arr = parseJson(raw)
    if (!Array.isArray(arr)) throw new Error('not array')
    return arr.filter((x) => x && x.text).slice(0, 30)
  }
  async summarize(turns) {
    const list = Array.isArray(turns) ? turns : []
    const sys = list.filter((t) => t.role === 'system').map((t) => String(t.text || '')).join('\n\n')
      || '用 3 句话总结这段对话里关于用户的事实、偏好、情绪与边界。'
    const body = list.some((t) => t.role === 'system')
      ? list.filter((t) => t.role !== 'system').map((t) => String(t.text || '')).join('\n\n')
      : list.map((t) => `${t.role || 'user'}: ${String(t.text || '')}`).join('\n')
    // 日记需要一点人味；纪要要稳。
    const creative = /日记/.test(sys)
    return this.chat([
      { role: 'system', content: sys },
      { role: 'user', content: body.slice(0, 8000) },
    ], creative ? 900 : 600, false, creative ? 0.8 : 0.2)
  }
  async reply(ctx) {
    return this.chat(replyMessages(ctx))
  }
}

const CAPABILITIES = ['appraise', 'extract', 'summarize', 'reply', 'complete', 'chat', 'embed']

export class ModelPort {
  constructor(primary, fallback) { this.primary = primary; this.fallback = fallback; this.failures = 0; this.openUntil = 0 }
  /** INV9：能力声明，业务只问能不能做，不问是谁 */
  capabilities() {
    const src = this.primary?.available() && Date.now() > this.openUntil ? this.primary : this.fallback
    const caps = {}
    for (const c of CAPABILITIES) {
      // 链式适配器要按方法逐个问：宿主 llm 有 complete、没有 embed，不能整条链都说「有」。
      caps[c] = typeof src?.[c] === 'function' && (typeof src.can !== 'function' || src.can(c))
    }
    return caps
  }
  async _run(method, ...args) {
    const now = Date.now()
    if (this.primary?.available() && now > this.openUntil) {
      try {
        const out = await this.primary[method](...args)
        this.failures = 0
        this.servedBy = 'primary'
        return out
      } catch (e) {
        this.lastError = String((e && e.message) || e)
        this.failures++
        if (process.env.DSHC_MODEL_DEBUG) console.error('[model]', String(e.message || e))
        if (this.failures >= 3) this.openUntil = Date.now() + 30000
      }
    }
    // 落到规则兜底：记下来，别让调用方以为这句话是模型说的
    this.servedBy = 'fallback'
    return this.fallback[method](...args)
  }
  appraise(text, formula, context) { return this._run('appraise', text, formula, context) }
  extract(turns) { return this._run('extract', turns) }
  summarize(turns) { return this._run('summarize', turns) }
  reply(ctx) { return this._run('reply', ctx) }
  complete(req) { return this._run('complete', req) }
  embed(texts) { return this._run('embed', texts) }
  /**
   * 通用对话：研究工具要按消息数组问模型（规划 / 抽取 / 写报告），
   * 比 complete(system,text) 更直接。失败同样计入熔断。
   */
  async chat(messages, maxTokens, json, temperature) {
    const now = Date.now()
    if (this.primary?.available() && now > this.openUntil && typeof this.primary.chat === 'function') {
      try {
        const out = await this.primary.chat(messages, maxTokens, json, temperature)
        this.failures = 0
        this.servedBy = 'primary'
        return out
      } catch (e) {
        this.lastError = String((e && e.message) || e)
        this.failures++
        if (process.env.DSHC_MODEL_DEBUG) console.error('[model]', this.lastError)
        if (this.failures >= 3) this.openUntil = Date.now() + 30000
      }
    }
    this.servedBy = 'fallback'
    if (typeof this.fallback?.chat === 'function') return this.fallback.chat(messages, maxTokens, json, temperature)
    throw new Error('模型 chat 不可用')
  }
  status() {
    return {
      primary: this.primary?.available() ? (Date.now() > this.openUntil ? 'ok' : 'circuit_open') : 'unavailable',
      fallback: 'ok', failures: this.failures, lastError: this.lastError || null,
      capabilities: this.capabilities(),
      adapter: this.primary?.available() && Date.now() > this.openUntil ? (this.primary.name || 'primary') : 'rules',
      // 上一次调用到底是谁答的：primary=真模型，fallback=规则兜底（评测/面板要靠它分辨）
      served: this.servedBy || null,
    }
  }
}


// ---------------- 复用 DSH 自己的模型（llm 服务） ----------------
let hostLlmGetter = null
export function attachHostLlm(getter) { hostLlmGetter = getter }

const AP_LABELS = ['joy', 'peaceful', 'curious', 'calm', 'confused', 'lost', 'irritated', 'frustrated']
const AP_PROMPT = "你是 OCC 情绪评价器。判断这句话对『接收它的意识体』的影响与反应，而不是判断说话人自己的情绪。scores 表示意识体的反应分布；另给一份 user_label/user_scores 表示说话人情绪（只供共情参考）。只输出 JSON：{\"scores\":{\"joy\":0.1,\"peaceful\":0.1,\"curious\":0.1,\"calm\":0.3,\"confused\":0.1,\"lost\":0.1,\"irritated\":0.1,\"frustrated\":0.1},\"goal_relevance\":0.5,\"goal_congruence\":0,\"agency\":\"self|other\",\"certainty\":0.6,\"novelty\":0.4,\"user_label\":\"joy|peaceful|curious|calm|confused|lost|irritated|frustrated\",\"user_scores\":{\"joy\":0.1,\"peaceful\":0.1,\"curious\":0.1,\"calm\":0.3,\"confused\":0.1,\"lost\":0.1,\"irritated\":0.1,\"frustrated\":0.1}}。scores 八个键都必须有，值为 0-1，和为 1。agency：self=意识体做了什么，other=对方做了什么。"

function normalizeScores(d) {
  const src = d && d.scores && typeof d.scores === 'object' ? d.scores : null
  if (!src) return null
  let sum = 0
  for (const k of AP_LABELS) sum += Math.max(0, Number(src[k]) || 0)
  const out = {}
  for (const k of AP_LABELS) out[k] = sum > 0 ? +(Math.max(0, Number(src[k]) || 0) / sum).toFixed(4) : 1 / 8
  return out
}

/**
 * affect.appraise.formula = 'concern' 时的提示词。
 * 与 v1 的区别只有一句：v1 问「这句话对我的影响」，等于在量「任务顺不顺」；
 * concern 问「有没有碰到我在乎的事」，任务顺不顺不算。
 * 依据见 v1新版本重要文档/7-情绪事件化-v1.md §1.3、§3.2。
 */
const AP_PROMPT_CONCERN = `你是情绪评价器。先判断这句话属于哪一类，再给它在乎的程度与方向。
kind（四选一）：
- task：布置任务、问技术问题、给操作指令、补充细节、确认状态
- eval：评价它、抱怨它、夸它、谢它、担心它、想改变它；说它哪里不对/不够好/不像活的/没反应/不饿
- relation：表达关系、亲近、信任、期待、失望（"我们""以后""你对我…"）
- chat：对方说自己的事、闲聊、感叹
polarity：-1 伤到它 / 0 无关 / 1 顺着它
只输出 JSON：{"kind":"task|eval|relation|chat","polarity":0,"concern_relevance":0,"concern_congruence":0,"change":0,"novelty":0.2,"certainty":0.8,"agency":"self|other|world","none":true,"scores":{"joy":0.125,"peaceful":0.125,"curious":0.125,"calm":0.125,"confused":0.125,"lost":0.125,"irritated":0.125,"frustrated":0.125},"user_label":"joy|peaceful|curious|calm|confused|lost|irritated|frustrated","user_scores":{"joy":0.125,"peaceful":0.125,"curious":0.125,"calm":0.125,"confused":0.125,"lost":0.125,"irritated":0.125,"frustrated":0.125}}
规则：
1. task / chat → none=true，concern_relevance ≤ 0.15，concern_congruence=0，scores 接近均匀。
2. eval / relation → none=false，concern_relevance 0.5~0.9，concern_congruence 用 polarity 的方向和强度表示，scores 给明显分布。
3. 如果给了前几句，结合语境判断：比如说了一句很短的话（「我真是服了」「算了」），要按它在上下文里是不是冲着它来的来分类。
4. 拿不准 → 判 task 或 chat；不要为了给分而编情绪。
5. change：和上一次同类状况比变了多少，0=没变，1=完全翻盘。
6. certainty：你有多确定自己读懂了这句话的意图。
7. agency：self=它自己做的，other=对方做的，world=外部情况。
8. scores 八个键都必须有，0-1，和为 1；允许五个以上接近 0.125 的平坦分布。
9. user_label / user_scores 只表示说话人自己的情绪，只供共情参考。`

/** 评价口径：v1（旧）或 concern（P1）。未知值一律回 v1。 */
export function promptFor(formula) {
  return String(formula) === 'concern' ? AP_PROMPT_CONCERN : AP_PROMPT
}

/**
 * 统一收口模型的原始 JSON：八类分、标签、用户情绪，以及 P1 的关切字段。
 * concern_* 映射回旧的 goal_*，下游（排序 / 动力学 / 影子闸门）不用改。
 */
export function finalizeAppraisal(d) {
  const src = d && typeof d === 'object' ? d : {}
  const scores = normalizeScores(src)
  const unknown = src.label === 'unknown' || src.label === 'none' || src.label === 'other'
  let label = unknown ? 'unknown' : (scores
    ? AP_LABELS.reduce((b, k) => (scores[k] > scores[b] ? k : b), 'calm')
    : (AP_LABELS.includes(src.label) ? src.label : 'calm'))
  const userScores = normalizeScores({ scores: src.user_scores })
  const userLabel = AP_LABELS.includes(src.user_label) ? src.user_label
    : (userScores ? AP_LABELS.reduce((b, k) => (userScores[k] > userScores[b] ? k : b), 'calm') : null)
  let none = src.none === true
  let rel = src.concern_relevance != null ? Number(src.concern_relevance) : Number(src.goal_relevance)
  let cong = src.concern_congruence != null ? Number(src.concern_congruence) : Number(src.goal_congruence)
  if (!Number.isFinite(rel)) rel = 0
  if (!Number.isFinite(cong)) cong = 0
  rel = Math.max(0, Math.min(1, rel))
  cong = Math.max(-1, Math.min(1, cong))
  /* 先分类再定量：让模型直接给 0–1 的「相关度」，它会一律往「任务」那边猜（实测永远 0.05–0.1）。
     分成 task / eval / relation / chat 四类要准得多，相关度和方向由这张表落地。 */
  const kind = ['task', 'eval', 'relation', 'chat'].includes(src.kind) ? src.kind : null
  const pol = Number(src.polarity)
  if (kind) {
    const REL = { task: 0.1, chat: 0.2, eval: 0.65, relation: 0.55 }
    const relevant = kind === 'eval' || kind === 'relation'
    none = !relevant
    rel = Math.max(rel, REL[kind])
    if (relevant) {
      if (Number.isFinite(pol) && pol !== 0) cong = Math.max(-1, Math.min(1, pol * 0.7))
      const vals = scores ? Object.values(scores).map(Number).filter((x) => Number.isFinite(x)) : []
      const flat = !vals.length || (Math.max(...vals) - Math.min(...vals) < 0.05)
      if (flat && Number.isFinite(pol) && pol !== 0) label = pol < 0 ? 'irritated' : 'joy'
    }
  }
  /* 对方正在气头上（user_scores 明显偏负），就算它把这句话归成 chat/task，
     也不可能真的无动于衷——这是关系层面的事，按 relation 处理。 */
  const negUser = userScores ? (Number(userScores.irritated || 0) + Number(userScores.frustrated || 0) + Number(userScores.lost || 0)) : 0
  if (none && negUser >= 0.5) {
    none = false
    rel = Math.max(rel, 0.5)
    cong = Math.min(cong, -0.3)
    if (label === 'calm') label = 'frustrated'
  }
  if (none) { rel = Math.min(rel, 0.15); cong = 0 }
  const change = Number(src.change)
  return {
    ...src,
    scores,
    label,
    user_label: userLabel,
    user_scores: userScores,
    goal_relevance: Math.round(rel * 1000) / 1000,
    goal_congruence: Math.round(cong * 1000) / 1000,
    change: Number.isFinite(change) ? Math.max(0, Math.min(1, change)) : null,
    none,
    raw_name: unknown ? String(src.raw || src.name || '') : undefined,
    source: 'model',
  }
}

class HostLlmAdapter {
  constructor() { this.name = 'dsh_llm' }
  _ctx() { try { return hostLlmGetter ? hostLlmGetter() : null } catch { return null } }
  available() {
    const ctx = this._ctx()
    if (!ctx) return false
    try { return typeof ctx.get('llm')?.stream === 'function' } catch { return false }
  }
  async complete({ system, text }) {
    return this._chat(system, text, 500, 0.3)
  }
  async summarize(turns) {
    const list = Array.isArray(turns) ? turns : []
    const sys = list.filter((t) => t.role === 'system').map((t) => String(t.text || '')).join('\n\n')
      || '用 3 句话总结这段对话里关于用户的事实、偏好、情绪与边界。'
    const body = list.some((t) => t.role === 'system')
      ? list.filter((t) => t.role !== 'system').map((t) => String(t.text || '')).join('\n\n')
      : list.map((t) => `${t.role || 'user'}: ${String(t.text || '')}`).join('\n')
    const creative = /日记/.test(sys)
    return this._chat(sys, body.slice(0, 8000), creative ? 900 : 600, creative ? 0.8 : 0.2)
  }
  /** 通用消息数组；研究工具的规划 / 抽取 / 写报告都走这里。 */
  async chat(messages, maxTokens = 600, json = false, temperature = 0.2) {
    const textOf = (c) => (typeof c === 'string' ? c
      : Array.isArray(c) ? c.map((b) => (b && b.type === 'text' ? b.text : '')).join('\n') : '')
    const list = Array.isArray(messages) ? messages : []
    const sys = list.filter((m) => m.role === 'system').map((m) => textOf(m.content)).join('\n\n')
    const body = list.filter((m) => m.role !== 'system').map((m) => textOf(m.content)).join('\n\n')
    return this._chat(sys, body, maxTokens, temperature)
  }
  async route() {
    let sel = null
    const ctx = this._ctx()
    const llm = ctx.get('llm')
    let provider = ''
    let model = ''
    try {
      sel = ctx.get('agentDefaultModel')?.currentSelection?.()
      provider = sel?.provider || sel?.route?.provider || ''
      model = sel?.model || sel?.modelId || ''
    } catch { /* ignore */ }
    if (!provider) {
      const ps = llm.listProviders?.() || []
      provider = ps[0]?.id || ''
    }
    if (provider && !model) {
      try { const ms = await llm.listModels(provider); model = ms[0]?.id || '' } catch { /* ignore */ }
    }
    if (!provider || !model) throw new Error('llm route: provider=' + provider + ' model=' + model + ' sel=' + JSON.stringify(sel || null))
    return { llm, provider, model }
  }
  async _chat(system, text, maxTokens = 400, temperature = 0.2, history = null) {
    const { llm, provider, model } = await this.route()
    // 多轮上下文：把同一段会话的前几轮也带进去（宿主模型按 messages 吃）
    const messages = []
    for (const m of Array.isArray(history) ? history : []) {
      if (!m || !m.text) continue
      messages.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: [{ type: 'text', text: String(m.text).slice(0, 300) }] })
    }
    messages.push({ role: 'user', content: [{ type: 'text', text: String(text) }] })
    const opts = { provider, model, system, messages, maxTokens, temperature }
    let out = ''
    let sawDelta = false
    if (typeof llm.prepareCall === 'function') {
      const cfg = { provider, model, temperature, maxTokens }
      const call = await llm.prepareCall(cfg)
      // 用 prepareCall 返回的 config 原样回传，避免校验不一致
      const streamOpts = { ...call.config, system, messages: opts.messages }
      for await (const ch of call.stream(streamOpts)) {
        if (ch.type === 'text-delta') { out += ch.text; sawDelta = true }
        else if (ch.type === 'block-end' && ch.block?.type === 'text' && !sawDelta) out += ch.block.text || ''
        else if (ch.type === 'finish' && ch.reason?.kind === 'error') {
          // 把原因带出来：上层只会记一句 lastError，看不见细节的话没法修
          throw new Error('llm finish error: ' + JSON.stringify(ch.reason).slice(0, 280))
        }
      }
    } else {
      for await (const ch of llm.stream(opts)) if (ch.type === 'text-delta') out += ch.text
    }
    return out
  }
  async appraise(text, formula = 'v1', context = '') {
    const user = context
      ? '前几句：\n' + String(context).slice(0, 600) + '\n\n现在这句：' + String(text).slice(0, 2000)
      : String(text).slice(0, 2000)
    if (String(formula) === 'concern') {
      const raw2 = await this._chat(promptFor('concern'), user, 2000, 0.2)
      return finalizeAppraisal(parseJson(raw2) || {})
    }
    let raw = ''
    let d = {}
    for (let attempt = 0; attempt < 2; attempt++) {
      raw = await this._chat(AP_PROMPT, String(text).slice(0, 2000), 2000, attempt === 0 ? 0.2 : 0)
      try { d = parseJson(raw) || {}; break } catch (e) {
        // 模型有时输出被截断/带噪声：直接从文本里抠八类数字
        const loose = {}
        let hit = 0
        for (const k of AP_LABELS) {
          const m = String(raw).match(new RegExp('"' + k + '"\\s*:\\s*([0-9.]+)'))
          if (m) { loose[k] = Number(m[1]); hit++ }
        }
        if (hit >= 6) { d = { scores: loose }; break }
        if (attempt === 1) throw new Error('non-json: ' + String(raw).slice(0, 120))
      }
    }
    const scores = normalizeScores(d)
    const unknown = d.label === 'unknown' || d.label === 'none' || d.label === 'other'
    const label = unknown ? 'unknown' : (scores ? AP_LABELS.reduce((b, k) => (scores[k] > scores[b] ? k : b), 'calm') : (AP_LABELS.includes(d.label) ? d.label : 'calm'))
    const userScores = normalizeScores({ scores: d.user_scores })
    const userLabel = AP_LABELS.includes(d.user_label) ? d.user_label
      : (userScores ? AP_LABELS.reduce((b, k) => (userScores[k] > userScores[b] ? k : b), 'calm') : null)
    return { ...d, scores, label, user_label: userLabel, user_scores: userScores, raw_name: unknown ? String(d.raw || d.name || '') : undefined, source: 'model' }
  }
  /** 宿主模型也能直接回话：没有单独配聊天模型时，不该退回规则兜底。 */
  async reply(ctx) {
    // 宿主 llm 的 stream 不接受 assistant 消息（replayState 报错），历史压进 system
    return this._chat(buildReplySystem({ ...ctx, historyInSystem: true }), String(ctx.text || '').slice(0, 2000), 400, 0.8)
  }
  /** 宿主模型也能抽事实：同一段对话，不该因为没配聊天模型就一条都不抽。 */
  async extract(turns) {
    const raw = await this.chat([
      { role: 'system', content: '从对话抽取值得长期记住的事实/偏好/边界。只输出 JSON 数组：[{"text":"","type":"fact|episode|appraisal","mark":"normal|sensitive","key":"","terms":[""]}]，最多 20 条。' +
        'text 用一句客观陈述，写清实体与属性；key 是稳定的去重键（如「用户.咖啡.偏好」）；terms 是 3~6 个「以后用户可能怎么问这件事」的词。没有就留空数组。' },
      { role: 'user', content: JSON.stringify(turns).slice(0, 6000) },
    ], 700, true)
    const arr = parseJson(raw)
    if (!Array.isArray(arr)) throw new Error('not array')
    return arr.filter((x) => x && x.text).slice(0, 30)
  }
}

class ChainAdapter {
  constructor(list) { this.list = list.filter(Boolean); this.name = 'chain' }
  available() { return this.list.some((a) => a.available()) }
  _pick(method) {
    // 能力要按方法逐个看：宿主适配器没有 extract 时不能整个链都失败。
    // embedOnly 的适配器（本地向量服务）只能接 embed，不能冒充聊天模型。
    return this.list.find((a) => a.available() && (!a.embedOnly || method === 'embed') && typeof a[method] === 'function') || null
  }
  /** 这个方法现在真的有人能跑吗（ModelPort.capabilities 用它，避免整条链冒充能力）。 */
  can(method) { return !!this._pick(method) }
  async _run(method, ...args) {
    const a = this._pick(method)
    if (!a) throw new Error('chain: no adapter for ' + method)
    return a[method](...args)
  }
  appraise(t, f) { return this._run('appraise', t, f) }
  extract(t) { return this._run('extract', t) }
  summarize(t) { return this._run('summarize', t) }
  reply(c) { return this._run('reply', c) }
  complete(a) { return this._run('complete', a) }
  embed(t) { return this._run('embed', t) }
  chat(messages, maxTokens, json, temperature) {
    const a = this._pick('chat')
    if (!a) throw new Error('chain: no adapter for chat')
    return a.chat(messages, maxTokens, json, temperature)
  }
}

export function createModel() {
  const rules = new RulesAdapter()
  let fileCfg = {}
  try {
    const p = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'consciousness', 'model.json')
    if (fs.existsSync(p)) fileCfg = JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch { fileCfg = {} }
  const url = process.env.DSHC_MODEL_URL || fileCfg.url || ''
  const key = process.env.DSHC_MODEL_KEY || fileCfg.key || ''
  const model = process.env.DSHC_MODEL_NAME || fileCfg.model || 'deepseek-chat'
  let local = false
  try { const h = new URL(url).hostname; local = h === '127.0.0.1' || h === 'localhost' || h === '::1' } catch { /* ignore */ }
  const external = url && (key || local) ? new OpenAIAdapter({
    url, key, model, timeout: fileCfg.timeout,
    embedModel: process.env.DSHC_EMBED_MODEL || fileCfg.embeddingModel || fileCfg.embedModel,
  }) : null
  // 向量单独配：本机 Ollama / 任意 OpenAI 兼容的 /embeddings。
  // 和聊天模型分开，避免「为了向量把整个插件切到小模型」。
  const emb = fileCfg.embedding || {}
  const embedUrl = String(process.env.DSHC_EMBED_URL || emb.url || '').replace(/\/$/, '')
  const embedAdapter = embedUrl ? new OpenAIAdapter({
    url: embedUrl,
    key: process.env.DSHC_EMBED_KEY || emb.key || '',
    model: emb.model || 'bge-m3',
    embedModel: process.env.DSHC_EMBED_MODEL || emb.model || 'bge-m3',
    timeout: Number(emb.timeout || 20000),
    embedOnly: true,
  }) : null
  const chain = new ChainAdapter([external, embedAdapter, new HostLlmAdapter()])
  return new ModelPort(chain, rules)
}
