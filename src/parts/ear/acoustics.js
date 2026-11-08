// 听见 · 声学：这段声音是「怎么说」的，不只是「说了什么」。
//
// 转写只留下字，说快说慢、声音稳不稳、句尾是挑还是沉，全在识别那一步丢掉了。
// 但 16k 单声道 PCM 在 toWav16k 里已经到过手上一遍——转写前顺手量一下，
// 几乎不花时间，也不用装任何模型。
//
// 只管量：给出可重复的数字。翻成「急 / 慢 / 压着说」这类话是 describeShape 的事，
// 别混进来——数字错了查得到，话错了只能猜。
//
// 纯函数，不碰文件、不碰进程，能直接喂字节测。
const SAMPLE_RATE = 16000
const FRAME_MS = 20
const FRAME_SAMPLES = (SAMPLE_RATE * FRAME_MS) / 1000
const FULL_SCALE = 32767
const MIN_F0_HZ = 60
const MAX_F0_HZ = 500
const MIN_LAG = Math.floor(SAMPLE_RATE / MAX_F0_HZ)
const MAX_LAG = Math.ceil(SAMPLE_RATE / MIN_F0_HZ)
// 音高分析最多看这么多帧：60 秒的语音也只算 80 个点，够用且不会卡住主线程。
const MAX_F0_FRAMES = 80
// 分析窗 40ms：要装得下 60Hz 的至少两个周期（33ms），又要够短，能看清句尾。
const F0_WINDOW = 640

/**
 * 量一段规范 WAV（44 字节头 + 16k 单声道 PCM16）的声学形状。
 * @param {Buffer} wav
 * @returns {null | {
 *   seconds: number,
 *   voicedRatio: number,   // 有声帧占全部帧的比例 0~1
 *   pauses: number,        // 句中停顿次数（首尾静音不算）
 *   phrases: number,       // 被停顿切出来的小段数（一口气一段）
 *   loudness: number,      // 说话时的平均响度 0~1（相对满幅）
 *   dynamic: number,       // 音量起伏 = 标准差 / 均值，越大越忽高忽低
 *   pitchHz: number|null,  // 中位音高（自相关估，不是过零率）
 *   jitterPct: number|null, // 相邻音高周期的抖动 %（声带不稳）
 *   shimmerPct: number|null,// 相邻响度的抖动 %（气声、压着说会高）
 *   pitchSlopeSt: number|null, // 句尾相对全句的音高偏移（半音，正=往上挑）
 * }}
 */
export function pcmShape(wav) {
  if (!Buffer.isBuffer(wav) || wav.length <= 44) return null
  const data = wav.subarray(44)
  const total = data.length >> 1
  if (total < FRAME_SAMPLES * 3) return null // 少于 60ms 量不出形状

  const frames = []
  for (let i = 0; i + FRAME_SAMPLES <= total; i += FRAME_SAMPLES) {
    let sum = 0
    for (let j = 0; j < FRAME_SAMPLES; j++) {
      const v = data.readInt16LE((i + j) * 2)
      sum += v * v
    }
    frames.push(Math.sqrt(sum / FRAME_SAMPLES))
  }
  if (frames.length < 3) return null

  // 静音门：在本段自己的底噪（p10）和峰值（p90）之间切，但不超过峰值的一半——
  // 整段都是同一种声音时（lo≈hi），不能把自己整段判成静音。
  // 设备音量、距离都不同，绝不能用写死的绝对阈值。
  const sorted = [...frames].sort((a, b) => a - b)
  const lo = sorted[Math.floor(sorted.length * 0.1)]
  const hi = sorted[Math.floor(sorted.length * 0.9)]
  if (hi < 120) {
    return { seconds: round(total / SAMPLE_RATE), voicedRatio: 0, pauses: 0, phrases: 0, loudness: 0, dynamic: 0, pitchHz: null, jitterPct: null, shimmerPct: null, pitchSlopeSt: null }
  }
  const gate = Math.min(hi * 0.5, lo + (hi - lo) * 0.22)

  const voicedFlags = frames.map((r) => r > gate)
  const voicedCount = voicedFlags.filter(Boolean).length
  const voicedRatio = voicedCount / frames.length
  const voicedRms = frames.filter((_, i) => voicedFlags[i])
  const meanRms = voicedRms.reduce((s, v) => s + v, 0) / voicedRms.length
  const variance = voicedRms.reduce((s, v) => s + (v - meanRms) ** 2, 0) / voicedRms.length
  const dynamic = meanRms > 0 ? Math.sqrt(variance) / meanRms : 0

  // 停顿与短语：连续 ≥3 帧（60ms）静音算一次停顿；把说话切成 phrases 段。
  let pauses = 0
  let run = 0
  let seenVoice = false
  let phrases = 0
  for (const voiced of voicedFlags) {
    if (voiced) {
      if (!seenVoice) phrases++
      else if (run >= 3) { pauses++; phrases++ }
      run = 0
      seenVoice = true
    } else if (seenVoice) {
      run++
    }
  }

  // 音高：在 voiced 帧里均匀抽 ≤80 个点做自相关。过零率对气声、噪声会飙，
  // 所以不用它判音高，只用自相关峰。
  const voicedIndexes = []
  for (let i = 0; i < frames.length; i++) if (voicedFlags[i]) voicedIndexes.push(i)
  const step = Math.max(1, Math.floor(voicedIndexes.length / MAX_F0_FRAMES))
  const pitchFrames = []
  for (let k = 0; k < voicedIndexes.length; k += step) {
    const center = voicedIndexes[k] * FRAME_SAMPLES + FRAME_SAMPLES / 2
    const est = f0At(data, total, Math.round(center))
    if (est && est.clarity >= 0.45) pitchFrames.push({ frame: voicedIndexes[k], lag: est.lag, hz: est.hz, clarity: est.clarity, rms: frames[voicedIndexes[k]] })
  }

  const hzList = pitchFrames.map((p) => p.hz)
  const pitchHz = hzList.length ? Math.round(median(hzList)) : null

  // 周期性：自相关那个峰有多高，代表这段声音的周期有多齐。
  //
  // 这里踩过一个坑，写下来：第一版拿「相邻 20ms 帧的音高差」当 jitter，
  // 结果真人说话每句都算出 14% 左右，于是每句都被判成「声音发颤」。
  // 原因是 20ms 一帧量到的是**语调**（一句话里音高本来就在动），
  // 不是声带抖动——真正的 jitter 是毫秒级、相邻周期之间的差，20ms 的帧根本看不见。
  // 所以改用峰高：周期齐 → 峰接近 1；气声、沙哑、绷着说话 → 峰掉下来。
  const periodicity = pitchFrames.length
    ? round(median(pitchFrames.map((p) => p.clarity)), 3)
    : null

  // 句尾升降：最后三分之一的有声段音高 vs 整句音高，换成半音（对数尺度，
  // 这样「男声升 20Hz」和「女声升 20Hz」不会被当成同一件事）。
  let pitchSlopeSt = null
  if (hzList.length >= 6) {
    const tailStart = Math.floor(hzList.length * 0.7)
    const tail = hzList.slice(tailStart)
    const base = median(hzList)
    const tailMed = median(tail)
    if (base > 0 && tailMed > 0) pitchSlopeSt = round(12 * Math.log2(tailMed / base), 2)
  }

  return {
    seconds: round(total / SAMPLE_RATE),
    voicedRatio: round(voicedRatio, 3),
    pauses,
    phrases,
    loudness: round(meanRms / FULL_SCALE, 3),
    dynamic: round(dynamic, 3),
    pitchHz,
    periodicity,
    pitchSlopeSt,
  }
}

/**
 * 一帧 40ms 的自相关音高估计。
 * 只找 [60, 500] Hz 对应的 lag 区间里的最高峰，峰太浅就当没音高（气声、噪声）。
 * @returns {null | { lag: number, hz: number, clarity: number }}
 */
function f0At(data, total, center) {
  const half = F0_WINDOW / 2
  let start = center - half
  if (start < 0) start = 0
  if (start + F0_WINDOW * 2 > total) start = total - F0_WINDOW * 2
  if (start < 0) return null

  const n = F0_WINDOW
  const x = new Float64Array(n + MAX_LAG)
  for (let i = 0; i < n + MAX_LAG; i++) x[i] = data.readInt16LE((start + i) * 2)

  // 减均值，去掉直流分量。
  let mean = 0
  for (let i = 0; i < n; i++) mean += x[i]
  mean /= n
  for (let i = 0; i < n; i++) x[i] -= mean

  const energy = (from, to) => {
    let e = 0
    for (let i = from; i < to; i++) e += x[i] * x[i]
    return e
  }

  const rOf = (lag) => {
    let num = 0
    for (let i = 0; i < n; i++) num += x[i] * x[i + lag]
    const den = Math.sqrt(energy(0, n) * energy(lag, lag + n)) || 1
    return num / den
  }

  const rs = []
  for (let lag = MIN_LAG; lag <= MAX_LAG; lag++) rs.push(rOf(lag))
  let maxR = 0
  for (const r of rs) if (r > maxR) maxR = r
  if (maxR <= 0) return null

  // 关键：不能取全局最高的那个峰。440Hz 的周期是 36.36 个采样，
  // 三倍周期 109 刚好更接近整数，自相关反而更高——直接取最大会把音高
  // 判成三分之一（八度错误）。所以取「第一个够高的局部峰」。
  let bestIdx = -1
  for (let i = 0; i < rs.length; i++) {
    if (rs[i] < Math.max(0.45, maxR * 0.9)) continue
    const left = i === 0 || rs[i] >= rs[i - 1]
    const right = i === rs.length - 1 || rs[i] >= rs[i + 1]
    if (left && right) { bestIdx = i; break }
  }
  if (bestIdx < 0) {
    // 没有明显的局部峰（噪声、气声）：退回全局最大的那个。
    for (let i = 0; i < rs.length; i++) if (rs[i] === maxR) { bestIdx = i; break }
  }
  if (bestIdx < 0) return null
  const bestLag = MIN_LAG + bestIdx
  const bestR = rs[bestIdx]
  if (bestLag < 0 || bestR <= 0) return null

  // 抛物线插值：整数 lag 的分辨率太粗（16k 下一个采样就 3% 误差），
  // 句尾只升一点点时会被抹平。
  let lagF = bestLag
  if (bestIdx > 0 && bestIdx < rs.length - 1) {
    const r0 = rs[bestIdx - 1]
    const r2 = rs[bestIdx + 1]
    const denom = r0 - 2 * bestR + r2
    if (denom !== 0) {
      const shift = (0.5 * (r0 - r2)) / denom
      if (Math.abs(shift) <= 1) lagF = bestLag + shift
    }
  }
  return { lag: lagF, hz: SAMPLE_RATE / lagF, clarity: bestR }
}

/**
 * 把形状翻成一句人话。只描述能听见的，不猜情绪——猜情绪是上层和模型的事。
 * @param {ReturnType<typeof pcmShape>} shape
 * @param {string} [text] 转写出来的字，用来估语速
 * @returns {string} 形如「说得快（7.4 字/秒）· 声音很稳 · 句尾往上挑」；量不出来就是空串
 */
export function describeShape(shape, text = '') {
  if (!shape || !shape.seconds) return ''
  if (shape.voicedRatio < 0.05) return '' // 整段都没人说话，别硬描述
  const parts = []
  const chars = String(text || '').replace(/[\s，。！？、,.!?…—]/g, '').length
  if (chars >= 2 && shape.voicedRatio > 0.05) {
    const cps = chars / Math.max(0.3, shape.seconds)
    const fast = cps >= 6 ? '说得快' : (cps <= 2.5 ? '说得慢' : '不快不慢')
    parts.push(`${fast}（${cps.toFixed(1)} 字/秒）`)
  }
  if (shape.loudness >= 0.16) parts.push('声音冲')
  else if (shape.loudness <= 0.05) parts.push('压着说')
  else parts.push('音量正常')
  // 周期齐不齐：周期清晰 → 稳；气声、沙哑、绷着说 → 「发虚」。
  // 门槛 0.55 / 0.80 是从纯音（≈0.99）和白噪声（≈0.1）两头夹出来的，
  // 真人嗓门的具体落点还没校准过，第一次真机跑完要再看。
  if (shape.periodicity != null && shape.periodicity < 0.55) parts.push('声音发虚')
  else if (shape.dynamic <= 0.25 && (shape.periodicity == null || shape.periodicity >= 0.8)) parts.push('声音很稳')
  // 句尾：正 = 往上挑（疑问、撒娇、挑衅都可能是它），负 = 往下沉（陈述、疲惫）。
  if (shape.pitchSlopeSt != null) {
    if (shape.pitchSlopeSt >= 1.2) parts.push('句尾往上挑')
    else if (shape.pitchSlopeSt <= -1.2) parts.push('句尾往下沉')
  }
  if (shape.pauses >= 3) parts.push(`中间停了 ${shape.pauses} 次`)
  return parts.join(' · ')
}

function median(list) {
  const sorted = [...list].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function avg(list) {
  return list.length ? list.reduce((s, v) => s + v, 0) / list.length : 0
}

function round(n, digits = 2) {
  const p = 10 ** digits
  return Math.round(n * p) / p
}
