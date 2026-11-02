/**
 * 回读解耦：语气只碰快情绪，不碰慢情绪。
 * 运行：node test/selfread-decouple.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, now } from '../src/db.js'
import { attachDb } from '../src/algo/index.js'
import { setParam } from '../src/kernel.js'
import { applySelfRead, readReplyTone } from '../src/modules/self_read.js'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS', name) } else {
    fail++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400))
  }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-selfread-'))
const db = openDb(path.join(dir, 'app.db'))
attachDb(db)
const aid = 'agt_sr'
db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)')
  .run(aid, '回读', 'chat', 'active', now())

const setState = (slow, fast) => db.prepare('UPDATE affect_v3 SET slow=?, fast=?, total=?, slow_at=?, fast_at=? WHERE agent_id=?')
  .run(slow, fast, fast, now(), now(), aid)
db.prepare('INSERT INTO affect_v3(agent_id,baseline,slow,fast,total,slow_at,fast_at) VALUES(?,?,?,?,?,?,?)')
  .run(aid, -0.2, 0, 0, 0, now(), now())

const warm = '好呀，今天想多聊一会儿～你慢慢说，我听着呢。'
const cold = '算了，随便，不想说这个。'

check('语气读得出来（暖）', readReplyTone(warm) && readReplyTone(warm).warmth > 0.2)
check('语气读得出来（冷）', readReplyTone(cold) && readReplyTone(cold).warmth < -0.2)
check('短句算平', readReplyTone('嗯。').flat === true)

/* 核心：语气暖，一点都不能动慢情绪 */
setState(-0.5, 0)
const r1 = applySelfRead(db, aid, warm)
let row = db.prepare('SELECT slow, fast FROM affect_v3 WHERE agent_id=?').get(aid)
check('暖句：慢情绪一动不动', row.slow === -0.5, { slow: row.slow })
check('暖句：碰的是快情绪', r1.applied === true && row.fast > 0, { r: r1, fast: row.fast })
check('暖句：快情绪只挪 ≤0.02', row.fast <= 0.02 + 1e-9, { fast: row.fast })

/* 冷句：往下，而且下行的步子打对折（拿一个不到封顶的距离来量） */
setState(-0.2, 0.1)
const r2 = applySelfRead(db, aid, cold)
row = db.prepare('SELECT slow, fast FROM affect_v3 WHERE agent_id=?').get(aid)
check('冷句：慢情绪一动不动', row.slow === -0.2, { slow: row.slow })
check('冷句：快情绪往下走', r2.applied === true && row.fast < 0.1, { fast: row.fast })
check('冷句：下行只有一半（-0.013 上下）',
  Math.abs(row.fast - 0.1) > 0.006 && Math.abs(row.fast - 0.1) < 0.018, { d: row.fast - 0.1 })

/* 死区：差得不多不碰 */
setState(-0.1, -0.1)
const r3 = applySelfRead(db, aid, '差不多吧，就这样。')
check('差得不多：不动', r3.applied === false && r3.reason === 'close', r3)

/* 连着二十轮都在哄人：慢情绪还是不动（以前这里会被顶到 0.3） */
setState(-0.5, 0)
let applied = 0
for (let i = 0; i < 20; i++) {
  const r = applySelfRead(db, aid, warm, { at: Date.now() + i * 60000 })
  if (r.applied) applied++
}
row = db.prepare('SELECT slow, fast FROM affect_v3 WHERE agent_id=?').get(aid)
check('连轰二十轮暖话：慢情绪仍然是 -0.5', row.slow === -0.5, { slow: row.slow })
check('二十轮里确实动过快情绪（不是空跑）', applied > 0, { applied })
check('快情绪没有一路飞上去（被死区挡住）', row.fast < 0.4, { fast: row.fast })

/* 关掉 */
setParam(db, aid, 'affect.selfread', { value: 'off' })
setState(-0.5, 0)
const off = applySelfRead(db, aid, warm)
row = db.prepare('SELECT slow, fast FROM affect_v3 WHERE agent_id=?').get(aid)
check('关掉之后完全不动', off.applied === false && off.reason === 'off' && row.fast === 0 && row.slow === -0.5)
setParam(db, aid, 'affect.selfread', { value: 'on' })

/* 空文本不炸 */
check('空文本不炸', applySelfRead(db, aid, '')?.reason === 'empty')

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
