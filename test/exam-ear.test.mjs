/**
 * 听见零件 · 考卷
 *
 * 管的是「一段声音变成字」：体检 / 修正头部 / 转规格 / 交给识别服务 / 失败要说人话。
 * 不管：谁发的、要不要回、要不要记、存不存音频。
 *
 * 运行：node test/exam-ear.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { inspectWav, canonicalizeWav } from '../src/parts/ear/probe.js'
import { toWav16k, transcribeViaDsh, explainDshError } from '../src/parts/ear/engine.js'
import { transcribeVoice } from '../src/parts/ear/index.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 300)) }
}
const throwsWith = (fn, needle) => {
  try { fn(); return false } catch (error) { return String(error?.message ?? error).includes(needle) }
}
const throwsAsyncWith = async (fn, needle) => {
  try { await fn(); return false } catch (error) { return String(error?.message ?? error).includes(needle) }
}

// ---------------------------------------------------------------- 造 WAV
function u32(n) {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(n, 0)
  return b
}
function wav({ rate = 16000, channels = 1, bits = 16, pcm = Buffer.alloc(320), list = false, pcmFormat = 1 } = {}) {
  const blockAlign = (channels * bits) / 8
  const fmt = Buffer.alloc(16)
  fmt.writeUInt16LE(pcmFormat, 0)
  fmt.writeUInt16LE(channels, 2)
  fmt.writeUInt32LE(rate, 4)
  fmt.writeUInt32LE(rate * blockAlign, 8)
  fmt.writeUInt16LE(blockAlign, 12)
  fmt.writeUInt16LE(bits, 14)
  const listChunk = list ? Buffer.concat([Buffer.from('LIST'), u32(4), Buffer.from('INFO')]) : Buffer.alloc(0)
  const body = Buffer.concat([Buffer.from('fmt '), u32(16), fmt, listChunk, Buffer.from('data'), u32(pcm.length), pcm])
  return Buffer.concat([Buffer.from('RIFF'), u32(4 + body.length), Buffer.from('WAVE'), body])
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-ear-'))
// 假 ffmpeg：把最后一个参数当输出文件，写一段规范的 16k WAV 进去。
const fakeRun = async (_cmd, args) => {
  fs.writeFileSync(args[args.length - 1], wav())
}
const fakeService = (result) => ({
  resolve: (input) => ({ input }),
  transcribe: async () => result,
})

// ================================================================ 体检
{
  const good = inspectWav(wav())
  check('规范 WAV：过', good.ok === true && good.sampleRate === 16000 && good.channels === 1, good)

  const withList = inspectWav(wav({ list: true }))
  check('带 LIST 元数据：不过，且点明 data 不在 36', withList.ok === false && String(withList.reason).includes('data'), withList)

  const wrongRate = inspectWav(wav({ rate: 44100 }))
  check('采样率 44100：不过，且报出采样率', wrongRate.ok === false && String(wrongRate.reason).includes('44100'), wrongRate)

  const stereo = inspectWav(wav({ channels: 2 }))
  check('双声道：不过，且要单声道', stereo.ok === false && String(stereo.reason).includes('单声道'), stereo)

  check('字节太少：报「太短」', inspectWav(Buffer.from('RIFF')).ok === false && String(inspectWav(Buffer.from('RIFF')).reason).includes('太短'))
  check('不是 WAV：报「不是 WAV」', String(inspectWav(Buffer.alloc(64, 1)).reason).includes('不是 WAV'))
}

// ================================================================ 修正头部
{
  const fixed = canonicalizeWav(wav({ list: true }))
  const fixedCheck = inspectWav(fixed)
  check('带 LIST 的 WAV：修完 data 回到 36，且能过体检', fixedCheck.ok === true && fixed.toString('ascii', 36, 40) === 'data', fixedCheck)
  check('修正只丢元数据，不多不少', fixed.length === 44 + 320, { got: fixed.length })

  const odd = canonicalizeWav(wav({ pcm: Buffer.alloc(321) }))
  check('奇数长度：截掉半个字节，长度变偶数', inspectWav(odd).ok === true && (odd.length - 44) % 2 === 0, { got: odd.length })

  check('不是 WAV：修不出来，明说', throwsWith(() => canonicalizeWav(Buffer.alloc(64, 1)), '不是 WAV'))
  check('采样率不对：修不出来，明说规格', throwsWith(() => canonicalizeWav(wav({ rate: 44100 })), '规格不对'))
  check('不是 PCM：修不出来，明说只收 PCM16', throwsWith(() => canonicalizeWav(wav({ pcmFormat: 3 })), 'PCM16'))
  check('没有音频数据：修不出来，明说', throwsWith(() => canonicalizeWav(wav({ pcm: Buffer.alloc(0) })), '没有音频数据'))
}

// ================================================================ 转规格
{
  const ok = await toWav16k({ buffer: wav({ rate: 44100 }), tmpDir, run: fakeRun })
  check('转规格：交给 ffmpeg 后拿回规范 WAV', inspectWav(ok).ok === true, { got: ok.length })

  check('空音频：不硬转，直接说空', await throwsAsyncWith(() => toWav16k({ buffer: Buffer.alloc(0), tmpDir, run: fakeRun }), '空的'))

  const badRun = async () => { throw new Error('boom') }
  check('ffmpeg 挂了：翻成人话', await throwsAsyncWith(() => toWav16k({ buffer: wav(), tmpDir, run: badRun }), 'ffmpeg 转 16kHz WAV 失败'))

  const shortRun = async (_cmd, args) => { fs.writeFileSync(args[args.length - 1], Buffer.alloc(20)) }
  check('ffmpeg 产出的东西不对：不冒充成功', await throwsAsyncWith(() => toWav16k({ buffer: wav(), tmpDir, run: shortRun }), '不符合要求'))
}

// ================================================================ 转写
{
  check('没装识别服务：说清装哪个 bundle', await throwsAsyncWith(
    () => transcribeViaDsh({ service: undefined, wav: wav() }), '没启用'))

  const spec = { received: false }
  const svc = {
    resolve: (input) => { spec.received = input?.audio instanceof Uint8Array && input.audio.length > 44; return { ok: 1 } },
    transcribe: async () => ({ text: ' 我在 ', audioSeconds: 4.2, inferenceSeconds: 0.1 }),
  }
  const got = await transcribeViaDsh({ service: svc, wav: wav() })
  check('正常转写：去掉首尾空白，带秒数', got.text === '我在' && got.audioSeconds === 4.2, got)
  check('交给识别的是裸音频字节，不是 Buffer 壳', spec.received === true)

  check('识别返回空文本：不编字，报「太短或没人说话」', await throwsAsyncWith(
    () => transcribeViaDsh({ service: fakeService({ text: '   ' }), wav: wav() }), '空文本'))
}

// ================================================================ 整条入口
{
  const ok = await transcribeVoice({ buffer: wav({ rate: 44100 }), ext: 'wav', tmpDir, run: fakeRun, service: fakeService({ text: '晚安', audioSeconds: 2 }) })
  check('入口：音频进来，一行字出去', ok.text === '晚安' && ok.wavBytes > 44 && ok.audioSeconds === 2, ok)

  check('入口：空音频不装成功', await throwsAsyncWith(
    () => transcribeVoice({ buffer: Buffer.alloc(0), tmpDir, run: fakeRun, service: fakeService({ text: 'x' }) }), '空的'))

  check('入口：服务空文本照样报出来', await throwsAsyncWith(
    () => transcribeVoice({ buffer: wav(), tmpDir, run: fakeRun, service: fakeService({ text: '' }) }), '空文本'))

  let ran = false
  const spy = async () => { ran = true }
  const direct = await transcribeVoice({ buffer: wav(), tmpDir, run: spy, service: fakeService({ text: '好', audioSeconds: 1 }) })
  check('入口：已经是规范 WAV 时不叫 ffmpeg', ran === false && direct.text === '好', { ran, text: direct.text })
}

// ================================================================ 人话原因
{
  check('异常：模型要下载 → 说下载', explainDshError(new Error('download model failed')).includes('下载'))
  check('异常：没有提供方 → 说没装识别', explainDshError(new Error('provider unavailable')).includes('没有可用的本地识别'))
  check('异常：别的 → 带上原话，不吞', explainDshError(new Error('socket hang up')).includes('socket hang up'))
}

try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* 删不掉不影响判定 */ }

console.log('\n通过 ' + pass + ' / ' + (pass + fail))
if (fail) process.exitCode = 1
