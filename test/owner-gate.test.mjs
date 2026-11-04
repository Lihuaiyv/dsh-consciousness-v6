/**
 * owner_gate 单测：认人硬闸。
 * 跑法：node test/owner-gate.test.mjs
 *
 * 不挂宿主：判定和守卫都是纯函数 + 一个库，直接喂 sessionId。
 * 真机上「宿主到底会不会调这个守卫」由 check-host / 真机 ping 验，不在这里。
 */
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, now } from '../src/db.js'
import { writeParam } from '../src/kernel.js'
import { qqSessionPrefix } from '../src/modules/qq_bridge.js'
import {
  GATE_TOOL, REASON_GUEST, REASON_GROUP, REASON_UNSET, EVENT_DENIED, EVENT_UNGATED,
  guestVerdict, ownerQqList, verdictFor, makeOwnerGuard,
} from '../src/modules/owner_gate.js'
import { createActionTools } from '../src/modules/actions/index.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-gate-'))
const db = openDb(path.join(dir, 'app.db'))
let pass = 0
let fail = 0
function check(name, ok, extra) {
  if (ok) { pass++; console.log('  ✓ ' + name) } else { fail++; console.log('  ✗ ' + name, extra === undefined ? '' : JSON.stringify(extra)) }
}

function newAgent(tag) {
  const aid = 'agt_gate_' + tag + '_' + Math.random().toString(36).slice(2, 7)
  db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
    .run(aid, 'gate-' + tag, 'chat', 'active', now())
  return aid
}
function setFlag(key, value) {
  db.prepare('INSERT INTO flags(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value))
}
function eventsOf(type) {
  return db.prepare('SELECT * FROM events WHERE type=?').all(type)
}

const OWNER = '10001'
const STRANGER = '20002'
const GROUP = '30003'
const OWNER_SID = qqSessionPrefix('u:' + OWNER) + '-abc123'
const STRANGER_SID = qqSessionPrefix('u:' + STRANGER) + '-def456'
const GROUP_SID = qqSessionPrefix('g:' + GROUP) + '-ghi789'

// ---------------------------------------------------------------- 纯判定
{
  check('没有会话 id：判不了 → 放行（标 ungated）', guestVerdict('').kind === 'ungated' && guestVerdict('').ok === true)
  check('网页会话：算主人', guestVerdict('sess_web_123').ok === true && guestVerdict('sess_web_123').kind === 'local')
  check('主人私聊：放行', guestVerdict(OWNER_SID, { owners: [OWNER] }).ok === true)
  check('主人私聊：kind=owner', guestVerdict(OWNER_SID, { owners: [OWNER] }).kind === 'owner')

  // 没有映射表时，hash 是单向的：认得出主人，认不出「是群还是陌生人」。
  // 两种都该拒，只是理由分开——前者说群，后者说不是主人。
  const map = { ['u:' + STRANGER]: STRANGER_SID, ['g:' + GROUP]: GROUP_SID }

  const st = guestVerdict(STRANGER_SID, { owners: [OWNER], sessionMap: map })
  check('陌生人私聊（有映射表）：拒', st.ok === false && st.kind === 'stranger')
  check('陌生人私聊：理由是不给翻', st.reason === REASON_GUEST, st.reason)

  const raw = guestVerdict(STRANGER_SID, { owners: [OWNER] })
  check('陌生人私聊（没映射表）：照样拒', raw.ok === false)
  check('没映射表：kind 是 unknown，不硬说人家是陌生人', raw.kind === 'unknown', raw)

  const gp = guestVerdict(GROUP_SID, { owners: [OWNER], sessionMap: map })
  check('群聊（有映射表）：拒', gp.ok === false && gp.kind === 'group')
  check('群聊：理由说的是群，不是「陌生人」', gp.reason === REASON_GROUP, gp.reason)
  check('群聊里哪怕主人在群里也拒', guestVerdict(GROUP_SID, { owners: [OWNER], sessionMap: map }).ok === false)

  const un = guestVerdict(STRANGER_SID, { owners: [] })
  check('主人号一个都没配：拒', un.ok === false && un.kind === 'unset')
  check('主人号没配：理由说的是没配，不是「你不是主人」', un.reason === REASON_UNSET, un.reason)
  check('主人号没配时，主人的那条也拒（认不出就不给）', guestVerdict(OWNER_SID, { owners: [] }).ok === false)

  check('有映射表：陌生人靠 map 认出来也拒', guestVerdict(STRANGER_SID, { owners: [OWNER], sessionMap: map }).kind === 'stranger')
  const ownerMap = { ['u:' + OWNER]: OWNER_SID }
  check('有映射表：主人靠 map 认出也放行', guestVerdict(OWNER_SID, { owners: [OWNER], sessionMap: ownerMap }).ok === true)
  check('映射表是坏的（null / 非对象）：不崩，退化成 hash 判定', guestVerdict(STRANGER_SID, { owners: [OWNER], sessionMap: null }).ok === false)
}

// ---------------------------------------------------------------- 主人号来源
{
  const aid = newAgent('owners')
  writeParam(db, aid, 'qq.bridge.owner_qq', '10001, 10002')
  setFlag('qq.owner', '10003')
  const list = ownerQqList(db, (k) => (k === 'qq.bridge.owner_qq' ? '10001, 10002' : ''))
  check('两处主人号并起来：参数表里的都在', list.includes('10001') && list.includes('10002'), list)
  // flags 表里的老配置也要认
  const list2 = ownerQqList(db, (k) => (k === 'qq.bridge.owner_qq' ? '10001' : ''))
  check('两处主人号并起来：flags 里的老配置也算', list2.includes('10003'), list2)
  check('刻意不带 FALLBACK_OWNER 兜底号', !list2.includes('3192248859'), list2)
}

// ---------------------------------------------------------------- verdictFor
{
  const aid = newAgent('verdict')
  const read = (k) => ({ 'gate.guest.enable': 'on', 'qq.bridge.owner_qq': OWNER, 'qq.bridge.sessions_file': '' }[k])
  check('verdictFor：客人拒', verdictFor({ db, aid, sessionId: STRANGER_SID, param: read }).ok === false)
  check('verdictFor：主人放行', verdictFor({ db, aid, sessionId: OWNER_SID, param: read }).ok === true)

  const off = (k) => (k === 'gate.guest.enable' ? 'off' : read(k))
  const v = verdictFor({ db, aid, sessionId: STRANGER_SID, param: off })
  check('总开关 off：客人也放行', v.ok === true && v.kind === 'off', v)
}

// ---------------------------------------------------------------- 宿主守卫
{
  const aid = newAgent('guard')
  writeParam(db, aid, 'qq.bridge.owner_qq', OWNER)
  // 守卫也要走「映射表认人」那条路：写一份真的 qq-sessions.json 喂给它
  const mapFile = path.join(dir, 'qq-sessions.json')
  fs.writeFileSync(mapFile, JSON.stringify({ ['u:' + STRANGER]: STRANGER_SID, ['g:' + GROUP]: GROUP_SID }), 'utf8')
  const param = (k) => (k === 'qq.bridge.owner_qq' ? OWNER : k === 'gate.guest.enable' ? 'on' : '')
  const guard = makeOwnerGuard({ getDb: () => db, getAid: () => aid, param, findSessionsFile: () => mapFile })

  const before = eventsOf(EVENT_DENIED).length
  check('守卫生效：客人被拒，返回理由', guard({ name: GATE_TOOL, agent: { id: STRANGER_SID } }) === REASON_GUEST)
  check('守卫记了一条 gate.denied', eventsOf(EVENT_DENIED).length === before + 1)
  const last = eventsOf(EVENT_DENIED).slice(-1)[0]
  const payload = JSON.parse(last.payload)
  check('拒绝事件里带了会话 id / 类型 / chatKey', payload.sessionId === STRANGER_SID && payload.kind === 'stranger' && payload.chatKey === 'u:' + STRANGER, payload)
  check('守卫：群聊拒，理由说的是群', guard({ name: GATE_TOOL, agent: { id: GROUP_SID } }) === REASON_GROUP)
  check('守卫生效：主人放行', guard({ name: GATE_TOOL, agent: { id: OWNER_SID } }) === undefined)
  check('守卫生效：网页会话放行', guard({ name: GATE_TOOL, agent: { id: 'sess_web_1' } }) === undefined)
  check('只看 memory_search：别的工具一律放过', guard({ name: 'act_send', agent: { id: STRANGER_SID } }) === undefined)

  const beforeUn = eventsOf(EVENT_UNGATED).length
  check('没有会话 id：放行', guard({ name: GATE_TOOL }) === undefined)
  check('没有会话 id：记了一条 gate.ungated（真机能看出有没有发生）', eventsOf(EVENT_UNGATED).length === beforeUn + 1)

  const wrongTool = makeOwnerGuard({ getDb: () => { throw new Error('db 还没起') }, getAid: () => aid, param })
  check('守卫自己出错：放行，不拖累工具链', wrongTool({ name: GATE_TOOL, agent: { id: STRANGER_SID } }) === undefined)
  check('守卫拿到半截 execution：不崩', makeOwnerGuard({ getDb: () => db, getAid: () => aid, param })({}) === undefined)
}

// ---------------------------------------------------------------- 第二道闸（工具自己再判）
{
  const aid = newAgent('exec')
  const tools = createActionTools({
    getDb: () => db,
    getAgentId: () => aid,
    gateSearch: (sid) => guestVerdict(sid, { owners: [OWNER] }),
  })
  const tool = tools.find((t) => t.name === GATE_TOOL)
  check('工具在', !!tool)

  const refused = await tool.execute({ query: '主人的事' }, { agent: { id: STRANGER_SID } })
  check('执行层：客人拿到的是拒绝，不是记忆', refused.refused === REASON_GUEST && !refused.items, refused)
  const rendered = tool.output.render({}, refused)
  check('渲染出来只有那句拒绝，没有「没有找到」之类误导', rendered.length === 1 && rendered[0].text === REASON_GUEST, rendered)

  const okV = await tool.execute({ query: '咖啡' }, { agent: { id: 'sess_web_1' } })
  check('执行层：主人那条照常走 recall（不是 refused）', okV.refused === undefined)

  const noGate = createActionTools({ getDb: () => db, getAgentId: () => aid })
  const tool2 = noGate.find((t) => t.name === GATE_TOOL)
  const v2 = await tool2.execute({ query: '咖啡' }, { agent: { id: STRANGER_SID } })
  check('没注入 gateSearch（老宿主/单测）：行为不变，不崩', v2.refused === undefined)
}

console.log('\n' + pass + '/' + (pass + fail) + ' passed')
if (fail) process.exit(1)
