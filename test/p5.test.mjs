/**
 * P5 遗忘区状态机测试：目标温度 / 迟滞 / 钉住不下沉 / S1 挡冷 / S3 穿透 / HTTP。
 * 运行：node test/p5.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, now } from '../src/db.js'
import { attachDb } from '../src/algo/index.js'
import { addMemory } from '../src/modules/memory.js'
import { targetTemp, tickTemps, tempStats, COLD_DAYS, ARCHIVE_DAYS, HOT_HITS, HYSTERESIS } from '../src/modules/temps.js'
import { retrieve } from '../src/modules/retrieve.js'
import { handle } from '../src/api.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)) }
}

const DAY = 86400000
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-p5-'))
const db = openDb(path.join(dir, 'app.db'))
attachDb(db)
const aid = 'agt_p5'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid, 'P5', 'daily', 'active', now())

// ---- 目标温度（纯函数）
{
  const old = { hits: 0, created_at: new Date(Date.now() - (COLD_DAYS + 5) * DAY).toISOString() }
  const veryOld = { hits: 0, created_at: new Date(Date.now() - (ARCHIVE_DAYS + 5) * DAY).toISOString() }
  const hotRow = { hits: HOT_HITS, created_at: now(), last_hit_at: now() }
  check('90 天没用 → cold', targetTemp(old) === 'cold', targetTemp(old))
  check('180 天没用 → archived', targetTemp(veryOld) === 'archived', targetTemp(veryOld))
  check('最近想起来 → hot', targetTemp(hotRow) === 'hot', targetTemp(hotRow))
  check('新条默认 warm', targetTemp({ hits: 0, created_at: now() }) === 'warm')
  check('钉住的不下沉', targetTemp({ ...old, mark: 'locked' }) === 'hot')
}

// ---- 迟滞：往下降要连续 2 次，往上升一次就够
{
  const m = addMemory(db, aid, { text: '三个月前提过的一件小事', type: 'fact' })
  db.prepare('UPDATE memory_items SET created_at=?, last_hit_at=NULL, hits=0 WHERE id=?')
    .run(new Date(Date.now() - (COLD_DAYS + 1) * DAY).toISOString(), m.id)
  const first = tickTemps(db, aid)
  check('第一次只记意愿、不迁移', !first.some((x) => x.id === m.id), first)
  check('计数 +1', Number(db.prepare('SELECT state_streak s FROM memory_items WHERE id=?').get(m.id).s) === 1)
  const second = tickTemps(db, aid)
  check('第二次真的迁到 cold', second.some((x) => x.id === m.id && x.to === 'cold') || db.prepare('SELECT temp_state t FROM memory_items WHERE id=?').get(m.id).t === 'cold', second)
  check('迁移后计数归零', Number(db.prepare('SELECT state_streak s FROM memory_items WHERE id=?').get(m.id).s) === 0)

  // 想起来 → 直接升 hot，不用等两次
  db.prepare('UPDATE memory_items SET hits=?, last_hit_at=? WHERE id=?').run(HOT_HITS, now(), m.id)
  const up = tickTemps(db, aid)
  check('升热一次就生效', (up.some((x) => x.id === m.id && x.to === 'hot')) || db.prepare('SELECT temp_state t FROM memory_items WHERE id=?').get(m.id).t === 'hot', up)
}

// ---- S1 挡冷、S2/S3 穿透
{
  const cold = addMemory(db, aid, { text: '很久以前聊过的潜水证', type: 'fact' })
  db.prepare("UPDATE memory_items SET temp_state='cold', created_at=?, last_hit_at=NULL WHERE id=?")
    .run(new Date(Date.now() - (COLD_DAYS + 10) * DAY).toISOString(), cold.id)
  const warm = addMemory(db, aid, { text: '最近在弄潜水装备清单', type: 'fact' })

  const s1 = retrieve(db, aid, '潜水', { k: 6, scene: 'S1', noUpgrade: true })
  const ids = s1.items.map((x) => x.id)
  check('S1 不召回冷记忆', !ids.includes(cold.id), s1.items.map((x) => x.text))
  check('S1 召回温记忆', ids.includes(warm.id), s1.items.map((x) => x.text))

  const s3 = retrieve(db, aid, '潜水', { k: 6, scene: 'S3' })
  check('S3 能穿透到冷记忆', s3.items.some((x) => x.id === cold.id), s3.items.map((x) => x.text))
}

// ---- 统计与 HTTP
{
  const st = tempStats(db, aid)
  check('统计含四档', ['hot', 'warm', 'cold', 'archived'].every((k) => typeof st[k] === 'number'), st)
  const total = st.hot + st.warm + st.cold + st.archived
  check('统计总和等于活跃条数', total === db.prepare("SELECT COUNT(*) n FROM memory_items WHERE agent_id=? AND status='active' AND invalid_at IS NULL").get(aid).n, { st, total })

  let n = 0
  const api = async (method, p, body = {}) => {
    const out = await handle(db, { method, path: p, body: { ...body, __idempotencyKey: 'p5' + (++n) }, token: 'user' })
    return out.body
  }
  const t = await api('GET', `/v1/agents/${aid}/temps`)
  check('HTTP 温度统计', t && t.stats && typeof t.stats.warm === 'number', t)
  const tick = await api('POST', `/v1/agents/${aid}/temps/tick`)
  check('HTTP 手动推进状态机', tick && Array.isArray(tick.moved), tick)
  const tiers = await api('GET', `/v1/agents/${aid}/tiers`)
  check('档位统计里带温度', tiers && tiers.temps && typeof tiers.temps.warm === 'number', tiers && tiers.temps)
}

console.log(`\n通过 ${pass} / ${pass + fail}`)
if (fail) process.exitCode = 1
