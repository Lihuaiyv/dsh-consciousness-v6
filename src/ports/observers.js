// 观察源（Observer）：用户投喂和以后的自动调研产出同一种 Observation。
// 约束：必须有出处；自动来源要两条独立出处；永远只到草案，不自动批准。

const SOURCES = ['user-doc', 'research']

/** 校验一条观察，返回 { ok, errors } */
export function validateObservation(o) {
  const errors = []
  if (!o || typeof o !== 'object') return { ok: false, errors: ['not-object'] }
  if (!SOURCES.includes(o.source)) errors.push('source')
  if (!String(o.title || '').trim()) errors.push('title')
  const cit = o.citation || {}
  if (!cit.url && !cit.quote && !cit.doi) errors.push('citation')
  if (!Array.isArray(o.targets) || !o.targets.length) errors.push('targets')
  if (o.samples != null && !(Number.isFinite(Number(o.samples)) && Number(o.samples) > 0)) errors.push('samples')
  if (o.source === 'research') {
    const n = Array.isArray(o.citations) ? o.citations.length : (cit.url ? 1 : 0)
    if (n < 2) errors.push('research-needs-2-citations')
  }
  return { ok: errors.length === 0, errors }
}

/** 人工投喂 → Observation（旧接口兼容） */
export function manualObservation(body = {}) {
  const note = String(body.note || body.excerpt || '').slice(0, 500)
  return {
    source: 'user-doc',
    title: String(body.title || '').slice(0, 120),
    url: String(body.url || ''),
    excerpt: note,
    claim: String(body.claim || note),
    targets: [String(body.target || '')].filter(Boolean),
    confidence: 0.6,
    samples: Number.isFinite(Number(body.samples)) && Number(body.samples) > 0 ? Number(body.samples) : 1,
    actionable: true,
    citation: { url: String(body.url || ''), quote: note },
  }
}

/**
 * 自动调研观察源：占位。等有了搜索/浏览能力，实现为：
 *   搜索 → 读论文 → 提取机制 → 对照自身 → 产出 Observation[]
 * 现在返回空数组，不假装会调研。
 */
export function researchObserver() {
  return []
}

export const OBSERVER_SOURCES = SOURCES
