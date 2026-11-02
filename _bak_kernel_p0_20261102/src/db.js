import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ensureSangguanSchema } from './modules/sangguan/schema.js'

const SCHEMA = `
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS schema_meta(version INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS agents(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'daily',
  status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL,
  deleted_at TEXT, schema_version INTEGER NOT NULL DEFAULT 1);

CREATE TABLE IF NOT EXISTS memory_items(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, type TEXT NOT NULL,
  mark TEXT NOT NULL DEFAULT 'normal', text TEXT NOT NULL, source TEXT NOT NULL,
  w0 REAL NOT NULL DEFAULT 0.5, weight REAL NOT NULL DEFAULT 0.5,
  stability REAL NOT NULL DEFAULT 1.0, difficulty REAL NOT NULL DEFAULT 5.0,
  last_decay_at TEXT NOT NULL, valid_at TEXT, invalid_at TEXT,
  status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL,
  deleted_at TEXT, version INTEGER NOT NULL DEFAULT 1);
CREATE INDEX IF NOT EXISTS idx_mem_agent ON memory_items(agent_id, status, created_at DESC);
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(id UNINDEXED, text, tokenize='trigram');

CREATE TABLE IF NOT EXISTS memory_links(
  from_id TEXT NOT NULL, to_id TEXT NOT NULL, kind TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.5, PRIMARY KEY(from_id, to_id, kind));

CREATE TABLE IF NOT EXISTS conflicts(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, a_id TEXT NOT NULL, b_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'open', resolution TEXT, reason TEXT, resolved_at TEXT);

CREATE TABLE IF NOT EXISTS proposals(
  id TEXT PRIMARY KEY, human_no TEXT, agent_id TEXT NOT NULL,
  change_class TEXT NOT NULL, target TEXT, field TEXT, before TEXT, after TEXT,
  state TEXT NOT NULL, gate_trace TEXT, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
  shadow_done INTEGER DEFAULT 0, shadow_total INTEGER DEFAULT 0,
  shadow_log TEXT, shadow_hit REAL, observing_until TEXT, approved_by TEXT,
  observe_baseline TEXT, observe_samples INTEGER DEFAULT 0);

CREATE TABLE IF NOT EXISTS change_journal(
  id TEXT PRIMARY KEY, proposal_id TEXT, agent_id TEXT NOT NULL, field TEXT,
  before_value TEXT, after_value TEXT, state TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS changes(
  id TEXT PRIMARY KEY, proposal_id TEXT, agent_id TEXT NOT NULL, field TEXT NOT NULL,
  before TEXT, after TEXT, applied_at TEXT NOT NULL, approver TEXT, actor TEXT NOT NULL,
  source TEXT NOT NULL, rolled_back_at TEXT, observing_until TEXT);

CREATE TABLE IF NOT EXISTS inbox_items(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, lane TEXT NOT NULL, ref_id TEXT,
  title TEXT, reason TEXT, priority INTEGER DEFAULT 3, state TEXT NOT NULL DEFAULT 'pending',
  expires_at TEXT, created_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS events(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, type TEXT NOT NULL,
  payload TEXT NOT NULL, created_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS journal(
  seq INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, turn_id TEXT,
  op TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'intent',
  created_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS idempotency(
  key TEXT PRIMARY KEY, body_hash TEXT NOT NULL, status INTEGER NOT NULL,
  response TEXT NOT NULL, created_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS metric_snapshots(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, key TEXT NOT NULL,
  value REAL, sampled_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS persona(
  agent_id TEXT NOT NULL, path TEXT NOT NULL, value TEXT NOT NULL,
  origin TEXT NOT NULL DEFAULT 'auto', updated_at TEXT NOT NULL,
  PRIMARY KEY(agent_id, path));

CREATE TABLE IF NOT EXISTS affect_state(
  agent_id TEXT PRIMARY KEY, primary_label TEXT NOT NULL, secondary_label TEXT,
  intensity REAL NOT NULL DEFAULT 0.5, mood REAL NOT NULL DEFAULT 0.6,
  pleasure REAL NOT NULL DEFAULT 0.0, arousal REAL NOT NULL DEFAULT 0.0,
  dominance REAL NOT NULL DEFAULT 0.0, updated_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS alerts(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, kind TEXT NOT NULL,
  severity INTEGER NOT NULL DEFAULT 2, title TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS affect_episodes(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, cause TEXT,
  appraisal TEXT, label TEXT, intensity REAL NOT NULL DEFAULT 0.5,
  resolution TEXT, started_at TEXT NOT NULL, ended_at TEXT,
  renewals INTEGER NOT NULL DEFAULT 0, rise_from REAL, rise_at TEXT);

-- 事件闸门：每条消息一行。gate=1 才是真的情绪事件（写 episode、换主情绪）；
-- gate=0 只留日志，用来算过闸率、回放校准。见 7-情绪事件化-v1.md §3.2。
CREATE TABLE IF NOT EXISTS affect_events(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, at TEXT NOT NULL,
  cause TEXT, rel REAL, cong REAL, nov REAL, cert REAL, prev_cong REAL,
  sig REAL, theta REAL, gate INTEGER NOT NULL DEFAULT 0,
  label TEXT, raw_label TEXT, margin REAL, scores TEXT, episode_id TEXT, formula TEXT);
CREATE INDEX IF NOT EXISTS idx_aevent_agent ON affect_events(agent_id, at DESC);

-- 「它现在觉得你」的反馈：一条 episode 最多一条，改就覆盖。
-- guess_label 是它当时读出的你，actual_label 是你亲口说的事实。
CREATE TABLE IF NOT EXISTS affect_user_read(
  agent_id TEXT NOT NULL, episode_id TEXT NOT NULL,
  guess_label TEXT NOT NULL, actual_label TEXT NOT NULL,
  note TEXT, created_at TEXT NOT NULL,
  PRIMARY KEY(agent_id, episode_id));

CREATE TABLE IF NOT EXISTS drive_state(
  agent_id TEXT PRIMARY KEY, r REAL NOT NULL, e REAL NOT NULL, c REAL NOT NULL,
  a REAL NOT NULL, s REAL NOT NULL, setpoint TEXT, band TEXT NOT NULL DEFAULT 'D1',
  streak INTEGER NOT NULL DEFAULT 0, tokens TEXT, tokens_refill_at TEXT,
  last_eval_at TEXT NOT NULL, dormant_since TEXT);

CREATE TABLE IF NOT EXISTS action_ports(
  agent_id TEXT NOT NULL, name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL, PRIMARY KEY(agent_id, name));
`

const EXT = `
CREATE TABLE IF NOT EXISTS relations(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'acquaintance',
  closeness REAL NOT NULL DEFAULT 0.2, trust REAL NOT NULL DEFAULT 0.2, dependence REAL NOT NULL DEFAULT 0.0,
  root INTEGER NOT NULL DEFAULT 0, notes TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS persona_values(
  agent_id TEXT NOT NULL, key TEXT NOT NULL, weight REAL NOT NULL DEFAULT 0.1, evidence TEXT,
  updated_at TEXT NOT NULL, PRIMARY KEY(agent_id, key));
CREATE TABLE IF NOT EXISTS preferences(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, tag TEXT NOT NULL, aversion REAL NOT NULL DEFAULT 0.0,
  origin TEXT NOT NULL DEFAULT 'auto', created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS taboos(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, text TEXT NOT NULL, level TEXT NOT NULL DEFAULT 'soft',
  origin TEXT NOT NULL DEFAULT 'auto', created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS condition_state(
  agent_id TEXT PRIMARY KEY, attention REAL NOT NULL DEFAULT 0.7, load REAL NOT NULL DEFAULT 0.2,
  state TEXT NOT NULL DEFAULT 'focus', updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS affect_samples(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, at TEXT NOT NULL, label TEXT, intensity REAL,
  fast TEXT, slow TEXT);
CREATE TABLE IF NOT EXISTS cooldowns(
  agent_id TEXT NOT NULL, scope TEXT NOT NULL, key TEXT NOT NULL, until TEXT NOT NULL,
  reason TEXT, PRIMARY KEY(agent_id, scope, key));
CREATE TABLE IF NOT EXISTS budgets(
  agent_id TEXT PRIMARY KEY, month TEXT NOT NULL, money_limit REAL NOT NULL DEFAULT 0,
  money_used REAL NOT NULL DEFAULT 0, token_limit INTEGER NOT NULL DEFAULT 0,
  token_used INTEGER NOT NULL DEFAULT 0, disturb_limit INTEGER NOT NULL DEFAULT 3,
  disturb_used INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS rule_versions(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, version INTEGER NOT NULL, params TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 0, note TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS metric_samples(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, key TEXT NOT NULL, value REAL, sampled_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS action_log(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, port TEXT NOT NULL, payload TEXT,
  status TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS chat_turns(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL,
  pack TEXT, mood TEXT, created_at TEXT NOT NULL, conversation_id TEXT);
CREATE INDEX IF NOT EXISTS idx_chat_agent ON chat_turns(agent_id, created_at);
-- 会话账（schema 13）：一段外部会话（QQ 私聊/群）归哪个意识体。
-- 和 bindings 分开：bindings 管 DSH 网页会话，conversations 管外部通道；都不写死到配置里。
CREATE TABLE IF NOT EXISTS conversations(
  conversation_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'qq', handle TEXT NOT NULL DEFAULT '',
  person_id TEXT, state TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL, last_seen_at TEXT,
  released_at TEXT, released_by TEXT);
CREATE INDEX IF NOT EXISTS idx_conv_agent ON conversations(agent_id, last_seen_at DESC);
CREATE TABLE IF NOT EXISTS proactive(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, text TEXT NOT NULL, reason TEXT,
  dim TEXT, state TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, delivered_at TEXT);
-- 会话绑定（schema 12）：一个 session 同时只认一个 agent；一个 agent 可绑多段会话。
-- state=bound 才注入；released 行留着可查（谁改的绑、什么时候）。
CREATE TABLE IF NOT EXISTS bindings(
  session_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, created_at TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'bound', source TEXT NOT NULL DEFAULT 'auto',
  bound_at TEXT, last_seen_at TEXT, released_at TEXT, released_by TEXT);
-- 每实例心跳账：调度器只认 next_at，不看进程内有没有 timer。
CREATE TABLE IF NOT EXISTS heartbeats(
  agent_id TEXT PRIMARY KEY, interval_ms INTEGER NOT NULL DEFAULT 300000,
  next_at INTEGER NOT NULL, last_at INTEGER, last_ms INTEGER,
  last_error TEXT, failures INTEGER NOT NULL DEFAULT 0,
  skips INTEGER NOT NULL DEFAULT 0, mode TEXT NOT NULL DEFAULT 'auto',
  deep_at INTEGER, deep_ms INTEGER NOT NULL DEFAULT 900000);
-- 在场状态缓存（派生值：真值由 bindings + 时间算；这里只给界面/诊断读）。
CREATE TABLE IF NOT EXISTS agent_runtime(
  agent_id TEXT PRIMARY KEY, state TEXT NOT NULL DEFAULT 'idle',
  since TEXT NOT NULL, reason TEXT, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS flags(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS algo_bindings(
  agent_id TEXT NOT NULL, name TEXT NOT NULL,
  active TEXT NOT NULL, canary TEXT, ratio REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL, PRIMARY KEY(agent_id, name));
CREATE TABLE IF NOT EXISTS agent_params(
  agent_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
  updated_at TEXT NOT NULL, PRIMARY KEY(agent_id, key));
CREATE TABLE IF NOT EXISTS rule_artifacts(
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, version INTEGER NOT NULL,
  payload_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'available',
  created_at TEXT NOT NULL, retired_at TEXT);
CREATE INDEX IF NOT EXISTS idx_rule_artifacts_kind ON rule_artifacts(kind, version);
CREATE TABLE IF NOT EXISTS agent_bindings(
  agent_id TEXT NOT NULL, kind TEXT NOT NULL,
  active_id TEXT NOT NULL, previous_id TEXT, pinned_id TEXT, v0_id TEXT NOT NULL,
  updated_at TEXT NOT NULL, PRIMARY KEY(agent_id, kind));
CREATE TABLE IF NOT EXISTS thoughts(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL,
  self_text TEXT, other_text TEXT, world_text TEXT, want_text TEXT,
  other_label TEXT, source TEXT NOT NULL DEFAULT 'model', created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_thoughts_agent ON thoughts(agent_id, created_at DESC);
CREATE TABLE IF NOT EXISTS persona_views(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, text TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'rules', facts TEXT, sources TEXT,
  prompt_chars INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_pview_agent ON persona_views(agent_id, created_at DESC);

-- ================= 分层记忆 T1–T4 =================
-- T4 原文层（冷）：一轮一行，只追加，永不改写。平时的召回**不碰**这张表。
CREATE TABLE IF NOT EXISTS raw_turns(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, session_id TEXT NOT NULL,
  turn_id TEXT, seq INTEGER NOT NULL DEFAULT 0, role TEXT NOT NULL,
  text TEXT NOT NULL, tool TEXT, meta TEXT,
  created_at TEXT NOT NULL, day TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_raw_agent_day ON raw_turns(agent_id, day, seq);
CREATE INDEX IF NOT EXISTS idx_raw_session ON raw_turns(session_id, seq);
CREATE VIRTUAL TABLE IF NOT EXISTS raw_fts USING fts5(id UNINDEXED, text, tokenize='trigram');

-- T2 纪要层（温）：一次会话 / 一天的压缩，日记的原料。
CREATE TABLE IF NOT EXISTS episodes(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, session_id TEXT, day TEXT NOT NULL,
  start_at TEXT, end_at TEXT, turns INTEGER NOT NULL DEFAULT 0,
  title TEXT, summary TEXT, topics TEXT, mood TEXT, open_loops TEXT,
  importance REAL NOT NULL DEFAULT 0.5, hits INTEGER NOT NULL DEFAULT 0,
  last_hit_at TEXT, source TEXT NOT NULL DEFAULT 'rules', created_at TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ep_uniq ON episodes(agent_id, session_id, day);

-- T3 日记层（温偏冷）：一天一篇，第一人称，可重建不覆盖。
CREATE TABLE IF NOT EXISTS diaries(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, day TEXT NOT NULL,
  text TEXT NOT NULL, mood TEXT, highlights TEXT, refs TEXT,
  source TEXT NOT NULL DEFAULT 'rules', version INTEGER NOT NULL DEFAULT 1,
  late INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS idx_diary_day ON diaries(agent_id, day);
-- 写这篇日记时的「它是什么状态」：人格 / 价值观 / 情绪 / 驱力 / 关系，用来解释口吻
-- 旧库用 ALTER 补列（见 openDb）。

-- T4 事实存根（append-only）：一条事实「最初生成时」的原样快照。
-- memory_items 里那条会衰减、被推翻、被去重合并、被删；这里留底，回答「我当初记的是哪句话」。
-- 只有「明确硬删」（软删满 7 天的清理）才会连存根一起清。
CREATE TABLE IF NOT EXISTS fact_archive(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, memory_id TEXT NOT NULL,
  text TEXT NOT NULL, type TEXT, mark TEXT,
  importance REAL, salience REAL, confidence REAL,
  fact_key TEXT, source_turn_id TEXT, source TEXT NOT NULL DEFAULT 'model',
  payload TEXT, created_at TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS idx_fa_mem ON fact_archive(agent_id, memory_id);
CREATE INDEX IF NOT EXISTS idx_fa_agent ON fact_archive(agent_id, created_at DESC);
CREATE VIRTUAL TABLE IF NOT EXISTS fact_fts USING fts5(id UNINDEXED, text, tokenize='trigram');

-- 检索回放日志：每次召回一行，用来调阈值（scene / 候选数 / 过门数 / 注入量 / 耗时）。
-- 只用于观测，不进任何召回路径；默认留 30 天。
CREATE TABLE IF NOT EXISTS retrieval_log(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, at TEXT NOT NULL,
  scene TEXT NOT NULL, query TEXT NOT NULL DEFAULT '', why TEXT,
  counts TEXT, kept TEXT, dropped TEXT,
  items INTEGER NOT NULL DEFAULT 0, tokens INTEGER NOT NULL DEFAULT 0, ms INTEGER);
CREATE INDEX IF NOT EXISTS idx_rlog_agent ON retrieval_log(agent_id, at DESC);

-- 开环：还没闭合的事（答应过的 / 要提醒的 / 没做完的）。
-- 它不参与召回打分，也不受相关度门控：到期或久未提及，就自己浮上来一条。
CREATE TABLE IF NOT EXISTS open_loops(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'task', text TEXT NOT NULL,
  memory_id TEXT, source_turn_id TEXT,
  due_at TEXT, stale_after TEXT,
  state TEXT NOT NULL DEFAULT 'open',
  fired_at TEXT, fire_count INTEGER NOT NULL DEFAULT 0,
  closed_at TEXT, closed_by TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_loop_open ON open_loops(agent_id, state, due_at);
CREATE INDEX IF NOT EXISTS idx_loop_mem ON open_loops(agent_id, memory_id);

-- 反思游标：这一窗新记忆的 importance 累加。到阈值就把流水账压成一条「结论」。
CREATE TABLE IF NOT EXISTS reflect_cursor(
  agent_id TEXT PRIMARY KEY, acc REAL NOT NULL DEFAULT 0,
  window_start TEXT, last_reflect_at TEXT, updated_at TEXT NOT NULL);

-- 浮现观测：每轮注入了哪几条、回复里用没用上。只做观测，不进召回路径。
CREATE TABLE IF NOT EXISTS surfaced_items(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL,
  memory_id TEXT, kind TEXT NOT NULL DEFAULT 'related', text TEXT NOT NULL,
  at TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0, used_at TEXT);
CREATE INDEX IF NOT EXISTS idx_surf_agent ON surfaced_items(agent_id, at DESC);

-- 实体：人名 / 物件 / 项目。用来把「同一件事的不同说法」并到一起（「美式」和「咖啡」）。
CREATE TABLE IF NOT EXISTS entities(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, name TEXT NOT NULL, kind TEXT,
  aliases TEXT, hits INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ent_name ON entities(agent_id, name);

-- 抽取队列：写入门控的异步入口。进程重启也不丢，失败按次数退避重试。
CREATE TABLE IF NOT EXISTS extract_queue(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, turns TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
  next_at TEXT NOT NULL, last_error TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_eq_state ON extract_queue(state, next_at);

-- P4 夜间巩固：每天一行，记下「哪一天、做了哪几步、用了多久」，跑没跑过一目了然。
CREATE TABLE IF NOT EXISTS consolidation_log(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, day TEXT NOT NULL, at TEXT NOT NULL,
  steps TEXT, ok INTEGER NOT NULL DEFAULT 1, ms INTEGER);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cl_day ON consolidation_log(agent_id, day);
`

/**
 * 关系域（v2 人物账本）：rel_event 是主数据，其余都是可重放投影。
 * 收口在 src/modules/relations.js；见 5-关系统筹-v2.md §4。
 * 依赖 PRAGMA foreign_keys=ON（SCHEMA 里已开）。
 */
const REL = `
CREATE TABLE IF NOT EXISTS rel_event(
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
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_rel_event_fp ON rel_event(agent_id, fingerprint);
CREATE INDEX IF NOT EXISTS idx_rel_event_at ON rel_event(agent_id, at DESC);

CREATE TABLE IF NOT EXISTS rel_tier(
  tier            TEXT PRIMARY KEY CHECK(tier IN ('owner','acquaintance','stranger')),
  label           TEXT NOT NULL,
  warmth          REAL NOT NULL, formality REAL NOT NULL, initiative REAL NOT NULL, disclosure REAL NOT NULL,
  detail_level    INTEGER NOT NULL CHECK(detail_level IN (1,2,3)),
  init_closeness  REAL NOT NULL, init_trust REAL NOT NULL, init_dependence REAL NOT NULL,
  half_life_days  REAL, forget_after_days REAL,
  promote_to      TEXT, demote_to TEXT, sort INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rel_person(
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
);
CREATE INDEX IF NOT EXISTS idx_rel_person_tier ON rel_person(agent_id, tier, salience DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_rel_owner ON rel_person(agent_id) WHERE tier='owner' AND status='active';

CREATE TABLE IF NOT EXISTS rel_edge(
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
);
CREATE INDEX IF NOT EXISTS idx_rel_edge_from ON rel_edge(agent_id, from_id);
CREATE INDEX IF NOT EXISTS idx_rel_edge_to   ON rel_edge(agent_id, to_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_rel_edge ON rel_edge(agent_id, from_id, to_id, kind) WHERE valid_to IS NULL;

CREATE TABLE IF NOT EXISTS rel_mention(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL,
  event_id TEXT NOT NULL REFERENCES rel_event(id),
  surface TEXT NOT NULL, normalized TEXT NOT NULL,
  how TEXT NOT NULL DEFAULT 'name',
  context TEXT,
  candidate_ids TEXT NOT NULL DEFAULT '[]',
  state TEXT NOT NULL DEFAULT 'unresolved',
  confidence REAL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rel_mention_norm ON rel_mention(agent_id, normalized, state);

CREATE TABLE IF NOT EXISTS rel_evidence(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL,
  person_id TEXT, edge_id TEXT, memory_id TEXT, turn_id TEXT, event_id TEXT,
  kind TEXT NOT NULL, text TEXT NOT NULL, weight REAL NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rel_evidence_person ON rel_evidence(agent_id, person_id);

CREATE TABLE IF NOT EXISTS rel_channel(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, person_id TEXT NOT NULL REFERENCES rel_person(id),
  channel TEXT NOT NULL, handle TEXT NOT NULL, confidence REAL NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, UNIQUE(agent_id, channel, handle)
);

CREATE TABLE IF NOT EXISTS rel_extract_queue(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL,
  event_id TEXT, turns TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0, next_at TEXT NOT NULL, last_error TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rel_queue_due ON rel_extract_queue(agent_id, state, next_at);

CREATE TABLE IF NOT EXISTS rel_review(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL,
  event_id TEXT,
  kind TEXT NOT NULL,
  person_id TEXT, edge_id TEXT,
  payload TEXT NOT NULL,
  confidence REAL NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rel_review_pending ON rel_review(agent_id, state, created_at);

CREATE VIEW IF NOT EXISTS v_relations AS
SELECT id, agent_id, name,
       CASE tier WHEN 'owner' THEN 'owner' WHEN 'acquaintance' THEN 'acquaintance' ELSE 'stranger' END AS kind,
       closeness, trust, dependence,
       CASE tier WHEN 'owner' THEN 1 ELSE 0 END AS root,
       summary AS notes, created_at, updated_at
FROM rel_person
WHERE status <> 'archived';
`

export function now() {
  return new Date().toISOString()
}

/** 本地日历日 YYYY-MM-DD（不要用 toISOString().slice(0,10)，那是 UTC，跨零点会错一天）。 */
export function localDay(d = new Date()) {
  const x = d instanceof Date ? d : new Date(d)
  if (!Number.isFinite(x.getTime())) {
    const n = new Date()
    const p = (v) => String(v).padStart(2, '0')
    return n.getFullYear() + '-' + p(n.getMonth() + 1) + '-' + p(n.getDate())
  }
  const p = (v) => String(v).padStart(2, '0')
  return x.getFullYear() + '-' + p(x.getMonth() + 1) + '-' + p(x.getDate())
}

/** ISO / Date → 本地日历日。 */
export function dayKey(isoOrDate) {
  if (isoOrDate == null || isoOrDate === '') return localDay(new Date())
  if (isoOrDate instanceof Date) return localDay(isoOrDate)
  const t = Date.parse(String(isoOrDate))
  return Number.isFinite(t) ? localDay(new Date(t)) : localDay(new Date())
}

/** 本地日 [startISO, endISO) 半开区间，供按 created_at 筛「当天」事实。 */
export function localDayBounds(day) {
  const d = String(day || localDay()).slice(0, 10)
  const start = new Date(d + 'T00:00:00')
  const end = new Date(start.getTime() + 86400000)
  return { start: start.toISOString(), end: end.toISOString(), day: d }
}

// 行动层：通道配置 / 已读来源 / 研究报告。
// 单独放一块而不是塞进 EXT：这几张表只有行动接口在用，删掉也不影响意识本体。
const ACTION = `
CREATE TABLE IF NOT EXISTS action_config(
  agent_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
  updated_at TEXT NOT NULL, PRIMARY KEY(agent_id, key));

CREATE TABLE IF NOT EXISTS research_seen(
  url_hash TEXT PRIMARY KEY, url TEXT NOT NULL, domain TEXT, title TEXT,
  first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, hits INTEGER NOT NULL DEFAULT 1);
CREATE INDEX IF NOT EXISTS idx_research_seen_domain ON research_seen(domain);

CREATE TABLE IF NOT EXISTS research_runs(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, topic TEXT NOT NULL, goal TEXT,
  depth TEXT, report TEXT, sources TEXT, stats TEXT, status TEXT NOT NULL,
  created_at TEXT NOT NULL, finished_at TEXT);
CREATE INDEX IF NOT EXISTS idx_research_runs_agent ON research_runs(agent_id, created_at DESC);

-- P3 浏览入口：抓完正文不再扔掉，落一条带 need_tags 的条目，喂给探索（browseNew）和几个辅助项。
CREATE TABLE IF NOT EXISTS browse_items(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, url TEXT, domain TEXT,
  title TEXT, text TEXT, query TEXT, channel TEXT NOT NULL DEFAULT 'browse',
  dwell_ms INTEGER NOT NULL DEFAULT 0, tags TEXT NOT NULL DEFAULT '[]',
  weights TEXT NOT NULL DEFAULT '{}', at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_browse_agent_at ON browse_items(agent_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_browse_domain ON browse_items(agent_id, domain);
`

/** 升级前整份复制一份（含 WAL/SHM）；新库、已是最新、复制失败都不阻断启动。 */
function backupBeforeUpgrade(file) {
  try {
    if (!fs.existsSync(file)) return
    const probe = new DatabaseSync(file, { readOnly: true })
    let v = 0
    try { const r = probe.prepare('SELECT version FROM schema_meta').get(); v = Number(r && r.version || 0) } catch { v = 0 } finally { probe.close() }
    if (!(v > 0 && v < 13)) return
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const dst = `${file}.bak-schema${v}-${stamp}`
    fs.copyFileSync(file, dst)
    for (const ext of ['-wal', '-shm']) {
      if (fs.existsSync(file + ext)) fs.copyFileSync(file + ext, dst + ext)
    }
  } catch { /* 备份失败不阻断；迁移只加列 */ }
}

export function openDb(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  backupBeforeUpgrade(file)
  const db = new DatabaseSync(file)
  db.exec(SCHEMA)
  db.exec(EXT)
  db.exec(REL)
  db.exec(ACTION)
  try { db.exec('ALTER TABLE affect_events ADD COLUMN formula TEXT') } catch { /* 已存在 */ }
  // 复现：同一段情绪被后续消息重新点亮了几次
  try { db.exec('ALTER TABLE affect_episodes ADD COLUMN renewals INTEGER NOT NULL DEFAULT 0') } catch { /* 已存在 */ }
  // 上升段：这一段从哪个值开始爬（rise_from）、什么时候开始爬（rise_at）。老记录没有，视为已经到顶
  try { db.exec('ALTER TABLE affect_episodes ADD COLUMN rise_from REAL') } catch { /* 已存在 */ }
  try { db.exec('ALTER TABLE affect_episodes ADD COLUMN rise_at TEXT') } catch { /* 已存在 */ }
  try { db.exec('ALTER TABLE agents ADD COLUMN last_interaction_at TEXT') } catch { /* 已存在 */ }
  try { db.exec('ALTER TABLE agents ADD COLUMN avatar TEXT') } catch { /* 已存在 */ }
  try { db.exec('ALTER TABLE proposals ADD COLUMN expect TEXT') } catch { /* 已存在 */ }
  try { db.exec('ALTER TABLE proposals ADD COLUMN risk TEXT') } catch { /* 已存在 */ }
  try { db.exec('ALTER TABLE proposals ADD COLUMN rollback_plan TEXT') } catch { /* 已存在 */ }
  try { db.exec('ALTER TABLE proposals ADD COLUMN deficit TEXT') } catch { /* 已存在 */ }
  try { db.exec('ALTER TABLE drive_state ADD COLUMN smooth TEXT') } catch { /* 已存在 */ }
  try { db.exec('ALTER TABLE drive_state ADD COLUMN unlocked TEXT') } catch { /* 已存在 */ }
  try { db.exec('ALTER TABLE proposals ADD COLUMN fork_artifact_id TEXT') } catch { /* 已存在 */ }
  // schema 13：旧库补会话列（新库在建表时已有）；索引必须等列补完再建
  try { db.exec('ALTER TABLE chat_turns ADD COLUMN conversation_id TEXT') } catch { /* 已存在 */ }
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_chat_conv ON chat_turns(agent_id, conversation_id, created_at)') } catch { /* 老库异常不影响启动 */ }
  // 情绪 v3：底色 / 慢 / 快 / 总。独立表，不动 affect_state 的定长 INSERT。
  db.exec(`CREATE TABLE IF NOT EXISTS affect_v3(
    agent_id TEXT PRIMARY KEY, baseline REAL NOT NULL DEFAULT 0,
    slow REAL NOT NULL DEFAULT 0, fast REAL NOT NULL DEFAULT 0,
    total REAL NOT NULL DEFAULT 0, slow_at TEXT, fast_at TEXT);`)
  // 快情绪的时间锚：两次评价隔了多久，快情绪就按这个间隔自己退（不是一句话直接归零）
  try { db.exec('ALTER TABLE affect_v3 ADD COLUMN fast_at TEXT') } catch { /* 已存在 */ }
  // 累积负荷：底色的第三层（日节律之外）。被慢情绪的持续偏离拖走一点，几天代谢回来。
  try { db.exec('ALTER TABLE affect_v3 ADD COLUMN base_off REAL DEFAULT 0') } catch { /* 已存在 */ }
  try { db.exec('ALTER TABLE affect_v3 ADD COLUMN base_off_at TEXT') } catch { /* 已存在 */ }
  // 底色段表：一行一段，不靠 tick 累积
  db.exec(`CREATE TABLE IF NOT EXISTS affect_baseline(
    agent_id TEXT NOT NULL, seg_no INTEGER NOT NULL,
    started_at TEXT NOT NULL, duration_h REAL NOT NULL,
    from_val REAL NOT NULL, to_val REAL NOT NULL,
    seed TEXT NOT NULL, PRIMARY KEY(agent_id, seg_no));`)
  // 空闲心跳的浮现队列：心跳只产候选，注入时最多取一条。
  // 故意不升 schema 号：沿用 proactive_decisions 的做法，在 openDb 里补建。
  db.exec(`CREATE TABLE IF NOT EXISTS surface_queue(
    id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, memory_id TEXT NOT NULL,
    reason TEXT, state TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL, expires_at TEXT);`)
  db.exec('CREATE INDEX IF NOT EXISTS idx_sq_agent ON surface_queue(agent_id, state, created_at)')
  // 三观引擎：只增账本 + 投影缓存。开关（sangguan.enabled）关闭时只是空表，不影响其他模块。
  try {
    ensureSangguanSchema(db)
  } catch (e) {
    console.warn('[sangguan] 建表跳过：', e && e.message)
  }
  // 一次性迁移：0~1 的 mood → -1~1 的 slow / total（已有记录不覆盖）
  try {
    const stamp = now()
    const ins = db.prepare('INSERT OR IGNORE INTO affect_v3(agent_id, baseline, slow, fast, total, slow_at) VALUES(?,0,?,0,?,?)')
    for (const r of db.prepare('SELECT agent_id, mood FROM affect_state').all()) {
      const v = Math.max(-1, Math.min(1, 2 * Number(r.mood || 0.5) - 1))
      ins.run(r.agent_id, v, v, stamp)
    }
  } catch { /* 老库没有 affect_state */ }
  // R05：冲突的悬置时间与“已罚过”标记（老冲突按当下回填）
  try { db.exec('ALTER TABLE conflicts ADD COLUMN opened_at TEXT') } catch { /* 已存在 */ }
  try { db.exec('ALTER TABLE conflicts ADD COLUMN penalized_at TEXT') } catch { /* 已存在 */ }
  // P3：冲突的可追溯字段（严重度 / 判定种类 / 来源轮次 / 依据 / 升级状态）
  for (const [col, spec] of [
    ['severity', "TEXT NOT NULL DEFAULT 'low'"],
    ['kind', 'TEXT'],
    ['source_turn_id', 'TEXT'],
    ['evidence', 'TEXT'],
    ['escalation_level', 'INTEGER NOT NULL DEFAULT 0'],
    ['escalated_at', 'TEXT'],
  ]) {
    try { db.exec(`ALTER TABLE conflicts ADD COLUMN ${col} ${spec}`) } catch { /* 已存在 */ }
  }
  try { db.prepare("UPDATE conflicts SET opened_at=? WHERE opened_at IS NULL").run(now()) } catch { /* 老库没有冲突表 */ }
  // 分层记忆：每条记忆自己的热度账本。旧库补列后默认是「中档」，refreshHeat() 会重算。
  for (const [col, spec] of [
    ['importance', 'REAL NOT NULL DEFAULT 0.5'],
    ['salience', 'REAL NOT NULL DEFAULT 0'],
    ['hits', 'INTEGER NOT NULL DEFAULT 0'],
    ['last_hit_at', 'TEXT'],
    ['heat', 'REAL NOT NULL DEFAULT 0.5'],
    ['band', "TEXT NOT NULL DEFAULT 'mid'"],
    ['confidence', 'REAL NOT NULL DEFAULT 0.8'],
    ['source_turn_id', 'TEXT'],
    ['fact_key', 'TEXT'],
    ['entity_id', 'TEXT'],
    // 写入侧检索卡：terms = 模型产的同义词 / 别名 / 可能问法，只做索引，不参与展示
    ['terms', 'TEXT'],
    // search_text = 原文 + key + terms，memory_fts 索引它；原文本身不动
    ['search_text', 'TEXT'],
    // 事实失效：同 fact_key 来了新说法时，旧那条 invalid_at=此刻、superseded_by=新 id。
    // 旧说法不删（回看还查得到），但默认召回不再带上它。
    ['superseded_by', 'TEXT'],
    // P5 温度状态机：hot / warm / cold / archived + 迟滞计数
    ['temp_state', "TEXT NOT NULL DEFAULT 'warm'"],
    ['state_since', 'TEXT'],
    ['state_streak', 'INTEGER NOT NULL DEFAULT 0'],
    // 情绪效价（-1 难受 ~ +1 舒服）：出生那一刻它自己的心情。
    // 召回时拿它和当前心情做「同向加成」——心情好更容易想起好事（mood-congruent recall）。
    ['valence', 'REAL NOT NULL DEFAULT 0'],
  ]) {
    try { db.exec(`ALTER TABLE memory_items ADD COLUMN ${col} ${spec}`) } catch { /* 已存在 */ }
  }
  // 旧 core/deep 分区标签下线：数据已无任何读取方，旧库直接把列摘掉（新库没有这列，失败即忽略）。
  try { db.exec('ALTER TABLE memory_items DROP COLUMN tier') } catch { /* 已不存在 / 老 SQLite 不支持 */ }
  try { db.exec('ALTER TABLE fact_archive DROP COLUMN tier') } catch { /* 已不存在 / 老 SQLite 不支持 */ }
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_mem_band ON memory_items(agent_id, band, heat DESC)') } catch { /* 索引失败不影响开库 */ }
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_mem_entity ON memory_items(agent_id, entity_id)') } catch { /* 索引失败不影响开库 */ }
  // 向量通道（P3）：一条记忆一行，vec 是 Float32Array 的字节。独立表，随时可删表回退。
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS memory_vec(
      memory_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, dim INTEGER NOT NULL,
      model TEXT NOT NULL, vec BLOB NOT NULL, at TEXT NOT NULL)`)
    db.exec('CREATE INDEX IF NOT EXISTS idx_vec_agent ON memory_vec(agent_id)')
  } catch { /* 建表失败只影响向量通道 */ }
  // 日记带上写作时的状态快照（口吻解释 / 前端联动展示）
  try { db.exec('ALTER TABLE diaries ADD COLUMN context TEXT') } catch { /* 已存在 */ }
  // 补写标记：写作时已经不是那一天了（关机 / 休眠错过 23:00，下次打开补的）
  try { db.exec('ALTER TABLE diaries ADD COLUMN late INTEGER NOT NULL DEFAULT 0') } catch { /* 已存在 */ }
  // 主动开口的结局追踪：回答 / 被忽略 / 回答时间
  try { db.exec('ALTER TABLE proactive ADD COLUMN answered INTEGER NOT NULL DEFAULT 0') } catch { /* 已存在 */ }
  try { db.exec('ALTER TABLE proactive ADD COLUMN ignored INTEGER NOT NULL DEFAULT 0') } catch { /* 已存在 */ }
  try { db.exec('ALTER TABLE proactive ADD COLUMN answered_at TEXT') } catch { /* 已存在 */ }
  // schema 12：会话绑定要能记住「谁改的、什么时候松的」；老库这里补列。
  for (const [col, spec] of [
    ['state', "TEXT NOT NULL DEFAULT 'bound'"], ['source', "TEXT NOT NULL DEFAULT 'auto'"],
    ['bound_at', 'TEXT'], ['last_seen_at', 'TEXT'], ['released_at', 'TEXT'], ['released_by', 'TEXT'],
  ]) {
    try { db.exec(`ALTER TABLE bindings ADD COLUMN ${col} ${spec}`) } catch { /* 已存在 */ }
  }
  // 老库里「bindings」早就被写过（10 月底的老功能），补列时 state 的默认值会把它们
  // 一起标成 bound——那等于凭空多出几段"正在挂"的对话。没有 bound_at 的就是老行，一律松开。
  try { db.exec("UPDATE bindings SET state='released', released_by='legacy' WHERE bound_at IS NULL AND state='bound'") } catch { /* 老库没这表 */ }
  // schema 12：在场状态与心跳时间直接挂到 agents 上，界面一次查询就能出全表。
  for (const [col, spec] of [
    ['runtime_state', "TEXT NOT NULL DEFAULT 'idle'"],
    ['last_seen_at', 'TEXT'],
    ['last_heartbeat_at', 'TEXT'],
  ]) {
    try { db.exec(`ALTER TABLE agents ADD COLUMN ${col} ${spec}`) } catch { /* 已存在 */ }
  }
  // schema 12：心跳分两档（零模型的 light / 可能调模型的 deep），各走各的到期时间
  for (const [col, spec] of [
    ['deep_at', 'INTEGER'],
    ['deep_ms', 'INTEGER NOT NULL DEFAULT 900000'],
  ]) {
    try { db.exec(`ALTER TABLE heartbeats ADD COLUMN ${col} ${spec}`) } catch { /* 已存在 */ }
  }
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS proactive_stats(
      agent_id TEXT NOT NULL, dim TEXT NOT NULL,
      sent INTEGER NOT NULL DEFAULT 0, answered INTEGER NOT NULL DEFAULT 0, ignored INTEGER NOT NULL DEFAULT 0,
      last_sent_at TEXT, cooldown_until TEXT, PRIMARY KEY(agent_id, dim))`)
  } catch { /* 已存在 */ }
  // 每次「该不该说」的决策都留一条：门槛结论、收益/成本、引用了哪条记忆。
  // 只做解释，不做审批；连续同样的沉默判断合并成一条（repeats 计数）。
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS proactive_decisions(
      id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, at TEXT NOT NULL,
      will INTEGER NOT NULL DEFAULT 0, reason TEXT NOT NULL, dim TEXT,
      source TEXT, text TEXT, benefit REAL, cost REAL,
      gates TEXT, chain TEXT, repeats INTEGER NOT NULL DEFAULT 1)`)
    db.exec('CREATE INDEX IF NOT EXISTS idx_pdec_agent ON proactive_decisions(agent_id, at DESC)')
  } catch { /* 已存在 */ }
  // 议程已降级为内部调度：老库里的表直接清掉（数据已无消费方）
  try { db.exec('DROP TABLE IF EXISTS agenda') } catch { /* ignore */ }
  // 指标键改名：议程没了，回应率归到主动开口名下（历史样本跟着搬）
  try { db.exec("UPDATE metric_samples SET key='drive.proactive_answer' WHERE key='drive.agenda_accept'") } catch { /* 老库没有指标表 */ }
  // 4 号文档 v2：性格五轴。big5.* → axis.*；neuroticism → sensitivity。
  // 幂等：只改 path，不动 value / origin；跑两次不出错。
  try {
    const map = [
      ['big5.extraversion', 'axis.ei'],
      ['big5.openness', 'axis.sn'],
      ['big5.agreeableness', 'axis.tf'],
      ['big5.conscientiousness', 'axis.jp'],
      ['big5.neuroticism', 'axis.sensitivity'],
    ]
    const upd = db.prepare('UPDATE persona SET path=? WHERE path=? AND agent_id=? AND NOT EXISTS (SELECT 1 FROM persona p2 WHERE p2.agent_id=persona.agent_id AND p2.path=?)')
    const agents = db.prepare("SELECT DISTINCT agent_id FROM persona WHERE path LIKE 'big5.%'").all()
    for (const a of agents) for (const [from, to] of map) upd.run(to, from, a.agent_id, to)
    db.prepare("DELETE FROM persona WHERE path LIKE 'big5.%'").run()
  } catch (e) {
    console.warn('[persona] big5 → axis 迁移跳过：', e && e.message)
  }
  // 出生初值调整：E/I 从 0.50 → 0.60（其余仍 0.50）。
  // 只碰「从没漂过」的 auto 0.5，不覆盖有经历痕迹的实例；跑多次幂等。
  try {
    db.prepare(`UPDATE persona SET value='0.6' WHERE path='axis.ei' AND value='0.5' AND origin='auto'
      AND NOT EXISTS (SELECT 1 FROM changes WHERE agent_id=persona.agent_id AND field='persona.axis.ei')`).run()
  } catch (e) {
    console.warn('[persona] E/I 初值调整跳过：', e && e.message)
  }
  // 情绪敏感度初值：0.50 → 0.80（偏高，让底色摆幅和小事门槛一眼看得出差别）。
  // 同样只碰从没漂过、也没有手调记录的 auto 0.5；跑多次幂等。
  try {
    db.prepare(`UPDATE persona SET value='0.8' WHERE path='axis.sensitivity' AND value='0.5' AND origin='auto'
      AND NOT EXISTS (SELECT 1 FROM changes WHERE agent_id=persona.agent_id AND field='persona.axis.sensitivity')`).run()
  } catch (e) {
    console.warn('[persona] 敏感度初值调整跳过：', e && e.message)
  }
  // 敏感度退役成「手动挡」：它只有「被刺→更敏感」一条正向通路、没有反向证据，自动挡下必然一路爬。
  // 老实例的 origin 还是 auto，这里统一收成 manual，界面上才不会写着「自动」却一直不动。
  try {
    db.prepare("UPDATE persona SET origin='manual' WHERE path='axis.sensitivity' AND origin='auto'").run()
  } catch (e) {
    console.warn('[persona] 敏感度改手动挡跳过：', e && e.message)
  }
  // 关系动力学 v1：习惯化计数（同一个人、同一类事反复来 → 冲击递减）。
  // 只存计数，不存结论；结论在 rel_person 三轴上，随时可从账本重放。
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS rel_habit(
      agent_id TEXT NOT NULL, person_id TEXT NOT NULL, key TEXT NOT NULL,
      n REAL NOT NULL DEFAULT 0, at TEXT, PRIMARY KEY(agent_id, person_id, key))`)
  } catch { /* 习惯化表失败只影响递减，不影响关系本体 */ }
  // 伤害留痕：重伤害 / 越界时记「受伤前的信任」，修复只能回到它的 90%（9 号 §5.3）
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS rel_violation(
      agent_id TEXT NOT NULL, person_id TEXT NOT NULL,
      ceiling REAL NOT NULL, at TEXT NOT NULL, PRIMARY KEY(agent_id, person_id))`)
  } catch { /* 留痕表失败只影响修复封顶 */ }
  // 性格五轴的「证据账本」：每轮先把发生的事记成一条证据，
  // 同向证据攒够密度才推动轴（Whole Trait Theory 的状态→特质）。
  // used=1 表示这条证据已经参与过一次漂移，留痕不删。
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS axis_evidence(
      id TEXT PRIMARY KEY, agent_id TEXT NOT NULL,
      axis TEXT NOT NULL, dir INTEGER NOT NULL,
      strength REAL NOT NULL DEFAULT 0.5, source TEXT NOT NULL,
      ref_id TEXT, at TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0)`)
    db.exec('CREATE INDEX IF NOT EXISTS idx_axev ON axis_evidence(agent_id, axis, at DESC, used)')
  } catch { /* 证据表失败只影响轴漂移，不影响主流程 */ }
  // 性格四轴「拔河」：左右各一个拉力池，证据只进池，池子明显偏了才推轴（v2）。
  // src 存「按来源分桶」的原始力气（JSON）：flush 时先按来源算净力、再乘各来源权重——
  // 不这样的话 reply 一天几百条会把 user_style(1.2) / 情绪(0.25) 这些权重全淹掉。
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS axis_rope(
      agent_id TEXT NOT NULL, axis TEXT NOT NULL,
      pos REAL NOT NULL DEFAULT 0, pos_n INTEGER NOT NULL DEFAULT 0, pos_s REAL NOT NULL DEFAULT 0,
      neg REAL NOT NULL DEFAULT 0, neg_n INTEGER NOT NULL DEFAULT 0, neg_s REAL NOT NULL DEFAULT 0,
      base REAL NOT NULL DEFAULT 0.5,
      at TEXT NOT NULL, base_at TEXT, src TEXT,
      PRIMARY KEY(agent_id, axis))`)
    try { db.exec('ALTER TABLE axis_rope ADD COLUMN src TEXT') } catch { /* 已存在 */ }
  } catch { /* 拉力池表失败时退回旧逻辑（flush 会自己判断） */ }
  // 性格证据的「第二判」队列：词表拿不准的那一轮先排队，夜间交给模型判，
  // 判出来的结果还要过一遍原文核对（quote 必须在她的回复里逐字出现）。
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS persona_judge(
      id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, turn_id TEXT,
      user_text TEXT, reply_text TEXT, at TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending', reason TEXT,
      verdict TEXT, attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL)`)
    db.exec('CREATE INDEX IF NOT EXISTS idx_pjudge ON persona_judge(agent_id, state, at DESC)')
    // refs：这一轮词表已经下了哪几条弱证据（JSON 数组）；模型不认就把它们撤掉
    try { db.exec('ALTER TABLE persona_judge ADD COLUMN refs TEXT') } catch { /* 已存在 */ }
  } catch { /* 判定队列失败只影响第二判 */ }
  // 每周情境探针：只做校准，不进拉力池
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS persona_probe(
      agent_id TEXT NOT NULL, week TEXT NOT NULL, at TEXT NOT NULL,
      n INTEGER NOT NULL DEFAULT 0, counts TEXT, agree REAL,
      PRIMARY KEY(agent_id, week))`)
  } catch { /* 探针表失败不影响判定 */ }
  try {
    const cols = db.prepare('PRAGMA table_info(axis_evidence)').all().map((c) => String(c.name))
    if (!cols.includes('pole')) db.exec('ALTER TABLE axis_evidence ADD COLUMN pole TEXT')
    if (!cols.includes('w')) db.exec('ALTER TABLE axis_evidence ADD COLUMN w REAL')
    // 为什么算这条证据（人话），界面/排查要看，不然只有数字没法问「凭什么」
    if (!cols.includes('why')) db.exec('ALTER TABLE axis_evidence ADD COLUMN why TEXT')
    // 弱证据（靠长度、靠单个数字这类）打标记：复核时模型不认就撤票
    if (!cols.includes('weak')) db.exec('ALTER TABLE axis_evidence ADD COLUMN weak INTEGER DEFAULT 0')
  } catch { /* 老库补列失败不影响写入（写入时会再试） */ }
  const row = db.prepare('SELECT version FROM schema_meta').get()
  // schema 13：外部会话账（conversations）+ chat_turns.conversation_id；只加表加列，不动旧数据
  if (!row) db.prepare('INSERT INTO schema_meta(version) VALUES(13)').run()
  else db.prepare('UPDATE schema_meta SET version=13').run()
  return db
}

export function journalIntent(db, agentId, op, payload, turnId = null) {
  const r = db.prepare("INSERT INTO journal(agent_id,turn_id,op,payload,state,created_at) VALUES(?,?,?,?,'intent',?)")
    .run(agentId, turnId, op, JSON.stringify(payload), now())
  return Number(r.lastInsertRowid)
}

export function journalDone(db, seq) {
  db.prepare("UPDATE journal SET state='done' WHERE seq=?").run(seq)
}

export function recover(db) {
  const rows = db.prepare("SELECT * FROM journal WHERE state='intent' ORDER BY seq").all()
  let n = 0
  for (const r of rows) {
    try {
      const p = JSON.parse(r.payload)
      if (r.op === 'insert_memory' && p.memory_id) {
        db.prepare('DELETE FROM memory_items WHERE id=?').run(p.memory_id)
        db.prepare('DELETE FROM memory_fts WHERE id=?').run(p.memory_id)
      }
    } catch { /* 损坏的 intent 直接标记回滚 */ }
    db.prepare("UPDATE journal SET state='rolled_back' WHERE seq=?").run(r.seq)
    n++
  }
  return n
}
