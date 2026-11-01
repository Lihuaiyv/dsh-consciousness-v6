/**
 * 三观独立模型端点：兼容 /chat/completions 的最小客户端（轻档可指向本地模型，费用为 0）。
 * 只在 config.model.light / heavy 配了 url 时使用；否则一律走宿主模型。
 */
const TIMEOUT_MS = 60000
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function httpError(message, status) {
  const err = new Error(message)
  if (status) err.status = status
  return err
}

// 429、5xx、断网重试一次；4xx 和返回体格式不对不重试
function retryable(err) {
  const s = err && err.status
  if (s === 429 || (s >= 500 && s <= 599)) return true
  return !s
}

async function once(ep, body) {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS)
  if (timer.unref) timer.unref()
  try {
    const res = await fetch(ep.url + '/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(ep.key ? { authorization: 'Bearer ' + ep.key } : {}) },
      body: JSON.stringify(body),
      signal: ctl.signal,
    })
    if (!res.ok) throw httpError('端点返回 ' + res.status, res.status)
    const data = await res.json()
    const text = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content
    if (typeof text !== 'string') throw httpError('端点返回格式不对', 200)
    return text
  } finally { clearTimeout(timer) }
}

export function endpointChat(ep) {
  return async (messages, maxTokens, json, temperature) => {
    const body = { model: ep.model || 'default', messages, max_tokens: maxTokens, temperature }
    if (json) body.response_format = { type: 'json_object' }
    try {
      return await once(ep, body)
    } catch (e) {
      if (!retryable(e)) throw e
      await sleep(400)
      return once(ep, body)
    }
  }
}
