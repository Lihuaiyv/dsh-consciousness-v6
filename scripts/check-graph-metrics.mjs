/**
 * 大因果体 · 验收指标（2026-11-17）
 *   骨架凝聚：骨架边上平均 |pull|          目标 ≥0.6
 *   负边占比：|pull| 大的负边 / 骨架边     目标 ≥20%（现在没有负边，会不达标，如实报）
 *   压缩比：叶子边数 / 体级边数            目标 ≥5:1
 *   扰动稳定：删 10% 叶子边后，「现在到哪」变了的比例 <15%
 * 用法：node scripts/check-graph-metrics.mjs <副本路径>
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDb } from '../src/db.js'
import { loadBody } from '../src/modules/event_causal.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const src = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(here, '..', '..', 'runtime', 'consciousness', 'app.db')
const work = path.join(here, 'metrics.tmp.db')
for (const f of [work, work + '-wal', work + '-shm']) { try { fs.unlinkSync(f) } catch { /* 没有 */ } }
fs.copyFileSync(src, work)
try { fs.copyFileSync(src + '-wal', work + '-wal') } catch { /* 没有 wal */ }

const db = openDb(work)
const aid = db.prepare('SELECT id FROM agents ORDER BY created_at LIMIT 1').get().id
const checks = []
const ck = (name, ok, detail) => { checks.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'WARN'} ${name}`, detail ? ` ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : '') }

const livE = db.prepare("SELECT * FROM event_edges WHERE agent_id=? AND status<>'rejected' AND valid_to IS NULL").all(aid)
const spine = livE.filter((e) => e.kind === 'spine')
const confirmed = livE.filter((e) => e.status === 'confirmed')
const neg = livE.filter((e) => Number(e.pull) < 0)
const avg = (a) => a.length ? a.reduce((s, x) => s + Math.abs(Number(x.pull) || 0), 0) / a.length : 0

// ① 骨架凝聚
const cohesion = avg(spine.length ? spine : confirmed)
ck(`骨架凝聚 |pull| 平均 ${cohesion.toFixed(2)}（线 ≥0.6）`, cohesion >= 0.6, { spine: spine.length, confirmed: confirmed.length })

// ② 负边占比
const negRatio = spine.length ? spine.filter((e) => Number(e.pull) < 0).length / spine.length : (livE.length ? neg.length / livE.length : 0)
ck(`负边占比 ${(negRatio * 100).toFixed(1)}%（线 ≥20%）`, negRatio >= 0.2, { neg: neg.length, total: livE.length })

// ③ 压缩比：叶子边（事件层）/ 体级边（level>0）
const leaf = livE.filter((e) => Number(e.level) === 0).length
const bodyLevel = livE.filter((e) => Number(e.level) > 0).length
ck(`压缩比 ${bodyLevel ? (leaf / bodyLevel).toFixed(1) : '无体级边'}（线 ≥5:1；现在只有事件层）`, bodyLevel > 0 && leaf / bodyLevel >= 5, { leaf, bodyLevel })

// ④ 扰动稳定：删 10% 叶子边，看「现在到哪」变化比例
const nodes = db.prepare('SELECT id FROM hot_events WHERE agent_id=? AND active=1 ORDER BY RANDOM() LIMIT 30').all(aid).map((r) => r.id)
const headBefore = new Map(nodes.map((id) => [id, (loadBody(db, aid, id, { threshold: 0.25 }).head || {}).id]))
const leafEdges = livE.filter((e) => e.kind !== 'spine')
const drop = Math.max(1, Math.floor(leafEdges.length * 0.1))
const del = db.prepare('DELETE FROM event_edges WHERE id=?')
for (const e of leafEdges.slice().sort(() => Math.random() - 0.5).slice(0, drop)) { try { del.run(e.id) } catch { /* 跳过 */ } }
let changed = 0
for (const id of nodes) {
  const after = (loadBody(db, aid, id, { threshold: 0.25 }).head || {}).id
  if (after !== headBefore.get(id)) changed++
}
const drift = nodes.length ? changed / nodes.length : 0
ck(`扰动稳定：删 ${drop} 条叶子边后「现在到哪」变了 ${(drift * 100).toFixed(1)}%（线 <15%）`, drift < 0.15, { nodes: nodes.length, changed })

db.close()
for (const f of [work, work + '-wal', work + '-shm']) { try { fs.unlinkSync(f) } catch { /* 清理 */ } }
const warn = checks.filter((c) => !c.ok).length
console.log(`\n${checks.length - warn}/${checks.length} 达标（WARN 不一定是 bug：负边要等模型判出冲突才有）`)
