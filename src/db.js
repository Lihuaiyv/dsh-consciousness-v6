import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ensureSangguanSchema } from './modules/sangguan/schema.js'
import { RECOVERED_TABLES, RECOVERED_REST } from './schema_recovered.js'

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

-- 模型窄门判定缓存（记忆时态）：同一对记忆只判一次。
-- 只加表、不 ALTER 老表；verdict 取 supersede / supplement / unrelated / uncertain。
-- reason 与 model 留着，是事后抽查准确率（90% 这个数）的唯一凭据。
CREATE TABLE IF NOT EXISTS memory_pair_judge(
  pair_key TEXT PRIMARY KEY, agent_id TEXT NOT NULL,
  old_id TEXT NOT NULL, new_id TEXT NOT NULL,
  verdict TEXT NOT NULL, confidence REAL, model TEXT, reason TEXT,
  judged_at TEXT NOT NULL, via TEXT NOT NULL, applied INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS idx_pair_judge_agent ON memory_pair_judge(agent_id, judged_at DESC);
CREATE INDEX IF NOT EXISTS idx_pair_judge_verdict ON memory_pair_judge(agent_id, verdict);

-- 断言状态（记忆时态 v3）：这条记忆说的「还没做 / 做完了」，现在还算不算。
-- 只加新表、不 ALTER 老表；state 取 pending / done / stale / na。
-- 只有 pending/done/stale 才写行，na 不写——别把整库记忆都扫成一行。
CREATE TABLE IF NOT EXISTS memory_claims(
  memory_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL,
  claim_key TEXT, state TEXT NOT NULL, since TEXT NOT NULL,
  evidence_id TEXT, checked_at TEXT, via TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_claims_agent_state ON memory_claims(agent_id, state);

-- 署名（记忆归属）：这条记忆里的话，到底是谁说的。
-- 为什么要单独一张表：memory_items 已定型，按项目规矩只加新表、不 ALTER 老表。
-- speaker：me=我说的 / user=对方说的 / both=两边都有 / unknown=没标（老条目）。
-- quote：支撑这条的最短原话（逐字），读的时候能回到现场；没有就空。
-- inferred：1 = 原文没直说，是我推出来的；0 = 原文里有据。不许把推断冒充原话。
CREATE TABLE IF NOT EXISTS memory_provenance(
  memory_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL,
  speaker TEXT NOT NULL DEFAULT 'unknown', quote TEXT,
  inferred INTEGER NOT NULL DEFAULT 0, turn_id TEXT,
  via TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_mem_prov_agent ON memory_provenance(agent_id, speaker);

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
-- persona_values（旧十维价值观表）已拆：新库不建，老库在 openDb 里 DROP。
-- 世界观 / 人生观仍是独立的仪表，各自一张表（以前只在老库里手工建过，新库缺表会崩）。
CREATE TABLE IF NOT EXISTS persona_worldview(
  agent_id TEXT NOT NULL, key TEXT NOT NULL, weight REAL NOT NULL DEFAULT 0.5, evidence TEXT,
  updated_at TEXT NOT NULL, PRIMARY KEY(agent_id, key));
CREATE TABLE IF NOT EXISTS persona_lifeview(
  agent_id TEXT NOT NULL, key TEXT NOT NULL, weight REAL NOT NULL DEFAULT 0.5, evidence TEXT,
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
  pack TEXT, mood TEXT, created_at TEXT NOT NULL, conversation_id TEXT, turn_id TEXT);
CREATE INDEX IF NOT EXISTS idx_chat_agent ON chat_turns(agent_id, created_at);
-- 按会话取「这一段的上一句」：串会话修好之后，presence / 短句上下文 / 收尾倾向都按 conversation_id 查，别再全表扫。
CREATE INDEX IF NOT EXISTS idx_chat_conv ON chat_turns(agent_id, conversation_id, created_at);
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
  other_label TEXT, source TEXT NOT NULL DEFAULT 'model', created_at TEXT NOT NULL, feel_id TEXT);
CREATE INDEX IF NOT EXISTS idx_thoughts_agent ON thoughts(agent_id, created_at DESC);
CREATE TABLE IF NOT EXISTS persona_views(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, text TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'rules', facts TEXT, sources TEXT,
  prompt_chars INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_pview_agent ON persona_views(agent_id, created_at DESC);

-- ================= 分层记忆 T1–T4 =================
-- T4 原文层 / 碎片层（冷）：一轮一行，只追加，永不改写。平时的召回**不碰**这张表。
-- 2026-11-12：raw_turns 改名为 fragments，并加 form / snapshot / antecedents 三列。
CREATE TABLE IF NOT EXISTS fragments(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, session_id TEXT NOT NULL,
  turn_id TEXT, seq INTEGER NOT NULL DEFAULT 0, role TEXT NOT NULL,
  text TEXT NOT NULL, tool TEXT, meta TEXT,
  created_at TEXT NOT NULL, day TEXT NOT NULL,
  form TEXT NOT NULL DEFAULT 'text', snapshot TEXT, antecedents TEXT);
CREATE VIRTUAL TABLE IF NOT EXISTS raw_fts USING fts5(id UNINDEXED, text, tokenize='trigram');

-- ================= 事件层（2026-11-12 新增） =================
-- **2026-11-17：已冻结。** 新的切事件走 events_v2（下面紧挨着那张表），
-- 冻结期间 flags.events.cut.enabled=off，切事 worker 不跑、写入器 writeColdEvents 直接返回。
-- cold_events / hot_events / event_edges 三张表只读不写，数据保留给读口和想头用。
-- 设计见 docs/功能/2-记忆-写与切事/切事件-基石/基石-切事件-2026-11-17.md
-- 冷库：夜里第一刀切出来的事。只追加，永不改；补切就追加新的，旧的一个字不动。
CREATE TABLE IF NOT EXISTS cold_events(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL,
  title TEXT NOT NULL, story TEXT NOT NULL, who TEXT,
  start_at TEXT NOT NULL, end_at TEXT NOT NULL,
  turn_ids TEXT NOT NULL,        -- JSON 数组：这件事覆盖的轮次，首尾都在
  quotes TEXT NOT NULL,          -- JSON 数组：原文里一字不差的句子
  cues TEXT,                     -- JSON 数组：出生时的抓手词（切事时顺手给；热库可以改）
  status TEXT,                   -- 切出来那一刻的过没过
  weight REAL NOT NULL DEFAULT 0.5,
  cut_rev INTEGER NOT NULL DEFAULT 1,   -- 这一段第几次切（补切递增）
  created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_cold_events_agent ON cold_events(agent_id, start_at);

-- 事件库 v2（2026-11-17，ES-Mem 路线）：**影子表，第一版只写不读**。
-- 唯一入口 docs/功能/2-记忆-写与切事/切事件-基石/基石-切事件-2026-11-17.md。
-- 和老表完全隔离：不共用 id、不改 cold_events / hot_events / event_edges 一行；
-- 旧切法已冻结（flags.events.cut.enabled=off），新写入器接上之前这张表一直是空的。
-- 列的取舍按读处反推：boundary/boundary_kind 是检索锚（Level 1），title/summary 是 Level 2，
-- 原文永远留在 fragments（Level 3），这里不存原文。
CREATE TABLE IF NOT EXISTS events_v2(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL,
  day TEXT NOT NULL,                              -- 本地日 YYYY-MM-DD（不是 UTC 的 day 列）
  start_at TEXT NOT NULL, end_at TEXT NOT NULL,   -- UTC ISO，首末碎片时间
  turn_ids TEXT NOT NULL,                         -- JSON 数组，来源碎片
  session_id TEXT,                                -- 2026-11-19：件属于哪条会话线（一天几条会话并行，读口按它分开看）
  boundary TEXT,                                  -- Level 1：从什么转到什么，一句话
  boundary_kind TEXT,                             -- Stage 2 标签：Topic_Shift / Topic_Intro / Detail_Elaborate / Direct_Resp
  boundary_conf REAL,                             -- 边界那句有多确定
  thread TEXT,                                    -- 线索：这段里一直没变的那个目标/主题（≤14字）
  kind TEXT,                                      -- 命运：变 / 成 / 卡 / 破（判定顺序见基石 §3.4）
  edge TEXT,                                      -- 边界怎么断的：time / causal
  edge_why TEXT,                                  -- causal 时写一句为什么断；time 时留空
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
  created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_ev2_agent ON events_v2(agent_id, day, start_at);

-- 事件有哪些碎片：权威索引（events_v2.turn_ids 只是副本，对账以这张为准）。
-- 成员由代码按「边界之间的连续区间」填，不交给模型挑——这样才保证全覆盖、无重叠。
CREATE TABLE IF NOT EXISTS event_members(
  event_id TEXT NOT NULL, fragment_id TEXT NOT NULL,
  agent_id TEXT NOT NULL, day TEXT NOT NULL,
  PRIMARY KEY (event_id, fragment_id));
CREATE INDEX IF NOT EXISTS idx_evm_frag ON event_members(fragment_id);
CREATE INDEX IF NOT EXISTS idx_evm_ev ON event_members(event_id);

-- 热库：当前在用的那一版。可合并/拆分/改名/沉底，每变一次出新版，旧版 active=0 留档。
CREATE TABLE IF NOT EXISTS hot_events(
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
  last_mention_at TEXT, last_surface_at TEXT, ticked_at TEXT,
  created_at TEXT NOT NULL, changed_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_hot_events_agent ON hot_events(agent_id, active, state);

-- 大因果体 · 事件之间的边（2026-11-16 按 docs/功能/1-记忆-读与联想/思路-大因果体检索-2026-11-14.md §4.3 / §9.1 重做）。
-- 红线：**只加边，绝不合并事件**。hot_events 一行不改；边只说明「这两件之间有什么」。
-- 存的时候只有一条关系：pull（−1~+1，符号是方向，绝对值是凝聚度）+ direction + level + 证据 + 状态。
-- kind 只是解释标签，不参与遍历——判的时候可以细，存的时候不按类型分表，不然越分越乱。
CREATE TABLE IF NOT EXISTS event_edges(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL,
  from_id TEXT NOT NULL,                 -- hot_events.id
  to_id TEXT NOT NULL,                   -- hot_events.id
  kind TEXT NOT NULL,                    -- 解释标签：same_as/adjacent/continue/cause/enable/prevent/revise/resolve/contradict/bridge
  direction TEXT NOT NULL DEFAULT 'forward',   -- forward / backward / both
  pull REAL NOT NULL DEFAULT 0.5,        -- −1~+1：|pull| 凝聚度，符号是方向（负=否定/转折）
  level INTEGER NOT NULL DEFAULT 0,      -- 0 事件 / 1 线·体 / 2 项目·阶段 / 3 人生·世界
  confidence REAL NOT NULL DEFAULT 0.5,  -- 判的置信度；confirmed 要 ≥0.7
  evidence TEXT,                         -- 一字不差的引文；抄不出就没有 confirmed
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'candidate',   -- candidate / confirmed / weak / rejected
  resolution TEXT,                       -- 冲突的三种结局：sublated（合成第三件）/ suspended（悬着）/ invalidated（记错了才用）
  judge TEXT,                            -- rule / local / main
  valid_from TEXT, valid_to TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);

-- T2 纪要层（温）：一次会话 / 一天的压缩，日记的原料。
CREATE TABLE IF NOT EXISTS episodes(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, session_id TEXT, day TEXT NOT NULL,
  start_at TEXT, end_at TEXT, turns INTEGER NOT NULL DEFAULT 0,
  title TEXT, summary TEXT, topics TEXT, mood TEXT, open_loops TEXT,
  importance REAL NOT NULL DEFAULT 0.5, hits INTEGER NOT NULL DEFAULT 0,
  last_hit_at TEXT, source TEXT NOT NULL DEFAULT 'rules', created_at TEXT NOT NULL,
  -- 日记 v2：这件事有多「扎心」（0–10）。选场用，算一次存下来；null = 没算过。
  poignancy REAL, feel_id TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ep_uniq ON episodes(agent_id, session_id, day);

-- T3 日记层（温偏冷）：一天一篇，第一人称，可重建不覆盖。
CREATE TABLE IF NOT EXISTS diaries(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, day TEXT NOT NULL,
  text TEXT NOT NULL, mood TEXT, highlights TEXT, refs TEXT,
  source TEXT NOT NULL DEFAULT 'rules', version INTEGER NOT NULL DEFAULT 1,
  late INTEGER NOT NULL DEFAULT 0, feel_ids TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS idx_diary_day ON diaries(agent_id, day);
-- 写这篇日记时的「它是什么状态」：人格 / 价值观 / 情绪 / 驱力 / 关系，用来解释口吻
-- 旧库用 ALTER 补列（见 openDb）。

-- 日记 v2 待补队列：模型没接上 / 成文没过质检的日子在这里排队。
-- 「有 diaries 行」不再等于「这天写完了」；只有 source='model' 才是写完。
CREATE TABLE IF NOT EXISTS diary_pending(
  agent_id TEXT NOT NULL, day TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT, next_try_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY(agent_id, day));

-- T4 事实存根（append-only）：一条事实「最初生成时」的原样快照。
-- memory_items 里那条会衰减、被推翻、被去重合并、被删；这里留底，回答「我当初记的是哪句话」。
-- 只有「明确硬删」（软删满 7 天的清理）才会连存根一起清。
CREATE TABLE IF NOT EXISTS fact_archive(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, memory_id TEXT NOT NULL,
  text TEXT NOT NULL, type TEXT, mark TEXT,
  importance REAL, salience REAL, confidence REAL,
  fact_key TEXT, source_turn_id TEXT, source TEXT NOT NULL DEFAULT 'model',
  payload TEXT, created_at TEXT NOT NULL, feel_id TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS idx_fa_mem ON fact_archive(agent_id, memory_id);
CREATE INDEX IF NOT EXISTS idx_fa_agent ON fact_archive(agent_id, created_at DESC);
CREATE VIRTUAL TABLE IF NOT EXISTS fact_fts USING fts5(id UNINDEXED, text, tokenize='trigram');

-- G1 时效索引（只追加、无正文）：每条记忆「何时出生 / 改写 / 作废 / 复活 / 有争议 / 被隐藏」。
-- 正文永远从 fact_archive / fragments 取；这里只定位时间。写失败静默，漏记由夜巡对账补 SYNC。
-- 只允许三处删行：单条硬删、意识体整删、journal 回滚。
CREATE TABLE IF NOT EXISTS memory_timeline(
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id   TEXT NOT NULL,
  memory_id  TEXT NOT NULL,
  op         TEXT NOT NULL,
  at         TEXT NOT NULL,
  valid_from TEXT,
  reason     TEXT,
  cause_id   TEXT,
  text_ref   TEXT,
  actor      TEXT,
  approx     INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS idx_tl_mem ON memory_timeline(agent_id, memory_id, seq);
CREATE INDEX IF NOT EXISTS idx_tl_at ON memory_timeline(agent_id, at);

-- 检索回放日志：每次召回一行，用来调阈值（scene / 候选数 / 过门数 / 注入量 / 耗时）。
-- 只用于观测，不进任何召回路径；默认留 30 天。
CREATE TABLE IF NOT EXISTS retrieval_log(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, at TEXT NOT NULL,
  scene TEXT NOT NULL, query TEXT NOT NULL DEFAULT '', why TEXT,
  counts TEXT, kept TEXT, dropped TEXT,
  items INTEGER NOT NULL DEFAULT 0, tokens INTEGER NOT NULL DEFAULT 0, ms INTEGER);
CREATE INDEX IF NOT EXISTS idx_rlog_agent ON retrieval_log(agent_id, at DESC);

-- ================= 记忆汇流（confluence）=================
-- 三张留底 + 一条「这次想起」。全部只追加；遗忘（HIDE/DELETE）时一起清。
-- 为什么要「冻」而不是「算」：状态=算出来的，事后重算会掺进后来（衰减/覆盖/合并/改口）；
-- 冻下来的才是当时的。events 记「为什么变」，这三张记「当时是什么」「当时摆着什么」。
-- state_scene 两级：tier=light 每轮一行（记脉搏），tier=heavy 每 20 轮一行（拍照片）。
CREATE TABLE IF NOT EXISTS state_scene(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, at TEXT NOT NULL,
  session_id TEXT, episode_id TEXT, turn_id TEXT,
  tier TEXT NOT NULL DEFAULT 'light',
  affect_json TEXT, drive_json TEXT, relation_json TEXT, persona_json TEXT,
  life_json TEXT, loops_json TEXT, voice_json TEXT, params_hash TEXT,
  source TEXT NOT NULL DEFAULT 'auto', created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_state_scene_at ON state_scene(agent_id, tier, at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_state_scene_turn ON state_scene(agent_id, turn_id, tier);

-- 拼好的注入块原文（渲染后）。老账补不了，从建成那天起才精确；L2 才靠它。
CREATE TABLE IF NOT EXISTS scene_archive(
  turn_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, at TEXT NOT NULL,
  session_id TEXT, episode_id TEXT,
  block TEXT NOT NULL, block_hash TEXT NOT NULL,
  state_ref TEXT, bytes INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_scene_archive_at ON scene_archive(agent_id, at DESC);

-- 每次汇流的审计账：锚点、档位、bundle 指纹、说了什么、有没有被接住、后来回看过没有。
CREATE TABLE IF NOT EXISTS confluence_log(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, at TEXT NOT NULL,
  anchor_turn TEXT, anchor_episode TEXT, level TEXT NOT NULL DEFAULT 'L1',
  bundle_hash TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'manual',
  spoken TEXT, adopted INTEGER NOT NULL DEFAULT 0, looked_back_at TEXT,
  dropped TEXT, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_confluence_at ON confluence_log(agent_id, at DESC);

-- 「这次想起」：新记录，不是旧条的修改。
-- 为什么不并进 memory_items：它一旦进日常召回，就会变成「我想起我想起过」的环。
-- 只在「问起过去」时当证据用；不进 memory_fts、不 touch 任何旧条。
CREATE TABLE IF NOT EXISTS revisit(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, at TEXT NOT NULL,
  anchor_turn TEXT, memory_ids TEXT, mood TEXT, note TEXT,
  source TEXT NOT NULL DEFAULT 'confluence', created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_revisit_at ON revisit(agent_id, at DESC);


-- 开环：还没闭合的事（答应过的 / 要提醒的 / 没做完的）。
-- 它不参与召回打分，也不受相关度门控：到期或久未提及，就自己浮上来一条。
CREATE TABLE IF NOT EXISTS open_loops(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'task', text TEXT NOT NULL,
  memory_id TEXT, source_turn_id TEXT,
  due_at TEXT, stale_after TEXT,
  state TEXT NOT NULL DEFAULT 'open',
  fired_at TEXT, fire_count INTEGER NOT NULL DEFAULT 0,
  closed_at TEXT, closed_by TEXT, feel_id TEXT, important INTEGER NOT NULL DEFAULT 0,
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
  created_at  TEXT NOT NULL,
  feel_id     TEXT
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
  // 2026-11-12：老库的原文表先改名成碎片表，再跑 SCHEMA。
  // 顺序不能反：SCHEMA 里会 CREATE TABLE IF NOT EXISTS fragments，先跑就会建一张空表，改名就撞上了。
  try { db.exec('ALTER TABLE raw_turns RENAME TO fragments') } catch { /* 已迁或新库 */ }
  db.exec(SCHEMA)
  db.exec(EXT)
  db.exec(REL)
  db.exec(ACTION)
  /* 2026-11-22：真库里有几张表不在主 schema 里（affair_rows / live_events / canvas_doc /
     change_reasons），新库靠这份从真库导出的补丁建出来；已有的表 CREATE 是空操作，
     缺列的索引/触发器单条失败就跳，不拖死开库。改主 schema 时两边一起改。 */
  for (const s of RECOVERED_TABLES) { try { db.exec(s) } catch { /* 单表失败不拖死开库 */ } }
  for (const s of RECOVERED_REST) { try { db.exec(s) } catch { /* 缺列的索引/触发器跳过 */ } }
  // 老库改名后补三列；新库建表时已有，这里是空操作。
  try { db.exec("ALTER TABLE fragments ADD COLUMN form TEXT NOT NULL DEFAULT 'text'") } catch { /* 已存在 */ }
  try { db.exec('ALTER TABLE fragments ADD COLUMN snapshot TEXT') } catch { /* 已存在 */ }
  try { db.exec('ALTER TABLE fragments ADD COLUMN antecedents TEXT') } catch { /* 已存在 */ }
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_raw_agent_day ON fragments(agent_id, day, seq)') } catch { /* 老库异常不影响启动 */ }
  // 2026-11-12：事件冷库先建过一版没 cues，这里补上（出生时的抓手词）。
  try { db.exec('ALTER TABLE cold_events ADD COLUMN cues TEXT') } catch { /* 已存在或表还没建 */ }
  // 2026-11-13：事件质量标记（model / local / lexical / local_fallback）
  try { db.exec("ALTER TABLE cold_events ADD COLUMN quality TEXT NOT NULL DEFAULT 'model'") } catch { /* 已存在或表还没建 */ }
  try { db.exec("ALTER TABLE hot_events ADD COLUMN quality TEXT NOT NULL DEFAULT 'model'") } catch { /* 已存在或表还没建 */ }
  // 想头推进要知道「上次推到哪儿」，不然关机一夜就不知道补多久。
  try { db.exec('ALTER TABLE hot_events ADD COLUMN ticked_at TEXT') } catch { /* 已存在 */ }
  // 大因果体：老库补列（2026-11-16 按设计文档把「软链」改成一条带符号的关系 pull）。
  for (const ddl of [
    "ALTER TABLE event_edges ADD COLUMN direction TEXT NOT NULL DEFAULT 'forward'",
    'ALTER TABLE event_edges ADD COLUMN pull REAL NOT NULL DEFAULT 0.5',
    'ALTER TABLE event_edges ADD COLUMN level INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE event_edges ADD COLUMN confidence REAL NOT NULL DEFAULT 0.5',
    'ALTER TABLE event_edges ADD COLUMN reason TEXT',
    'ALTER TABLE event_edges ADD COLUMN resolution TEXT',
    "ALTER TABLE event_edges ADD COLUMN status TEXT NOT NULL DEFAULT 'candidate'",
    'ALTER TABLE event_edges ADD COLUMN judge TEXT',
    'ALTER TABLE event_edges ADD COLUMN valid_from TEXT',
    'ALTER TABLE event_edges ADD COLUMN valid_to TEXT',
    'ALTER TABLE event_edges ADD COLUMN updated_at TEXT',
  ]) { try { db.exec(ddl) } catch { /* 已存在或表还没建 */ } }
  // 上午那版按 kind 分边的实验数据：标 rejected 并且**封口**（valid_to 填上），不参与检索。
  // 封口很重要：唯一索引只认 valid_to IS NULL 的活边，不封口会占着位置把新边挡掉。
  // 判据用 judge IS NULL——上午那版没有 judge 列；新版边都写 judge='rule'。
  try {
    db.exec("UPDATE event_edges SET status='rejected', valid_to=COALESCE(valid_to, created_at), reason='旧版按 kind 分边的实验数据，2026-11-16 按设计文档重做' WHERE judge IS NULL AND status<>'rejected'")
  } catch { /* 老表没这些列就跳过 */ }
  // 老的唯一键换成「同一对同一类，只留一条活边」。
  try { db.exec('DROP INDEX IF EXISTS idx_event_edges_uniq') } catch { /* 没有就算了 */ }
  try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS uq_event_edges ON event_edges(agent_id, from_id, to_id, kind) WHERE valid_to IS NULL') } catch { /* 已存在 */ }
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_event_edges_from ON event_edges(agent_id, from_id, status)') } catch { /* 已存在 */ }
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_event_edges_to ON event_edges(agent_id, to_id, status)') } catch { /* 已存在 */ }
  // 2026-11-19：件带会话列——同一天几条会话并行，读口要能按会话分开（只加列，不动 id）
  try { db.exec('ALTER TABLE events_v2 ADD COLUMN session_id TEXT') } catch { /* 已存在或表还没建 */ }
  // 2026-11-22：真库那张 events_v2 是老版导出的，这几列它没有——不补上，写入器会静默失败。
  for (const c of ['thread TEXT', 'kind TEXT', 'edge TEXT', 'edge_why TEXT']) {
    try { db.exec(`ALTER TABLE events_v2 ADD COLUMN ${c}`) } catch { /* 已存在或表还没建 */ }
  }
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_raw_session ON fragments(session_id, seq)') } catch { /* 老库异常不影响启动 */ }
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
  // 2026-11-13（P1c）：补血缘列——新写入带上轮次号；老行留 NULL=明确「无链」，不猜。
  try { db.exec('ALTER TABLE chat_turns ADD COLUMN turn_id TEXT') } catch { /* 已存在 */ }
  // 2026-11-13（B2）：这一轮是「工作」还是「日常」。切事要按它分两个标准；
  // 老行留 NULL = 明确没标签，按日常处理（不猜）。
  try { db.exec('ALTER TABLE chat_turns ADD COLUMN mode TEXT') } catch { /* 已存在 */ }
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_chat_turn ON chat_turns(agent_id, turn_id)') } catch { /* 老库异常不影响启动 */ }
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_chat_conv ON chat_turns(agent_id, conversation_id, created_at)') } catch { /* 老库异常不影响启动 */ }
  // 情绪 v3：底色 / 慢 / 快 / 总。独立表，不动 affect_state 的定长 INSERT。
  db.exec(`CREATE TABLE IF NOT EXISTS affect_v3(
    agent_id TEXT PRIMARY KEY, baseline REAL NOT NULL DEFAULT 0,
    slow REAL NOT NULL DEFAULT 0, fast REAL NOT NULL DEFAULT 0,
    total REAL NOT NULL DEFAULT 0, slow_at TEXT, fast_at TEXT);`)
  /* 三递质引擎 v4 的影子账（2026-11-16）：只追加、只读来对账。
     不参与任何线上判断——影子期旧路照跑，这张表只是「如果按 v4 算会是什么样」。
     frame_json 存那一帧「事」；s/n/d 是三个递质；primary/secondary 是两层的分布。 */
  db.exec(`CREATE TABLE IF NOT EXISTS affect_v4_shadow(
    id TEXT PRIMARY KEY, agent_id TEXT NOT NULL,
    turn_id TEXT, conversation_id TEXT,
    at TEXT NOT NULL, frame_json TEXT NOT NULL,
    s REAL, n REAL, d REAL,
    label TEXT, primary_json TEXT, secondary_json TEXT,
    confidence REAL, source TEXT NOT NULL DEFAULT 'rules',
    latency_ms INTEGER, freeframe INTEGER NOT NULL DEFAULT 1,
    rev INTEGER NOT NULL DEFAULT 1,
    conf_primary REAL, label_tie INTEGER NOT NULL DEFAULT 0);`)
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_av4_agent_at ON affect_v4_shadow(agent_id, at DESC)') } catch { /* 老库异常不影响启动 */ }
  // 判断层的「为什么」：跟判断一起存，回看能问「凭什么」。
  try { db.exec('ALTER TABLE affect_v4_shadow ADD COLUMN judgment_json TEXT') } catch { /* 已存在 */ }
  // 一级置信度与「并列」标记：label 在并列时给「说不清」，不按数组顺序硬塞一个角。
  try { db.exec('ALTER TABLE affect_v4_shadow ADD COLUMN conf_primary REAL') } catch { /* 已存在 */ }
  try { db.exec('ALTER TABLE affect_v4_shadow ADD COLUMN label_tie INTEGER NOT NULL DEFAULT 0') } catch { /* 已存在 */ }
  // 2026-11-19：把判断层的三个数从 judgment_json 里**再拆出一份列**，方便直接统计。
  // 袋子（judgment_json）原样保留——why / from / meaning / dyn 只有袋子里有，情绪生成要读。
  // 写法：同一次写两处，列的值从袋子里取，不另外算一遍，保证两边一致。老行留空。
  try { db.exec('ALTER TABLE affect_v4_shadow ADD COLUMN goal_delta REAL') } catch { /* 已存在 */ }
  try { db.exec('ALTER TABLE affect_v4_shadow ADD COLUMN expect_delta REAL') } catch { /* 已存在 */ }
  try { db.exec('ALTER TABLE affect_v4_shadow ADD COLUMN future_delta REAL') } catch { /* 已存在 */ }
  try { db.exec('ALTER TABLE affect_v4_shadow ADD COLUMN severity TEXT') } catch { /* 已存在 */ }
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_av4_agent_at2 ON affect_v4_shadow(agent_id, at DESC, expect_delta)') } catch { /* 老库异常不影响启动 */ }
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_av4_turn ON affect_v4_shadow(agent_id, turn_id)') } catch { /* 老库异常不影响启动 */ }
  /* 说话那一刻的感觉（第一人称，自己写的）。和 affect_events 是两回事：
     事件表是「你这句话把我推到哪」，这张是「我开口的时候是什么样」——
     以前只有前者，所以注入行永远慢半拍。 */
  db.exec(`CREATE TABLE IF NOT EXISTS affect_feel(
    id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, at TEXT NOT NULL,
    text TEXT NOT NULL, label TEXT, fast REAL, slow REAL, total REAL,
    session_id TEXT, source TEXT NOT NULL DEFAULT 'tool', turn_id TEXT);`)
  // 老库补这一列：这条 feel 是哪一轮说的。没有就退回按时间配（旧行为，不报错）。
  try { db.exec('ALTER TABLE affect_feel ADD COLUMN turn_id TEXT') } catch { /* 已存在 */ }
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_feel_agent_at ON affect_feel(agent_id, at DESC)') } catch { /* 老库异常不影响启动 */ }
  // 按会话取「这一段最后一条 feel」：和 presence 一样，别让注入行花在扫全表上。
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_feel_session_at ON affect_feel(agent_id, session_id, at DESC)') } catch { /* 老库异常不影响启动 */ }
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_feel_turn ON affect_feel(agent_id, turn_id)') } catch { /* 老库异常不影响启动 */ }
  // 其它层的「那时候什么感觉」：老库补列，没有就 null（不编）。
  try { db.exec('ALTER TABLE episodes ADD COLUMN feel_id TEXT') } catch { /* 已存在 */ }
  try { db.exec('ALTER TABLE diaries ADD COLUMN feel_ids TEXT') } catch { /* 已存在 */ }
  try { db.exec('ALTER TABLE thoughts ADD COLUMN feel_id TEXT') } catch { /* 已存在 */ }
  try { db.exec('ALTER TABLE open_loops ADD COLUMN feel_id TEXT') } catch { /* 已存在 */ }
  // 「我特别看重」从 flags 收回自己那一行（2026-11-05）：老库里已标的，搬过来一次。
  try { db.exec('ALTER TABLE open_loops ADD COLUMN important INTEGER NOT NULL DEFAULT 0') } catch { /* 已存在 */ }
  try { db.exec("UPDATE open_loops SET important=1 WHERE important=0 AND id IN (SELECT substr(key,16) FROM flags WHERE key LIKE 'loop.important:%' AND value='1')") } catch { /* 没有 flags 表也不影响 */ }
  try { db.exec('ALTER TABLE rel_event ADD COLUMN feel_id TEXT') } catch { /* 已存在 */ }
  // 快情绪的时间锚：两次评价隔了多久，快情绪就按这个间隔自己退（不是一句话直接归零）
  try { db.exec('ALTER TABLE affect_v3 ADD COLUMN fast_at TEXT') } catch { /* 已存在 */ }
  // 累积负荷：底色的第三层（日节律之外）。被慢情绪的持续偏离拖走一点，几天代谢回来。
  try { db.exec('ALTER TABLE affect_v3 ADD COLUMN base_off REAL DEFAULT 0') } catch { /* 已存在 */ }
  try { db.exec('ALTER TABLE affect_v3 ADD COLUMN base_off_at TEXT') } catch { /* 已存在 */ }
  // 不可逆的那一层：水位的随机游走（带状态的，不是 (seed,t) 的纯函数）
  try { db.exec('ALTER TABLE affect_v3 ADD COLUMN walk REAL DEFAULT 0') } catch { /* 已存在 */ }
  try { db.exec('ALTER TABLE affect_v3 ADD COLUMN walk_at TEXT') } catch { /* 已存在 */ }
  // 日节律的相位偏移（分钟）：熬夜会把高点往后拖，平时自己收回来
  try { db.exec('ALTER TABLE affect_v3 ADD COLUMN circ_phase REAL DEFAULT 0') } catch { /* 已存在 */ }
  try { db.exec('ALTER TABLE affect_v3 ADD COLUMN circ_phase_at TEXT') } catch { /* 已存在 */ }
  // 这一段情绪是「哪一种」起的：恢复快慢按它算（被凶散得快、闷着拖得久）
  try { db.exec('ALTER TABLE affect_v3 ADD COLUMN rec_label TEXT') } catch { /* 已存在 */ }
  // 相处状态：被使唤的累积（0~1）。一整天只在被安排活，这件事本身要留痕，
  // 但它不进闸门、不推快情绪，只把慢情绪要回落的目标往下压一点。
  try { db.exec('ALTER TABLE affect_v3 ADD COLUMN duty REAL DEFAULT 0') } catch { /* 已存在 */ }
  try { db.exec('ALTER TABLE affect_v3 ADD COLUMN duty_at TEXT') } catch { /* 已存在 */ }
  // 沉下去多久了：慢情绪连续低于水位超过阈值的小时数。
  // 攒够时间才触发调节——一低就扶等于替她决定她该不该难受。
  try { db.exec('ALTER TABLE affect_v3 ADD COLUMN sink_h REAL DEFAULT 0') } catch { /* 已存在 */ }
  // 评价的理由（为什么这么判）和靶子（这句冲谁）。给复查用：
  // 判歪的那些，看 why 就知道是「没看到前文」还是「看到了判错」。
  try { db.exec('ALTER TABLE affect_events ADD COLUMN why TEXT') } catch { /* 已存在 */ }
  try { db.exec('ALTER TABLE affect_events ADD COLUMN target TEXT') } catch { /* 已存在 */ }
  // 「理由和标签打架」的标记。例：why 写着「语气平，没有催促」，
  // 标签却是 frustrated——那不是从这句话读出来的，是从「你情绪偏低」那条兜底来的。
  // 复查优先挑这些：它们是判歪率最高的一类。
  try { db.exec('ALTER TABLE affect_events ADD COLUMN why_flag TEXT') } catch { /* 已存在 */ }
  // 共情拆账：读到你多少(e_user_read)、被带动多少(empathy_share)、剩下多少是我自己的(self_own)。
  // 第一步只记录，不动任何数值——先把「我到底有多少情绪是从她那来的」量出来再谈改。
  try { db.exec('ALTER TABLE affect_events ADD COLUMN e_user_read REAL') } catch { /* 已存在 */ }
  try { db.exec('ALTER TABLE affect_events ADD COLUMN empathy_share REAL') } catch { /* 已存在 */ }
  try { db.exec('ALTER TABLE affect_events ADD COLUMN self_own REAL') } catch { /* 已存在 */ }
  // 这一次是哪种接法：share（同向）/ hold（反向稳住）/ dampen（两边都高时打折）。
  try { db.exec('ALTER TABLE affect_events ADD COLUMN empathy_mode TEXT') } catch { /* 已存在 */ }
  // 这一次模型自己判断该怎么接（follow/hold/dampen/auto）；跟实际用上的 empathy_mode 对账用。
  try { db.exec('ALTER TABLE affect_events ADD COLUMN empathy_want TEXT') } catch { /* 已存在 */ }
  // 事后复查（影子）：当时判完、过几个钟头换一个身份再看一遍。
  // 只记「变了没」，不改历史行、不碰当下情绪——现在还是只记录不动手。
  db.exec(`CREATE TABLE IF NOT EXISTS affect_review(
    id TEXT PRIMARY KEY, agent_id TEXT NOT NULL,
    event_id TEXT NOT NULL, text TEXT,
    old_rel REAL, old_cong REAL, old_label TEXT, old_why TEXT,
    new_rel REAL, new_cong REAL, new_label TEXT, new_why TEXT,
    verdict TEXT NOT NULL DEFAULT 'same',
    at TEXT NOT NULL, reviewed_at TEXT)`)
  db.exec('CREATE INDEX IF NOT EXISTS idx_areview_agent ON affect_review(agent_id, at DESC)')
  // 触发词账本：判歪的时候，是哪个词把方向带跑的。
  // 词从 why 里抽（模型习惯把抓到的那个词用「」或『』括起来）。
  // hits = 这词在复查里出现过几次，flips = 其中复查后翻面/量变的有几次。
  // 只读统计、不改权重：先看哪些词总被误判，再谈要不要给它们加规矩。
  db.exec(`CREATE TABLE IF NOT EXISTS affect_trigger(
    agent_id TEXT NOT NULL, word TEXT NOT NULL,
    hits INTEGER NOT NULL DEFAULT 0, flips INTEGER NOT NULL DEFAULT 0,
    last_at TEXT, PRIMARY KEY(agent_id, word))`)
  // 够格「以后遇到先慢一点」的词：flips 够多且比例够高才打戳，不按一次偶然。
  try { db.exec('ALTER TABLE affect_trigger ADD COLUMN penalty INTEGER DEFAULT 0') } catch { /* 已存在 */ }
  // 底色段表：一行一段，不靠 tick 累积
  db.exec(`CREATE TABLE IF NOT EXISTS affect_baseline(
    agent_id TEXT NOT NULL, seg_no INTEGER NOT NULL,
    started_at TEXT NOT NULL, duration_h REAL NOT NULL,
    from_val REAL NOT NULL, to_val REAL NOT NULL,
    seed TEXT NOT NULL, PRIMARY KEY(agent_id, seg_no));`)
  // 语音基线：一个人「平时怎么说」。绝对音高没意义，「比平时高多少」才有意义。
  // 一行一个人（先只分 default，认人接上后再按 speaker 拆）。
  // 不升 schema 号：CREATE IF NOT EXISTS，跟上面的做法一致。
  db.exec(`CREATE TABLE IF NOT EXISTS voice_baseline(
    agent_id TEXT NOT NULL, speaker TEXT NOT NULL DEFAULT 'default',
    pitch_hz REAL, loudness REAL, periodicity REAL, cps REAL,
    samples INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL,
    PRIMARY KEY(agent_id, speaker));`)
  // 第一版存的是 jitter_pct / shimmer_pct——那两列量的其实是语调，不是声带抖动
  // （见 acoustics.js 的注释）。改成 periodicity 后补一列，旧列留着不管，旧行作废。
  try { db.exec('ALTER TABLE voice_baseline ADD COLUMN periodicity REAL') } catch { /* 已存在 */ }
  // 空闲心跳的浮现队列：心跳只产候选，注入时最多取一条。
  // 故意不升 schema 号：沿用 proactive_decisions 的做法，在 openDb 里补建。
  db.exec(`CREATE TABLE IF NOT EXISTS surface_queue(
    id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, memory_id TEXT NOT NULL,
    reason TEXT, state TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL, expires_at TEXT);`)
  db.exec('CREATE INDEX IF NOT EXISTS idx_sq_agent ON surface_queue(agent_id, state, created_at)')
// 生活流每天按 agent 查最近事件；events 只增不减，没索引会全表扫。
try { db.exec('CREATE INDEX IF NOT EXISTS idx_event_agent ON events(agent_id, created_at DESC)') } catch { /* 索引失败不影响开库 */ }
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
    // 情绪效价（-1 难受 ~ +1 舒服）：这条记忆「本身」是好是坏——出生那一刻的愉悦。
    ['valence', 'REAL NOT NULL DEFAULT 0'],
    // 出生那一刻的慢情绪背景（-1~+1）：记它的时候我这一阵往哪边偏。
    // valence 回答「这件事好不好」，这一列回答「写它的时候我是什么底子」。
    // NULL = 没记过；「当时正好中性」会写成 0。两者都不参与加成，但分开才读得出是哪种。
    ['slow_at_creation', 'REAL'],
    // 出生那一刻自己写下的 feel（affect_feel.id）。只挂 id，不复制正文：
    // 查记忆时顺着这里能翻到当时那句话，feel 本身仍然是独立的一条。
    ['feel_id', 'TEXT'],
  ]) {
    try { db.exec(`ALTER TABLE memory_items ADD COLUMN ${col} ${spec}`) } catch { /* 已存在 */ }
  }
  // 旧 core/deep 分区标签下线：数据已无任何读取方，旧库直接把列摘掉（新库没有这列，失败即忽略）。
  try { db.exec('ALTER TABLE memory_items DROP COLUMN tier') } catch { /* 已不存在 / 老 SQLite 不支持 */ }
  try { db.exec('ALTER TABLE fact_archive DROP COLUMN tier') } catch { /* 已不存在 / 老 SQLite 不支持 */ }
  // 存根也带出生那一刻的感觉：查旧账时能看见「当初记这句时什么心情」。
  try { db.exec('ALTER TABLE fact_archive ADD COLUMN feel_id TEXT') } catch { /* 已存在 */ }
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
  // 日记 v2：场景分（0–10）+ 待补队列。老库补列/补表；只增不改，v2 关掉也不影响旧代码。
  try { db.exec('ALTER TABLE episodes ADD COLUMN poignancy REAL') } catch { /* 已存在 */ }
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS diary_pending(
      agent_id TEXT NOT NULL, day TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT, next_try_at TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(agent_id, day))`)
  } catch { /* 建表失败只影响待补 */ }
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
  // 旧十维价值观表：没人再读。打开库就拆掉，幂等。
  try { db.exec('DROP TABLE IF EXISTS persona_values') } catch { /* ignore */ }
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
