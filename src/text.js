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
 * 从一条 user 消息里取出「人真正说的那句」。
 * 只有样板时返回 ''，调用方据此丢弃整条。
 */
export function cleanUserText(raw) {
  let s = String(raw || '')
  s = s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '')
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
