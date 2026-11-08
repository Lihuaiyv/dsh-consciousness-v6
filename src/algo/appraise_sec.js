/**
 * 评价的第二组检查：应对潜力（coping）与规范意义（norm）。
 *
 * 为什么加（2026-11-07）：
 *   原来的评价只有五个字段（相关性 / 一致性 / 施事 / 确定性 / 新奇），
 *   八类标签里全是低唤醒的——没有怒、怕、羞、委屈。所以「被砸中」永远只能落到「有点烦」。
 *   按 Scherer 的 SEC，还差两组检查：
 *     · 应对潜力：这件事我控不控制得住 —— 分开「怒」和「怕」
 *     · 规范意义：这合不合我的准则     —— 分开「生气」和「委屈」，以及「羞」
 *
 * 这个模块只做映射，不写库、不改强度。默认不进主链路（appraise 侧用参数 affect.appraise.sec 控制），
 * 先跑影子：看得见分得出来，再谈要不要接。
 */

/** 四类高唤醒 + 原有几类。命名跟主链路保持一致（英文小写）。 */
export const SEC_LABELS = ['anger', 'fear', 'shame', 'hurt', 'joy', 'curious', 'calm', 'frustrated']

const clamp01 = (x) => Math.max(0, Math.min(1, Number(x) || 0))
const clamp11 = (x) => Math.max(-1, Math.min(1, Number(x) || 0))

/**
 * 从一次评价里读出一个更细的标签。
 *
 * @param {object} p
 * @param {number} [p.coping] 0 = 完全控不住，1 = 完全控得住
 * @param {number} [p.norm]   -1 = 违反我的准则，+1 = 合我的准则
 * @param {number} [p.cong]   goal_congruence（-1 挡住 … +1 满足）
 * @param {number} [p.rel]    goal_relevance
 * @param {'self'|'other'} [p.agency] 谁干的
 * @param {number} [p.cert]   确定性
 */
export function secLabel({ coping = null, norm = null, cong = 0, rel = 0.5, agency = 'other', cert = 0.8 } = {}) {
  const c = clamp11(cong)
  const r = clamp01(rel)

  // 完全无关：谈不上情绪
  if (r < 0.05) return 'calm'

  // 挡住了我的目标
  if (c < -0.2) {
    // 自己干的、又不合我的准则 → 羞
    const n = norm == null ? 0 : clamp11(norm)
    if (agency === 'self' && n < -0.1) return 'shame'
    // 别人干的、违反我的准则 → 怒（控得住）或委屈（控不太住）
    if (n < -0.1) {
      if (coping == null) return 'hurt'
      return clamp01(coping) >= 0.55 ? 'anger' : 'hurt'
    }
    // 没有准则信息、也没有应对潜力：分不出来就说分不出来，别拿「挫败」凑
    if (coping == null) return null
    if (clamp01(coping) <= 0.3) return 'fear'
    if (clamp01(coping) >= 0.7) return 'anger'
    return 'frustrated'
  }

  // 满足了我的目标
  if (c > 0.2) {
    const n = norm == null ? 0 : clamp11(norm)
    if (n < -0.1 && agency === 'self') return 'shame'
    return 'joy'
  }

  // 中间地带：不确定 / 新奇 → 好奇；其余真的分不出来
  if (clamp01(cert) < 0.5) return 'curious'
  return null
}

/** 这四类是不是「只靠新增的两个字段才分得出来」——影子对照用。 */
export function isHighArousal(label) {
  return label === 'anger' || label === 'fear' || label === 'shame' || label === 'hurt'
}
