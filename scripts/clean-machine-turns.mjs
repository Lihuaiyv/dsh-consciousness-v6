/**
 * 清掉 raw_turns 里冒充用户原话的机器消息。
 * 默认只看不删；--apply 才真删。
 *
 * 认的三种（和 src/text.js 的 MACHINE_MESSAGE 一致）：
 *   - This is an automatically generated checkpoint …
 *   - <compacted-summary> …
 *   - Background subagent / Background job …
 */
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import os from 'node:os';

const APPLY = process.argv.includes('--apply');
const db = new DatabaseSync(path.join(os.homedir(), '.dsh', 'consciousness', 'app.db'));

// 必须锚定开头：我自己的正常回复里也会提到「checkpoint」这个词，模糊匹配会把真回复删掉。
const MACHINE_MESSAGE = /^\s*(?:This is an automatically generated checkpoint|Background (?:subagent|job)\b|<compacted-summary>|Approval prompts are disabled|The approval policy changed|Approval policy changed)/i

const all = db.prepare('SELECT id, role, session_id, seq, created_at, text FROM raw_turns').all();
const seen = new Map();
for (const r of all) {
  if (r.role !== 'user') continue
  if (!MACHINE_MESSAGE.test(String(r.text || ''))) continue
  seen.set(r.id, r);
}

function kindOf(t) {
  if (/^This is an automatically generated checkpoint/i.test(t)) return 'checkpoint'
  if (/^<compacted-summary>/i.test(t)) return 'compacted'
  return 'background'
}

console.log(`匹配到 ${seen.size} 条`);
const counts = {}
for (const r of seen.values()) {
  const k = kindOf(String(r.text))
  counts[k] = (counts[k] || 0) + 1
}
console.log('分类:', JSON.stringify(counts));
for (const r of [...seen.values()].slice(0, 10)) {
  console.log(`  ${String(r.created_at).slice(0, 10)} [${kindOf(String(r.text))}] ${String(r.text).replace(/\s+/g, ' ').slice(0, 70)}`);
}

if (!APPLY) {
  console.log('\n（只看不删。加 --apply 才真删）');
  db.close();
  process.exit(0);
}

const delFts = db.prepare('DELETE FROM raw_fts WHERE id=?');
const delRaw = db.prepare('DELETE FROM raw_turns WHERE id=?');
let nRaw = 0, nFts = 0;
db.exec('BEGIN');
try {
  for (const id of seen.keys()) {
    nFts += Number(delFts.run(id).changes || 0);
    nRaw += Number(delRaw.run(id).changes || 0);
  }
  db.exec('COMMIT');
} catch (e) {
  db.exec('ROLLBACK');
  console.error('回滚:', e.message);
  process.exit(1);
}

console.log(`\n删除 raw_turns ${nRaw} 条，raw_fts ${nFts} 条`);
console.log('剩余总量:', JSON.stringify(db.prepare('SELECT role, COUNT(*) c FROM raw_turns GROUP BY role').all()));
console.log('还有 checkpoint?:', db.prepare("SELECT COUNT(*) c FROM raw_turns WHERE text LIKE '%automatically generated checkpoint%'").get().c);
console.log('还有 compacted-summary?:', db.prepare("SELECT COUNT(*) c FROM raw_turns WHERE text LIKE '%<compacted-summary>%'").get().c);
console.log('还有后台通报?:', db.prepare("SELECT COUNT(*) c FROM raw_turns WHERE text LIKE '%Background subagent%'").get().c);
db.close();
