/**
 * D10 碎片兜底锁（2026-11-15）
 *
 * episode 停写后，原话还在 fragments：检索凑不够 k 条时，用 raw_fts 从碎片补。
 *   - 开关 on：能补出 frag_* 条；
 *   - 开关 off：不补（默认，测试隔离）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { recall } from '../src/modules/memory.js'
import { writeParam } from '../src/kernel.js'

const P = path.join(os.tmpdir(), 'dsh-check-frag-fallback-' + Date.now() + '.db')
let fails = 0
const ok = (name, cond, extra) => {
  if (cond) { console.log('PASS', name) } else { fails++; console.log('FAIL', name, extra ? JSON.stringify(extra) : '') }
}

try {
  const db = openDb(P)
  const aid = 'a1'
  const at = '2026-11-12T03:00:00Z'
  db.prepare('INSERT INTO agents(id,name,mode,status,created_at,schema_version) VALUES(?,?,?,?,?,1)').run(aid, '小测', 'daily', 'active', at)
  const texts = [
    '今天我要两点睡觉，这之前别劝我',
    '我把两件事列为不催的待定项：微信收发和视频皮肤',
  ]
  texts.forEach((t, i) => {
    const id = 'frag_' + (i + 1)
    db.prepare('INSERT INTO fragments(id,agent_id,session_id,turn_id,seq,role,text,created_at,day) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(id, aid, 's1', 't' + (i + 1), i + 1, 'user', t, at, '2026-11-12')
    db.prepare('INSERT INTO raw_fts(id,text) VALUES(?,?)').run(id, t)
  })

  writeParam(db, aid, 'memory.fragment.fallback', 'on')
  const r = recall(db, aid, '两点睡觉', 5, 512)
  const hit = (r.items || []).filter((it) => it.type === 'fragment' && String(it.id).startsWith('frag_'))
  ok('开关 on：碎片兜底补出原话', hit.length >= 1 && hit.some((x) => x.text.includes('两点睡觉')), { items: r.items?.map((x) => x.id) })
  ok('兜底条带来源/归一化分数', hit.every((x) => x.source === 'fragments' && x.score >= 0.35 && x.score <= 0.8), hit)

  writeParam(db, aid, 'memory.fragment.fallback', 'off')
  const r2 = recall(db, aid, '两点睡觉', 5, 512)
  const hit2 = (r2.items || []).filter((it) => it.type === 'fragment')
  ok('开关 off：不补（默认）', hit2.length === 0, { items: r2.items?.map((x) => x.id) })

  db.close()
} catch (e) {
  fails++
  console.log('FAIL 碎片兜底异常:', (e && e.stack) || e)
} finally {
  try { fs.rmSync(P) } catch { /* 清理失败不影响结论 */ }
}
process.exit(fails ? 1 : 0)
