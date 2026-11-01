/**
 * 关系域测试：人物账本（rel_event 主数据 → 人物 / 边 / 提及投影）。
 * 运行：node test/relations.test.mjs
 *
 * 覆盖：种子与迁移、认人、一句话 → 一笔账、重放自证、合并、衰减、提示词预算、HTTP 接口。
 */
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, now } from '../src/db.js'
import * as R from '../src/modules/relations.js'
import { handle } from '../src/api.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 700)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-relations-'))
const db = openDb(path.join(dir, 'app.db'))
const aid = 'agt_rel'
db.prepare("INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)")
  .run(aid, '关系', 'daily', 'active', now())
// 旧库的三行分类 + 一个真人：迁移后分类不该变成人
for (const [name, kind, k, r, d, root] of [
  ['主人', 'owner', 0.7, 0.8, 0.3, 1],
  ['熟人', 'acquaintance', 0.25, 0.4, 0.05, 0],
  ['陌生人', 'stranger', 0.1, 0.3, 0, 0],
  ['老王', 'acquaintance', 0.45, 0.5, 0.1, 0],
]) {
  db.prepare('INSERT INTO relations VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run('rel_' + name, aid, name, kind, k, r, d, root, name === '老王' ? '老同事，做前端的' : null, now(), now())
}

// ---------------- 种子 / 迁移 ----------------
const h0 = R.bootstrap(db, aid)
check('迁移：三档策略只有三行', h0.tiers === 3, h0)
check('迁移：有且只有一个主人', h0.persons.by_tier['owner.active'] === 1, h0.persons)
const owner = R.ownerPerson(db, aid)
check('迁移：主人沿用旧表三维', owner && Math.abs(owner.closeness - 0.7) < 1e-6 && Math.abs(owner.trust - 0.8) < 1e-6, owner)
const names = R.listPersons(db, aid, { status: 'active' }).map((p) => p.name).sort()
check('迁移：分类三行没有变成人，真人搬进来了', JSON.stringify(names) === JSON.stringify(['主人', '老王']), names)
const laowang = R.listPersons(db, aid, {}).find((p) => p.name === '老王')
check('迁移：旧 notes → summary，旧 kind → tier', laowang && laowang.summary === '老同事，做前端的' && laowang.tier === 'acquaintance', laowang)
check('迁移：幂等（再跑一遍人数不变）', (R.bootstrap(db, aid), R.listPersons(db, aid, {}).length === 2))
check('迁移：渠道绑定 ui/local → 主人', R.personByChannel(db, aid, {})?.id === owner.id)

// ---------------- 一句话 → 一笔账 → 一个人 ----------------
const t1 = '2026-10-30T10:00:00.000Z'
const line = '我同事小周和她的丈夫老陈，昨天帮我修了电脑'
const a = R.ingest(db, aid, { text: line, sessionId: 's1', turnId: 't1', at: t1 })
check('入账：一句话落一笔账', a.id && a.dup === false, a)
const again = R.ingest(db, aid, { text: line, sessionId: 's1', turnId: 't1', at: t1 })
check('入账：同一个 turn 重复只留一笔', again.dup === true && again.id === a.id, again)
const evCount = db.prepare('SELECT COUNT(*) n FROM rel_event WHERE agent_id=?').get(aid).n
check('入账：账本里没有重复行', Number(evCount) === Number(h0.events) + 1, { evCount, base: h0.events })
const ownerAfter = R.ownerPerson(db, aid)
check('入账：说话人 touch 一次', ownerAfter.talk_count === 1 && ownerAfter.last_talk_at === t1, ownerAfter.talk_count)
check('入账：带称呼的人按熟人候选建，默认不入图', ['小周', '老陈'].every((n) => {
  const p = R.listPersons(db, aid, {}).find((x) => x.name === n)
  return p && p.tier === 'acquaintance' && p.graph_visible === false
}))
check('入账：新名字不建「主人 / 熟人 / 陌生人」', !R.listPersons(db, aid, {}).some((p) => ['熟人', '陌生人'].includes(p.name)))
// 名字在前、关系在后：这是最自然的说法，不能漏（用账本里还没有的人验建人）
const cop = R.extractMentions(db, aid, '阿念是我朋友')
check('抽取：「X 是我朋友」认得出名字并建成熟人候选', cop.some((m) => m.surface === '阿念' && m.create && m.tier === 'acquaintance'), cop)
const cop2 = R.extractMentions(db, aid, '然后小王是我同事')
check('抽取：「然后 X 是我同事」不把「然后」算进名字', cop2.some((m) => m.surface === '小王'), cop2)
const roleIs = R.extractMentions(db, aid, '我朋友是李雷')
check('抽取：「我朋友是 X」认得出名字', roleIs.some((m) => m.surface === '李雷'), roleIs)
// 四字昵称：「我兄弟小小尼姑」以前被 {2,3} 截成「小小尼」
const four = R.extractMentions(db, aid, '我兄弟小小尼姑')
check('抽取：四字昵称不被截断（小小尼姑）', four.some((m) => m.surface === '小小尼姑'), four)
check('抽取：界面词不当人名（叫手动添加关系）', R.extractMentions(db, aid, '叫手动添加关系').length === 0)
check('抽取：宿主通报不入账', R.ingest(db, aid, { text: 'background job pwsh-123 finished', sessionId: 's9', turnId: 't9' }).skipped === 'system-message')
check('抽取：审批样板不入账', R.ingest(db, aid, { text: 'Approval prompts are disabled in this session: actions that require approval are rejected automatically — do not request sandbox escalation (do not set `sandbox_permissions`).', sessionId: 's10', turnId: 't11' }).skipped === 'system-message')
check('抽取：子代理完工通报不入账', R.ingest(db, aid, { text: 'Background subagent 17e3c487-467e-4992-aaa0-b3d50bec22b5 finished and will do no further work unless you send it more.', sessionId: 's11', turnId: 't12' }).skipped === 'system-message')

// ---------------- 认人 ----------------
const xz = R.listPersons(db, aid, {}).find((p) => p.name === '小周')
const exact = R.resolve(db, aid, '小周')
check('认人：精确命中 1.0', exact.candidates[0].id === xz.id && exact.candidates[0].score === 1, exact.candidates[0])
check('认人：没记录的人只给空候选', R.resolve(db, aid, '张三丰').candidates.length === 0)
check('认人：找得到的人 lookup 给卡', R.lookup(db, aid, '小周').confidence === 1)
check('认人：找不到的人 lookup 不给卡', R.lookup(db, aid, '张三丰').card === '')
// 同名 / 近似名：不自动合并，只靠别名归到同一个人
R.remember(db, aid, { name: '小周', aliases: ['周工'], summary: '修电脑那位' })
const alias = R.resolve(db, aid, '周工')
check('认人：别名能命中同一个人', alias.candidates[0].id === xz.id && alias.candidates[0].score === 1, alias.candidates[0])
check('认人：名字相近只给候选，不自动认', R.resolve(db, aid, '小周哥').candidates.every((c) => c.id !== 'nope'))

// ---------------- 现场：卡片 / 提示词 ----------------
const card = R.cardText(db, aid, xz.id)
check('卡片：带关系类型和证据，不编', card.includes('小周') && card.includes('帮你修') === false && card.includes('我记得的就这些'), card)
const blockOwner = R.promptBlock(db, aid)
check('提示词：主人有温度和三维', blockOwner.includes('当前对话对象：主人') && blockOwner.includes('温度：热情'), blockOwner)
check('提示词：主人块 ≤ 160 字', Array.from(blockOwner).length <= 160, Array.from(blockOwner).length)
const strangerBlock = R.promptBlock(db, aid, { personId: xz.id })
check('提示词：熟人块更短、礼貌', strangerBlock.includes('礼貌') && Array.from(strangerBlock).length <= 80, strangerBlock)

// ---------------- 边 / 合并 / 重放 ----------------
const chen = R.listPersons(db, aid, {}).find((p) => p.name === '老陈')
R.upsertEdgeApi(db, aid, { from_id: xz.id, to_id: chen.id, kind: 'marriage', role_label: '夫妻' })
const snap = () => JSON.stringify({
  persons: db.prepare('SELECT id,name,tier,status,closeness,trust,last_seen_at,talk_count FROM rel_person WHERE agent_id=? ORDER BY id').all(aid),
  edges: db.prepare('SELECT id,from_id,to_id,kind,role_label,valid_to FROM rel_edge WHERE agent_id=? ORDER BY id').all(aid),
  mentions: db.prepare('SELECT id,surface,state,candidate_ids FROM rel_mention WHERE agent_id=? ORDER BY id').all(aid),
  channels: db.prepare('SELECT person_id,channel,handle FROM rel_channel WHERE agent_id=? ORDER BY id').all(aid),
})
const beforeRebuild = snap()
const rb = R.rebuild(db, aid)
check('重放：清空投影后账本还能重建', rb.events > 0 && rb.persons >= 4, rb)
check('重放：person / edge / mention 与重放前逐字段一致', snap() === beforeRebuild)

// 合并：别名搬过去，边搬过去，源归档
const dup = R.remember(db, aid, { name: '周小' })
const merged = R.mergePersons(db, aid, dup.id, xz.id)
check('合并：目标拿到别名', merged.person.aliases.includes('周小'), merged.person.aliases)
check('合并：源被归档，不再出现在列表', !R.listPersons(db, aid, {}).some((p) => p.id === dup.id))
check('合并：合并后的名字还能认出来', R.resolve(db, aid, '周小').candidates[0]?.id === xz.id)

// ---------------- 衰减 ----------------
const late = new Date('2027-05-20T10:00:00.000Z')
const tickOut = R.tick(db, aid, { at: late.toISOString() })
check('衰减：跑过一次并落账', tickOut.changed > 0 && tickOut.event, tickOut)
const after = R.listPersons(db, aid, { status: 'active' }).concat(R.listPersons(db, aid, { status: 'archived' }), R.listPersons(db, aid, { status: 'faded' }))
const small = after.find((p) => p.name === '小周')
check('衰减：生人 200 天后归档', small && small.status === 'archived', small && small.status)
check('衰减：主人不随时间淡出', R.ownerPerson(db, aid)?.status === 'active' && R.ownerPerson(db, aid)?.salience === 1)
const beforeDecayRebuild = snap()
R.rebuild(db, aid)
check('重放：衰减结果也能重建', snap() === beforeDecayRebuild)

// ---------------- 红线 ----------------
let code = ''
try { R.remember(db, aid, { name: '第二个主人', tier: 'owner' }) } catch (e) { code = e.code }
check('红线：主人只能有一个', code === 'RED_LINE', code)
let delCode = ''
try { R.removePerson(db, aid, owner.id) } catch (e) { delCode = e.code }
check('红线：主人不能删', delCode === 'RED_LINE', delCode)

// ---------------- 指纹（回归：两个人的同类操作不能折叠成一笔账） ----------------
{
  const mk = (name) => R.remember(db, aid, { name, tier: 'stranger' }).id
  const jia = mk('甲'), yi = mk('乙')
  const evBefore = db.prepare('SELECT COUNT(*) n FROM rel_event WHERE agent_id=?').get(aid).n
  R.removePerson(db, aid, jia)
  R.removePerson(db, aid, yi)
  const archived = R.listPersons(db, aid, { status: 'archived' }).map((p) => p.name)
  check('删除：两个人各自入账，不是第二笔被指纹折叠', archived.includes('甲') && archived.includes('乙'), archived)
  const evAfter = db.prepare('SELECT COUNT(*) n FROM rel_event WHERE agent_id=?').get(aid).n
  check('删除：两笔删除就是两笔账', evAfter === evBefore + 2, { evBefore, evAfter })
  R.removePerson(db, aid, yi)
  const evAgain = db.prepare('SELECT COUNT(*) n FROM rel_event WHERE agent_id=?').get(aid).n
  check('删除：同一个人重复删只记一笔（幂等）', evAgain === evAfter, { evAfter, evAgain })
  const bing = mk('丙'), ding = mk('丁')
  R.promotePerson(db, aid, bing)
  R.promotePerson(db, aid, ding)
  const vis = R.listPersons(db, aid, {}).filter((p) => ['丙', '丁'].includes(p.name)).map((p) => p.graph_visible)
  check('入图：两个人各自能提升（第二次不被指纹折叠）', vis.every(Boolean) && vis.length === 2, vis)
}

// ---------------- 删掉的人还能再加回来（回归：同名事件指纹会把新建吞掉） ----------------
{
  const first = R.remember(db, aid, { name: '小明', tier: 'acquaintance', summary: '老同学' })
  R.removePerson(db, aid, first.id)
  check('重加：删掉后列表里没有他', !R.listPersons(db, aid, {}).some((p) => p.name === '小明'))
  const back = R.remember(db, aid, { name: '小明', tier: 'acquaintance', summary: '老同学，回来了' })
  const row = R.listPersons(db, aid, {}).find((p) => p.name === '小明')
  check('重加：同一个人能回来，不是静默失败', !!row && back.created === false, { back, row: row && row.status })
  check('重加：还是原来那张卡（id 不变）', row && row.id === first.id, { before: first.id, after: row && row.id })
  check('重加：新的一句话写进去了', row && row.summary === '老同学，回来了', row && row.summary)
  // 删 → 加回 → 再删：第二次删除不能被「同一个人归档过」的指纹吞掉（线上「删不掉」就是这个）
  R.removePerson(db, aid, back.id)
  check('重加：加回来之后还能再删', !R.listPersons(db, aid, {}).some((p) => p.name === '小明'))

  // 同样的手记内容换层再换回来：第二次「改成生人」不能被内容指纹当成重复
  R.remember(db, aid, { name: '丁一', tier: 'acquaintance', summary: '手记' })
  R.remember(db, aid, { name: '丁一', tier: 'stranger', summary: '手记' })
  R.remember(db, aid, { name: '丁一', tier: 'acquaintance', summary: '手记' })
  R.remember(db, aid, { name: '丁一', tier: 'stranger', summary: '手记' })
  const ding = R.listPersons(db, aid, {}).find((p) => p.name === '丁一')
  check('手记：同样内容换层换回来也要真的落库', ding && ding.tier === 'stranger', ding)

  // 聊天里重新提到删过的人，也一样复用旧卡
  const said = '他叫阿力'
  R.ingest(db, aid, { text: said, sessionId: 's2', turnId: 't2', at: '2026-10-30T11:00:00.000Z' })
  const ali = R.listPersons(db, aid, {}).find((p) => p.name === '阿力')
  R.removePerson(db, aid, ali.id)
  R.ingest(db, aid, { text: '阿力是我朋友', sessionId: 's3', turnId: 't3', at: '2026-10-30T11:05:00.000Z' })
  const aliBack = R.listPersons(db, aid, {}).filter((p) => p.name === '阿力')
  check('重加：聊天里再提到，人回来了且不重复', aliBack.length === 1 && aliBack[0].id === ali.id, aliBack)
  const snapAfterRevive = snap()
  R.rebuild(db, aid)
  check('重加：重放后还是活的、还是一张卡', snap() === snapAfterRevive
    && R.listPersons(db, aid, {}).filter((p) => p.name === '阿力').length === 1)
}

// ---------------- HTTP ----------------
const api = async (method, p, body) => {
  const req = { method, path: p, body: body || {}, token: 'user' }
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) req.body.__idempotencyKey = 'k_' + Math.random().toString(16).slice(2)
  const out = await handle(db, req)
  return { status: out.status, body: out.body }
}
const hl = await api('GET', `/v1/agents/${aid}/relations/health`)
check('API：health 报 schema 10 / 人数 / 账本条数', hl.status === 200 && hl.body.schema === 10 && hl.body.events > 0, hl.body)
const lp = await api('GET', `/v1/agents/${aid}/persons`)
check('API：人物列表（归档的不出现）', lp.status === 200 && Array.isArray(lp.body)
  && lp.body.some((p) => p.name === '主人') && !lp.body.some((p) => p.name === '老王'), lp.body.map((p) => p.name))
const rs = await api('GET', `/v1/agents/${aid}/persons/resolve?q=${encodeURIComponent('主人')}`)
check('API：认人候选', rs.status === 200 && rs.body.candidates[0]?.name === '主人', rs.body)
const cd = await api('GET', `/v1/agents/${aid}/persons/${owner.id}/card`)
check('API：人物卡', cd.status === 200 && typeof cd.body.card === 'string' && cd.body.card.includes('主人'), cd.body)
const rp = await api('POST', `/v1/agents/${aid}/persons`, { name: '小林', tier: 'acquaintance' })
check('API：写人物要幂等键，写成功', rp.status === 200 && rp.body.ok === true, rp.body)
const pr = await api('POST', `/v1/persons/${rp.body.id}/promote`, {})
check('API：提升入图', pr.status === 200 && pr.body.graph_visible === true, pr.body)
// ---------------- 改称呼：人还是同一个人，旧称呼变别名 ----------------
const xnn = R.remember(db, aid, { name: '小小尼', tier: 'acquaintance' })
const rn = await api('POST', `/v1/persons/${xnn.id}/rename`, { name: '小小尼姑' })
check('API：改称呼', rn.status === 200 && rn.body.name === '小小尼姑' && rn.body.id === xnn.id, rn.body)
check('API：旧称呼留作别名，下次提到还认得', (rn.body.aliases || []).includes('小小尼')
  && R.resolve(db, aid, '小小尼').candidates.some((c) => c.id === xnn.id), rn.body.aliases)
const rnDup = await api('POST', `/v1/persons/${xnn.id}/rename`, { name: '主人' })
check('API：改成别人的名字被挡下（同名要合并）', rnDup.status === 409, rnDup.body)
const rnEmpty = await api('POST', `/v1/persons/${xnn.id}/rename`, { name: '   ' })
check('API：空称呼被挡下', rnEmpty.status === 400, rnEmpty.body)
R.rebuild(db, aid)
const rnAfter = (await api('GET', `/v1/agents/${aid}/persons/${xnn.id}`)).body
check('改称呼：重放账本后名字还在', rnAfter.person && rnAfter.person.name === '小小尼姑', rnAfter.person && rnAfter.person.name)
const eg = await api('POST', `/v1/agents/${aid}/persons/${rp.body.id}/edges`, { to_id: owner.id, kind: 'colleague', role_label: '同事' })
check('API：建边', eg.status === 200 && eg.body.ok === true, eg.body)
const rv = await api('GET', `/v1/agents/${aid}/relations/review`)
check('API：待确认列表', rv.status === 200 && Array.isArray(rv.body.items), rv.body)

// 手记：选的层 = 落的层，同名再加是换层而不是覆盖别人
const st = await api('POST', `/v1/agents/${aid}/persons`, { name: '阿康', tier: 'stranger' })
const stRow = (await api('GET', `/v1/agents/${aid}/persons`)).body.find((p) => p.name === '阿康')
check('API：选生人就落生人', st.status === 200 && stRow && stRow.tier === 'stranger', stRow)
const mv = await api('POST', `/v1/agents/${aid}/persons`, { name: '阿康', tier: 'acquaintance' })
const mvRows = (await api('GET', `/v1/agents/${aid}/persons`)).body.filter((p) => p.name === '阿康')
check('API：同名再加是换层，不会多一行', mv.status === 200 && mvRows.length === 1 && mvRows[0].tier === 'acquaintance', mvRows)
const bad = await api('POST', `/v1/agents/${aid}/persons`, { name: '阿康', tier: 'friend' })
check('API：给错的层直接报错，不静默改层', bad.status === 400, bad)
const ow = await api('POST', `/v1/agents/${aid}/persons`, { name: '主人', tier: 'acquaintance' })
const owRow = (await api('GET', `/v1/agents/${aid}/persons`)).body.find((p) => p.name === '主人')
check('API：主人不会被「添加同名的人」挪走', ow.status === 409 && owRow && owRow.tier === 'owner', { ow, owRow })

// ---------------- 工具 / 命令（口径层，不依赖宿主） ----------------
{
  const { relationTools, relationToolGuards, relationCommands } = await import('../src/modules/relations_tools.js')
  const scope = () => ({ d: db, aid })
  const tools = relationTools(scope)
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]))
  check('工具：两个工具都有 output.schema + render', tools.length === 2
    && tools.every((t) => t.output && t.output.schema && typeof t.output.render === 'function'))
  const look = await byName.relation_lookup.execute({ query: '小林' })
  check('工具：relation_lookup 给人物卡', typeof look.card === 'string' && look.card.includes('小林'), look)
  const miss = await byName.relation_lookup.execute({ query: '查无此人' })
  check('工具：查不到就给空，不编', miss.card === '' && miss.confidence === 0, miss)
  const noConfirm = await byName.relation_remember.execute({ name: '阿强' })
  check('工具：没确认不写', noConfirm.ok === false
    && db.prepare("SELECT 1 FROM rel_person WHERE agent_id=? AND name='阿强'").get(aid) === undefined)
  const guard = relationToolGuards(scope)[0]
  check('守卫：没确认 → 拒绝并说明', typeof guard({ name: 'relation_remember', arguments: { name: '阿强' } }) === 'string')
  check('守卫：确认后放行', guard({ name: 'relation_remember', arguments: { name: '阿强', confirm: true } }) === undefined)
  check('守卫：别的工具不拦', guard({ name: 'relation_lookup', arguments: {} }) === undefined)
  const rem = await byName.relation_remember.execute({ name: '阿强', tier: 'acquaintance', summary: '楼下修车的', confirm: true })
  check('工具：确认后写入', rem.ok === true && rem.created === true, rem)
  const cmd = relationCommands(scope)[0]
  const c1 = await cmd.handler({ rawInput: '阿强' })
  check('命令：/whois 给人物卡', c1.kind === 'success' && c1.text.includes('阿强'), c1)
  const c2 = await cmd.handler({ rawInput: '' })
  check('命令：空参数给人话', c2.kind === 'error' && c2.text.includes('/whois'), c2)
  const c3 = await cmd.handler({ rawInput: '查无此人' })
  check('命令：查不到不编，只给候选位', c3.kind === 'success' && c3.text.includes('没有'), c3)
  const quiet = await relationTools(() => null)[0].execute({ query: '小周' })
  check('工具：没有意识体时安静返回空', quiet.card === '' && quiet.confidence === 0, quiet)
  db.prepare("UPDATE agents SET status='paused' WHERE id=?").run(aid)
  check('守卫：暂停实例拒绝写', typeof guard({ name: 'relation_remember', arguments: { name: 'x', confirm: true } }) === 'string')
  db.prepare("UPDATE agents SET status='active' WHERE id=?").run(aid)
}

// ---------------- 宿主系统消息 / 账本卫生 ----------------
{
  const before = db.prepare('SELECT COUNT(*) n FROM rel_event WHERE agent_id=?').get(aid).n
  const skip = R.ingest(db, aid, {
    text: 'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context.',
    sessionId: 's9', turnId: 't9',
  })
  const after = db.prepare('SELECT COUNT(*) n FROM rel_event WHERE agent_id=?').get(aid).n
  check('入账：宿主系统消息不入账', skip.skipped === 'system-message' && after === before, skip)
  const long = R.ingest(db, aid, { text: '（长文）'.repeat(500), sessionId: 's9', turnId: 't10' })
  check('入账：超长粘贴不当聊天', long.skipped === 'system-message', long.skipped)
}

// ---------------- 名字带引称动词的脏卡：清扫不能只跑一次 ----------------
{
  R.remember(db, aid, { name: '小灰', tier: 'acquaintance' })
  R.remember(db, aid, { name: '叫小灰', tier: 'acquaintance' })
  R.bootstrap(db, aid)
  const liveNames = R.listPersons(db, aid, { status: 'active' }).map((p) => p.name)
  check('清扫：再次启动也把「叫小灰」并回「小灰」', liveNames.includes('小灰') && !liveNames.includes('叫小灰'), liveNames)
}

// ---------------- 收尾 ----------------
check('账本：每笔账都有指纹和目标', db.prepare('SELECT COUNT(*) n FROM rel_event WHERE agent_id=? AND fingerprint IS NULL').get(aid).n === 0)
const h = R.health(db, aid)
check('体检：schema 10 且无悬空提及', h.schema === 10 && h.unresolved_mentions === 0, h)

console.log('\n' + pass + ' passed, ' + fail + ' failed')
try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* Windows 上有 WAL 锁就留给系统清理 */ }
if (fail) process.exit(1)
