/**
 * 每轮压一次：一句话摘要（我上一句）＋ 六轮对话压缩（你 / 我）。
 *
 * 起初（计划-上一句摘要-2026-11-15）只压「我上一句」，因为那行「我上一句说的是「…」」是硬截断，常切出半句。
 * 2026-11-15 22:42 主人又定了一条：**主人的话也不许原样递进提示词，一起压**——以后那条「最近几轮在聊」
 * 要写成对话的样子（你：… 我：…），六轮十二行。同一个模型调用顺手压两句，不多花一次钱。
 *
 * 硬规则：
 *   - 只压，不判断、不评价、不加情绪；原话留在 chat_turns，一个字都不动。
 *   - 失败/超时/不合格一律不写，读侧退回原来的截断（presence.js 的兜底一直在）。
 *   - 「最多 N 字」不是「必须 N 字」；写死长度会逼出凑字，跟模板一个病。
 *   - 落事件不建表：`presence.last_sentence`，payload 带 turn_id / you / me，同一轮只写一条。
 */

const TYPE = 'presence.last_sentence'
const SYS = '只输出两行，不要解释、不要代码围栏、不要 JSON。'
  + '第一行以「对方：」开头，写对方那句话的短版（对方不一定是一个人，可能是主人，也可能是别人）。'
  + '第二行以「我：」开头，写她刚说出口那句话的短版。'
  + '每行最多 {N} 字，超了会被截掉；you 用对方自己的说法，me 像她刚说出口的话——不要抄整段、不要写成摘要报告。'
  + '两行都要完整，不许以省略号结尾；不要保留链接、路径、代码、英文文件名；不要新增谁没说过的话。'

function num(v, d) {
  const n = Number(v)
  return Number.isFinite(n) ? n : d
}

/** 字数按「看得见的字」算（emoji / 生僻字不按 UTF-16 算两次）。 */
function len(s) {
  return Array.from(String(s || '')).length
}

function clip(s, n) {
  const a = Array.from(String(s || '').replace(/\s+/g, ' ').trim())
  return a.length > n ? a.slice(0, n).join('') + '…' : a.join('')
}

/** 给模型：这一轮的两句话 + 目标长度。两边都没有就直接返回（调用方不该来问）。 */
export function buildPairPrompt({ user = '', text = '', maxChars = 24 } = {}) {
  const you = String(user == null ? '' : user).replace(/〔留〕/g, '').trim()
  const me = String(text == null ? '' : text).replace(/〔留〕/g, '').trim()
  return [
    { role: 'system', content: SYS.replace('{N}', String(num(maxChars, 24))) },
    { role: 'user', content: '对方：' + you + '\n我：' + me },
  ]
}

/** 键名从宽：模型有时候用中文键、全角冒号、方括号引号。 */
function grabField(src, keys) {
  for (const k of keys) {
    const re = new RegExp('["“”「」『』]?\\s*' + k + '\\s*["“”「」『』]?\\s*[:：]\\s*["“”「」『』]?([^"“”「」『』\\n]*)', 'i')
    const m = src.match(re)
    if (m) {
      const v = String(m[1] || '').replace(/[，,]\s*$/, '').trim()
      if (v) return v
    }
  }
  return ''
}

/** 从模型输出里抠两句。先认「对方：… / 我：…」两行（现在就要这个），再退回 JSON。
 *  为什么不用 JSON 了：2026-11-15 22:47 起，两键 JSON 的版本模型一直回空串，单键时代从没空过。 */
export function parsePair(raw) {
  let t = String(raw == null ? '' : raw).trim()
  if (!t) return { you: '', me: '' }
  t = t.replace(/^```(?:json|text|markdown)?\s*/i, '').replace(/```\s*$/, '').trim()
  // ① 两行标签（要的就是这个）
  const lines = t.split('\n').map((x) => x.trim()).filter(Boolean)
  const pickLabeled = (keys) => {
    for (const ln of lines) {
      const s = ln.replace(/^[-*•\s]+/, '')
      for (const k of keys) {
        const m = s.match(new RegExp('^' + k + '\\s*[:：]\\s*(.+)$'))
        if (m) return String(m[1]).trim()
      }
    }
    return ''
  }
  const labYou = pickLabeled(['对方', '你', 'you'])
  const labMe = pickLabeled(['我', 'me'])
  if (labYou || labMe) return { you: labYou, me: labMe }
  const a = t.indexOf('{')
  const b = t.lastIndexOf('}')
  if (a >= 0 && b > a) {
    try {
      const o = JSON.parse(t.slice(a, b + 1))
      const you = String((o && (o.you || o.ta || o.user || o.he || o['对方'])) || '').trim()
      const me = String((o && (o.me || o.line || o.text || o.short || o['我'])) || '').trim()
      if (you || me) return { you, me }
    } catch { /* 不是标准 JSON（全角冒号、中文键都在这里翻车过），走下面按字段抠 */ }
    const you = grabField(t, ['you', 'ta', 'user', '对方', '对方说'])
    const me = grabField(t, ['me', 'line', 'text', 'short', '我', '我说'])
    if (you || me) return { you, me }
  }
  // 实在不是 JSON：只认第一行当「我」那句——比猜错强。
  const first = t.split('\n').map((x) => x.trim()).filter(Boolean)[0] || ''
  return { you: '', me: first }
}

/**
 * 合格标准（都是被坏例子逼出来的）：
 * 非空、长得像一句人话、不超过 N+8 字、不以省略号收尾、不带链接/路径/长英文。
 */
export function validateLastSentence(text, { maxChars = 24 } = {}) {
  let t = String(text == null ? '' : text).replace(/\s+/g, ' ').trim()
  if (!t) return { ok: false, reason: 'empty' }
  t = t.replace(/^["'“「『]+/, '').replace(/["'”」』]+$/, '').trim()
  if (!t) return { ok: false, reason: 'empty' }
  if (t.includes('```')) return { ok: false, reason: 'fence' }
  const n = len(t)
  const cap = num(maxChars, 24)
  if (n < 4) return { ok: false, reason: 'short' }
  if (n > cap + 8) return { ok: false, reason: 'long' }
  if (/(…|\.\.\.)\s*$/.test(t)) return { ok: false, reason: 'ellipsis' }
  if (/https?:|\[[^\]]*\]\(/.test(t)) return { ok: false, reason: 'link' }
  if (/[A-Za-z]{8,}/.test(t)) return { ok: false, reason: 'latin' }
  if (/^\s*[\[{]/.test(t)) return { ok: false, reason: 'shape' }
  return { ok: true, text: t }
}

function withTimeout(p, ms) {
  let t = null
  const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new Error('timeout')), Math.max(200, num(ms, 6000))) })
  return Promise.race([p, timeout]).finally(() => { if (t) clearTimeout(t) })
}

/**
 * 一句收尾（2026-11-15 23:0x）：模型「压」和「不压」都得能用。
 * 本地 14B 实测会把整段原样抄回来（870ms、格式对、内容没压），所以：超长不再判失败，**本地裁到 N 字**；
 * 很短的一句（比如对方只说了「咋样了」）也照收——那种本来就没什么好压的。
 * 只有空的、带链接/围栏的才算真坏，值得重试。
 */
function settleOne(text, maxChars) {
  const t = String(text == null ? '' : text).replace(/\s+/g, ' ').trim()
  if (!t) return { ok: false, reason: 'empty' }
  const v = validateLastSentence(t, { maxChars })
  if (v.ok) return v
  if (v.reason === 'long') return { ok: true, text: clip(t, maxChars) }
  if (v.reason === 'short') return { ok: true, text: t }
  return v
}

/**
 * 要两句短话。两边都本来就不长（≤ N 字）时**不调模型**，直接原样还回去。
 * @returns {{ok:boolean, you:string, text:string, reason?:string, ms:number, skipped?:boolean}}
 */
export async function generatePairSummary(opt = {}) {
  const t0 = Date.now()
  const { complete, timeoutMs = 6000 } = opt
  const maxChars = num(opt.maxChars, 24)
  const user = String(opt.user == null ? '' : opt.user).replace(/〔留〕/g, '').trim()
  const text = String(opt.text == null ? '' : opt.text).replace(/〔留〕/g, '').trim()
  if (!user && !text) return { ok: false, you: '', text: '', reason: 'empty', ms: 0 }
  if (len(user) <= maxChars && len(text) <= maxChars) return { ok: true, you: user, text, reason: 'short', ms: 0, skipped: true }
  if (typeof complete !== 'function') return { ok: false, you: '', text: '', reason: 'no-model', ms: 0 }
  /* 线上真踩过（2026-11-15 22:39～22:59，连着 12 次）：这条是全轮第一个模型调用，紧接着回话之后发出去，
     拿回的是**空串**（不是格式坏）；同一轮两秒后的词表调用却是好的。
     推断是「回话那条通道还没彻底收尾」的时间窗，但 1.2 秒那次没躲开，所以把等待分成三段、越往后越晚：
     2.5 秒 / 再 1.2 秒 / 再 2 秒。三次都空就交给调用方兜底（本地截断）。 */
  const delays = Array.isArray(opt.delays) && opt.delays.length ? opt.delays.map((x) => Math.max(0, num(x, 0))) : [2500, 1200, 2000]
  let lastReason = 'empty'
  let raw = ''
  for (let attempt = 0; attempt < Math.max(1, delays.length); attempt++) {
    const wait = delays[attempt] == null ? 1200 : delays[attempt]
    if (wait) await new Promise((r) => setTimeout(r, wait))
    try {
      raw = await withTimeout(Promise.resolve(complete(buildPairPrompt({ user, text, maxChars }))), timeoutMs)
    } catch (e) {
      return { ok: false, you: '', text: '', reason: String((e && e.message) || '') === 'timeout' ? 'timeout' : 'model-error', ms: Date.now() - t0 }
    }
    const parsed = parsePair(raw)
    const vYou = user ? settleOne(parsed.you, maxChars) : { ok: true, text: '' }
    const vMe = text ? settleOne(parsed.me, maxChars) : { ok: true, text: '' }
    if (vYou.ok && vMe.ok) return { ok: true, you: vYou.text || '', text: vMe.text || '', reason: 'ok', ms: Date.now() - t0 }
    lastReason = (!vYou.ok && user ? 'you:' : 'me:') + (vYou.ok ? vMe.reason : vYou.reason)
    // 形状坏（带链接、超长）重试也没用；只有「空」值得再要一次。
    const emptyish = !String(raw || '').trim() || lastReason.endsWith(':empty')
    if (!emptyish) return { ok: false, you: '', text: '', reason: lastReason, raw: clip(raw, 120), ms: Date.now() - t0 }
  }
  return { ok: false, you: '', text: '', reason: lastReason, raw: clip(raw, 160), ms: Date.now() - t0 }
}

/** 落一条（只追加）。同一轮已经写过就不写第二条。
 *  `source`：model = 模型压的；clip = 模型没给、本地截断兜底（六轮上下文不能断）。 */
export function recordLastSentence(db, aid, { turnId = null, conversationId = null, text = '', you = '', maxChars = 24, ms = 0, source = 'model' } = {}) {
  try {
    if (!text && !you) return null
    if (turnId && lastSentenceRow(db, aid, { turnId })) return null
    const id = 'evt_' + Date.now().toString(36) + Math.random().toString(16).slice(2, 10)
    const payload = JSON.stringify({
      text: String(text || ''),
      you: String(you || ''),
      turn_id: turnId || null,
      conv: conversationId || null,
      max: num(maxChars, 24),
      ms: num(ms, 0),
      source: String(source || 'model'),
    })
    db.prepare('INSERT INTO events VALUES(?,?,?,?,?)').run(id, aid, TYPE, payload, new Date().toISOString())
    return id
  } catch { return null }
}

/** 按 turn_id 找那一行（原始 payload）。找不到返回 null。 */
function lastSentenceRow(db, aid, { turnId = null, hours = 72 } = {}) {
  try {
    if (!turnId) return null
    const since = new Date(Date.now() - Math.max(1, num(hours, 72)) * 3600000).toISOString()
    const rows = db.prepare('SELECT payload, created_at FROM events WHERE agent_id=? AND type=? AND created_at>=? ORDER BY created_at DESC, rowid DESC LIMIT 16')
      .all(aid, TYPE, since)
    for (const row of rows) {
      let p = null
      try { p = JSON.parse(row.payload) } catch { continue }
      if (!p || String(p.turn_id || '') !== String(turnId)) continue
      return { text: String(p.text || ''), you: String(p.you || ''), at: row.created_at, max: num(p.max, 24), source: String(p.source || 'model') }
    }
    return null
  } catch { return null }
}

/**
 * 读侧：这一轮（turn_id）有没有压好的短话。
 * **只按 turn_id 认**——拿别轮的短话顶替比截断更糟。
 */
export function lastSentenceOf(db, aid, { turnId = null, hours = 72 } = {}) {
  const row = lastSentenceRow(db, aid, { turnId, hours })
  if (!row || !row.text) return null
  // clip 兜底那条本来就是截断的，别拿「不许以省略号结尾」把它挡掉——挡掉等于白记。
  if (row.source === 'clip') return { text: row.text, you: row.you || '', at: row.at }
  const v = validateLastSentence(row.text, { maxChars: row.max })
  if (!v.ok) return null
  return { text: v.text, you: row.you || '', at: row.at }
}

export const LAST_SENTENCE_TYPE = TYPE

/**
 * 最近几轮压好的对话（旧→新），给「这会儿心情大概」那行当上下文用。
 *
 * 为什么是它：压过的短句已经在库里了，一对不到五十字，六对也就三百字——
 * 比去读帧链便宜得多，也比「最近用过哪些句子」有用：它给的是「我们这一段在聊什么」。
 * 只取同一个会话的，别把别的窗口的事混进来。老行没有 you 的，那一半就不出；
 * 同一毫秒写的两条靠 rowid 定顺序（事件表只追加，rowid 就是写进来的先后）。
 */
export function recentDialoguePairs(db, aid, { conversationId = null, rounds = 6, hours = 48 } = {}) {
  try {
    const n = Math.max(1, Math.min(12, num(rounds, 6)))
    const since = new Date(Date.now() - Math.max(1, num(hours, 48)) * 3600000).toISOString()
    const rows = db.prepare('SELECT payload FROM events WHERE agent_id=? AND type=? AND created_at>=? ORDER BY created_at DESC, rowid DESC LIMIT ?')
      .all(aid, TYPE, since, n * 3)
    const out = []
    for (const row of rows) {
      let p = null
      try { p = JSON.parse(row.payload) } catch { continue }
      if (!p) continue
      if (conversationId && p.conv && String(p.conv) !== String(conversationId)) continue
      const cap = num(p.max, 24)
      const isClip = String(p.source || '') === 'clip'
      const you = p.you ? (isClip ? { ok: true, text: p.you } : validateLastSentence(p.you, { maxChars: cap })) : { ok: false }
      const me = p.text ? (isClip ? { ok: true, text: p.text } : validateLastSentence(p.text, { maxChars: cap })) : { ok: false }
      if (!you.ok && !me.ok) continue
      out.push({ you: you.ok ? you.text : '', me: me.ok ? me.text : '' })
      if (out.length >= n) break
    }
    return out.reverse()
  } catch { return [] }
}
