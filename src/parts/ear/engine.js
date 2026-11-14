// 听见 · 转规格与识别：两个外部世界的接口都在这一格。
//
//   1. ffmpeg（进程）——把任意音频转成 16k 单声道 PCM16 WAV；
//   2. DSH 的识别服务（宿主服务）——把那段 WAV 转成字。
//
// 两个都走注入：ffmpeg 用 `run`，识别服务用传进来的 `service`。
// 所以这个文件不 spawn、不拿全局状态，考卷能直接喂假数据。
import { execFile } from 'node:child_process'
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { canonicalizeWav, inspectWav } from './probe.js'

/** DSH 语音服务在宿主里的服务名（cordis service id）。 */
export const DSH_SPEECH_SERVICE = 'speechToText'

/** 默认语言：auto = 让识别自己判（中英混说也稳）。 */
export const DEFAULT_STT_LANGUAGE = 'auto'

/**
 * execFile 的 message 开头是整条命令，真正的原因在 stderr 最后一行。
 * 以前只留前 90 个字，日志里只剩 ffmpeg 路径，看不出为什么失败。
 */
function ffmpegFailText(error) {
  const stderr = String(error?.stderr ?? '').trim()
  const last = stderr.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).pop()
  const brief = last || String(error?.message ?? error).split(/\r?\n/)[0]
  return `ffmpeg 转 16kHz WAV 失败：${String(brief).slice(0, 180)}`
}

/** 默认的 ffmpeg 执行器（可注入，方便单测）。 */
function runFfmpeg(command, args, options) {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error) => (error ? reject(error) : resolve()))
  })
}

/**
 * 把任意音频转成 16 kHz 单声道 PCM16 WAV。
 * @param {object} options
 * @param {Buffer} options.buffer 原始音频
 * @param {string} [options.ext] 原始扩展名（决定临时文件名，ffmpeg 主要靠内容嗅探）
 * @param {string} [options.ffmpegPath]
 * @param {string} options.tmpDir 临时文件目录（必须已存在或可创建）
 * @param {Function} [options.run] 执行器（默认 execFile 的 Promise 包装）
 * @returns {Promise<Buffer>}
 */
export async function toWav16k({ buffer, ext = 'amr', ffmpegPath = 'ffmpeg', tmpDir, run = runFfmpeg }) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error('语音内容是空的，没法转写')
  mkdirSync(tmpDir, { recursive: true })
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const input = join(tmpDir, `ear-${stamp}.${String(ext || 'amr').replace(/[^a-z0-9]/gi, '') || 'amr'}`)
  const output = join(tmpDir, `ear-${stamp}.wav`)
  writeFileSync(input, buffer)
  try {
    // 关键：`-map_metadata -1` 与 `-fflags +bitexact` 都是**输出侧**选项，必须放在 `-i` 之后！
    // （2026-10-04 真机事故：放在 -i 前，ffmpeg 直接 Command failed —— 输入选项里没有它们。）
    await run(ffmpegPath, ['-y', '-i', input,
      '-map_metadata', '-1', '-fflags', '+bitexact',
      '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', output], { timeout: 60_000 })
    // 规范化失败（例如 ffmpeg 产物规格不对）也要用同一个前缀报出来，调用方/测试看的是这句。
    let wav
    try {
      wav = canonicalizeWav(readFileSync(output))
    } catch (error) {
      throw new Error(`转出来的音频不符合要求：${String(error?.message ?? error)}`)
    }
    const check = inspectWav(wav)
    if (!check.ok) throw new Error(`转出来的音频不符合要求：${check.reason}`)
    return wav
  } catch (error) {
    if (String(error?.message ?? '').includes('不符合要求')) throw error
    throw new Error(ffmpegFailText(error))
  } finally {
    try { unlinkSync(input) } catch { /* best effort */ }
    try { unlinkSync(output) } catch { /* best effort */ }
  }
}

/**
 * 用 DSH 自带的语音服务转写。
 * @param {object} options
 * @param {object|undefined} options.service 宿主服务（`ctx.get('speechToText')`）
 * @param {Buffer} options.wav 16 kHz 单声道 PCM16 WAV
 * @param {string} [options.language]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{ text: string, audioSeconds: number|null, inferenceSeconds: number|null }>}
 */
export async function transcribeViaDsh({ service, wav, language = DEFAULT_STT_LANGUAGE, signal }) {
  if (!service || typeof service.resolve !== 'function' || typeof service.transcribe !== 'function') {
    throw new Error('DSH 的语音转文字没启用：请把 @deepseek-ai/dsh-experimental-voice-input-bundle 加进 profile 的 bundles 并重启')
  }
  const check = inspectWav(wav)
  if (!check.ok) throw new Error(`音频不符合 DSH 语音服务的要求：${check.reason}`)
  const spec = service.resolve({ audio: new Uint8Array(wav), language })
  const transcript = await service.transcribe(spec, signal ?? AbortSignal.timeout(120_000))
  const text = String(transcript?.text ?? '').trim()
  if (text === '') throw new Error('DSH 语音服务返回了空文本（可能是录音太短或没人说话）')
  return {
    text,
    audioSeconds: Number.isFinite(transcript?.audioSeconds) ? transcript.audioSeconds : null,
    inferenceSeconds: Number.isFinite(transcript?.inferenceSeconds) ? transcript.inferenceSeconds : null,
  }
}

/** 把识别服务的异常翻译成主人看得懂的一句话。 */
export function explainDshError(error) {
  const message = String(error?.message ?? error)
  if (/download|prepare|preparation|model/i.test(message)) {
    return `首次使用要下载本地语音模型：${message.slice(0, 80)}`
  }
  if (/unavailable|not registered|unknown provider/i.test(message)) {
    return `DSH 里没有可用的本地识别提供方（检查 profile 是否装了 speech-to-text-sensevoice）：${message.slice(0, 60)}`
  }
  return `DSH 语音转文字失败：${message.slice(0, 90)}`
}
