/**
 * INV10 表归属白名单。
 * 模块文件只能 SQL 触碰本域表 + SHARED。
 * features host：人格/情绪采样/软召回/工况/冷却/预算/行动已收回 modules；
 * 仍允许：规则版本、指标聚合、导出/导入、绑定/对话编排。
 */

export const SHARED = Object.freeze(['agents', 'events', 'journal', 'idempotency', 'sqlite_master'])

/** @type {Record<string, { files: string[], tables: string[] }>} */
export const OWNERSHIP = {
  memory: {
    files: [
      'modules/memory.js',
      'modules/conflict.js',
      'modules/study.js',
      'algo/recall.js',
    ],
    tables: [
      'memory_items', 'memory_links', 'memory_fts', 'conflicts', 'alerts', 'raw_turns',
      // 只读：召回的关系加成（记忆挂在谁名下、那个人多亲近）
      'rel_evidence', 'rel_person',
    ],
  },
  loops: {
    // 开环：承诺 / 待办 / 悬着的事，写自己的表；只读记忆正文用来挂来源
    files: ['modules/loops.js'],
    tables: ['open_loops', 'memory_items'],
  },
  surfacing: {
    // 浮现观测：注入 / 用上，只写自己的表
    files: ['modules/surfacing.js'],
    tables: ['surfaced_items'],
  },
  pulse: {
    // 空闲心跳：只写自己的浮现队列；记忆正文只读，用来挑候选
    files: ['modules/pulse.js'],
    tables: ['surface_queue', 'surfaced_items', 'memory_items'],
  },
  selfread: {
    // 回读自己那句话：只改 affect_v3 的慢情绪
    files: ['modules/self_read.js'],
    tables: ['affect_v3'],
  },
  algo: {
    files: [
      'algo/active.js', 'algo/registry.js', 'algo/index.js',
      'algo/decay.js', 'algo/deficit.js',
      'algo/appraise.js', 'algo/affect_dyn.js',
    ],
    tables: ['algo_bindings'],
  },
  persona: {
    files: ['modules/persona.js'],
    tables: ['persona', 'persona_values', 'changes', 'preferences', 'taboos', 'relations'],
  },
  relations: {
    // 人物账本：rel_event 是主数据，其余都是可重放投影。
    // 名单里的 relations（旧表）只读，用于一次性迁移；v2 不写它。
    files: ['modules/relations.js'],
    tables: [
      'rel_event', 'rel_tier', 'rel_person', 'rel_edge', 'rel_mention', 'rel_evidence',
      'rel_channel', 'rel_extract_queue', 'rel_review', 'rel_habit', 'rel_violation',
      'relations',
    ],
  },
  poisons: {
    files: ['modules/poisons.js'],
    // 只读：工况 + 记忆条数；情绪/驱力走各自模块的公开函数
    tables: ['condition_state', 'memory_items'],
  },
  values: {
    files: ['modules/values.js'],
    // 读外域做证据（记忆/情绪），只写自己的 persona_values
    tables: ['persona_values', 'memory_items', 'affect_state', 'rel_person', 'relations'],
  },
  affect: {
    files: ['modules/affect.js'],
    // affect_events：P0 影子闸门，每条消息一行，只记录「会不会成为事件」
    tables: ['affect_state', 'affect_episodes', 'affect_samples', 'affect_v3', 'affect_baseline', 'affect_user_read', 'affect_events'],
  },
  drive: {
    files: ['modules/drive.js'],
    // persona 只读：v1d 的设定点由人格调制（候选公式，默认不启用）
    // persona_values 只读：v3 的「重要度」权重（性格 × 价值观），只读不写
    // affect_events 只读：情绪 → 驱力只吃过了闸的事件（doc 7）
    // relations / affect_v3 / condition_state / browse_items 只读：胃口的四路外部状态
    // affect_state 只读：长期情绪改胃口（跟提示词/页面上写的那个标签同源）
    tables: [
      'drive_state', 'action_ports', 'action_log', 'cooldowns', 'budgets', 'persona', 'persona_values', 'affect_events',
      'relations', 'rel_person', 'affect_v3', 'condition_state', 'browse_items', 'affect_state',
    ],
  },
  selfmod: {
    files: ['modules/selfmod.js', 'modules/selfmod_store.js', 'modules/artifacts.js'],
    tables: [
      'proposals', 'changes', 'rule_versions', 'inbox_items', 'metric_samples',
      'rule_artifacts', 'agent_bindings', 'chat_turns', 'drive_state', 'change_journal',
    ],
  },
  ops: {
    files: ['modules/ops.js', 'modules/chat.js', 'modules/edges.js'],
    // 编排层：只通过 ports 读外域；自身可写 chat/绑定/指标快照，以及 purge 时的级联清理
    tables: [
      'chat_turns', 'bindings', 'flags', 'metric_snapshots', 'metric_samples', 'condition_state',
      // purge / zip 级联（命令式清理，不算业务耦合）
      'memory_items', 'memory_links', 'memory_fts', 'conflicts', 'persona', 'persona_values', 'preferences', 'taboos',
      'open_loops',
      'relations', 'affect_state', 'affect_episodes', 'affect_samples', 'affect_user_read', 'drive_state',
      'action_ports', 'action_log', 'proposals', 'changes', 'inbox_items', 'alerts', 'algo_bindings',
      'agent_params', 'agent_bindings', 'rule_artifacts',
      // 分层记忆的级联清理
      'episodes', 'diaries', 'raw_turns', 'raw_fts', 'fact_archive', 'fact_fts',
      // 人物账本的级联清理（purge 时按子表 → person 顺序删）
      'rel_mention', 'rel_evidence', 'rel_edge', 'rel_channel', 'rel_extract_queue', 'rel_review', 'rel_event', 'rel_person',
    ],
  },
  kernel: {
    files: ['kernel.js'],
    tables: [...SHARED, 'changes', 'agent_params', 'flags'], // setParam 写 changes + agent_params
  },
  layers: {
    // 分层记忆：原文 / 纪要 / 日记 / 事实存根 / 热度账本 / 会话缓冲 / 检索骨架 / 回放日志 / 夜间巩固
    files: ['modules/archive.js', 'modules/tiers.js', 'modules/temps.js', 'modules/buffer.js', 'modules/retrieve.js', 'modules/pack.js', 'modules/retrieval_log.js', 'modules/nightly.js', 'modules/vault.js', 'modules/consolidate.js'],
    tables: ['raw_turns', 'raw_fts', 'episodes', 'diaries', 'fact_archive', 'fact_fts', 'retrieval_log', 'consolidation_log', 'memory_items', 'memory_fts', 'affect_state', 'flags', 'chat_turns',
      // 累计重要性 → 反思的游标（consolidate.js 读写）
      'reflect_cursor',
      // 只读：写日记时快照状态、仓库统计体量、注入用量
      'persona', 'persona_values', 'drive_state', 'relations', 'preferences', 'taboos', 'metric_samples',
      // 只读：检索时的实体扩散（entities）与同实体一跳（memory_links）
      'entities', 'memory_links',
      // 向量通道：检索读已存向量
      'memory_vec'],
  },
  vectors: {
    // 向量通道：写自己的 memory_vec，读记忆正文
    files: ['modules/vector.js'],
    tables: ['memory_vec', 'memory_items'],
  },
  writegate: {
    // 写入侧：实体归一化 / 写入门控 / 抽取队列 / 检索卡补写（门控只改 memory_items 的强化计数）
    files: ['modules/entities.js', 'modules/gate.js', 'modules/extract_queue.js', 'modules/enrich.js'],
    tables: ['entities', 'extract_queue', 'memory_items', 'memory_fts', 'conflicts', 'alerts'],
  },
  sangguan: {
    // 三观引擎：L0 只增账本 + 可重建投影 + 判定缓存；claim_purge 只在整 agent 清除的事务里存在
    // chat_turns 只读（用户是否活跃）；flags 存开关 / 预算 / 判定健康 / 快环缓冲 / 注入影子记录
    files: [
      'api', 'bridge', 'budget', 'catalog', 'config', 'core', 'deliberate', 'elev', 'errors', 'events', 'explain', 'fast', 'fold',
      'gates', 'http_chat', 'index', 'inject', 'intake', 'ledger', 'liveness', 'llm', 'machine', 'night', 'open', 'practice',
      'precedent', 'projection', 'purge', 'schema', 'seed', 'sim', 'summary', 'tags', 'templates', 'theta', 'trial', 'ulid', 'verdict',
    ].map((f) => 'modules/sangguan/' + f + '.js'),
    tables: [
      'claim_events', 'persona_claims', 'claim_questions', 'claim_kappa', 'claim_predictions', 'claim_evidence',
      'claim_edges', 'claim_summaries',
      'claim_proj_claim', 'claim_proj_kappa', 'claim_proj_nu', 'claim_proj_edge', 'claim_proj_theta', 'claim_proj_meta',
      'claim_llm_cache', 'claim_purge', 'flags', 'chat_turns',
      // intake 只读：旧通道变成候选，不写这些表
      'memory_items', 'conflicts', 'diaries', 'rel_person', 'drive_state', 'action_log',
    ],
  },
  host: {
    // api.js / index.js / db.js 不直接写业务 SQL；features / eval 编排聚合
    files: ['features.js', 'modules/eval.js', 'modules/proxies.js', 'modules/browse.js', 'push.js'],
    tables: [
      'changes', 'rule_versions', 'metric_samples', 'conflicts', 'proposals',
      'events', 'agents', 'flags', 'bindings', 'chat_turns', 'proactive', 'proactive_stats', 'proactive_decisions',
      'affect_episodes', 'memory_items', 'memory_fts', 'sqlite_master',
      // 全量导出 / 导入清单
      'fact_archive', 'fact_fts', 'raw_turns', 'episodes', 'diaries',
      // 全量导出动态 ${t}（扫不到）；保留导出清单核心表以防静态化
      'memory_links', 'persona', 'affect_state', 'alerts', 'drive_state',
      'open_loops',
      'metric_snapshots', 'algo_bindings', 'persona_values', 'preferences',
      'taboos', 'relations', 'affect_samples', 'affect_user_read', 'agent_params',
      'rule_artifacts', 'agent_bindings',
      // 需求代理只读
      'condition_state', 'action_log', 'action_ports',
      // P2/P3：v3 传感器读新实体与收件箱；浏览入口写 browse_items
      'entities', 'inbox_items', 'browse_items',
      // 人物账本的导出 / 导入
      'rel_tier', 'rel_event', 'rel_person', 'rel_edge', 'rel_mention', 'rel_evidence',
      'rel_channel', 'rel_extract_queue', 'rel_review',
    ],
  },
}

export function tablesForFile(relPosix) {
  const norm = relPosix.replace(/\\/g, '/')
  for (const [mod, spec] of Object.entries(OWNERSHIP)) {
    if (spec.files.some((f) => norm === f || norm.endsWith('/' + f) || norm.endsWith(f))) {
      return { module: mod, tables: spec.tables, shared: SHARED }
    }
  }
  return null
}

export function isTableAllowed(relPosix, table) {
  const info = tablesForFile(relPosix)
  if (!info) return { ok: true, reason: 'untracked' }
  if (info.tables.includes('*')) return { ok: true, module: info.module }
  const t = String(table).toLowerCase()
  if (info.shared.includes(t) || info.tables.includes(t)) return { ok: true, module: info.module }
  return { ok: false, module: info.module, allowed: [...info.shared, ...info.tables] }
}
