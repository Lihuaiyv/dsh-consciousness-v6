/**
 * INV10 表归属白名单。
 * 模块文件只能 SQL 触碰本域表 + SHARED。
 * features host：人格/情绪采样/软召回/工况/冷却/预算/行动已收回 modules；
 * 仍允许：规则版本、指标聚合、导出/导入、绑定/对话编排。
 */

/**
 * 写入声明：一张表只有声明过的域能写（ops / host 两个搬库例外不声明）。
 * 写在这里而不是散在各域对象里，是为了整张表能一眼看完、检查器只读这一处。
 * selfhood / selfread 声明为空数组：它们只读，不该再直接写 memory_items。
 */
export const WRITES = Object.freeze({
  loops: ['open_loops'],
  queue: ['proactive'],
  speak: ['proactive_decisions', 'proactive_stats'],
  expression: [],
  who: [],
  memory: ['memory_items', 'memory_fts', 'alerts', 'conflicts'],
  timeline: ['memory_timeline', 'memory_items', 'flags'],
  layers: ['raw_turns', 'raw_fts', 'episodes', 'diaries', 'diary_pending', 'fact_fts', 'retrieval_log', 'consolidation_log', 'reflect_cursor'],
  persona: ['persona', 'relations', 'preferences', 'taboos'],
  selfmod: ['metric_samples', 'persona', 'proposals', 'rule_artifacts', 'rule_versions', 'agent_bindings', 'change_journal', 'inbox_items'],
  affect: ['affect_baseline', 'affect_episodes', 'affect_events', 'affect_review', 'affect_samples', 'affect_state', 'affect_trigger', 'affect_user_read', 'affect_v3'],
  feel: ['affect_feel'],
  drive: ['action_log', 'action_ports', 'budgets', 'cooldowns', 'drive_state'],
  relations: ['rel_channel', 'rel_edge', 'rel_evidence', 'rel_habit', 'rel_mention', 'rel_person', 'rel_tier', 'rel_violation'],
  sangguan: [
    'claim_edges', 'claim_events', 'claim_evidence', 'claim_kappa', 'claim_llm_cache', 'claim_predictions',
    'claim_proj_claim', 'claim_proj_edge', 'claim_proj_kappa', 'claim_proj_meta', 'claim_proj_nu', 'claim_proj_theta',
    'claim_purge', 'claim_questions', 'claim_summaries', 'persona_claims', 'sangguan_drafts',
  ],
  writegate: ['entities', 'extract_queue', 'memory_pair_judge'],
  vectors: ['memory_vec'],
  surfacing: ['surfaced_items'],
  pulse: ['surface_queue'],
  algo: ['algo_bindings'],
  kernel: ['agent_params'],
  selfhood: [],
  selfread: ['affect_v3'],
  poisons: [],
  values: ['persona_values'],
  // 搬库 / 编排：ops 清库和导入、host 导入导出和接线。它们可以写别的域的表，
  // 但只许在本名单里——不是「想写哪张写哪张」。真正的进一步拆分要等把导入/导出/清库
  // 的代码抽成独立文件，那之前先按整域例外登记。
  ops: ['memory_items', 'memory_timeline', 'proactive', 'chat_turns', 'fact_fts', 'open_loops', 'raw_fts', 'rule_artifacts', 'condition_state', 'fact_archive', 'memory_links'],
  host: ['memory_timeline', 'proactive', 'chat_turns', 'diaries', 'metric_samples', 'proposals', 'relations', 'rule_versions', 'browse_items'],
})

export const SHARED = Object.freeze([
  'agents', 'events', 'journal', 'idempotency', 'sqlite_master',
  // 两张流水 / 便签：不是业务表，按「谁都可能记一笔」对待。
  // changes：变更流水，只追加 + 标记回滚，跟 events 同类；
  // flags：共享便签（开关 / 启动标记 / 学习状态），键必须带域前缀，别用裸 key。
  'changes', 'flags',
])

/** @type {Record<string, { files: string[], tables: string[], reads?: string[], writes?: string[] }>} */
export const OWNERSHIP = {
  memory: {
    files: [
      'modules/memory.js',
      'modules/memory_fields.js',
      'modules/conflict.js',
      'modules/contradict.js',
      'modules/conflict_ask.js',
      'modules/study.js',
      'algo/recall.js',
    ],
    tables: [
      'memory_items', 'memory_links', 'memory_fts', 'conflicts', 'alerts', 'raw_turns',
      // 开案后真的开口问：往主动消息队列里排一条
      'proactive',
      // 只读：召回的关系加成（记忆挂在谁名下、那个人多亲近）
      'rel_evidence', 'rel_person',
    ],
  },
  loops: {
    // 开环：承诺 / 待办 / 悬着的事。只写自己的表 open_loops；来源由调用方递进来，不碰记忆正文。
    files: ['parts/loops/index.js', 'modules/loops.js'],
    tables: ['open_loops'],
    reads: [],
  },
  queue: {
    // 待发消息队列：proactive 只由 modules/proactive.js 写。开口、冲突提问、投递、作废都调它的公开函数。
    files: ['modules/proactive.js'],
    tables: ['proactive'],
    reads: [],
  },
  speak: {
    // 主动开口：判断 + 生成 + 记判决。读情绪 / 驱力 / 人格 / 记忆 / 开环；只写自己的两张账表。
    files: [
      'parts/speak/index.js', 'parts/speak/prefs.js', 'parts/speak/budget.js', 'parts/speak/trigger.js',
      'parts/speak/judge.js', 'parts/speak/store.js', 'parts/speak/compose.js', 'parts/speak/hooks.js',
    ],
    tables: [
      'proactive', 'proactive_decisions', 'proactive_stats', 'flags',
      'agents', 'memory_items', 'affect_state', 'drive_state',
    ],
    reads: [],
  },
  who: {
    // 认人：只回答「谁在说话」。不写库；自己读两张账本表（通道登记 / 主人卡），
    // 这样「谁在说话」只有一份实现，关系动力也调它。
    files: ['modules/who.js'],
    tables: ['rel_person', 'rel_channel'],
    reads: [],
  },
  expression: {
    // 说话分寸：只算档位和句子多少，不碰表。
    files: ['algo/expression.js', 'modules/expression_state.js'],
    tables: [],
    reads: [],
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
    // reldyn / desensitize 是纯函数（不碰表），登记在这里让界桩扫得到零件文件。
    files: ['modules/relations.js', 'algo/reldyn.js', 'algo/desensitize.js'],
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
    // 情绪动力搬家：实现搬进 parts/affect/index.js，modules/affect.js 只留转发。
    files: ['modules/affect.js', 'parts/affect/index.js'],
    // affect_events：P0 影子闸门，每条消息一行，只记录「会不会成为事件」
    // affect_review / affect_trigger：事后复查 + 触发词学习，本来就是它自己的两张表，之前漏登记
    tables: ['affect_state', 'affect_episodes', 'affect_samples', 'affect_v3', 'affect_baseline', 'affect_user_read', 'affect_events', 'affect_review', 'affect_trigger'],
  },
  feel: {
    // 感受（feel）：立零件时补的域。只写 affect_feel；读的情绪/对话/记忆只读。
    files: ['modules/feel.js'],
    tables: [
      'affect_feel',
      // 只读：拼「这一秒」时要带当时的快/慢和标签
      'affect_v3', 'affect_state', 'affect_events',
      // 只读：回顾时顺带同时段的对话与当天日记
      'raw_turns', 'chat_turns', 'memory_items', 'diaries',
    ],
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
  selfhood: {
    // 生活流 / 自我改写 / 反刍：只写自己的事件、记忆来源和 persona 白名单
    files: ['modules/life.js', 'modules/self_memory.js', 'modules/self_pattern.js', 'modules/self_author.js', 'modules/reappraise.js', 'modules/self_repeat.js'],
    tables: [
      'events', 'memory_items', 'agent_params', 'persona', 'changes',
      'affect_samples', 'affect_state', 'conflicts', 'proactive',
    ],
  },
  selfmod: {
    files: ['modules/selfmod.js', 'modules/selfmod_store.js', 'modules/artifacts.js'],
    tables: [
      'proposals', 'changes', 'rule_versions', 'inbox_items', 'metric_samples',
      'rule_artifacts', 'agent_bindings', 'chat_turns', 'drive_state', 'change_journal',
      // 回滚她自己改的样子（persona.style.*）时按 changes.before 写回
      'persona',
    ],
  },
  ops: {
    files: ['modules/ops.js', 'modules/chat.js', 'modules/edges.js', 'modules/qq_push.js'],
    // 编排层：只通过 ports 读外域；自身可写 chat/绑定/指标快照，以及 purge 时的级联清理
    tables: [
      'chat_turns', 'bindings', 'flags', 'metric_snapshots', 'metric_samples', 'condition_state',
      // purge / zip 级联（命令式清理，不算业务耦合）
      'memory_items', 'memory_links', 'memory_fts', 'conflicts', 'persona', 'persona_values', 'preferences', 'taboos',
      'open_loops',
      'relations', 'affect_state', 'affect_episodes', 'affect_samples', 'affect_user_read', 'affect_feel', 'drive_state',
      'action_ports', 'action_log', 'proposals', 'changes', 'inbox_items', 'alerts', 'algo_bindings',
      'agent_params', 'agent_bindings', 'rule_artifacts', 'proactive',
      // 分层记忆的级联清理
      'episodes', 'diaries', 'raw_turns', 'raw_fts', 'fact_archive', 'fact_fts', 'memory_timeline',
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
    // modules/diary.js：日记原来是这层里的散件，立成零件后文件仍在 layers 名下（写 diaries / diary_pending）
    files: ['modules/archive.js', 'modules/tiers.js', 'modules/temps.js', 'modules/buffer.js', 'modules/retrieve.js', 'modules/pack.js', 'modules/retrieval_log.js', 'modules/nightly.js', 'modules/vault.js', 'modules/consolidate.js', 'modules/diary.js'],
    tables: ['raw_turns', 'raw_fts', 'episodes', 'diaries', 'diary_pending', 'fact_archive', 'fact_fts', 'retrieval_log', 'consolidation_log', 'memory_items', 'memory_fts', 'affect_state', 'flags', 'chat_turns',
      // 累计重要性 → 反思的游标（consolidate.js 读写）
      'reflect_cursor',
      // 只读：写日记时快照状态、仓库统计体量、注入用量
      'persona', 'persona_values', 'drive_state', 'relations', 'preferences', 'taboos', 'metric_samples', 'conflicts',
      // 只读：日记要写那天的心情，从情绪三张表取（affect_feel 是 feel 快照）
      'affect_samples', 'affect_feel', 'affect_episodes',
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
    // fact_archive：原地改写的旧句留底（`<id>:hist:<version>`）
    // memory_pair_judge：窄门判定的缓存表（pair_judge 负责读写），gate 只把 applied 标成 0/1——
    // 登记在这里是为了让这次跨模块写可见，不是把表从 pair_judge 抢过来。
    files: ['modules/entities.js', 'modules/gate.js', 'modules/extract_queue.js', 'modules/enrich.js', 'modules/memory_source.js'],
    tables: ['entities', 'extract_queue', 'memory_items', 'memory_fts', 'conflicts', 'alerts', 'fact_archive', 'memory_pair_judge'],
  },
  timeline: {
    // G1 时效索引：写 memory_timeline；生效 / 正文 / 可见性按字段分写给 memory_items（check-timeline 守门）。
    // flags 记门开关；其余只读：正文从 memory_items / fact_archive 取，说话时间从 raw_turns / episodes 认。
    files: ['modules/timeline.js', 'modules/timeparse.js', 'modules/asof.js'],
    tables: ['memory_timeline', 'memory_items', 'fact_archive', 'raw_turns', 'episodes', 'conflicts', 'flags'],
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
      'claim_llm_cache', 'claim_purge', 'sangguan_drafts', 'flags', 'chat_turns',
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
      'fact_archive', 'fact_fts', 'raw_turns', 'episodes', 'diaries', 'memory_timeline',
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

/**
 * 搬库域：它们写别的域的表是清库 / 导入导出，不算业务写权。
 * 判定规则：一张表的写手里，最多一个业务域，其余都必须是搬库域，或者整张表进 WRITE_SPLIT。
 */
export const MAINTENANCE = Object.freeze(['ops', 'host'])

/**
 * 允许「按字段分写」的表：表级两个域各写各的字段，不是抢。
 * memory_items：内容 / 索引 / 打分 / 温度 / 热度 归 memory；生效 / 正文 / 可见性 归 timeline（check-timeline 守门）。
 * ops 的清库、host 的导入导出是搬库，单独算例外，不在这张表里。
 */
export const WRITE_SPLIT = Object.freeze({
  memory_items: ['memory', 'timeline'],
  // persona：人格模块写整行；selfmod 回滚时只按 changes.before 写回 style.* 那几个键。
  persona: ['persona', 'selfmod'],
  // affect_v3：情绪模块写整行；selfread 回读时只改慢情绪那几个字段。
  affect_v3: ['affect', 'selfread'],
})

export function tablesForFile(relPosix) {
  const norm = relPosix.replace(/\\/g, '/')
  for (const [mod, spec] of Object.entries(OWNERSHIP)) {
    if (spec.files.some((f) => norm === f || norm.endsWith('/' + f) || norm.endsWith(f))) {
      return { module: mod, tables: spec.tables, shared: SHARED, reads: spec.reads || null, writes: Object.prototype.hasOwnProperty.call(WRITES, mod) ? WRITES[mod] : null }
    }
  }
  return null
}

/**
 * op = 'read' | 'write'。填了 writes 的域，写别的表会被拒（reason=read_only）；
 * 没填 writes 的域仍按老样子放行——读写拆分是逐个域补的，补一个管一个。
 */
export function isTableAllowed(relPosix, table, op = 'read') {
  const info = tablesForFile(relPosix)
  if (!info) return { ok: true, reason: 'untracked' }
  if (info.tables.includes('*')) return { ok: true, module: info.module }
  const t = String(table).toLowerCase()
  if (info.shared.includes(t)) return { ok: true, module: info.module }
  if (!info.tables.includes(t)) return { ok: false, module: info.module, allowed: [...info.shared, ...info.tables] }
  if (op === 'write' && info.writes && !info.writes.includes(t)) {
    return { ok: false, module: info.module, reason: 'read_only', table: t, allowed: [...info.writes] }
  }
  return { ok: true, module: info.module }
}
