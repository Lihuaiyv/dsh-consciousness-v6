/**
 * 语音壳（行动层）· 考卷
 *
 * 管的是「两个零件接到工具上」这一段：配置怎么折、文件怎么读、没配好怎么说人话。
 * 它不考转码和合成本身——那是 exam-ear / exam-mouth 的事。
 *
 * 运行：node test/voice-tools.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { saveConfig } from '../src/modules/actions/channels.js'
import { voiceConfigOf, executeHear, executeSay } from '../src/modules/actions/voice.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 300)) }
}
const throwsWith = async (fn, needle) => {
  try { await fn(); return false } catch (e) { return String(e?.message ?? e).includes(needle) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-voicetools-'))
const db = openDb(path.join(dir, 'app.db'))
const wav = (() => {
  const b = Buffer.alloc(44 + 64)
  b.write('RIFF', 0, 'ascii'); b.writeUInt32LE(36 + 64, 4); b.write('WAVE', 8, 'ascii')
  b.write('fmt ', 12, 'ascii'); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20)
  b.writeUInt16LE(1, 22); b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28)
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36, 'ascii'); b.writeUInt32LE(64, 40)
  return b
})()
const fakeFetch = (body) => async () => ({
  ok: true, status: 200,
  arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  text: async () => String(body),
  json: async () => ({}),
})

// ================================================================ 配置怎么折
{
  const d = voiceConfigOf({})
  check('配置全空：默认走微软、地址留空', d.ttsProvider === 'azure' && d.ttsBaseUrl === '', d)
  const m = voiceConfigOf({
    'voice.provider': 'local', 'voice.local_ref': 'r.wav', 'voice.local_prompt': '提示',
    'voice.base_url': 'https://x/v1', 'voice.api_key': 'k', 'voice.name': 'v',
  })
  check('设置里的 voice.* 折成零件认的字段',
    m.ttsProvider === 'local' && m.ttsLocalRefAudio === 'r.wav' && m.ttsLocalPromptText === '提示' && m.ttsApiKey === 'k', m)
  check('没填的项不会变成字符串 undefined',
    Object.values(voiceConfigOf({ 'voice.provider': 'compat' })).every((v) => v !== 'undefined'), voiceConfigOf({}))
}

// ================================================================ 听见（走不到 ffmpeg 的那几种）
{
  const anyFile = path.join(dir, 'any.wav')
  fs.writeFileSync(anyFile, wav)
  check('没给路径：问要听哪个文件', await throwsWith(() => executeHear({ args: {} }), '本地音频路径'))
  check('文件不存在：明说哪个找不到', await throwsWith(() => executeHear({ args: { path: path.join(dir, 'nope.wav') } }), '找不到这个文件'))
  check('没有识别服务：指向要装的那个包', await throwsWith(
    () => executeHear({ args: { path: anyFile }, getSpeech: () => null }), '语音识别服务'))
}

// ================================================================ 出声
{
  check('空文本：不说空话', await throwsWith(() => executeSay({ db, agentId: 'a1', args: {} }), '要念什么'))
  check('太长：不硬念', await throwsWith(() => executeSay({ db, agentId: 'a1', args: { text: '啊'.repeat(601) } }), '600'))

  check('没配密钥：明说缺哪一项，不发请求', await throwsWith(
    () => executeSay({ db, agentId: 'a1', args: { text: '在' } }), '没配密钥'))

  saveConfig(db, 'a1', { 'voice.provider': 'local', 'voice.local_ref': 'ref.wav', 'voice.play': false })
  const out = await executeSay({ db, agentId: 'a1', args: { text: '哄你' }, fetchImpl: fakeFetch(wav) })
  check('本机嗓子配好了：生成文件并落盘', out.ok === true && out.format === 'wav' && fs.existsSync(out.file), out)
  check('设置里关了播放：不播，也不假装播了', out.played === false && out.bytes > 44, out)
  check('文件真的是音频（不是空壳）', fs.readFileSync(out.file).toString('ascii', 0, 4) === 'RIFF')

  const html = Buffer.from('<html>502</html>')
  check('嗓子回错误页：不落盘当成功', await throwsWith(
    () => executeSay({ db, agentId: 'a1', args: { text: '在' }, fetchImpl: fakeFetch(html) }), '不是音频'))
}

try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 删不掉不影响判定 */ }
console.log('\n通过 ' + pass + ' / ' + (pass + fail))
if (fail) process.exitCode = 1
