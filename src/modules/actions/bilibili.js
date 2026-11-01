/**
 * B 站只读客户端：搜索 / 热门 / 推荐流 / 视频详情 / 评论。
 *
 * 用的是网页端公开接口，不需要登录：
 *   - 先访问一次首页拿 buvid3 / b_nut（没有它搜索会 -412）
 *   - wbi 签名（img_key + sub_key 混表）由 /x/web-interface/nav 获取，缓存 6 小时
 * 可选：配置里填 SESSDATA 后能拿到登录态内容（关注流、更高频次），不填也能用。
 */
import crypto from 'node:crypto'
import { fetchWithTimeout, UA, htmlToText } from './util.js'

const MIXIN = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39,
  12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63,
  57, 62, 11, 36, 20, 34, 44, 52,
]

export class BiliError extends Error {
  constructor(code, message, details) {
    super(message)
    this.name = 'BiliError'
    this.code = code
    this.details = details || null
  }
}

const state = {
  jar: new Map(),
  extraCookie: '',
  wbi: null,
  wbiAt: 0,
  booted: false,
}

export function setBiliCookie(cookie) {
  state.extraCookie = String(cookie || '').trim()
  // 用户换了 cookie，旧 wbi 仍可用，但 cookie 变了就重新取一次
  state.booted = false
}

function cookieHeader() {
  const base = [...state.jar.entries()].map(([k, v]) => k + '=' + v).join('; ')
  return [base, state.extraCookie].filter(Boolean).join('; ')
}

function absorb(res) {
  let list = []
  try {
    if (typeof res.headers.getSetCookie === 'function') list = res.headers.getSetCookie()
  } catch { list = [] }
  if (!list.length) {
    const raw = res.headers.get('set-cookie')
    if (raw) list = [raw]
  }
  for (const raw of list) {
    const m = String(raw).match(/^\s*([^=;]+)=([^;]*)/)
    if (m) state.jar.set(m[1].trim(), m[2])
  }
}

async function request(url, { timeout = 12000, referer = 'https://www.bilibili.com/', signal } = {}) {
  let res
  try {
    res = await fetchWithTimeout(url, {
      headers: {
        'User-Agent': UA,
        Referer: referer,
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.6',
        ...(cookieHeader() ? { Cookie: cookieHeader() } : {}),
      },
      signal,
    }, timeout)
  } catch (e) {
    throw new BiliError('BILI_NETWORK', '连不上 B 站：' + String((e && e.message) || e))
  }
  absorb(res)
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { json = null }
  return { res, text, json }
}

async function ensureBoot() {
  if (state.booted) return
  try {
    const r = await request('https://www.bilibili.com/', { timeout: 10000 })
    // 只需要 Cookie；页面本身不解析
    void r
  } catch { /* 首页失败也继续，搜索会自己报错 */ }
  state.booted = true
}

async function getWbi(force = false) {
  if (!force && state.wbi && Date.now() - state.wbiAt < 6 * 3600 * 1000) return state.wbi
  const { json } = await request('https://api.bilibili.com/x/web-interface/nav', { timeout: 10000 })
  const wbi = json && json.data && json.data.wbi_img
  if (!wbi || !wbi.img_url || !wbi.sub_url) {
    throw new BiliError('BILI_WBI', 'B 站没有返回 wbi 签名素材，稍后再试')
  }
  const key = (u) => String(u).split('/').pop().split('.')[0]
  const raw = key(wbi.img_url) + key(wbi.sub_url)
  const mixin = MIXIN.map((i) => raw[i] || '').join('').slice(0, 32)
  state.wbi = mixin
  state.wbiAt = Date.now()
  return mixin
}

function signParams(params, mixin) {
  const p = { ...params, wts: Math.floor(Date.now() / 1000) }
  const query = Object.keys(p)
    .sort()
    .map((k) => {
      const v = String(p[k] == null ? '' : p[k]).replace(/[!'()*]/g, '')
      return encodeURIComponent(k) + '=' + encodeURIComponent(v)
    })
    .join('&')
  const wRid = crypto.createHash('md5').update(query + mixin).digest('hex')
  return query + '&w_rid=' + wRid
}

function stripEm(s) {
  return htmlToText(String(s || '').replace(/<em[^>]*>|<\/em>/g, ''), { max: 300 }).replace(/\n+/g, ' ').trim()
}

function mmss(sec) {
  if (typeof sec === 'string' && /^\d+:\d{1,2}$/.test(sec.trim())) {
    const [m, s] = sec.trim().split(':').map(Number)
    return m + ':' + String(s).padStart(2, '0')
  }
  const n = Math.max(0, Math.round(Number(sec) || 0))
  const m = Math.floor(n / 60)
  const s = n % 60
  return m + ':' + String(s).padStart(2, '0')
}

function iso(ts) {
  const n = Number(ts) || 0
  if (!n) return null
  return new Date(n * 1000).toISOString()
}

function pickStat(stat) {
  const s = stat || {}
  return {
    view: Number(s.view || 0),
    danmaku: Number(s.danmaku || 0),
    reply: Number(s.reply || 0),
    like: Number(s.like || 0),
    coin: Number(s.coin || 0),
    favorite: Number(s.favorite || 0),
    share: Number(s.share || 0),
  }
}

function parseCount(v) {
  if (typeof v === 'number') return v
  const m = String(v == null ? '' : v).trim().match(/^([\d.]+)\s*(万|亿)?/)
  if (!m) return 0
  const n = Number(m[1])
  if (!Number.isFinite(n)) return 0
  return Math.round(n * (m[2] === '亿' ? 1e8 : m[2] === '万' ? 1e4 : 1))
}

function normalizeVideoItem(it, kind) {
  const bvid = String(it.bvid || (it.id && /^BV/i.test(String(it.id)) ? it.id : '')).trim()
  const aid = Number(it.aid || (it.id && !/^BV/i.test(String(it.id)) ? it.id : 0)) || null
  const stat = pickStat(it.stat)
  const view = stat.view || parseCount(it.play)
  const danmaku = stat.danmaku || parseCount(it.video_review)
  const url = bvid
    ? 'https://www.bilibili.com/video/' + bvid
    : (aid ? 'https://www.bilibili.com/video/av' + aid : (it.arcurl || it.uri || ''))
  return {
    kind,
    bvid,
    aid,
    title: stripEm(it.title),
    author: (it.owner && it.owner.name) || it.author || '',
    url,
    cover: it.pic || '',
    duration: mmss(typeof it.duration === 'string' ? it.duration : it.duration),
    published_at: iso(it.pubdate || it.pub_time || it.ctime),
    description: stripEm(it.desc || it.description || ''),
    stat: { ...stat, view, danmaku },
    tag: stripEm(it.tag || ''),
  }
}

function apiUrl(pathname, query) {
  return 'https://api.bilibili.com' + pathname + (query ? '?' + query : '')
}

function ensureCode(json, what) {
  const code = json && Number(json.code)
  if (!Number.isFinite(code)) throw new BiliError('BILI_BAD_RESPONSE', what + '：返回不是 JSON')
  if (code !== 0) {
    const hint = code === -412 ? '（触发风控：换个网络/稍后再试，或在设置里填 B 站 Cookie）'
      : code === -101 ? '（需要登录：请在设置里填 SESSDATA）' : ''
    throw new BiliError('BILI_CODE_' + code, what + '失败：' + (json.message || code) + hint, { code, message: json.message })
  }
  return json.data
}

/** 搜索视频。order: totalrank | click | pubdate | dm | stow */
export async function searchVideos(keyword, { limit = 10, page = 1, order = 'totalrank', signal } = {}) {
  const q = String(keyword || '').trim()
  if (!q) throw new BiliError('BILI_ARG', '搜索关键词不能为空')
  await ensureBoot()
  const mixin = await getWbi()
  const size = Math.max(1, Math.min(30, Number(limit) || 10))
  const query = signParams({
    search_type: 'video',
    keyword: q,
    page: Math.max(1, Number(page) || 1),
    page_size: size,
    order,
  }, mixin)
  const { json } = await request(apiUrl('/x/web-interface/wbi/search/type', query), { signal })
  const data = ensureCode(json, 'B 站搜索')
  const list = (data && data.result) || []
  return {
    keyword: q,
    order,
    items: list.map((it) => normalizeVideoItem(it, 'search')),
    total: Number(data && data.numResults) || list.length,
  }
}

/** 热门（不需要 wbi，最稳）。 */
export async function popular({ limit = 10, page = 1, signal } = {}) {
  await ensureBoot()
  const size = Math.max(1, Math.min(50, Number(limit) || 10))
  const { json } = await request(apiUrl('/x/web-interface/popular?ps=' + size + '&pn=' + Math.max(1, Number(page) || 1)), { signal })
  const data = ensureCode(json, 'B 站热门')
  return {
    items: (data.list || []).map((it) => normalizeVideoItem(it, 'popular')),
  }
}

/** 首页推荐流（wbi）。失败时调用方可以退回 popular。 */
export async function recommend({ limit = 10, signal } = {}) {
  await ensureBoot()
  const mixin = await getWbi()
  const size = Math.max(1, Math.min(30, Number(limit) || 10))
  const query = signParams({
    ps: size,
    fresh_type: 3,
    fresh_idx: 1,
    fresh_idx_1h: 1,
    feed_version: 'V8',
    homepage_ver: 1,
    brush: Math.floor(Math.random() * 5),
  }, mixin)
  const { json } = await request(apiUrl('/x/web-interface/wbi/index/top/feed/rcmd', query), { signal })
  const data = ensureCode(json, 'B 站推荐流')
  return {
    items: ((data && data.item) || []).map((it) => normalizeVideoItem(it, 'recommend')),
  }
}

export async function videoDetail(bvidOrAid, { signal } = {}) {
  const ref = String(bvidOrAid || '').trim()
  if (!ref) throw new BiliError('BILI_ARG', '缺 bvid 或 aid')
  const param = /^BV/i.test(ref) ? 'bvid=' + encodeURIComponent(ref) : 'aid=' + encodeURIComponent(ref.replace(/^av/i, ''))
  const { json } = await request(apiUrl('/x/web-interface/view?' + param), { signal })
  const d = ensureCode(json, 'B 站视频详情')
  return {
    bvid: d.bvid,
    aid: d.aid,
    title: stripEm(d.title),
    description: String(d.desc || '').slice(0, 2000),
    author: (d.owner && d.owner.name) || '',
    author_mid: d.owner && d.owner.mid,
    url: 'https://www.bilibili.com/video/' + d.bvid,
    cover: d.pic,
    published_at: iso(d.pubdate),
    duration: mmss(d.duration),
    category: d.tname,
    stat: pickStat(d.stat),
    pages: (d.pages || []).length,
  }
}

export async function comments(bvidOrAid, { limit = 10, signal } = {}) {
  const detail = await videoDetail(bvidOrAid, { signal })
  const size = Math.max(1, Math.min(30, Number(limit) || 10))
  const { json } = await request(apiUrl('/x/v2/reply?type=1&oid=' + detail.aid + '&sort=2&ps=' + size + '&pn=1'), { signal })
  const data = ensureCode(json, 'B 站评论')
  return {
    bvid: detail.bvid,
    title: detail.title,
    total: Number((data.page && data.page.acount) || 0),
    items: (data.replies || []).map((r) => ({
      author: (r.member && r.member.uname) || '',
      text: String((r.content && r.content.message) || '').slice(0, 800),
      like: Number(r.like || 0),
      at: iso(r.ctime),
    })),
  }
}

/**
 * 发一条视频评论。必须带登录 Cookie（SESSDATA + bili_jct）。
 * 这是公开、不可撤回的写操作，只在用户明确要求时调用。
 */
export async function postComment(ref, text, { cookie, signal } = {}) {
  const body = String(text || '').trim()
  if (!body) throw new BiliError('BILI_ARG', '评论内容是空的')
  if (body.length > 800) throw new BiliError('BILI_ARG', 'B 站评论最多 800 字')
  const jar = new Map()
  for (const part of String(cookie || '').split(/;\s*/)) {
    const i = part.indexOf('=')
    if (i > 0) jar.set(part.slice(0, i).trim(), part.slice(i + 1).trim())
  }
  const sess = jar.get('SESSDATA')
  const csrf = jar.get('bili_jct')
  if (!sess || !csrf) {
    throw new BiliError('BILI_LOGIN_REQUIRED',
      '写评论要登录态：设置里的 B 站 Cookie 至少要有 SESSDATA 和 bili_jct（浏览器 F12 → Application → Cookies 复制整条）')
  }
  const detail = await videoDetail(ref, { signal })
  const form = new URLSearchParams({
    oid: String(detail.aid),
    type: '1',
    message: body,
    csrf,
    plat: '1',
  })
  let res
  try {
    res = await fetchWithTimeout('https://api.bilibili.com/x/v2/reply/add', {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        Referer: 'https://www.bilibili.com/video/' + detail.bvid,
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: String(cookie),
      },
      body: form.toString(),
      signal,
    }, 15000)
  } catch (e) {
    throw new BiliError('BILI_NETWORK', '发评论时连不上 B 站：' + String((e && e.message) || e))
  }
  const raw = await res.text()
  let json = null
  try { json = JSON.parse(raw) } catch { json = null }
  const code = json && Number(json.code)
  if (!Number.isFinite(code)) throw new BiliError('BILI_BAD_RESPONSE', '发评论失败：返回不是 JSON')
  if (code !== 0) {
    const hint = code === -101 ? '（Cookie 失效，重新登录后复制 SESSDATA + bili_jct）'
      : code === -111 ? '（csrf 校验失败：bili_jct 和 SESSDATA 不是同一次登录的）'
        : code === 12002 ? '（评论太频繁，等一会儿）'
          : code === -400 ? '（内容被拒：可能含敏感词或只有链接）' : ''
    throw new BiliError('BILI_COMMENT_' + code, '发评论失败：' + (json.message || code) + hint, { code })
  }
  const rpid = json.data && (json.data.rpid || json.data.rpid_str)
  return {
    ok: true,
    bvid: detail.bvid,
    aid: detail.aid,
    rpid,
    url: 'https://www.bilibili.com/video/' + detail.bvid,
    note: '评论已发出（公开可见，删除要手动去 B 站）',
  }
}

/** 通道体检：游客也能返回 ok；logged_in 只表示 cookie 是否有效。 */
export async function biliStatus({ signal } = {}) {
  try {
    await ensureBoot()
    const { json } = await request('https://api.bilibili.com/x/web-interface/nav', { timeout: 8000, signal })
    const code = Number(json && json.code)
    return {
      ok: true,
      logged_in: code === 0,
      user: code === 0 ? (json.data && json.data.uname) || '' : '',
      note: code === 0 ? '已登录' : '游客可用（搜索走公开接口）',
    }
  } catch (e) {
    return { ok: false, logged_in: false, error: String((e && e.message) || e) }
  }
}
