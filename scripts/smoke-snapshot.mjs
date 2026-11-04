/**
 * 感受快照冒烟：真的把一段系统提示拼出来，看那一行在不在、位置对不对、关得掉关不掉。
 *   node scripts/smoke-snapshot.mjs
 *
 * 验六件事：
 *   1) 默认拼得出来，位置在「感觉现在大概」之后、「现在：」之前；
 *   2) `affect.inject.snapshot=off` → 整行消失（逐字回到改前）；
 *   3) QQ 非主人（opts.snap='off'）→ 整行消失，主人在的时候照给；
 *   4) 陌生人（audience='stranger'）→ 不给；
 *   5) 预算被压到 40 token → 整行丢，**不许剩半句**；
 *   6) 探针 event `affect.snapshot.injected` 真的落了。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { consciousnessBlock } from '../index.js'
import { writeParam } from '../src/kernel.js'
import { seedTiers } from '../src/modules/relations.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name) }
  else { fail++; console.log('FAIL ' + name + '  ' + JSON.stringify(detail === undefined ? '' : detail).slice(0, 500)) }
}

const now = () => new Date().toISOString()
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-snap-smoke-'))
const db = openDb(path.join(dir, 'app.db'))
const aid = 'agt_snap_smoke'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid, '小汐', 'chat', 'active', now())

const putPersona = db.prepare('INSERT INTO persona(agent_id,path,value,updated_at) VALUES(?,?,?,?)')
putPersona.run(aid, 'style.tone', JSON.stringify('可爱粘人'), now())
putPersona.run(aid, 'style.address', JSON.stringify('主人'), now())
putPersona.run(aid, 'axis.ei', JSON.stringify(0.35), now())

db.prepare(`INSERT INTO affect_state(agent_id,primary_label,secondary_label,intensity,mood,pleasure,arousal,dominance,updated_at)
  VALUES(?,?,?,?,?,?,?,?,?)`).run(aid, 'peaceful', null, 0.62, 0.55, 0.2, 0.1, 0.1, now())
db.prepare('INSERT INTO affect_v3(agent_id,baseline,slow,fast,total,slow_at,fast_at) VALUES(?,?,?,?,?,?,?)')
  .run(aid, 0.05, 0.12, 0.2, 0.18, now(), now())

seedTiers(db)
db.prepare(`INSERT INTO rel_person(id,agent_id,name,tier,closeness,trust,dependence,salience,status,
  first_seen_at,last_seen_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  .run('rp_1', aid, '主人', 'owner', 0.94, 0.74, 0.22, 1, 'active', now(), now(), now(), now())

// 上一刻：一条事件 + 同刻样本（差 1ms，跟真实写入一样）
const at = new Date(Date.now() - 60000).toISOString()
const at2 = new Date(Date.now() - 60000 + 1).toISOString()
db.prepare('INSERT INTO affect_events(id,agent_id,at,cause,label,gate) VALUES(?,?,?,?,?,?)')
  .run('aev_smoke', aid, at, '我可不舍得说难听的话', 'peaceful', 1)
db.prepare('INSERT INTO affect_samples(id,agent_id,at,label,intensity,fast,slow) VALUES(?,?,?,?,?,?,?)')
  .run('afs_smoke', aid, at2, 'peaceful', 0.766,
    JSON.stringify({ pleasure: 0.2, arousal: 0.1, dominance: 0.1 }),
    JSON.stringify({ slow: 0.11, fast: 0.2, total: 0.18, fast_self: 0.02, fast_empathy: 0.18 }))

const SNAP = '（上一句落在我身上'

// 1 默认
const b1 = consciousnessBlock(db, aid)
check('默认：快照那行在', b1.includes(SNAP), b1.slice(0, 200))
check('默认：带原话', b1.includes('我可不舍得说难听的话'), b1.includes('我可不舍得说难听的话'))
check('默认：带数', b1.includes('慢 +0.11') && b1.includes('快 +0.20'), b1.match(/（上一句[^\n]*/)?.[0])
{
  const feltAt = b1.indexOf('感觉现在大概')
  const snapAt = b1.indexOf(SNAP)
  const nowAt = b1.indexOf('现在：')
  check('位置：在「感觉现在大概」之后', feltAt >= 0 && snapAt > feltAt, { feltAt, snapAt })
  check('位置：在「现在：」之前', nowAt > snapAt, { snapAt, nowAt })
}

// 2 开关 off
writeParam(db, aid, 'affect.inject.snapshot', 'off')
const b2 = consciousnessBlock(db, aid)
check('开关 off：整行消失', !b2.includes(SNAP), b2.includes(SNAP))
writeParam(db, aid, 'affect.inject.snapshot', 'on')

// 3 QQ 非主人
const b3 = consciousnessBlock(db, aid, { snap: 'off' })
check('QQ 非主人：不给', !b3.includes(SNAP), b3.includes(SNAP))
const b3b = consciousnessBlock(db, aid, { snap: 'on' })
check('QQ 主人：照给', b3b.includes(SNAP), b3b.includes(SNAP))

// 4 陌生人
const b4 = consciousnessBlock(db, aid, { audience: 'stranger' })
check('陌生人：不给', !b4.includes(SNAP), b4.includes(SNAP))

// 5 预算压死：整行丢，不许半句
writeParam(db, aid, 'memory.inject.budget', 40)
const b5 = consciousnessBlock(db, aid)
check('预算 40：那行整条没了', !b5.includes(SNAP), b5.includes(SNAP))
check('预算 40：也没剩下半句「…那一刻」', !b5.includes('那一刻 慢'), b5.slice(0, 300))
writeParam(db, aid, 'memory.inject.budget', 800)

// 6 探针
const probe = db.prepare("SELECT COUNT(*) n FROM events WHERE agent_id=? AND type='affect.snapshot.injected'").get(aid)
check('探针：affect.snapshot.injected 落了', Number(probe.n) >= 1, probe)

console.log('\n通过 ' + pass + ' / ' + (pass + fail))
process.exit(fail ? 1 : 0)
