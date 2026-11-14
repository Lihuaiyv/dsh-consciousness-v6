// 出声 · 五条嗓子：微软（SSML）、任意兼容接口的 /audio/speech、本机 GPT-SoVITS、
// 系统自带（Windows SAPI）、BreezeBlue（角色音色云端）。五条都在这一格，
// 因为它们是同一件事的五个实现：文字进来，音频出去。换嗓子只改这里；
// 调用方永远只认 synthesizeVoice。
//
// 厂商名不进代码（INV9）：第二条嗓子只叫「compat」，地址和模型名由主人在设置里填。
// 第五条单独叫「breeze」，是因为它不吃 /audio/speech 那个形状（见 synthesizeBreezeVoice）。
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

/** 本机嗓子（GPT-SoVITS api_v2 形状）的 POST /tts 请求体（纯函数，可单测）。
 *  额外字段（语速 / 情绪）是给「本机薄壳」用的：GPT-SoVITS 会忽略不认识的键，
 *  IndexTTS 的薄壳会读，用来把语气调软。不填就不发，保持老行为。 */
export function buildLocalTtsRequest(config, text) {
  const body = {
    text,
    text_lang: config.ttsLocalTextLang || 'zh',
    ref_audio_path: config.ttsLocalRefAudio || '',
    prompt_text: config.ttsLocalPromptText || '',
    prompt_lang: config.ttsLocalPromptLang || 'zh',
    media_type: 'wav',
    streaming_mode: 0,
  }
  const duration = Number(config.ttsLocalDuration)
  if (Number.isFinite(duration) && duration >= 0.5 && duration <= 2) body.duration_factor = duration
  const emo = String(config.ttsLocalEmoVector || '').trim()
  if (emo) {
    const vec = emo.split(',').map((x) => Number(x)).filter((n) => Number.isFinite(n)).slice(0, 8)
    if (vec.length === 8) body.emo_vector = vec
  }
  const alpha = Number(config.ttsLocalEmoAlpha)
  if (Number.isFinite(alpha) && alpha >= 0 && alpha <= 1) body.emo_alpha = alpha
  return body
}

/**
 * BreezeBlue 云端嗓子的请求体（纯函数，可单测）。
 * 它的字段名不跟 /audio/speech 那套走：model_id / instructions / voice_settings。
 * 没填语气说明就不发这个键——空串会被当成「要求它别说」。
 */
export function buildBreezeTtsRequest(config, text) {
  const body = { text, model_id: (config && config.ttsBreezeModel) || 'breeze-tts-2' }
  const instructions = String((config && config.ttsBreezeInstructions) || '').trim()
  if (instructions) body.instructions = instructions
  return body
}

/** 从失败响应里挖一句人话：JSON 的 detail / message / error，取不到就回原文。 */
async function breezeErrorDetail(response) {
  try {
    const body = await response.json()
    const d = body && (body.detail || body.message || body.error)
    if (d) return String(typeof d === 'string' ? d : JSON.stringify(d))
    return ''
  } catch { return await response.text().catch(() => '') }
}

/**
 * BreezeBlue 云端嗓子：POST {base}/v1/text-to-speech/{voice_id}，认证头是 xi-api-key。
 * 和 compat 分开写，是因为它不吃 /audio/speech 那个形状；
 * 地址、音色 ID、模型名、语气说明全部由主人在设置里填。
 */
export async function synthesizeBreezeVoice(config, text, { fetchImpl = fetch } = {}) {
  const base = String((config && config.ttsBreezeUrl) || 'https://api.breeze.blue').replace(/\/+$/, '')
  const voiceId = String((config && config.ttsBreezeVoice) || '').trim()
  if (!voiceId) throw new Error('BreezeBlue 嗓子缺音色 ID（ttsBreezeVoice）')
  const response = await fetchImpl(`${base}/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3`, {
    method: 'POST',
    headers: {
      'xi-api-key': config.ttsApiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(buildBreezeTtsRequest(config, text)),
    signal: AbortSignal.timeout(120_000),
  })
  if (!response.ok) throw new Error(`BreezeBlue TTS HTTP ${response.status}: ${String(await breezeErrorDetail(response)).slice(0, 120)}`)
  return { audio: Buffer.from(await response.arrayBuffer()), format: 'mp3' }
}

// ─────────────────────────────────────────────────────────────────────────
// 造嗓子（不进合成路径）：这两个函数不念话，只跟云端要「一副新嗓子」。
//   先 design —— 发一段描述，拿回几个候选（每个有自己的 generated_voice_id）；
//   主人挑一个再 save —— 存成自己账号下的私有音色，之后就拿那个 voice_id 念话。
// 空手造音色这件事，本机那几条开源嗓子都做不细；这条才走云端。
// ─────────────────────────────────────────────────────────────────────────

/** 设计请求体（纯函数，可单测）。 */
export function buildBreezeDesignRequest(config, description) {
  const line = String(description == null ? '' : description).trim()
  if (!line) throw new Error('要造什么样的声音？给一句描述（音色、语气、年纪都行）')
  const body = {
    voice_description: line,
    // 候选一次别要太多：每个都花钱，挑不过来看。
    preview_count: Math.max(1, Math.min(4, Number((config && config.ttsBreezePreviewCount) || 3) || 3)),
  }
  if (config && config.ttsBreezeModel) body.model_id = config.ttsBreezeModel
  if (config && config.ttsBreezeLanguage) body.language_code = config.ttsBreezeLanguage
  return body
}

/** 发描述 → 拿候选。回 { previews, text, payload }；候选里每个都有 generated_voice_id。 */
export async function breezeDesignPreviews(config, description, { fetchImpl = fetch } = {}) {
  const base = String((config && config.ttsBreezeUrl) || 'https://api.breeze.blue').replace(/\/+$/, '')
  if (!config || !config.ttsApiKey) throw new Error('造嗓子要密钥（ttsApiKey）：没它云端不认')
  const response = await fetchImpl(`${base}/v1/voice-previews/design?output_format=mp3`, {
    method: 'POST',
    headers: { 'xi-api-key': config.ttsApiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(buildBreezeDesignRequest(config, description)),
    signal: AbortSignal.timeout(180_000),
  })
  if (!response.ok) throw new Error(`BreezeBlue 设计 HTTP ${response.status}: ${String(await breezeErrorDetail(response)).slice(0, 120)}`)
  const payload = await response.json()
  const previews = Array.isArray(payload && payload.previews) ? payload.previews : []
  if (!previews.length) throw new Error('BreezeBlue 没给候选（回包里没有 previews）')
  return { previews, text: (payload && payload.text) || '', payload }
}

/** 取一个候选的试听音频（GET …/voice-previews/{id}/stream）。 */
export async function breezePreviewAudio(config, generatedVoiceId, { fetchImpl = fetch } = {}) {
  const base = String((config && config.ttsBreezeUrl) || 'https://api.breeze.blue').replace(/\/+$/, '')
  const id = String(generatedVoiceId || '').trim()
  if (!id) throw new Error('要从哪个候选取音频？给我 generated_voice_id')
  const response = await fetchImpl(`${base}/v1/voice-previews/${encodeURIComponent(id)}/stream`, {
    headers: { 'xi-api-key': config.ttsApiKey },
    signal: AbortSignal.timeout(120_000),
  })
  if (!response.ok) throw new Error(`BreezeBlue 试听 HTTP ${response.status}: ${String(await breezeErrorDetail(response)).slice(0, 120)}`)
  return { audio: Buffer.from(await response.arrayBuffer()), format: 'mp3' }
}

/** 挑中的候选存成私有音色。回保存结果（里面有 voice_id）。 */
export async function breezeSaveDesignPreview(config, generatedVoiceId, { name = '', description = '' } = {}, { fetchImpl = fetch } = {}) {
  const base = String((config && config.ttsBreezeUrl) || 'https://api.breeze.blue').replace(/\/+$/, '')
  const id = String(generatedVoiceId || '').trim()
  if (!id) throw new Error('要保存哪个候选？给我 generated_voice_id')
  const body = {
    voice_name: String(name || '').trim() || '小汐',
    language_code: String((config && config.ttsBreezeLanguage) || 'zh'),
  }
  if (String(description || '').trim()) body.voice_description = String(description).trim()
  const response = await fetchImpl(`${base}/v1/voice-previews/${encodeURIComponent(id)}/save`, {
    method: 'POST',
    headers: { 'xi-api-key': config.ttsApiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  })
  if (!response.ok) throw new Error(`BreezeBlue 保存 HTTP ${response.status}: ${String(await breezeErrorDetail(response)).slice(0, 120)}`)
  const saved = await response.json()
  if (!saved || !saved.voice_id) throw new Error('存下来了，但回包里没有 voice_id，先别当成功')
  return saved
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
  if (config.ttsProvider === 'breeze') {
    return synthesizeBreezeVoice(config, text, { fetchImpl })
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
    const args = ['-m', 'edge_tts', '--voice', String((config && config.ttsVoice) || 'zh-CN-XiaoyiNeural'), '--file', txt, '--write-media', mp3]
    const rate = String((config && config.ttsRate) || '').trim()
    const pitch = String((config && config.ttsPitch) || '').trim()
    if (rate) args.push('--rate=' + rate)
    if (pitch) args.push('--pitch=' + pitch)
    await run(py, args, env)
    const audio = readFileSync(mp3)
    if (!audio.length) throw new Error('edge-tts 没产出音频')
    return { audio, format: 'mp3' }
  } finally {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
  }
}
