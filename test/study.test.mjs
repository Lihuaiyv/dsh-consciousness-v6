/**
 * 时间线 / 原话 测试。
 * 运行：node test/study.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, now } from '../src/db.js'
import { attachDb } from '../src/algo/index.js'
import { addMemory } from '../src/modules/memory.js'
import { appendTurn } from '../src/modules/archive.js'
import { timeline, turnDetail, topMemory } from '../src/modules/study.js'
import { localDay } from '../src/modules/nightly.js'
import { handle } from '../src/api.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-study-'))
const db = openDb(path.join(dir, 'app.db'))
attachDb(db)
const aid = 'agt_study'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid, '时间线', 'daily', 'active', now())

const t1 = appendTurn(db, aid, { sessionId: 's1', role: 'user', text: '我的猫叫团子，是只橘猫' })
appendTurn(db, aid, { sessionId: 's1', role: 'assistant', text: '团子这名字好听' })
const m1 = addMemory(db, aid, { text: '用户养了一只叫团子的橘猫', type: 'fact', turn_id: t1.id })
addMemory(db, aid, { text: '用户在做记忆分层插件', type: 'fact' })

// ---- 时间线
{
  const tl = timeline(db, aid, { days: 7 })
  check('时间线有分组', tl.groups.length >= 1 && tl.total >= 2, { total: tl.total, groups: tl.groups.length })
  const g = tl.groups[0]
  check('分组带当天条数', g.count === g.items.length && g.day.length === 10, g.day)
  check('条目带热度与档位', g.items[0].heat != null && g.items[0].temp_state != null, g.items[0])
}

// ---- 近 5 天：本地历日占位，空天也在，跨天凌晨不掉进 UTC 昨天
{
  const tl5 = timeline(db, aid, { days: 5 })
  check('近 5 天 groups 真有 5 天', tl5.groups.length === 5, tl5.groups.map((x) => x.day))
  check('第一天是今天（本地）', tl5.groups[0].day === localDay(), tl5.groups[0].day)
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  start.setDate(start.getDate() - 4)
  check('最后一天是今天往前第 4 天', tl5.groups[4].day === localDay(start), tl5.groups[4].day)

  // 插一条「今天凌晨 2 点」：按 UTC 会掉到昨天，按本地日应仍归今天
  const dawn = new Date()
  dawn.setHours(2, 0, 0, 0)
  const mid = addMemory(db, aid, { text: '凌晨记下的事·时间线本地日', type: 'fact' })
  db.prepare('UPDATE memory_items SET created_at=? WHERE id=?').run(dawn.toISOString(), mid.id)
  const tlDawn = timeline(db, aid, { days: 5 })
  const todayG = tlDawn.groups.find((x) => x.day === localDay())
  check('凌晨记忆归本地今天', todayG && todayG.items.some((x) => x.id === mid.id), {
    today: localDay(), utcSlice: dawn.toISOString().slice(0, 10), groups: tlDawn.groups.map((x) => x.day + ':' + x.count),
  })
}

// ---- 热度榜按档配额：普通新事实进中期，老低分进长期，桌面不该被短期占满
{
  addMemory(db, aid, { text: '超级重要的承诺边界', type: 'fact', importance: 0.95 })
  const oldId = addMemory(db, aid, { text: '很久以前一件小事·配额', type: 'fact', importance: 0.05 }).id
  db.prepare('UPDATE memory_items SET created_at=? WHERE id=?')
    .run(new Date(Date.now() - 400 * 86400000).toISOString(), oldId)
  const top = topMemory(db, aid, { limit: 99 })
  const bands = new Set((top.items || []).map((x) => x.band))
  check('热度榜含中期', bands.has('mid'), { counts: top.counts, bands: [...bands] })
  check('热度榜含长期', bands.has('long') || (top.counts && top.counts.long > 0), { counts: top.counts, bands: [...bands] })
  check('短期不该多于中期（桌面应少）',
    Number(top.counts.short || 0) <= Number(top.counts.mid || 0), top.counts)
}

// ---- 原话
{
  const d = turnDetail(db, aid, t1.id)
  check('能取到原话', d && d.turn && /团子/.test(d.turn.text), d && d.turn && d.turn.text)
  check('带前后几句', d.around.length >= 1, d.around.length)
  check('不存在的 id 返回 null', turnDetail(db, aid, 'raw_nope') === null)
}

// ---- HTTP
{
  let n = 0
  const api = async (method, p, body = {}) => {
    const out = await handle(db, { method, path: p, body: { ...body, __idempotencyKey: 'st' + (++n) }, token: 'user' })
    return out.body
  }
  const tl = await api('GET', `/v1/agents/${aid}/memory/timeline?days=7`)
  check('HTTP 时间线', tl && Array.isArray(tl.groups), tl && tl.groups && tl.groups.length)
  const tr = await api('GET', `/v1/agents/${aid}/turns/${t1.id}`)
  check('HTTP 原话', tr && tr.turn && tr.turn.id === t1.id, tr && tr.turn && tr.turn.id)
  const top = await api('GET', `/v1/agents/${aid}/memory/top?limit=2`)
  const heats = (top && top.items || []).map((x) => Number(x.heat) || 0)
  check('HTTP 热度榜按 heat 降序', Array.isArray(top.items) && top.items.length === 2 && heats[0] >= heats[1], { total: top.total, heats })
  check('HTTP 热度榜带回档计数', top && top.counts && typeof top.counts.short === 'number', top && top.counts)
}

console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exitCode = 1
