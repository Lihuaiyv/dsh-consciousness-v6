// 驱动表：为什么现在要变。驱动 ≠ 目标；一个驱动可以指向一个目标，也可以只产生观察。
import { event, getFlag, setFlag } from '../kernel.js'
import { nudgeDeficit } from './drive.js'
export const DRIVERS = [
  {
    id: 'capability.gap',
    label: '能力缺口',
    type: 'capability',
    target: 'taxonomy.labels',
    dim: 'e',
    weight: 0.005,
    evaluate(db, aid) {
      const out = []
      try {
        const n = Number(db.prepare("SELECT COUNT(*) n FROM events WHERE agent_id=? AND type='affect.unlabeled' AND created_at>=?").get(aid, new Date(Date.now() - 7 * 86400000).toISOString()).n || 0)
        if (n) out.push({ driver: 'capability.gap', severity: n >= 10 ? 'high' : 'low', text: '近 7 天有 ' + n + ' 次认不出', target: 'taxonomy.labels' })
      } catch { /* ignore */ }
      return out
    },
  },
  {
    id: 'acceptance.anomaly',
    label: '验收指标异常',
    type: 'data',
    target: null,
    dim: 'c',
    weight: 0.01,
    evaluate(db, aid) {
      const out = []
      const avg = (key) => {
        try {
          const r = db.prepare("SELECT AVG(value) v FROM (SELECT value FROM metric_samples WHERE agent_id=? AND key=? ORDER BY sampled_at DESC LIMIT 20)").get(aid, key)
          return r && r.v != null ? Number(r.v) : null
        } catch { return null }
      }
      try {
        const k = Number(db.prepare("SELECT value FROM metric_samples WHERE agent_id=? AND key='affect.label_kappa' ORDER BY sampled_at DESC LIMIT 1").get(aid)?.value)
        if (Number.isFinite(k) && k < 0.6) {
          out.push({ driver: 'acceptance.anomaly', severity: 'high', text: '情绪 κ 只有 ' + k.toFixed(2) + '（门槛 0.60）', metric: 'affect.label_kappa', value: k })
          try {
            const last = db.prepare("SELECT created_at FROM events WHERE agent_id=? AND type='acceptance.anomaly' ORDER BY rowid DESC LIMIT 1").get(aid)
            if (!last || Date.now() - Date.parse(last.created_at) > 3600000) {
              event(db, aid, 'acceptance.anomaly', { metric: 'affect.label_kappa', value: k })
            }
          } catch { /* 记号失败不影响驱动 */ }
        }
        const hit = avg('memory.recall_hit')
        if (hit != null && hit < 0.7) out.push({ driver: 'acceptance.anomaly', severity: 'mid', text: '召回命中 ' + hit.toFixed(2) + '（门槛 0.70）', metric: 'memory.recall_hit', value: hit })
        const bad = Number(db.prepare('SELECT COUNT(*) n FROM metric_samples WHERE agent_id=? AND (value<0 OR value>1)').get(aid).n || 0)
        if (bad > 0) out.push({ driver: 'acceptance.anomaly', severity: 'high', text: '有 ' + bad + ' 条指标值越界（0-1 之外）' })
      } catch { /* 老库没有指标表 */ }
      return out
    },
  },
  {
    id: 'external.knowledge',
    label: '外部新知',
    type: 'knowledge',
    target: null,
    dim: 'e',
    weight: 0.005,
    evaluate(db, aid) {
      const out = []
      try {
        const rows = db.prepare(`SELECT id, target, gate_trace FROM proposals WHERE agent_id=? AND state='draft' AND (gate_trace LIKE '%user-doc%' OR gate_trace LIKE '%"source":"research"%') ORDER BY created_at DESC LIMIT 5`).all(aid)
        for (const r of rows) {
          let ev = {}
          try { ev = (JSON.parse(r.gate_trace || '[]')[0]) || {} } catch { ev = {} }
          out.push({ driver: 'external.knowledge', severity: 'low', text: '候选新知：' + (ev.title || r.id) + '（目标 ' + r.target + '）', target: r.target })
        }
      } catch { /* ignore */ }
      return out
    },
  },
]

export const DRIVER_IDS = DRIVERS.map((d) => d.id)

export function driverById(id) {
  return DRIVERS.find((d) => d.id === id) || null
}

/** 跑一遍所有驱动，返回观察到的异常 */
export function driverFindings(db, aid) {
  const out = []
  for (const d of DRIVERS) {
    try { out.push(...(d.evaluate(db, aid) || [])) } catch { /* 单驱动失败跳过 */ }
  }
  return out
}

/**
 * 驱动 → 驱力：发现问题就抬高对应缺口维度。
 * 每条驱动每小时最多推一次；high 严重度按 2 倍步幅。
 */
export function applyDriverToDrive(db, aid) {
  const findings = driverFindings(db, aid)
  const applied = []
  const seen = new Set()
  for (const f of findings) {
    if (seen.has(f.driver)) continue
    seen.add(f.driver)
    const drv = driverById(f.driver)
    if (!drv || !drv.dim) continue
    const key = 'driver.push:' + f.driver + ':' + aid
    try {
      const last = Number(getFlag(db, key) || 0)
      if (Date.now() - last < 3600000) continue
      const delta = Number(drv.weight || 0.005) * (f.severity === 'high' ? 2 : 1)
      const out = nudgeDeficit(db, aid, drv.dim, delta)
      if (out) {
        setFlag(db, key, String(Date.now()))
        applied.push({ driver: f.driver, dim: drv.dim, delta, from: out.from, to: out.to })
      }
    } catch { /* 单条失败跳过 */ }
  }
  return applied
}
