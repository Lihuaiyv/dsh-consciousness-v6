/**
 * 目的性自由浏览（研究搜集）。
 *
 * 和「打开一个网页」不一样：给一个题目和目的，它自己拆检索式、多轮搜、去重、
 * 抓正文、逐条抽主张、按来源可信度交叉印证，最后写成一份带引用的报告。
 *
 * 几条硬规矩：
 *   - 同一个 URL 在 seen 窗口内不再重复抓（research_seen 表）；重复跑到没新料时，
 *     会明确写「本轮没有新来源」，而不是把旧料当新发现。
 *   - 每个结论都必须能追到来源编号 [S#]；单来源结论会被标成「低置信」。
 *   - 来源分档（政府/学术/媒体/社区/未知）和最近程度都进分，不把知乎回答当论文。
 *   - 模型不可用时退化成「检索 + 摘要」模式，报告里会说明，不假装做过交叉验证。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { now } from '../../db.js'
import { nid } from '../../kernel.js'
import { canonicalUrl, hostOf, sha256, htmlToText, tokensOf, jaccard, mapLimit, parseJsonLoose, clamp } from './util.js'
import { scoreSource, scoreLabel, sourceTag, classifyDomain } from './credibility.js'

const DEPTHS = {
  quick: { rounds: 1, perRound: 3, perQuery: 6, fetch: 5, label: '快速' },
  standard: { rounds: 2, perRound: 5, perQuery: 8, fetch: 9, label: '标准' },
  deep: { rounds: 3, perRound: 6, perQuery: 10, fetch: 14, label: '深挖' },
}

const ASPECTS = ['现状', '原理', '数据', '案例', '风险', '最新进展', '对比', '实践方法', '争议', '成本']
const REFINE = ['最新', '报告 数据', '失败 教训', '教程 步骤', '对比 评测', '政策 监管', '案例 复盘', '专家 观点']

function researchDir() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'consciousness', 'research')
}

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(label + ' 超时（' + Math.round(ms / 1000) + 's）')), ms)
    promise.then((v) => { clearTimeout(t); resolve(v) }, (e) => { clearTimeout(t); reject(e) })
  })
}

function modelReady(model) {
  try { return !!model && model.status && model.status().primary === 'ok' } catch { return false }
}

async function askJson(model, system, user, maxTokens = 1200) {
  const raw = await model.chat([
    { role: 'system', content: system },
    { role: 'user', content: user },
  ], maxTokens, true, 0.2)
  return parseJsonLoose(raw)
}

function aspectQueries(topic, aspects, count, round) {
  const out = []
  const pool = (aspects && aspects.length ? aspects : ASPECTS)
  for (let i = 0; i < count; i++) {
    const a = pool[(round * count + i) % pool.length]
    const r = REFINE[(round * count + i) % REFINE.length]
    const q = (round === 0 && i < 2) ? topic : topic + ' ' + a + (round > 0 ? ' ' + r : '')
    out.push(q.replace(/\s+/g, ' ').trim())
  }
  return out
}

async function planQueries({ model, topic, goal, aspects, count }) {
  const fallback = aspectQueries(topic, aspects, count, 0)
  if (!modelReady(model)) return { queries: fallback, by: 'heuristic' }
  try {
    const out = await withTimeout(askJson(model,
      '你是检索策略助手。只输出 JSON，不要解释。',
      '主题：' + topic + '\n目的：' + (goal || '尽量全面、可信地了解这个主题') + '\n'
      + '请给出 ' + count + ' 条互补的中文检索式，覆盖：现状、关键数据、正反观点、最新进展、可执行方案。\n'
      + '要求：每条不超过 30 字；不要重复；不要都带同一个词。\n'
      + '输出：{"queries":["…","…"]}', 700), 45000, '检索规划')
    const list = out && Array.isArray(out.queries) ? out.queries.map((x) => String(x).trim()).filter(Boolean).slice(0, count) : []
    if (list.length >= Math.min(3, count)) return { queries: list, by: 'model' }
  } catch { /* 退回启发式 */ }
  return { queries: fallback, by: 'heuristic' }
}

function seenRecently(db, hash, days) {
  try {
    const r = db.prepare('SELECT last_seen FROM research_seen WHERE url_hash=?').get(hash)
    if (!r || !r.last_seen) return false
    return Date.now() - Date.parse(r.last_seen) < Math.max(1, days) * 86400000
  } catch { return false }
}

function markSeen(db, sources) {
  try {
    const stmt = db.prepare(`INSERT INTO research_seen(url_hash,url,domain,title,first_seen,last_seen,hits)
      VALUES(?,?,?,?,?,?,1)
      ON CONFLICT(url_hash) DO UPDATE SET last_seen=excluded.last_seen, hits=research_seen.hits+1, title=excluded.title`)
    for (const s of sources) {
      stmt.run(sha256(canonicalUrl(s.url)), s.url, hostOf(s.url), s.title || '', now(), now())
    }
  } catch { /* seen 写不进去不影响报告 */ }
}

function cleanSnippet(s) {
  return String(s || '').replace(/\s+/g, ' ').trim().slice(0, 400)
}

/** 一眼能看出的「这是卖东西的」：域名/路径像商店，或标题里全是促销词。 */
function commercialish(url, title) {
  const s = (String(url || '') + ' ' + String(title || '')).toLowerCase()
  return /(^|[/.])(shop|item|mall|buy|promo|discount|coupon|store)([/.]|$)/.test(s)
    || /优惠|折扣|购买|促销|推广|返利|团购|下单|秒杀/.test(s)
}

function currencyLabel(published) {
  const t = Date.parse(String(published || ''))
  if (!Number.isFinite(t)) return '无日期'
  const days = (Date.now() - t) / 86400000
  if (days <= 365) return '一年内'
  if (days <= 1095) return '三年内'
  return '较旧'
}

async function fetchText(web, url, signal) {
  const r = await withTimeout(web.fetch({ url }, signal), 25000, '抓取 ' + hostOf(url))
  if (!r) return null
  if (Number(r.statusCode) >= 400) return { ok: false, status: r.statusCode, text: '' }
  const body = r.body || {}
  const raw = String(body.content || '')
  const text = body.kind === 'html' ? htmlToText(raw, { max: 14000 }) : String(raw).slice(0, 14000)
  const title = body.kind === 'html' ? ((raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '') : ''
  return { ok: text.length >= 200, status: Number(r.statusCode) || 200, text, title: htmlToText(title, { max: 200 }) }
}

async function extractClaims(model, { topic, goal, source, text }) {
  const sys = '你是严谨的研究助手。只依据给定正文抽取可核验的说法，绝不补充正文里没有的信息。只输出 JSON。'
  const user = '研究主题：' + topic + '\n研究目的：' + (goal || '') + '\n'
    + '来源标题：' + (source.title || '') + '\n来源域名：' + hostOf(source.url) + '\n'
    + '正文（可能被截断）：\n' + text.slice(0, 6000) + '\n\n'
    + '请输出：{"summary":"3 句以内摘要","claims":[{"claim":"一条可核验的具体说法","quote":"正文中的原句（≤80字）","stance":"support|neutral|oppose","confidence":0到1}],"published":"YYYY-MM-DD 或空","author":"作者或机构，没有就空"}\n'
    + '要求：claims 最多 5 条，只留和主题相关的；数字、时间、结论优先；不要把广告词当事实。'
  const out = await withTimeout(askJson(model, sys, user, 900), 60000, '抽取 ' + hostOf(source.url))
  if (!out || !Array.isArray(out.claims)) return { summary: text.slice(0, 240), claims: [], published: '', author: '' }
  return {
    summary: cleanSnippet(out.summary).slice(0, 500),
    claims: out.claims
      .filter((c) => c && typeof c.claim === 'string' && c.claim.trim())
      .slice(0, 5)
      .map((c) => ({
        claim: c.claim.trim().slice(0, 200),
        quote: String(c.quote || '').trim().slice(0, 160),
        stance: ['support', 'neutral', 'oppose'].includes(c.stance) ? c.stance : 'neutral',
        self_confidence: clamp(Number(c.confidence) || 0.5, 0, 1),
      })),
    published: String(out.published || '').slice(0, 20),
    author: String(out.author || '').slice(0, 80),
  }
}

/** 把不同来源说的「同一件事」并成一簇。 */
function clusterClaims(claims) {
  const items = claims.map((c, i) => ({ ...c, idx: i, tokens: tokensOf(c.claim) }))
  const parent = items.map((_, i) => i)
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i] } return i }
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[rb] = ra }
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (items[i].sid === items[j].sid) continue
      if (jaccard(items[i].tokens, items[j].tokens) >= 0.42) union(i, j)
    }
  }
  const groups = new Map()
  for (let i = 0; i < items.length; i++) {
    const r = find(i)
    if (!groups.has(r)) groups.set(r, [])
    groups.get(r).push(items[i])
  }
  const out = []
  for (const g of groups.values()) {
    const sids = [...new Set(g.map((x) => x.sid))]
    const scores = g.map((x) => x.source_score)
    const best = Math.max(...scores)
    const n = sids.length
    // 同一簇里既有 support 又有 oppose：不是「印证」，是「打架」，要降置信并标出来
    const stances = new Set(g.map((x) => x.stance))
    const disputed = stances.has('support') && stances.has('oppose')
    let confidence = clamp(0.22 + 0.14 * (n - 1) + 0.28 * (best - 0.45), 0.05, 0.96)
    if (disputed) confidence = clamp(confidence - 0.12, 0.05, 0.96)
    const longest = g.slice().sort((a, b) => b.claim.length - a.claim.length)[0]
    out.push({
      claim: longest.claim,
      quote: longest.quote,
      sids,
      stance: longest.stance,
      disputed,
      sources: n,
      best_source_score: +best.toFixed(3),
      confidence: +confidence.toFixed(3),
      label: scoreLabel(confidence),
      self_confidence: +(g.reduce((s, x) => s + x.self_confidence, 0) / g.length).toFixed(2),
    })
  }
  return out.sort((a, b) => b.confidence - a.confidence)
}

function renderFallbackReport({ topic, goal, sources, clusters, stats, modelUsed }) {
  const lines = []
  lines.push('# ' + topic)
  if (goal) lines.push('> 目的：' + goal)
  lines.push('')
  lines.push('## 结论')
  if (stats.synth_error) {
    lines.push('（综述没生成：' + stats.synth_error + '。下面是按来源可信度和交叉印证整理的原始材料。）')
  } else if (!modelUsed) {
    lines.push('（模型不可用：本轮只做了检索、去重和抓取，没有做语义交叉验证。）')
  } else if (!clusters.length) {
    lines.push('（这轮没有抽到可归纳的说法，先按来源列材料。）')
  } else {
    lines.push('（这一轮没写成综述，下面是原始材料。）')
  }
  lines.push('')
  lines.push('## 关键说法（按置信度）')
  if (!clusters.length) lines.push('- 没有抽到可核验的说法；可以先看下面的来源摘要。')
  if (stats.extract_failed) {
    lines.push('- 注意：有 ' + stats.extract_failed + ' 个来源的模型抽取失败'
      + (stats.extract_error ? '（' + stats.extract_error + '）' : '') + '，这些来源只保留了摘要，没有进入交叉印证。')
  }
  for (const c of clusters.slice(0, 12)) {
    lines.push('- ' + c.claim + '（' + c.label + ' · ' + c.confidence.toFixed(2)
      + (c.disputed ? ' · 来源互相矛盾' : '') + ' · '
      + c.sids.map((i) => '[' + sourceTag(i) + ']').join('') + '）')
  }
  lines.push('')
  lines.push('## 来源')
  sources.forEach((s, i) => {
    lines.push('- [' + sourceTag(i) + '] ' + (s.title || s.url) + ' — ' + s.domain + ' · ' + s.tier_label + ' · 可信度 ' + s.score.toFixed(2) + ' · ' + s.url)
    if (s.summary) lines.push('  ' + s.summary)
  })
  lines.push('')
  lines.push('## 统计')
  lines.push('- 新来源 ' + stats.fetched + ' / 候选 ' + stats.found + '；跳过已读 ' + stats.seen_skipped
    + '；标题重复 ' + (stats.duplicate_titles || 0) + '；域名 ' + stats.domains + ' 个')
  if (stats.synth_error) lines.push('- 综述没生成：' + stats.synth_error)
  return lines.join('\n')
}

async function synthesize({ model, topic, goal, sources, clusters, stats, aspectList, maxTokens = 900 }) {
  if (!modelReady(model)) return null
  const srcLines = sources.map((s, i) => '[' + sourceTag(i) + '] ' + (s.title || '') + ' | ' + s.domain + ' | '
    + s.tier_label + (s.purpose === 'commercial' ? '（商业/推广）' : '')
    + ' | 可信度 ' + s.score.toFixed(2) + ' | ' + (s.published_at || '无日期') + ' | ' + s.url).join('\n')
  const claimLines = clusters.slice(0, 18).map((c, i) => 'C' + (i + 1) + ' ' + c.claim
    + ' | 支持来源 ' + c.sids.map((x) => '[' + sourceTag(x) + ']').join('')
    + ' | 置信度 ' + c.confidence.toFixed(2) + (c.disputed ? ' | 来源互相矛盾' : '')).join('\n')
  const sys = '你是研究主编。只依据给定来源写报告，不编造来源里没有的内容。引用一律用 [S1] 这种编号。'
  const user = '主题：' + topic + '\n目的：' + (goal || '全面、可信地了解这个主题') + '\n'
    + '关注角度：' + aspectList.join('、') + '\n\n'
    + '来源：\n' + srcLines + '\n\n'
    + '已交叉核对的说法：\n' + claimLines + '\n\n'
    + '请写中文 Markdown 报告，结构严格如下：\n'
    + '## 一句话结论\n（2 句以内，直接回答目的）\n'
    + '## 关键发现\n（5 条以内，每条末尾带 [S#]；按可信度排序；互相矛盾的要指出）\n'
    + '## 证据表\n（Markdown 表格：说法 | 支持来源 | 可信度 | 备注）\n'
    + '## 分歧与不确定\n（哪些说法只有单一来源、哪些来源互相打架、哪些问题没查到）\n'
    + '## 可行性评估\n（3 条以内可执行建议；每条写：前置条件 / 大概成本 / 预计时间 / 主要风险 / 可行性 高/中/低）\n'
    + '## 建议的下一步\n（还值得查什么、用什么检索式、需要什么一手数据）\n'
    + '## 来源\n（列 [S#] 标题 — 域名 — 可信度）\n\n'
    + '硬性要求：不要输出「根据我的知识」；没有来源支撑的判断必须写「推测」；'
    + '单来源结论在证据表备注里写「单一来源」；来源日期超过 3 年的注明「较旧」。'
  return withTimeout(model.chat([
    { role: 'system', content: sys },
    { role: 'user', content: user },
  ], maxTokens, false, 0.3), 180000, '报告生成')
}

/**
 * 跑一次研究。
 * @param {{db:any, agentId:string, topic:string, goal?:string, depth?:string, aspects?:string[],
 *          maxSources?:number, web:any, model?:any, signal?:AbortSignal, onStep?:Function}} opts
 */
export async function runResearch(opts) {
  const { db, agentId, topic, goal = '', aspects = [], maxSources, web, model, signal } = opts
  const onStep = typeof opts.onStep === 'function' ? opts.onStep : () => {}
  const t0 = Date.now()
  const cleanTopic = String(topic || '').trim()
  if (!cleanTopic) throw new Error('研究主题不能为空')
  if (!web || typeof web.search !== 'function' || typeof web.fetch !== 'function') {
    throw new Error('宿主没有提供 web 检索服务（web.search / web.fetch），自由浏览用不了')
  }
  const depthKey = DEPTHS[opts.depth] ? opts.depth : 'standard'
  const depth = DEPTHS[depthKey]
  const cap = Math.max(3, Math.min(24, Number(maxSources) || depth.fetch * 1.6 || 12))
  const cfg = safeConfig(db, agentId)
  const seenDays = Math.max(1, Number(cfg['research.seen_days']) || 60)
  const aspectList = (Array.isArray(aspects) && aspects.length ? aspects : ASPECTS).map(String).slice(0, 10)

  onStep({ phase: 'plan', message: '拆检索式' })
  const planned = await planQueries({ model, topic: cleanTopic, goal, aspects: aspectList, count: depth.rounds * depth.perRound })

  const runId = nid('rsr_')
  const found = new Map()
  const seenSkipped = { n: 0 }
  const queries = []
  let searchFailed = 0
  let searchError = ''
  let duplicateTitles = 0

  for (let round = 0; round < depth.rounds; round++) {
    const qs = planned.queries.slice(round * depth.perRound, (round + 1) * depth.perRound)
    if (!qs.length) break
    queries.push(...qs)
    onStep({ phase: 'search', message: '第 ' + (round + 1) + ' 轮检索（' + qs.length + ' 条）' })
    await mapLimit(qs, 3, async (query) => {
      try {
        const r = await withTimeout(web.search({ query, maxResults: depth.perQuery }, signal), 30000, '检索「' + query + '」')
        for (const s of (r && r.sources) || []) {
          if (!s || !/^https?:/i.test(String(s.url || ''))) continue
          const canon = canonicalUrl(s.url)
          const hash = sha256(canon)
          if (seenRecently(db, hash, seenDays)) { seenSkipped.n++; continue }
          if (found.has(hash)) continue
          // 同一篇文章在 www / m / 转载站会有不同 URL：标题几乎一样就當重复
          const titleTokens = tokensOf(String(s.title || ''))
          let dup = false
          for (const ex of found.values()) {
            if (jaccard(titleTokens, tokensOf(ex.title)) > 0.82) { dup = true; break }
          }
          if (dup) { duplicateTitles++; continue }
          found.set(hash, {
            url: s.url,
            canonical: canon,
            hash,
            title: String(s.title || '').slice(0, 200),
            snippet: cleanSnippet(s.snippet),
            published_at: s.publishedAt ? String(s.publishedAt).slice(0, 20) : '',
            query,
            ...scoreSource({ url: s.url, title: s.title, publishedAt: s.publishedAt }),
          })
        }
      } catch (e) {
        searchFailed++
        if (!searchError) searchError = String((e && e.message) || e).slice(0, 200)
      }
    })
  }

  // 检索全挂（常见于没有 agent 会话上下文的 HTTP 手动调用）：明确报错，不产出空报告
  if (!found.size && searchFailed && !seenSkipped.n) {
    throw new Error('检索全部失败：' + (searchError || 'web 检索不可用')
      + '。如果是手动在设置页触发，请在对话里让我调用 act_research（需要会话上下文）。')
  }

  // 域名配额 + 可信度排序
  const perDomain = new Map()
  const candidates = [...found.values()].sort((a, b) => b.score - a.score)
  const picked = []
  for (const c of candidates) {
    const n = perDomain.get(c.domain) || 0
    if (n >= 2) continue
    perDomain.set(c.domain, n + 1)
    picked.push(c)
    if (picked.length >= cap) break
  }

  // 全是看过的：允许少量回访，别让重复研究变成空报告
  let revisited = 0
  if (!picked.length) {
    const known = db.prepare('SELECT url,title,domain,last_seen FROM research_seen ORDER BY last_seen DESC LIMIT 6').all()
    for (const k of known) {
      picked.push({
        url: k.url, canonical: canonicalUrl(k.url), hash: sha256(canonicalUrl(k.url)),
        title: k.title || k.url, snippet: '', published_at: '',
        ...scoreSource({ url: k.url, title: k.title }), revisited: true,
      })
      revisited++
    }
  }

  onStep({ phase: 'fetch', message: '抓取 ' + picked.length + ' 个新来源' })
  const fetched = []
  await mapLimit(picked, 3, async (src) => {
    try {
      const r = await fetchText(web, src.url, signal)
      if (!r || !r.ok) return
      fetched.push({ ...src, text: r.text, title: r.title || src.title })
    } catch { /* 单页失败跳过 */ }
  })
  fetched.sort((a, b) => b.score - a.score)

  const sources = []
  const allClaims = []
  const modelUsed = modelReady(model)
  let extractFailed = 0
  let lastExtractError = ''
  for (let i = 0; i < fetched.length; i++) {
    const f = fetched[i]
    const sid = sources.length
    let ex = { summary: f.text.slice(0, 240), claims: [], published: '', author: '' }
    if (modelUsed) {
      onStep({ phase: 'extract', message: '读第 ' + (i + 1) + '/' + fetched.length + ' 个来源' })
      try {
        ex = await extractClaims(model, { topic: cleanTopic, goal, source: f, text: f.text })
      } catch (e) {
        // 抽取失败要留痕：不能把「没抽出来」当成「来源里没有说法」
        extractFailed++
        lastExtractError = String((e && e.message) || e).slice(0, 200)
      }
    }
    const published = f.published_at || ex.published || ''
    const rescored = scoreSource({ url: f.url, title: f.title, publishedAt: published })
    const purpose = commercialish(f.url, f.title) ? 'commercial' : 'informational'
    const relevance = +jaccard(tokensOf(cleanTopic), tokensOf((f.title || '') + ' ' + (f.snippet || f.text.slice(0, 300)))).toFixed(2)
    const baseScore = +(Math.max(f.score, rescored.score) - (purpose === 'commercial' ? 0.04 : 0)).toFixed(3)
    sources.push({
      sid,
      url: f.url,
      title: f.title,
      domain: f.domain,
      tier: rescored.tier,
      tier_label: rescored.tier_label,
      score: baseScore,
      label: scoreLabel(baseScore),
      published_at: published,
      purpose,
      relevance,
      // CRAAP 的五项里能自动判的四项：权威 / 时效 / 用途 / 相关；准确性等交叉印证后回填
      craap: {
        authority: rescored.tier_label,
        currency: currencyLabel(published),
        accuracy: '待印证',
        purpose: purpose === 'commercial' ? '商业/推广' : '信息',
        relevance,
      },
      summary: ex.summary,
      words: f.text.length,
      claims: ex.claims.length,
      revisited: !!f.revisited,
      query: f.query || '',
    })
    for (const c of ex.claims) {
      allClaims.push({ ...c, sid, source_score: sources[sid].score })
    }
  }

  const clusters = clusterClaims(allClaims)
  // 交叉印证后回填来源分（被更多来源复述的说法，来源本身也更可信一点）
  for (const c of clusters) {
    for (const s of c.sids) {
      const bonus = Math.min(0.08, (c.sids.length - 1) * 0.02)
      sources[s].score = +Math.min(0.98, sources[s].score + bonus).toFixed(3)
      sources[s].label = scoreLabel(sources[s].score)
      if (sources[s].craap) sources[s].craap.accuracy = c.sids.length >= 2 ? '多来源印证' : '单一来源'
    }
  }

  const stats = {
    found: found.size,
    fetched: sources.length,
    seen_skipped: seenSkipped.n,
    duplicate_titles: duplicateTitles,
    revisited,
    domains: new Set(sources.map((s) => s.domain)).size,
    claims: allClaims.length,
    clusters: clusters.length,
    disputed: clusters.filter((c) => c.disputed).length,
    high: clusters.filter((c) => c.confidence >= 0.7).length,
    low: clusters.filter((c) => c.confidence < 0.5).length,
    queries: queries.length,
    depth: depthKey,
    depth_label: depth.label,
    model: modelUsed ? 'on' : 'off',
    extract_failed: extractFailed,
    extract_error: lastExtractError,
    search_failed: searchFailed,
    search_error: searchError,
    plan_by: planned.by,
    ms: Date.now() - t0,
  }

  onStep({ phase: 'write', message: '写报告' })
  let report = null
  let synthError = ''
  if (modelUsed && clusters.length) {
    try {
      report = await synthesize({ model, topic: cleanTopic, goal, sources, clusters, stats, aspectList })
      if (!report || !String(report).trim()) throw new Error('模型返回了空报告')
    } catch (e) {
      synthError = String((e && e.message) || e).slice(0, 240)
      // 2200 token 有时会被路由拒；退一档再试一次，别直接掉回模板
      try {
        report = await synthesize({ model, topic: cleanTopic, goal, sources, clusters, stats, aspectList, maxTokens: 600 })
        if (!report || !String(report).trim()) report = null
      } catch (e2) {
        synthError += ' | retry: ' + String((e2 && e2.message) || e2).slice(0, 200)
        report = null
      }
    }
  }
  stats.synth_error = synthError
  if (!report) report = renderFallbackReport({ topic: cleanTopic, goal, sources, clusters, stats, modelUsed })
  report = String(report).trim()
  const header = '> 研究编号 ' + runId + ' · ' + depth.label + ' · ' + new Date(t0).toLocaleString('zh-CN')
    + ' · 来源 ' + sources.length + ' 个 · 耗时 ' + Math.round((Date.now() - t0) / 1000) + 's\n\n'
  if (!report.startsWith('#')) report = '# ' + cleanTopic + '\n\n' + report
  const full = header + report

  try {
    db.prepare(`INSERT INTO research_runs(id,agent_id,topic,goal,depth,report,sources,stats,status,created_at,finished_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
      runId, agentId, cleanTopic, goal, depthKey, full,
      JSON.stringify(sources), JSON.stringify(stats), 'ok', now(), now())
  } catch { /* 落库失败也把报告返回 */ }
  markSeen(db, sources)

  try {
    fs.mkdirSync(researchDir(), { recursive: true })
    fs.writeFileSync(path.join(researchDir(), runId + '.md'), full, 'utf8')
  } catch { /* 文件写失败不影响返回 */ }

  // 记一笔行动日志（和发消息共用一张表，界面里能看见）
  try {
    db.prepare('INSERT INTO action_log VALUES(?,?,?,?,?,?)').run(
      nid('act_'), agentId, 'research', JSON.stringify({ topic: cleanTopic, depth: depthKey, sources: sources.length, stats }),
      'ok', now())
  } catch { /* ignore */ }

  return {
    run_id: runId,
    topic: cleanTopic,
    goal,
    depth: depthKey,
    report: full,
    sources,
    claims: clusters.slice(0, 40),
    stats,
    file: path.join(researchDir(), runId + '.md'),
    at: new Date().toISOString(),
  }
}

function safeConfig(db, agentId) {
  try {
    // 避免和研究模块互相 import：这里直接读表
    const rows = db.prepare('SELECT key,value FROM action_config WHERE agent_id=?').all(agentId)
    const out = {}
    for (const r of rows) { try { out[r.key] = JSON.parse(r.value) } catch { /* skip */ } }
    return out
  } catch { return {} }
}

export function listRuns(db, agentId, limit = 20) {
  try {
    return db.prepare('SELECT id,topic,goal,depth,stats,status,created_at,finished_at FROM research_runs WHERE agent_id=? ORDER BY created_at DESC LIMIT ?')
      .all(agentId, Math.max(1, Math.min(100, Number(limit) || 20)))
  } catch { return [] }
}

export function getRun(db, agentId, id) {
  try {
    const r = db.prepare('SELECT * FROM research_runs WHERE agent_id=? AND id=?').get(agentId, String(id || ''))
    if (!r) return null
    return { ...r, sources: safeParse(r.sources, []), stats: safeParse(r.stats, {}) }
  } catch { return null }
}

function safeParse(s, fallback) {
  try { return JSON.parse(s) } catch { return fallback }
}

export { DEPTHS, classifyDomain }
