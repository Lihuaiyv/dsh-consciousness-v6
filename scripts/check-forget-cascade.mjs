/**
 * 门禁锁：遗忘级联（红线）——HIDE 之后，原话轮次必须被封住。
 *
 * 为什么锁这条：`asof` / 汇流 / 深翻 以前各写各的 SQL，结论藏了、原话还能被端出来
 * （bug-asof-遗忘不彻底-2026-11-09）。现在三路共用 `forgottenTurnIds`，这个脚本钉住共享层：
 *   1) HIDE 一条记忆 → 它指向的轮次进 forgottenTurnIds；
 *   2) filterForgotten 会丢这一轮；
 *   3) replayScene 拒绝用已忘的轮次重放；
 *   4) 老账没有 turn 链时，按时间窗封（forgottenInWindow > 0）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDb } from '../src/db.js'
import { forgottenTurnIds, filterForgotten, forgottenInWindow } from '../src/modules/visibility.js'
import { replayScene } from '../src/modules/confluence.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const file = path.join(here, 'check-forget.tmp.db')
for (const f of [file, file + '-wal', file + '-shm']) { try { fs.unlinkSync(f) } catch { /* 没有就算了 */ } }

const checks = []
const ck = (name, ok, detail) => { checks.push({ name, ok: !!ok }); console.log((ok ? 'PASS ' : 'FAIL ') + name, ok ? '' : JSON.stringify(detail).slice(0, 300)) }

try {
  const db = openDb(file)
  const aid = 'agt_fg'
  const t0 = new Date('2026-11-10T15:00:00+08:00').toISOString()
  const t1 = new Date('2026-11-10T15:01:00+08:00').toISOString()
  db.prepare('INSERT INTO agents(id,name,mode,status,created_at) VALUES(?,?,?,?,?)').run(aid, '测试', 'daily', 'active', t0)
  const frag = db.prepare('INSERT INTO fragments(id,agent_id,session_id,turn_id,seq,role,text,created_at,day) VALUES(?,?,?,?,?,?,?,?,?)')
  frag.run('f1', aid, 's1', 'turn_fg_1', 1, 'user', '这句要忘掉', t0, '2026-11-10')
  frag.run('f2', aid, 's1', 'turn_fg_2', 2, 'assistant', '这句不用忘', t1, '2026-11-10')
  db.prepare(`INSERT INTO memory_items(id,agent_id,type,text,source,last_decay_at,created_at,source_turn_id)
    VALUES(?,?,?,?,?,?,?,?)`).run('m1', aid, 'episode', '这句要忘掉', 'manual', t0, t0, 'turn_fg_1')
  db.prepare(`INSERT INTO memory_timeline(agent_id,memory_id,op,at,valid_from) VALUES(?,?,?,?,?)`)
    .run(aid, 'm1', 'HIDE', t0, t0)

  const ft = forgottenTurnIds(db, aid)
  ck('HIDE 的记忆指向的轮次被封', ft.has('turn_fg_1'), [...ft])
  const filt = filterForgotten(db, aid, [{ turn_id: 'turn_fg_1', text: 'a' }, { turn_id: 'turn_fg_2', text: 'b' }])
  ck('filterForgotten 丢掉那一轮、留下别的', filt.kept.length === 1 && filt.kept[0].turn_id === 'turn_fg_2' && filt.dropped === 1, filt)

  // 已忘轮次的留底不能被重放
  db.prepare(`INSERT INTO scene_archive(turn_id,agent_id,at,session_id,episode_id,block,block_hash,state_ref,bytes,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run('turn_fg_1', aid, t0, 's1', null, '那一轮的整段', 'h1', null, 12, t0)
  const rep = replayScene(db, aid, { at: t0, sessionId: 's1' })
  ck('replayScene 拒绝已忘轮次', rep === null, rep)

  // 老账走时间窗：没有 turn 链的 HIDE，按时间封（这条用另一条记忆模拟）
  const oldT = new Date('2026-11-01T10:00:00+08:00').toISOString()
  db.prepare(`INSERT INTO memory_items(id,agent_id,type,text,source,last_decay_at,created_at)
    VALUES(?,?,?,?,?,?,?)`).run('m2', aid, 'episode', '老账要忘', 'manual', oldT, oldT)
  db.prepare(`INSERT INTO memory_timeline(agent_id,memory_id,op,at,valid_from) VALUES(?,?,?,?,?)`)
    .run(aid, 'm2', 'HIDE', oldT, oldT)
  const win = forgottenInWindow(db, aid, new Date('2026-11-01T09:00:00+08:00').toISOString(), new Date('2026-11-01T11:00:00+08:00').toISOString())
  ck('老账按时间窗封（不用猜 turn）', Number(win) > 0, { win })
  db.close()
} finally {
  for (const f of [file, file + '-wal', file + '-shm']) { try { fs.unlinkSync(f) } catch { /* 清理 */ } }
}

const fail = checks.filter((c) => !c.ok)
if (fail.length) { console.error('遗忘级联锁失败:', fail.length); process.exit(1) }
console.log('遗忘级联锁 ok')
