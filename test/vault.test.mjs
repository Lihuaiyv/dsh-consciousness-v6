/**
 * 记忆仓库 / 日记导出 测试：体量统计 / 导出目录结构 / 打开目录守卫 / 日记状态快照 + 口吻。
 * 运行：node test/vault.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, now } from '../src/db.js'
import { attachDb } from '../src/algo/index.js'
import { addMemory } from '../src/modules/memory.js'
import { appendTurn, buildEpisode, buildDiary, getDiary, diaryContext, diaryTone } from '../src/modules/archive.js'
import { warehouse, exportDocs, openFolder, setDocsRoot, getDocsRoot } from '../src/modules/vault.js'
import { handle } from '../src/api.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-vault-'))
const db = openDb(path.join(dir, 'app.db'))
attachDb(db)
const aid = 'agt_vault'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid, '仓库', 'daily', 'active', now())
db.prepare("INSERT INTO persona(agent_id,path,value,origin,updated_at) VALUES(?,?,?,?,?)")
  .run(aid, 'axis.sn', '0.72', 'auto', now())
db.prepare("INSERT INTO persona(agent_id,path,value,origin,updated_at) VALUES(?,?,?,?,?)")
  .run(aid, 'axis.ei', '0.31', 'auto', now())
db.prepare('INSERT INTO affect_state(agent_id,primary_label,intensity,mood,updated_at) VALUES(?,?,?,?,?)')
  .run(aid, 'curious', 0.66, 0.7, now())
db.prepare('INSERT INTO drive_state(agent_id,r,e,c,a,s,band,last_eval_at) VALUES(?,?,?,?,?,?,?,?)')
  .run(aid, 0.5, 0.5, 0.5, 0.5, 0.5, 'D1', now())

const day = '2026-10-28'
{
  appendTurn(db, aid, { sessionId: 's1', role: 'user', text: '今天去看了海', at: day + 'T10:00:00.000Z' })
  appendTurn(db, aid, { sessionId: 's1', role: 'assistant', text: '海风大吗', at: day + 'T10:01:00.000Z' })
  buildEpisode(db, aid, { session: 's1', day })
  addMemory(db, aid, { text: '用户喜欢看海', type: 'fact' })
}

// ---- 状态快照 + 口吻
{
  const ctx = diaryContext(db, aid)
  check('快照带性格五轴', Number(ctx.axes.sn) === 0.72, ctx.axes)
  check('快照带情绪', ctx.affect && ctx.affect.label === 'curious', ctx.affect)
  check('快照带驱力', ctx.drive && ctx.drive.band === 'D1', ctx.drive)
  const tone = diaryTone(ctx)
  check('口吻会被状态影响', /联想/.test(tone) && /话少|克制/.test(tone), tone)
  const d = await buildDiary(db, aid, day)
  check('日记写了口吻开句', /今天/.test(d.text) && d.text.split('\n').length >= 3, d.text.slice(0, 60))
  const got = getDiary(db, aid, day)
  check('日记存了 context', got.context && got.context.affect && got.context.affect.label === 'curious', got.context)
}

// ---- 仓库体量
{
  const w = warehouse(db, aid)
  check('六个分区都在', (w.parts || []).length === 6, (w.parts || []).map((p) => p.key))
  check('有短期/长期/书签', ['T0', 'T1', 'T2'].every((k) => w.parts.some((p) => p.key === k)), w.parts.map((p) => p.key))
  check('有原文/事实档案馆', ['T4', 'FA'].every((k) => w.parts.some((p) => p.key === k)))
  const t1 = w.parts.find((p) => p.key === 'T1')
  check('条数与字节都算出来', t1.rows >= 1 && t1.bytes > 0, t1)
  // 占比 = 现在条数 / 这个模块的容量，不是占总字节
  check('每个模块都带容量', w.parts.every((p) => Number(p.cap) > 0), w.parts.map((p) => [p.key, p.cap]))
  check('占比按容量算', Math.abs(t1.pct - (Math.round((t1.rows / t1.cap) * 1000) / 10)) < 0.05, { rows: t1.rows, cap: t1.cap, pct: t1.pct })
  check('占比不再加起来是 100', w.parts.reduce((s, p) => s + p.pct, 0) < 100, w.parts.reduce((s, p) => s + p.pct, 0))
  const capped = warehouse(db, aid, { caps: { T1: 2 } }).parts.find((p) => p.key === 'T1')
  check('容量可以覆盖', capped.cap === 2 && capped.pct >= 50, capped)
  check('有整库大小', w.db_bytes > 0, w.db_bytes)
}

// ---- 导出目录结构
{
  const root = path.join(dir, 'docs')
  const out = exportDocs(db, aid, { root })
  check('导出了文件', out.files > 0, out.files)
  const diaryFile = path.join(root, '日记', '2026', '2026-10.md')
  check('日记按月分层', fs.existsSync(diaryFile), diaryFile)
  const body = fs.readFileSync(diaryFile, 'utf8')
  check('日记文件带日期小标题与正文', body.includes('## ' + day) && body.includes('海'), body.slice(0, 80))
  check('对话档案存在', fs.existsSync(path.join(root, '对话档案', '2026', '10', day + '.md')))
  check('事实档案存在', fs.existsSync(path.join(root, '事实档案', '事实档案.md')))
  check('仓库能看到导出目录', warehouse(db, aid, { root }).docs.exists === true)
}

// ---- 保存位置可改
{
  const custom = path.join(dir, '我的记忆')
  const saved = setDocsRoot(db, custom)
  check('改保存位置会建目录', fs.existsSync(saved) && path.resolve(saved) === path.resolve(custom), saved)
  check('保存位置记住了', getDocsRoot(db) === path.resolve(custom), getDocsRoot(db))
  check('仓库默认用记住的位置', warehouse(db, aid).docs.root === path.resolve(custom))
  const out = exportDocs(db, aid)
  check('导出落到新位置', fs.existsSync(path.join(saved, '日记')) && out.root === path.resolve(custom), out.root)
  check('空路径被拒', (() => { try { setDocsRoot(db, '   '); return false } catch { return true } })())
}

// ---- 打开目录守卫（不真的弹窗：只测拒绝路径）
{
  const root = path.join(dir, 'docs')
  const bad = openFolder(path.join(dir, '..'), { root })
  check('不许打开导出目录之外', bad.ok === false, bad)
  const missing = openFolder(path.join(root, '不存在的目录'), { root })
  check('目录不存在时给提示', missing.ok === false && /先导出/.test(missing.reason), missing)
}

// ---- HTTP
{
  let n = 0
  const api = async (method, p, body = {}) => {
    const out = await handle(db, { method, path: p, body: { ...body, __idempotencyKey: 'v' + (++n) }, token: 'user' })
    return out.body
  }
  const w = await api('GET', `/v1/agents/${aid}/vault`)
  check('HTTP 仓库', w && Array.isArray(w.parts) && w.parts.length === 6, w && w.parts && w.parts.length)
  const ex = await api('POST', `/v1/agents/${aid}/vault/export`, {})
  check('HTTP 导出', ex && ex.files > 0, ex)
  const one = await api('GET', `/v1/agents/${aid}/diaries/${day}`)
  check('HTTP 单日日记带 context', one && one.context && one.context.drive, one && one.context)
}

console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exitCode = 1
