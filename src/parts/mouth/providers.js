// 出声 · 三条嗓子：微软（SSML）、任意兼容接口的 /audio/speech、本机 GPT-SoVITS。
//
// 三条都在这一格，因为它们是同一件事的三个实现：文字进来，音频出去。
// 换嗓子只改这里；调用方永远只认 synthesizeVoice。
//
// 厂商名不进代码（INV9）：第二条嗓子只叫「compat」，地址和模型名由主人在设置里填。
//
// `fetchImpl` 可注入：考卷不发真请求，也不花主人的钱。

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
 * @param {{ fetchImpl?: Function }} [options]
 * @returns {Promise<{ audio: Buffer, format: 'mp3'|'wav' }>}
 */
export async function synthesizeTts(config, text, { fetchImpl = fetch } = {}) {
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
