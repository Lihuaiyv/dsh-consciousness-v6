/**
 * 语音服务 · 考卷
 *
 * 管的是「把耳朵嘴巴包成宿主服务」这一段：形状对不对、没装零件时说没说人话、
 * 宿主两代写法能不能挂上去。
 *
 * 运行：node test/voice-service.test.mjs
 */
import { createVoiceServices, VOICE_IN, VOICE_OUT } from '../src/voice_service.js'
import { createHost } from '../src/host/dsh.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 300)) }
}
const throwsWith = async (fn, needle) => {
  try { await fn(); return false } catch (e) { return String(e?.message ?? e).includes(needle) }
}

// ---------------------------------------------------------------- 形状
{
  const s = createVoiceServices()
  check('只出两个服务：听和说', Object.keys(s).sort().join(',') === [VOICE_IN, VOICE_OUT].sort().join(','), Object.keys(s))
  check('听有 transcribe', typeof s[VOICE_IN].transcribe === 'function')
  check('说有 speak', typeof s[VOICE_OUT].speak === 'function')
}

// ---------------------------------------------------------------- 没装零件要说人话
{
  const s = createVoiceServices()
  check('空音频：说「空的」', await throwsWith(() => s[VOICE_IN].transcribe({ audio: Buffer.alloc(0) }), '空的'))
  check('没有识别服务：说没装听见零件', await throwsWith(() => s[VOICE_IN].transcribe({ audio: Buffer.from('x') }), '没装听见零件'))
  const noConf = createVoiceServices()
  check('出声没配好：报人话，不静默', await throwsWith(() => noConf[VOICE_OUT].speak({ text: '你好' }), '没配'))
  check('出声空文本：说「空的」', await throwsWith(() => createVoiceServices({ getConfig: () => ({ ttsProvider: 'azure', ttsApiKey: 'k' }) })[VOICE_OUT].speak({ text: '  ' }), '空的'))
}

// ---------------------------------------------------------------- 桥上配好的配方可以直接拿来念
{
  let called = ''
  const fetchImpl = async (url) => {
    called = String(url)
    return { ok: true, arrayBuffer: async () => Buffer.from('ID3fake-mp3-bytes') }
  }
  const s = createVoiceServices()
  const out = await s[VOICE_OUT].speak({
    text: '在',
    config: { ttsProvider: 'openai', ttsApiKey: 'k', ttsBaseUrl: 'http://example.test/v1', ttsModel: 'tts-1', ttsVoice: 'alloy' },
    fetchImpl,
  })
  check('桥的 openai 配方改走 compat 地址', called === 'http://example.test/v1/audio/speech', called)
  check('交回来的是音频字节', Buffer.isBuffer(out.audio) && out.audio.length > 0, out)
}

// ---------------------------------------------------------------- 挂到宿主上
{
  // 新版 cordis：ctx.set
  const mounted = {}
  const host = createHost({ log: () => {} })
  const report = host.install({ set: (n, v) => { mounted[n] = v } }, { services: { [VOICE_IN]: { a: 1 } } })
  check('ctx.set 能挂上', mounted[VOICE_IN] && mounted[VOICE_IN].a === 1, mounted)
  check('报告里记成 ok', report.summary.includes('services=ok'), report.summary)
}

{
  // 旧版 cordis：ctx.set 挂了，退回 provide + 赋值
  const provided = []
  const ctx = {
    set: () => { throw new Error('新版才有') },
    provide: (n) => { provided.push(n) },
  }
  const host = createHost({ log: () => {} })
  host.install(ctx, { services: { [VOICE_OUT]: { b: 2 } } })
  check('ctx.set 不行时走 provide', provided.includes(VOICE_OUT) && ctx[VOICE_OUT] && ctx[VOICE_OUT].b === 2, { provided, ctxValue: ctx[VOICE_OUT] })
}

{
  // 两代都没有：记降级，但不能抛
  const host = createHost({ log: () => {} })
  const report = host.install({}, { services: { [VOICE_IN]: {} } })
  const seam = (report.seams || []).find((s) => s.seam === 'services')
  check('都没有时记一笔，不抛', seam && seam.level !== 'ok', seam)
  check('报告里有 services 这一项', report.summary.includes('services='), report.summary)
}

{
  // 没声明服务：这一项记 skipped，不记 absent/error（没声明 ≠ 声明了装不上）
  const host = createHost({ log: () => {} })
  const report = host.install({ set: () => {} }, {})
  const seam = (report.seams || []).find((s) => s.seam === 'services')
  check('没声明就不装：记 skipped', seam && seam.level === 'skipped', seam)
}

console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) { console.log('失败：', fail); process.exit(1) }
