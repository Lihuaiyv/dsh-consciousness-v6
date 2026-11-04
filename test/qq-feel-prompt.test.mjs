/**
 * QQ 的 feel 段：借桥接插件的 provider 扩展点，把「先用 feel 记一句」和
 * 「我上一句说出来之前…」挂进 QQ 会话。
 * 钉住三条：主人私聊有、客人和群聊没有、超过窗口的旧 feel 不冒充。
 * 运行：node test/qq-feel-prompt.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { setParam, getParam } from '../src/kernel.js'
import { attachQQFeelProvider, buildQQFeelText, QQ_FEEL_SECTION_NAME } from '../src/modules/qq_bridge.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name) } else { fail++; console.log('FAIL ' + name + '  ' + JSON.stringify(detail === undefined ? '' : detail).slice(0, 300)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-qqfeelprompt-'))
const db = openDb(path.join(dir, 'app.db'))
const AID = 'agt_qqfeelprompt'
const OWNER = '3192248859'
const SID = 'qq-0123456789abcdef01234567-abc'

db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(AID, '小汐', 'daily', 'active', new Date().toISOString())
setParam(db, AID, 'qq.bridge.enable', { value: 'on' })
setParam(db, AID, 'qq.bridge.owner_qq', { value: OWNER })

function feel(agoMin, text) {
  db.prepare('INSERT INTO affect_feel(id,agent_id,at,text,label,fast,slow,total,session_id,source) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run('afe_' + Math.random().toString(36).slice(2, 8), AID, new Date(Date.now() - agoMin * 60000).toISOString(), text, 'joy', 0.1, 0.2, 0.3, SID, 'tool')
}

// 假桥接：只留 registerToolProvider，把 provider 存下来
let provider = null
const api = { registerToolProvider: (fn) => { provider = fn; return () => { provider = null } } }
const ctx = { get: (name) => (name === 'qqBridge' ? api : null), on: () => () => {} }
const param = (k) => getParam(db, AID, k)
const h = attachQQFeelProvider({ getCtx: () => ctx, getDb: () => db, getAid: () => AID, resolveAid: () => AID, param })
check('provider 注册上了', h.attached === true && typeof provider === 'function', h)

const run = (route) => provider({ route, agentCtx: { agent: { id: SID } } })
const textOf = (res) => ((res.sections || []).map((s) => s.text).join('\n'))
const owner = { messageType: 'private', targetId: Number(OWNER) }

// 1) 主人私聊 + 窗口内的 feel：指引和我那句都在
feel(3, '刚被夸了一句，心里有点亮')
{
  const res = run(owner)
  const text = textOf(res)
  check('主人私聊有且只有一段', (res.sections || []).length === 1, res)
  check('段名固定（可追踪）', (res.sections || [])[0]?.name === QQ_FEEL_SECTION_NAME, res.sections)
  check('带「先用 feel 记一句」', text.includes('先用 feel 记一句'), text)
  check('带我上一句写下的 feel', text.includes('刚被夸了一句'), text)
  check('标明是我自己的话、不是对方说的', text.includes('这是我自己的话'), text)
}

// 2) 客人私聊：一点不给
check('客人私聊没有 feel 段', (run({ messageType: 'private', targetId: 99999 }).sections || []).length === 0)

// 3) 群聊：哪怕主人在群里也不给（群是共用对话，亲密材料不能漏）
check('群聊没有 feel 段', (run({ messageType: 'group', targetId: 123456 }).sections || []).length === 0)
check('主人在群里也不给', (run({ messageType: 'group', targetId: Number(OWNER) }).sections || []).length === 0)

// 4) 太旧：指引留着（让它下一句开始写），旧感觉不冒充
db.prepare("UPDATE affect_feel SET at=? WHERE agent_id=? AND text LIKE '%刚被夸%'").run(new Date(Date.now() - 3 * 3600000).toISOString(), AID)
{
  const text = textOf(run(owner))
  check('超 2 小时的旧 feel 不出现', !text.includes('刚被夸了一句'), text)
  check('指引仍留着', text.includes('先用 feel 记一句'), text)
}

// 5) 一次 feel 都没有：只有指引，不编一句
{
  const text = buildQQFeelText(db, 'agt_none_yet', { isOwner: true })
  check('没有 feel 时只剩指引', text.startsWith('开口之前') && !text.includes('我上一句说出来之前'), text)
}

// 6) 两个开关：总闸关 / 注入关，都不给
setParam(db, AID, 'affect.feel.inject', { value: 'off' })
check('affect.feel.inject=off 时不给', (run(owner).sections || []).length === 0)
setParam(db, AID, 'affect.feel.inject', { value: 'on' })
setParam(db, AID, 'qq.bridge.enable', { value: 'off' })
check('qq.bridge.enable=off 时不给', (run(owner).sections || []).length === 0)

// 7) 归属按「这条 QQ 会话自己是谁」找，不按当前激活人格（真机踩过的坑）：
//    宿主的 active agent 可能是别的人格，qq.bridge.enable 就读到 off，provider 静默给空。
setParam(db, AID, 'qq.bridge.enable', { value: 'on' })
{
  const OTHER = 'agt_other_persona'
  db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
    .run(OTHER, '另一个人格', 'daily', 'active', new Date().toISOString())
  let provider2 = null
  const api2 = { registerToolProvider: (fn) => { provider2 = fn; return () => {} } }
  const ctx2 = { get: (name) => (name === 'qqBridge' ? api2 : null), on: () => () => {} }
  const h2 = attachQQFeelProvider({ getCtx: () => ctx2, getDb: () => db, getAid: () => OTHER, resolveAid: () => OTHER, param: () => undefined })
  check('第二份 provider 也注册上了', h2.attached === true, h2)
  const run2 = (route) => provider2({ route, key: 'u:' + OWNER, agentCtx: { agent: { id: SID } } })
  check('只看激活人格的话会读到 off、给空（旧 bug 的样子）', (run2(owner).sections || []).length === 0)
  db.prepare("INSERT INTO conversations(conversation_id,agent_id,channel,state,created_at) VALUES(?,?,?,?,?)")
    .run('qq:p:' + OWNER, AID, 'qq', 'active', new Date().toISOString())
  check('按 QQ 会话自己的归属找到小汐：给了', (run2(owner).sections || []).length === 1)
}

db.close()
console.log('\n通过 ' + pass + ' / ' + (pass + fail))
if (fail) { console.log('失败:', fail); process.exit(1) }
