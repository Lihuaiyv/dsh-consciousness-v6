/**
 * 浏览 → 需求（8 号 §4.5，P3）。
 *
 * 以前 act_browse 抓完正文就扔了，只留一行 action_log。现在抓完顺手 ingest 一次：
 * 落一条 browse_items（title / 正文 / query / dwell），按词表打 need_tags，
 * 给探索的 browseNew 和以后的「浏览 tag 面板」用。
 *
 * 纪律（doc 6 §8）：
 *   - 每小时硬顶 30 条；同一 url 72h 内只记一次；
 *   - dwell<3s 打五折；单条权重 ≤0.02；E/C/R/S 各自有日封顶；
 *   - 只用词表，不上模型/embedding —— 便宜、可解释、模型升级也不会漂。
 */
import { now } from '../db.js'
import { err, nid, agent, getParam } from '../kernel.js'
import { addEvidence } from './axis_evidence.js'

export const MAX_PER_HOUR = 30
export const PER_ITEM_CAP = 0.02
export const DAY_CAP = { E: 0.06, C: 0.04, R: 0.03, S: 0.03 }

const RE = {
  people: /朋友|家人|同事|喜欢的人|关系|感情|恋爱|分手|吵架|和好|陪伴|想念|委屈/,
  threat: /事故|冲突|危险|风险|失败|崩溃|损失|被骗|伤害|威胁|警告|错误/,
  answered: /结论是|原来是|答案是|所以是|确认了|搞清楚了/,
  deep: /原理|为什么|机制|推导|综述|论文|教程|深入|详解/,
}

function clamp01(x) { return Math.max(0, Math.min(1, Number(x) || 0)) }

function domainOf(url) {
  try {
    const u = new URL(String(url))
    return u.hostname.toLowerCase().replace(/^www\./, '')
  } catch { return '' }
}

/**
 * 给一条浏览条目打标签 + 算权重（单条已封顶，日封顶在 ingest 里做）。
 * @returns {{ tags: string[], weights: {E:number,C:number,R:number,S:number} }}
 */
export function classifyBrowse(body = {}) {
  const title = String(body.title || '')
  const text = String(body.text || '')
  const query = String(body.query || '').trim()
  const all = title + '\n' + text
  const dwell = Number(body.dwell_ms) || 0
  const tags = []
  if (query) tags.push('self_issued')
  if (RE.people.test(all)) tags.push('people')
  if (RE.threat.test(all)) tags.push('threat')
  if (RE.answered.test(all)) tags.push('answered')
  // 深读：停够 60s 或正文够长，且真的在讲一个东西
  const deep = (dwell >= 60000 || text.length >= 1500) && (RE.deep.test(all) || text.length >= 1500)
  if (deep) tags.push('deep')
  const half = dwell > 0 && dwell < 3000 ? 0.5 : 1
  const weights = {
    E: +(PER_ITEM_CAP * half).toFixed(4), // 新领域在 ingest 里按去重结果再定
    C: deep ? +(0.01 * half).toFixed(4) : 0,
    R: RE.people.test(all) ? +(0.01 * half).toFixed(4) : 0,
    S: RE.threat.test(all) ? -+(0.01 * half).toFixed(4) : 0,
  }
  return { tags, weights }
}

function dayUsed(db, aid, sinceIso) {
  const used = { E: 0, C: 0, R: 0, S: 0 }
  try {
    const rows = db.prepare('SELECT weights FROM browse_items WHERE agent_id=? AND at>?').all(aid, sinceIso)
    for (const r of rows) {
      let w = {}
      try { w = JSON.parse(r.weights || '{}') } catch { w = {} }
      for (const k of Object.keys(used)) used[k] += Number(w[k]) || 0
    }
  } catch { /* 新库还没表 */ }
  return used
}

/**
 * 落一条浏览条目。
 * @param {object} body {url,title,text,query,channel,dwell_ms}
 */
export function ingestBrowse(db, aid, body = {}) {
  agent(db, aid)
  if (String(getParam(db, aid, 'drive.browse.ingest') || 'on') === 'off') {
    return { ok: true, skipped: 'disabled' }
  }
  const url = String(body.url || '').trim().slice(0, 800)
  const title = String(body.title || '').trim().slice(0, 300)
  const text = String(body.text || '').trim().slice(0, 8000)
  const query = String(body.query || '').trim().slice(0, 200)
  if (!url && !title && !text) err(400, 'INVALID_ARGUMENT', 'url / title / text 至少要有一个')
  const channel = ['browse', 'research', 'manual'].includes(String(body.channel)) ? String(body.channel) : 'browse'
  const domain = domainOf(url)

  // 限流：一小时硬顶，防一次 feed 把探索喂饱
  const hourAgo = new Date(Date.now() - 3600 * 1000).toISOString()
  const lastHour = Number(db.prepare('SELECT COUNT(*) n FROM browse_items WHERE agent_id=? AND at>?').get(aid, hourAgo).n || 0)
  if (lastHour >= MAX_PER_HOUR) err(429, 'RATE_LIMITED', '一小时最多记 ' + MAX_PER_HOUR + ' 条浏览，先消化一下')

  // 去重：同一 url 72h 内只记一次（重复刷同一页不该再喂一次需求）
  if (url) {
    const since = new Date(Date.now() - 72 * 3600 * 1000).toISOString()
    const dup = db.prepare('SELECT id, at FROM browse_items WHERE agent_id=? AND url=? AND at>? ORDER BY at DESC LIMIT 1').get(aid, url, since)
    if (dup) return { ok: true, dup: true, id: dup.id, at: dup.at }
  }

  const { tags, weights } = classifyBrowse({ title, text, query, dwell_ms: body.dwell_ms })
  // 新领域：这个 domain 近 7 天没出现过，才算「看到新东西」
  let newDomain = false
  if (domain) {
    const since = new Date(Date.now() - 7 * 86400 * 1000).toISOString()
    newDomain = !db.prepare('SELECT 1 AS x FROM browse_items WHERE agent_id=? AND domain=? AND at>? LIMIT 1').get(aid, domain, since)
  }
  if (newDomain) {
    tags.push('new_domain')
    if (!tags.includes('deep')) weights.E = PER_ITEM_CAP
    else weights.E = PER_ITEM_CAP
  } else {
    weights.E = 0
  }

  // 日封顶：今天已经用掉的量先从当条权重里扣掉，别让第 4 条把当天额度顶穿
  const today = now().slice(0, 10)
  const used = dayUsed(db, aid, today + 'T00:00:00')
  for (const k of Object.keys(weights)) {
    const cap = DAY_CAP[k] || 0
    const left = Math.max(0, cap - used[k])
    weights[k] = +(Math.sign(weights[k]) * Math.min(Math.abs(weights[k]), left)).toFixed(4)
  }

  const id = nid('bwi_')
  const at = now()
  db.prepare(`INSERT INTO browse_items(id,agent_id,url,domain,title,text,query,channel,dwell_ms,tags,weights,at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, aid, url || null, domain || null, title || null, text || null, query || null, channel,
    Math.max(0, Number(body.dwell_ms) || 0), JSON.stringify(tags), JSON.stringify(weights), at,
  )
  // 浏览也接性格：真读进去了（深读/新领域）→ 往 N 推一条；停留 <3s 的只算一点点。
  // 这里不 flush，等夜间统一结算，避免一次 feed 把轴顶飞。
  try {
    const deep = tags.includes('deep')
    const shallow = Number(body.dwell_ms || 0) > 0 && Number(body.dwell_ms || 0) < 3000
    if (deep || newDomain) {
      addEvidence(db, aid, {
        axis: 'sn', dir: 1,
        strength: deep ? 0.5 : 0.3,
        source: shallow ? 'browse_shallow' : 'browse',
        refId: id,
      })
    }
  } catch { /* 性格那条线失败不影响浏览本体 */ }
  return { ok: true, id, at, tags, weights, new_domain: newDomain, domain }
}

/** 近 N 天浏览概览，给 v3 的 browseNew 用（无条目时按 doc 取 0.5，别把「没数据」算成「没探索」）。 */
export function browseSummary(db, aid, days = 3) {
  const since = new Date(Date.now() - days * 86400 * 1000).toISOString()
  let total = 0
  let fresh = 0
  try {
    total = Number(db.prepare('SELECT COUNT(*) n FROM browse_items WHERE agent_id=? AND at>?').get(aid, since).n || 0)
    fresh = Number(db.prepare("SELECT COUNT(*) n FROM browse_items WHERE agent_id=? AND at>? AND tags LIKE '%new_domain%'").get(aid, since).n || 0)
  } catch { /* 新库还没表 */ }
  return {
    days,
    total,
    new_domain: fresh,
    // P3 之前这一项恒为 0.5；现在有数据就按「新领域比例」算，没数据仍退回 0.5
    browseNew: total ? clamp01(fresh / total) : 0.5,
  }
}

/** 列表（界面 tag 面板/调试用） */
export function listBrowse(db, aid, limit = 20) {
  agent(db, aid)
  return db.prepare('SELECT * FROM browse_items WHERE agent_id=? ORDER BY at DESC, rowid DESC LIMIT ?').all(aid, Math.max(1, Math.min(100, Number(limit) || 20)))
}
