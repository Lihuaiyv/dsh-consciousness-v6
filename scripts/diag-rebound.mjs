/**
 * 诊断：慢情绪为什么回不到水位线？
 * 拿真库的副本，对比两股力：
 *   A. 只说一句（applyEmotionV3）—— 应该往 b 落
 *   B. 连着说几轮（每轮 appraise + 回读自己的语气）—— 会不会被回读顶回去
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { applyEmotionV3 } from '../src/modules/affect.js'
import { applySelfRead } from '../src/modules/self_read.js'

const SRC = path.join(process.env.USERPROFILE || process.env.HOME, '.dsh', 'consciousness', 'app.db')
const AID = 'agt_3977d80f17'
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshc-diag-'))
const dst = path.join(dir, 'app.db')
fs.copyFileSync(SRC, dst)
for (const ext of ['-wal', '-shm']) {
  const f = SRC + ext
  if (fs.existsSync(f)) fs.copyFileSync(f, dst + ext)
}
const db = openDb(dst)
const H = 3600000

function state() {
  const r = db.prepare('SELECT slow, fast, baseline, slow_at FROM affect_v3 WHERE agent_id=?').get(AID)
  return r
}
function reset(slow, fast, at) {
  db.prepare('UPDATE affect_v3 SET slow=?, fast=?, slow_at=?, fast_at=? WHERE agent_id=?')
    .run(slow, fast, new Date(at).toISOString(), new Date(at).toISOString(), AID)
}

const nowMs = Date.now()
const s0 = state()
console.log('起点：slow=' + s0.slow + ' fast=' + s0.fast + ' 水位=' + Number(s0.baseline).toFixed(3))

/* A：什么都没发生，只是过 6 小时 */
reset(Number(s0.slow), Number(s0.fast), nowMs)
const a = applyEmotionV3(db, AID, { pleasure: 0, label: 'calm', at: nowMs + 6 * H, fresh: false })
console.log('A 干等 6 小时（无事件）：slow=' + a.slow + ' 水位=' + a.baseline.toFixed(3) + ' 差距=' + Math.abs(a.slow - a.baseline).toFixed(3))

/* B：这 6 小时里每 3 分钟说一轮，每轮回复都回读一次自己的语气 */
reset(Number(s0.slow), Number(s0.fast), nowMs)
const warm = '好呀，那先别急着弄了。你先坐着歇一会儿，我不催你，等你缓过来再说。'
let cur = state()
let selfN = 0
let selfSum = 0
for (let i = 1; i <= 120; i++) {
  const at = nowMs + i * 3 * 60000
  applyEmotionV3(db, AID, { pleasure: -0.2, label: 'irritated', at, fresh: true })
  const sr = applySelfRead(db, AID, warm, { at: at + 30000 })
  if (sr && sr.applied) { selfN++; selfSum += Number(sr.delta) || 0 }
  cur = state()
  const rr = db.prepare('SELECT base_off FROM affect_v3 WHERE agent_id=?').get(AID)
  if (i % 20 === 0) console.log('  B 第' + i + '轮 s=' + cur.slow + ' 水位=' + Number(cur.baseline).toFixed(3) + ' 负荷=' + Number(rr.base_off).toFixed(3))
}
console.log('  回读生效次数=' + selfN + ' 累计推高=' + selfSum.toFixed(3))
const b = state()
console.log('B 每 3 分钟一轮 + 回读语气：slow=' + b.slow + ' 水位=' + Number(b.baseline).toFixed(3) + ' 差距=' + Math.abs(b.slow - b.baseline).toFixed(3))

/* C：一样连着说，但把回读关掉 */
const prev = db.prepare("SELECT value FROM agent_params WHERE agent_id=? AND key='affect.selfread'").get(AID)
db.prepare("INSERT INTO agent_params(agent_id,key,value,updated_at) VALUES(?,?,?,?) ON CONFLICT(agent_id,key) DO UPDATE SET value=excluded.value")
  .run(AID, 'affect.selfread', '"off"', new Date().toISOString())
reset(Number(s0.slow), Number(s0.fast), nowMs)
for (let i = 1; i <= 120; i++) {
  const at = nowMs + i * 3 * 60000
  applyEmotionV3(db, AID, { pleasure: -0.2, label: 'irritated', at, fresh: true })
  applySelfRead(db, AID, warm, { at: at + 30000 })
}
const c = state()
console.log('C 一样连着说、回读关掉：slow=' + c.slow + ' 水位=' + Number(c.baseline).toFixed(3) + ' 差距=' + Math.abs(c.slow - c.baseline).toFixed(3))
db.prepare("UPDATE agent_params SET value=? WHERE agent_id=? AND key='affect.selfread'").run(prev ? prev.value : 'on', AID)

fs.rmSync(dir, { recursive: true, force: true })

