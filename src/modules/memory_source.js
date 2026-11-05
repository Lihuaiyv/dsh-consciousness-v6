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
/**
 * 没过闸门时到底卡在哪一类：'len' 太长/太短、'narration' 第三人称旁白、
 * 'head' 开头不像自己说的话、'no_me' 通篇没有「我」、'noise' 运行时残留。
 * 只记一个 false 分不出该改字数还是该改提示词——夜里那条自我日记连卡两晚就是这么摸黑的。
 */
export function selfTextWhy(text) {
  const t = String(text || '').trim()
  if (t.length < 6 || t.length > 120) return 'len'
  if (narrationOnly(t)) return 'narration'
  if (!SELF_HEAD.test(t)) return 'head'
  if (!t.includes('我')) return 'no_me'
  // 运行时噪音 / 转写残留
  if (/^(User|Assistant|user|assistant)\s*[:：]/.test(t)) return 'noise'
  if (/^\s*[\[{<]/.test(t)) return 'noise'
  if (/出错了|failed|Traceback|Error:/i.test(t)) return 'noise'
  return 'ok'
}
export function selfTextOk(text) {
  return selfTextWhy(text) === 'ok'
}

/**
 * P1.5 三档分类：ok 直接留；drop 明显不要；unsure 交模型判一句。
 *
 * 为什么不再要求「以我开头」：线上实测被内容闸挡下的八条里，「被用户一问，我心里有点发虚」
 * 「面板的冲突页面还没显示……」都算真事，只因为开头不是「我」就整条扔了。
 * 现在放宽成「含我就算 ok」；通篇没有「我」、又不明显是垃圾的，才叫模型判。
 * 超过 200 字的截到 200 再判，不整条丢——丢掉的话，那件事就真的没了。
 */
export function classifySelf(text) {
  const t = String(text || '').trim()
  if (!t) return { tier: 'drop', why: 'empty' }
  if (t.length < 6) return { tier: 'drop', why: 'short' }
  // 运行时残留：转写、代码块、报错堆栈——这类留着只是占地方，不进冷层。
  if (/^(User|Assistant|user|assistant)\s*[:：]/.test(t)) return { tier: 'drop', why: 'noise' }
  if (/^\s*[\[{<]/.test(t)) return { tier: 'drop', why: 'noise' }
  if (/出错了|failed|Traceback|Error:/i.test(t)) return { tier: 'drop', why: 'noise' }
  // 旁白：主语是对方。不丢，退冷层，深查仍能翻到。
  if (narrationOnly(t)) return { tier: 'drop', why: 'narration', cold: true }
  const body = t.length > 200 ? t.slice(0, 200) : t
  const long = t.length > 200
  if (body.includes('我')) return long ? { tier: 'ok', why: 'has_me_long', text: body } : { tier: 'ok', why: 'has_me' }
  return long ? { tier: 'unsure', why: 'long_no_me', text: body } : { tier: 'unsure', why: 'no_me' }
}

/** 一条「我自己」的事有多值得记住（0–1，规则分）。
 *  「想明白了什么 / 改了主意 / 情绪重 / 承诺」加分；「第几步、跑了什么测试」减分。
 *  模型的分只在需要时补进来（六成规则、四成模型），所以这里只做粗排，不做绝判。 */
const SELF_UP = /(想明白|意识到|发现|原来|决定|不再|改主意|接受|害怕|难受|难过|开心|安心|心里|答应|以后|下次|我好像|觉得|后悔|犹豫)/
const SELF_DOWN = /(跑|测试|提交|重启|部署|修好|通过|版本|commit|push|日志|接口|函数|页面|配置|脚本|文件|字段|表结构)/
export function scoreSelf(text) {
  const t = String(text || '').trim()
  if (!t) return 0
  let s = 0.4
  if (SELF_UP.test(t)) s += 0.25
  if (/(答应|以后|下次|不再|承诺|说好)/.test(t)) s += 0.1
  if (SELF_DOWN.test(t)) s -= 0.25
  if (/^(向|跟|对)(对方|主人|用户|他|她)/.test(t)) s -= 0.05
  if (t.length >= 24 && t.length <= 120) s += 0.05
  return Math.max(0, Math.min(1, Math.round(s * 100) / 100))
}

/** 从 payload / source_turn 拼一条人话溯源。 */
function sourceHint(row = {}) {
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
