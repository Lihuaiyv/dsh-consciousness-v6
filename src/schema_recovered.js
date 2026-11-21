// 2026-11-22：从真库 sqlite_master 导出的补丁 schema（db.js 旧版丢失的表/索引/触发器）。
// 表先建，索引和触发器逐条试，缺列的跳过，不让一条坏语句拖死整次开库。
export const RECOVERED_TABLES = [
`CREATE TABLE IF NOT EXISTS schema_meta(version INTEGER NOT NULL)`,
`CREATE TABLE IF NOT EXISTS agents(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'daily',
  status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL,
  deleted_at TEXT, schema_version INTEGER NOT NULL DEFAULT 1, last_interaction_at TEXT, avatar TEXT, runtime_state TEXT NOT NULL DEFAULT 'idle', last_seen_at TEXT, last_heartbeat_at TEXT)`,
`CREATE TABLE IF NOT EXISTS memory_items(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, type TEXT NOT NULL, mark TEXT NOT NULL DEFAULT 'normal', text TEXT NOT NULL, source TEXT NOT NULL,
  w0 REAL NOT NULL DEFAULT 0.5, weight REAL NOT NULL DEFAULT 0.5,
  stability REAL NOT NULL DEFAULT 1.0, difficulty REAL NOT NULL DEFAULT 5.0,
  last_decay_at TEXT NOT NULL, valid_at TEXT, invalid_at TEXT,
  status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL,
  deleted_at TEXT, version INTEGER NOT NULL DEFAULT 1, importance REAL NOT NULL DEFAULT 0.5, salience REAL NOT NULL DEFAULT 0, hits INTEGER NOT NULL DEFAULT 0, last_hit_at TEXT, heat REAL NOT NULL DEFAULT 0.5, band TEXT NOT NULL DEFAULT 'mid', confidence REAL NOT NULL DEFAULT 0.8, source_turn_id TEXT, fact_key TEXT, entity_id TEXT, temp_state TEXT NOT NULL DEFAULT 'warm', state_since TEXT, state_streak INTEGER NOT NULL DEFAULT 0, terms TEXT, search_text TEXT, superseded_by TEXT, valence REAL NOT NULL DEFAULT 0, feel_id TEXT, slow_at_creation REAL)`,
`CREATE TABLE IF NOT EXISTS memory_links(
  from_id TEXT NOT NULL, to_id TEXT NOT NULL, kind TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.5, PRIMARY KEY(from_id, to_id, kind))`,
`CREATE TABLE IF NOT EXISTS conflicts(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, a_id TEXT NOT NULL, b_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'open', resolution TEXT, reason TEXT, resolved_at TEXT, opened_at TEXT, penalized_at TEXT, severity TEXT NOT NULL DEFAULT 'low', kind TEXT, source_turn_id TEXT, evidence TEXT, escalation_level INTEGER NOT NULL DEFAULT 0, escalated_at TEXT)`,
`CREATE TABLE IF NOT EXISTS proposals(
  id TEXT PRIMARY KEY, human_no TEXT, agent_id TEXT NOT NULL,
  change_class TEXT NOT NULL, target TEXT, field TEXT, before TEXT, after TEXT,
  state TEXT NOT NULL, gate_trace TEXT, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
  shadow_done INTEGER DEFAULT 0, shadow_total INTEGER DEFAULT 0,
  shadow_log TEXT, shadow_hit REAL, observing_until TEXT, approved_by TEXT,
  observe_baseline TEXT, observe_samples INTEGER DEFAULT 0, fork_artifact_id TEXT, expect TEXT, risk TEXT, rollback_plan TEXT, deficit TEXT)`,
`CREATE TABLE IF NOT EXISTS changes(
  id TEXT PRIMARY KEY, proposal_id TEXT, agent_id TEXT NOT NULL, field TEXT NOT NULL,
  before TEXT, after TEXT, applied_at TEXT NOT NULL, approver TEXT, actor TEXT NOT NULL,
  source TEXT NOT NULL, rolled_back_at TEXT, observing_until TEXT)`,
`CREATE TABLE IF NOT EXISTS inbox_items(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, lane TEXT NOT NULL, ref_id TEXT,
  title TEXT, reason TEXT, priority INTEGER DEFAULT 3, state TEXT NOT NULL DEFAULT 'pending',
  expires_at TEXT, created_at TEXT NOT NULL)`,
`CREATE TABLE IF NOT EXISTS events(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, type TEXT NOT NULL,
  payload TEXT NOT NULL, created_at TEXT NOT NULL)`,
`CREATE TABLE IF NOT EXISTS journal(
  seq INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, turn_id TEXT,
  op TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'intent',
  created_at TEXT NOT NULL)`,
`CREATE TABLE IF NOT EXISTS idempotency(
  key TEXT PRIMARY KEY, body_hash TEXT NOT NULL, status INTEGER NOT NULL,
  response TEXT NOT NULL, created_at TEXT NOT NULL)`,
`CREATE TABLE IF NOT EXISTS metric_snapshots(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, key TEXT NOT NULL,
  value REAL, sampled_at TEXT NOT NULL)`,
`CREATE TABLE IF NOT EXISTS persona(
  agent_id TEXT NOT NULL, path TEXT NOT NULL, value TEXT NOT NULL,
  origin TEXT NOT NULL DEFAULT 'auto', updated_at TEXT NOT NULL,
  PRIMARY KEY(agent_id, path))`,
`CREATE TABLE IF NOT EXISTS affect_state(
  agent_id TEXT PRIMARY KEY, primary_label TEXT NOT NULL, secondary_label TEXT,
  intensity REAL NOT NULL DEFAULT 0.5, mood REAL NOT NULL DEFAULT 0.6,
  pleasure REAL NOT NULL DEFAULT 0.0, arousal REAL NOT NULL DEFAULT 0.0,
  dominance REAL NOT NULL DEFAULT 0.0, updated_at TEXT NOT NULL)`,
`CREATE TABLE IF NOT EXISTS alerts(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, kind TEXT NOT NULL,
  severity INTEGER NOT NULL DEFAULT 2, title TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL)`,
`CREATE TABLE IF NOT EXISTS affect_episodes(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, cause TEXT,
  appraisal TEXT, label TEXT, intensity REAL NOT NULL DEFAULT 0.5,
  resolution TEXT, started_at TEXT NOT NULL, ended_at TEXT, renewals INTEGER NOT NULL DEFAULT 0, rise_from REAL, rise_at TEXT)`,
`CREATE TABLE IF NOT EXISTS drive_state(
  agent_id TEXT PRIMARY KEY, r REAL NOT NULL, e REAL NOT NULL, c REAL NOT NULL,
  a REAL NOT NULL, s REAL NOT NULL, setpoint TEXT, band TEXT NOT NULL DEFAULT 'D1',
  streak INTEGER NOT NULL DEFAULT 0, tokens TEXT, tokens_refill_at TEXT,
  last_eval_at TEXT NOT NULL, dormant_since TEXT, smooth TEXT, unlocked TEXT)`,
`CREATE TABLE IF NOT EXISTS action_ports(
  agent_id TEXT NOT NULL, name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL, PRIMARY KEY(agent_id, name))`,
`CREATE TABLE IF NOT EXISTS relations(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'acquaintance',
  closeness REAL NOT NULL DEFAULT 0.2, trust REAL NOT NULL DEFAULT 0.2, dependence REAL NOT NULL DEFAULT 0.0,
  root INTEGER NOT NULL DEFAULT 0, notes TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
`CREATE TABLE IF NOT EXISTS preferences(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, tag TEXT NOT NULL, aversion REAL NOT NULL DEFAULT 0.0,
  origin TEXT NOT NULL DEFAULT 'auto', created_at TEXT NOT NULL)`,
`CREATE TABLE IF NOT EXISTS taboos(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, text TEXT NOT NULL, level TEXT NOT NULL DEFAULT 'soft',
  origin TEXT NOT NULL DEFAULT 'auto', created_at TEXT NOT NULL)`,
`CREATE TABLE IF NOT EXISTS condition_state(
  agent_id TEXT PRIMARY KEY, attention REAL NOT NULL DEFAULT 0.7, load REAL NOT NULL DEFAULT 0.2,
  state TEXT NOT NULL DEFAULT 'focus', updated_at TEXT NOT NULL)`,
`CREATE TABLE IF NOT EXISTS affect_samples(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, at TEXT NOT NULL, label TEXT, intensity REAL,
  fast TEXT, slow TEXT)`,
`CREATE TABLE IF NOT EXISTS cooldowns(
  agent_id TEXT NOT NULL, scope TEXT NOT NULL, key TEXT NOT NULL, until TEXT NOT NULL,
  reason TEXT, PRIMARY KEY(agent_id, scope, key))`,
`CREATE TABLE IF NOT EXISTS budgets(
  agent_id TEXT PRIMARY KEY, month TEXT NOT NULL, money_limit REAL NOT NULL DEFAULT 0,
  money_used REAL NOT NULL DEFAULT 0, token_limit INTEGER NOT NULL DEFAULT 0,
  token_used INTEGER NOT NULL DEFAULT 0, disturb_limit INTEGER NOT NULL DEFAULT 3,
  disturb_used INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL)`,
`CREATE TABLE IF NOT EXISTS rule_versions(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, version INTEGER NOT NULL, params TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 0, note TEXT, created_at TEXT NOT NULL)`,
`CREATE TABLE IF NOT EXISTS metric_samples(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, key TEXT NOT NULL, value REAL, sampled_at TEXT NOT NULL)`,
`CREATE TABLE IF NOT EXISTS action_log(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, port TEXT NOT NULL, payload TEXT,
  status TEXT NOT NULL, created_at TEXT NOT NULL)`,
`CREATE TABLE IF NOT EXISTS chat_turns(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL,
  pack TEXT, mood TEXT, created_at TEXT NOT NULL, conversation_id TEXT, turn_id TEXT, mode TEXT)`,
`CREATE TABLE IF NOT EXISTS bindings(
  session_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, created_at TEXT NOT NULL, active_at TEXT, state TEXT NOT NULL DEFAULT 'bound', source TEXT NOT NULL DEFAULT 'auto', bound_at TEXT, last_seen_at TEXT, released_at TEXT, released_by TEXT)`,
`CREATE TABLE IF NOT EXISTS flags(key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
`CREATE TABLE IF NOT EXISTS algo_bindings(
  agent_id TEXT NOT NULL, name TEXT NOT NULL,
  active TEXT NOT NULL, canary TEXT, ratio REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL, PRIMARY KEY(agent_id, name))`,
`CREATE TABLE IF NOT EXISTS agent_params(
  agent_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
  updated_at TEXT NOT NULL, PRIMARY KEY(agent_id, key))`,
`CREATE TABLE IF NOT EXISTS rule_artifacts(
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, version INTEGER NOT NULL,
  payload_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'available',
  created_at TEXT NOT NULL, retired_at TEXT)`,
`CREATE TABLE IF NOT EXISTS agent_bindings(
  agent_id TEXT NOT NULL, kind TEXT NOT NULL,
  active_id TEXT NOT NULL, previous_id TEXT, pinned_id TEXT, v0_id TEXT NOT NULL,
  updated_at TEXT NOT NULL, PRIMARY KEY(agent_id, kind))`,
`CREATE TABLE IF NOT EXISTS proactive(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, text TEXT NOT NULL, reason TEXT,
  dim TEXT, state TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, delivered_at TEXT, answered INTEGER NOT NULL DEFAULT 0, ignored INTEGER NOT NULL DEFAULT 0, answered_at TEXT, session_id TEXT)`,
`CREATE TABLE IF NOT EXISTS change_journal(
  id TEXT PRIMARY KEY, proposal_id TEXT, agent_id TEXT NOT NULL, field TEXT,
  before_value TEXT, after_value TEXT, state TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
`CREATE TABLE IF NOT EXISTS thoughts(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL,
  self_text TEXT, other_text TEXT, world_text TEXT, want_text TEXT,
  other_label TEXT, source TEXT NOT NULL DEFAULT 'model', created_at TEXT NOT NULL, payload TEXT, feel_id TEXT)`,
`CREATE TABLE IF NOT EXISTS proactive_stats(
      agent_id TEXT NOT NULL, dim TEXT NOT NULL,
      sent INTEGER NOT NULL DEFAULT 0, answered INTEGER NOT NULL DEFAULT 0, ignored INTEGER NOT NULL DEFAULT 0,
      last_sent_at TEXT, cooldown_until TEXT, PRIMARY KEY(agent_id, dim))`,
`CREATE TABLE IF NOT EXISTS proactive_decisions(
      id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, at TEXT NOT NULL,
      will INTEGER NOT NULL DEFAULT 0, reason TEXT NOT NULL, dim TEXT,
      source TEXT, text TEXT, benefit REAL, cost REAL,
      gates TEXT, chain TEXT, repeats INTEGER NOT NULL DEFAULT 1)`,
`CREATE TABLE IF NOT EXISTS persona_views(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, text TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'rules', facts TEXT, sources TEXT,
  prompt_chars INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL)`,
`CREATE TABLE IF NOT EXISTS "fragments"(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, session_id TEXT NOT NULL,
  turn_id TEXT, seq INTEGER NOT NULL DEFAULT 0, role TEXT NOT NULL,
  text TEXT NOT NULL, tool TEXT, meta TEXT,
  created_at TEXT NOT NULL, day TEXT NOT NULL, form TEXT NOT NULL DEFAULT 'text', snapshot TEXT, antecedents TEXT)`,
`CREATE TABLE IF NOT EXISTS episodes(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, session_id TEXT, day TEXT NOT NULL,
  start_at TEXT, end_at TEXT, turns INTEGER NOT NULL DEFAULT 0,
  title TEXT, summary TEXT, topics TEXT, mood TEXT, open_loops TEXT,
  importance REAL NOT NULL DEFAULT 0.5, hits INTEGER NOT NULL DEFAULT 0,
  last_hit_at TEXT, source TEXT NOT NULL DEFAULT 'rules', created_at TEXT NOT NULL, seg INTEGER NOT NULL DEFAULT 0, beats TEXT, poignancy REAL, feel_id TEXT)`,
`CREATE TABLE IF NOT EXISTS diaries(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, day TEXT NOT NULL,
  text TEXT NOT NULL, mood TEXT, highlights TEXT, refs TEXT,
  source TEXT NOT NULL DEFAULT 'rules', version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, context TEXT, late INTEGER NOT NULL DEFAULT 0, feel_ids TEXT)`,
`CREATE TABLE IF NOT EXISTS fact_archive(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, memory_id TEXT NOT NULL,
  text TEXT NOT NULL, type TEXT, mark TEXT,
  importance REAL, salience REAL, confidence REAL,
  fact_key TEXT, source_turn_id TEXT, source TEXT NOT NULL DEFAULT 'model',
  payload TEXT, created_at TEXT NOT NULL, feel_id TEXT)`,
`CREATE TABLE IF NOT EXISTS retrieval_log(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, at TEXT NOT NULL,
  scene TEXT NOT NULL, query TEXT NOT NULL DEFAULT '', why TEXT,
  counts TEXT, kept TEXT, dropped TEXT,
  items INTEGER NOT NULL DEFAULT 0, tokens INTEGER NOT NULL DEFAULT 0, ms INTEGER)`,
`CREATE TABLE IF NOT EXISTS entities(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, name TEXT NOT NULL, kind TEXT,
  aliases TEXT, hits INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
`CREATE TABLE IF NOT EXISTS extract_queue(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, turns TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
  next_at TEXT NOT NULL, last_error TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
`CREATE TABLE IF NOT EXISTS consolidation_log(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, day TEXT NOT NULL, at TEXT NOT NULL,
  steps TEXT, ok INTEGER NOT NULL DEFAULT 1, ms INTEGER)`,
`CREATE TABLE IF NOT EXISTS rel_event(
  id          TEXT PRIMARY KEY,
  agent_id    TEXT NOT NULL,
  kind        TEXT NOT NULL,
  source      TEXT NOT NULL,
  session_id  TEXT,
  turn_id     TEXT,
  speaker_id  TEXT,
  text        TEXT,
  payload     TEXT NOT NULL DEFAULT '{}',
  at          TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  created_at  TEXT NOT NULL
, feel_id TEXT)`,
`CREATE TABLE IF NOT EXISTS rel_tier(
  tier            TEXT PRIMARY KEY CHECK(tier IN ('owner','acquaintance','stranger')),
  label           TEXT NOT NULL,
  warmth          REAL NOT NULL, formality REAL NOT NULL, initiative REAL NOT NULL, disclosure REAL NOT NULL,
  detail_level    INTEGER NOT NULL CHECK(detail_level IN (1,2,3)),
  init_closeness  REAL NOT NULL, init_trust REAL NOT NULL, init_dependence REAL NOT NULL,
  half_life_days  REAL, forget_after_days REAL,
  promote_to      TEXT, demote_to TEXT, sort INTEGER NOT NULL
)`,
`CREATE TABLE IF NOT EXISTS rel_person(
  id            TEXT PRIMARY KEY,
  agent_id      TEXT NOT NULL,
  name          TEXT NOT NULL,
  aliases       TEXT NOT NULL DEFAULT '[]',
  tier          TEXT NOT NULL REFERENCES rel_tier(tier),
  graph_visible INTEGER NOT NULL DEFAULT 0 CHECK(graph_visible IN (0,1)),
  summary       TEXT,
  profile       TEXT NOT NULL DEFAULT '{}',
  closeness     REAL NOT NULL, trust REAL NOT NULL, dependence REAL NOT NULL,
  warmth        REAL,
  salience      REAL NOT NULL DEFAULT 1,
  first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, last_talk_at TEXT,
  talk_count    INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','faded','archived')),
  source        TEXT NOT NULL DEFAULT 'chat',
  last_event_id TEXT,
  version       INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL, updated_at TEXT NOT NULL
)`,
`CREATE TABLE IF NOT EXISTS rel_edge(
  id            TEXT PRIMARY KEY,
  agent_id      TEXT NOT NULL,
  from_id       TEXT NOT NULL REFERENCES rel_person(id),
  to_id         TEXT NOT NULL REFERENCES rel_person(id),
  kind          TEXT NOT NULL, role_label TEXT,
  closeness REAL, trust REAL, tension REAL, power REAL,
  confidence    REAL NOT NULL DEFAULT 0.7,
  source        TEXT NOT NULL DEFAULT 'chat' CHECK(source IN ('chat','manual','inferred','merged')),
  evidence_count INTEGER NOT NULL DEFAULT 1,
  valid_from TEXT, valid_to TEXT,
  last_event_id TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
)`,
`CREATE TABLE IF NOT EXISTS rel_mention(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL,
  event_id TEXT NOT NULL REFERENCES rel_event(id),
  surface TEXT NOT NULL, normalized TEXT NOT NULL,
  how TEXT NOT NULL DEFAULT 'name',
  context TEXT,
  candidate_ids TEXT NOT NULL DEFAULT '[]',
  state TEXT NOT NULL DEFAULT 'unresolved',
  confidence REAL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
)`,
`CREATE TABLE IF NOT EXISTS rel_evidence(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL,
  person_id TEXT, edge_id TEXT, memory_id TEXT, turn_id TEXT, event_id TEXT,
  kind TEXT NOT NULL, text TEXT NOT NULL, weight REAL NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
)`,
`CREATE TABLE IF NOT EXISTS rel_channel(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, person_id TEXT NOT NULL REFERENCES rel_person(id),
  channel TEXT NOT NULL, handle TEXT NOT NULL, confidence REAL NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, UNIQUE(agent_id, channel, handle)
)`,
`CREATE TABLE IF NOT EXISTS rel_extract_queue(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL,
  event_id TEXT, turns TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0, next_at TEXT NOT NULL, last_error TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
)`,
`CREATE TABLE IF NOT EXISTS rel_review(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL,
  event_id TEXT,
  kind TEXT NOT NULL,
  person_id TEXT, edge_id TEXT,
  payload TEXT NOT NULL,
  confidence REAL NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
)`,
`CREATE TABLE IF NOT EXISTS affect_v3(
    agent_id TEXT PRIMARY KEY, baseline REAL NOT NULL DEFAULT 0,
    slow REAL NOT NULL DEFAULT 0, fast REAL NOT NULL DEFAULT 0,
    total REAL NOT NULL DEFAULT 0, slow_at TEXT, fast_at TEXT, base_off REAL DEFAULT 0, base_off_at TEXT, walk REAL DEFAULT 0, walk_at TEXT, circ_phase REAL DEFAULT 0, circ_phase_at TEXT, rec_label TEXT, duty REAL DEFAULT 0, duty_at TEXT, sink_h REAL DEFAULT 0)`,
`CREATE TABLE IF NOT EXISTS affect_baseline(
    agent_id TEXT NOT NULL, seg_no INTEGER NOT NULL,
    started_at TEXT NOT NULL, duration_h REAL NOT NULL,
    from_val REAL NOT NULL, to_val REAL NOT NULL,
    seed TEXT NOT NULL, PRIMARY KEY(agent_id, seg_no))`,
`CREATE TABLE IF NOT EXISTS affect_user_read(
  agent_id TEXT NOT NULL, episode_id TEXT NOT NULL,
  guess_label TEXT NOT NULL, actual_label TEXT NOT NULL,
  note TEXT, created_at TEXT NOT NULL,
  PRIMARY KEY(agent_id, episode_id))`,
`CREATE TABLE IF NOT EXISTS affect_events(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, at TEXT NOT NULL,
  cause TEXT, rel REAL, cong REAL, nov REAL, cert REAL, prev_cong REAL,
  sig REAL, theta REAL, gate INTEGER NOT NULL DEFAULT 0,
  label TEXT, raw_label TEXT, margin REAL, scores TEXT, episode_id TEXT, formula TEXT, why TEXT, target TEXT, why_flag TEXT, e_user_read REAL, empathy_share REAL, self_own REAL, empathy_mode TEXT, empathy_want TEXT)`,
`CREATE TABLE IF NOT EXISTS action_config(
  agent_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
  updated_at TEXT NOT NULL, PRIMARY KEY(agent_id, key))`,
`CREATE TABLE IF NOT EXISTS research_seen(
  url_hash TEXT PRIMARY KEY, url TEXT NOT NULL, domain TEXT, title TEXT,
  first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, hits INTEGER NOT NULL DEFAULT 1)`,
`CREATE TABLE IF NOT EXISTS research_runs(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, topic TEXT NOT NULL, goal TEXT,
  depth TEXT, report TEXT, sources TEXT, stats TEXT, status TEXT NOT NULL,
  created_at TEXT NOT NULL, finished_at TEXT)`,
`CREATE TABLE IF NOT EXISTS memory_vec(
      memory_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, dim INTEGER NOT NULL,
      model TEXT NOT NULL, vec BLOB NOT NULL, at TEXT NOT NULL)`,
`CREATE TABLE IF NOT EXISTS live_events(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, kind TEXT NOT NULL,
  payload TEXT NOT NULL, created_at TEXT NOT NULL, consumed_at TEXT)`,
`CREATE TABLE IF NOT EXISTS canvas_doc(
  agent_id TEXT PRIMARY KEY, doc TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL)`,
`CREATE TABLE IF NOT EXISTS rel_habit(
      agent_id TEXT NOT NULL, person_id TEXT NOT NULL, key TEXT NOT NULL,
      n REAL NOT NULL DEFAULT 0, at TEXT, PRIMARY KEY(agent_id, person_id, key))`,
`CREATE TABLE IF NOT EXISTS rel_violation(
      agent_id TEXT NOT NULL, person_id TEXT NOT NULL,
      ceiling REAL NOT NULL, at TEXT NOT NULL, PRIMARY KEY(agent_id, person_id))`,
`CREATE TABLE IF NOT EXISTS axis_evidence(
      id TEXT PRIMARY KEY, agent_id TEXT NOT NULL,
      axis TEXT NOT NULL, dir INTEGER NOT NULL,
      strength REAL NOT NULL DEFAULT 0.5, source TEXT NOT NULL,
      ref_id TEXT, at TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0, pole TEXT, w REAL, why TEXT, weak INTEGER DEFAULT 0)`,
`CREATE TABLE IF NOT EXISTS browse_items(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, url TEXT, domain TEXT,
  title TEXT, text TEXT, query TEXT, channel TEXT NOT NULL DEFAULT 'browse',
  dwell_ms INTEGER NOT NULL DEFAULT 0, tags TEXT NOT NULL DEFAULT '[]',
  weights TEXT NOT NULL DEFAULT '{}', at TEXT NOT NULL)`,
`CREATE TABLE IF NOT EXISTS axis_rope(
      agent_id TEXT NOT NULL, axis TEXT NOT NULL,
      pos REAL NOT NULL DEFAULT 0, pos_n INTEGER NOT NULL DEFAULT 0, pos_s REAL NOT NULL DEFAULT 0,
      neg REAL NOT NULL DEFAULT 0, neg_n INTEGER NOT NULL DEFAULT 0, neg_s REAL NOT NULL DEFAULT 0,
      base REAL NOT NULL DEFAULT 0.5,
      at TEXT NOT NULL, base_at TEXT, src TEXT,
      PRIMARY KEY(agent_id, axis))`,
`CREATE TABLE IF NOT EXISTS persona_judge(
      id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, turn_id TEXT,
      user_text TEXT, reply_text TEXT, at TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending', reason TEXT,
      verdict TEXT, attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, refs TEXT)`,
`CREATE TABLE IF NOT EXISTS persona_probe(
      agent_id TEXT NOT NULL, week TEXT NOT NULL, at TEXT NOT NULL,
      n INTEGER NOT NULL DEFAULT 0, counts TEXT, agree REAL,
      PRIMARY KEY(agent_id, week))`,
`CREATE TABLE IF NOT EXISTS change_reasons(
      change_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, why TEXT, at TEXT NOT NULL)`,
`CREATE TABLE IF NOT EXISTS persona_worldview(
  agent_id TEXT NOT NULL, key TEXT NOT NULL, weight REAL NOT NULL DEFAULT 0.5, evidence TEXT,
  updated_at TEXT NOT NULL, PRIMARY KEY(agent_id, key))`,
`CREATE TABLE IF NOT EXISTS persona_lifeview(
  agent_id TEXT NOT NULL, key TEXT NOT NULL, weight REAL NOT NULL DEFAULT 0.5, evidence TEXT,
  updated_at TEXT NOT NULL, PRIMARY KEY(agent_id, key))`,
`CREATE TABLE IF NOT EXISTS memory_timeline(
  seq INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, memory_id TEXT NOT NULL,
  op TEXT NOT NULL, at TEXT NOT NULL, valid_from TEXT, reason TEXT, cause_id TEXT,
  text_ref TEXT, actor TEXT, approx INTEGER NOT NULL DEFAULT 0)`,
`CREATE TABLE IF NOT EXISTS claim_events(
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT UNIQUE NOT NULL,
  agent_id TEXT NOT NULL, at TEXT NOT NULL,
  type TEXT NOT NULL, layer TEXT, actor TEXT NOT NULL,
  refs_json TEXT, payload_json TEXT, gate_report_json TEXT,
  precedent_ids_json TEXT, expect_json TEXT, job_key TEXT)`,
`CREATE TABLE IF NOT EXISTS persona_claims(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, layer TEXT NOT NULL, kind TEXT NOT NULL,
  text TEXT NOT NULL, boundary_json TEXT, pred_json TEXT, origin TEXT NOT NULL,
  q_id TEXT, created_at TEXT NOT NULL, meta_json TEXT)`,
`CREATE TABLE IF NOT EXISTS claim_questions(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, layer TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL)`,
`CREATE TABLE IF NOT EXISTS claim_kappa(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, layer TEXT NOT NULL, q_id TEXT NOT NULL,
  pos_id TEXT NOT NULL, neg_id TEXT NOT NULL, dep TEXT NOT NULL, excl TEXT NOT NULL, opened_at TEXT NOT NULL)`,
`CREATE TABLE IF NOT EXISTS claim_predictions(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, claim_id TEXT NOT NULL, expect TEXT NOT NULL, observe TEXT NOT NULL,
  p REAL NOT NULL, reg_at TEXT NOT NULL, due_at TEXT NOT NULL)`,
`CREATE TABLE IF NOT EXISTS claim_evidence(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, kind TEXT NOT NULL, target_type TEXT NOT NULL,
  target_id TEXT NOT NULL, sign INTEGER NOT NULL, weight REAL NOT NULL, ref TEXT NOT NULL,
  derived_from TEXT, at TEXT NOT NULL)`,
`CREATE TABLE IF NOT EXISTS claim_edges(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, type TEXT NOT NULL,
  from_id TEXT NOT NULL, to_id TEXT NOT NULL, created_at TEXT NOT NULL)`,
`CREATE TABLE IF NOT EXISTS claim_summaries(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, layer TEXT, kind TEXT,
  from_seq INTEGER, to_seq INTEGER, text TEXT, built_at TEXT)`,
`CREATE TABLE IF NOT EXISTS claim_proj_claim(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, layer TEXT NOT NULL, kind TEXT NOT NULL,
  status TEXT NOT NULL, pi REAL NOT NULL, n INTEGER NOT NULL, mentions INTEGER NOT NULL,
  e REAL NOT NULL, n_dep INTEGER NOT NULL, epoch INTEGER NOT NULL, review INTEGER NOT NULL,
  born_seq INTEGER NOT NULL, last_ev_at TEXT, last_seq INTEGER NOT NULL)`,
`CREATE TABLE IF NOT EXISTS claim_proj_kappa(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, layer TEXT NOT NULL, sigma TEXT NOT NULL,
  sub_id TEXT, last_delib_seq INTEGER, trial_until TEXT, dormant_since TEXT,
  accepted_at TEXT, extended INTEGER NOT NULL DEFAULT 0,
  opened_at TEXT NOT NULL, closed_at TEXT, last_seq INTEGER NOT NULL)`,
`CREATE TABLE IF NOT EXISTS claim_proj_nu(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, claim_id TEXT NOT NULL,
  outcome TEXT NOT NULL, resolved_at TEXT, last_seq INTEGER NOT NULL)`,
`CREATE TABLE IF NOT EXISTS claim_proj_edge(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, active INTEGER NOT NULL,
  retired_at TEXT, last_seq INTEGER NOT NULL)`,
`CREATE TABLE IF NOT EXISTS claim_proj_theta(
  agent_id TEXT NOT NULL, key TEXT NOT NULL, scope TEXT NOT NULL, value REAL NOT NULL,
  last_seq INTEGER NOT NULL, PRIMARY KEY(agent_id, key, scope))`,
`CREATE TABLE IF NOT EXISTS claim_proj_meta(agent_id TEXT PRIMARY KEY, last_seq INTEGER NOT NULL)`,
`CREATE TABLE IF NOT EXISTS claim_llm_cache(key TEXT PRIMARY KEY, template TEXT, out_json TEXT, at TEXT, agent_id TEXT)`,
`CREATE TABLE IF NOT EXISTS claim_purge(agent_id TEXT PRIMARY KEY)`,
`CREATE TABLE IF NOT EXISTS open_loops(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'task', text TEXT NOT NULL,
  memory_id TEXT, source_turn_id TEXT,
  due_at TEXT, stale_after TEXT,
  state TEXT NOT NULL DEFAULT 'open',
  fired_at TEXT, fire_count INTEGER NOT NULL DEFAULT 0,
  closed_at TEXT, closed_by TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, feel_id TEXT, important INTEGER NOT NULL DEFAULT 0)`,
`CREATE TABLE IF NOT EXISTS reflect_cursor(
  agent_id TEXT PRIMARY KEY, acc REAL NOT NULL DEFAULT 0,
  window_start TEXT, last_reflect_at TEXT, updated_at TEXT NOT NULL)`,
`CREATE TABLE IF NOT EXISTS surfaced_items(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL,
  memory_id TEXT, kind TEXT NOT NULL DEFAULT 'related', text TEXT NOT NULL,
  at TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0, used_at TEXT)`,
`CREATE TABLE IF NOT EXISTS surface_queue(
    id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, memory_id TEXT NOT NULL,
    reason TEXT, state TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL, expires_at TEXT)`,
`CREATE TABLE IF NOT EXISTS heartbeats(
  agent_id TEXT PRIMARY KEY, interval_ms INTEGER NOT NULL DEFAULT 300000,
  next_at INTEGER NOT NULL, last_at INTEGER, last_ms INTEGER,
  last_error TEXT, failures INTEGER NOT NULL DEFAULT 0,
  skips INTEGER NOT NULL DEFAULT 0, mode TEXT NOT NULL DEFAULT 'auto',
  deep_at INTEGER, deep_ms INTEGER NOT NULL DEFAULT 900000)`,
`CREATE TABLE IF NOT EXISTS agent_runtime(
  agent_id TEXT PRIMARY KEY, state TEXT NOT NULL DEFAULT 'idle',
  since TEXT NOT NULL, reason TEXT, updated_at TEXT NOT NULL)`,
`CREATE TABLE IF NOT EXISTS conversations(
  conversation_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'qq', handle TEXT NOT NULL DEFAULT '',
  person_id TEXT, state TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL, last_seen_at TEXT,
  released_at TEXT, released_by TEXT)`,
`CREATE TABLE IF NOT EXISTS sangguan_drafts(
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
  updated_at TEXT NOT NULL)`,
`CREATE TABLE IF NOT EXISTS diary_pending(
  agent_id TEXT NOT NULL, day TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT, next_try_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY(agent_id, day))`,
`CREATE TABLE IF NOT EXISTS affect_review(
    id TEXT PRIMARY KEY, agent_id TEXT NOT NULL,
    event_id TEXT NOT NULL, text TEXT,
    old_rel REAL, old_cong REAL, old_label TEXT, old_why TEXT,
    new_rel REAL, new_cong REAL, new_label TEXT, new_why TEXT,
    verdict TEXT NOT NULL DEFAULT 'same',
    at TEXT NOT NULL, reviewed_at TEXT)`,
`CREATE TABLE IF NOT EXISTS affect_trigger(
    agent_id TEXT NOT NULL, word TEXT NOT NULL,
    hits INTEGER NOT NULL DEFAULT 0, flips INTEGER NOT NULL DEFAULT 0,
    last_at TEXT, penalty INTEGER DEFAULT 0, PRIMARY KEY(agent_id, word))`,
`CREATE TABLE IF NOT EXISTS affect_feel(
    id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, at TEXT NOT NULL,
    text TEXT NOT NULL, label TEXT, fast REAL, slow REAL, total REAL,
    session_id TEXT, source TEXT NOT NULL DEFAULT 'tool', turn_id TEXT)`,
`CREATE TABLE IF NOT EXISTS memory_pair_judge(
  pair_key TEXT PRIMARY KEY, agent_id TEXT NOT NULL,
  old_id TEXT NOT NULL, new_id TEXT NOT NULL,
  verdict TEXT NOT NULL, confidence REAL, model TEXT, reason TEXT,
  judged_at TEXT NOT NULL, via TEXT NOT NULL, applied INTEGER NOT NULL DEFAULT 0)`,
`CREATE TABLE IF NOT EXISTS memory_claims(
  memory_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL,
  claim_key TEXT, state TEXT NOT NULL, since TEXT NOT NULL,
  evidence_id TEXT, checked_at TEXT, via TEXT NOT NULL)`,
`CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(id UNINDEXED, text, tokenize='trigram')`,
`CREATE VIRTUAL TABLE IF NOT EXISTS raw_fts USING fts5(id UNINDEXED, text, tokenize='trigram')`,
`CREATE VIRTUAL TABLE IF NOT EXISTS fact_fts USING fts5(id UNINDEXED, text, tokenize='trigram')`,
`CREATE TABLE IF NOT EXISTS memory_provenance(
  memory_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL,
  speaker TEXT NOT NULL DEFAULT 'unknown', quote TEXT,
  inferred INTEGER NOT NULL DEFAULT 0, turn_id TEXT,
  via TEXT NOT NULL, created_at TEXT NOT NULL)`,
`CREATE TABLE IF NOT EXISTS voice_baseline(
    agent_id TEXT NOT NULL, speaker TEXT NOT NULL DEFAULT 'default',
    pitch_hz REAL, loudness REAL, jitter_pct REAL, shimmer_pct REAL, cps REAL,
    samples INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, periodicity REAL,
    PRIMARY KEY(agent_id, speaker))`,
`CREATE TABLE IF NOT EXISTS state_scene(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, at TEXT NOT NULL,
  session_id TEXT, episode_id TEXT, turn_id TEXT,
  tier TEXT NOT NULL DEFAULT 'light',
  affect_json TEXT, drive_json TEXT, relation_json TEXT, persona_json TEXT,
  life_json TEXT, loops_json TEXT, voice_json TEXT, params_hash TEXT,
  source TEXT NOT NULL DEFAULT 'auto', created_at TEXT NOT NULL)`,
`CREATE TABLE IF NOT EXISTS scene_archive(
  turn_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, at TEXT NOT NULL,
  session_id TEXT, episode_id TEXT,
  block TEXT NOT NULL, block_hash TEXT NOT NULL,
  state_ref TEXT, bytes INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL)`,
`CREATE TABLE IF NOT EXISTS confluence_log(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, at TEXT NOT NULL,
  anchor_turn TEXT, anchor_episode TEXT, level TEXT NOT NULL DEFAULT 'L1',
  bundle_hash TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'manual',
  spoken TEXT, adopted INTEGER NOT NULL DEFAULT 0, looked_back_at TEXT,
  dropped TEXT, created_at TEXT NOT NULL)`,
`CREATE TABLE IF NOT EXISTS revisit(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, at TEXT NOT NULL,
  anchor_turn TEXT, memory_ids TEXT, mood TEXT, note TEXT,
  source TEXT NOT NULL DEFAULT 'confluence', created_at TEXT NOT NULL)`,
`CREATE TABLE IF NOT EXISTS cold_events(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL,
  title TEXT NOT NULL, story TEXT NOT NULL, who TEXT,
  start_at TEXT NOT NULL, end_at TEXT NOT NULL,
  turn_ids TEXT NOT NULL,        -- JSON 数组：这件事覆盖的轮次，首尾都在
  quotes TEXT NOT NULL,          -- JSON 数组：原文里一字不差的句子
  status TEXT,                   -- 切出来那一刻的过没过
  weight REAL NOT NULL DEFAULT 0.5,
  cut_rev INTEGER NOT NULL DEFAULT 1,   -- 这一段第几次切（补切递增）
  created_at TEXT NOT NULL, cues TEXT, quality TEXT NOT NULL DEFAULT 'model')`,
`CREATE TABLE IF NOT EXISTS hot_events(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL,
  title TEXT NOT NULL, story TEXT NOT NULL,
  cues TEXT,                     -- JSON 数组：抓手词
  source_cold_ids TEXT NOT NULL, -- JSON 数组：来源只记冷库 id，不记热库 id（链条不会越接越长）
  op TEXT NOT NULL DEFAULT 'born',   -- born/merge/split/rename/compress/sink
  reason TEXT,                   -- 为什么变
  version INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL DEFAULT '台面',  -- 台面/旧版/沉底
  want REAL NOT NULL DEFAULT 0.25,     -- 想头
  ceiling REAL NOT NULL DEFAULT 1.0,   -- 天花板
  mentions INTEGER NOT NULL DEFAULT 0,
  last_mention_at TEXT, last_surface_at TEXT,
  created_at TEXT NOT NULL, changed_at TEXT NOT NULL, ticked_at TEXT, quality TEXT NOT NULL DEFAULT 'model')`,
`CREATE TABLE IF NOT EXISTS event_edges(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL,
  from_id TEXT NOT NULL,        -- 更早那件（hot_events.id）
  to_id TEXT NOT NULL,          -- 更晚那件
  kind TEXT NOT NULL,           -- cue=共享专名 / turn=同一轮被切两次 / adjacent=时间相邻 / day=同一天且挨着
  score REAL NOT NULL DEFAULT 0.5,
  evidence TEXT,                -- JSON：撞的抓手 / 间隔分钟 / 共用的 turn
  layer TEXT NOT NULL DEFAULT 'soft',   -- soft=同一件事（这层）；causal=真因果（还没做）
  created_at TEXT NOT NULL, direction TEXT NOT NULL DEFAULT 'forward', pull REAL NOT NULL DEFAULT 0.5, level INTEGER NOT NULL DEFAULT 0, confidence REAL NOT NULL DEFAULT 0.5, reason TEXT, status TEXT NOT NULL DEFAULT 'candidate', judge TEXT, valid_from TEXT, valid_to TEXT, updated_at TEXT, resolution TEXT)`,
`CREATE TABLE IF NOT EXISTS affect_v4_shadow(
    id TEXT PRIMARY KEY, agent_id TEXT NOT NULL,
    turn_id TEXT, conversation_id TEXT,
    at TEXT NOT NULL, frame_json TEXT NOT NULL,
    s REAL, n REAL, d REAL,
    label TEXT, primary_json TEXT, secondary_json TEXT,
    confidence REAL, source TEXT NOT NULL DEFAULT 'rules',
    latency_ms INTEGER, freeframe INTEGER NOT NULL DEFAULT 1,
    rev INTEGER NOT NULL DEFAULT 1, judgment_json TEXT, conf_primary REAL, label_tie INTEGER NOT NULL DEFAULT 0, goal_delta REAL, expect_delta REAL, future_delta REAL, severity TEXT)`,
`CREATE TABLE IF NOT EXISTS events_v2(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL,
  day TEXT NOT NULL,                              -- 本地日 YYYY-MM-DD（不是 UTC 的 day 列）
  start_at TEXT NOT NULL, end_at TEXT NOT NULL,   -- UTC ISO，首末碎片时间
  turn_ids TEXT NOT NULL,                         -- JSON 数组，来源碎片
  boundary TEXT,                                  -- Level 1：从什么转到什么，一句话
  boundary_kind TEXT,                             -- Stage 2 标签：Topic_Shift / Topic_Intro / Detail_Elaborate / Direct_Resp
  boundary_conf REAL,                             -- 边界那句有多确定
  title TEXT NOT NULL,                            -- 一句话，≤20 字
  summary TEXT NOT NULL,                          -- Level 2
  quotes TEXT,                                    -- JSON 数组，一字不差的原文
  cues TEXT,                                      -- JSON 数组，抓手词
  status TEXT,                                    -- 没过去 / 过去了：读口情绪乘子、想头加权都读它
  mode TEXT,                                      -- work / daily
  weight REAL NOT NULL DEFAULT 0.5,
  quality TEXT NOT NULL DEFAULT 'model',          -- model / local / lexical：低质量件要能被过滤
  confidence REAL NOT NULL DEFAULT 0.5,           -- Stage 2 的 p_eb；低置信不进台面
  feel_id TEXT,                                   -- 情绪接缝：这件事当时的情绪（同 memory_items.feel_id 待遇，可空不可丢）
  cut_rev INTEGER NOT NULL DEFAULT 1,
  extra TEXT,                                     -- JSON：塞不进列的先放这里，别急着加列
  created_at TEXT NOT NULL, session_id TEXT)`,
`CREATE TABLE IF NOT EXISTS event_members(
  event_id TEXT NOT NULL, fragment_id TEXT NOT NULL,
  agent_id TEXT NOT NULL, day TEXT NOT NULL,
  PRIMARY KEY (event_id, fragment_id))`,
`CREATE TABLE IF NOT EXISTS affair_rows (
  id TEXT PRIMARY KEY,
  agent_id TEXT,
  conversation_id TEXT,
  day TEXT,
  at TEXT,
  text TEXT,
  motive TEXT,
  motive_why TEXT,
  step TEXT,
  step_why TEXT,
  kind TEXT,
  place TEXT,
  open_json TEXT
)`,
]
export const RECOVERED_REST = [
`CREATE INDEX IF NOT EXISTS idx_mem_agent ON memory_items(agent_id, status, created_at DESC)`,
`CREATE INDEX IF NOT EXISTS idx_chat_agent ON chat_turns(agent_id, created_at)`,
`CREATE INDEX IF NOT EXISTS idx_rule_artifacts_kind ON rule_artifacts(kind, version)`,
`CREATE INDEX IF NOT EXISTS idx_thoughts_agent ON thoughts(agent_id, created_at DESC)`,
`CREATE INDEX IF NOT EXISTS idx_pdec_agent ON proactive_decisions(agent_id, at DESC)`,
`CREATE INDEX IF NOT EXISTS idx_pview_agent ON persona_views(agent_id, created_at DESC)`,
`CREATE INDEX IF NOT EXISTS idx_raw_agent_day ON "fragments"(agent_id, day, seq)`,
`CREATE INDEX IF NOT EXISTS idx_raw_session ON "fragments"(session_id, seq)`,
`CREATE UNIQUE INDEX IF NOT EXISTS idx_diary_day ON diaries(agent_id, day)`,
`CREATE INDEX IF NOT EXISTS idx_mem_band ON memory_items(agent_id, band, heat DESC)`,
`CREATE UNIQUE INDEX IF NOT EXISTS idx_fa_mem ON fact_archive(agent_id, memory_id)`,
`CREATE INDEX IF NOT EXISTS idx_fa_agent ON fact_archive(agent_id, created_at DESC)`,
`CREATE INDEX IF NOT EXISTS idx_rlog_agent ON retrieval_log(agent_id, at DESC)`,
`CREATE UNIQUE INDEX IF NOT EXISTS idx_ent_name ON entities(agent_id, name)`,
`CREATE INDEX IF NOT EXISTS idx_eq_state ON extract_queue(state, next_at)`,
`CREATE UNIQUE INDEX IF NOT EXISTS idx_cl_day ON consolidation_log(agent_id, day)`,
`CREATE INDEX IF NOT EXISTS idx_mem_entity ON memory_items(agent_id, entity_id)`,
`CREATE UNIQUE INDEX IF NOT EXISTS uq_rel_event_fp ON rel_event(agent_id, fingerprint)`,
`CREATE INDEX IF NOT EXISTS idx_rel_event_at ON rel_event(agent_id, at DESC)`,
`CREATE INDEX IF NOT EXISTS idx_rel_person_tier ON rel_person(agent_id, tier, salience DESC)`,
`CREATE UNIQUE INDEX IF NOT EXISTS uq_rel_owner ON rel_person(agent_id) WHERE tier='owner' AND status='active'`,
`CREATE INDEX IF NOT EXISTS idx_rel_edge_from ON rel_edge(agent_id, from_id)`,
`CREATE INDEX IF NOT EXISTS idx_rel_edge_to   ON rel_edge(agent_id, to_id)`,
`CREATE UNIQUE INDEX IF NOT EXISTS uq_rel_edge ON rel_edge(agent_id, from_id, to_id, kind) WHERE valid_to IS NULL`,
`CREATE INDEX IF NOT EXISTS idx_rel_mention_norm ON rel_mention(agent_id, normalized, state)`,
`CREATE INDEX IF NOT EXISTS idx_rel_evidence_person ON rel_evidence(agent_id, person_id)`,
`CREATE INDEX IF NOT EXISTS idx_rel_queue_due ON rel_extract_queue(agent_id, state, next_at)`,
`CREATE INDEX IF NOT EXISTS idx_rel_review_pending ON rel_review(agent_id, state, created_at)`,
`CREATE INDEX IF NOT EXISTS idx_aevent_agent ON affect_events(agent_id, at DESC)`,
`CREATE INDEX IF NOT EXISTS idx_research_seen_domain ON research_seen(domain)`,
`CREATE INDEX IF NOT EXISTS idx_research_runs_agent ON research_runs(agent_id, created_at DESC)`,
`CREATE INDEX IF NOT EXISTS idx_vec_agent ON memory_vec(agent_id)`,
`CREATE INDEX IF NOT EXISTS idx_live_events_agent ON live_events(agent_id, consumed_at)`,
`CREATE INDEX IF NOT EXISTS idx_axev ON axis_evidence(agent_id, axis, at DESC, used)`,
`CREATE INDEX IF NOT EXISTS idx_browse_agent_at ON browse_items(agent_id, at DESC)`,
`CREATE INDEX IF NOT EXISTS idx_browse_domain ON browse_items(agent_id, domain)`,
`CREATE INDEX IF NOT EXISTS idx_pjudge ON persona_judge(agent_id, state, at DESC)`,
`CREATE INDEX IF NOT EXISTS idx_tl_mem ON memory_timeline(agent_id, memory_id, seq)`,
`CREATE INDEX IF NOT EXISTS idx_tl_at ON memory_timeline(agent_id, at)`,
`CREATE INDEX IF NOT EXISTS ix_ev_agent_seq ON claim_events(agent_id, seq)`,
`CREATE INDEX IF NOT EXISTS ix_ev_agent_type ON claim_events(agent_id, type, seq)`,
`CREATE UNIQUE INDEX IF NOT EXISTS ux_ev_job ON claim_events(agent_id, job_key) WHERE type='JOB_DONE'`,
`CREATE INDEX IF NOT EXISTS ix_pc_agent ON persona_claims(agent_id, layer)`,
`CREATE INDEX IF NOT EXISTS ix_cx_target ON claim_evidence(agent_id, target_id)`,
`CREATE INDEX IF NOT EXISTS ix_pjc_agent ON claim_proj_claim(agent_id, layer, status)`,
`CREATE INDEX IF NOT EXISTS ix_pjk_agent ON claim_proj_kappa(agent_id, sigma)`,
`CREATE INDEX IF NOT EXISTS idx_claim_llm_cache_agent ON claim_llm_cache(agent_id)`,
`CREATE INDEX IF NOT EXISTS idx_loop_open ON open_loops(agent_id, state, due_at)`,
`CREATE INDEX IF NOT EXISTS idx_loop_mem ON open_loops(agent_id, memory_id)`,
`CREATE INDEX IF NOT EXISTS idx_surf_agent ON surfaced_items(agent_id, at DESC)`,
`CREATE UNIQUE INDEX IF NOT EXISTS idx_ep_uniq ON episodes(agent_id, session_id, day, seg)`,
`CREATE INDEX IF NOT EXISTS idx_sq_agent ON surface_queue(agent_id, state, created_at)`,
`CREATE INDEX IF NOT EXISTS idx_conv_agent ON conversations(agent_id, last_seen_at DESC)`,
`CREATE INDEX IF NOT EXISTS idx_chat_conv ON chat_turns(agent_id, conversation_id, created_at)`,
`CREATE INDEX IF NOT EXISTS idx_event_agent ON events(agent_id, created_at DESC)`,
`CREATE INDEX IF NOT EXISTS ix_sgd_agent ON sangguan_drafts(agent_id, status, created_at)`,
`CREATE INDEX IF NOT EXISTS idx_areview_agent ON affect_review(agent_id, at DESC)`,
`CREATE INDEX IF NOT EXISTS idx_feel_agent_at ON affect_feel(agent_id, at DESC)`,
`CREATE INDEX IF NOT EXISTS idx_pair_judge_agent ON memory_pair_judge(agent_id, judged_at DESC)`,
`CREATE INDEX IF NOT EXISTS idx_pair_judge_verdict ON memory_pair_judge(agent_id, verdict)`,
`CREATE INDEX IF NOT EXISTS idx_feel_turn ON affect_feel(agent_id, turn_id)`,
`CREATE INDEX IF NOT EXISTS idx_feel_session_at ON affect_feel(agent_id, session_id, at DESC)`,
`CREATE INDEX IF NOT EXISTS idx_claims_agent_state ON memory_claims(agent_id, state)`,
`CREATE VIEW v_relations AS
SELECT id, agent_id, name,
       CASE tier WHEN 'owner' THEN 'owner' WHEN 'acquaintance' THEN 'acquaintance' ELSE 'stranger' END AS kind,
       closeness, trust, dependence,
       CASE tier WHEN 'owner' THEN 1 ELSE 0 END AS root,
       summary AS notes, created_at, updated_at
FROM rel_person
WHERE status <> 'archived'`,
`CREATE TRIGGER trg_claim_events_no_update BEFORE UPDATE ON claim_events
BEGIN SELECT RAISE(ABORT, '三观账本只增：claim_events 不允许 UPDATE'); END`,
`CREATE TRIGGER trg_claim_events_no_delete BEFORE DELETE ON claim_events
WHEN NOT EXISTS (SELECT 1 FROM claim_purge WHERE agent_id=OLD.agent_id)
BEGIN SELECT RAISE(ABORT, '三观账本只增：claim_events 不允许 DELETE'); END`,
`CREATE TRIGGER trg_persona_claims_no_update BEFORE UPDATE ON persona_claims
BEGIN SELECT RAISE(ABORT, '三观账本只增：persona_claims 不允许 UPDATE'); END`,
`CREATE TRIGGER trg_persona_claims_no_delete BEFORE DELETE ON persona_claims
WHEN NOT EXISTS (SELECT 1 FROM claim_purge WHERE agent_id=OLD.agent_id)
BEGIN SELECT RAISE(ABORT, '三观账本只增：persona_claims 不允许 DELETE'); END`,
`CREATE TRIGGER trg_claim_questions_no_update BEFORE UPDATE ON claim_questions
BEGIN SELECT RAISE(ABORT, '三观账本只增：claim_questions 不允许 UPDATE'); END`,
`CREATE TRIGGER trg_claim_questions_no_delete BEFORE DELETE ON claim_questions
WHEN NOT EXISTS (SELECT 1 FROM claim_purge WHERE agent_id=OLD.agent_id)
BEGIN SELECT RAISE(ABORT, '三观账本只增：claim_questions 不允许 DELETE'); END`,
`CREATE TRIGGER trg_claim_kappa_no_update BEFORE UPDATE ON claim_kappa
BEGIN SELECT RAISE(ABORT, '三观账本只增：claim_kappa 不允许 UPDATE'); END`,
`CREATE TRIGGER trg_claim_kappa_no_delete BEFORE DELETE ON claim_kappa
WHEN NOT EXISTS (SELECT 1 FROM claim_purge WHERE agent_id=OLD.agent_id)
BEGIN SELECT RAISE(ABORT, '三观账本只增：claim_kappa 不允许 DELETE'); END`,
`CREATE TRIGGER trg_claim_predictions_no_update BEFORE UPDATE ON claim_predictions
BEGIN SELECT RAISE(ABORT, '三观账本只增：claim_predictions 不允许 UPDATE'); END`,
`CREATE TRIGGER trg_claim_predictions_no_delete BEFORE DELETE ON claim_predictions
WHEN NOT EXISTS (SELECT 1 FROM claim_purge WHERE agent_id=OLD.agent_id)
BEGIN SELECT RAISE(ABORT, '三观账本只增：claim_predictions 不允许 DELETE'); END`,
`CREATE TRIGGER trg_claim_evidence_no_update BEFORE UPDATE ON claim_evidence
BEGIN SELECT RAISE(ABORT, '三观账本只增：claim_evidence 不允许 UPDATE'); END`,
`CREATE TRIGGER trg_claim_evidence_no_delete BEFORE DELETE ON claim_evidence
WHEN NOT EXISTS (SELECT 1 FROM claim_purge WHERE agent_id=OLD.agent_id)
BEGIN SELECT RAISE(ABORT, '三观账本只增：claim_evidence 不允许 DELETE'); END`,
`CREATE TRIGGER trg_claim_edges_no_update BEFORE UPDATE ON claim_edges
BEGIN SELECT RAISE(ABORT, '三观账本只增：claim_edges 不允许 UPDATE'); END`,
`CREATE TRIGGER trg_claim_edges_no_delete BEFORE DELETE ON claim_edges
WHEN NOT EXISTS (SELECT 1 FROM claim_purge WHERE agent_id=OLD.agent_id)
BEGIN SELECT RAISE(ABORT, '三观账本只增：claim_edges 不允许 DELETE'); END`,
`CREATE TRIGGER trg_claim_summaries_no_update BEFORE UPDATE ON claim_summaries
BEGIN SELECT RAISE(ABORT, '三观账本只增：claim_summaries 不允许 UPDATE'); END`,
`CREATE TRIGGER trg_claim_summaries_no_delete BEFORE DELETE ON claim_summaries
WHEN NOT EXISTS (SELECT 1 FROM claim_purge WHERE agent_id=OLD.agent_id)
BEGIN SELECT RAISE(ABORT, '三观账本只增：claim_summaries 不允许 DELETE'); END`,
`CREATE INDEX IF NOT EXISTS idx_mem_prov_agent ON memory_provenance(agent_id, speaker)`,
`CREATE INDEX IF NOT EXISTS idx_state_scene_at ON state_scene(agent_id, tier, at DESC)`,
`CREATE UNIQUE INDEX IF NOT EXISTS idx_state_scene_turn ON state_scene(agent_id, turn_id, tier)`,
`CREATE INDEX IF NOT EXISTS idx_scene_archive_at ON scene_archive(agent_id, at DESC)`,
`CREATE INDEX IF NOT EXISTS idx_confluence_at ON confluence_log(agent_id, at DESC)`,
`CREATE INDEX IF NOT EXISTS idx_revisit_at ON revisit(agent_id, at DESC)`,
`CREATE INDEX IF NOT EXISTS idx_cold_events_agent ON cold_events(agent_id, start_at)`,
`CREATE INDEX IF NOT EXISTS idx_hot_events_agent ON hot_events(agent_id, active, state)`,
`CREATE INDEX IF NOT EXISTS idx_chat_turn ON chat_turns(agent_id, turn_id)`,
`CREATE INDEX IF NOT EXISTS idx_event_edges_from ON event_edges(from_id)`,
`CREATE INDEX IF NOT EXISTS idx_event_edges_to ON event_edges(to_id)`,
`CREATE UNIQUE INDEX IF NOT EXISTS uq_event_edges ON event_edges(agent_id, from_id, to_id, kind) WHERE valid_to IS NULL`,
`CREATE INDEX IF NOT EXISTS idx_av4_agent_at ON affect_v4_shadow(agent_id, at DESC)`,
`CREATE INDEX IF NOT EXISTS idx_av4_turn ON affect_v4_shadow(agent_id, turn_id)`,
`CREATE INDEX IF NOT EXISTS idx_ev2_agent ON events_v2(agent_id, day, start_at)`,
`CREATE INDEX IF NOT EXISTS idx_evm_frag ON event_members(fragment_id)`,
`CREATE INDEX IF NOT EXISTS idx_evm_ev ON event_members(event_id)`,
`CREATE INDEX IF NOT EXISTS idx_av4_agent_at2 ON affect_v4_shadow(agent_id, at DESC, expect_delta)`,
`CREATE INDEX IF NOT EXISTS affair_rows_day ON affair_rows(agent_id, day)`,
]
