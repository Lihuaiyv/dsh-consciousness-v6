/** 读口统一（P3）：开关默认 off；开了只挑一条、≤60 字；旧路可回。 */
import { makeWorld } from './eval-persona/setup.mjs'
import { unifiedReadOn, pickReadLine } from '../src/modules/read_port.js'

let pass = 0, fail = 0
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log('PASS', name) } else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 300)) }
}

const w = makeWorld()
const { db } = w
const aid = db.prepare("SELECT id FROM agents ORDER BY (status='active') DESC LIMIT 1").all()[0].id
try {
  check('读口：默认关', unifiedReadOn(db, aid) === false)
  db.prepare("INSERT INTO flags(key,value) VALUES('read.port.unified','on') ON CONFLICT(key) DO UPDATE SET value='on'").run()
  check('读口：翻 on 生效', unifiedReadOn(db, aid) === true)

  const none = pickReadLine(db, aid, { query: '想不起来的事' })
  check('读口：池子空就 null', none === null, none)

  const mem = [{ id: 'm1', text: '你以前说过：先写验收再动代码', score: 0.8, confidence: 0.7, type: 'fact' }]
  const one = pickReadLine(db, aid, { query: '写验收', memories: mem })
  check('读口：只挑一条', !!one && typeof one.line === 'string', one)
  check('读口：带来源前缀', !!one && /^〔记忆〕/.test(one.line), one && one.line)
  check('读口：单条 ≤60 字', !!one && one.text.length <= 60, one && one.text.length)
} finally {
  try { w.close && w.close() } catch { /* ignore */ }
}
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
