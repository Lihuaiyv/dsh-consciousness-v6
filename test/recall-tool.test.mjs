/**
 * 检索工具 v3（memory_search）：多说法融合 + 五层 + 局部上下文。
 * 运行：node test/recall-tool.test.mjs
 *
 * 验的是「工具好不好用」，不是「注入准不准」——这一层不设高门，
 * 只要那层里真有、就应该交得回去，而且一层命中再多也不能把另一层挤掉。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { addMemory } from '../src/modules/memory.js'
import { planRecall, fusePhrasings, recallTool, renderRecall, DEFAULT_LAYERS } from '../src/modules/recall_tool.js'
import { createActionTools } from '../src/modules/actions/index.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-rtool-'))
const db = openDb(path.join(dir, 'app.db'))
const aid = 'agt_tool'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid, 'tool', 'daily', 'active', new Date().toISOString())

const ago = (days) => new Date(Date.now() - days * 86400000).toISOString()

// ---------------- 参数整理
{
  const d = planRecall({ query: '  记忆召回  ' })
  check('默认只查记忆 + 原文', d.layers.join(',') === DEFAULT_LAYERS.join(','), d.layers)
  check('query 去掉首尾空白', d.query === '记忆召回', d.query)
  check('没给 also 时只有一种说法', d.queries.length === 1, d.queries)
  check('默认 brief', d.detail === 'brief', d.detail)

  const full = planRecall({ query: 'x', detail: 'full', k: 12 })
  check('full 模式 k 压到 5', full.k === 5, full.k)
  check('k 超上限被夹住', planRecall({ query: 'x', k: 99 }).k === 12, planRecall({ query: 'x', k: 99 }).k)
  check('days 负数归零', planRecall({ query: 'x', days: -5 }).days === 0)
  check('days 超上限夹住', planRecall({ query: 'x', days: 99999 }).days === 3650)
  check('context 超上限夹住', planRecall({ query: 'x', context: 9 }).context === 3)

  const many = planRecall({ query: 'a', also: ['b', 'c', 'd', 'e', 'f'] })
  check('说法最多 4 种', many.queries.length === 4, many.queries)
  check('重复说法去重', planRecall({ query: 'a', also: ['a', 'b'] }).queries.join(',') === 'a,b')

  check('非法层名被丢掉并回默认', planRecall({ query: 'x', layers: ['nope'] }).layers.join(',') === DEFAULT_LAYERS.join(','))
  check('层名按用户给的走', planRecall({ query: 'x', layers: ['diary'] }).layers.join(',') === 'diary')

  check('旧说法默认不带', planRecall({ query: 'x' }).includeSuperseded === false)
  check('include 里点了就带', planRecall({ query: 'x', include: ['superseded'] }).includeSuperseded === true)
}

// ---------------- RRF 融合
{
  const a = { id: 'a', text: 'A', e: 0.6 }
  const b = { id: 'b', text: 'B', e: 0.9 }
  const fused = fusePhrasings([
    { w: 1, items: [b, a] },          // 主查询：b 第 1，a 第 2
    { w: 0.75, items: [a] },          // 第二种说法：a 第 1
  ])
  check('两种说法都命中的排前面', fused[0].id === 'a', fused)
  check('融合后仍带证据分', fused[0].e === 0.6, fused[0])
  check('融合分数是名次的倒数和', fused[0].rrf > fused[1].rrf, fused)
}

// ---------------- 造数据
const add = (text, extra = {}) => addMemory(db, aid, { text, type: 'fact', importance: 0.8, ...extra })
const memBubble = add('用户喜欢把对话气泡改成流动的水波纹')
const memBorder = add('那条消息的边框要软一点，别太锐')
const memLong = add('长文本测试' + '很'.repeat(380))
const memCold = add('用户随口说过一句「我真是服了」', { cold: true })
const memOld = add('很久以前定的方案是圆角')
const memStale = add('默认头像要用鲸鱼')
db.prepare('UPDATE memory_items SET created_at=?, invalid_at=?, superseded_by=? WHERE id=?')
  .run(ago(60), ago(2), memStale.id, memStale.id)
db.prepare('UPDATE memory_items SET created_at=? WHERE id=?').run(ago(60), memOld.id)

// 记忆层塞满候选，用来验证「不能把原文层挤掉」
for (let i = 0; i < 10; i++) add('记忆召回评测第 ' + i + ' 次讨论，召回率还是低')

const putRaw = (id, seq, role, text, at) => {
  db.prepare('INSERT INTO raw_turns(id,agent_id,session_id,seq,role,text,created_at,day) VALUES(?,?,?,?,?,?,?,?)')
    .run(id, aid, 'sess1', seq, role, text, at, at.slice(0, 10))
  db.prepare('INSERT INTO raw_fts(id,text) VALUES(?,?)').run(id, text)
}
putRaw('raw_p', 1, 'user', '今天想聊聊记忆召回评测怎么做', ago(1))
putRaw('raw_1', 2, 'user', '记忆召回评测的第一步先把门槛压下来', ago(1))
putRaw('raw_2', 3, 'assistant', '嗯，门槛压下来之后原文层才翻得到', ago(1))
putRaw('raw_3', 4, 'user', '那就这么定了', ago(1))
putRaw('raw_old', 5, 'user', '以前说过气泡要更圆一点', ago(60))

db.prepare(`INSERT INTO episodes(id,agent_id,session_id,day,start_at,end_at,turns,title,summary,topics,open_loops,importance,source,created_at)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('ep_1', aid, 'sess1', ago(1).slice(0, 10), ago(1), ago(1), 4,
  '记忆召回评测', '讨论门槛和原文层', '["召回"]', '[]', 0.6, 'rules', ago(1))
db.prepare(`INSERT INTO diaries(id,agent_id,day,text,mood,highlights,refs,source,version,late,created_at,updated_at)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run('dry_1', aid, ago(1).slice(0, 10), '今天一整天都在弄记忆召回评测，脑子有点胀。',
  'curious', '[]', '{}', 'rules', 1, 0, ago(1), ago(1))

// ---------------- 单层能查到
{
  const r = await recallTool(db, aid, { query: '气泡', layers: ['memory'] })
  check('记忆层能查到事实', r.items.some((x) => x.id === memBubble.id), r.items.map((x) => x.id))
  check('结果的 at 带时间', /^\d{4}-\d{2}-\d{2}/.test(r.items[0].at || ''), r.items[0])
}

{
  const r = await recallTool(db, aid, { query: '记忆召回评测', layers: ['raw'] })
  check('原文层能翻到那句', r.items.some((x) => x.id === 'raw_1'), r.items.map((x) => x.id))
}

{
  const r = await recallTool(db, aid, { query: '记忆召回评测', layers: ['episode'] })
  check('纪要层能查到', r.items.some((x) => x.id === 'ep_1'), r.items.map((x) => x.id))
}

{
  const r = await recallTool(db, aid, { query: '记忆召回评测', layers: ['diary'] })
  check('日记层能查到', r.items.some((x) => x.id === 'dry_1'), r.items.map((x) => x.id))
}

{
  // 存根是「每条事实出生时的原样」，加记忆时自动留底
  const r = await recallTool(db, aid, { query: '水波纹', layers: ['fact'] })
  check('存根层能查到', r.items.length >= 1 && r.items[0].layer === 'fact', r.items)
}

// ---------------- 一层命中再多也挤不掉另一层（原 bug 回归）
{
  const r = await recallTool(db, aid, { query: '记忆召回评测', layers: ['memory', 'raw'], k: 3 })
  const layers = new Set(r.items.map((x) => x.layer))
  check('记忆层塞满 10 条时原文照样在场', layers.has('memory') && layers.has('raw'), r.items.map((x) => x.layer + ':' + x.id))
  check('记忆层截到 k 条', r.items.filter((x) => x.layer === 'memory').length === 3, r.items.length)
  check('原文层有命中就交回去', r.items.filter((x) => x.layer === 'raw').length >= 1, r.items.length)
  check('没显示完的条数被算出来', r.more.memory >= 5, r.more)
}

// ---------------- 换说法能补漏
{
  const direct = await recallTool(db, aid, { query: '气泡', layers: ['memory'] })
  const widened = await recallTool(db, aid, { query: '气泡', layers: ['memory'], also: ['边框 软'] })
  check('只说「气泡」查不到边框那条', !direct.items.some((x) => x.id === memBorder.id), direct.items.map((x) => x.text))
  check('补一种说法就查得到', widened.items.some((x) => x.id === memBorder.id), widened.items.map((x) => x.text))
}

// ---------------- 时间窗
{
  const wide = await recallTool(db, aid, { query: '圆角', layers: ['memory'], days: 0 })
  const narrow = await recallTool(db, aid, { query: '圆角', layers: ['memory'], days: 7 })
  check('不限时间时查得到旧记忆', wide.items.some((x) => x.id === memOld.id), wide.items.map((x) => x.id))
  check('days 也管记忆层', !narrow.items.some((x) => x.id === memOld.id), narrow.items.map((x) => x.id))

  const oldRaw = await recallTool(db, aid, { query: '气泡要更圆', layers: ['raw'], days: 30 })
  const allRaw = await recallTool(db, aid, { query: '气泡要更圆', layers: ['raw'], days: 0 })
  check('days 管原文层', !oldRaw.items.some((x) => x.id === 'raw_old'), oldRaw.items.map((x) => x.id))
  check('days=0 放宽到全时间', allRaw.items.some((x) => x.id === 'raw_old'), allRaw.items.map((x) => x.id))
}

// ---------------- 前后文
{
  const r = await recallTool(db, aid, { query: '记忆召回评测', layers: ['raw'], context: 1, k: 2 })
  const hit = r.items.find((x) => x.id === 'raw_1')
  check('命中带前后文', !!hit && Array.isArray(hit.near) && hit.near.length >= 2, hit && hit.near)
  const prev = (hit && hit.near || []).find((n) => n.rel === 'prev')
  const next = (hit && hit.near || []).find((n) => n.rel === 'next')
  check('前一句是对的', prev && prev.text.includes('今天想聊聊'), prev)
  check('后一句是对的', next && next.text.includes('门槛压下来之后'), next)
  check('前后文标了谁说的', prev && prev.role === 'user' && next && next.role === 'assistant', hit && hit.near)

  const noCtx = await recallTool(db, aid, { query: '记忆召回评测', layers: ['raw'], context: 0, k: 2 })
  check('context=0 时不带', noCtx.items.every((x) => !x.near), noCtx.items)
}

// ---------------- 冷层 / 旧说法
{
  const r = await recallTool(db, aid, { query: '我真是服了', layers: ['memory'] })
  const cold = r.items.find((x) => x.id === memCold.id)
  check('冷层的东西也查得到', !!cold, r.items.map((x) => x.text))
  check('冷层被标出来', cold && cold.cold === true, cold)

  const plain = await recallTool(db, aid, { query: '鲸鱼 头像', layers: ['memory'] })
  const withOld = await recallTool(db, aid, { query: '鲸鱼 头像', layers: ['memory'], include: ['superseded'] })
  check('旧说法默认不带', !plain.items.some((x) => x.id === memStale.id), plain.items.map((x) => x.text))
  check('点了 superseded 才带出来', withOld.items.some((x) => x.id === memStale.id), withOld.items.map((x) => x.text))
  const stale = withOld.items.find((x) => x.id === memStale.id)
  check('旧说法标了 stale', stale && stale.stale === true, stale)
}

// ---------------- brief / full
{
  const brief = await recallTool(db, aid, { query: '长文本测试', layers: ['memory'], k: 1 })
  const full = await recallTool(db, aid, { query: '长文本测试', layers: ['memory'], k: 1, detail: 'full' })
  check('brief 截到 120 字', brief.items[0].text.length <= 120, brief.items[0].text.length)
  check('full 给到全文', full.items[0].text.length > 120, full.items[0].text.length)
  check('full 单条不超过 1200', full.items[0].text.length <= 1200, full.items[0].text.length)
}

// ---------------- 空查询 / 查不到
{
  const empty = await recallTool(db, aid, { query: '   ' })
  check('空查询不出错，返回空', empty.items.length === 0 && empty.query === '', empty)
  const none = await recallTool(db, aid, { query: '量子色动力学', layers: ['memory', 'raw'] })
  check('查不到就是 0 条，不硬凑', none.items.length === 0, none.items)

  const text = renderRecall(none)
  check('查不到时给下一步建议', text.includes('换几种说法'), text)
}

// ---------------- 图扩散通道真的在跑
{
  // 两条记忆挂在同一个实体下（addMemory 会自动连双向边）。
  // 查询只命中其中一条，另一条字面完全不沾——只能靠一跳邻居捞回来。
  const seed = add('小周最近总去打篮球', { entity_id: 'ent_zhou' })
  const peer = add('他每周三固定去球场练投篮', { entity_id: 'ent_zhou' })
  const r = await recallTool(db, aid, { query: '小周', layers: ['memory'], k: 6 })
  check('命中的那条在', r.items.some((x) => x.id === seed.id), r.items.map((x) => x.text))
  check('同实体的邻居也带回来了', r.items.some((x) => x.id === peer.id), r.items.map((x) => x.text))
  const hit = r.items.find((x) => x.id === peer.id)
  check('邻居走的是扩散通道', hit && hit.via === 'link', hit)
}

// ---------------- 空格 / 逗号分隔的多关键词
{
  // 原文层只吃一个查询串：trigram 切不出三个字就退化成整串 LIKE，
  // 「气泡 磨砂」不拆开是一条都查不到的。
  putRaw('raw_seg1', 20, 'user', '气泡特效想要更亮一点', ago(1))
  putRaw('raw_seg2', 21, 'user', '手机壳要磨砂质感', ago(1))
  const r = await recallTool(db, aid, { query: '气泡 磨砂', layers: ['raw'], k: 4 })
  const ids = r.items.map((x) => x.id)
  check('空格分开的多个词各自都查得到', ids.includes('raw_seg1') && ids.includes('raw_seg2'), ids)
  const coma = await recallTool(db, aid, { query: '气泡，磨砂', layers: ['raw'], k: 4 })
  check('逗号分隔同样认', coma.items.map((x) => x.id).includes('raw_seg2'), coma.items.map((x) => x.id))
  const joined = await recallTool(db, aid, { query: '气泡磨砂', layers: ['raw'], k: 4 })
  check('不加分隔符时查不到（证明是拆分起的作用）',
    !joined.items.some((x) => x.id === 'raw_seg1' || x.id === 'raw_seg2'), joined.items.map((x) => x.id))
}

// ---------------- 渲染
{
  const r = await recallTool(db, aid, { query: '记忆召回评测', layers: ['memory', 'raw'], k: 2, context: 1 })
  const text = renderRecall(r)
  check('渲染带查询词', text.includes('记忆召回评测'), text.slice(0, 120))
  check('渲染带层名', text.includes('[记忆') && text.includes('[原文'), text.slice(0, 300))
  check('渲染带时间', /\d{2}-\d{2} \d{2}:\d{2}/.test(text), text.slice(0, 200))
  check('渲染标出没显示完的', text.includes('还有没显示出来'), text)

  const coldText = renderRecall(await recallTool(db, aid, { query: '我真是服了', layers: ['memory'] }))
  check('渲染标出冷层', coldText.includes('（冷层）'), coldText)
  const ctxText = renderRecall(r)
  check('渲染带前后文箭头', ctxText.includes('↑') || ctxText.includes('↓'), ctxText)
}

// ---------------- 工具接线
{
  const tools = createActionTools({ getDb: () => db, getAgentId: () => aid })
  const tool = tools.find((t) => t.name === 'memory_search')
  check('工具还在', !!tool, tools.map((t) => t.name))
  check('参数里有 also', JSON.stringify(tool.parameters).includes('also'), tool.parameters)
  check('参数里有 layers 枚举', JSON.stringify(tool.parameters).includes('"episode"'), tool.parameters)
  check('参数里去掉了 scope', !JSON.stringify(tool.parameters).includes('scope'), tool.parameters)
  const out = await tool.execute({ query: '记忆召回评测', layers: ['memory', 'raw'], k: 2 })
  check('工具跑得通', out.items.length >= 2, out)
  const rendered = tool.output.render({}, out)
  check('工具渲染不是空的', String(rendered[0].text || '').includes('查「记忆召回评测」'), rendered[0].text)
}

db.close()
console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exitCode = 1
