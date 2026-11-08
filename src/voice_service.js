// 语音服务：把「耳朵」「嘴巴」两个零件，包成宿主上别的插件能拿到的两个服务。
//
//   voiceIn.transcribe({ audio, ext, language }) → { text, audioSeconds, shape, shapeWords }
//   voiceOut.speak({ text })                     → { audio, format }
//
// 为什么要有这一层：QQ 桥那边原来自己抄了 stt.js / tts.js 两份实现，跨包 import
// 会破坏单向依赖（INV10）。接缝只能是**宿主服务**——桥只认名字，不认我们的文件路径。
//
// 这个文件是宿主装配，按术语表不立零件，只写进 host 域的 entry。
// 它不转码、不合成本身做判断：那些永远在 src/parts/ear 与 src/parts/mouth。
import os from 'node:os'
import { transcribeVoice } from './parts/ear/index.js'
import { describeShape } from './parts/ear/acoustics.js'
import { synthesizeVoice } from './parts/mouth/index.js'
import { voiceConfigOf } from './modules/actions/voice.js'

export const VOICE_IN = 'voiceIn'
export const VOICE_OUT = 'voiceOut'

/**
 * 造两个服务对象。依赖全部注入，这个函数自己不去 ctx 上摸东西。
 * @param {object} options
 * @param {() => object|null} [options.getSpeech] 宿主的 speechToText 服务
 * @param {() => object} [options.getConfig] 出声用的 voice.* 配置
 * @param {string} [options.tmpDir]
 * @returns {{ voiceIn: object, voiceOut: object }}
 */
export function createVoiceServices({ getSpeech, getConfig, tmpDir = os.tmpdir() } = {}) {
  return {
    [VOICE_IN]: {
      /**
       * 一段声音 → 字，外加「怎么说」。
       * 音频转完就丢，不落盘；这里也不碰库，不记基线（那是意识体自己的事）。
       */
      async transcribe(input = {}) {
        const raw = input && input.audio
        const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw || [])
        if (!buffer.length) throw new Error('语音内容是空的，没法转写')
        const service = typeof getSpeech === 'function' ? getSpeech() : null
        if (!service) throw new Error('没装听见零件：本机没有 speechToText 服务')
        const out = await transcribeVoice({
          buffer,
          ext: String((input && input.ext) || 'webm').replace(/^\./, ''),
          tmpDir,
          service,
          language: (input && input.language) || 'auto',
        })
        return {
          text: out.text,
          audioSeconds: out.audioSeconds,
          shape: out.shape || null,
          shapeWords: describeShape(out.shape, out.text),
        }
      },
    },
    [VOICE_OUT]: {
      /**
       * 一句话 → 音频字节。只交字节，怎么递是通道自己的事（QQ 要 silk 就自己转）。
       * 配置不齐这里就报人话，别等请求发出去才 401。
       */
      async speak(input = {}) {
        const cfg = typeof getConfig === 'function' ? getConfig() : {}
        const out = await synthesizeVoice(voiceConfigOf(cfg), input && input.text)
        return { audio: out.audio, format: out.format }
      },
    },
  }
}
