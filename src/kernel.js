import { now } from './db.js'
import { createModel } from './model.js'
import { bootstrapAlgos } from './algo/index.js'

bootstrapAlgos()
export const model = createModel()

export class ApiError extends Error {
  constructor(status, code, message, details = {}) {
    super(message)
    this.status = status
    this.code = code
    this.details = details
  }
}

export function err(status, code, message, details) {
  throw new ApiError(status, code, message, details)
}

export function nid(prefix) {
  return prefix + Math.random().toString(16).slice(2, 12)
}

export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const out = fn()
    db.exec('COMMIT')
    return out
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* ignore */ }
    throw e
  }
}

/** 可嵌套的原子块：外层已有事务时也能用（BEGIN 不能嵌套，SAVEPOINT 可以）。 */
let SP_SEQ = 0
export function savepoint(db, fn) {
  const name = 'sp_' + (++SP_SEQ)
  db.exec('SAVEPOINT ' + name)
  try {
    const out = fn()
    db.exec('RELEASE ' + name)
    return out
  } catch (e) {
    try { db.exec('ROLLBACK TO ' + name); db.exec('RELEASE ' + name) } catch { /* ignore */ }
    throw e
  }
}

export function agent(db, aid) {
  const row = db.prepare("SELECT * FROM agents WHERE id=? AND status!='soft_deleted'").get(aid)
  if (!row) err(404, 'NOT_FOUND', 'agent 不存在')
  return row
}

export function active(db, aid) {
  const row = agent(db, aid)
  if (row.status !== 'active') err(409, 'READ_ONLY', '已暂停：停注入、停写入、停主动')
  return row
}

export function event(db, aid, type, payload) {
  db.prepare('INSERT INTO events VALUES(?,?,?,?,?)')
    .run(nid('evt_'), aid, type, JSON.stringify(payload), now())
}

export function chars(text) { return new Set(String(text).match(/[\u4e00-\u9fff]|[a-zA-Z0-9]/g) || []) }

/** 参数目录：等级 + 默认值。运行时取值走 getParam（按 agent），不要改这里的默认值当实例状态。 */
export const PARAMS = {
  'memory.decay.lambda': ['C4', 0.02],
  'memory.decay.formula': ['C3', 'v1'],
  'memory.recall.floor': ['C4', 0],
  'memory.recall.weights.relation': ['C4', 0.10],
  // 心情一致：心情好更容易想起好事，低落更容易想起坏事（mood-congruent recall）
  'memory.recall.weights.mood': ['C4', 0.15],
  'memory.recall.formula': ['C3', 'v2'],
  // 默认 v3：分层记忆 / RRF / 实体 / 向量通道。显式写成 v2 才走老 recall。
  'memory.retrieve.formula': ['C3', 'v3'],
  // 召回增强：off = 纯词法；low = 只在低置信时叫模型（默认）；always = 每轮都叫。
  'memory.retrieve.expand': ['C4', 'low'],
  // pre-step 最多等预取多久（毫秒）；等不到就先用词法结果，不阻塞这一轮。
  'memory.retrieve.expand.wait': ['C4', 250],
  // 向量通道：auto = 有向量才用；off = 关。
  'memory.retrieve.vector': ['C4', 'auto'],
  // 图扩散：回看/深查最多走几跳（S1 恒 1 跳），二跳按 decay 打折（0.45 × 0.65 ≈ 0.29，过不了 S1 门）。
  'memory.recall.link.hops': ['C4', 2],
  'memory.recall.link.decay': ['C4', 0.65],
  // 类型权重：事实 > 评价 > 自省（只影响排序，不影响准入）。
  'memory.recall.typeweights': ['C4', 'on'],
  // 写入侧闸门：摘要的重要度交给模型判（on/off），低于 floor 的落库但进深查层。
  'memory.write.reflect_judge': ['C4', 'on'],
  'memory.write.reflect_floor': ['C4', 0.7],
  // 原文层分龄：深查时默认只翻最近 N 天的对话原文（0 = 不限）；
  // 查询里有「最早/一开始/很久以前」这类词时自动放开（retrieve.oldAccountQuery）。
  'memory.recall.archive.days': ['C4', 30],
  'memory.inject.pool': ['C4', 50],
  'memory.inject.budget': ['C4', 800],
  'memory.auto': ['C4', true],
  // 日记打包：纪要 importance 低于此值默认不进材料（忙天给高分腾坑）；0 = 不设下限
  'memory.episode.min_diary_importance': ['C4', 0.25],
  // L1 金标精修：on/off；日限额；importance 阈值；有效轮次阈值
  'memory.episode.refine': ['C4', 'on'],
  'memory.episode.refine.daily_cap': ['C4', 8],
  'memory.episode.refine.theta': ['C4', 0.55],
  'memory.episode.refine.min_turns': ['C4', 8],
  // L2 忙天簇修：纪要条数超过此值才跑（一次模型）；0 = 关
  'memory.episode.cluster_at': ['C4', 12],
  // M0–M2 纪要→事实：夜巡蒸馏；off = 仅按轮抽取
  'memory.episode.distill': ['C4', 'on'],
  'memory.episode.distill.theta': ['C4', 0.55],
  'memory.episode.distill.daily_cap': ['C4', 6],
  'memory.episode.distill.prefer_cluster': ['C4', 'on'],
  // 无模型时是否用规则从 beats/open_loops 捞硬断言（默认 off）
  'memory.episode.distill.rules': ['C4', 'off'],
  // U0：日模型调用硬顶（refine+cluster+diary+distill+extract）；0 = 不限
  'memory.llm.daily_cap': ['C4', 16],
  // U1：向量索引 auto|bruteforce|off
  'memory.retrieve.vector.index': ['C4', 'auto'],
  // U2：同 key / 高相似同极性时 UPDATE 改写
  'memory.write.reconcile': ['C4', 'on'],
  // U6：改口（极性翻转）conflict=开黄灯（默认）| update=静默覆盖
  'memory.write.flip_policy': ['C4', 'conflict'],
  // U7：S1 对冷层「习惯类」事实做窄穿透（查询字面命中才放行）；off=完全不穿透
  'memory.retrieve.habit_cold': ['C4', 'on'],
  // G1：「某天当时」查询（时效索引 + 冷库出证）；auto=对话里自动触发（默认关）；axis=said 说话时间 | recorded 入库时间
  'memory.asof': ['C4', 'on'],
  'memory.asof.auto': ['C4', 'off'],
  'memory.asof.axis': ['C4', 'said'],
  // U3：夜巡实体解析 / 事实合并
  'memory.entity.resolve': ['C4', 'on'],
  'memory.entity.resolve.daily_cap': ['C4', 2],
  'memory.consolidate.facts': ['C4', 'on'],
  // M3：最近纪要 topics 给命中的 T1 微助推（0 = 关）
  'memory.retrieve.episode_topic_boost': ['C4', 0],
  // 日记选料：有簇修时优先吃簇+精修；L0 只按比例补洞（off = 回到纯 importance 排序）
  'memory.diary.prefer_cluster': ['C4', 'on'],
  // 有簇时，L0 规则纪要最多占用材料预算的比例（0～1）
  'memory.diary.l0_fill_ratio': ['C4', 0.45],
  // 概览「嘀咕」：专用一次模型调用，只给人看、不进 memory_items；关则跳过调用
  'ui.mutter.enabled': ['C4', true],
  'persona.step_cap': ['C0', 0.15],
  'persona.learn_rate': ['C4', 0.05],
  // 五轴证据累加：窗口内同向证据 ≥ min 条、平均强度 ≥ strength，才推一次轴
  'persona.evidence.window': ['C4', 20],
  'persona.evidence.min': ['C4', 3],
  'persona.evidence.strength': ['C4', 0.25],
  // MBTI（四轴）效应挡位：off = 完全不介入；shadow = 只算不用（只更新数字）；on = 影响情绪强度与表达（默认）
  'persona.axes.mode': ['C4', 'on'],
  'affect.decay': ['C4', 0.4],
  'affect.mapping': ['C3', 'v1'],
  'affect.dynamics.formula': ['C3', 'v1'],
  // 关系动力学：v1 = 事件 → 三轴（9 号文档）；v0 = 关闭，不动关系
  'relation.dynamics.formula': ['C3', 'v1'],
  // 评价口径：v1=旧（任务相关性）；concern=关切（P1，任务顺不顺不算）
  'affect.appraise.formula': ['C3', 'concern'],
  // 事件闸门：on = 事件才改主情绪（默认）；shadow = 只记录不接管
  'affect.gate.mode': ['C4', 'on'],
  // 过闸线。0.10 比影子期松一档：句子还是任务话就过不去，语气一变就能进
  'affect.gate.theta': ['C4', 0.10],
  // 快情绪回落：τ（分钟）+ 伸展指数。τ=20、shape=1.5 → 46 秒几乎不动，5 分钟剩 0.43，1 小时 0.03
  'affect.fast.tau': ['C4', 20],
  'affect.fast.shape': ['C4', 1.5],
  // 事件生命周期：同一段情绪几分钟内再来一句话 → 复现（重新点亮并加强）；刚散场又来 → 不应期打折
  'affect.event.renew': ['C4', 20],
  'affect.event.boost': ['C4', 0.12],
  'affect.event.refractory': ['C4', 2],
  // 上升段：事件不是瞬间到顶，先走 attackStart 那一小步（占这一跳的比例），再用 attack 分钟爬满峰值
  'affect.event.attack': ['C4', 3],
  'affect.event.attackStart': ['C4', 0.5],
  'affect.event.attackShape': ['C4', 1.5],
  'condition.coef': ['C4', 2.5],
  // 驱力的设定点不在这里：它们是 drive_state.setpoint 里自己长出来的基线（见 deficit@v2）
  // v3 = v2 + 五维「重要度」权重（性格 × 价值观，Σw=5），2026-10-30 起为默认
  'drive.deficit.formula': ['C3', 'v3'],
  // 重要度开关：off 时 w ≡ 1，等价于 v2 口径
  'drive.need.weights': ['C3', 'on'],
  // 胃口倍率：0.08 的整体想多要多少。1 = 原值，2 = 两倍（2026-10-30 起默认 2）
  'drive.setpoint.appetite': ['C4', 2],
  // 满足度日回落：0.12 = 八天掉光；太慢会让缺口永远被抹平
  'drive.decay.lambda': ['C4', 0.12],
  // 主动开口门槛：0 = 跟着档位走（D0 不开口 / D1 0.22 / D2 0.15 / D3 0.10）；>0 则强制这个固定值
  'proactive.min_deficit': ['C4', 0],
  // 情绪 → 驱力：on = 过闸的情绪事件结算进满足度；off = 只记不结算
  'drive.affect.coupling': ['C3', 'on'],
  // P2 传感器 v3：shadow = 只算不接管（默认，先并行 48h 对照）；on = 替换满足度；off = 不算
  'drive.sensor.v3': ['C3', 'shadow'],
  // P3 浏览入口：on = act_browse 抓完自动落 browse_items；off = 关上这条输入线
  'drive.browse.ingest': ['C3', 'on'],
  // 夜间巩固：顺手重长价值观（force）；off = 跳过这一步
  'persona.values.nightly': ['C4', 'on'],
  // 夜间巩固：世界观 / 人生观（默认随价值观一起重长）
  'persona.worldview.nightly': ['C4', 'on'],
  'persona.lifeview.nightly': ['C4', 'on'],
  'guard.budget.c3': ['C0', 2],
}

function parseStored(raw, fallback) {
  if (raw == null) return fallback
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

/** 读实例参数；无覆盖则回落目录默认值 */
export function getParam(db, aid, key) {
  const spec = PARAMS[key]
  if (!spec) return undefined
  try {
    const row = db.prepare('SELECT value FROM agent_params WHERE agent_id=? AND key=?').get(aid, key)
    if (row) return parseStored(row.value, spec[1])
  } catch { /* 表未建时回落默认 */ }
  return spec[1]
}

/** 只读实例覆盖值；没有覆盖返回 undefined（要区分「显式改过」时用它，别用 getParam）。 */
export function getParamOverride(db, aid, key) {
  const spec = PARAMS[key]
  if (!spec) return undefined
  try {
    const row = db.prepare('SELECT value FROM agent_params WHERE agent_id=? AND key=?').get(aid, key)
    return row ? parseStored(row.value, spec[1]) : undefined
  } catch { return undefined }
}

/** 实例全部参数快照（含默认） */
export function getAllParams(db, aid) {
  const out = {}
  for (const key of Object.keys(PARAMS)) out[key] = getParam(db, aid, key)
  return out
}

/** 持久化实例参数（不校验等级；调用方负责） */
export function writeParam(db, aid, key, value) {
  if (!PARAMS[key]) err(404, 'NOT_FOUND', '参数不存在')
  db.prepare(`INSERT INTO agent_params(agent_id,key,value,updated_at) VALUES(?,?,?,?)
    ON CONFLICT(agent_id,key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`)
    .run(aid, key, JSON.stringify(value), now())
  return value
}

/** 批量写入（规则版本激活 / 批准提案） */
export function writeParams(db, aid, map) {
  if (!map || typeof map !== 'object') return 0
  let n = 0
  for (const [k, v] of Object.entries(map)) {
    if (!PARAMS[k]) continue
    writeParam(db, aid, k, v)
    n++
  }
  return n
}

export function paramsList(db, aid) {
  agent(db, aid)
  return Object.entries(PARAMS).map(([k, [level]]) => ({
    key: k, value: getParam(db, aid, k), level, direct: level === 'C4',
  }))
}

export function setParam(db, aid, key, body) {
  active(db, aid)
  if (!PARAMS[key]) err(404, 'NOT_FOUND', '参数不存在')
  const [level, def] = PARAMS[key]
  const before = getParam(db, aid, key)
  const val = body.value === undefined ? def : body.value
  // 枚举参数先校验：写个拼错的挡位不至于静默退回 shadow
  if (key === 'persona.axes.mode' && !['off', 'shadow', 'on'].includes(String(val))) {
    err(400, 'INVALID_ARGUMENT', 'persona.axes.mode 只能是 off / shadow / on')
  }
  if (key === 'affect.gate.mode' && !['shadow', 'on'].includes(String(val))) {
    err(400, 'INVALID_ARGUMENT', 'affect.gate.mode 只能是 shadow / on')
  }
  if (level === 'C0') err(409, 'GUARDRAIL', 'C0 参数只能由人离线修改', { level })
  if (level === 'C3' || level === 'C1' || level === 'C2') {
    err(409, 'PROPOSAL_REQUIRED', level + ' 参数不能直改，请发起提案', {
      draft: {
        change_class: level, target: key, before, after: val,
        requires: ['G5_EVIDENCE', 'G6_REVERSIBLE', 'G7_HUMAN'],
      },
    })
  }
  writeParam(db, aid, key, val)
  const cid = nid('chg_')
  db.prepare('INSERT INTO changes VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(cid, null, aid, key, JSON.stringify(before), JSON.stringify(val), now(), 'user', 'user', 'manual', null, null)
  return { change_id: cid, value: val }
}

export function modelStatus() {
  return model.status()
}

export const METRICS = [
  ['memory.recall_hit', '召回命中率 Recall@5'], ['memory.ndcg5', '排序质量 nDCG@5'],
  ['memory.false_recall', '误召回率'], ['memory.time_consistency', '时间一致性'],
  ['memory.cross_session', '跨会话召回'], ['memory.conflict', '冲突检出率 / 解决率'],
  ['memory.inject_usage', '注入利用率'], ['memory.forgetting_fit', '遗忘曲线拟合 R²'],
  ['memory.core_token', '注入 token 占用'],
  ['persona.identity_blind', '同一性盲测'], ['persona.role_knowledge', '角色知识准确率'],
  ['persona.style_consistency', '语气 / 风格一致率'], ['persona.value_drift', '价值观权重月漂移'],
  ['persona.taboo_violation', '禁忌违反率'], ['persona.relation_consistency', '对同一人的态度一致性'],
  ['persona.manual_conflict', '手写区与自动区冲突率'], ['persona.relation_explain', '关系三维更新可解释率'],
  ['affect.label_kappa', '标签一致率（Cohen κ）'], ['affect.intensity_mae', '强度误差 MAE'],
  ['affect.cause_accuracy', '诱因归因准确率'], ['affect.fast_slow_fit', '快 / 慢情绪分离拟合 R²'],
  ['affect.overload', '过载检测 precision / recall'], ['affect.reestimate_agree', '手动重估一致率'],
  ['affect.inertia_anomaly', '情绪惯性异常率'], ['affect.stream_lag', '工况断流告警延迟'],
  ['drive.baseline_error', '缺口基线回归误差'], ['drive.band_switch', '档位切换'],
  ['drive.saturation', '饱和率'], ['drive.proactive_answer', '主动回应率'],
  ['drive.intrude_accept', '主动打扰接受率'], ['drive.gap_behavior', '缺口—行为一致性'],
  ['drive.block_explain', '令牌与冷却拦截可解释'], ['drive.dormant_resume', '休眠恢复正确率'],
  ['self.gate_distribution', '闸门拒绝码分布'], ['self.shadow_accuracy', '影子预测准确率'],
  ['self.pass_rate', '提案通过率'], ['self.rollback_rate', '回滚率'],
  ['self.regression_rate', '变更后回归率'], ['self.mttr', 'MTTR'],
  ['self.audit_complete', '审计完整率'], ['self.revertible', '单字段可回滚率'],
  ['self.shadow_coverage', '影子覆盖率'],
  ['sys.model_switch', '换模型回归通过率'], ['sys.algo_switch', '换算法回归通过率'],
  ['sys.inject_latency', '注入延迟 p95'], ['sys.cache_hit', '前缀缓存命中'],
  ['sys.crash_recovery', '崩溃恢复成功率'], ['sys.backup_drill', '备份恢复演练通过'],
  ['exp.first_screen', '30 秒说清它是谁'], ['exp.two_clicks', '两次点击找到注入来源'],
  ['exp.trust_score', '周问卷信任度'],
  ['affect.read_accuracy', '读你准确率（你亲手纠正）'],
]

// ---------------- 学习开关与冷却（kernel 持有 flags，避免模块循环依赖） ----------------
export const LEARNING_DEFAULTS = { c4Auto: true, personaLearn: true, cooldownRounds: 6 }
export function getLearningPrefs(db, aid) {
  try {
    const row = db.prepare('SELECT value FROM flags WHERE key=?').get('learning:' + aid)
    return { ...LEARNING_DEFAULTS, ...(row ? JSON.parse(row.value) : {}) }
  } catch { return { ...LEARNING_DEFAULTS } }
}
export function setLearningPrefs(db, aid, body) {
  const cur = getLearningPrefs(db, aid)
  const next = {
    c4Auto: body.c4Auto === undefined ? cur.c4Auto : !!body.c4Auto,
    personaLearn: body.personaLearn === undefined ? cur.personaLearn : !!body.personaLearn,
    cooldownRounds: Math.max(0, Math.min(200, Number(body.cooldownRounds ?? cur.cooldownRounds))),
  }
  db.prepare('INSERT INTO flags(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run('learning:' + aid, JSON.stringify(next))
  return next
}

export function getFlag(db, key) {
  const r = db.prepare('SELECT value FROM flags WHERE key=?').get(key)
  return r ? r.value : null
}
export function setFlag(db, key, value) {
  db.prepare('INSERT INTO flags(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value))
}
export function clearFlag(db, key) {
  db.prepare('DELETE FROM flags WHERE key=?').run(key)
}
