/**
 * P3 浏览入口 + P2 传感器 v3 的测试。
 * 运行：node test/browse-sensor.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, now } from '../src/db.js'
import { attachDb } from '../src/algo/index.js'
import { classifyBrowse, ingestBrowse, browseSummary, listBrowse } from '../src/modules/browse.js'
import { computeNeedProxies } from '../src/modules/proxies.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-browse-'))
const db = openDb(path.join(dir, 'app.db'))
attachDb(db)
const aid = 'agt_browse'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid, '浏览', 'daily', 'active', now())

// ---- 分类：词表打标签，单条封顶
{
  const p = classifyBrowse({ text: '今天和朋友吵架了，关系有点僵', title: '关系' })
  check('人物词打 people', p.tags.includes('people'), p)
  check('人物 → R 权重 0.01', p.weights.R === 0.01, p.weights)
  const t = classifyBrowse({ text: '出了一次事故，很危险', title: '事故' })
  check('威胁词打 threat', t.tags.includes('threat'), t)
  check('威胁 → S 负权重', t.weights.S === -0.01, t.weights)
  const d = classifyBrowse({ text: '这个原理到底是怎么回事，机制是什么', dwell_ms: 65000 })
  check('深读打 deep', d.tags.includes('deep'), d)
  check('深读 → C 权重 0.01', d.weights.C === 0.01, d.weights)
  const half = classifyBrowse({ text: 'x'.repeat(1600), dwell_ms: 1000 })
  check('停留不足 3s → 打五折', Math.abs(half.weights.C - 0.005) < 1e-9 && Math.abs(half.weights.E - 0.01) < 1e-9, half.weights)
  const q = classifyBrowse({ title: '随便看看', query: '咖啡' })
  check('自己搜的 → self_issued', q.tags.includes('self_issued'), q)
}

// ---- ingest：落库 / 新领域 / 去重
{
  const a = ingestBrowse(db, aid, { url: 'https://alpha.com/a', title: '原理详解', text: '这个原理是怎么回事，机制是什么' })
  check('第一条落库', a.ok === true && !!a.id, a)
  check('新 domain 标 new_domain', a.new_domain === true && a.tags.includes('new_domain'), a)
  check('E 权重 0.02（单条封顶）', a.weights.E === 0.02, a.weights)
  const dup = ingestBrowse(db, aid, { url: 'https://alpha.com/a', title: '原理详解' })
  check('同 url 72h 内去重', dup.dup === true, dup)
  const sameDomain = ingestBrowse(db, aid, { url: 'https://alpha.com/b', title: '另一页' })
  check('同 domain 不算新领域', sameDomain.new_domain === false && sameDomain.weights.E === 0, sameDomain)
  const b = ingestBrowse(db, aid, { url: 'https://beta.org/x', title: '新的地方' })
  check('换 domain 又算新领域', b.new_domain === true, b)
  const rows = listBrowse(db, aid, 10)
  check('列表按时间倒序', rows.length === 3 && rows[0].id === b.id, rows.map((r) => r.id))
  const s = browseSummary(db, aid, 3)
  check('browseNew = 新领域比例', s.total === 3 && s.new_domain === 2 && Math.abs(s.browseNew - 2 / 3) < 1e-6, s)
}

// ---- 限流：一小时 30 条
{
  for (let i = 0; i < 30; i++) {
    db.prepare('INSERT INTO browse_items(id,agent_id,url,domain,title,text,query,channel,dwell_ms,tags,weights,at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
      .run('bwi_rate_' + i, aid, 'https://r' + i + '.com/' + i, 'r' + i + '.com', 't', 'x', null, 'browse', 0, '[]', '{}', now())
  }
  let code = null
  try { ingestBrowse(db, aid, { url: 'https://overflow.com/1', title: '超了' }) } catch (e) { code = e.code }
  check('超过 30 条/小时 → 429', code === 'RATE_LIMITED', code)
}

// ---- 开关：drive.browse.ingest=off 时不落库
{
  db.prepare('INSERT OR REPLACE INTO agent_params(agent_id,key,value,updated_at) VALUES(?,?,?,?)')
    .run(aid, 'drive.browse.ingest', 'off', now())
  const before = listBrowse(db, aid, 100).length
  const r = ingestBrowse(db, aid, { url: 'https://off.example.com/x', title: '不该落' })
  check('关掉时直接跳过', r.skipped === 'disabled', r)
  check('关掉时确实没写', listBrowse(db, aid, 100).length === before, null)
  db.prepare('INSERT OR REPLACE INTO agent_params(agent_id,key,value,updated_at) VALUES(?,?,?,?)')
    .run(aid, 'drive.browse.ingest', 'on', now())
}

// ---- v3 传感器：五维都有、browseNew 吃到浏览
{
  const pack = computeNeedProxies(db, aid)
  check('v3 包存在', !!pack.v3, pack && Object.keys(pack))
  const v3 = pack.v3 || {}
  const dims = ['R', 'E', 'C', 'A', 'S']
  check('v3 五维齐全且在 0~1', dims.every((k) => typeof v3.proxies[k] === 'number' && v3.proxies[k] >= 0 && v3.proxies[k] <= 1), v3.proxies)
  check('v3 detail 带 browseNew', typeof v3.detail.browseNew === 'number', v3.detail)
  const s = browseSummary(db, aid, 3)
  check('v3 的 browseNew 与库一致', Math.abs(v3.detail.browseNew - s.browseNew) < 1e-3, { v: v3.detail.browseNew, s })
  check('v3 与 v2 是两套数', v3.proxies.R !== pack.proxies.R || v3.proxies.E !== pack.proxies.E, { v2: pack.proxies, v3: v3.proxies })
}

console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exit(1)
