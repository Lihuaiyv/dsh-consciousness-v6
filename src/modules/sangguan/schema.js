/**
 * 三观引擎 · 建表（code-guide §5.3，master-plan §5）。
 * L0 账本 + 不可变实体：只插入，触发器拒绝 UPDATE / DELETE（I1）。
 * claim_proj_*：可清空重建的投影缓存（I2）。
 * 全部 IF NOT EXISTS，openDb 每次调用都幂等；开关关闭时只是几张空表。
 */

export const L0_TABLES = Object.freeze([
  'claim_events', 'persona_claims', 'claim_questions', 'claim_kappa',
  'claim_predictions', 'claim_evidence', 'claim_edges', 'claim_summaries',
])

export const PROJ_TABLES = Object.freeze([
  'claim_proj_claim', 'claim_proj_kappa', 'claim_proj_nu', 'claim_proj_edge',
  'claim_proj_theta', 'claim_proj_meta',
])

const DDL = `
CREATE TABLE IF NOT EXISTS claim_events(
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT UNIQUE NOT NULL,
  agent_id TEXT NOT NULL, at TEXT NOT NULL,
  type TEXT NOT NULL, layer TEXT, actor TEXT NOT NULL,
  refs_json TEXT, payload_json TEXT, gate_report_json TEXT,
  precedent_ids_json TEXT, expect_json TEXT, job_key TEXT);
CREATE INDEX IF NOT EXISTS ix_ev_agent_seq ON claim_events(agent_id, seq);
CREATE INDEX IF NOT EXISTS ix_ev_agent_type ON claim_events(agent_id, type, seq);
CREATE UNIQUE INDEX IF NOT EXISTS ux_ev_job ON claim_events(agent_id, job_key) WHERE type='JOB_DONE';

-- q_id：合题与 κ 通过它绑定同一问题（S4）
CREATE TABLE IF NOT EXISTS persona_claims(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, layer TEXT NOT NULL, kind TEXT NOT NULL,
  text TEXT NOT NULL, boundary_json TEXT, pred_json TEXT, origin TEXT NOT NULL,
  q_id TEXT, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS ix_pc_agent ON persona_claims(agent_id, layer);
CREATE TABLE IF NOT EXISTS claim_questions(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, layer TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS claim_kappa(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, layer TEXT NOT NULL, q_id TEXT NOT NULL,
  pos_id TEXT NOT NULL, neg_id TEXT NOT NULL, dep TEXT NOT NULL, excl TEXT NOT NULL, opened_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS claim_predictions(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, claim_id TEXT NOT NULL, expect TEXT NOT NULL, observe TEXT NOT NULL,
  p REAL NOT NULL, reg_at TEXT NOT NULL, due_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS claim_evidence(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, kind TEXT NOT NULL, target_type TEXT NOT NULL,
  target_id TEXT NOT NULL, sign INTEGER NOT NULL, weight REAL NOT NULL, ref TEXT NOT NULL,
  derived_from TEXT, at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS ix_cx_target ON claim_evidence(agent_id, target_id);
CREATE TABLE IF NOT EXISTS claim_edges(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, type TEXT NOT NULL,
  from_id TEXT NOT NULL, to_id TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS claim_summaries(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, layer TEXT, kind TEXT,
  from_seq INTEGER, to_seq INTEGER, text TEXT, built_at TEXT);

CREATE TABLE IF NOT EXISTS claim_proj_claim(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, layer TEXT NOT NULL, kind TEXT NOT NULL,
  status TEXT NOT NULL, pi REAL NOT NULL, n INTEGER NOT NULL, mentions INTEGER NOT NULL,
  e REAL NOT NULL, n_dep INTEGER NOT NULL, epoch INTEGER NOT NULL, review INTEGER NOT NULL,
  born_seq INTEGER NOT NULL, last_ev_at TEXT, last_seq INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS ix_pjc_agent ON claim_proj_claim(agent_id, layer, status);
CREATE TABLE IF NOT EXISTS claim_proj_kappa(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, layer TEXT NOT NULL, sigma TEXT NOT NULL,
  sub_id TEXT, last_delib_seq INTEGER, trial_until TEXT, dormant_since TEXT,
  accepted_at TEXT, extended INTEGER NOT NULL DEFAULT 0,
  opened_at TEXT NOT NULL, closed_at TEXT, last_seq INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS ix_pjk_agent ON claim_proj_kappa(agent_id, sigma);
CREATE TABLE IF NOT EXISTS claim_proj_nu(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, claim_id TEXT NOT NULL,
  outcome TEXT NOT NULL, resolved_at TEXT, last_seq INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS claim_proj_edge(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, active INTEGER NOT NULL,
  retired_at TEXT, last_seq INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS claim_proj_theta(
  agent_id TEXT NOT NULL, key TEXT NOT NULL, scope TEXT NOT NULL, value REAL NOT NULL,
  last_seq INTEGER NOT NULL, PRIMARY KEY(agent_id, key, scope));
CREATE TABLE IF NOT EXISTS claim_proj_meta(agent_id TEXT PRIMARY KEY, last_seq INTEGER NOT NULL);

-- 模型判定缓存：命题不可变 ⇒ 成对判定可永久缓存（S3 起用）
CREATE TABLE IF NOT EXISTS claim_llm_cache(key TEXT PRIMARY KEY, template TEXT, out_json TEXT, at TEXT, agent_id TEXT);

-- 整 agent 清除标记（拍板 2）：只在 purgeAgent 的同一事务里存在，删完即撤
CREATE TABLE IF NOT EXISTS claim_purge(agent_id TEXT PRIMARY KEY);

-- 草稿收件箱：还没进账本的取舍。草稿要能反复改到五闸全过，所以不套只增触发器；
-- 入库那一刻才走 draft.js commitDraft 写账本。
CREATE TABLE IF NOT EXISTS sangguan_drafts(
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  alt TEXT, foregone TEXT, cost_to TEXT,
  exclusion TEXT, boundary_json TEXT, counterexample TEXT,
  evidence_json TEXT NOT NULL,
  cluster_json TEXT,
  gates_json TEXT NOT NULL,
  status TEXT NOT NULL,
  source TEXT NOT NULL,
  vouch INTEGER NOT NULL DEFAULT 0,
  batch_key TEXT,
  claim_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS ix_sgd_agent ON sangguan_drafts(agent_id, status, created_at);
`

function guards(t) {
  return `
CREATE TRIGGER IF NOT EXISTS trg_${t}_no_update BEFORE UPDATE ON ${t}
BEGIN SELECT RAISE(ABORT, '三观账本只增：${t} 不允许 UPDATE'); END;
CREATE TRIGGER IF NOT EXISTS trg_${t}_no_delete BEFORE DELETE ON ${t}
WHEN NOT EXISTS (SELECT 1 FROM claim_purge WHERE agent_id=OLD.agent_id)
BEGIN SELECT RAISE(ABORT, '三观账本只增：${t} 不允许 DELETE'); END;`
}

export function ensureSangguanSchema(db) {
  db.exec(DDL)
  // 旧库的删除触发器没有清除豁免：换成新版
  for (const t of L0_TABLES) {
    const r = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(`trg_${t}_no_delete`)
    if (r && !String(r.sql).includes('claim_purge')) db.exec(`DROP TRIGGER trg_${t}_no_delete`)
  }
  db.exec(L0_TABLES.map(guards).join('\n'))
  // 旧库补列：投影可丢了重建，但 ALTER 让未 rebuild 的库也能读
  for (const [col, spec] of [['accepted_at', 'TEXT'], ['extended', 'INTEGER NOT NULL DEFAULT 0']]) {
    try { db.exec(`ALTER TABLE claim_proj_kappa ADD COLUMN ${col} ${spec}`) } catch { /* 已有 */ }
  }
  try { db.exec('ALTER TABLE claim_llm_cache ADD COLUMN agent_id TEXT') } catch { /* 已有 */ }
  db.exec('CREATE INDEX IF NOT EXISTS idx_claim_llm_cache_agent ON claim_llm_cache(agent_id)')
  // 命题的扩展字段（场景 / 预期 / 投入 / 多说法 / 推导）。命题不可变，建时写一次，读时缺省补全。
  try { db.exec('ALTER TABLE persona_claims ADD COLUMN meta_json TEXT') } catch { /* 已有 */ }
}
