/**
 * 检索回放日志测试：写入 / 列表 / 汇总 / 清理 / HTTP。
 * 运行：node test/retrieval-log.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, now } from '../src/db.js'
import { attachDb } from '../src/algo/index.js'
import { logRetrieval, listRetrievalLog, retrievalStats, pruneRetrievalLog } from '../src/modules/retrieval_log.js'
import { handle } from '../src/api.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-rlog-'))
const db = openDb(path.join(dir, 'app.db'))
attachDb(db)
const aid = 'agt_rlog'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid, '日志', 'daily', 'active', now())

// ---- 写入与读取
{
  const old = new Date(Date.now() - 2 * 86400000).toISOString()
  const mid = new Date(Date.now() - 3600000).toISOString()
  logRetrieval(db, aid, { at: old, scene: 'S1', query: '咖啡', why: ['默认'], counts: { T1: 7 }, kept: { T1: 2 }, items: 2, tokens: 44, ms: 12 })
  logRetrieval(db, aid, { at: mid, scene: 'S3', query: '量子色动力学', why: ['默认', '升级'], items: 0, tokens: 0, ms: 5 })
  logRetrieval(db, aid, { scene: 'v2', query: '旧路径', items: 1, tokens: 20, dropped: ['T4'], ms: 3 })
  const rows = listRetrievalLog(db, aid, { limit: 10 })
  check('三条都记下了', rows.length === 3, rows.length)
  check('新的在前', rows[0].scene === 'v2' && rows[2].scene === 'S1', rows.map((r) => r.scene))
  check('JSON 字段能解析', Array.isArray(rows[1].why) || Array.isArray(rows[2].why), rows.map((r) => r.why))
  const s1 = rows.find((r) => r.scene === 'S1')
  check('S1 的计数与 token 存对', s1.counts.T1 === 7 && s1.kept.T1 === 2 && s1.tokens === 44, s1)
  check('空查询不炸', logRetrieval(db, aid, {}) === true)
  const one = listRetrievalLog(db, aid, { scene: 'S3' })
  check('按场景过滤', one.length === 1 && one[0].scene === 'S3', one.length)
}

// ---- 汇总
{
  const st = retrievalStats(db, aid, 7)
  check('汇总总次数', st.total === 4, st.total)
  check('空手数只数 items=0', st.empty === 2, st.empty)
  check('空手率', st.empty_rate === 0.5, st.empty_rate)
  check('分场景有 S1 / S3', st.scenes.some((x) => x.scene === 'S1') && st.scenes.some((x) => x.scene === 'S3'), st.scenes.map((x) => x.scene))
  const s1 = st.scenes.find((x) => x.scene === 'S1')
  // S1 有两条：一条召回 2 条、一条空查询 0 条 → 平均 1
  check('S1 平均召回条数', s1.items === 1, s1)
}

// ---- 清理
{
  const n = pruneRetrievalLog(db, aid, 3)
  check('只清 30 天前的（这里 2 天前不该被清）', n === 0, n)
  const old = new Date(Date.now() - 40 * 86400000).toISOString()
  db.prepare(`INSERT INTO retrieval_log(id,agent_id,at,scene,query,items,tokens) VALUES(?,?,?,?,?,?,?)`)
    .run('rlg_old', aid, old, 'S1', '很老的一条', 1, 10)
  check('40 天前的会被清掉', pruneRetrievalLog(db, aid, 30) === 1)
  check('清完还剩原来的', listRetrievalLog(db, aid, { limit: 50 }).length === 4)
}

// ---- HTTP
{
  let n = 0
  const api = async (method, p, body = {}) => {
    const out = await handle(db, { method, path: p, body: { ...body, __idempotencyKey: 'rl' + (++n) }, token: 'user' })
    return out.body
  }
  const list = await api('GET', `/v1/agents/${aid}/retrieval-log?limit=5`)
  check('HTTP 列表', Array.isArray(list.items) && list.items.length >= 1, list.items && list.items.length)
  const stats = await api('GET', `/v1/agents/${aid}/retrieval-stats?days=7`)
  check('HTTP 汇总', stats.total >= 1 && Array.isArray(stats.scenes), stats)
}

console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exitCode = 1
