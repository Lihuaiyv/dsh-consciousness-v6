/**
 * 端到端自检：走 api.handle（和线上同一条路由），在真实库的副本上。
 *
 * 验：
 *   1. GET  /persona/evidence   新路由存在
 *   2. PUT  /persona/intent     意图能写、能读
 *   3. POST /persona/axis       能手动交回经历
 *   4. learnFromTurn 三次夸奖   证据入账 + 攒够密度后轴真的动
 *
 * 用法：node scripts/axis-e2e.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { openDb } from '../src/db.js'
import { handle } from '../src/api.js'
import { learnFromTurn } from '../src/features.js'
import { readAxes } from '../src/modules/traits.js'
import { snapshot } from '../src/modules/axis_evidence.js'

const src = path.join(os.homedir(), '.dsh', 'consciousness', 'app.db')
const tmp = path.join(os.tmpdir(), 'axis-e2e-' + Date.now() + '.db')
fs.copyFileSync(src, tmp)
const db = openDb(tmp)

const aid = 'agt_3977d80f17'
const base = '/v1/agents/' + aid
const call = (method, p, body = {}) => handle(db, { method, path: base + p, body, token: 'user' })
const show = (k, v) => console.log(k.padEnd(24), typeof v === 'string' ? v : JSON.stringify(v))

let ok = 0
const check = (name, cond, extra) => {
  console.log((cond ? '  ✅ ' : '  ❌ ') + name + (extra ? '  ' + JSON.stringify(extra) : ''))
  if (cond) ok++
}

// 1. 证据路由
let r = await call('GET', '/persona/evidence')
check('GET /persona/evidence 200', r.status === 200 && Array.isArray(r.body.axes), r.status)

// 2. 意图写读删
r = await call('PUT', '/persona/intent', { key: 'ei', target: 0.7, __idempotencyKey: 'e2e-intent-' + Date.now() })
check('PUT /persona/intent 200', r.status === 200 && r.body.changed === true, r.body)
r = await call('GET', '/persona/intent')
check('GET /persona/intent 带 ei=0.7', r.status === 200 && r.body.intents?.some((x) => x.axis === 'ei' && x.target === 0.7), r.body)
r = await call('PUT', '/persona/intent', { key: 'ei', target: null, __idempotencyKey: 'e2e-clear-' + Date.now() })
check('清意图', r.status === 200)

// 3. 交回经历（tf 现在应该已经是 auto，返回 not-manual 也算路由通）
r = await call('POST', '/persona/axis', { key: 'tf', why: 'e2e', __idempotencyKey: 'e2e-release-' + Date.now() })
check('POST /persona/axis 200', r.status === 200, r.body)

// 4. 真聊天链路：三句夸奖 → 关系事件 + 性格证据
const before = readAxes(db, aid)
for (const t of ['谢谢你，这次真的帮我省了很多事。', '你真好，做得不错。', '这次我很喜欢，很开心。']) {
  try { learnFromTurn(db, aid, t, null) } catch (e) { console.log('learn 失败', e.message) }
}
const after = readAxes(db, aid)
show('学习前五轴', before)
show('学习后五轴', after)
show('证据快照', snapshot(db, aid).filter((x) => x.total > 0))
const evTotal = db.prepare('SELECT COUNT(*) n FROM axis_evidence WHERE agent_id=?').get(aid).n
check('证据表有记录', evTotal > 0, { evTotal })

// 5. 再补几条，直到跨过密度阈值
for (let i = 0; i < 6; i++) {
  try { learnFromTurn(db, aid, '谢谢你，我喜欢这样，很好。', null) } catch { /* ignore */ }
}
const finalAxes = readAxes(db, aid)
show('补足后五轴', finalAxes)
const moved = Object.keys(before).some((k) => Math.abs(finalAxes[k] - before[k]) > 1e-6)
check('轴真的动了（不是摆设）', moved, { before, after: finalAxes })

db.close()
try { fs.unlinkSync(tmp) } catch { /* ignore */ }
console.log('\n通过 ' + ok + ' 项')
process.exit(0)
