/**
 * 认人硬闸 · 宿主接线端到端。
 * 跑法：node test/owner-gate-host.test.mjs
 *
 * 单测（owner-gate.test.mjs）验的是判定和守卫函数本身；
 * 这个文件验的是**它真的被插进宿主了**：apply() 之后 tools.guard 被调过一次，
 * 拿到的那个守卫真能挡住客人、放过主人，并且注册出去的 memory_search 自己也拦得住。
 *
 * 不启真 DSH：mock ctx，只走 inject(['tools']) 那条路。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, now } from '../src/db.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-gate-e2e-'))
process.env.DSH_HOME = dir
const DB_PATH = path.join(dir, 'consciousness', 'app.db')
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true })

const AID = 'agt_gate_e2e'
const OWNER = '10001'
const seed = openDb(DB_PATH)
seed.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(AID, '小汐', 'chat', 'active', now())
seed.close()

const { apply } = await import('../index.js')
const { qqSessionPrefix } = await import('../src/modules/qq_bridge.js')
const { PARAMS, writeParam } = await import('../src/kernel.js')
const { REASON_GUEST } = await import('../src/modules/owner_gate.js')

let pass = 0
let fail = 0
function check(name, ok, extra) {
  if (ok) { pass++; console.log('  ✓ ' + name) } else { fail++; console.log('  ✗ ' + name, extra === undefined ? '' : JSON.stringify(extra)) }
}

const OWNER_SID = qqSessionPrefix('u:' + OWNER) + '-o1'
const STRANGER_SID = qqSessionPrefix('u:20002') + '-s1'

// 主人号先配好，再让 apply() 起插件
{
  const d = openDb(DB_PATH)
  writeParam(d, AID, 'qq.bridge.owner_qq', OWNER)
  d.close()
}

const seen = { guards: [], tools: [], sections: [] }
const child = {
  effect: (f) => f(),
  systemPrompt: { section: (sec) => { seen.sections.push(sec); return () => {} } },
  webServer: { register: () => () => {} },
  tools: {
    register: (def) => { seen.tools.push(def); return () => {} },
    guard: (g) => { seen.guards.push(g); return () => {} },
  },
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

// ---------------------------------------------------------------- 接线
check('参数表里有 gate.guest.enable', Object.prototype.hasOwnProperty.call(PARAMS, 'gate.guest.enable'))
check('默认是开', PARAMS['gate.guest.enable'] && PARAMS['gate.guest.enable'][1] === 'on', PARAMS['gate.guest.enable'])
check('apply 之后真注册了守卫（不是只写好了放着）', seen.guards.length >= 1, seen.guards.length)
check('四个工具都在', seen.tools.map((t) => t.name).includes('memory_search'))

const guard = seen.guards[0]
if (typeof guard === 'function') {
  check('守卫挡住陌生人的 memory_search', guard({ name: 'memory_search', agent: { id: STRANGER_SID } }) === REASON_GUEST)
  check('守卫放过主人的 memory_search', guard({ name: 'memory_search', agent: { id: OWNER_SID } }) === undefined)
  check('守卫放过网页会话', guard({ name: 'memory_search', agent: { id: 'sess_web_e2e' } }) === undefined)
  check('守卫不管别的工具', guard({ name: 'act_browse', agent: { id: STRANGER_SID } }) === undefined)
  check('守卫对没有 agent 的调用不崩', guard({ name: 'memory_search' }) === undefined)
}

// ---------------------------------------------------------------- 第二道闸
const tool = seen.tools.find((t) => t.name === 'memory_search')
if (tool) {
  const refused = await tool.execute({ query: '主人的私事' }, { agent: { id: STRANGER_SID } })
  check('注册出去的 memory_search：客人这一层也拒', refused && refused.refused === REASON_GUEST, refused)
  check('拒绝时不带任何记忆内容', refused && refused.items === undefined)
  const rendered = tool.output.render({}, refused)
  check('渲染只出那句拒绝', rendered.length === 1 && rendered[0].text === REASON_GUEST, rendered)

  const okV = await tool.execute({ query: '咖啡' }, { agent: { id: OWNER_SID } })
  check('主人这条照常检索（不是被拒）', okV && okV.refused === undefined)
}

// ---------------------------------------------------------------- 关掉总开关
{
  const d = openDb(DB_PATH)
  writeParam(d, AID, 'gate.guest.enable', 'off')
  d.close()
  check('总开关 off：客人也放行（排查时能一键退回）', guard({ name: 'memory_search', agent: { id: STRANGER_SID } }) === undefined)
}

console.log('')
console.log('通过 ' + pass + ' / ' + (pass + fail))
if (fail) process.exit(1)
process.exit(0)
