/**
 * B2 去重锁（2026-11-13）
 *
 * 同一天里「同角色 + 同正文」的重复碎片只切一次：
 *   - loadCleanRows / loadCleanRowsWithMode 都去重；
 *   - 切事结果里 clean < rows，事件不会引用被丢的重复轮次。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { splitDayBatch } from '../src/modules/event_split.js'

const P = path.join(os.tmpdir(), 'dsh-check-dedupe-' + Date.now() + '.db')
let fails = 0
const ok = (name, cond, extra) => {
  if (cond) { console.log('PASS', name) } else { fails++; console.log('FAIL', name, extra ? JSON.stringify(extra) : '') }
}

try {
  const db = openDb(P)
  const aid = 'a1'
  const at = '2026-11-12T03:00:00Z'
  const frag = (id, role, text, t) => db.prepare('INSERT INTO fragments(id,agent_id,session_id,turn_id,seq,role,text,created_at,day) VALUES(?,?,?,?,?,?,?,?,?)').run(id, aid, 's1', 't' + id, Number(id.slice(1)), role, text, t, '2026-11-12')
  frag('f1', 'user', '同一句话', at)
  frag('f2', 'user', '同一句话', at)          // 重复
  frag('f3', 'assistant', '同一句回话', at)
  frag('f4', 'assistant', '同一句回话', at)   // 重复
  frag('f5', 'user', '另一句', at)

  const r = await splitDayBatch(db, aid, '2026-11-12', {
    complete: async () => '[]',
    onEvents: () => {},
  })
  ok('重复正文被去重（rows 5 / clean 3）', r.rows === 5 && r.clean === 3, { rows: r.rows, clean: r.clean })

  // 逐件读口同一套去重
  const { loadCleanRows } = await import('../src/modules/event_split.js')
  const lc = loadCleanRows(db, aid, '2026-11-12')
  ok('loadCleanRows 也去重', lc.rows.length === 5 && lc.clean.length === 3, { rows: lc.rows.length, clean: lc.clean.length })

  db.close()
} catch (e) {
  fails++
  console.log('FAIL 去重异常:', (e && e.stack) || e)
} finally {
  try { fs.rmSync(P) } catch { /* 清理失败不影响结论 */ }
}
process.exit(fails ? 1 : 0)
