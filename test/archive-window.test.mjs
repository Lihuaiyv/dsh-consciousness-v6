/**
 * P4b：原文层分龄（A）+ 检索工具（E）。
 * 运行：node test/archive-window.test.mjs
 *
 * 验四件事：
 *   1. searchRaw 带 since 时翻不到更早的原话，不带时翻得到；
 *   2. oldAccountQuery 认得「很久以前 / 一开始」这类翻旧账说法；
 *   3. retrieve 的 archiveDays 默认把旧原话挡在外面，days=0 才放开；
 *   4. memory_search 工具能真的查回来（memory / archive 两种范围）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { addMemory } from '../src/modules/memory.js'
import { searchRaw } from '../src/modules/archive.js'
import { retrieve, oldAccountQuery } from '../src/modules/retrieve.js'
import { createActionTools } from '../src/modules/actions/index.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 300)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-arch-'))
const db = openDb(path.join(dir, 'app.db'))
const aid = 'agt_arch'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid, 'arch', 'daily', 'active', new Date().toISOString())

const at = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toISOString()
function putRaw(id, text, daysAgo) {
  db.prepare('INSERT INTO raw_turns(id,agent_id,session_id,seq,role,text,created_at,day) VALUES(?,?,?,?,?,?,?,?)')
    .run(id, aid, 's1', 1, 'user', text, at(daysAgo), at(daysAgo).slice(0, 10))
  db.prepare('INSERT INTO raw_fts(id,text) VALUES(?,?)').run(id, text)
}
putRaw('raw_old', '最早那次说的是把气泡特效改成水波纹', 60)
putRaw('raw_new', '今天聊的是记忆检索的工具化', 1)

// ---- 1. searchRaw 的 since
{
  const since30 = at(30)
  const inWindow = searchRaw(db, aid, '记忆检索工具化', 8, { since: since30 }).map((r) => r.id)
  const allTime = searchRaw(db, aid, '记忆检索工具化', 8, {}).map((r) => r.id)
  check('新原话在窗口内查得到', inWindow.includes('raw_new'), inWindow)
  check('不传 since 时全时间可查', allTime.includes('raw_new'), allTime)
  const oldInWindow = searchRaw(db, aid, '气泡特效水波纹', 8, { since: since30 }).map((r) => r.id)
  const oldAll = searchRaw(db, aid, '气泡特效水波纹', 8, {}).map((r) => r.id)
  check('旧原话被 30 天窗口挡住', !oldInWindow.includes('raw_old'), oldInWindow)
  check('旧原话在不限时间时查得到', oldAll.includes('raw_old'), oldAll)
}

// ---- 2. 翻旧账识别
{
  check('「很久以前」算翻旧账', oldAccountQuery('很久以前说的那个气泡特效') === true)
  check('「一开始」算翻旧账', oldAccountQuery('一开始我们定的方案是什么') === true)
  check('普通问题不算翻旧账', oldAccountQuery('记忆检索现在什么水平') === false)
}

// ---- 3. retrieve 的 archiveDays
{
  const deep = retrieve(db, aid, '气泡特效水波纹', { k: 8, floor: 0, scene: 'S3', archiveDays: 30, noUpgrade: true })
  const ids = deep.items.map((x) => x.id)
  check('深查默认挡掉旧原话', !ids.includes('raw_old'), ids)

  const all = retrieve(db, aid, '气泡特效水波纹', { k: 8, floor: 0, scene: 'S3', archiveDays: 0, noUpgrade: true, keepAll: true })
  check('archiveDays=0 能翻到旧原话', all.items.map((x) => x.id).includes('raw_old'), all.items.map((x) => x.id))

  const asked = retrieve(db, aid, '很久以前说的那个气泡特效水波纹', { k: 8, floor: 0, scene: 'S3', archiveDays: 30, noUpgrade: true, keepAll: true })
  check('查询里说“很久以前”会自动放开', asked.items.map((x) => x.id).includes('raw_old'), asked.items.map((x) => x.id))
}

// ---- 4. memory_search 工具
{
  addMemory(db, aid, { text: '用户喜欢把气泡做成水波纹特效', type: 'fact', importance: 0.9 })
  const tools = createActionTools({ getDb: () => db, getAgentId: () => aid })
  const tool = tools.find((t) => t.name === 'memory_search')
  check('工具注册了', !!tool, tools.map((t) => t.name))
  check('工具带 query 参数', !!tool && !!tool.parameters && JSON.stringify(tool.parameters).includes('query'), tool && tool.parameters)

  const r1 = await tool.execute({ query: '气泡特效', layers: ['memory'], k: 5 })
  check('工具能查记忆条目', r1.items.length >= 1 && r1.items.every((x) => x.layer === 'memory'), r1.items)

  const r2 = await tool.execute({ query: '气泡特效水波纹', layers: ['raw'], days: 0, k: 5 })
  check('工具能翻原文', r2.items.some((x) => x.id === 'raw_old'), r2.items.map((x) => x.id))

  const r3 = await tool.execute({ query: '气泡特效水波纹', layers: ['raw'], days: 30, k: 5 })
  check('工具默认受时间窗约束', !r3.items.some((x) => x.id === 'raw_old'), r3.items.map((x) => x.id))

  const r4 = await tool.execute({ query: '记忆检索工具化', layers: ['memory', 'raw'], days: 7, k: 6 })
  check('两层同时查', Array.isArray(r4.items) && r4.items.length >= 1, r4.items)
  check('默认不查日记/纪要', !(r4.items || []).some((x) => x.layer === 'diary' || x.layer === 'episode'), r4.items)
}

db.close()
console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exitCode = 1
