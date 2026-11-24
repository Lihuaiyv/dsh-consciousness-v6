/**
 * 宿主调用的「想了多少」（2026-11-24 加）。
 *
 * 为什么要有这组用例：判断层判决只有一百多字节，却要 5~29 秒；怀疑时间全在思考上，
 * 但我们以前只数 text-delta，思考那块一个字都没记——「思考爆表」是推的，不是量的。
 * 现在适配器边收流边把思考字数 / token 用量 / 结束原因填进调用方给的 stats，
 * 报错里也带上同一份量。这组用例锁六件事：
 *   1. 思考字数、正文长度、用量、档位都收得到（成功也记）；
 *   2. 只有整块思考、没有逐字 delta 时也数得到；
 *   3. 思考吃光额度：抛 truncated，消息里带思考字数（不再只说「空」）；
 *   4. 模型没声明过的档不许硬塞（硬塞会被宿主直接拒）；
 *   5. 模型完全不声明档时，传了也不硬塞；
 *   6. 不传 stats / 不传档时行为跟以前一样（旧调用点不用改）。
 *
 * 一律走 completeStrict：普通 complete 会落到规则兜底（会返回一段假 JSON），
 * 那就看不见真正的报错，也测不到「空正文必须抛」。
 */
import assert from 'node:assert'
import { createModel, attachHostLlm } from '../src/model.js'

const pass = []
const fail = []
const ok = (name) => { pass.push(name); console.log('ok  ' + name) }
const bad = (name, e) => { fail.push(name); console.log('FAIL ' + name + ' :: ' + (e && e.message)) }
const t = async (name, fn) => { try { await fn(); ok(name) } catch (e) { bad(name, e) } }

/** 造一个假宿主：prepareCall 会调用 configure；模型声明了哪些档由 efforts 决定。 */
function fakeHost({ efforts = [{ id: 'low' }, { id: 'minimal' }], chunks = [] } = {}) {
  const seen = { cfgs: [], configs: [] }
  const llm = {
    stream: async function* () { /* available() 只检查它存在 */ },
    prepareCall: async (cfg, _signal, configure) => {
      seen.cfgs.push({ ...cfg })
      const info = { provider: cfg.provider, id: cfg.model, reasoning: efforts.length ? { efforts } : undefined }
      let controls = { ...cfg }
      if (typeof configure === 'function') controls = configure(controls, info) || controls
      // 真宿主会在这里校验：没声明的档直接拒（模拟 resolveCallConfig 的行为）
      if (controls.reasoningEffort) {
        const ids = (info.reasoning && info.reasoning.efforts ? info.reasoning.efforts : []).map((e) => String(e.id))
        if (!ids.includes(String(controls.reasoningEffort))) throw new Error('unsupported reasoning effort: ' + controls.reasoningEffort)
      }
      seen.configs.push({ ...controls })
      return {
        config: { ...controls },
        async *stream() { for (const c of chunks) yield c },
      }
    },
  }
  const ctx = {
    get: (n) => (n === 'llm' ? llm
      : n === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'p', model: 'm' }) } : null),
  }
  return { llm, ctx, seen }
}

const say = (o) => { attachHostLlm(() => o.ctx); return createModel() }

await t('思考字数 / 正文长度 / 用量 / 档位都收得到，正文照旧返回', async () => {
  const host = fakeHost({
    chunks: [
      { type: 'block-start', blockType: 'reasoning' },
      { type: 'reasoning-delta', text: '先把这句话拆一拆，' },
      { type: 'reasoning-delta', text: '再看看冲谁。' },   // 合计 15 字
      { type: 'block-start', blockType: 'text' },
      { type: 'text-delta', text: '{"fact":"测试"}' },      // 13 字
      { type: 'usage', usage: { inputTokens: 900, outputTokens: 120, reasoningTokens: 96 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ],
  })
  const m = say(host)
  const stats = {}
  const out = await m.completeStrict({ system: 's', text: 'u', maxTokens: 300, reasoningEffort: 'LOW', stats })
  assert.equal(out, '{"fact":"测试"}')
  assert.equal(stats.reasoningChars, 15)
  assert.equal(stats.outputChars, 13)
  assert.equal(stats.finish, 'stop')
  assert.equal(stats.effort, 'low', '档位要按模型声明的大小写回填（传 LOW 用 low）')
  assert.deepEqual(stats.usage, { inputTokens: 900, outputTokens: 120, reasoningTokens: 96 })
  assert.ok(stats.blocks.includes('reasoning') && stats.blocks.includes('text'), '收到哪些块要留一份')
  assert.ok(Number(stats.ms) >= 0)
})

await t('只有整块思考、没有逐字 delta 时也数得到', async () => {
  const host = fakeHost({
    chunks: [
      { type: 'block-end', block: { type: 'reasoning', text: '想了挺久的一段' } },
      { type: 'block-end', block: { type: 'text', text: '{"by":"other"}' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ],
  })
  const m = say(host)
  const stats = {}
  const out = await m.completeStrict({ system: 's', text: 'u', maxTokens: 300, stats })
  assert.equal(out, '{"by":"other"}')
  assert.equal(stats.reasoningChars, 7)
})

await t('思考吃光额度：抛 truncated，消息里带思考字数', async () => {
  const host = fakeHost({
    chunks: [
      { type: 'reasoning-delta', text: '想'.repeat(40) },
      { type: 'finish', reason: { kind: 'max-tokens' } },
    ],
  })
  const m = say(host)
  const stats = {}
  let err = null
  try { await m.completeStrict({ system: 's', text: 'u', maxTokens: 300, stats }) } catch (e) { err = e }
  assert.ok(err, '空正文必须抛，不许当成功')
  assert.match(String(err.message), /llm truncated/)
  assert.equal(err.truncated, true)
  assert.match(String(err.message), /思考 40 字/, '报错里要说清想了多少，别再让人猜')
  assert.equal(stats.reasoningChars, 40, '失败那次也要留下量')
})

await t('模型没声明的档不硬塞（会被宿主直接拒）', async () => {
  const host = fakeHost({
    efforts: [{ id: 'low' }],
    chunks: [{ type: 'text-delta', text: 'x' }, { type: 'finish', reason: { kind: 'stop' } }],
  })
  const m = say(host)
  const stats = {}
  const out = await m.completeStrict({ system: 's', text: 'u', maxTokens: 300, reasoningEffort: 'ultra', stats })
  assert.equal(out, 'x')
  assert.equal(host.seen.configs[0].reasoningEffort, undefined, '不认识的档不许出现在调用配置里')
  assert.equal(stats.effort, '', '没选上档就如实记空')
})

await t('模型完全不声明档时，传了也不硬塞', async () => {
  const host = fakeHost({
    efforts: [],
    chunks: [{ type: 'text-delta', text: 'y' }, { type: 'finish', reason: { kind: 'stop' } }],
  })
  const m = say(host)
  const out = await m.completeStrict({ system: 's', text: 'u', maxTokens: 300, reasoningEffort: 'low' })
  assert.equal(out, 'y')
  assert.equal(host.seen.configs[0].reasoningEffort, undefined)
})

await t('不传 stats / 不传档：跟以前一样（旧调用点不用改）', async () => {
  const host = fakeHost({ chunks: [{ type: 'text-delta', text: 'z' }, { type: 'finish', reason: { kind: 'stop' } }] })
  const m = say(host)
  const out = await m.completeStrict({ system: 's', text: 'u' })
  assert.equal(out, 'z')
  assert.equal(host.seen.configs[0].reasoningEffort, undefined)
  assert.equal(host.seen.cfgs[0].maxTokens, 500, '不传 maxTokens 时仍是老的 500')
})

await t('空正文且没说原因：抛 empty（消息里带思考字数与用量）', async () => {
  const host = fakeHost({
    chunks: [
      { type: 'reasoning-delta', text: '想了但没落字' },
      { type: 'usage', usage: { inputTokens: 10, outputTokens: 6, reasoningTokens: 6 } },
    ],
  })
  const m = say(host)
  let err = null
  try { await m.completeStrict({ system: 's', text: 'u', maxTokens: 300 }) } catch (e) { err = e }
  assert.ok(err, '空正文必须抛')
  assert.equal(err.empty, true)
  assert.match(String(err.message), /思考 6 字/)
  assert.match(String(err.message), /其中思考 6/)
})

console.log(`\n通过 ${pass.length} / ${pass.length + fail.length}`)
if (fail.length) { console.log('失败:', fail); process.exit(1) }
