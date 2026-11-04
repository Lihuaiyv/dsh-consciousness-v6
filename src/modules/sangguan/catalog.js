/**
 * 三观引擎 · 常量目录（logic-gates v3 §1、master-plan §5）。
 * 纯数据，无副作用；ledger / fold / gates 共用。
 */

export const LAYERS = Object.freeze(['W', 'L', 'V'])
export const ACTORS = Object.freeze(['sys', 'judge', 'user'])
export const ORIGINS = Object.freeze(['extract', 'seed', 'synth', 'elev', 'user', 'probe', 'abduce'])

// Core(ℓ) 只有一种；其余为该层保护带 Belt(ℓ)
export const CORE_KIND = Object.freeze({ W: 'core', L: 'telos', V: 'principle' })
export const BELT_KINDS = Object.freeze({ W: ['belt', 'obs'], L: ['chapter', 'role'], V: ['norm', 'ideal', 'commit'] })
export const isCoreKind = (layer, kind) => CORE_KIND[layer] === kind
export const kindOk = (layer, kind) => isCoreKind(layer, kind) || (BELT_KINDS[layer] || []).includes(kind)

export const TERMINAL = Object.freeze(['superseded', 'falsified', 'sublated', 'demoted', 'withdrawn'])
export const isTerminal = (status) => TERMINAL.includes(status)
// 未结 κ：两极必须都不在终态（P21）；其中 struggle / sub_trial 占用两极（I4）
export const SIGMA_OPEN = Object.freeze(['struggle', 'sub_trial', 'suspended', 'coexist'])
export const SIGMA_LOCK = Object.freeze(['struggle', 'sub_trial'])

export const NU_OUTCOMES = Object.freeze(['hit', 'miss', 'void'])
export const EVIDENCE_KINDS = Object.freeze(['act', 'verdict', 'check', 'invest'])
export const EDGE_TYPES = Object.freeze(['DEPENDS', 'CONSTRAINS', 'PRESSURE', 'CITES', 'DERIVES'])
export const BRANCHES = Object.freeze(['RESOLVE', 'SUB', 'COEX', 'SUSPEND'])

/**
 * 事件目录。layer：须带层；need：payload 必填字段；job：须带幂等键；
 * slots：可携带的不可变实体及条数（数字 = 恰好 n 条，'+' = 至少 1 条，[a,b] = 区间）。
 * 未列在 slots 里的实体一律不许带。
 */
export const EVENTS = Object.freeze({
  // 写入
  CLAIM_EXP: { layer: true, slots: { claims: 1 } },
  // 用户撤回尚未被占用的种子。终态 withdrawn；不是删除。
  CLAIM_WITHDRAW: { layer: true, need: ['claim_id'] },
  // 收回已经长出证据的保护带命题（例如从已下线仪表种进来的旧句）。终态 withdrawn；核心只能走升维。
  CLAIM_RETIRE: { layer: true, need: ['claim_id'] },
  DUP: { layer: true, need: ['claim_id'] },
  REV: { layer: true, slots: { claims: 1 }, need: ['old_id'] },
  CON: { layer: true, need: ['claim_id'] },
  REJECT: {},
  CORE_ESTABLISH: { layer: true, slots: { claims: 1 }, need: ['from_id'] },
  // 违背：回复踩了它自己认下的命题（P2）。只减 π，不改状态
  VIOLATE: { layer: true, need: ['claim_id'] },
  FLIP: { layer: true, need: ['claim_id'] },
  // 矛盾
  KAPPA_CANDIDATE: { layer: true, need: ['a_id', 'b_id'] },
  KAPPA_OPEN: { layer: true, slots: { kappas: 1, questions: [0, 1] } },
  KAPPA_QUEUED: { layer: true },
  REOPEN: { layer: true, need: ['kappa_id'] },
  KAPPA_OBSOLETE: { layer: true, need: ['kappa_id'] },
  PENDING_JUDGE: {},
  // 裁决
  DELIBERATE: { layer: true, need: ['kappa_id', 'branch'] },
  RESOLVE: { layer: true, need: ['kappa_id', 'winner_id', 'loser_id'] },
  RESOLVE_CORE_BLOCKED: { layer: true, need: ['kappa_id'] },
  CORE_CLASH: { layer: true, need: ['kappa_id'] },
  COEX: { layer: true, need: ['kappa_id', 'loss'] },
  TRADEOFF: { layer: true, need: ['kappa_id', 'lean_pole'] },
  SUSPEND: { layer: true, need: ['kappa_id'] },
  REPAIR_FAILED: { layer: true },
  // 扬弃
  SUB_REJECTED: { layer: true, need: ['kappa_id'] },
  SUB_ACCEPT: { layer: true, slots: { claims: 1 }, need: ['kappa_id'] },
  SUB_CONFIRM: { layer: true, need: ['kappa_id'] },
  SUB_ROLLBACK: { layer: true, need: ['kappa_id'] },
  SUB_EXTEND: { layer: true, need: ['kappa_id'] },
  SUB_DORMANT: { layer: true, need: ['kappa_id'] },
  SUB_EXPIRE: { layer: true, need: ['kappa_id'] },
  // 实践
  NU_REGISTER: { slots: { nus: '+' } },
  EVIDENCE: { slots: { evidence: '+' } },
  NU_RESOLVE: { need: ['nu_id', 'outcome'] },
  // 纲领
  DEGEN_CHECK: { layer: true },
  ELEV_PROPOSE: { layer: true },
  ELEV_REJECTED: { layer: true, need: ['proposal_id'] },
  // E2 / E3 不通过或起草失败：保持退化，记下当时的 m / 修订数，有新输入才重试
  ELEV_FAILED: { layer: true },
  ELEV_COMMIT: { layer: true, slots: { claims: 1 }, need: ['old_core_id', 'scope'] },
  // 结构
  EDGE_PROPOSE: {},
  EDGE_ADD: { slots: { edges: '+' } },
  EDGE_RETIRE: { need: ['edge_id'] },
  REVIEW_FLAG: { need: ['claim_id'] },
  // 活性
  INQUIRY: {},
  THETA_ADJUST: { need: ['key', 'value'] },
  // L2 自传摘要（J16）：只是派生的说法，fold 不读
  SUMMARY_BUILD: { slots: { summaries: 1 } },
  // 运维
  JOB_DONE: { job: true },
})

export const ENTITY_SLOTS = Object.freeze(['claims', 'questions', 'kappas', 'nus', 'evidence', 'edges', 'summaries'])
// 实体 id 前缀：读日志时一眼认出是什么
export const ID_PREFIX = Object.freeze({ claims: 'cl_', questions: 'q_', kappas: 'k_', nus: 'nu_', evidence: 'x_', edges: 'ed_', summaries: 'sm_' })
