// 行动层的语音壳：把「听见」「出声」两个零件接到工具上。
//
// 这个文件只是壳：它不转码、不合成、不判断，只做三件事——
//   1. 把设置里的 voice.* 折成零件要的配置；
//   2. 递音频进去 / 把音频写到临时文件；
//   3. 需要出声时调本机播放。
// 真正的实现永远在 src/parts/ear 与 src/parts/mouth（5.1.2：别处不许再抄一份）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { getConfig } from './channels.js'
import { transcribeVoice } from '../../parts/ear/index.js'
import { synthesizeVoice } from '../../parts/mouth/index.js'

/** 设置里的 voice.* → 出声零件认的配置。字段名对齐旧桥，搬家不改配方。 */
export function voiceConfigOf(cfg = {}) {
  const pick = (k, d = '') => {
    const v = cfg[k]
    return v == null || v === '' ? d : String(v)
  }
  return {
    ttsProvider: pick('voice.provider', 'azure'),
    ttsApiKey: pick('voice.api_key'),
    ttsBaseUrl: pick('voice.base_url'),
    ttsModel: pick('voice.model'),
    ttsVoice: pick('voice.name'),
    ttsStyle: pick('voice.style'),
    ttsLocalUrl: pick('voice.local_url', 'http://127.0.0.1:9880'),
    ttsLocalRefAudio: pick('voice.local_ref'),
    ttsLocalPromptText: pick('voice.local_prompt'),
  }
}

function expand(file) {
  const s = String(file || '').trim()
  if (s === '~') return os.homedir()
  if (s.startsWith('~/') || s.startsWith('~\\')) return path.join(os.homedir(), s.slice(2))
  return s
}

/**
 * 听见：本地音频文件 → 文字。
 * @param {{ args?: object, getSpeech?: Function }} deps
 */
export async function executeHear({ args = {}, getSpeech } = {}) {
  const file = expand(args.path || args.file)
  if (!file) throw new Error('要听哪个文件？给我一个本地音频路径（wav / mp3 / amr 都行）')
  if (!fs.existsSync(file)) throw new Error('找不到这个文件：' + file)
  const buffer = fs.readFileSync(file)
  const service = typeof getSpeech === 'function' ? getSpeech() : null
  if (!service) {
    throw new Error('本机没有语音识别服务：设置 → 插件里启用「语音输入」那个实验包，再让我听')
  }
  const out = await transcribeVoice({
    buffer,
    ext: path.extname(file).replace('.', '') || 'amr',
    tmpDir: os.tmpdir(),
    service,
    language: args.language || 'auto',
  })
  return {
    ok: true,
    text: out.text,
    audio_seconds: out.audioSeconds,
    inference_seconds: out.inferenceSeconds,
    bytes: buffer.length,
    at: new Date().toISOString(),
  }
}

/** 本机播放：wav 走 SoundPlayer，别的交给系统默认程序。失败不算整个动作失败。 */
function playFile(file, format) {
  return new Promise((resolve) => {
    try {
      const ps = format === 'wav'
        ? `$p = New-Object Media.SoundPlayer '${file.replace(/'/g, "''")}'; $p.PlaySync()`
        : `Start-Process '${file.replace(/'/g, "''")}'`
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'ignore', windowsHide: true })
      child.on('error', (e) => resolve({ played: false, error: String(e && e.message || e) }))
      child.on('exit', (code) => resolve(code === 0 ? { played: true, error: '' } : { played: false, error: '播放器退出码 ' + code }))
    } catch (e) {
      resolve({ played: false, error: String(e && e.message || e) })
    }
  })
}

/**
 * 出声：文字 → 音频文件（可选直接播出来）。
 * @param {{ db: object, agentId: string, args?: object, fetchImpl?: Function }} deps
 */
export async function executeSay({ db, agentId, args = {}, fetchImpl } = {}) {
  const text = String(args.text || '').trim()
  if (!text) throw new Error('要念什么？给我一句话')
  if (text.length > 600) throw new Error('一口气念不了这么长（最多 600 字），分两段吧')
  const cfg = db && agentId ? getConfig(db, agentId) : {}
  const out = await synthesizeVoice(voiceConfigOf(cfg), text, { fetchImpl })
  const file = path.join(os.tmpdir(), 'dsh-voice-' + Date.now().toString(36) + '.' + out.format)
  fs.writeFileSync(file, out.audio)
  const wantPlay = args.play === undefined ? cfg['voice.play'] !== false : !!args.play
  const playResult = wantPlay ? await playFile(file, out.format) : { played: false, error: '' }
  return {
    ok: true,
    file,
    format: out.format,
    bytes: out.audio.length,
    text,
    played: playResult.played,
    play_error: playResult.error || '',
    at: new Date().toISOString(),
  }
}
