/**
 * U5 中文金标：蒸馏路径 + 召回门槛（不联网）。
 * 退出码：0 过线 / 1 未过。npm run eval:memory
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, now } from '../src/db.js'
import { attachDb } from '../src/algo/index.js'
import { appendTurn, buildEpisodes } from '../src/modules/archive.js'
import { runNightly, localDay } from '../src/modules/nightly.js'
import { retrieve } from '../src/modules/retrieve.js'
import { writeParam } from '../src/kernel.js'
import { rememberFact } from '../src/modules/remember_tool.js'
import { retrieveAsOf, memoryHistory } from '../src/modules/asof.js'

const GOLD = [
  { talk: '我们定了：部署一律用方案甲，别再改回乙。', probe: '方案甲', need: '方案甲' },
  { talk: '记住我喜欢深色主题写代码。', probe: '深色', need: '深色' },
  { talk: '我的猫叫团子，是橘猫。', probe: '团子', need: '团子' },
]

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-gold-'))
const db = openDb(path.join(dir, 'app.db'))
attachDb(db)
const aid = 'agt_gold'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid, 'gold', 'daily', 'active', now())
writeParam(db, aid, 'memory.episode.distill', 'on')
writeParam(db, aid, 'memory.episode.distill.rules', 'on')
writeParam(db, aid, 'memory.episode.refine', 'off')
writeParam(db, aid, 'memory.llm.daily_cap', 32)

const day = localDay()
for (const g of GOLD) {
  appendTurn(db, aid, { sessionId: 's_gold', role: 'user', text: g.talk, at: now() })
  appendTurn(db, aid, { sessionId: 's_gold', role: 'assistant', text: '好的，记下了。', at: now() })
}
await buildEpisodes(db, aid, { day, session: 's_gold' })
await runNightly(db, aid, {
  day,
  force: true,
  extract: async () => GOLD.map((g) => ({
    text: g.need.length >= 4 ? ('用户相关：' + g.need) : g.talk.slice(0, 40),
    type: 'fact',
    key: g.probe,
  })),
  summarize: null,
  merge: false,
})

// remember 金标补一条
rememberFact(db, aid, { text: '每周二晚上去游泳', key: 'habit.swim' })

let hit = 0
const probes = [...GOLD.map((g) => g.probe), '游泳']
for (const p of probes) {
  const r = retrieve(db, aid, p, { k: 8, floor: 0 })
  const ok = r.items.some((x) => String(x.text || '').includes(p) || probes.some((q) => String(x.text || '').includes(q) && p === q))
  // 宽松：probe 字样出现在任一命中
  const ok2 = r.items.some((x) => String(x.text || '').includes(p))
  if (ok2) hit++
  console.log(ok2 ? 'HIT' : 'MISS', p, '→', r.items.slice(0, 3).map((x) => x.text).join(' | '))
}
const rate = hit / probes.length
console.log(`\n金标命中 ${hit}/${probes.length} = ${(rate * 100).toFixed(0)}%`)

// G1 「那时」金标：改口前那一刻问，答旧版本；现在问，答新版本；翻旧账不改热度
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
await sleep(30)
const tBefore = now()
await sleep(30)
rememberFact(db, aid, { text: '每周二和周四晚上去游泳', key: 'habit.swim' })
const heat = () => JSON.stringify(db.prepare('SELECT id,hits,last_hit_at,heat,band FROM memory_items WHERE agent_id=? ORDER BY id').all(aid))
const h0 = heat()
const asofGold = []
{
  const v = retrieveAsOf(db, aid, '游泳', { at: tBefore })
  const it = (v.items || []).find((x) => String(x.text).includes('游泳'))
  asofGold.push({ name: '改口前那一刻 = 每周二', ok: !!it && it.text.includes('每周二晚上') && !it.text.includes('周四'), got: it && it.text })
  asofGold.push({ name: '并注明现在已变', ok: !!it && /周四/.test(it.now || ''), got: it && it.now })
  const cur = retrieveAsOf(db, aid, '游泳', { at: now() })
  const c = (cur.items || []).find((x) => String(x.text).includes('游泳'))
  asofGold.push({ name: '现在 = 二和周四', ok: !!c && c.text.includes('周四'), got: c ? c.text : { reason: cur.reason, range: cur.range, items: (cur.items || []).map((x) => x.text) } })
  const hist = memoryHistory(db, aid, it ? it.id : '')
  asofGold.push({ name: '单条历史两版', ok: !!hist && hist.versions.length === 2, got: hist && hist.versions.map((x) => x.text) })
}
asofGold.push({ name: '翻旧账不改热度', ok: heat() === h0 })
for (const g of asofGold) console.log(g.ok ? 'HIT ' : 'MISS', '那时·' + g.name, g.ok ? '' : JSON.stringify(g.got))
const asofHit = asofGold.filter((g) => g.ok).length
console.log(`那时金标 ${asofHit}/${asofGold.length}`)

db.close()
if (rate < 0.75 || asofHit < asofGold.length) {
  console.error('未过线：召回需要 ≥75%，那时金标需要全中')
  process.exitCode = 1
} else {
  console.log('过线')
}
