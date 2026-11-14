/**
 * 说话分寸 · 词表生成器（把「感觉行」从 24 句模板换成一句生成的人话）
 *
 * 老办法：8 种情绪 × 3 档强度 = 24 句写死的「感觉现在大概：脑子有点绕…」。
 * 同一句天天用，就成了口癖；而「感觉/情绪/有点」这种词一多，AI 味就出来了。
 *
 * 这里的规矩（生成、校验、去重三件都在这一页）：
 *   1) 只写可核对的动作或事实，不写「我感觉…」；「感觉 / 情绪 / 情感 / 有点」直接不许出现。
 *   2) 8~24 字，一行，不解释。
 *   3) 最近用过的（默认 30 天）不许再用；重了就不收，宁可留着旧模板。
 *
 * 纯函数部分可单测；generateVoice 要注入 complete，失败一律返回 ok:false（调用方回退模板）。
 */

export const VOICE_BANNED = ['感觉', '情绪', '情感', '有点']
export const VOICE_MIN = 8
export const VOICE_MAX = 24

const num = (v, d) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : d
}

/** 这一句能不能进提示词。返回 { ok, reason }。 */
export function validateVoice(text) {
  const t = String(text == null ? '' : text).trim()
  if (!t) return { ok: false, reason: 'empty' }
  if (t.includes('\n')) return { ok: false, reason: 'multiline' }
  // 禁词先判：这样「有点想追问」报的是 banned，而不是 short——报错得指得准，改的人才知道往哪改
  for (const w of VOICE_BANNED) if (t.includes(w)) return { ok: false, reason: 'banned:' + w }
  const len = Array.from(t).length
  /* 线上真踩过：模型给回一句英文「How can I help you?」，当时只看长度和禁词，就把它当感受行塞进了提示词。
     现在要求：主体是中文（汉字至少占一半），而且不是问句——感受行不是拿来问「需要帮忙吗」的。 */
  const cjk = (t.match(/[\u4e00-\u9fff]/g) || []).length
  if (cjk < len * 0.5) return { ok: false, reason: 'not-chinese' }
  if (/[?？]/.test(t)) return { ok: false, reason: 'question' }
  if (len < VOICE_MIN) return { ok: false, reason: 'short' }
  if (len > VOICE_MAX) return { ok: false, reason: 'long' }
  if (/^(嗯|啊|哦|好吧)/.test(t)) return { ok: false, reason: 'filler' }
  if (/[，。！？,.!?]$/.test(t) && len > VOICE_MAX - 1) return { ok: false, reason: 'long' }
  return { ok: true }
}

const norm = (s) => String(s || '').replace(/[\s\p{P}]/gu, '')
/** 和最近的某一句太像（去掉标点后一样，或互相包含且都不短）。 */
export function isRepeat(text, recent = []) {
  const t = norm(text)
  if (!t) return true
  for (const r of recent) {
    const n = norm(r)
    if (!n) continue
    if (n === t) return true
    if (t.length >= 6 && n.length >= 6 && (n.includes(t) || t.includes(n))) return true
  }
  return false
}

/** 模型给的那一句：优先认 JSON 的 line 字段（影子那边证明这个模型吃 JSON 更稳），再退回纯文本第一行。 */
export function parseVoice(out) {
  let t = String(out == null ? '' : out).trim()
  if (!t) return ''
  t = t.replace(/^```(?:json|text|markdown)?\s*/i, '').replace(/```\s*$/, '').trim()
  const a = t.indexOf('{')
  const b = t.lastIndexOf('}')
  if (a >= 0 && b > a) {
    try {
      const obj = JSON.parse(t.slice(a, b + 1))
      const line = String((obj && (obj.line || obj.text || obj.utterance)) || '').trim()
      if (line) return line.replace(/^["'「『]+/, '').replace(/["'」』]+$/, '').trim()
    } catch { /* 不是 JSON，往下走 */ }
  }
  t = t.split('\n').map((x) => x.trim()).filter(Boolean)[0] || ''
  t = t.replace(/^["'「『]+/, '').replace(/["'」』]+$/, '').trim()
  return t
}

/* 用 JSON 格式问（影子那边验证过：这个模型对「只输出 JSON」比对「只输出一行」听话得多）。 */
const VOICE_SYS = '只输出 JSON，不要解释、不要代码围栏，格式：{"line":"一行中文"}。'
  + 'line 写她此刻的状态，或刚才那句话在她那儿的样子，8~24 字，第一人称或省略主语都行。'
  + '能对上真实情形的一句话、一个判断、一个念头，都可以。'
  + '不要用「感觉 / 情绪 / 情感 / 有点」，不要写「她」，不要重复给过的句子。'

/** 给模型：这一刻的数 + 最近用过的句子（免得又给同一句）。 */
export function buildVoicePrompt({ label = 'calm', intensity = 0.4, slow = 0, mood = null, recent = [] } = {}) {
  const state = '情绪标签：' + String(label) + '；强度 ' + (Math.round(num(intensity, 0.4) * 100) / 100)
    + '；慢情绪 ' + (Math.round(num(slow, 0) * 100) / 100)
    + (mood == null ? '' : '；整体心情 ' + (Math.round(num(mood, 0) * 100) / 100))
  const used = (recent || []).slice(0, 8)
  return [
    { role: 'system', content: VOICE_SYS },
    { role: 'user', content: state + (used.length ? '\n最近用过（不要再给这些）：\n' + used.map((x) => '- ' + x).join('\n') : '') },
  ]
}

function withTimeout(p, ms) {
  let t = null
  const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new Error('timeout')), Math.max(200, num(ms, 6000))) })
  return Promise.race([p, timeout]).finally(() => { if (t) clearTimeout(t) })
}

/**
 * 问一次模型要一句「感觉行」。重了、坏了就再来一次；两次都不行返回 ok:false（调用方保留模板）。
 * @param {{complete:Function, recent?:string[], timeoutMs?:number, label?:string, intensity?:number, slow?:number, mood?:number}} opt
 */
export async function generateVoice(opt = {}) {
  const t0 = Date.now()
  const { complete, recent = [], timeoutMs = 6000 } = opt
  if (typeof complete !== 'function') return { ok: false, reason: 'no-model', ms: 0 }
  const tried = []
  for (let i = 0; i < 2; i++) {
    let raw = ''
    try {
      raw = await withTimeout(Promise.resolve(complete(buildVoicePrompt({ ...opt, recent: [...recent, ...tried] }))), timeoutMs)
    } catch (e) {
      return { ok: false, reason: String((e && e.message) || '') === 'timeout' ? 'timeout' : 'model-error', tried, ms: Date.now() - t0 }
    }
    const text = parseVoice(raw)
    const v = validateVoice(text)
    if (v.ok && !isRepeat(text, [...recent, ...tried])) {
      return { ok: true, text, reason: 'ok', tried, ms: Date.now() - t0 }
    }
    tried.push(text || '(' + v.reason + ')')
    if (!v.ok) return { ok: false, reason: v.reason, tried, ms: Date.now() - t0 }
  }
  return { ok: false, reason: 'repeat', tried, ms: Date.now() - t0 }
}

/** 落一条「用过」：进事件表，和影子同一个屋，不另开表。 */
export function recordVoice(db, aid, { text, at = Date.now() } = {}) {
  if (!text) return null
  try {
    const id = 'evt_' + Date.now().toString(36) + Math.random().toString(16).slice(2, 10)
    db.prepare('INSERT INTO events VALUES(?,?,?,?,?)').run(id, aid, 'expr.phrase', JSON.stringify({ text: String(text) }), new Date(at).toISOString())
    return id
  } catch { return null }
}

/** 最近用过的句子（给去重用）。 */
export function recentVoices(db, aid, { days = 30, limit = 40 } = {}) {
  try {
    const since = new Date(Date.now() - Math.max(1, num(days, 30)) * 86400000).toISOString()
    const rows = db.prepare("SELECT payload FROM events WHERE agent_id=? AND type='expr.phrase' AND created_at>=? ORDER BY created_at DESC LIMIT ?").all(aid, since, Math.max(1, num(limit, 40)))
    return rows.map((r) => {
      try { return String(JSON.parse(r.payload).text || '') } catch { return '' }
    }).filter(Boolean)
  } catch { return [] }
}

/** 最近一条还在保鲜期内的句子（拼提示词用）。坏句子直接跳过——宁可用模板，也不把英文/问句塞进提示词。 */
export function latestVoice(db, aid, { hours = 12, at = Date.now() } = {}) {
  try {
    const since = new Date(num(at, Date.now()) - Math.max(1, num(hours, 12)) * 3600000).toISOString()
    const rows = db.prepare("SELECT payload, created_at FROM events WHERE agent_id=? AND type='expr.phrase' AND created_at>=? ORDER BY created_at DESC LIMIT 8").all(aid, since)
    for (const row of rows) {
      let text = ''
      try { text = String(JSON.parse(row.payload).text || '') } catch { continue }
      if (text && validateVoice(text).ok) return { text, at: row.created_at }
    }
    return null
  } catch { return null }
}
