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
    status: '在用',
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
      'src/features.js',
      'index.js',
      'src/push.js',
      'src/modules/qq_push.js',
      'client.js',
    ],
    entry: 'runSpeakTick（src/parts/speak/index.js）',
    exam: { file: 'test/exam-speak.test.mjs', score: '21/21', note: '判断该不该说（事由/气头/安静/开关/额度/破例/计费），21 道' },
    assert: null,
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
    rollback: { pointer: 'speak-before-swap', note: '回退 = git checkout speak-before-swap -- src/features.js' },
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
    assert: null,
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
      'src/modules/pack.js',
      'index.js',
    ],
    entry: 'retrieve / deepRecall（src/modules/retrieve.js）',
    exam: { file: 'test/exam-recall.test.mjs', score: '76/76', note: '路由 / 证据门 / 实体与扩词 / 融合与重排 / 锚点与配额 / 深翻 / 遗忘阈值，76 道' },
    assert: null,
    swaps: [],
    rollback: { pointer: 'recall-before-part', note: '回退 = git checkout recall-before-part -- src/modules/parts.js docs/给人看的/零件-召回.md，再删 test/exam-recall.test.mjs' },
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
