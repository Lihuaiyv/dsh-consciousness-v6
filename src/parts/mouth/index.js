// 出声（mouth）：一段字变成声音。
//
// 它管：文字进来 → 挑一条嗓子 → 拿回音频字节 → 看一眼真的是音频 → 交出去。
// 它不管：该不该说（那是主动开口）、说得对不对（说话分寸）、发给谁（发信）、
//        也不碰 QQ 的 record 段——它只交字节，怎么递是通道的事。
import { synthesizeTts } from './providers.js'
import { sniffAudioFormat } from './format.js'

/**
 * 配置齐不齐。没齐就说人话，别等请求发出去才报 401。
 * @param {object} config
 * @returns {string|null} 没问题回 null
 */
export function checkTtsConfig(config) {
  const c = config || {}
  const provider = c.ttsProvider || 'azure'
  // 系统自带嗓子（Windows SAPI）：不联网、不要 key，只要系统里装了语音。
  if (provider === 'system') return null
  // Edge 在线嗓子：不要 key，但要一个能跑 edge-tts 的 python。
  if (provider === 'edge') {
    if (!c.ttsEdgePython) return 'Edge 嗓子缺 python 路径（ttsEdgePython）'
    return null
  }
  if (provider === 'local') {
    if (!c.ttsLocalRefAudio) return '本机嗓子缺参考音频（ttsLocalRefAudio）：没它克隆不出声音'
    return null
  }
  if (provider === 'compat') {
    if (!c.ttsBaseUrl) return '这条嗓子没配地址（ttsBaseUrl）'
    if (!c.ttsApiKey) return '这条嗓子没配密钥（ttsApiKey）'
    return null
  }
  if (provider === 'breeze') {
    if (!c.ttsApiKey) return 'BreezeBlue 嗓子没配密钥（ttsApiKey）'
    if (!c.ttsBreezeVoice) return 'BreezeBlue 嗓子没配音色 ID（ttsBreezeVoice）：去控制台或音色页复制一个'
    return null
  }
  if (provider === 'azure') {
    if (!c.ttsApiKey) return '这条嗓子没配密钥（ttsApiKey）'
    return null
  }
  return `不认识的嗓子：${String(provider)}（只有 azure / compat / local / system / edge / breeze）`
}

/**
 * @param {object} config
 * @param {string} text
 * @param {{ fetchImpl?: Function }} [options]
 * @returns {Promise<{ audio: Buffer, format: 'mp3'|'wav' }>}
 */
export async function synthesizeVoice(config, text, { fetchImpl } = {}) {
  const line = String(text ?? '').trim()
  if (line === '') throw new Error('要念的内容是空的')
  const bad = checkTtsConfig(config)
  if (bad) throw new Error(bad)
  const result = await synthesizeTts(config, line, { fetchImpl })
  const audio = Buffer.isBuffer(result?.audio) ? result.audio : Buffer.alloc(0)
  const sniffed = sniffAudioFormat(audio)
  if (!sniffed) throw new Error('嗓子回的不是音频（多半是错误页），不敢交出去')
  // 以字节为准：配置说 mp3 而回来是 wav 时，按实际的说。
  return { audio, format: sniffed }
}
