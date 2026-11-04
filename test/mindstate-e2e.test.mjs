/**
 * 端到端：mock 宿主 + apply() + systemPrompt 真拼装，看状态行会不会进提示词。
 * 跑法：node test/mindstate-e2e.test.mjs
 *
 * 不启真 DSH：只用 createHost 的 direct/inject 两条路里的一条，
 * 把 apply() 跑起来，再从 section 的 text() 里看结果。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, now } from '../src/db.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-mind-e2e-'))
process.env.DSH_HOME = dir

const DB_PATH = path.join(dir, 'consciousness', 'app.db')
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true })

// 先把库和 agent 建好：apply() 里的 ensureDb 会接管同一个文件。
const seed = openDb(DB_PATH)
const AID = 'agt_mind_e2e'
seed.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(AID, '小汐', 'chat', 'active', now())
seed.close()

const { apply, debugNoteSessionMeter, _resetMeterThrottle } = await import('../index.js')
const { _resetMindState } = await import('../src/modules/mindstate.js')
const { writeParam } = await import('../src/kernel.js')

let pass = 0
let fail = 0
function check(name, ok, extra) {
  if (ok) { pass++; console.log('  ✓ ' + name) } else { fail++; console.log('  ✗ ' + name, extra === undefined ? '' : JSON.stringify(extra)) }
}

const seen = { sections: [] }
const disposers = []
const child = {
  effect: (f) => f(),
  systemPrompt: { section: (sec) => { seen.sections.push(sec); return () => {} } },
  webServer: { register: () => () => {} },
  tools: { register: () => () => {}, guard: () => () => {} },
  commands: { register: () => () => {} },
}
const ctx = {
  on: () => () => {},
  inject: (deps, fn) => { fn(child) },
  get: () => null,
  effect: (f) => f(),
  dispose: () => {},
}

try { apply(ctx) } catch (e) { console.log('apply 抛错: ' + (e && e.message)) }

const section = seen.sections.find((s) => s && s.name === 'dsh-consciousness')
check('apply 后注册了 dsh-consciousness 段', !!section, seen.sections.map((s) => s && s.name))

if (section && typeof section.text === 'function') {
  // 没有任何水位/欠债时：不该凭空多一段
  _resetMindState()
  const before = String(section.text({}) || '')
  check('没有水位：提示词里没有【状态】', !before.includes('【状态】'), before.slice(-120))

  // 喂一个 70% 的水位：该开口
  _resetMeterThrottle()
  const session = { id: 'sess-e2e', requestContext: () => ({ provider: 'p', model: 'm', contextWindow: 100000 }) }
  debugNoteSessionMeter({ agent: { session } }, () => 72000)
  const after = String(section.text({}) || '')
  check('70% 水位：提示词里出现【状态】', after.includes('【状态】'), after.slice(-160))
  check('70% 水位：出现「快到上限」', after.includes('快到上限'), after.slice(-160))

  // 调高门槛到 0.98：同一份水位不该再开口
  const db2 = openDb(DB_PATH)
  writeParam(db2, AID, 'mind.meter.ratio', 0.98)
  db2.close()
  const quiet = String(section.text({}) || '')
  check('门槛调到 0.98：同一水位沉默', !quiet.includes('快到上限'), quiet.slice(-120))

  // 关掉总开关
  const db3 = openDb(DB_PATH)
  writeParam(db3, AID, 'mind.meter.enable', 'off')
  writeParam(db3, AID, 'mind.meter.ratio', 0.6)
  db3.close()
  const off = String(section.text({}) || '')
  check('总开关 off：沉默', !off.includes('【状态】'), off.slice(-120))

  // 整体模拟：一轮轮用着变满 → 提醒 → 压缩后自己消失（不用谁去擦）
  const db4 = openDb(DB_PATH)
  writeParam(db4, AID, 'mind.meter.enable', 'on')
  db4.close()
  const seq = [30000, 55000, 68000, 75000, 20000]
  const expect = [false, false, true, true, false]
  for (let i = 0; i < seq.length; i++) {
    _resetMeterThrottle()
    debugNoteSessionMeter({ agent: { session } }, () => seq[i])
    const text = String(section.text({}) || '')
    const has = text.includes('快到上限')
    check('序列 ' + (i + 1) + '（' + (seq[i] / 1000) + '%）：' + (expect[i] ? '开口' : '沉默'), has === expect[i], text.slice(-100))
  }
}

_resetMindState()
console.log('')
console.log('通过 ' + pass + ' / ' + (pass + fail))
if (fail) process.exit(1)
// apply() 里挂着维护定时器，收尾直接退，别等它。
process.exit(0)
