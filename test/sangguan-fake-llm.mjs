/**
 * 三观测试用假 LLM：按模板 id 回放夹具，全部离线。
 * fixtures[templateId] = 字符串 | 对象 | 数组（依次回放，用完重复最后一个）| (input, n) => 字符串或对象；抛错模拟调用失败。
 */
export function fakeChat(fixtures = {}) {
  const calls = []
  const seen = {}
  const chat = async (messages, maxTokens, json, temperature, meta = {}) => {
    const id = meta.template
    calls.push({ id, tier: meta.tier, messages, maxTokens, json, temperature, input: meta.input, repair: !!meta.repair })
    const n = (seen[id] = (seen[id] || 0) + 1)
    let f = fixtures[id]
    if (Array.isArray(f)) f = f[Math.min(n, f.length) - 1]
    if (typeof f === 'function') f = await f(meta.input, n, messages)
    if (f instanceof Error) throw f
    if (f === undefined) throw new Error('假 LLM 没有夹具：' + id)
    return typeof f === 'string' ? f : JSON.stringify(f)
  }
  chat.calls = calls
  chat.count = (id) => calls.filter((c) => !id || c.id === id).length
  return chat
}
