/**
 * U5 · 来源徽章
 * extract / episode / consolidate / manual / update_history …
 */

export const SOURCE_BADGE = Object.freeze({
  extract: { label: '抽取', tone: 'extract' },
  episode: { label: '纪要', tone: 'episode' },
  consolidate: { label: '合并', tone: 'consolidate' },
  manual: { label: '手记', tone: 'manual' },
  remember: { label: '手记', tone: 'manual' },
  summary: { label: '摘要', tone: 'summary' },
  model: { label: '模型', tone: 'model' },
  update_history: { label: '旧版', tone: 'history' },
  ui: { label: '手记', tone: 'manual' },
})

export function sourceBadge(source) {
  const key = String(source || '').trim().toLowerCase() || 'manual'
  const hit = SOURCE_BADGE[key]
  if (hit) return { key, ...hit }
  return { key, label: key.slice(0, 8) || '其他', tone: 'other' }
}

/**
 * 第三人称旁白：主语是「用户 / 对方 / 助手」的转述句（P0）。
 *
 * 为什么单独判：摘要和抽取经常产出「用户正在推进…」「用户偏好…」「对话中没有…」，
 * 这种句子写进记忆库，久了「我记得的」全是「用户关心什么」，没有一条是我自己。
 * 判中不丢：它可能是真事实（名单、权限、截止时间），只是不该假装成「我记得的事」——
 * 落到冷层（temp_state='cold'），深查照样翻得到。
 */
const NARRATION = [
  /^(用户|对方|他|她|助手|对话)(正在|要求|偏好|已|只|想|关注|提到|询问|希望|表示|指出|确认|在)/,
  /^(用户|对方|助手)的(事实|偏好|情绪|需求|请求|意图)/,
  /对话中没有|未被明确表达|事实层面|从对话中可确认/,
]

export function narrationOnly(text) {
  const t = String(text || '').trim()
  if (!t) return false
  return NARRATION.some((re) => re.test(t))
}

/** 她自己的第一人称句子（P1）：主语是「我」，允许「今天 / 后来」这类时间词开头。
 *  不能只认「我」开头——夜里那条「今天我怎么过的」天然以「今天」起句。
 */
const SELF_HEAD = /^(我|今天|昨天|前天|今晚|今早|早上|上午|下午|晚上|后来|刚才|这几天|这阵子|最近)/
export function selfTextOk(text) {
  const t = String(text || '').trim()
  if (t.length < 6 || t.length > 120) return false
  if (narrationOnly(t)) return false
  if (!SELF_HEAD.test(t)) return false
  if (!t.includes('我')) return false
  // 运行时噪音 / 转写残留
  if (/^(User|Assistant|user|assistant)\s*[:：]/.test(t)) return false
  if (/^\s*[\[{<]/.test(t)) return false
  if (/出错了|failed|Traceback|Error:/i.test(t)) return false
  return true
}

/** 从 payload / source_turn 拼一条人话溯源。 */
export function sourceHint(row = {}) {
  const badge = sourceBadge(row.source)
  let episode = null
  try {
    const p = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload
    if (p && p.episode_id) episode = { id: p.episode_id, day: p.day, seg: p.seg }
  } catch { /* ignore */ }
  return {
    badge,
    episode,
    turn_id: row.source_turn_id || null,
  }
}
