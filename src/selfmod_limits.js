// 自修改门槛：属 C0（人可调，系统不得自改）。默认值可按实例用环境变量覆盖：
//   DSHC_LIMITS='{"evidence":{"C2":50}}'
// 覆盖是浅合并，只改你写到的键。

function deepMerge(base, extra) {
  if (!extra || typeof extra !== 'object') return base
  for (const [k, v] of Object.entries(extra)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') deepMerge(base[k], v)
    else base[k] = v
  }
  return base
}

export const LIMITS = deepMerge({
  // G5 证据样本量下限：越危险的结构改动要求越多
  evidence: { C1: 50, C2: 10, C3: 20, C4: 10 },
  // 影子轮数
  shadowRounds: { C1: 40, C2: 20, C3: 20 },
  // 影子未跑完的 TTL（天）
  shadowTtlDays: 14,
  // G4 同对象冷却（天）
  cooldownObjectDays: { C1: 180, C2: 90, C3: 14, C4: 14 },
  // G4 同维度冷却（天）；C4 的 6 小时按 0.25 天
  cooldownDimensionDays: { C1: 90, C2: 30, C3: 7, C4: 0.25 },
  // 回滚后的冻结与隔离
  rollback: { freezeDays: 14, quarantineCount: 2, quarantineWindowDays: 90, quarantineFreezeDays: 30 },
  // 观察期
  observation: { days: 14, rounds: 200 },
}, (() => {
  try {
    const raw = process.env.DSHC_LIMITS
    return raw ? JSON.parse(raw) : null
  } catch { return null }
})())

export function evidenceNeed(cls) {
  return Number(LIMITS.evidence[cls] ?? 20)
}

export function shadowRounds(cls) {
  return Number(LIMITS.shadowRounds[cls] ?? 20)
}

export function cooldownObjectDays(cls) {
  return Number(LIMITS.cooldownObjectDays[cls] ?? 14)
}
