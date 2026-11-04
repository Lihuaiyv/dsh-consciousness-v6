/**
 * 第 4 步端到端：writeMutter 真正把 feel 和 unsaid 交给模型，并把结果写回 flags。
 * 用本地假模型服务验证「喂进去的 messages」，不调真模型。
 * 运行：node test/mutter-e2e.test.mjs
 */
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name + '  ' + JSON.stringify(detail === undefined ? '' : detail).slice(0, 400)) }
}

// 假模型：把请求体记下来，回一段像嘀咕的固定文本
let lastReq = null
const server = http.createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    try { lastReq = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { lastReq = {} }
    const body = JSON.stringify({ choices: [{ message: { content: '这句问得轻，我心里其实先沉了一下，又不想让她看出来。' } }] })
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(body)
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
process.env.DSHC_MODEL_URL = 'http://127.0.0.1:' + server.address().port
process.env.DSHC_MODEL_NAME = 'fake'

const { openDb } = await import('../src/db.js')
const { attachDb } = await import('../src/algo/index.js')
const { writeMutter } = await import('../src/features.js')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-muttere2e-'))
const db = openDb(path.join(dir, 'app.db'))
attachDb(db)
const aid = 'agt_muttere2e'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid, '嘀咕E2E', 'daily', 'active', new Date().toISOString())

function feel(agoMin, text) {
  db.prepare('INSERT INTO affect_feel(id,agent_id,at,text,label,fast,slow,total,session_id,source) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run('afe_e2e', aid, new Date(Date.now() - agoMin * 60000).toISOString(), text, 'calm', 0.1, 0.2, 0.3, null, 'tool')
}
function unsaid(cause, text) {
  db.prepare('INSERT INTO events VALUES(?,?,?,?,?)')
    .run('evt_e2e', aid, 'unsaid.moment', JSON.stringify({ text, event_id: null, cause }), new Date().toISOString())
}

feel(3, '有点想被多问一句')
unsaid('你最近还好吗', '其实不太好，但不想说')
const turns = [{ role: 'user', text: '你最近还好吗' }, { role: 'assistant', text: '还行，你呢。' }]
const out = await writeMutter(db, aid, turns)

check('writeMutter 返回了嘀咕', !!out && typeof out.text === 'string' && out.text.length > 0, out)
check('嘀咕内容来自模型（不是拼贴）', out && out.text.includes('心里其实先沉了一下'), out && out.text)
check('写进了 flags', (() => { try { return !!db.prepare("SELECT value FROM flags WHERE key=?").get('ui.mutter.' + aid) } catch { return false } })(), null)

const msgs = (lastReq && lastReq.messages) || []
const sys = msgs.find((m) => m.role === 'system')
const user = msgs.find((m) => m.role === 'user')
check('system 在，且不是空的', sys && sys.content && sys.content.length > 20, sys && sys.content && sys.content.slice(0, 40))
check('user 里带自己写下的 feel', user && user.content.includes('（我自己之前写下的：有点想被多问一句）'), user && user.content.slice(0, 120))
check('user 里带咽回去的半句', user && user.content.includes('（这一轮咽回去的半句：其实不太好，但不想说）'), user && user.content.slice(0, 160))
check('user 里带带标签的对话', user && user.content.includes('user: 你最近还好吗') && user.content.includes('assistant: 还行，你呢。'), user && user.content.slice(-80))
check('材料在对话之前', user && user.content.indexOf('（我自己之前写下的：') < user.content.indexOf('user: 你最近还好吗'), null)
check('system 提示词不再规定 80～130 字', sys && !/80～130/.test(sys.content), sys && /80～130/.test(sys.content))

server.close()
db.close()
console.log('\n通过 ' + pass + ' / ' + (pass + fail))
if (fail) { console.log('失败:', fail); process.exit(1) }
