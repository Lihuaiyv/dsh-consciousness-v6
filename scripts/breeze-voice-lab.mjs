/**
 * 造嗓子的小工作台：描述 → 候选 → 试听 → 存成自己的音色。
 *
 * 只做三件事，不播声音、不进对话：
 *   node scripts/breeze-voice-lab.mjs design "清亮、轻软，平时有点小迷糊" [--count 3]
 *   node scripts/breeze-voice-lab.mjs preview <generated_voice_id> [--out x.mp3]
 *   node scripts/breeze-voice-lab.mjs save <generated_voice_id> [--name 小汐] [--desc "…"]
 *
 * 密钥只从环境变量读，不进命令行参数（别留进历史）：
 *   BREEZE_API_KEY=brz_...
 * 想换地址：BREEZE_BASE_URL=https://api.breeze.blue
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  breezeDesignPreviews,
  breezePreviewAudio,
  breezeSaveDesignPreview,
} from '../src/parts/mouth/providers.js'

const KEY = process.env.BREEZE_API_KEY || ''
const config = {
  ttsApiKey: KEY,
  ttsBreezeUrl: process.env.BREEZE_BASE_URL || 'https://api.breeze.blue',
  ttsBreezeModel: process.env.BREEZE_MODEL || 'breeze-tts-2',
  ttsBreezeLanguage: process.env.BREEZE_LANG || 'zh',
}

function flag(name, fallback = '') {
  const i = process.argv.indexOf('--' + name)
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

function outDir() {
  const dir = flag('out-dir', path.join(os.tmpdir(), 'breeze-voices'))
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function needKey() {
  if (!KEY) {
    console.error('没有密钥：先设环境变量 BREEZE_API_KEY（brz_ 开头）。')
    process.exit(2)
  }
}

async function main() {
  const cmd = process.argv[2] || ''
  if (cmd === 'design') {
    needKey()
    const description = process.argv.slice(3).filter((a) => !a.startsWith('--')).join(' ')
    if (!description.trim()) {
      console.error('给一句描述，比如：node scripts/breeze-voice-lab.mjs design "清亮、轻软，平时有点小迷糊"')
      process.exit(2)
    }
    const { previews, text } = await breezeDesignPreviews(
      { ...config, ttsBreezePreviewCount: Number(flag('count', '3')) || 3 },
      description,
    )
    console.log('候选 ' + previews.length + ' 个' + (text ? '（试听台词：' + text + '）' : ''))
    const dir = outDir()
    let i = 0
    for (const p of previews) {
      i++
      const id = p.generated_voice_id || p.generatedVoiceId || ''
      if (!id) { console.log('  #' + i + ' 没有 generated_voice_id，跳过'); continue }
      const out = path.join(dir, 'candidate-' + i + '.mp3')
      try {
        const { audio } = await breezePreviewAudio(config, id)
        fs.writeFileSync(out, audio)
        console.log('  #' + i + '  ' + id + '  → ' + out)
      } catch (e) {
        console.log('  #' + i + '  ' + id + '  （试听没取到：' + (e && e.message) + '）')
      }
    }
    console.log('\n听完挑一个：node scripts/breeze-voice-lab.mjs save <id> --name 小汐')
    return
  }
  if (cmd === 'preview') {
    needKey()
    const id = process.argv[3]
    if (!id) { console.error('给 generated_voice_id'); process.exit(2) }
    const out = flag('out', path.join(outDir(), 'preview-' + id + '.mp3'))
    const { audio } = await breezePreviewAudio(config, id)
    fs.writeFileSync(out, audio)
    console.log('写到 ' + out + '（' + audio.length + ' 字节）')
    return
  }
  if (cmd === 'save') {
    needKey()
    const id = process.argv[3]
    if (!id) { console.error('给 generated_voice_id'); process.exit(2) }
    const saved = await breezeSaveDesignPreview(config, id, {
      name: flag('name', '小汐'),
      description: flag('desc', ''),
    })
    console.log('存好了：' + (saved.voice_name || '') + '  voice_id=' + saved.voice_id)
    console.log('把它填进设置 → 意识 → 驱动 → 行动接口 → 嗓子：BreezeBlue 的那个音色 ID。')
    return
  }
  console.log('用法：design "描述" | preview <id> | save <id> --name 小汐')
  process.exitCode = 2
}

main().catch((e) => {
  console.error('失败：' + (e && e.message ? e.message : e))
  process.exitCode = 1
})
