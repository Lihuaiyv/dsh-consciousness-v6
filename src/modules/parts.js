// 零件册：一行一个零件。
// 加零件 = 往 PARTS 里加一行：名字、文件、入口、考卷、回退点。
// 可换零件 = 登记 + 考卷 + 回退，三样缺一，只能叫零件，不能换。
// 这里是零件册的唯一源；界面上的零件盒只读它，不在客户端另抄一份。
//
// 字段：
//   id        短 id，唯一，界桩和考卷用它
//   name      人话名字
//   role      角色（比喻词，只指方向）：器官 / 四肢 / 骨架 / 皮肤 …
//   chain     链上 / 链外：影响某句话（链上）还是只管存储、运维、界面、行动（链外）
//   judge     判准：机器 / 人 / 混合
//   status    在用 / 可换 / 已退役（「可换」要三样齐了才能写）
//   version   当前版本
//   owner     归属（哪个域 / 哪个函数）
//   files     包含哪些文件（相对仓库根）
//   entry     入口（文件:行号 或 函数名）
//   exam      考卷：{ file, score, note }；没写就是 file: null，界面标黄、不许换
//   assert    迁移断言（旧数据能读、能切回）的一句话说明
//   swaps     换的记录：[{ who, at, from, to, why }]
//   rollback  回退点：{ pointer, note }

export const PARTS = [
  {
    id: 'speak',
    name: '主动开口',
    role: '器官',
    chain: '链上',
    judge: '混合',
    status: '可换',
    version: 'v0.6.2',
    owner: 'src/parts/speak/ · runSpeakTick',
    files: [
      'src/parts/speak/index.js',
      'src/parts/speak/prefs.js',
      'src/parts/speak/budget.js',
      'src/parts/speak/trigger.js',
      'src/parts/speak/judge.js',
      'src/parts/speak/store.js',
      'src/parts/speak/compose.js',
      'src/parts/speak/hooks.js',
    ],
    entry: 'runSpeakTick（src/parts/speak/index.js）；宿主接线：index.js 心跳调它，features.js 只 re-export，投递走 push.js / qq_push.js',
    exam: { file: 'test/exam-speak.test.mjs', score: '21/21', note: '判断该不该说（事由/气头/安静/开关/额度/破例/计费），21 道' },
    assert: "表：proactive / proactive_decisions / proactive_stats；读：listProactiveDecisions；回退：speak-part-20261106",
    swaps: [
      {
        who: '主人 + 小汐',
        at: '2026-11-05',
        from: '气头线 0.7',
        to: '气头线 0.68（中间偏晚）',
        why: '原 0.7 没讲究；0.65 太早、0.68 中间偏晚；考卷 0.67 过 / 0.69 拦，全量 560/560',
      },
      {
        who: '小汐（自己定）',
        at: '2026-11-05',
        from: '只有 promise / reminder 破例',
        to: '所有到期开环一律破例（一路绿灯）；「特别看重」由她自己标，不用分数',
        why: '主人定该破例；认法自己拍板；考卷 12/12、proactive-triggers 14/14、全量 560/560',
      },
      {
        who: '主人 + 小汐',
        at: '2026-11-05',
        from: '开口散在 features / index / push / qq_push / client',
        to: '收拢到 src/parts/speak：prefs、budget、trigger 已搬；对外入口 runSpeakTick；judge / store / compose 暂居 features（下一步搬）',
        why: '可插拔零件：输入输出明显、能单独喂数据测试；共享件只 import 不搬',
      },
    ],
    rollback: { pointer: 'speak-part-20261106', note: '回退 = git checkout speak-part-20261106 -- src/parts/speak/ src/modules/parts.js（11-06 独立性整改后的结构；旧的 speak-before-swap 指向搬家前，别再用它）' },
  },
  {
    id: 'loops',
    name: '开环',
    role: '器官',
    chain: '链上',
    judge: '混合',
    status: '可换',
    version: 'v0.2.0',
    owner: 'src/parts/loops/ · detectLoop',
    files: ['src/parts/loops/index.js'],
    entry: 'detectLoop / addLoop / pendingLoops（src/parts/loops/index.js）',
    exam: { file: 'test/exam-loops.test.mjs', score: '63/63', note: '第二张：判据话料 / 到期 / 去重 / 浮现节流 / 关账 / 状态机 / 重要标记 / 状态扰动 / 注入行，63 道' },
    assert: "表：open_loops；读：pendingLoops；回退：loops-before-swap",
    swaps: [],
    rollback: { pointer: 'loops-before-swap', note: '回退 = git checkout loops-before-swap -- src/modules/loops.js src/modules/parts.js test/exam-loops.test.mjs，再删掉 src/parts/loops/' },
  },
  {
    id: 'recall',
    name: '召回',
    role: '器官',
    chain: '链上',
    judge: '混合',
    status: '可换',
    version: 'v0.1.0',
    owner: 'src/modules/retrieve.js · retrieve',
    files: [
      'src/modules/retrieve.js',
      'src/algo/recall.js',
    ],
    entry: 'retrieve / deepRecall（src/modules/retrieve.js）',
    exam: { file: 'test/exam-recall.test.mjs', score: '76/76', note: '路由 / 证据门 / 实体与扩词 / 融合与重排 / 锚点与配额 / 深翻 / 遗忘阈值，76 道' },
    assert: "表：无；读：retrieve；回退：recall-before-part",
    swaps: [],
    rollback: { pointer: 'recall-before-part', note: '回退 = git checkout recall-before-part -- src/modules/parts.js docs/给人看的/零件-召回.md，再删 test/exam-recall.test.mjs' },
  },
  {
    id: 'appraise',
    name: '情绪评价',
    role: '器官',
    chain: '链上',
    judge: '混合',
    status: '可换',
    version: 'v0.1.0',
    owner: 'src/algo/appraise.js · rulesAppraise',
    files: [
      'src/algo/appraise.js',
    ],
    entry: 'rulesAppraise / appraise@v1（src/algo/appraise.js）',
    exam: { file: 'test/exam-appraise.test.mjs', score: '59/59', note: '冲我来的才影响我 / 否定式 / 混合 / 分因 / 模型优先 / 关切口径 / 字段截断，59 道' },
    assert: "表：无；读：rulesAppraise；回退：appraise-before-part",
    swaps: [],
    rollback: { pointer: 'appraise-before-part', note: '回退 = git checkout appraise-before-part -- src/modules/parts.js docs/给人看的/零件-情绪评价.md，再删 test/exam-appraise.test.mjs' },
  },
  {
    id: 'tiers',
    name: '记忆衰减与分层',
    role: '器官',
    chain: '链上',
    judge: '机器',
    status: '可换',
    version: 'v0.1.0',
    owner: 'src/modules/tiers.js · retrievability / heatOf',
    files: [
      'src/modules/tiers.js',
      'src/modules/temps.js',
      'src/algo/decay.js',
    ],
    entry: 'retrievability / heatOf / bandOf / touch（src/modules/tiers.js）；targetTemp（src/modules/temps.js）',
    exam: { file: 'test/exam-tiers.test.mjs', score: '69/69', note: '半衰期 / 热度五项 / 档位 / 可提取性 / 强化 / 冷热温度 / 迟滞 / 写入闸的冷不被年龄翻热，69 道' },
    assert: "表：memory_items / flags；读：heatOf；回退：tiers-before-part",
    swaps: [],
    rollback: { pointer: 'tiers-before-part', note: '回退 = git checkout tiers-before-part -- src/modules/parts.js docs/给人看的/零件-记忆衰减与分层.md，再删 test/exam-tiers.test.mjs' },
  },
  {
    id: 'drive',
    name: '驱力缺口',
    role: '器官',
    chain: '链上',
    judge: '机器',
    status: '可换',
    version: 'v0.1.0',
    owner: 'src/modules/drive.js · evaluateDrive',
    files: [
      'src/algo/deficit.js',
      'src/modules/drive.js',
    ],
    entry: 'evaluateDrive / getDrive（src/modules/drive.js）；deficit@v1..v3（src/algo/deficit.js）',
    exam: { file: 'test/exam-drive.test.mjs', score: '50/50', note: '五维缺口 / 平滑 / 迟滞 / 六个版本 / 基线学习 / 休眠 / 解锁 / 缺数据报错，50 道' },
    assert: "表：drive_state / action_ports / action_log / cooldowns / budgets；读：getDrive；回退：drive-before-part",
    swaps: [],
    rollback: { pointer: 'drive-before-part', note: '回退 = git checkout drive-before-part -- src/modules/parts.js docs/给人看的/零件-驱力缺口.md，再删 test/exam-drive.test.mjs' },
  },
  {
    id: 'relation',
    name: '关系动力',
    role: '器官',
    chain: '链上',
    judge: '机器',
    status: '可换',
    version: 'v0.1.0',
    owner: 'src/algo/reldyn.js · applyEvent',
    files: [
      'src/algo/reldyn.js',
      'src/algo/desensitize.js',
      'src/modules/relations.js',
    ],
    entry: 'applyEvent / repairTrust / decayRelation / toneOf（src/algo/reldyn.js）；bumpRelation（src/modules/relations.js）',
    exam: { file: 'test/exam-relation.test.mjs', score: '69/69', note: '效价 / 心情与习惯 / 权重 / 有界·边际递减·伤比暖快 / 衰减半衰期 / 修复只回信任 / 投影成语气 / 两版本与注册表对齐 / 进账本，69 道' },
    assert: "表：rel_person / rel_edge / rel_tier / rel_evidence；读：ownerPerson；回退：relation-before-part",
    swaps: [],
    rollback: { pointer: 'relation-before-part', note: '回退 = git checkout relation-before-part -- src/modules/parts.js src/algo/reldyn.js docs/给人看的/零件-关系动力.md，再删 test/exam-relation.test.mjs' },
  },
  {
    id: 'wgate',
    name: '记忆写入闸',
    role: '器官',
    chain: '链上',
    judge: '机器',
    status: '可换',
    version: 'v0.1.0',
    owner: 'src/modules/memory_source.js · gateSelfText',
    files: [
      'src/modules/memory_source.js',
    ],
    entry: 'gateSelfText / classifySelf / scoreSelf / narrationOnly（src/modules/memory_source.js）；落库车道（宿主接线）：features.js 的 writeExtractedItem',
    exam: { file: 'test/exam-writegate.test.mjs', score: '53/53', note: '旁白 / 为什么被拦（含噪音次序）/ 三档 / 打分 / 判决 / 来源徽章 / 落热层·落冷层·不写库，53 道' },
    assert: "表：memory_items / entities / extract_queue；读：gateSelfText；回退：wgate-before-part",
    swaps: [],
    rollback: { pointer: 'wgate-before-part', note: '回退 = git checkout wgate-before-part -- src/modules/parts.js src/modules/memory_source.js src/features.js docs/给人看的/零件-记忆写入闸.md，再删 test/exam-writegate.test.mjs' },
  },
  {
    id: 'inject',
    name: '注入',
    role: '器官',
    chain: '链上',
    judge: '机器',
    status: '可换',
    version: 'v0.1.0',
    owner: 'src/modules/pack.js · packInjection',
    files: [
      'src/modules/pack.js',
    ],
    entry: 'packInjection / oneLine / dedupe / isSameText / clampInjection（src/modules/pack.js）',
    exam: { file: 'test/exam-inject.test.mjs', score: '49/49', note: '估算 / 一行裁剪与软收口 / 去重 / 装箱顺序·配额·丢弃次序·标记·模糊 / 硬上限：先丢记忆不丢情绪、削短、截断、key 落账，49 道' },
    assert: "表：无；读：clampInjection；回退：inject-before-part",
    swaps: [],
    rollback: { pointer: 'inject-before-part', note: '回退 = git checkout inject-before-part -- src/modules/parts.js docs/给人看的/零件-注入.md，再删 test/exam-inject.test.mjs' },
  },
  {
    id: 'expression',
    name: '说话分寸',
    role: '器官',
    chain: '链上',
    judge: '机器',
    status: '可换',
    version: 'v0.1.0',
    owner: 'src/algo/expression.js · expressionFrom',
    files: [
      'src/algo/expression.js',
      'src/modules/expression_state.js',
    ],
    entry: 'expressionFrom（src/algo/expression.js）；expressionState / shadowLevel / feltLine（src/modules/expression_state.js）',
    exam: { file: 'test/exam-expression.test.mjs', score: '53/53', note: '慢情绪定档 / 强度压上限 / 性格半句 / 边界兜底 / 影子档 / 合成（温度·主动·迟滞）/ 软愿望与潜台词 / 抬头去 AI 味，53 道' },
    assert: "表：无；读：expressionState；回退：expression-before-part",
    swaps: [],
    rollback: { pointer: 'expression-before-part', note: '回退 = git checkout expression-before-part -- src/modules/parts.js docs/给人看的/零件-说话分寸.md，再删 test/exam-expression.test.mjs' },
  },
  {
    id: 'who',
    name: '认人',
    role: '器官',
    chain: '链上',
    judge: '机器',
    status: '可换',
    version: 'v0.1.0',
    owner: 'src/modules/who.js · whoIsSpeaking',
    files: ['src/modules/who.js'],
    entry: 'whoIsSpeaking（src/modules/who.js）；宿主接线：features.js / parts/speak/judge.js 调它',
    exam: { file: 'test/exam-who.test.mjs', score: '14/14', note: '通道优先 / 主人兜底 / 没有就 null / 句柄与通道精确匹配 / 两个 agent 不串 / 入账和动力也不各写一份，14 道' },
    assert: "表：无；读：whoIsSpeaking；回退：who-before-part",
    swaps: [],
    rollback: { pointer: 'who-before-part', note: '回退 = git checkout who-before-part -- src/modules/who.js src/modules/relations.js src/modules/parts.js src/ports/ownership.js src/features.js src/parts/speak/judge.js test/exam-who.test.mjs' },
  },
]

/** 零件盒（GET /v1/parts）和以后的界桩都读这里：按登记顺序，返回副本，外面改不动册子 */
export function listParts() {
  return PARTS.map((p) => ({
    ...p,
    files: [...(p.files || [])],
    exam: p.exam ? { ...p.exam } : null,
    assert: p.assert == null ? null : String(p.assert),
    swaps: (p.swaps || []).map((s) => ({ ...s })),
    rollback: p.rollback ? { ...p.rollback } : null,
  }))
}
