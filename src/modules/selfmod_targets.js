// 自修改目标表：一行一个「可以数据化修改」的面。
// 新增模块要支持自修改 = 加一行 + 发一个信号事件，不用改核心逻辑。
import { resolveActiveArtifact, parsePayload } from './artifacts.js'

export const TARGETS = [
  {
    id: 'taxonomy.labels',
    label: '情绪分类表',
    changeClass: 'C2',
    field: 'taxonomy.labels',
    signal: 'affect.unlabeled',   // 什么样的现象算缺口
    threshold: 10,                // 攒够几条才起草
    windowDays: 7,                // 只看近几天
    cooldownDays: 30,             // 同一目标多久内不重复起草
    evidence: 'user-utterance',   // 证据来源
    apply: 'artifact:taxonomy',   // 批准后怎么生效
    base(db, aid) {               // 当前值（promote 时以它为底合并）
      const art = resolveActiveArtifact(db, aid, 'taxonomy')
      const p = art ? parsePayload(art) : null
      return p && Array.isArray(p.affect_labels) ? p.affect_labels.slice() : []
    },
  },
  {
    id: 'memory.inject.pool',
    label: '记忆注入池',
    changeClass: 'C4',
    field: 'memory.inject.pool',
    signal: 'memory.recall_miss',
    threshold: 20,
    windowDays: 7,
    cooldownDays: 30,
    evidence: 'user-utterance',
    apply: 'param',
    next(cur) { return Math.min(200, Math.round(cur * 1.1)) },
    base(db, aid) {
      try {
        const r = db.prepare("SELECT value FROM agent_params WHERE agent_id=? AND key='memory.inject.pool'").get(aid)
        return r && r.value != null ? Number(r.value) : 50
      } catch { return 50 }
    },
  },
  {
    id: 'recall.version',
    label: '召回算法版本',
    changeClass: 'C3',
    field: 'memory.recall.formula',
    signal: 'memory.recall_miss',
    threshold: 40,
    windowDays: 14,
    cooldownDays: 90,
    evidence: 'user-utterance',
    apply: 'binding',
    next(cur) { return String(cur) === 'v2b' ? 'v2' : 'v2b' },
    base(db, aid) {
      try {
        const r = db.prepare("SELECT value FROM agent_params WHERE agent_id=? AND key='memory.recall.formula'").get(aid)
        return r && r.value != null ? JSON.parse(r.value) : 'v2'
      } catch { return 'v2' }
    },
  },
  {
    id: 'structure.edge_weight',
    label: '结构边权重',
    changeClass: 'C1',
    field: 'structure.edges',
    signal: 'structure.edge_gap',
    threshold: 50,
    windowDays: 14,
    cooldownDays: 90,
    evidence: 'user-utterance',
    apply: 'artifact:structure',
    base(db, aid) {
      try {
        const art = resolveActiveArtifact(db, aid, 'structure')
        return art ? (parsePayload(art) || { edges: [] }) : { edges: [] }
      } catch { return { edges: [] } }
    },
  },
  {
    id: 'appraise.version',
    label: '情绪评价算法版本',
    changeClass: 'C3',
    field: 'affect.mapping',
    signal: 'acceptance.anomaly',
    threshold: 20,
    windowDays: 14,
    cooldownDays: 90,
    evidence: 'metric-snapshot',
    apply: 'binding',
    next(cur) { return String(cur) === 'v1b' ? 'v1' : 'v1b' },
    base(db, aid) {
      try {
        const r = db.prepare("SELECT value FROM agent_params WHERE agent_id=? AND key='affect.mapping'").get(aid)
        return r && r.value != null ? JSON.parse(r.value) : 'v1'
      } catch { return 'v1' }
    },
  },
  // 下一个目标照抄结构即可，例如：
  // { id: 'memory.inject.pool', label: '注入池大小', changeClass: 'C4', field: 'memory.inject.pool',
  //   signal: 'memory.recall_miss', threshold: 20, windowDays: 7, cooldownDays: 30,
  //   evidence: 'user-utterance', base: (db, aid) => 50 },
]

export function targetById(id) {
  return TARGETS.find((t) => t.id === id) || null
}

export const TARGET_IDS = TARGETS.map((t) => t.id)
