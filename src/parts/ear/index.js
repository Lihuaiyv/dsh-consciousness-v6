// 听见（ear）：一段声音变成字。
//
// 它管：拿到音频字节 → 转成能识别的规格 → 交给识别服务 → 交出那行字。
// 它不管：这段字要不要信、要不要回、要不要记、是谁发的——那些是别的零件的事。
// 它也不存音频：转完就丢，只把字交出去。
//
// 入口只有一个：transcribeVoice。
import { toWav16k, transcribeViaDsh } from './engine.js'

/**
 * @param {object} options
 * @param {Buffer} options.buffer 原始音频（silk / amr / 任意规格 wav 都可能）
 * @param {string} [options.ext] 原始扩展名，只决定临时文件名；靠内容嗅探，不靠名字
 * @param {string} [options.ffmpegPath]
 * @param {string} options.tmpDir 临时目录（转完就删，不留音频）
 * @param {object} options.service DSH 宿主服务 speechToText
 * @param {string} [options.language] 默认「自动」
 * @param {AbortSignal} [options.signal]
 * @param {Function} [options.run] ffmpeg 执行器（考卷注入假的）
 * @returns {Promise<{ text: string, audioSeconds: number|null, inferenceSeconds: number|null, wavBytes: number }>}
 */
export async function transcribeVoice({ buffer, ext, ffmpegPath, tmpDir, service, language, signal, run } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error('语音内容是空的，没法转写')
  const wav = await toWav16k({ buffer, ext, ffmpegPath, tmpDir, run })
  const transcript = await transcribeViaDsh({ service, wav, language, signal })
  return { ...transcript, wavBytes: wav.length }
}
