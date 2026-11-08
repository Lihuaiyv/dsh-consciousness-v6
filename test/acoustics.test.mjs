/**
 * 听见零件 · 声学考卷
 *
 * 管的是「怎么说」那一半：同一段 16k PCM 上量出来的快慢、起伏、停顿、音高。
 * 不管转写（exam-ear）、不管谁发的、不管要不要回。
 *
 * 运行：node test/acoustics.test.mjs
 */
import { pcmShape, describeShape } from '../src/parts/ear/acoustics.js'
import { transcribeVoice } from '../src/parts/ear/index.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 300)) }
}

// ---------------------------------------------------------------- 造 PCM
function u32(n) {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(n, 0)
  return b
}
function wavOf(pcm) {
  const fmt = Buffer.alloc(16)
  fmt.writeUInt16LE(1, 0)       // PCM
  fmt.writeUInt16LE(1, 2)       // 单声道
  fmt.writeUInt32LE(16000, 4)
  fmt.writeUInt32LE(32000, 8)
  fmt.writeUInt16LE(2, 12)
  fmt.writeUInt16LE(16, 14)
  const body = Buffer.concat([Buffer.from('fmt '), u32(16), fmt, Buffer.from('data'), u32(pcm.length), pcm])
  return Buffer.concat([Buffer.from('RIFF'), u32(4 + body.length), Buffer.from('WAVE'), body])
}
function tone(seconds, hz = 440, amp = 8000) {
  const n = Math.round(seconds * 16000)
  const b = Buffer.alloc(n * 2)
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(amp * Math.sin((2 * Math.PI * hz * i) / 16000)), i * 2)
  return b
}
function silence(seconds) {
  return Buffer.alloc(Math.round(seconds * 16000) * 2)
}

// ================================================================ 数字
{
  const shape = pcmShape(wavOf(tone(1)))
  check('一秒正弦：能量是满载的一半左右', shape && shape.voicedRatio > 0.9, shape)
  check('一秒正弦：时长约 1 秒', shape && Math.abs(shape.seconds - 1) < 0.05, shape)
  check('一秒正弦：音高估在 440 附近', shape && shape.pitchHz >= 400 && shape.pitchHz <= 480, shape && shape.pitchHz)
  check('纯音：没有停顿', shape && shape.pauses === 0, shape)
  check('纯音：音量起伏很小', shape && shape.dynamic < 0.2, shape && shape.dynamic)
}

{
  const shape = pcmShape(wavOf(Buffer.concat([tone(0.5), silence(0.2), tone(0.5)])))
  check('中间空 0.2 秒：算一次停顿', shape && shape.pauses === 1, shape)
  check('中间空 0.2 秒：有声占比小于一', shape && shape.voicedRatio < 0.95 && shape.voicedRatio > 0.6, shape && shape.voicedRatio)
}

{
  const shape = pcmShape(wavOf(silence(1)))
  check('整段安静：没有有声部分', shape && shape.voicedRatio === 0, shape)
  check('整段安静：不猜音高', shape && shape.pitchHz === null, shape)
  check('整段安静：不硬写一句话', describeShape(shape, '') === '', describeShape(shape, ''))
}

{
  check('音频太短：量不出形状就交白卷', pcmShape(wavOf(Buffer.alloc(40))) === null)
  check('不是 WAV 也不炸', pcmShape(null) === null)
}

// ================================================================ 人话
{
  const shape = pcmShape(wavOf(tone(1.2)))
  const line = describeShape(shape, '好的好的我知道了')
  check('有字时能说出语速', /字\/秒/.test(line), line)
  check('音量够大时说「音量正常」或「声音冲」', /音量正常|声音冲/.test(line), line)
}

// ================================================================ 接进耳朵
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-acoustics-'))
  const fakeRun = async (_cmd, args) => { fs.writeFileSync(args[args.length - 1], wavOf(tone(1))) }
  const service = { resolve: (input) => ({ input }), transcribe: async () => ({ text: '嗯', audioSeconds: 1 }) }
  const out = await transcribeVoice({ buffer: Buffer.from('fake'), ext: 'webm', tmpDir, service, run: fakeRun })
  check('转写结果里带上了声音形状', out && out.shape && out.shape.seconds > 0, out && out.shape)
  check('转写本身没被形状拖坏', out && out.text === '嗯', out && out.text)
}

// ================================================================ 稳不稳、句尾
{
  const shape = pcmShape(wavOf(tone(1)))
  check('纯音：周期非常齐', shape && shape.periodicity != null && shape.periodicity > 0.9, shape && shape.periodicity)
}

{
  // 白噪声没有周期：自相关峰应该掉下来，不能被当成「很稳」。
  const noise = Buffer.alloc(16000 * 2)
  for (let i = 0; i < 16000; i++) noise.writeInt16LE(Math.round((Math.random() * 2 - 1) * 6000), i * 2)
  const shape = pcmShape(wavOf(noise))
  check('白噪声：周期不齐', shape && (shape.periodicity == null || shape.periodicity < 0.6), shape && shape.periodicity)
}

{
  // 440Hz 的周期是 36.36 个采样，三倍周期 109 更接近整数；取全局最高峰会判成 147。
  // 这条专门守着「八度错误」不再回来。
  const low = pcmShape(wavOf(tone(1, 220)))
  check('低音不会掉一个八度', low && low.pitchHz >= 200 && low.pitchHz <= 240, low && low.pitchHz)
  const mid = pcmShape(wavOf(tone(1, 330)))
  check('中音不会掉一个八度', mid && mid.pitchHz >= 300 && mid.pitchHz <= 360, mid && mid.pitchHz)
}

{
  const shape = pcmShape(wavOf(Buffer.concat([tone(0.7, 440), tone(0.3, 523)])))
  check('句尾升一个音：斜率是正的', shape && shape.pitchSlopeSt > 1, shape && shape.pitchSlopeSt)
}

{
  const shape = pcmShape(wavOf(Buffer.concat([tone(0.7, 440), tone(0.3, 370)])))
  check('句尾降：斜率是负的', shape && shape.pitchSlopeSt < -1, shape && shape.pitchSlopeSt)
}

{
  const shape = pcmShape(wavOf(Buffer.concat([tone(0.4), silence(0.2), tone(0.4), silence(0.2), tone(0.4)])))
  check('三段一口气：数得出短语', shape && shape.phrases === 3, shape && shape.phrases)
  check('三段一口气：两次停顿', shape && shape.pauses === 2, shape && shape.pauses)
}

{
  const line = describeShape(pcmShape(wavOf(Buffer.concat([tone(0.7, 440), tone(0.3, 523)]))), '好的好的')
  check('句尾往上挑能说出来', /往上挑/.test(line), line)
}

console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) { console.log('失败：', fail); process.exit(1) }
