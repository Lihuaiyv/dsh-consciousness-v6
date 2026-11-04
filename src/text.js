/**
 * DSH 会把「运行环境说明」当成一条 user 消息塞进会话：
 *   Current runtime context … / Time sampled while preparing turn … / <system-reminder>…
 * 这既不是用户说的话，也不该进记忆。这里只做一件事：把它剥掉。
 */

const NOISE_LINE = [
  /^Current runtime context\./i,
  /^Current working directory:/i,
  /^Current DSH file policy:/i,
  /^Approval policy:/i,
  /^Approval prompts are disabled/i,
  // 宿主改配置时自己往会话里插的通报。带 "changed from" 的这种以前漏了，
  // 结果被当成用户原话存下来，还混进「上次你们聊到」里，开场就说一句英文。
  /^The approval policy changed/i,
  /^Approval policy changed/i,
  /^Current DeepSeek Harness implementation checkout:/i,
  /^Current DeepSeek Harness Web GUI URL:/i,
  /^Browser time zone for this request:/i,
  /^Elapsed since the preceding/i,
  /^Time sampled while preparing turn/i,
  /^This snapshot supersedes earlier/i,
  /^Tokens prefixed with @/i,
  // 宿主自己的进展通报 / 压缩摘要 / 子代理完工通知：都不是用户说的
  /^This is an automatically generated checkpoint/i,
  /^Background (?:subagent|job)\b/i,
  /^<compacted-summary>/i,
  /^<\/compacted-summary>/i,
  /^You are an AI agent powered by/i,
  /^You are a coding agent powered by/i,
  /^The following is a system reminder/i,
  /^Non-zero exits are reported/i,
  /^Track every background job/i,
]

/** 这一段是不是纯样板（没有任何人说的话）。 */
export function looksLikeRuntimeNoise(text) {
  const s = String(text || '')
  if (!s.trim()) return true
  const lines = s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  if (!lines.length) return true
  return lines.every((l) => NOISE_LINE.some((re) => re.test(l)))
}

/**
 * 宿主整条塞进来的机器消息：里面一句人话都不会有。
 *
 * 这类消息是「上下文快满了，把前面压成摘要再塞回来」，或者「后台任务跑完了」。
 * 它当轮必须留着（不然我就断片了），但它**不是用户说的话**——
 * 真正的原话早就在更早的 raw_turns 里躺着，摘要只是二手复述。
 * 以前剥不干净，摘要就被当成「用户亲口说过的事实」存进原话层，再被抽成记忆。
 */
const MACHINE_MESSAGE = /^\s*(?:This is an automatically generated checkpoint|Background (?:subagent|job)\b|<compacted-summary>|<goal_(?:round|complete)>)/i

/**
 * 只接受一句话：去引号、取首行、压长度、拦技术噪音和框架词。
 * 返回 null = 这句不能拿出去说（路径、凭据、代码块、SILENT 都算）。
 *
 * 原来住在 features.js 里（只给主动开口用）。挪到这里是因为「感受快照」也要回放原话——
 * 回放原话和主动开口是同一个底线：不能把盘符、URL、token 当成人话念出来。
 */
export function cleanLine(raw) {
  let s = String(raw || '').trim()
  s = s.replace(/^```(?:text)?/i, '').replace(/```$/, '').trim()
  if (!s || /^SILENT$/i.test(s)) return null
  s = s.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)[0] || ''
  s = s.replace(/^["'「『]+|["'」』]+$/g, '').trim()
  if (!s || /^[{[]/.test(s)) return null
  if (s.length > 80) s = s.slice(0, 79) + '…'
  if (/(https?:\/\/|\/v1\/|[A-Za-z]:\\|\.js\b|\.json\b|token|凭据|密码)/i.test(s)) return null
  return s
}

/**
 * 从一条 user 消息里取出「人真正说的那句」。
 * 只有样板时返回 ''，调用方据此丢弃整条。
 */
export function cleanUserText(raw) {
  let s = String(raw || '')
  // 整条机器消息：直接丢，连剥都不用剥。剥完剩下的也是摘要正文，照样是二手货。
  if (MACHINE_MESSAGE.test(s)) return ''
  s = s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '')
  // 夹在中间的压缩摘要块：整块拿走
  s = s.replace(/<compacted-summary>[\s\S]*?<\/compacted-summary>/gi, '')
  s = s
    .split(/\r?\n/)
    .filter((line) => {
      const t = line.trim()
      if (!t) return true
      return !NOISE_LINE.some((re) => re.test(t))
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (!s) return ''
  if (!/[\u4e00-\u9fa5a-zA-Z0-9]/.test(s)) return ''
  return s
}
