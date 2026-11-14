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
import { describeShape } from '../../parts/ear/acoustics.js'
import { applyBaseline, describeDrift } from '../voice_baseline.js'
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
    ttsLocalDuration: pick('voice.local_duration'),
    ttsLocalEmoVector: pick('voice.local_emo'),
    ttsLocalEmoAlpha: pick('voice.local_emo_alpha'),
    ttsEdgePython: pick('voice.edge_python'),
    ttsEdgeDir: pick('voice.edge_dir'),
    ttsRate: pick('voice.rate'),
    ttsPitch: pick('voice.pitch'),
    ttsBreezeUrl: pick('voice.breeze_url', 'https://api.breeze.blue'),
    ttsBreezeVoice: pick('voice.breeze_voice'),
    ttsBreezeModel: pick('voice.breeze_model', 'breeze-tts-2'),
    ttsBreezeInstructions: pick('voice.breeze_instructions'),
  }
}

function expand(file) {
  const s = String(file || '').trim()
  if (s === '~') return os.homedir()
  if (s.startsWith('~/') || s.startsWith('~\\')) return path.join(os.homedir(), s.slice(2))
  return s
}

/**
 * 听见：本地音频文件或上传字节 → 文字。
 * @param {{ args?: object, getSpeech?: Function, db?: object, agentId?: string }} deps
 *   args.path / args.file —— 本地路径；
 *   args.audio_base64 + args.format —— 浏览器录音上传（webm / wav / mp3 / ogg）。
 *   db + agentId —— 给了才记个人基线（「比平时高/快」靠它），不给就只量本段。
 */
export async function executeHear({ args = {}, getSpeech, db, agentId } = {}) {
  let buffer = null
  let ext = 'amr'
  const file = expand(args.path || args.file)
  if (file) {
    if (!fs.existsSync(file)) throw new Error('找不到这个文件：' + file)
    buffer = fs.readFileSync(file)
    ext = path.extname(file).replace('.', '') || 'amr'
  } else if (args.audio_base64) {
    const raw = String(args.audio_base64 || '').replace(/^data:[^;]+;base64,/, '')
    buffer = Buffer.from(raw, 'base64')
    ext = String(args.format || args.ext || 'webm').replace(/^\./, '').toLowerCase() || 'webm'
    if (!buffer.length) throw new Error('录音是空的，再说一次')
  } else {
    throw new Error('要听哪个文件？给我一个本地音频路径（wav / mp3 / amr 都行），或把录音字节传上来')
  }
  const service = typeof getSpeech === 'function' ? getSpeech() : null
  if (!service) {
    throw new Error('本机没有语音识别服务：设置 → 插件里启用「语音输入」那个实验包，再让我听')
  }
  const out = await transcribeVoice({
    buffer,
    ext,
    tmpDir: os.tmpdir(),
    service,
    language: args.language || 'auto',
  })
  // 个人基线：先拿旧常态比这一句，再把这一句滚进常态里。
  // 没给 db/agentId 就算了——量本段照样能跑，只是少「比平时」这一层。
  let drift = ''
  try {
    if (db && agentId) {
      const base = applyBaseline(db, { agentId, shape: out.shape, text: out.text })
      drift = describeDrift(base.drift, base.warmed)
    }
  } catch { drift = '' }
  const shapeWords = describeShape(out.shape, out.text)
  return {
    ok: true,
    text: out.text,
    audio_seconds: out.audioSeconds,
    inference_seconds: out.inferenceSeconds,
    bytes: buffer.length,
    // 「怎么说」的那一半：转写只留下字，这些是同一段声音上顺带量的。
    shape: out.shape || null,
    shape_words: shapeWords,
    // 跟他自己平时比，不是跟别人比。不够格时是空串。
    voice_drift: drift,
    // 拼好的一句，给注入那行直接用。
    voice_line: [shapeWords, drift].filter(Boolean).join('，'),
    at: new Date().toISOString(),
  }
}

/** 刚刚开口的时间戳：网页右下角那颗光点靠它知道该亮了。 */
let voiceFlashAt = 0
let voiceFlashUntil = 0
/** 开口了：记下起点和预计说完的时刻（按字数估），网页里的光点靠它决定亮多久。 */
export function markVoiceFlash(durationMs = 0) {
  voiceFlashAt = Date.now()
  voiceFlashUntil = voiceFlashAt + Math.max(0, Number(durationMs) || 0)
}
export function lastVoiceFlash() { return { at: voiceFlashAt, until: voiceFlashUntil } }

/** 麦克风说完后，这段会话在窗口内回完话要自动念（见 maybeSpeakReply）。 */
const voiceExpectUntil = new Map()

/**
 * 上一段语音「怎么说」的那句话，按会话挂 2 分钟。
 * 转写只交出字；这一行让下一轮拼系统提示时，那边也知道它是快是慢、停没停。
 * 读一次就取走——只属于刚说出口的那一轮，不留到后面冒充。
 */
const voiceShapeBySession = new Map()

export function markVoiceShape(sessionId, line) {
  const sid = String(sessionId || '').trim()
  const text = String(line || '').trim()
  if (!sid || !text) return
  voiceShapeBySession.set(sid, { line: text, at: Date.now() })
}

export function takeVoiceShape(sessionId) {
  const sid = String(sessionId || '').trim()
  if (!sid) return ''
  const hit = voiceShapeBySession.get(sid)
  if (!hit) return ''
  voiceShapeBySession.delete(sid)
  return Date.now() - hit.at <= 120_000 ? hit.line : ''
}

export function markVoiceExpect(sessionId, ms = 120000) {
  const sid = String(sessionId || '').trim()
  if (!sid) return
  voiceExpectUntil.set(sid, Date.now() + Math.max(10_000, Number(ms) || 120000))
}

export function takeVoiceExpect(sessionId) {
  const sid = String(sessionId || '').trim()
  if (!sid) return false
  const until = voiceExpectUntil.get(sid)
  if (!until) return false
  voiceExpectUntil.delete(sid)
  return Date.now() <= until
}

/** 每段会话最近一句助手回复，给「点一下再念」用。 */
const lastAssistantBySession = new Map()

export function rememberAssistantReply(sessionId, text) {
  const sid = String(sessionId || '').trim()
  const t = String(text || '').trim()
  if (!sid || !t) return
  lastAssistantBySession.set(sid, { text: t.slice(0, 600), at: Date.now() })
}

export function lastAssistantReply(sessionId) {
  const sid = String(sessionId || '').trim()
  if (!sid) return null
  return lastAssistantBySession.get(sid) || null
}

/**
 * 只取回话的第一句：屏幕上那一大段解释不进耳朵。
 * 按中文/英文句末切；切不出来就取前 40 字。
 */
export function firstSentenceOf(text, max = 40) {
  const raw = String(text || '').trim()
  if (!raw) return ''
  // 优先：回复里用「」或 "" 圈出来的那一句，就是「要说的话」——屏幕上的解释不念。
  const quoted = raw.match(/[「"]([^」"\n]{2,80})[」"]/)
  if (quoted) return quoted[1].trim().slice(0, max)
  const m = raw.match(/^[^。！？!?\n]+[。！？!?]?/)
  const first = (m ? m[0] : raw).trim()
  return first.length > max ? first.slice(0, max) : first
}

/**
 * 回完一句后要不要自动念：只在「刚才是麦克风说的」且设置是 auto 时念。
 * 失败只记人话，不拖对话。
 */
export async function maybeSpeakReply({ db, agentId, sessionId, text } = {}) {
  rememberAssistantReply(sessionId, text)
  if (!db || !agentId) return { spoke: false, reason: 'no_agent' }
  const cfg = getConfig(db, agentId)
  if (cfg['voice.reply.mode'] !== 'auto') return { spoke: false, reason: 'reply_off' }
  if (!takeVoiceExpect(sessionId)) return { spoke: false, reason: 'not_from_mic' }
  const line = firstSentenceOf(text)
  if (!line) return { spoke: false, reason: 'empty' }
  try {
    const out = await executeSay({ db, agentId, args: { text: line.slice(0, 600), play: true } })
    return { spoke: !!out.played, reason: out.played ? 'ok' : (out.play_error || 'no_play'), file: out.file }
  } catch (e) {
    return { spoke: false, reason: String(e && e.message || e).slice(0, 160) }
  }
}

/**
 * 出声之前先给眼睛一个信号：托盘气泡先亮 1.5 秒，然后声音才出来。
 * 不阻塞、失败不管——看不见气泡也不该耽误说话。
 */
function flashDesktopHint() {
  try {
    // 托盘气泡在 Win11 上经常被通知设置吃掉，所以直接画一个置顶的小圆点：
    // 无边框、透明背景、右下角浮 1.6 秒，一定能看见。
    const ps = [
      "Add-Type -AssemblyName System.Windows.Forms",
      "Add-Type -AssemblyName System.Drawing",
      "$f = New-Object System.Windows.Forms.Form",
      "$f.FormBorderStyle = 'None'",
      "$f.StartPosition = 'Manual'",
      "$f.ShowInTaskbar = $false",
      "$f.TopMost = $true",
      "$f.Size = New-Object System.Drawing.Size(110,110)",
      "$wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea",
      "$f.Location = New-Object System.Drawing.Point(($wa.Right-170), ($wa.Bottom-170))",
      "$f.BackColor = [System.Drawing.Color]::Magenta",
      "$f.TransparencyKey = [System.Drawing.Color]::Magenta",
      "$f.add_Paint({ param($s,$e) $e.Graphics.SmoothingMode = 'AntiAlias'; $b = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(230,255,190,90)); $e.Graphics.FillEllipse($b, 12, 12, 86, 86) })",
      "$f.Show()",
      // WinForms 没有消息循环就不画窗口，只 Show()+Sleep 会什么都看不见。
      "$end = (Get-Date).AddMilliseconds(1800)",
      "while ((Get-Date) -lt $end) { [System.Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 25 }",
      "$f.Close()",
    ].join('; ')
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'ignore', windowsHide: true })
    child.on('error', () => {})
  } catch { /* 闪不出来就算了 */ }
}

/** 本机播放：wav 走 SoundPlayer，别的交给系统默认程序。失败不算整个动作失败。 */
function playFile(file, format) {
  return new Promise((resolve) => {
    try {
      const ps = format === 'wav'
        ? `$p = New-Object Media.SoundPlayer '${file.replace(/'/g, "''")}'; $p.PlaySync()`
        // mp3 不弹播放器窗口：用 WPF 的 MediaPlayer 静默播，等一句说完。
        : `Add-Type -AssemblyName PresentationCore; $p = New-Object System.Windows.Media.MediaPlayer; $p.Open([uri]'${file.replace(/'/g, "''")}'); $p.Play(); $deadline = (Get-Date).AddSeconds(90); Start-Sleep -Milliseconds 400; while ((Get-Date) -lt $deadline) { if ($p.NaturalDuration.HasTimeSpan -and $p.Position -ge $p.NaturalDuration.TimeSpan) { break }; Start-Sleep -Milliseconds 200 }`
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
  // 先给眼睛一个信号，再合成出声：视觉先到，声音后到，不吓人。
  // 按字数估这一句大概说多久，光点就一直亮到那时候。
  markVoiceFlash((String(text || '').length / 4.5) * 1000 + 3000)
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
