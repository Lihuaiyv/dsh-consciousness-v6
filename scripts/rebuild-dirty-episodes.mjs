/**
 * 重建被宿主通知污染的纪要（episodes）。
 * 原话已经清掉了，但纪要还留着当时算出来的旧 summary，开场续接会把它念出来。
 * 按 (session_id, day) 重算，id 不变（buildEpisode 内部按 session+day 找旧行再 UPDATE）。
 */
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import os from 'node:os';
import { buildEpisode } from '../src/modules/archive.js';

const db = new DatabaseSync(path.join(os.homedir(), '.dsh', 'consciousness', 'app.db'));

const dirty = db.prepare(`SELECT id, agent_id, session_id, day, title FROM episodes
  WHERE summary LIKE '%Approval%' OR summary LIKE '%approval%' OR summary LIKE '%compacted-summary%'
     OR summary LIKE '%automatically generated checkpoint%' OR summary LIKE '%Background subagent%'`).all();

console.log(`待重建 ${dirty.length} 条`);
let ok = 0;
let skipped = 0;
for (const e of dirty) {
  try {
    const out = buildEpisode(db, e.agent_id, { session: e.session_id || undefined, day: e.day });
    if (out) {
      ok++;
      console.log(`  ✔ [${e.day}] ${String(e.title).slice(0, 24)} -> 新标题「${String(out.title).slice(0, 24)}」`);
    } else { skipped++; console.log(`  · [${e.day}] 没有可用的原话了，跳过（纪要保留原样）`); }
  } catch (err) {
    skipped++;
    console.log(`  ✘ [${e.day}] ${err.message}`);
  }
}

const left = db.prepare(`SELECT COUNT(*) c FROM episodes
  WHERE summary LIKE '%Approval%' OR summary LIKE '%approval%'`).get().c;
console.log(`\n重建 ${ok} 条，跳过 ${skipped} 条`);
console.log(`纪要里还剩 approval 字样: ${left} 条`);
db.close();
