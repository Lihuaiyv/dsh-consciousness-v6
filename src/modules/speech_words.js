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

export const VOICE_BANNED = ['感觉', '情绪', '情感']
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

/* 用 JSON 格式问（影子那边验证过：这个模型对「只输出 JSON」比对「只输出一行」听话得多）。
   2026-11-15 改：这一行从「动作借代」改成「说心情」；主人 22:38 亲手定了这段措辞，照抄，别自己加约束。
   要点：用「你」不用「她」；只写心情；摘要当上下文。 */
const VOICE_SYS = '只输出 JSON，不要解释、不要代码围栏，格式：{"line":"一行中文"}。'
  + '\nline 写你此刻大概的心情：说自己当下心情什么样，8~24 字，第一人称或省主语都行。'
  + '\n只写心情。不要重复以前写过的句子。'
  + '\n如果下面还给了「刚才他那句落下来时我的反应」，就把这一阵的心情和那一下揉成一句，别用分号断成两截、别写成两件事。'
  + '\n下面是最近六轮对话（「对方：」是他，「我：」是你，各一句短的），心情贴着这些事，不要凭空造一件不存在的事。'

/**
 * 给模型：这一刻的数 + 最近几轮对话（你/我，各一句压好的短话）。
 * 2026-11-15：原来给的是「最近用过的八句原句」——本意防重复，结果把「手/笔/纸」这套意象也锁死了。
 * 现在改成给**最近六轮压好的对话**（主人 22:42 定：两边都压过，写成对话的样子，六轮十二行）。
 * @param {{label?:string, intensity?:number, slow?:number, mood?:number, dialogue?:Array<{you?:string, me?:string}>}} opt
 */
export function buildVoicePrompt({ label = 'calm', intensity = 0.4, slow = 0, mood = null, dialogue = [], snap = null } = {}) {
  const state = '这一刻：情绪标签 ' + String(label) + '；强度 ' + (Math.round(num(intensity, 0.4) * 100) / 100)
    + '；慢情绪 ' + (Math.round(num(slow, 0) * 100) / 100)
    + (mood == null ? '' : '；整体心情 ' + (Math.round(num(mood, 0) * 100) / 100) + '（-1 到 1，0 是平）')
  const pairs = (dialogue || []).filter((p) => p && (p.you || p.me)).slice(-6)
  /* 老数据只有「我」那一半（没压过对方的话），就只出我这一行——别塞「（没压出来）」这种占位，
     模型会把它当发生过的事。新的一轮开始两边都有。
     2026-11-15 22:49 主人提醒：那一栏不一定是他——也可能是别人、或者客套话，所以写「对方」，不写「你」。 */
  const log = pairs
    .map((p) => [(p.you ? '对方：' + p.you : ''), (p.me ? '我：' + p.me : '')].filter(Boolean).join('\n'))
    .filter(Boolean)
    .join('\n')
  const snapText = snap && snap.short
    ? '\n刚才他那句落下来时：' + (snap.cause ? '他说「' + String(snap.cause).slice(0, 40) + '」；' : '') + '我的反应是 ' + snap.short
    : ''
  return [
    { role: 'system', content: VOICE_SYS },
    {
      role: 'user',
      content: state + (pairs.length ? '\n最近六轮（旧→新）：\n' + log : '') + snapText,
    },
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
    /* 2026-11-15：提示词已经不列禁词了（主人定了短版），所以违规也当「再来一次」，
       而不是一句就把这一轮判死——否则模型偶尔写个「情绪」就整天退回模板。 */
    if (v.ok && !isRepeat(text, [...recent, ...tried])) {
      return { ok: true, text, reason: 'ok', tried, ms: Date.now() - t0 }
    }
    tried.push(text || '(' + v.reason + ')')
  }
  return { ok: false, reason: 'repeat', tried, ms: Date.now() - t0 }
}

/** 落一条「用过」：进事件表，和影子同一个屋，不另开表。
 *  2026-11-15：顺手记下写这句时的四个数——下一轮靠它们判断「心情变了没有、要不要重写」。 */
export function recordVoice(db, aid, { text, at = Date.now(), label = null, intensity = null, slow = null, mood = null } = {}) {
  if (!text) return null
  try {
    const id = 'evt_' + Date.now().toString(36) + Math.random().toString(16).slice(2, 10)
    db.prepare('INSERT INTO events VALUES(?,?,?,?,?)').run(id, aid, 'expr.phrase', JSON.stringify({
      text: String(text),
      label: label == null ? null : String(label),
      intensity: Number.isFinite(Number(intensity)) ? Number(intensity) : null,
      slow: Number.isFinite(Number(slow)) ? Number(slow) : null,
      mood: Number.isFinite(Number(mood)) ? Number(mood) : null,
    }), new Date(at).toISOString())
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
      let p = null
      try { p = JSON.parse(row.payload) } catch { continue }
      const text = String((p && p.text) || '')
      if (!text || !validateVoice(text).ok) continue
      return {
        text,
        at: row.created_at,
        snap: { label: p.label || null, intensity: Number.isFinite(Number(p.intensity)) ? Number(p.intensity) : null, slow: Number.isFinite(Number(p.slow)) ? Number(p.slow) : null, mood: Number.isFinite(Number(p.mood)) ? Number(p.mood) : null },
      }
    }
    return null
  } catch { return null }
}

/** 强度分档（和 expression_state 一致：0 弱 / 1 中 / 2 强）。 */
function bandOf(v) {
  const i = Math.max(0, Math.min(1, num(v, 0.4)))
  if (i < 0.4) return 0
  if (i < 0.7) return 1
  return 2
}

/**
 * 这一句还够用吗（2026-11-15）：心情变了才重写，不是到点就换。
 *
 * 判据（任何一条成立就重写）：
 *   - 没有新鲜句；
 *   - 情绪标签变了；
 *   - 强度跨档（弱/中/强互换）；
 *   - 慢情绪走了 0.2 以上；
 *   - 旧的没记下当时的数（老数据），只能当「变了」处理。
 * 冷却：两条之间至少隔 gapMin 分钟，免得一轮一句烧调用。
 * @returns {{stale:boolean, why:string}}
 */
export function voiceStale(snap, { label = 'calm', intensity = 0.4, slow = 0, at = Date.now(), lastAt = null, gapMin = 30 } = {}) {
  const gap = Math.max(0, num(gapMin, 30)) * 60000
  if (lastAt) {
    const t = Date.parse(lastAt)
    if (Number.isFinite(t) && at - t < gap) return { stale: false, why: 'gap' }
  }
  if (!snap) return { stale: true, why: 'new' }
  if (snap.label == null || snap.intensity == null || snap.slow == null) return { stale: true, why: 'unrecorded' }
  if (String(snap.label) !== String(label || 'calm')) return { stale: true, why: 'label' }
  if (bandOf(snap.intensity) !== bandOf(intensity)) return { stale: true, why: 'band' }
  if (Math.abs(num(snap.slow, 0) - num(slow, 0)) >= 0.2) return { stale: true, why: 'slow' }
  return { stale: false, why: 'same' }
}
