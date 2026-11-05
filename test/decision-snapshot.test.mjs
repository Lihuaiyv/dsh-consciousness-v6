/**
 * 决策快照 + 手动拒绝的「安静多久」：给以后回放留粮，也让她拒绝时不冷冰冰。
 * 运行：node test/decision-snapshot.test.mjs
 *
 * 判据：
 * - 走完整判断的决策，落库的 chain 里有 input_snapshot（stage=full，带 trigger / hours_since）
 * - 开关关掉这种早返回，也有 stage 标记
 * - 手动叫她、她拒绝时，返回一个钟头数 + 一句人话，不硬顶
 */
import { makeWorld } from './eval-persona/setup.mjs'
import { addLoop } from '../src/modules/loops.js'
import {
  decideSpeak, recordProactiveDecision, listProactiveDecisions,
  proactiveTriggerOf, setProactivePrefs, queueProactive,
} from '../src/features.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) } else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)) }
}

const at = (ms) => new Date(Date.now() + ms).toISOString()
const w = makeWorld()
try {
  const prefs = { enabled: true, per_day: 1, idle_hours: 0, quiet: false }
  setProactivePrefs(w.db, w.aid, prefs)

  // ① 开关关掉：早返回也留 stage
  setProactivePrefs(w.db, w.aid, { ...prefs, enabled: false })
  const dOff = decideSpeak(w.db, w.aid)
  recordProactiveDecision(w.db, w.aid, dOff)
  const offRow = listProactiveDecisions(w.db, w.aid, 1)[0]
  check('开关关掉的决策有 stage=switch', !!offRow && offRow.chain.input_snapshot && offRow.chain.input_snapshot.stage === 'switch', offRow && offRow.chain)

  // ② 走完整判断：快照里有事由、隔了多久、人格轴
  setProactivePrefs(w.db, w.aid, prefs)
  addLoop(w.db, w.aid, { text: '明天提醒他看那份报告', due_at: at(-3600000) })
  const dFull = decideSpeak(w.db, w.aid, { trigger: proactiveTriggerOf(w.db, w.aid) })
  recordProactiveDecision(w.db, w.aid, dFull)
  const fullRow = listProactiveDecisions(w.db, w.aid, 1)[0]
  const snap = fullRow && fullRow.chain && fullRow.chain.input_snapshot
  check('完整决策有 stage=full', !!snap && snap.stage === 'full', snap && snap.stage)
  check('快照带事由', !!snap && !!snap.trigger && String(snap.trigger.text || '').includes('报告'), snap && snap.trigger)
  check('快照带隔了多久', !!snap && typeof snap.hours_since === 'number', snap && snap.hours_since)
  check('快照带人格轴', !!snap && !!snap.axes && typeof snap.axes.ei === 'number', snap && snap.axes)
  check('快照带缺口读数', !!snap && !!snap.deficit && typeof snap.deficit.min === 'number', snap && snap.deficit)
} finally { w.close() }

// ③ 手动叫她、她拒绝：给钟头数 + 人话，不硬顶（干净世界：没缺口、没开环）
const w2 = makeWorld()
try {
  setProactivePrefs(w2.db, w2.aid, { enabled: true, per_day: 1, idle_hours: 0, quiet: false })
  const out = await queueProactive(w2.db, w2.aid, { manual: true })
  check('手动拒绝：不硬顶（queued=false）', !!out && out.queued === false, out && out.queued)
  check('手动拒绝：给一个钟头数', !!out && typeof out.next_try_in_hours === 'number' && out.next_try_in_hours > 0, out && out.next_try_in_hours)
  check('手动拒绝：有一句人话', !!out && /安静/.test(String(out.note || '')), out && out.note)
} finally { w2.close() }

console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exitCode = 1
