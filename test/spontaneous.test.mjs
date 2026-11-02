/**
 * 自发扰动：很久没人说话的时候，偶尔自己心里动一下。
 * 运行：node test/spontaneous.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, now } from '../src/db.js'
import { attachDb } from '../src/algo/index.js'
import { setParam, getParam, setFlag } from '../src/kernel.js'
import { seedAffect, applyEmotionV3, spontaneousTick } from '../src/modules/affect.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) } else {
    fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400))
  }
}
const H = 3600000

/* 固定序列的随机数：测试不靠运气 */
function mulberry32(a) {
  let t = a >>> 0
  return function () {
    t = (t + 0x6d2b79f5) >>> 0
    let x = t
    x = Math.imul(x ^ (x >>> 15), x | 1)
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61)
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296
  }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-spont-'))
const db = openDb(path.join(dir, 'app.db'))
attachDb(db)
const aid = 'agt_spont'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid, '自发', 'daily', 'active', now())
seedAffect(db, aid)
applyEmotionV3(db, aid, { pleasure: 0, label: 'calm', at: Date.parse('2026-11-01T08:00:00.000Z') })

/* 空档不够长：一次都不掷 */
setParam(db, aid, 'affect.spont.rate', { value: 24 })
db.prepare('UPDATE agents SET last_interaction_at=?, created_at=? WHERE id=?')
  .run(new Date(Date.parse('2026-11-01T08:00:00.000Z')).toISOString(),
    new Date(Date.parse('2026-11-01T08:00:00.000Z')).toISOString(), aid)
const early = spontaneousTick(db, aid, Date.parse('2026-11-01T09:30:00.000Z'), { rnd: mulberry32(1) })
check('刚说过话两小时内：不起（idle 门槛）', early === null)
check('没起就不写样本', db.prepare("SELECT COUNT(*) n FROM affect_samples WHERE agent_id=? AND slow LIKE '%spontaneous%'").get(aid).n === 0)

/* 没人理很久 + 高频：掷，而且写事件 + 写样本 */
db.prepare('UPDATE agents SET last_interaction_at=? WHERE id=?')
  .run(new Date(Date.parse('2026-11-01T08:00:00.000Z')).toISOString(), aid)
let hits = 0
const t0 = Date.parse('2026-11-01T12:00:00.000Z')
const rnd = mulberry32(2026)
for (let i = 0; i < 48; i++) {
  const r = spontaneousTick(db, aid, t0 + i * 5 * 60000, { rnd })
  if (r) hits++
}
check('空了一天 + 高频：真的会冒出来', hits > 0, { hits })
const ev = db.prepare("SELECT COUNT(*) n FROM events WHERE agent_id=? AND type='affect.spontaneous'").get(aid).n
check('每一笔都留了事件（能翻回去看）', ev === hits, { ev, hits })
const nSamp = db.prepare("SELECT COUNT(*) n FROM affect_samples WHERE agent_id=? AND slow LIKE '%spontaneous%'").get(aid).n
check('每一笔也都进了样本（图上看得见）', nSamp === hits, { nSamp, hits })

/* 强度：不吓人，也不为零 */
const rows = db.prepare("SELECT slow FROM affect_samples WHERE agent_id=? AND slow LIKE '%spontaneous%'").all(aid)
const mags = rows.map((r) => Math.abs(JSON.parse(r.slow).fast))
check('每一次的强度都在设定幅度以内（≤ 0.12）', mags.every((m) => m <= 0.12 + 1e-9), { max: Math.max(...mags) })
check('至少有一次不是贴着 0（没白记）', mags.some((m) => m > 0.01), { sizes: mags.slice(0, 5) })

/* 方向：已经低着的时候，冒出来的那一下是往下的；高着的时候是往上的 */
setParam(db, aid, 'affect.spont.rate', { value: 48 })
db.prepare('UPDATE agents SET last_interaction_at=? WHERE id=?').run(new Date(t0 - 48 * H).toISOString(), aid)
const armRoll = (atMs) => setFlag(db, 'affect.spont.at:' + aid, new Date(atMs - 6 * H).toISOString())
armRoll(t0 + 4 * H)
db.prepare('UPDATE affect_v3 SET slow=-0.6, slow_at=?, fast_at=? WHERE agent_id=?')
  .run(new Date(t0 + 3 * H).toISOString(), new Date(t0 + 3 * H).toISOString(), aid)
const downHit = spontaneousTick(db, aid, t0 + 4 * H, { rnd: mulberry32(555) })
check('低着的时候冒出来的是往下的', downHit && downHit.pleasure < 0, { hit: downHit && downHit.pleasure })
armRoll(t0 + 6 * H)
db.prepare('UPDATE affect_v3 SET slow=0.6, slow_at=?, fast_at=? WHERE agent_id=?')
  .run(new Date(t0 + 5 * H).toISOString(), new Date(t0 + 5 * H).toISOString(), aid)
const upHit = spontaneousTick(db, aid, t0 + 6 * H, { rnd: mulberry32(777) })
check('高着的时候冒出来的是往上的', upHit && upHit.pleasure > 0, { hit: upHit && upHit.pleasure })

/* 关掉 */
setParam(db, aid, 'affect.spont.rate', { value: 0 })
check('rate 参数读得出来', Number(getParam(db, aid, 'affect.spont.rate')) === 0)
db.prepare('UPDATE agents SET last_interaction_at=? WHERE id=?').run(new Date(t0 - 48 * H).toISOString(), aid)
let offHits = 0
for (let i = 0; i < 20; i++) if (spontaneousTick(db, aid, t0 + 100 * H + i * 5 * 60000, { rnd: mulberry32(9) })) offHits++
check('rate=0 时一次都不冒（旧行为）', offHits === 0, { offHits })

/* 同一小时重复调用不会连炸：先到先得，掷过就不再掷 */
setParam(db, aid, 'affect.spont.rate', { value: 24 })
db.prepare('UPDATE agents SET last_interaction_at=? WHERE id=?').run(new Date(t0 - 48 * H).toISOString(), aid)
const tSame = t0 + 200 * H
let sameHits = 0
for (let i = 0; i < 6; i++) if (spontaneousTick(db, aid, tSame, { rnd: mulberry32(11) })) sameHits++
check('同一个时刻重复调用不会连着冒出（掷点会前移）', sameHits <= 1, { sameHits })

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
