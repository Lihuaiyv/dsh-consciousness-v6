/**
 * 状态机迁移表（logic-gates v3 §2.1 命题 status、§2.2 矛盾对 σ）。纯数据，fold 按表执行。
 * role 指向 payload 字段，或 poles（κ 两极）/ live_poles（κ 中仍为 contested 的极）/ sub（κ 的合题 c*）。
 * guard：belt = 只能落在保护带（核心不能被 RESOLVE / CON 证伪，P12）；core = 只能落在核心。
 */

export const CREATE_STATUS = Object.freeze({
  CLAIM_EXP: 'active', REV: 'active', CORE_ESTABLISH: 'active', ELEV_COMMIT: 'active', SUB_ACCEPT: 'provisional',
})

const POLES_BACK = [{ role: 'poles', from: ['contested'], to: 'active' }]
const SUB_FAIL = [...POLES_BACK, { role: 'sub', from: ['provisional'], to: 'withdrawn' }]

export const CLAIM_MOVES = Object.freeze({
  CLAIM_WITHDRAW: [{ role: 'claim_id', from: ['active'], to: 'withdrawn' }],
  REV: [{ role: 'old_id', from: ['active'], to: 'superseded', guard: 'belt' }],
  CON: [{ role: 'claim_id', from: ['active'], to: 'falsified', guard: 'belt' }],
  CORE_ESTABLISH: [{ role: 'from_id', from: ['active'], to: 'superseded', guard: 'belt' }],
  ELEV_COMMIT: [{ role: 'old_core_id', from: ['active'], to: 'demoted', guard: 'core' }],
  KAPPA_OPEN: [{ role: 'poles', from: ['active'], to: 'contested' }],
  REOPEN: [{ role: 'poles', from: ['active'], to: 'contested' }],
  SUSPEND: POLES_BACK,
  COEX: POLES_BACK,
  RESOLVE: [
    { role: 'winner_id', from: ['contested'], to: 'active' },
    { role: 'loser_id', from: ['contested'], to: 'falsified', guard: 'belt' },
  ],
  SUB_CONFIRM: [
    { role: 'poles', from: ['contested'], to: 'sublated' },
    { role: 'sub', from: ['provisional'], to: 'active' },
  ],
  SUB_ROLLBACK: SUB_FAIL,
  SUB_EXPIRE: SUB_FAIL,
  // 一极已被改写：κ 关闭，仍在交锋中的另一极放回 active
  KAPPA_OBSOLETE: [{ role: 'live_poles', from: ['contested'], to: 'active' }],
})

export const KAPPA_MOVES = Object.freeze({
  RESOLVE: { from: ['struggle'], to: 'resolved' },
  COEX: { from: ['struggle'], to: 'coexist' },
  SUSPEND: { from: ['struggle'], to: 'suspended' },
  SUB_ACCEPT: { from: ['struggle'], to: 'sub_trial' },
  SUB_CONFIRM: { from: ['sub_trial'], to: 'sublated' },
  SUB_ROLLBACK: { from: ['sub_trial'], to: 'suspended' },
  SUB_EXPIRE: { from: ['sub_trial'], to: 'suspended' },
  REOPEN: { from: ['suspended', 'coexist'], to: 'struggle' },
  KAPPA_OBSOLETE: { from: ['suspended', 'coexist', 'struggle'], to: 'resolved' },
})

export const KAPPA_CLOSED = Object.freeze(['resolved', 'sublated'])

// 只引用 κ、不迁移 σ 的事件：κ 必须存在且与事件同层
export const KAPPA_REFS = Object.freeze([
  'DELIBERATE', 'RESOLVE_CORE_BLOCKED', 'CORE_CLASH', 'TRADEOFF', 'SUB_REJECTED',
  'SUB_EXTEND', 'SUB_DORMANT',
])
