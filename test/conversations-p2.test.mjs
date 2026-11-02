/**
 * P2：外部通道也用网页端那份意识体包（consciousnessBlock），并受预算截断。
 * 不需要真模型：直接测 buildReplySystem / clampContextBlock，再用 /v1/chat 验证
 * chatReply 真的把包取出来、并受 qq.prompt_budget 约束。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { handle } from '../src/api.js'
import { buildReplySystem } from '../src/model.js'
import { attachContextBlock, clampContextBlock } from '../src/features.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-p2-'))
let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) } else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail)) }
}

async function call(db, method, p, body = {}) {
  const req = { method, path: p, body: method === 'GET' ? body : { ...body, __idempotencyKey: 'k' + Math.random().toString(36).slice(2) }, token: 'user' }
  return handle(db, req)
}

// ① system 里真的带上了包，而且包在最前面（人设/关系优先）
// 有包的时候便签只写通道规矩，不把语气/情绪/需求再抄一遍（否则两处说法会打架）
{
  const sys = buildReplySystem({
    text: '在吗',
    pack: [{ text: '用户喜欢猫' }],
    style: { tone: '可爱', address: '主人' },
    affect: { label: 'calm', intensity: 0.5 },
    drive: { band: 'D1' },
    contextBlock: '【意识体：小汐】\n语气：可爱\n关系：主人 亲近 0.9\n日记：今天有点累',
  })
  check('包被拼进 system', sys.includes('【意识体：小汐】') && sys.includes('日记：今天有点累'), sys.slice(0, 120))
  check('包在最前面', sys.indexOf('【意识体：小汐】') < sys.indexOf('规则：按你自己的分寸说'), sys.slice(0, 60))
  check('有包时不重复语气/情绪/需求', !sys.includes('语气：可爱。') && !sys.includes('主情绪是') && !sys.includes('D1'), sys.slice(-200))
  check('通道规矩还在', sys.includes('按你自己的分寸说') && sys.includes('我可能记错'), sys.slice(-160))
  check('不再用字数命令管她', !sys.includes('不超过 4 句'), sys.slice(-160))
}

// ② 没有包时：退回精简提示，身份/语气/记忆都还在，不出现空上下文块
{
  const sys = buildReplySystem({
    text: '在吗',
    pack: [{ text: '用户喜欢猫' }],
    style: { tone: '可爱', address: '主人' },
    affect: { label: 'calm', intensity: 0.5 },
    drive: { band: 'D1' },
  })
  check('无包时身份与语气仍写', sys.includes('你就是这个意识体本人') && sys.includes('语气：可爱'), sys.slice(0, 120))
  check('无包时情绪/需求/记忆仍写', sys.includes('主情绪是') && sys.includes('D1') && sys.includes('用户喜欢猫'), sys.slice(-200))
  check('无包时不加空上下文块', !sys.includes('上下文结束'), sys.slice(0, 60))
}

// ③ 预算截断：保留开头，砍尾部，并留标记
{
  const long = 'A'.repeat(1000)
  const cut = clampContextBlock(long, 400)
  check('超预算被截断', cut.length <= 400, cut.length)
  check('保留开头', cut.startsWith('AAAAAAAAAA'), cut.slice(0, 20))
  check('留了截断标记', cut.endsWith('（上下文按预算截断）'), cut.slice(-20))
  check('不超预算时原样返回', clampContextBlock('短内容', 400) === '短内容')
  check('预算为 0 时不截断', clampContextBlock(long, 0) === long)
}

// ④ /v1/chat 真的取包，且按 qq.prompt_budget 截
{
  const { db } = await (async () => {
    const d = openDb(path.join(dir, 'p2.db'))
    const r = await call(d, 'POST', '/v1/agents', { name: '小测' })
    return { db: d, aid: r.body.id }
  })()
  const aid = db.prepare("SELECT id FROM agents WHERE name='小测'").get().id
  // 顺便验证：这一轮真召回的结果会被当成 opts.recall 传进包，包自己不再另找一份
  let seen = null
  attachContextBlock((d, id, opts) => { seen = opts; return '【包】' + 'X'.repeat(3000) })
  await call(db, 'PUT', '/v1/qq/settings', { default_agent: aid, prompt_budget: 600 })
  const out = await call(db, 'POST', '/v1/chat', {
    text: '你好', conversation_id: 'qq:p:3192248859',
    speaker: { channel: 'qq', handle: '3192248859' }, default_agent: aid,
  })
  check('回包带上下文长度', out.status === 200 && out.body.context_chars > 0, out.body.context_chars)
  check('按预算截到 600 附近', out.body.context_chars <= 620, out.body.context_chars)
  check('回包带上下文开头', String(out.body.context_head).startsWith('【包】'), out.body.context_head)
  check('这一轮召回传进了包（不重复查第二份）', seen && Array.isArray(seen.recall), seen)
  db.close()
}

// ⑤ 还原钩子，别污染后面的测试
attachContextBlock(null)

console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) { console.log('失败', fail); process.exit(1) }
