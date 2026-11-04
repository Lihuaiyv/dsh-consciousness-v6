/**
 * feel 工具 / 注入行的「真接线」：不是单测形状，而是走一遍 apply()，
 * 看宿主那六个接缝上到底有没有它。
 * 运行：node test/feel-wire.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, now } from '../src/db.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-feel-wire-'))
process.env.DSH_HOME = dir
const DB_PATH = path.join(dir, 'consciousness', 'app.db')
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true })

const AID = 'agt_feel_wire'
const OWNER = '10001'
{
  const seed = openDb(DB_PATH)
  seed.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
    .run(AID, '小汐', 'chat', 'active', now())
  seed.close()
}

const { apply, hostReport } = await import('../index.js')
const { writeParam } = await import('../src/kernel.js')

let pass = 0
let fail = 0
function check(name, ok, extra) {
  if (ok) { pass++; console.log('  ✓ ' + name) } else { fail++; console.log('  ✗ ' + name, extra === undefined ? '' : JSON.stringify(extra).slice(0, 300)) }
}

{
  const d = openDb(DB_PATH)
  writeParam(d, AID, 'qq.bridge.owner_qq', OWNER)
  d.close()
}

const seen = { tools: [], sections: [], guards: [] }
const child = {
  effect: (f) => f(),
  systemPrompt: { section: (sec) => { seen.sections.push(sec); return () => {} } },
  webServer: { register: () => () => {} },
  tools: { register: (def) => { seen.tools.push(def); return () => {} }, guard: (g) => { seen.guards.push(g); return () => {} } },
  commands: { register: () => () => {} },
}
const ctx = { on: () => () => {}, inject: (deps, fn) => fn(child), get: () => null, effect: (f) => f(), dispose: () => {} }
try { apply(ctx) } catch (e) { console.log('apply 抛错: ' + (e && e.message)) }

const rep = hostReport()
check('宿主报告：tools 这层是 ok', !!rep && rep.seams.some((s) => s.seam === 'tools' && s.level === 'ok'), rep && rep.summary)
const feel = seen.tools.find((t) => t.name === 'feel')
check('apply 之后 feel 真注册出去了', !!feel, seen.tools.map((t) => t.name))
check('注册时没被宿主判成不合规（否则 tools 这层会是 degraded）', !!rep && !/tools=degraded/.test(rep.summary), rep && rep.summary)

// 提示词段：section 的 text() 里应当有 feel 那条通路（只在主人会话里给）
const sec = seen.sections[0]
if (sec && typeof sec.text === 'function') {
  const t = String(sec.text({}) || '')
  check('主人会话的提示词里有 feel 指引', t.includes('先用 feel 记一句'), t.length)
} else {
  check('systemPrompt.section 注册到了', false, sec && Object.keys(sec))
}

console.log('')
console.log('通过 ' + pass + ' / ' + (pass + fail))
process.exit(fail ? 1 : 0)
