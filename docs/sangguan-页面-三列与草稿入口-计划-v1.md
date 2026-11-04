# 三观页 · 三列 + 草稿入口 · 实施计划 v1

> 状态：**已实现并验证**（2026-11-03）。完成情况与前后数据见 `docs/sangguan-页面-改造-完成报告-v1.md`。

> 承接 `sangguan-改造-完成报告-v1.md`（步骤 0–4 已完成）。本计划只做两件事：把页面改成三列判据，把草稿做成页面上的入口。顺带把前一轮留下的三个收口项补齐（lanes 暴露、日记 intake、J1 只抽 V）。

## 0. 一句话

现在三观页是「三层竖排 + 每层一堆命题 + 页头三个数」，看不出 W/L/V 是三种不同的东西。改成三列并排、每列写清自己的判据、各自的证据长什么样；V 列挂一个草稿收件箱，草稿是 V 层唯一入口，人批过才入库。页头三个数搬到概览页的「它靠不靠谱」。

## 1. 已有能力怎么接（不重复造）

| 已有 | 代码位置 | 页面/接口怎么用 |
|---|---|---|
| 三列开关 | `config.js` `laneOn` / `setSangguanConfig({lanes})` | 每列顶部一个开关；`publicConfig` 现在没暴露 `lanes`，要补 |
| 三列闸 | `gates.js` `gateW/gateL/gateV` | 草稿卡「为什么没过」的五句话；W/L 的核心「怎么长出来的」 |
| 草稿生成 | `draft.js` `clusterByForegone` / `gatesOf` / `buildDrafts` / `commitDraft` | 收件箱主体与入库动作，原样复用 |
| 取料规则 | `scripts/sangguan-draft.mjs` 里的 HONESTY / REDO / TRADEOFF / 去重 | 抽成 `draftfeed.js`，脚本与页面共用一份 |
| J32 反事实标注 | `templates.js` J32（已写好，尚未有调用方） | 起草流水线第一步；按批 8–10 条一次 |
| J33 起草 | `templates.js` J33 + `buildDrafts` | 起草流水线第二步 |
| 常驻宪章 | `constitution.js` `buildConstitution` | 三列顶部「常驻三行」预览 + 每列核心句 |
| 情境召回 | `recall.js` `recall` / `recallLines` | 「拿一句话试试它会想起什么」 |
| 注入视图 | `inject.js` `buildLaneView` / `injectView(opt.query)` | 预览框直接复用，不新增一套 |
| 合并去重 | `merge.js` `mergeClaims` | 本期不做界面，只留「重复了吗」的提示位（见 §7 不做） |

## 2. 页面长什么样

```
┌ 世界观 W ──────────────┐ ┌ 人生观 L ──────────────┐ ┌ 价值观 V ──────────────┐
│ 判据：能预测事、经得起撞 │ │ 判据：走过哪几章、花了多久 │ │ 判据：选了这边、放弃了什么 │
│ [这一列开着]            │ │ [这一列还没开 · 打开]     │ │ [这一列开着]            │
│                         │ │                         │ │                         │
│ 世界大体可以被理解       │ │ 先把日子过明白           │ │ 诚实比体面更要紧         │
│ · 人多数时候愿意讲道理   │ │ 第 2 章 · 自 10-28       │ │ 平时：…  仰望：…         │
│ 在争：该先听还是先答     │ │ 投入：12 天 / 34 次      │ │ 取舍：两样都要，代价…     │
│ 怎么长：3 个场景都这样，  │ │ 怎么长：这一周的回信里，  │ │ 怎么长：2 次真选了这边，   │
│ 预言过 4 次、错了 1 次   │ │ 有 5 天在真的做           │ │ 放弃了省事 / 面子         │
└─────────────────────────┘ └─────────────────────────┘ └─────────────────────────┘
         ┌ 草稿 2 条，等你批 ─────────────────────────────┐
         │ 拿一句话试试它会想起什么：[______________]      │
         │ 这一刻会想起：你更看重：诚实比体面更要紧          │
         └─────────────────────────────────────────────────┘
┌ 草稿箱 ─────────────────────────────────────────────────┐
│ 「宁可慢一点，也别把话说满」                              │
│ 另一条路 … / 代价 … / 边界 … / 反例 …                    │
│ [有另一条路 ✓][说了代价 ✓][能排除 ✓][不是工作 ✓][两次以上 ✓]│
│ 证据：11-01 那一句 · 11-03 那一句       [改] [入库] [丢掉] │
└──────────────────────────────────────────────────────────┘
它最近在想什么 / 预见与回流 / 史 / 旧维度仪表（都折叠，保留）
```

三个数（说过的没做到 / 答应的事兑现了 / 自己改了主意）从三观页移除，落到概览页「它靠不靠谱」卡里，位置在百分比下面。

## 3. 数据契约

### 3.1 新表（`schema.js` 追加，纯新增，不动账本）

```sql
CREATE TABLE IF NOT EXISTS sangguan_drafts(
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  kind TEXT NOT NULL,              -- 放弃物类别：时间/准确/被喜欢/省事/安心/面子/其他
  text TEXT NOT NULL,
  alt TEXT, foregone TEXT, cost_to TEXT,
  exclusion TEXT, boundary_json TEXT, counterexample TEXT,
  evidence_json TEXT NOT NULL,     -- [{ref,at,quote}]
  cluster_json TEXT,               -- 聚类现场，重算 G5 用
  gates_json TEXT NOT NULL,        -- {g1..g5,pass}
  status TEXT NOT NULL,            -- draft | edited | committed | discarded
  source TEXT NOT NULL,            -- llm | manual
  vouch INTEGER NOT NULL DEFAULT 0,-- 手写时人自己勾的「我认」
  batch_key TEXT,
  claim_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_sgd_agent ON sangguan_drafts(agent_id, status, created_at);
```

草稿是「还没进账本的东西」，所以不设只增触发器，可以改；入库那一刻才走 `commitDraft` 写账本。删表不影响历史。

### 3.2 接口

| 方法 | 路径 | 权限 | 返回 |
|---|---|---|---|
| GET | `/sangguan/status` | viewer | 追加 `lanes`、`constitution{tokens,lines}`、`drafts{pending,running}` |
| GET | `/sangguan/drafts?status=draft,edited` | viewer | `{drafts:[…], job:{status,started_at,error,created}}` |
| POST | `/sangguan/drafts` | user | 新建一条手写草稿（source=manual），body 同 patch；返回含 gates 的整条 |
| GET | `/sangguan/drafts/:id` | viewer | 单条（含 cluster、gates） |
| POST | `/sangguan/drafts/:id/patch` | user | 改 text/alt/foregone/exclusion/boundary/counterexample/evidence/vouch → 按 `source` 重算 gates，status=edited |
| POST | `/sangguan/drafts/:id/commit` | user | 五闸全过才写；`commitDraft(..., {human:true})`，status=committed + claim_id |
| POST | `/sangguan/drafts/:id/discard` | user | status=discarded |
| POST | `/sangguan/drafts/generate` | user | 起一轮起草（后台跑），立刻回 `{job}`；正在跑 → 409 |
| GET | `/sangguan/recall?text=…` | viewer | `{core,picked,candidates}`（已有 `recall()`，只加路由） |
| GET | `/sangguan/inject/preview?text=…` | viewer | 现有接口加 `text` 透传，`injectView(...,{query})` |

配置：`PUT /config {lanes:{W:true}}` 已支持，页面只需要按钮；`publicConfig` 加 `lanes` 回显。

### 3.3 五闸的力度（手写与自动分档）

手写草稿也过五闸，但同一条闸的**取证方式**不同，不搞两套标准：

| 闸 | 自动草稿（source=llm） | 手写草稿（source=manual） | 为什么这么拿捏 |
|---|---|---|---|
| G1 有另一条路 | `alt` 非空 | 非空，允许「当时也可以不这样」这种口气 | 没有另一条路就是口号，这条不能松 |
| G2 有代价 | `foregone` 非空且不是「没什么 / 无」 | 同上，但「代价是时间 / 面子」这类短语算过，不要求写成句子 | 人写的时候通常只写关键词，硬要句子会逼出套话 |
| G3 能排除 | `exclusion` 非空 | 非空；允许「这件事上我不会那样做」 | 读不出「不会怎么做」就不是判断 |
| G4 不是任务 | 窄任务词表 + 不以日期开头 | 同一套词表 | 这是上一轮吃过的亏，手写更不能放 |
| G5 有重复证据 | ≥2 条、跨 ≥2 天（`clusterByForegone` 保证） | **≥1 条带日期的证据 + 人自己勾「我认」**（`vouch`） | 自动稿是从一次偶发里猜的，所以要两次；手写是人自己担保，一次真事就够，但要留下担保记录 |

具体落法：

- `gatesOf(d, cluster, opt)` 增加 `opt.source`，默认 `'llm'`，行为不变；`manual` 时 G5 换成「evidence 里至少一条有合格的 `at`（YYYY-MM-DD 起）+ `d.vouch === true`」。
- 手写的证据可以是一句原话加日期，也可以是「从最近的取舍现场里点一条」带进去（`mineEpisodes` 的结果直接给表单选），`ref` 可空。
- 正文长度：自动 40–90 字（J33 提示词要求，不做硬闸）；手写 6–120 字，太短写不成判断，太长多半是解释。
- 入库仍然只有一条路：`commitDraft(d, {human:true})`；`source:'manual'` 与 `vouch` 一起写进草稿行，tech 视图能查。
- 不为手写另开「强制入库」；过不了就改到过，或丢掉。

### 3.4 起草任务

- 状态存 `flags`：`sangguan.draftjob:<aid>` = `{status:'running'|'done'|'error', started_at, ended_at, created, error}`。
- 只在内存里 `void run()`，不 await（HTTP 不阻塞）；重复点由 running 状态挡。
- 夜巡里每周一次：`job_key = sg:draft:<isoWeek>`，只有 `lanes.V` 开着才跑，走 `trap()`，失败只记 `JOB_DONE.payload.errors`。

## 4. 分步（每步做完先模拟、修完再下一步）

### P1 数据层：草稿表 + store
- 新增 `draftstore.js`：`createDraft`（带 `source`，30 天同文去重）、`listDrafts`、`getDraft`、`patchDraft`（按 `source` 调 `gatesOf(...,{source})` 重算五闸）、`markCommitted`、`markDiscarded`、`pendingCount`。
- `draft.js` 的 `gatesOf` 加第三个参数 `opt.source`（默认 `llm`，行为不变）；`manual` 分支见 §3.3。
- `schema.js` 加表；`projection.js` 不碰。
- 测：`test/sangguan-draftstore.test.mjs`（建/列/改/丢弃/去重/闸重算；手写一条只有一条证据 + 勾了「我认」能过、没勾不过；自动稿仍要两条跨天）。
- 判据：不改 `draft.js` 的旧调用路径，现有 `sangguan-draft` 24 项仍绿。

### P2 取料共用：`draftfeed.js`
- 把脚本里的 `HONESTY / REDO / TRADEOFF / NOISE / HER`、`mineCorrected / mineStated / minePledges / countRepeats / dedupe` 抽成模块，导出 `mineEpisodes(db, aid, {limit,max})`。
- `scripts/sangguan-draft.mjs` 改为 import 它，CLI 参数与产物不变。
- 测：`test/sangguan-draftfeed.test.mjs` 用同一段假数据比对抽取结果（条数、kind、trigger）。
- 判据：脚本跑一次输出条数与改造前一致（真库只读，不写）。

### P3 起草流水线：`draftrun.js`
- `runDraftRound(db, aid, {now, ask, batch=8})`：
  1. `mineEpisodes` 取料（上限 60）；
  2. 分批 J32 标注（`{kind, items}` → `{items:[{i,alt,foregone,cost_to}]}`），坏格式丢弃；
  3. `clusterByForegone`（≥2 条、跨 2 天）；
  4. `buildDrafts`（J33，一簇 2–3 版）；
  5. 逐条 `createDraft`（source=llm，batch_key）。
- `startDraftRound(db, aid)`：查 running → 置 running → `void run()` → 写 done/error；包 try/catch，绝不把异常抛到 HTTP。
- 测：`test/sangguan-draftrun.test.mjs`（注入假 ask，覆盖：正常出稿、J32 坏格式、簇不够、running 拒绝、去重）。
- 判据：假 LLM 下从 6 条取舍现场到 ≥1 条过闸草稿；再次运行不重复入库。

### P4 HTTP 接口
- `api.js` 加 §3.2 全部路由；`publicConfig` 加 `lanes`；`status` 加 `lanes/constitution/drafts`。
- `api.js` 的 `inject/preview` 分支把 `query.get('text')` 透传给 `injectView`。
- 测：`test/sangguan-drafts-api.test.mjs`：权限（viewer 不能改）、闸未过不能 commit、commit 后账本有 V/norm 且 `origin:'user'`、重复 discard、running 409。
- 判据：curl 全通；`x` 关着时 GET 只回 `{enabled:false}` 的现有约定不破。

### P5 页面三列
- 新 CSS：`.dshc-sg3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}`，`@media(max-width:980px)` 变单列。
- 改 `SangguanPage`：
  - 删掉页头 `SgLedgerBar` 与三个 `headLine`；
  - 三列各一个 `<section>`（保留 `sectionOf('世界观')` 这类断言可用的结构），列内 = 判据一句 / lanes 开关 / 核心句（无则 `SgSeed`）/ 辅助条（≤3）/ 本列在争 / 「怎么长出来的」一句；
  - L 列的投入数据取 `laneStats()`（见下）；V 列底部显示「草稿 N 条等你批」并可跳到草稿箱；
  - 召回预览框：输入一句 → `GET /recall?text=` + `GET /inject/preview?text=`，显示「常驻三行 + 这一会儿会想起」；
  - 预见与回流 / 它最近在想什么 / 史 / 旧仪表保留，放在三列之后，史与旧仪表默认折叠。
- `laneStats(db, aid, now)`（`lanes.js` 导出）：W 的场景数、预言 settled/hit/miss；L 的投入天数与次数（复用 `investOf`）；V 的草稿/已入库数。
- 测：更新 `test/sangguan-page.test.mjs`：三列在同一个 grid 容器里、每列有判据句、L 列有投入、页头不再有三个数；tech 视图仍露 π/id。
- 判据：真机刷新后三列并排，窄屏变单列，无术语（用户视图）。

### P6 草稿箱 UI + 数字搬家
- `SgDraft` 组件：正文（可编辑）、另一条路/代价/边界/反例、五个闸的小标签（不过的标红并写人话）、证据两三条、`改` / `入库` / `丢掉`；`入库` 在不过闸时禁用。
- `写一条` 入口（手写草稿）：正文 / 另一条路 / 代价 / 边界 / 反例 + **证据**（一句原话加日期，或从最近 `mineEpisodes` 的候选里点一条带进来）+ **「这条我认」勾选**。边写边算闸，每道闸旁边直接写「还差什么」，比如「G1：写下当时也可以怎么做」。不预填句式，不塞模板句。
- 草稿箱头部：`现在起草` + `写一条` 两个按钮，运行中「正在翻最近的取舍…」+ 上次结果一句；空态写清「这几天没有值得写成三观的事」，并给 `写一条` 小入口。
- `SimpleHome`：加 `useAsync(GET /sangguan/scorecard?days=30)`，在「它靠不靠谱」卡里渲染 `SgLedgerBar`（复用，tech=false）。
- 测：扩展 `sangguan-page.test.mjs`：自动草稿卡渲染、点入库后账本多一条 `V/norm origin=user`、丢弃后列表少一条、手写一条只能过四闸时「入库」禁用且提示缺哪道、补上证据和勾选后可入库、概览页出现三个数。
- 判据：用户视图能从「看到草稿 / 自己写一条」走到「入库」，全程零术语，手写不被迫写成套话。

### P7 收口（前一轮的三个尾巴）
- `intake.js`：`lanes.L` 开着时不再把 `diaries` 搬进 L（关着时保持旧行为，逐字不变）。
- `fast.js`：`lanes.W` / `lanes.L` 开着时，J1 提示词只抽剩下的层；两层都关时仍抽 V。
- `night.js`：加 `runDraftRound`（每周、仅 `lanes.V`、走 `trap`）。
- 测：`sangguan-intake-lane.test.mjs`（开 L 后日记不进候选、关 L 后恢复）、`sangguan-j1-lane.test.mjs`（假 LLM 检查不再产出 W/L）。
- 判据：开着三列跑一夜，第二天 L 列只有章节、没有日记原文。

### P8 全量回归 + 真机
- `test:sangguan`、`test:sangguan:long`、`run-tests` 全绿；
- 备份真库 → 重启 DSH → 打开三观页 → 开 W、跑一次「现在起草」→ 批一条 → 看注入预览 → 对比改动前后页面截图与数据（草稿条数、注入 token、三列内容）。
- 写 `sangguan-页面-改造-完成报告-v1.md`：前/后对照、发现并修的问题、剩余不做项。

## 5. 兼容与回滚

- 新表纯新增，删掉即回退；账本无新事件类型（起草只写 `JOB_DONE`）。
- 页面改动没有功能开关，但数据全来自老接口 + 新接口；新接口 404 时页面应降级为「草稿箱暂不可用」，不整页崩（`useAsync` 的 error 分支）。
- `lanes` 默认全关：关着时三列照常显示，但每列标「这一列还没开」，V 列的自动起草不跑，只显示手工草稿。
- 分数卡搬家不删组件，只改调用点；想退回去只改一处。

## 6. 测试清单

| 文件 | 覆盖 |
|---|---|
| `sangguan-draftstore.test.mjs` | 建/列/改/弃/去重/闸重算（含手写分档） |
| `sangguan-draft-gates-manual.test.mjs` | `gatesOf(...,{source:'manual'})`：一证 + 我认能过；一证不勾不过；两条跨天但没勾也不过；任务词/日期开头仍拦；自动分支逐字不变 |
| `sangguan-draftfeed.test.mjs` | 取料规则与脚本一致 |
| `sangguan-draftrun.test.mjs` | J32→聚类→J33→入库；坏格式；running；幂等 |
| `sangguan-drafts-api.test.mjs` | 权限、闸、commit 写账本、404 |
| `sangguan-intake-lane.test.mjs` | L 开时日记不再进 L |
| `sangguan-j1-lane.test.mjs` | W/L 开时 J1 不再抽 W/L |
| `sangguan-page.test.mjs`（改） | 三列、判据、投入、草稿箱、概览三个数 |
| `sangguan-lanes-e2e.test.mjs`（扩） | 端到端：开三列 → 夜巡 → 草稿 → 人批 → 注入 |

## 7. 本期不做（写清，免得以为漏了）

- 合并/去重的界面（`merge.js` 已有能力，等真出现重复再说）。
- J34 模型二段召回（仍走字面召回，够用且零成本）。
- 草稿「从 CLI 文件导入」；页面只认库里的草稿。
- 月度复盘指标进 `eval.js`。

## 8. 风险

- **LLM 起草慢/贵**：J32 每批 8 条、上限 60 条 → 最多 8 次 T1 + 每簇一次 T2；只手动触发 + 每周一次，失败不重试。
- **J32 输出不稳**：严格校验，缺字段就丢该条，不猜；整批坏就记 error，不出半成品。
- **页面测试的假 React**：新组件避免 `useEffect` 与受控输入以外的副作用；编辑框用本地 state，测试只点按钮。
- **三列信息密度**：用户视图每列最多 3 条辅助 + 1 张在争卡，超出折叠到「全部」；tech 视图才全量。
