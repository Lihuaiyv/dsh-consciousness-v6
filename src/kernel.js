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
  'memory.retrieve.formula': ['C3', 'v2'],
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
  // 每轮摘要要不要直接写进 T1 事实区（默认保留现状 on）。
  // 关掉后摘要只留在 T2 纪要里，记忆库不再被「用户关心什么」的旁白占位。
  'memory.write.summary_to_t1': ['C4', 'on'],
  // 原文层分龄：深查时默认只翻最近 N 天的对话原文（0 = 不限）；
  // 查询里有「最早/一开始/很久以前」这类词时自动放开（retrieve.oldAccountQuery）。
  'memory.recall.archive.days': ['C4', 30],
  'memory.inject.pool': ['C4', 50],
  'memory.inject.budget': ['C4', 800],
  // 行为示例：把「语气：可爱粘人」这种标签补成几条具体反应（on/off）。
  // off 时与改造前逐字一致，方便对照与回滚。
  'memory.inject.examples': ['C4', 'on'],
  // 记忆的时间与清晰度标签：（3 天前）/（3 个月前，有点糊）。off 时与改造前逐字一致。
  'memory.inject.age': ['C4', 'on'],
  // 内容级模糊：30 天以上的旧事，括号 / 数字 / 引号原话会被删掉（只删不改）。
  // 钉住的、重要度 ≥0.7、冲突类不参与；off 时只贴标签、正文一字不动。
  'memory.inject.fade': ['C4', 'on'],
  // G1「某天当时」：总开关；时间轴按 said（说话时间）还是 recorded（入库时间）切；
  // auto=on 才会在问句带过去时间时往每轮注入补「那时」段（会占上下文，默认关）。
  'memory.asof': ['C4', 'on'],
  'memory.asof.axis': ['C4', 'said'],
  'memory.asof.auto': ['C4', 'off'],
  // 模糊最多用几档：1 只删括号 / 2 再删数字 / 3 再删引号原话。默认 3（到头）。
  'memory.fade.max_level': ['C4', 3],
  // 复习抵年龄：被想起过的旧事糊得慢一点（有效年龄 = 真实年龄 ÷ 复习系数，下限 50%）。
  'memory.fade.rehearsal': ['C4', 'on'],
  // 说话模式：auto = 按最近一句判闲聊/干活；chat / work 强制。
  // 干活时不开文体约束——不然改代码会写成小作文。
  'style.mode': ['C4', 'auto'],
  // 文体清单：off 不写、soft 三条（默认）、strong 再加顺序词和小节标题。
  'style.guard': ['C4', 'soft'],
  // 冲突开案后要不要真的开口问：on = 排一条主动消息问「到底是哪个」；off = 只记进面板。
  'memory.conflict.ask': ['C4', 'on'],
  // 「浮上来」三条通道（配额制）：相关度照旧，额外给重要度锚点 / 24h 新近 / 开环固定名额。
  // 没有这几条，重要但跟这句话无关的东西永远过不了相关度门。
  'memory.float.enable': ['C4', 'on'],
  'memory.float.anchor': ['C4', 1],
  'memory.float.fresh': ['C4', 1],
  'memory.float.fresh_hours': ['C4', 24],
  'memory.float.loop': ['C4', 1],
  // 同一条开环几小时内只提一次（防每轮复读）。
  'memory.float.loop.throttle': ['C4', 6],
  // 累计重要性到多少分，把这一窗的流水账压成一条反思。
  'memory.reflect.acc': ['C4', 5.0],
  // 预取向量的等待上限（毫秒）：bge-m3 冷启动经常超过 150ms。
  'memory.retrieve.vector.wait': ['C4', 400],
  'memory.auto': ['C4', true],
  // 概览「嘀咕」：聊完后专用一次模型调用，只给人看、不进 memory_items；关则跳过调用
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
  // 慢情绪（真 EMA）：α = 追快情绪的速率，β = 回底色的速率。α+β 管「多久退掉」，α:β 管「谁更算数」。
  // α=0.09、β=0.11 → λ=0.205，τ≈4.9h；稳态里快情绪四成半、水位五成半（水位拉得回来，大事也改得动她）。
  // β 太小球会在刚才那一下上黏死；太大就只剩底色，没有余温。
  'affect.slow.alpha': ['C4', 0.09],
  'affect.slow.beta': ['C4', 0.11],
  // 恢复速度分正负：低落退得慢一点（neg=1.4 → 用时 ×1.4），被抬高退得快一点（pos=0.8 → 用时 ×0.8）。
  // 两个都给 1 就是「好坏一样快」的旧行为。
  'affect.recover.neg': ['C4', 1.4],
  'affect.recover.pos': ['C4', 0.8],
  // 恢复还要看是「哪一种」坏：说不清的闷（lost/confused）拖得久，被凶一下（irritated）反而散得快，
  // 高兴（joy/curious）散得最快，平静（calm/peaceful）居中。值是「用时倍数」，都在 1 就是只分正负。
  'affect.recover.deep': ['C4', 1.3],
  'affect.recover.sharp': ['C4', 0.9],
  'affect.recover.bright': ['C4', 0.8],
  'affect.recover.soft': ['C4', 1],
  // 底色自己的波浪（叠在段式慢波上）：日节律 + 累积负荷。
  // 日节律：一天一个来回，相位随 agent 定；0 = 关。
  'affect.baseline.circadian': ['C4', 0.06],
  // 激素纹：水位上的脉冲（一两个小时一个尖，有大小、有安静的时候）+ 1/f 漂移，
  // 刻意不平滑——真实激素不是一条漂亮的正弦。0 = 退回旧的三层平滑底色。
  'affect.baseline.rough': ['C4', 0.08],
  // 长周期：十几到三十几天一个来回，一天里根本看不出来（要拉「一月」才看得到）。
  'affect.baseline.cycle': ['C4', 0.07],
  // 累积负荷（allostatic load）：一直偏着，水位本身被拖走；没刺激就代谢回来。
  // gain 大 / tau 长 = 几天缓不过来；都小 = 没心没肺。
  'affect.baseline.load.gain': ['C4', 0.01],
  'affect.baseline.load.tau': ['C4', 168],
  // 睡眠：两段对话之间的夜里长空档。睡着时回落更快（λ × 这个倍数），醒来重置一部分。
  // lambda=1 等于「睡着和醒着一样慢」，重置=0 等于「醒来不重置」，两个都给 0/1 就是旧行为。
  'affect.sleep.lambda': ['C4', 1.5],
  'affect.sleep.reset': ['C4', 0.06],
  // 不可逆的那一层：水位的随机游走。sd 是稳态标准差（0 = 关，退回纯函数底色），
  // tau 是「走散了多久会被拉回来」的时标（小时）。带状态、存库，重算不会变回原样。
  'affect.walk.sd': ['C4', 0.03],
  'affect.walk.tau': ['C4', 36],
  // 节律被经历改写：深夜（23:00–06:00）还在说话，日节律的相位就往后挪一点（分钟/次，一小时最多一次），
  // 平时按 tau 小时慢慢收回。nightShift=0 = 相位永远不动（旧行为）。
  'affect.circ.nightShift': ['C4', 12],
  'affect.circ.cap': ['C4', 180],
  'affect.circ.tau': ['C4', 72],
  // 快慢耦合：同一句刺激，水位低的时候反应更大、水位高的时候更扛得住。
  // 0 = 关掉（谁说的话都一样重，旧行为）；0.5 = 水位差 1 倍时反应差 ±50%。
  'affect.couple.gain': ['C4', 0.5],
  // 自发扰动：很久没人说话的时候，偶尔自己心里动一下（没来由的烦 / 松一口气）。
  // rate = 每 24 小时几次；idle = 至少要空多久才掷；mag = 那一下的强度。rate=0 关掉。
  'affect.spont.rate': ['C4', 0.6],
  'affect.spont.idle': ['C4', 3],
  'affect.spont.mag': ['C4', 0.12],
  // 事件生命周期：同一段情绪几分钟内再来一句话 → 复现（重新点亮并加强）；刚散场又来 → 不应期打折
  'affect.event.renew': ['C4', 20],
  'affect.event.boost': ['C4', 0.2],
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
