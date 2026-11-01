/**
 * 行动层的公共小工具：超时抓取、HTML 转文本、相似度、哈希。
 * 不依赖宿主 API，纯 Node。
 */
import crypto from 'node:crypto'

export const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

export function sha256(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex')
}

export function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, Number(n) || 0))
}

export function sleep(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    if (t.unref) t.unref()
  })
}

/** 带超时的 fetch：超时抛 AbortError，调用方自己决定怎么降级。 */
export async function fetchWithTimeout(url, options = {}, timeoutMs = 12000) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), Math.max(1000, Number(timeoutMs) || 12000))
  try {
    return await fetch(url, { ...options, signal: options.signal || ctrl.signal })
  } finally {
    clearTimeout(timer)
  }
}

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–',
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', middot: '·', times: '×', copy: '©', reg: '®',
}

export function decodeEntities(s) {
  return String(s).replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/gi, (all, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      if (Number.isFinite(code) && code > 0 && code < 0x110000) {
        try { return String.fromCodePoint(code) } catch { return all }
      }
      return all
    }
    const v = ENTITIES[body.toLowerCase()]
    return v == null ? all : v
  })
}

/** HTML → 可读文本。块级标签转换行，脚本样式直接丢掉。 */
export function htmlToText(html, { max = 16000 } = {}) {
  let s = String(html || '')
  s = s.replace(/<!--[\s\S]*?-->/g, ' ')
  s = s.replace(/<(script|style|noscript|svg|iframe|canvas|template)[\s\S]*?<\/\1>/gi, ' ')
  s = s.replace(/<(br|hr)\s*\/?>/gi, '\n')
  s = s.replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote|pre|table|ul|ol|dd|dt)>/gi, '\n')
  s = s.replace(/<li[^>]*>/gi, '· ')
  s = s.replace(/<[^>]+>/g, ' ')
  s = decodeEntities(s)
  s = s.replace(/[ \t\f\v\u00a0]+/g, ' ')
  s = s.replace(/ *\n */g, '\n')
  s = s.replace(/\n{3,}/g, '\n\n')
  s = s.trim()
  return s.length > max ? s.slice(0, max) + '\n…（截断）' : s
}

export function hostOf(url) {
  try {
    const u = new URL(String(url))
    return u.hostname.toLowerCase().replace(/^www\./, '')
  } catch { return '' }
}

/** URL 归一：去掉锚点、跟踪参数、末尾斜杠。用来判重，不用于展示。 */
export function canonicalUrl(raw) {
  try {
    const u = new URL(String(raw))
    u.hash = ''
    const drop = /^(utm_|spm$|from$|ref$|source$|fbclid$|gclid$|yclid$|mc_cid$|mc_eid$|share_|vd_source$)/i
    const keep = []
    for (const [k, v] of [...u.searchParams.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (drop.test(k)) continue
      keep.push([k, v])
    }
    u.search = ''
    for (const [k, v] of keep) u.searchParams.append(k, v)
    u.protocol = u.protocol.toLowerCase()
    u.hostname = u.hostname.toLowerCase()
    if (u.pathname.length > 1 && u.pathname.endsWith('/')) u.pathname = u.pathname.replace(/\/+$/, '')
    let out = u.toString()
    if (out.endsWith('/') && !u.search) out = out.slice(0, -1)
    return out
  } catch { return String(raw || '') }
}

/** 中英混排的粗粒度分词：英文按词，中文按二元组。用于判断两条说法是不是同一件事。 */
export function tokensOf(text) {
  const s = String(text || '').toLowerCase().replace(/[\s\u3000]+/g, ' ')
  const out = new Set()
  for (const w of s.match(/[a-z0-9][a-z0-9._-]{1,}/g) || []) out.add(w)
  const cjk = s.replace(/[^\u4e00-\u9fff]+/g, ' ')
  for (const run of cjk.split(/\s+/)) {
    if (run.length < 2) continue
    for (let i = 0; i + 1 < run.length; i++) out.add(run.slice(i, i + 2))
  }
  return out
}

export function jaccard(a, b) {
  const A = a instanceof Set ? a : tokensOf(a)
  const B = b instanceof Set ? b : tokensOf(b)
  if (!A.size || !B.size) return 0
  let inter = 0
  const small = A.size <= B.size ? A : B
  const big = small === A ? B : A
  for (const x of small) if (big.has(x)) inter++
  return inter / (A.size + B.size - inter)
}

/** 从模型回复里抠 JSON（容忍 ```json 围栏和前后废话）。 */
export function parseJsonLoose(raw) {
  const s = String(raw || '').trim()
  if (!s) return null
  try { return JSON.parse(s) } catch { /* 继续 */ }
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) { try { return JSON.parse(fence[1].trim()) } catch { /* 继续 */ } }
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try { return JSON.parse(s.slice(start, end + 1)) } catch { /* 继续 */ }
  }
  const as = s.indexOf('[')
  const ae = s.lastIndexOf(']')
  if (as >= 0 && ae > as) {
    try { return JSON.parse(s.slice(as, ae + 1)) } catch { /* 继续 */ }
  }
  return null
}

/** 并发限流（不引第三方库）。 */
export async function mapLimit(items, limit, fn) {
  const list = [...items]
  const out = new Array(list.length)
  let next = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, list.length)) }, async () => {
    for (;;) {
      const i = next++
      if (i >= list.length) return
      out[i] = await fn(list[i], i)
    }
  })
  await Promise.all(workers)
  return out
}
