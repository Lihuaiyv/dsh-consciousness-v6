// 听见 · 体检：这一段音频是不是「十六千赫兹、单声道、十六位、头干净」。
//
// 为什么自己验：DSH 的识别服务对 WAV 是**严格**检查（不做块遍历），ffmpeg 默认会写
// LIST/INFO 元数据块，`data` 就不在第三十六字节，平台会抛 Invalid speech WAV。
// 所以这里既当体检，也当修正：不管 ffmpeg 怎么写，只抽 fmt + data 按规范重建。
//
// 纯函数，不碰文件、不碰进程——能直接喂字节测。

/**
 * 检查一段字节是不是规范形态的 16k 单声道 PCM16 WAV。
 * @param {Buffer} buffer
 * @returns {{ ok: boolean, reason?: string, sampleRate?: number, channels?: number, bits?: number }}
 */
export function inspectWav(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 46) return { ok: false, reason: '音频太短，不像是完整录音' }
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    return { ok: false, reason: '不是 WAV（没找到 RIFF/WAVE 头）' }
  }
  // 下面逐条对齐平台的 validateWave：它是严格检查，所以这里也必须严格，
  // 否则会出现「本地过了、平台抛 Invalid speech WAV」（2026-10-04 真机事故）。
  if (buffer.toString('ascii', 12, 16) !== 'fmt ') return { ok: false, reason: 'WAV 头不规范：fmt 块不在偏移 12' }
  if (buffer.readUInt32LE(16) !== 16) return { ok: false, reason: 'WAV 头不规范：fmt 块长度不是 16' }
  if (buffer.readUInt16LE(20) !== 1) return { ok: false, reason: 'WAV 不是 PCM 编码' }
  const channels = buffer.readUInt16LE(22)
  if (channels !== 1) return { ok: false, reason: `声道数 ${channels}，需要单声道`, channels }
  const sampleRate = buffer.readUInt32LE(24)
  if (sampleRate !== 16000) return { ok: false, reason: `采样率 ${sampleRate}，需要 16000`, sampleRate }
  if (buffer.readUInt32LE(28) !== 32000) return { ok: false, reason: 'WAV 字节率不是 32000（16kHz×单声道×16 位）' }
  if (buffer.readUInt16LE(32) !== 2) return { ok: false, reason: 'WAV 块对齐不是 2' }
  const bits = buffer.readUInt16LE(34)
  if (bits !== 16) return { ok: false, reason: `位深 ${bits}，需要 16 位`, bits }
  if (buffer.toString('ascii', 36, 40) !== 'data') {
    return { ok: false, reason: 'WAV 的 data 块不在偏移 36（多半多了元数据块，例如 ffmpeg 默认写的 LIST）' }
  }
  if (buffer.readUInt32LE(4) !== buffer.length - 8) return { ok: false, reason: 'WAV 的 RIFF 长度与文件长度不一致' }
  if (buffer.readUInt32LE(40) !== buffer.length - 44) return { ok: false, reason: 'WAV 的 data 长度与文件长度不一致' }
  if ((buffer.length - 44) % 2 !== 0) return { ok: false, reason: 'WAV 的音频数据长度是奇数' }
  return { ok: true, channels, sampleRate, bits }
}

/**
 * 把任意规格的 PCM16 WAV 重写成规范形态：44 字节头 + 音频数据（`fmt ` 在 12、`data` 在 36）。
 * 别的块（LIST 之类）一律丢掉；奇数长度截掉半个字节。
 * @param {Buffer} buffer
 * @returns {Buffer}
 */
export function canonicalizeWav(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 44) throw new Error('音频太短，不像是完整录音')
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('不是 WAV（没找到 RIFF/WAVE 头）')
  }
  let fmt = null
  let data = null
  let offset = 12
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4)
    const size = buffer.readUInt32LE(offset + 4)
    const body = buffer.subarray(offset + 8, Math.min(buffer.length, offset + 8 + size))
    if (id === 'fmt ') fmt = body
    else if (id === 'data') data = body
    offset += 8 + size + (size % 2)
  }
  if (!fmt) throw new Error('WAV 里没有 fmt 块')
  if (!data || data.length === 0) throw new Error('WAV 里没有音频数据（data 块是空的）')
  if (fmt.length < 16) throw new Error('WAV 的 fmt 块不完整')
  if (fmt.readUInt16LE(0) !== 1) throw new Error('WAV 不是 PCM 编码，转写只接受 PCM16')
  const channels = fmt.readUInt16LE(2)
  const sampleRate = fmt.readUInt32LE(4)
  const bits = fmt.readUInt16LE(14)
  if (channels !== 1 || sampleRate !== 16000 || bits !== 16) {
    throw new Error(`WAV 规格不对（声道 ${channels} / 采样率 ${sampleRate} / 位深 ${bits}），需要 16kHz 单声道 16 位`)
  }
  // 平台要求音频数据长度为偶数；多出半个字节就截掉。
  const pcm = data.length % 2 === 0 ? data : data.subarray(0, data.length - 1)
  const out = Buffer.alloc(44 + pcm.length)
  out.write('RIFF', 0, 'ascii')
  out.writeUInt32LE(36 + pcm.length, 4)
  out.write('WAVE', 8, 'ascii')
  out.write('fmt ', 12, 'ascii')
  out.writeUInt32LE(16, 16)
  out.writeUInt16LE(1, 20)
  out.writeUInt16LE(1, 22)
  out.writeUInt32LE(16000, 24)
  out.writeUInt32LE(32000, 28)
  out.writeUInt16LE(2, 32)
  out.writeUInt16LE(16, 34)
  out.write('data', 36, 'ascii')
  out.writeUInt32LE(pcm.length, 40)
  pcm.copy(out, 44)
  return out
}
