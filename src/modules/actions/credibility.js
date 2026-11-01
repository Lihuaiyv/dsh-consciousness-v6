/**
 * 来源可信度：先按域名分档，再按「有没有日期 / 是不是 https / 有多少来源互相印证」加减。
 *
 * 这不是学术意义上的 fact-check，只是把「一眼能看出的来源差异」显式化：
 * 政府/学术 > 官方媒体/技术文档 > 百科/参考 > 社区/自媒体 > 未知。
 * 模型在写报告时要同时给出「结论 + 依据来源 + 置信度」，别把 0.4 的来源说成定论。
 */
import { hostOf } from './util.js'

const RULES = [
  { id: 'official', label: '政府/公共机构', base: 0.92, re: /(^|\.)(gov\.cn|gov|mil|go\.jp|go\.kr|gov\.uk|gc\.ca|europa\.eu)$/i },
  { id: 'official', label: '国际组织', base: 0.9, re: /(^|\.)(who\.int|un\.org|worldbank\.org|oecd\.org|imf\.org|wto\.org)$/i },
  { id: 'academic', label: '学术/论文', base: 0.9, re: /(^|\.)(arxiv\.org|doi\.org|pubmed\.ncbi\.nlm\.nih\.gov|nature\.com|science\.org|sciencedirect\.com|springer\.com|ieee\.org|acm\.org|ssrn\.com|cnki\.net|wanfangdata\.com\.cn|jstor\.org|cell\.com)$/i },
  { id: 'academic', label: '高校', base: 0.86, re: /(^|\.)(edu\.cn|edu|ac\.uk|ac\.jp|edu\.hk|edu\.tw)$/i },
  { id: 'media', label: '官方/主流媒体', base: 0.78, re: /(^|\.)(xinhuanet\.com|news\.cn|people\.com\.cn|cctv\.com|chinadaily\.com\.cn|thepaper\.cn|caixin\.com|yicai\.com|reuters\.com|apnews\.com|bbc\.com|ft\.com|bloomberg\.com|nytimes\.com|wsj\.com|economist\.com|theguardian\.com|cnfin\.com|cei\.cn|cyol\.com|gmw\.cn|stcn\.com|cnstock\.com|21jingji\.com)$/i },
  { id: 'docs', label: '技术文档/代码', base: 0.8, re: /(^|\.)(developer\.mozilla\.org|docs\.python\.org|nodejs\.org|w3\.org|ietf\.org|rfc-editor\.org|github\.com|gitlab\.com|stackoverflow\.com|learn\.microsoft\.com|docs\.aws\.amazon\.com|kubernetes\.io)$/i },
  { id: 'reference', label: '百科/参考', base: 0.7, re: /(^|\.)(wikipedia\.org|britannica\.com|baike\.baidu\.com|wikiwand\.com)$/i },
  { id: 'industry', label: '行业媒体/研究', base: 0.66, re: /(^|\.)(36kr\.com|huxiu\.com|jiqizhixin\.com|infoq\.cn|qbitai\.com|leiphone\.com|tmtpost\.com|statista\.com|gartner\.com|mckinsey\.com|deloitte\.com|pwc\.com)$/i },
  { id: 'community', label: '社区/自媒体', base: 0.45, re: /(^|\.)(zhihu\.com|weibo\.com|bilibili\.com|xiaohongshu\.com|douban\.com|tieba\.baidu\.com|reddit\.com|quora\.com|medium\.com|substack\.com|csdn\.net|juejin\.cn|v2ex\.com|jianshu\.com|sohu\.com|163\.com|qq\.com|sina\.com\.cn|toutiao\.com)$/i },
  { id: 'low', label: '聚合/低质', base: 0.3, re: /(^|\.)(pinterest\.|facebook\.com|instagram\.com|tiktok\.com|douyin\.com|snapchat\.com|tumblr\.com)$/i },
]

const UNKNOWN = { id: 'unknown', label: '未知来源', base: 0.48 }

export function classifyDomain(domain) {
  const d = String(domain || '').toLowerCase()
  if (!d) return UNKNOWN
  for (const r of RULES) if (r.re.test(d)) return { id: r.id, label: r.label, base: r.base }
  return UNKNOWN
}

export function scoreLabel(score) {
  const s = Number(score) || 0
  if (s >= 0.8) return '高'
  if (s >= 0.6) return '中'
  if (s >= 0.4) return '偏低'
  return '低'
}

/**
 * @param {{url:string,title?:string,publishedAt?:string}} source
 * @param {{now?:number,corroboration?:number}} [opts] corroboration = 有多少独立来源支持同一说法
 */
export function scoreSource(source, opts = {}) {
  const now = Number(opts.now) || Date.now()
  const url = String((source && source.url) || '')
  const domain = hostOf(url)
  const tier = classifyDomain(domain)
  let s = tier.base
  if (/^https:/i.test(url)) s += 0.02
  const t = Date.parse(String((source && source.publishedAt) || ''))
  if (Number.isFinite(t)) {
    const days = (now - t) / 86400000
    if (days <= 90) s += 0.06
    else if (days <= 365) s += 0.04
    else if (days <= 1095) s += 0.01
    else s -= 0.05
  }
  if (String((source && source.title) || '').length >= 8) s += 0.01
  const corroboration = Math.max(0, Number(opts.corroboration) || 0)
  s += Math.min(0.12, corroboration * 0.04)
  s = Math.max(0.05, Math.min(0.98, s))
  return {
    score: +s.toFixed(3),
    label: scoreLabel(s),
    tier: tier.id,
    tier_label: tier.label,
    domain,
  }
}

/** 报告里统一用「来源编号」引用，别把长 URL 塞进正文。 */
export function sourceTag(index) {
  return 'S' + (Number(index) + 1)
}
