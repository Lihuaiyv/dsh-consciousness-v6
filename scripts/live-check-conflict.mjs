/**
 * 活库验证（第三步）：走插件真实 HTTP 接口，写两条对立的手动记忆，
 * 看它们是不是「先落 pending → 判官给结论 → 结案」，而不是当场开卡 + 排问句。
 *
 * 用法（插件重载后）：node scripts/live-check-conflict.mjs
 * 可配：DSHC_API（默认 http://127.0.0.1:49800/dsh-consciousness/api）、DSHC_AGENT（默认 agt_3977d80f17）
 */
const BASE = process.env.DSHC_API || 'http://127.0.0.1:49800/dsh-consciousness/api'
const AID = process.env.DSHC_AGENT || 'agt_3977d80f17'

async function call(method, path, body = {}) {
  const payload = { method, path, body: { ...body, __idempotencyKey: 'live-' + Math.random().toString(36).slice(2) + Date.now().toString(36) }, token: 'user' }
  const r = await fetch(BASE, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
  const j = await r.json()
  if (j && j.error) throw new Error(j.error.message || j.error.code)
  return j
}

const stamp = String(Date.now()).slice(-6)
const A = `联调：用户的生日是十月三日${stamp}`
const B = `联调：用户的生日不是十月三日${stamp}`

async function conflicts() { return call('GET', `/v1/agents/${AID}/conflicts`) }
const findPair = (rows) => rows.filter((c) => c.a && c.b && String(c.a.text).includes('十月三日') && String(c.b.text).includes('十月三日') && (String(c.a.text).includes(stamp) || String(c.b.text).includes(stamp)))

function fmt(c) {
  return `${c.state}${c.resolution ? '/' + c.resolution : ''}${c.reason ? ' · ' + String(c.reason).slice(0, 40) : ''}`
}

try {
  // 先清掉之前跑剩下的联调记忆，别把测试垃圾留在她库里
  try {
    const list = await call('GET', '/v1/agents/' + AID + '/memory')
    for (const m of (Array.isArray(list) ? list : [])) {
      if (String(m.text || '').includes('联调')) await call('DELETE', '/v1/agents/' + AID + '/memory/' + m.id)
    }
  } catch { /* 清不掉不影响本次验证 */ }
  const ping = await call('GET', '/v1/agents')
  console.error('接口通，agent 数：', Array.isArray(ping) ? ping.length : '?')
  const a = await call('POST', `/v1/agents/${AID}/memory`, { text: A, type: 'fact', importance: 0.9 })
  console.error('写第一条：', a.id)
  const b = await call('POST', `/v1/agents/${AID}/memory`, { text: B, type: 'fact', importance: 0.9 })
  console.error('写第二条：', b.id, 'conflict=', b.conflict, 'conflict_id=', b.conflict_id)
  if (a.id === b.id) { console.error('两条被合并成同一条（相似度太高），换文本再试'); process.exit(2) }

  let rows = []
  let seen = null
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2000))
    rows = await conflicts()
    const pair = findPair(rows)
    if (!pair.length) continue
    const c = pair[0]
    if (!seen) seen = c.state
    if (c.state !== 'pending') break
  }
  const pair = findPair(rows)
  const c = pair[0]
  if (!c) {
    console.log('\n结果：没找到这一对（可能没被判成冲突，或文本没写进去）')
    process.exit(1)
  }
  console.log('\n第一眼看到的状态：', seen)
  console.log('最终状态：', fmt(c))
  console.log('卡片条数：', pair.length)
  const asks = await call('GET', `/v1/agents/${AID}/proactive`)
  const mine = (asks.items || asks || []).filter((x) => String(x.text || '').includes(stamp))
  console.log('排给主人的问句：', mine.length)
  const ok = c.state !== 'open' && mine.length === 0
  console.log(ok ? '\n通过：没有当场开卡、没有排问句' : '\n不通过：还是开了卡或排了问句')
  try { await call('DELETE', '/v1/agents/' + AID + '/memory/' + a.id); await call('DELETE', '/v1/agents/' + AID + '/memory/' + b.id) } catch { /* 清理失败不影响结论 */ }
  process.exit(ok ? 0 : 1)
} catch (e) {
  console.error('失败：', e.message)
  process.exit(1)
}
