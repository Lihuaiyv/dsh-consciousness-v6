/**
 * 个人基线 · 考卷
 *
 * 管的是「这一句跟他自己平时比，变了多少」：冷启动只记不判、过了冷启动才提、
 * 太短的不进基线、一个人一个基线。
 *
 * 运行：node test/voice-baseline.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { applyBaseline, describeDrift, readBaseline, speechRateOf, VOICE_BASELINE_TUNING as T } from '../src/modules/voice_baseline.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 300)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-voicebase-'))
const db = openDb(path.join(dir, 'app.db'))
const AGENT = 'agt_base'

// 造一段「声音形状」：默认是一个平稳的中音。
function shapeOf({ pitch = 200, loud = 0.10, periodicity = 0.9, voiced = 0.8 } = {}) {
  return {
    seconds: 2, voicedRatio: voiced, pauses: 0, phrases: 1,
    loudness: loud, dynamic: 0.2, pitchHz: pitch,
    periodicity, pitchSlopeSt: 0,
  }
}
const TEXT = '好的好的我知道了' // 8 个字 / 2 秒 = 4 字/秒

// ---------------------------------------------------------------- 冷启动
{
  let last = null
  for (let i = 0; i < T.warmupSamples; i++) last = applyBaseline(db, { agentId: AGENT, shape: shapeOf(), text: TEXT })
  check(`前 ${T.warmupSamples} 次只记不判：还没热身够`, last && last.warmed === false, last)
  check('样本数照常累加', last && last.samples === T.warmupSamples, last && last.samples)
  check('冷启动期间不给「比平时」的结论', describeDrift(last.drift, last.warmed) === '', describeDrift(last.drift, last.warmed))
  const row = readBaseline(db, AGENT)
  check('库里有这个人的基线', row && row.pitch_hz != null, row && row.pitch_hz)
  check('基线音高贴着 200', row && Math.abs(row.pitch_hz - 200) < 1, row && row.pitch_hz)
}

// ---------------------------------------------------------------- 过了冷启动
{
  const r = applyBaseline(db, { agentId: AGENT, shape: shapeOf(), text: TEXT })
  check(`第 ${T.warmupSamples + 1} 次算热身完了`, r && r.warmed === true, r && r.warmed)
  check('同一个音：不硬说「比平时」', describeDrift(r.drift, r.warmed) === '', describeDrift(r.drift, r.warmed))
}

// ---------------------------------------------------------------- 明显偏高
{
  // 260 / 200 = 1.3 倍，约 4.5 个半音，过门槛。
  const r = applyBaseline(db, { agentId: AGENT, shape: shapeOf({ pitch: 260 }), text: TEXT })
  check('音高明显高了：说「比平时高」', describeDrift(r.drift, r.warmed).includes('比平时高'), describeDrift(r.drift, r.warmed))
  const row = readBaseline(db, AGENT)
  check('基线被这次拉动了一点，但没被拉满', row && row.pitch_hz > 200 && row.pitch_hz < 260, row && row.pitch_hz)
}

// ---------------------------------------------------------------- 语速
{
  const r = applyBaseline(db, { agentId: AGENT, shape: shapeOf({ pitch: 205 }), text: '好的好的好的好的好的好的好的好的好的好的' })
  check('语速快了一大截：说「比平时快」', describeDrift(r.drift, r.warmed).includes('比平时快'), describeDrift(r.drift, r.warmed))
}

// ---------------------------------------------------------------- 太短不进基线
{
  const before = readBaseline(db, AGENT)
  const short = { ...shapeOf(), voicedRatio: 0.05 }
  const r = applyBaseline(db, { agentId: AGENT, shape: short, text: '嗯' })
  const after = readBaseline(db, AGENT)
  check('几乎没声音：不取样', r.samples === before.samples && after.samples === before.samples, { before: before.samples, after: after.samples })
  check('没音高：不取样', applyBaseline(db, { agentId: AGENT, shape: { ...shapeOf(), pitchHz: null } }).samples === before.samples)
  check('形状为空：不炸、不多记', applyBaseline(db, { agentId: AGENT, shape: null }).samples === before.samples)
}

// ---------------------------------------------------------------- 一人一份
{
  const other = applyBaseline(db, { agentId: 'agt_other', shape: shapeOf({ pitch: 400 }), text: TEXT })
  check('别人是另一份基线', other.samples === 1 && readBaseline(db, AGENT).samples > 1, { other: other.samples, mine: readBaseline(db, AGENT).samples })
  check('别人的高音不会污染我的基线', readBaseline(db, AGENT).pitch_hz < 260, readBaseline(db, AGENT).pitch_hz)
}

// ---------------------------------------------------------------- 阈值与语速
{
  const low = { pitchSt: 2.9, loudRatio: 1.0, periodicityDelta: 0, cpsRatio: 1.0 }
  check('差 2.9 个半音：不够格，不说', describeDrift(low, true) === '', describeDrift(low, true))
  const high = { pitchSt: 3.1, loudRatio: 1.0, periodicityDelta: 0, cpsRatio: 1.0 }
  check('差 3.1 个半音：说「高」', describeDrift(high, true) === '比平时高', describeDrift(high, true))
  check('没热身：再大的差也不说', describeDrift(high, false) === '', describeDrift(high, false))
  check('最多说两件', describeDrift({ pitchSt: 5, loudRatio: 2, periodicityDelta: -0.5, cpsRatio: 2 }, true).split('、').length <= 2)
}

{
  check('语速：8 字 2 秒 = 4 字/秒', Math.abs(speechRateOf('好的好的我知道了', 2) - 4) < 0.01, speechRateOf('好的好的我知道了', 2))
  check('语速：标点不算字', Math.abs(speechRateOf('好，的。好！', 2) - 1.5) < 0.01, speechRateOf('好，的。好！', 2))
  check('语速：没字就是 null', speechRateOf('', 2) === null && speechRateOf('嗯', 2) === null)
}

console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) { console.log('失败：', fail); process.exit(1) }
