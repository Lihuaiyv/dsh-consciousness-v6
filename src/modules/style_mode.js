/**
 * 说话模式与文体清单（P3）。
 *
 * 问题：说话质感只在**闲聊**时是对的。要是一直开着「不列点、不总结」，
 * 主人让我改代码时我就会写成小作文——那是灾难。所以先判这一轮是闲聊还是干活。
 *
 * 判定故意保守：**只有明确像干活才判 work**，剩下都当闲聊。
 * 判错了的代价不对称——闲聊里多列了个点只是不礼貌，干活里少了结构是没法用。
 *
 * 模式来源（参数 style.mode）：
 *   auto（默认）→ 看最近一句用户话的启发式
 *   chat / work → 强制
 */

import { cardLine } from './expression_state.js'

/** 干活信号：代码块、路径、命令、扩展名、技术词。 */
const WORK_SIGNALS = [
  /```/, // 代码块
  /[A-Za-z]:\\|\/[\w.-]+\/|\\[\w.-]+\\/, // Windows / POSIX 路径
  /\b(git|npm|pnpm|yarn|node|pwsh|bash|cd|ls|grep|curl)\b/i, // 命令
  /\.(m?js|ts|tsx|jsx|py|json|ya?ml|sql|db|md)\b/i, // 文件
  /(报错|编译|接口|函数|依赖|部署|数据库|日志|单元测试|回归|重构|实现|改一下|修一下|跑一遍)/, // 技术动作
  /\b(const|function|import|export|class|return|await)\b/, // 代码标识
]

/** 一句用户话 → 'work' | 'chat' */
export function detectMode(text) {
  const t = String(text || '')
  if (!t.trim()) return 'chat'
  for (const re of WORK_SIGNALS) if (re.test(t)) return 'work'
  return 'chat'
}

/** 模式解析：显式参数优先，auto 用缓存（最近一句判出来的）。 */
export function resolveMode(raw, cached) {
  const v = String(raw || 'auto').toLowerCase()
  if (v === 'chat' || v === 'work') return v
  return cached === 'work' ? 'work' : 'chat'
}

/**
 * 文体清单：只说「不要做什么」。
 * soft 三条最常见；strong 再加顺序词和小节标题。
 */
const SOFT = '不要列点，不要用「总之/以上就是」收尾，也不要说「希望这些对你有帮助」。'
const STRONG = SOFT + '不要「首先/其次/最后」，不要分小节标题，一段话说完就收。'

export function guardBlock(strength = 'soft') {
  const s = String(strength || 'soft').toLowerCase()
  if (s === 'off') return ''
  if (s === 'strong') return STRONG
  return SOFT
}

/**
 * 这一轮要注入的文体块。work 模式返回空数组——干活时不加任何文体约束。
 *
 * 以前返回两行（「这一轮怎么写」+ 清单）。现在「怎么写」那句并进了表达卡，
 * 由 index.js 用 cardLine 一次性注入，这里只留清单——少一条命令，多一条余地。
 * @param {{mode?:string, level?:string, guard?:string}} p
 */
export function styleInjection({ mode = 'chat', level = 'normal', guard = 'soft' } = {}) {
  if (mode !== 'chat') return []
  const g = guardBlock(guard)
  return g ? [g] : []
}

/** 与 expression_state.cardLine 同义（同一份文案，别在这里再抄一遍）。 */
export function styleText(level) {
  return cardLine({ level })
}
