/**
 * 门禁锁：切事写入器（cueGate / 冷热库 / 幂等 / 切→导→热）。
 * 临时库跑，跑完删；不碰真库。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDb } from '../src/db.js'
import { writeColdEvents, cueGate, cutAndIngest } from '../src/modules/event_write.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const file = path.join(here, 'check-event-write.tmp.db')
for (const f of [file, file + '-wal', file + '-shm']) { try { fs.unlinkSync(f) } catch { /* 没有就算了 */ } }

const checks = []
const ck = (name, ok, detail) => { checks.push({ name, ok: !!ok }); console.log((ok ? 'PASS ' : 'FAIL ') + name, ok ? '' : JSON.stringify(detail)) }

try {
  const db = openDb(file)
  const aid = 'agt_cw'
  db.prepare('INSERT INTO agents(id,name,mode,status,created_at) VALUES(?,?,?,?,?)').run(aid, '测试', 'daily', 'active', new Date().toISOString())
  const day = '2026-11-10'
  const rows = [
    ['f1', 't1', 'user', '第一句原文：今天把切事写入器写完了'],
    ['f2', 't2', 'assistant', '第二句原文：好，那我们跑一遍看看'],
    ['f3', 't3', 'user', '第三句原文：跑通了，冷库和热库都有了'],
  ]
  for (let i = 0; i < rows.length; i++) {
    const [id, tid, role, text] = rows[i]
    const at = new Date(`2026-11-10T1${i}:0${i}:00+08:00`).toISOString()
    db.prepare('INSERT INTO fragments(id,agent_id,session_id,turn_id,seq,role,text,created_at,day) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(id, aid, 's1', tid, i + 1, role, text, at, day)
  }

  ck('抓手门：空数组拒收', !cueGate([]).ok, cueGate([]))
  ck('抓手门：好抓手放行', cueGate(['切事写入器', '冷库']).ok, cueGate(['切事写入器', '冷库']))

  const ev = {
    title: '测试的一天', who: '主人', started_at: '2026-11-10T10:00:00+08:00', ended_at: '2026-11-10T12:00:00+08:00',
    turn_ids: ['t1', 't2', 't3'], quotes: ['第一句原文：今天把切事写入器写完了', '第二句原文：好，那我们跑一遍看看'],
    cues: ['切事写入器', '冷库'], status: '过去了', weight: 0.6, story: '起因经过结果',
  }
  const first = writeColdEvents(db, aid, [ev, { ...ev, title: '没抓手', cues: [] }])
  const second = writeColdEvents(db, aid, [ev])
  ck('冷+热各写一条', first.added === 1 && first.hotAdded === 1, first)
  ck('无抓手拒收', first.rejected === 1, first)
  ck('重复导入只 skip', second.added === 0 && second.skipped === 1 && second.hotAdded === 0, second)
  ck('库里冷热各 1 行', db.prepare('SELECT COUNT(*) n FROM cold_events').get().n === 1 && db.prepare('SELECT COUNT(*) n FROM hot_events').get().n === 1)

  const fake = async () => JSON.stringify({ ...ev, last_turn_id: 't3' })
  const cut = await cutAndIngest(db, aid, day, { complete: fake })
  ck('切→导→热 链路通', cut.ok && cut.write && cut.write.skipped === 1, cut && cut.write)
  db.close()
} finally {
  for (const f of [file, file + '-wal', file + '-shm']) { try { fs.unlinkSync(f) } catch { /* 清理 */ } }
}

const fail = checks.filter((c) => !c.ok)
if (fail.length) { console.error('切事写入器锁失败:', fail.length); process.exit(1) }
console.log('切事写入器锁 ok')
