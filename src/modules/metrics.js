/**
 * 指标采样入口：metric_samples 只经这里写，避免各域各自 INSERT。
 */
import { now } from '../db.js'
import { nid } from '../kernel.js'

export function recordMetric(db, aid, key, value) {
  if (value == null || !Number.isFinite(Number(value))) return
  db.prepare('INSERT INTO metric_samples VALUES(?,?,?,?,?)').run(nid('mts_'), aid, key, Number(value), now())
}
