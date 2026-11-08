// 出声 · 四条嗓子：微软（SSML）、任意兼容接口的 /audio/speech、本机 GPT-SoVITS、
// 系统自带（Windows SAPI）。四条都在这一格，因为它们是同一件事的四个实现：
// 文字进来，音频出去。换嗓子只改这里；调用方永远只认 synthesizeVoice。
//
// 厂商名不进代码（INV9）：第二条嗓子只叫「compat」，地址和模型名由主人在设置里填。
//
// `fetchImpl` / `run` 可注入：考卷不发真请求、不启进程，也不花主人的钱。
import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 把文字塞进 SSML。转义必须做全：少一个 & 整段请求就 400。 */
export function buildAzureSsml(text, voice, style) {
  const escapeXml = (s) => String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
  const styleAttr = style ? ` style="${escapeXml(style)}"` : ''
  return `<speak version="1.0" xml:lang="zh-CN"><voice name="${escapeXml(voice)}"${styleAttr}>${escapeXml(text)}</voice></speak>`
}

/** 本机 GPT-SoVITS api_v2 的 POST /tts 请求体（纯函数，可单测）。 */
export function buildLocalTtsRequest(config, text) {
  return {
    text,
    text_lang: config.ttsLocalTextLang || 'zh',
    ref_audio_path: config.ttsLocalRefAudio || '',
    prompt_text: config.ttsLocalPromptText || '',
    prompt_lang: config.ttsLocalPromptLang || 'zh',
    media_type: 'wav',
    streaming_mode: 0,
  }
}

/**
 * 合成一段音频。
 * @param {object} config 桥的配置（与旧实现同名字段，搬家不改配方）
 * @param {string} text
 * @param {{ fetchImpl?: Function, run?: Function }} [options]
 * @returns {Promise<{ audio: Buffer, format: 'mp3'|'wav' }>}
 */
export async function synthesizeTts(config, text, { fetchImpl = fetch, run } = {}) {
  if (config.ttsProvider === 'system') {
    return synthesizeSystemVoice(config, text, { run })
  }
  if (config.ttsProvider === 'edge') {
    return synthesizeEdgeVoice(config, text, { run })
  }
  if (config.ttsProvider === 'compat') {
    const base = String(config.ttsBaseUrl).replace(/\/+$/, '')
    const response = await fetchImpl(`${base}/audio/speech`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.ttsApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: config.ttsModel || 'tts-1', voice: config.ttsVoice || 'alloy', input: text }),
      signal: AbortSignal.timeout(60_000),
    })
    if (!response.ok) throw new Error(`TTS HTTP ${response.status}: ${(await response.text().catch(() => '')).slice(0, 120)}`)
    return { audio: Buffer.from(await response.arrayBuffer()), format: 'mp3' }
  }
  if (config.ttsProvider === 'local') {
    // 本机 GPT-SoVITS api_v2：POST /tts 回裸 wav 字节（失败时可能回 JSON）。
    const base = String(config.ttsLocalUrl || 'http://127.0.0.1:9880').replace(/\/+$/, '')
    const response = await fetchImpl(`${base}/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildLocalTtsRequest(config, text)),
      signal: AbortSignal.timeout(120_000),
    })
    if (!response.ok) {
      let detail = ''
      try { detail = (await response.json()).message ?? '' } catch { detail = await response.text().catch(() => '') }
      throw new Error(`本地 TTS HTTP ${response.status}: ${String(detail).slice(0, 120)}`)
    }
    return { audio: Buffer.from(await response.arrayBuffer()), format: 'wav' }
  }
  // 默认微软 Speech REST（SSML）
  const region = config.ttsAzureRegion || 'eastasia'
  const voice = config.ttsVoice || 'zh-CN-XiaoxiaoNeural'
  const response = await fetchImpl(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': config.ttsApiKey,
      'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
      'User-Agent': 'dsh-consciousness',
    },
    body: buildAzureSsml(text, voice, config.ttsStyle || ''),
    signal: AbortSignal.timeout(60_000),
  })
  if (!response.ok) throw new Error(`Azure TTS HTTP ${response.status}: ${(await response.text().catch(() => '')).slice(0, 120)}`)
  return { audio: Buffer.from(await response.arrayBuffer()), format: 'mp3' }
}

/** 跑一个外部进程（可注入；考卷注入假的）。env 用来带 PYTHONPATH。 */
function runProcess(exe, args, env) {
  return new Promise((resolve, reject) => {
    execFile(exe, args, { timeout: 120_000, windowsHide: true, env: env || process.env },
      (error) => (error ? reject(error) : resolve()))
  })
}

/** 默认用系统 PowerShell 跑一段脚本（可注入；考卷注入假的）。 */
function runPowerShell(script) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: 60_000, windowsHide: true }, (error) => (error ? reject(error) : resolve()))
  })
}

/**
 * 系统自带嗓子（Windows SAPI）：不联网、不要 key。
 * 文本走 base64 传给 PowerShell，避开中文和引号在命令行里的转义坑。
 * 中文念得好不好，看系统装了哪个中文语音（这台是 Microsoft Huihui Desktop）。
 */
export async function synthesizeSystemVoice(config, text, { run = runPowerShell, tmpDir = tmpdir() } = {}) {
  const line = String(text ?? '').trim()
  if (!line) throw new Error('要念的内容是空的')
  const dir = mkdtempSync(join(tmpDir, 'dsh-tts-'))
  const out = join(dir, 'say.wav')
  const b64 = Buffer.from(line, 'utf8').toString('base64')
  const voice = String((config && config.ttsVoice) || '').trim()
  const q = (s) => String(s).replace(/'/g, "''")
  const script = [
    `$t=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${q(b64)}'))`,
    'Add-Type -AssemblyName System.Speech',
    '$s=New-Object System.Speech.Synthesis.SpeechSynthesizer',
    voice ? `try { $s.SelectVoice('${q(voice)}') } catch {}` : '',
    `$s.SetOutputToWaveFile('${q(out)}')`,
    '$s.Speak($t)',
    '$s.Dispose()',
  ].filter(Boolean).join('; ')
  try {
    await run(script)
    const audio = readFileSync(out)
    if (!audio.length) throw new Error('系统嗓子没产出音频')
    return { audio, format: 'wav' }
  } finally {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
  }
}

/**
 * Edge 在线嗓子（微软那套神经语音，免费、不要 key）：走 python 的 edge-tts。
 * 文本先写 utf8 文件再 --file 传，避开命令行中文乱码。
 */
export async function synthesizeEdgeVoice(config, text, { run = runProcess, tmpDir = tmpdir() } = {}) {
  const line = String(text ?? '').trim()
  if (!line) throw new Error('要念的内容是空的')
  const py = String((config && config.ttsEdgePython) || '').trim()
  if (!py) throw new Error('没配 edge 的 python 路径（ttsEdgePython）')
  const dir = mkdtempSync(join(tmpDir, 'dsh-edge-'))
  const txt = join(dir, 'say.txt')
  const mp3 = join(dir, 'say.mp3')
  writeFileSync(txt, line, 'utf8')
  const env = { ...process.env, PYTHONPATH: String((config && config.ttsEdgeDir) || '').trim() }
  try {
    await run(py, ['-m', 'edge_tts', '--voice', String((config && config.ttsVoice) || 'zh-CN-XiaoyiNeural'), '--file', txt, '--write-media', mp3], env)
    const audio = readFileSync(mp3)
    if (!audio.length) throw new Error('edge-tts 没产出音频')
    return { audio, format: 'mp3' }
  } finally {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
  }
}
