/**
 * 出声零件 · 考卷
 *
 * 管的是「一段字变成声音」：配置齐不齐、三条嗓子各发什么、回来的到底是不是音频。
 * 不管：该不该说、说什么、发给谁、record 段。
 *
 * 运行：node test/exam-mouth.test.mjs
 */
import { synthesizeVoice, checkTtsConfig } from '../src/parts/mouth/index.js'
import { buildAzureSsml, buildLocalTtsRequest, buildBreezeTtsRequest, buildBreezeDesignRequest, breezeDesignPreviews, breezeSaveDesignPreview } from '../src/parts/mouth/providers.js'
import { sniffAudioFormat } from '../src/parts/mouth/format.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 300)) }
}
const throwsWith = async (fn, needle) => {
  try { await fn(); return false } catch (error) { return String(error?.message ?? error).includes(needle) }
}

// ---------------------------------------------------------------- 造字节
const mp3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(200, 7)])
const html = Buffer.from('<!doctype html><html><body>502 Bad Gateway</body></html>', 'utf8')
const wav = (() => {
  const b = Buffer.alloc(44 + 64)
  b.write('RIFF', 0, 'ascii')
  b.writeUInt32LE(36 + 64, 4)
  b.write('WAVE', 8, 'ascii')
  b.write('fmt ', 12, 'ascii')
  b.writeUInt32LE(16, 16)
  b.writeUInt16LE(1, 20)
  b.writeUInt16LE(1, 22)
  b.writeUInt32LE(16000, 24)
  b.writeUInt32LE(32000, 28)
  b.writeUInt16LE(2, 32)
  b.writeUInt16LE(16, 34)
  b.write('data', 36, 'ascii')
  b.writeUInt32LE(64, 40)
  return b
})()

/** 假服务：记下这次请求，回一段字节。 */
function fakeFetch(body, { ok = true, status = 200 } = {}) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url: String(url), init })
    return {
      ok,
      status,
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
      text: async () => String(body),
      json: async () => { try { return JSON.parse(String(body)) } catch { return {} } },
    }
  }
  impl.calls = calls
  return impl
}

// ================================================================ 配置
{
  check('本机嗓子缺参考音频：明说缺什么', checkTtsConfig({ ttsProvider: 'local' })?.includes('参考音频') === true)
  check('云端嗓子缺密钥：明说缺什么', checkTtsConfig({ ttsProvider: 'azure' })?.includes('密钥') === true)
  check('不认识的嗓子：点出来，不硬猜', String(checkTtsConfig({ ttsProvider: 'nope' })).includes('nope'))
  check('配置齐了：放行', checkTtsConfig({ ttsProvider: 'local', ttsLocalRefAudio: 'a.wav' }) === null)

  check('空文本：半个字都不合成', await throwsWith(() => synthesizeVoice({ ttsProvider: 'compat', ttsBaseUrl: 'https://x.test/v1', ttsApiKey: 'k' }, '   '), '空的'))
  check('没密钥就报人话，而不是等 401', await throwsWith(() => synthesizeVoice({ ttsProvider: 'azure' }, '在的'), '没配密钥'))
  check('兼容接口没配地址：明说缺地址', await throwsWith(() => synthesizeVoice({ ttsProvider: 'compat', ttsApiKey: 'k' }, '在的'), '没配地址'))
}

// ================================================================ 微软
{
  const f = fakeFetch(mp3)
  const got = await synthesizeVoice({ ttsProvider: 'azure', ttsApiKey: 'k', ttsVoice: 'zh-CN-XiaoxiaoNeural', ttsStyle: 'cheerful' }, '  在的  ', { fetchImpl: f })
  check('微软：拿回 mp3', got.format === 'mp3' && got.audio.length > 0, got.format)
  check('微软：走的是它自己的地址', f.calls[0].url.includes('cognitiveservices') === true)
  const body = String(f.calls[0].init.body)
  check('微软：发的是 SSML，带音色和风格', body.includes('<speak') && body.includes('zh-CN-XiaoxiaoNeural') && body.includes('cheerful'))
  check('微软：文本首尾空白不念进去', body.includes('在的') && !body.includes('  在的'))

  const ssml = buildAzureSsml('A & B <tag> "引" \'单\'', 'v', '')
  check('SSML：& < > " \' 全部转义', ssml.includes('A &amp; B &lt;tag&gt; &quot;引&quot; &apos;单&apos;'), ssml)
}

// ================================================================ 兼容接口
{
  const f = fakeFetch(mp3)
  const got = await synthesizeVoice({ ttsProvider: 'compat', ttsApiKey: 'k', ttsBaseUrl: 'https://x.test/v1/', ttsModel: 'm1', ttsVoice: 'v1' }, '晚安', { fetchImpl: f })
  check('兼容接口：拿回 mp3', got.format === 'mp3')
  check('兼容接口：地址拼对（去掉多余的斜杠）', f.calls[0].url === 'https://x.test/v1/audio/speech', f.calls[0].url)
  const sent = JSON.parse(String(f.calls[0].init.body))
  check('兼容接口：model / voice / input 都在', sent.model === 'm1' && sent.voice === 'v1' && sent.input === '晚安', sent)
}

// ================================================================ 本机
{
  const f = fakeFetch(wav)
  const got = await synthesizeVoice({ ttsProvider: 'local', ttsLocalRefAudio: 'ref.wav', ttsLocalPromptText: '提示', ttsLocalUrl: 'http://127.0.0.1:9880' }, '哄你', { fetchImpl: f })
  check('本机：拿回 wav', got.format === 'wav' && sniffAudioFormat(got.audio) === 'wav')
  check('本机：去的是 /tts', f.calls[0].url === 'http://127.0.0.1:9880/tts', f.calls[0].url)
  const sent = JSON.parse(String(f.calls[0].init.body))
  check('本机：参考音频与提示文本都带上', sent.ref_audio_path === 'ref.wav' && sent.prompt_text === '提示', sent)
  check('本机：请求体有默认值，不缺字段', buildLocalTtsRequest({}, 'x').text_lang === 'zh' && buildLocalTtsRequest({}, 'x').media_type === 'wav')
}

// ================================================================ BreezeBlue
{
  check('BreezeBlue 缺密钥：明说缺什么', String(checkTtsConfig({ ttsProvider: 'breeze', ttsBreezeVoice: 'voc_x' })).includes('密钥'))
  check('BreezeBlue 缺音色 ID：明说缺什么', String(checkTtsConfig({ ttsProvider: 'breeze', ttsApiKey: 'k' })).includes('音色'))
  check('BreezeBlue 配齐了：放行', checkTtsConfig({ ttsProvider: 'breeze', ttsApiKey: 'k', ttsBreezeVoice: 'voc_x' }) === null)

  const f = fakeFetch(mp3)
  const got = await synthesizeVoice({
    ttsProvider: 'breeze', ttsApiKey: 'brz_k', ttsBreezeUrl: 'https://api.breeze.blue/',
    ttsBreezeVoice: 'voc_abc', ttsBreezeModel: 'breeze-tts-2', ttsBreezeInstructions: '轻一点',
  }, '晚安', { fetchImpl: f })
  check('BreezeBlue：拿回 mp3', got.format === 'mp3' && got.audio.length > 0, got.format)
  check('BreezeBlue：地址拼对（去多余斜杠）',
    f.calls[0].url.startsWith('https://api.breeze.blue/v1/text-to-speech/voc_abc'), f.calls[0].url)
  check('BreezeBlue：认证头是 xi-api-key', f.calls[0].init.headers['xi-api-key'] === 'brz_k', f.calls[0].init.headers)
  const sent = JSON.parse(String(f.calls[0].init.body))
  check('BreezeBlue：body 用它的字段名', sent.text === '晚安' && sent.model_id === 'breeze-tts-2' && sent.instructions === '轻一点', sent)
  check('BreezeBlue：语气说明留空就不发这个键', !('instructions' in buildBreezeTtsRequest({}, 'x')), buildBreezeTtsRequest({}, 'x'))
}

// ================================================================ BreezeBlue · 造嗓子
{
  /** 假服务：回一段 JSON，记下请求。 */
  const jsonFetch = (payload) => {
    const calls = []
    const impl = async (url, init) => {
      calls.push({ url: String(url), init })
      return {
        ok: true, status: 200,
        arrayBuffer: async () => new ArrayBuffer(0),
        text: async () => JSON.stringify(payload),
        json: async () => payload,
      }
    }
    impl.calls = calls
    return impl
  }
  const cfg = { ttsApiKey: 'brz_k', ttsBreezeUrl: 'https://api.breeze.blue' }

  check('设计：没给描述就问要什么声音', await throwsWith(() => Promise.resolve(buildBreezeDesignRequest({}, '  ')), '一句描述'))

  const f = jsonFetch({ previews: [{ generated_voice_id: 'gen_1' }, { generated_voice_id: 'gen_2' }], text: '试听台词' })
  const got = await breezeDesignPreviews(cfg, ' 清亮一点 ', { fetchImpl: f })
  check('设计：去 /v1/voice-previews/design', f.calls[0].url.startsWith('https://api.breeze.blue/v1/voice-previews/design'), f.calls[0].url)
  check('设计：认证头是 xi-api-key', f.calls[0].init.headers['xi-api-key'] === 'brz_k', f.calls[0].init.headers)
  const sent = JSON.parse(String(f.calls[0].init.body))
  check('设计：描述去空白、候选数默认 3', sent.voice_description === '清亮一点' && sent.preview_count === 3, sent)
  check('设计：回包里的候选和试听台词拿出来', got.previews.length === 2 && got.text === '试听台词', got)
  check('设计：回包没候选就不当成功', await throwsWith(() => breezeDesignPreviews(cfg, '清亮一点', { fetchImpl: jsonFetch({}) }), '没给候选'))

  const sf = jsonFetch({ voice_id: 'voc_new', voice_name: '小汐' })
  const saved = await breezeSaveDesignPreview(cfg, 'gen_1', { name: '小汐' }, { fetchImpl: sf })
  check('保存：去 …/voice-previews/gen_1/save', sf.calls[0].url === 'https://api.breeze.blue/v1/voice-previews/gen_1/save', sf.calls[0].url)
  const sbody = JSON.parse(String(sf.calls[0].init.body))
  check('保存：名字和语言都带上', sbody.voice_name === '小汐' && sbody.language_code === 'zh', sbody)
  check('保存：拿得到新的 voice_id', saved.voice_id === 'voc_new', saved)
  check('保存：回包没 voice_id 不假装成功', await throwsWith(() => breezeSaveDesignPreview(cfg, 'gen_1', {}, { fetchImpl: jsonFetch({}) }), '没有 voice_id'))
}

// ================================================================ 出事的时候
{
  check('服务 500：把状态码说出来', await throwsWith(
    () => synthesizeVoice({ ttsProvider: 'azure', ttsApiKey: 'k' }, '在', { fetchImpl: fakeFetch(html, { ok: false, status: 500 }) }), '500'))
  check('回来是错误页：不当成声音交出去', await throwsWith(
    () => synthesizeVoice({ ttsProvider: 'azure', ttsApiKey: 'k' }, '在', { fetchImpl: fakeFetch(html) }), '不是音频'))

  const got = await synthesizeVoice({ ttsProvider: 'azure', ttsApiKey: 'k' }, '在', { fetchImpl: fakeFetch(wav) })
  check('配置说 mp3 而回来是 wav：按字节说，不跟着配置撒谎', got.format === 'wav', got.format)
}

// ================================================================ 看字节
{
  check('看字节：wav 认得出', sniffAudioFormat(wav) === 'wav')
  check('看字节：mp3 认得出', sniffAudioFormat(mp3) === 'mp3')
  check('看字节：帧同步开头也认得出', sniffAudioFormat(Buffer.concat([Buffer.from([0xff, 0xfb]), Buffer.alloc(200)])) === 'mp3')
  check('看字节：HTML 不认（null）', sniffAudioFormat(html) === null)
  check('看字节：太短不认', sniffAudioFormat(Buffer.from('RIFF')) === null)
}

console.log('\n通过 ' + pass + ' / ' + (pass + fail))
if (fail) process.exitCode = 1
