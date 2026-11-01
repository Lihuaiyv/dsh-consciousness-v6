# 分层记忆（T0–T4）

> 一套库、五个分区、一个热度账本。目标：**原文不丢、事实可用、日记成篇、检索有先后**。

## 1. 为什么是五个分区

分区不是越多越好。每多一个分区，就多一份写入路径、一份迁移、一份“它为什么不一致”的排查成本。
判断标准只有一条：**访问模式不同才分区**。

| 分区 | 内容 | 访问模式 | 量级 | 存哪 |
|---|---|---|---|---|
| **T0 自我** | persona / 关系 / 禁忌 / 价值观 | 每轮必带，极小 | 几 KB | 现有表 |
| **T1 事实** | 蒸馏出的语义记忆（memory_items） | 每轮按句召回 | 百~千条 | 现有表 |
| **T2 纪要** | 会话切段压缩（L0 规则；L1 精修；L2 忙天簇修） | 写日记时、回看时 | 每天数条～数十段 | `episodes` |
| **T3 日记** | 一天一篇第一人称 | 展示、注入最近两天 | 一年 365 篇 | `diaries` |
| **T4 原文** | 完整对话，逐句 | **几乎不读**，只在“翻原话”时 | 万级 | `raw_turns` |
| **T4 存根** | 每条事实**出生时**的原样一句话 | 只在“我当初记的是什么”时 | 等于事实数 | `fact_archive` |

再加两个**不存正文的索引**，都不是新分区：

- `memory_items.heat / band`（热度账本）决定短期/中期/长期。
- `memory_timeline`（时效索引，G1）只记「这条记忆何时出生、改写、作废、有争议」，用来回答「某天当时算数的是哪一版」。正文仍从冷库取。

为什么不拆成 6~8 个：把“偏好/承诺/情绪记忆”再拆表，查询就要跨表 union，而它们的访问模式完全一样。
**同一访问模式的东西放一张表，用 `type` 区分**，比拆表便宜。

## 2. 表结构

```sql
-- T4 原文：只追加，永不改写；一句一行
raw_turns(id, agent_id, session_id, turn_id, seq, role, text, tool, meta, created_at, day)
raw_fts(id UNINDEXED, text)            -- trigram，供“翻原话”用

-- T4 事实存根：事实出生时的那句话 + 当时的参数，只追加（UNIQUE agent_id, memory_id）
fact_archive(id, agent_id, memory_id, text, type, tier, mark,
             importance, salience, confidence, fact_key, source_turn_id,
             source, payload, created_at)
fact_fts(id UNINDEXED, text)           -- trigram，供“我当初怎么记的”用

-- 时效索引（G1）：只追加、无正文。一条记忆的一生是一串事件，查询时投影成区间
memory_timeline(seq, agent_id, memory_id, op, at, valid_from, cause_id,
                text_ref, reason, actor, approx)
-- op：ADD / REVISE / INVALIDATE / REACTIVATE / DISPUTE_OPEN / DISPUTE_CLOSE / HIDE / UNHIDE / DELETE / SYNC

-- T2 纪要：同会话可多段 seg（UNIQUE agent_id, session_id, day, seg）
-- L0 规则底稿 → L1 高分段模型精修(source=model) → L2 忙天 __day_cluster__ 时段要点
episodes(id, agent_id, session_id, day, seg, start_at, end_at, turns,
         title, summary, topics, beats, mood, open_loops,
         importance, hits, last_hit_at, source, created_at)

-- T3 日记：一天一篇（UNIQUE agent_id, day），可重建，version 递增
diaries(id, agent_id, day, text, mood, highlights, refs, source, version, created_at, updated_at)

-- 热度账本（memory_items 上的列）
importance, salience, hits, last_hit_at, heat, band, confidence, source_turn_id, fact_key
```

原文是真相，纪要和日记都是**投影**：坏了可以按天重算，原文永远不动。

## 3. 写入路径

```
用户说一句 ──▶ captureTurn ──▶ raw_turns + raw_fts        （同步，先落冷库；day=本地日历日）
模型回一句 ──▶ commitTurn  ──▶ raw_turns                  （同步）
                    │
                    ├─ 每 6 轮 ──▶ buildEpisodes(session, day)  （L0 切段纪要；不覆盖已有 L1 精修稿）
                    ├─ 每轮 ──▶ extract_queue ──▶ ingest ──▶ memory_items（按轮抽取，source=extract）
                    └─ 每天 23:00 ──▶ L0 重算 → L1 精修 → L2 簇修
                                       → 纪要蒸馏(M1/M2, source=episode) → buildDiary
                                       （日记有模型用模型，没有用模板；错过由下次启动补）

蒸馏出一条事实 ──▶ addMemory ──▶ memory_items + fact_archive（同一事务：存根先留底；
                               episode 蒸馏的存根 payload 带 episode_id/day/seg）
                    │
                    └─ 同一笔写入 ──▶ memory_timeline（ADD / REVISE / INVALIDATE / …）
                       改口、软删、冲突开案/结案、巩固丢弃都走这里，不在别处改 invalid_at / text
```

- 用户那句先落库：**哪怕这一轮最后没回复、被中断，原话也不会丢**。
- 同一句 3 秒内重复到达（重放 / 重复事件）只算一次；隔很久的同一句话是真说过两次，保留。
- 旧数据：启动后一次性把 `chat_turns` 迁进 `raw_turns`（session 记为 `legacy`），再按天压纪要。

## 4. 读取路径

| 场景 | 读什么 | 不读什么 |
|---|---|---|
| 每轮对话 | T0 + 最近两天日记 + T1 按句召回 | T4 |
| “你还记得…?” | T1（必要时 T2/T3） | T4 |
| “我原话怎么说的” | T4 `searchRaw` | — |
| “我当初是怎么记这件事的” | T4 `searchFactArchive` | T1（已经被改过） |
| “某天当时记得什么” | 时效索引定位版本，冷库出原句（`retrieveAsOf`） | 不加热度、不加命中 |
| 写日记 | T2 + 当天 T1 | T4（只数条数） |

「那时」只在显式查询时走。对话里自动补一段要 `memory.asof.auto=on`（默认 off）；开了也只在问句带过去时间（「半年前」「去年三月」）时插入，并标「那时·当时有效 / 期间改过 / 当时有争议 / 历史陈述」。

| 参数 | 默认 | 含义 |
|---|---|---|
| `memory.asof` | on | 关掉后，接口和工具都不做「那时」查询 |
| `memory.asof.auto` | off | 对话预取是否自动插入「那时」段 |
| `memory.asof.axis` | said | `said` 按说出口的时间；`recorded` 按入库时间 |

注入顺序（`clampInjection` 超预算时从后往前丢）：
主动开口 → 情绪 → 驱力 → **日记** → 相关记忆。

## 5. 短期 / 中期 / 长期

不是三张表，是每条记忆自己的 `band`：

```
heat = 0.40·重要度 + 0.22·新鲜度 + 0.18·强化 + 0.10·钉住 + 0.10·情绪显著度
新鲜度 = 0.5 ^ (距上次被想起的天数 / 半衰期)
半衰期 = 30 天 × (1 + 2×重要度)      // 重要的淡得慢
强化   = min(1, log(1+命中次数) / log(9))

band: 钉住 / heat≥0.52              → short（桌面，应少）
      60 天内                       → mid
      更老且 heat≥0.45              → mid（还烫才留）
      其余                          → long
```

默认事实出生热度约 0.42，进中期；只有够烫或钉住的才上桌面。
「近两天一律短期」会把桌面堆满，已去掉。
也不能用「heat≥0.30 即 mid」：importance≥0.75 时 0.40·importance 地板就把长期堵死了。

召回时档位只加一个小偏置（short +0.03 / mid +0.015 / long 0），**不乘总分**——
乘上去会让“档位高但只是勉强相关”的条目压过真正相关的那条。

强化：被召回一次 → `hits+1`、`last_hit_at` 拨到现在、热度重算。
所以“最近总被提起的事”热度抬上去，会自己升回短期，不需要人工维护。

档位规则换版时启动会按新规则重算一次（`tiers.bootstrapped.v2`），之后随写随算 / 夜巡 / 召回强化。

**但页面上看到的是「此刻」的账，不是库里的快照。** 列里的 `heat / band / temp_state` 只在夜巡（23:00）
或召回强化时被写一次，而新鲜度是按秒在衰减的——照着存档显示，数字会一整天不动。所以三个读接口
（`/memory/top`、`/memory/timeline`、`/memory`）都走 `nowRow()`（`src/modules/tiers.js`）：
按请求时刻重算 `heat / band`，额外给一个 `temp_now`（温度状态机按现在算的目标档位），
**不覆盖**存档的 `temp_state`——注入那边按存档判 cold / archived，改语义会连带改行为。

`/memory/top` 按档配额取数（默认每档 `limit/3`），并回 `counts`（全量各档条数），避免总榜前 N 全是短期。

前端：热度卡展开着时每 10 秒重算一次，时间线每 20 秒；折叠关着、窗口切到后台就停。
想连注入排序一起跟上，点「写回库」（`POST /v1/agents/:id/tiers/refresh`）。

## 6. 日记

`buildDiary(day)` 每天 23:00 由巩固 worker 跑一次（`DSHC_DIARY_HOUR` 可改小时），写的是**当天**；过了零点它就是前端「昨天的日记」那一篇。关机 / 休眠错过不丢：下次启动（以及每半小时的兜底检查）会把「到点没写、但还有原料」的天按天补写，补的那几篇 `late=1`，前端标「补写」；最多回看 7 天（`DSHC_DIARY_BACKFILL_DAYS` 可改，0 = 不补），那天一句原文都没有就不写。具体：

1. 取当天纪要 + 当天新增事实 +（纪要很少时）原文抽样 + 心情 / 口吻；
2. **选料**（`packDiaryMaterial`）：预算默认 5500 字、完整 JSON；`memory.episode.min_diary_importance` 跳过低分；
   `memory.diary.prefer_cluster=on`（默认）时，有 L2 簇修则主吃簇+精修，L0 只按 `memory.diary.l0_fill_ratio`（默认 0.45）补洞；
3. 心情优先取**该日** `affect_episodes`（`mood_source=day`），没有再退当前 `affect_state`（`live`）；
4. 有可用模型 → 写 200–400 字第一人称散文；失败则半预算重试一次，再失败退模板；
5. 输出过 `isPromptEcho` / 过短检查；正文超长在句号处截断（`clipDiaryBody`）；
6. 没有模型 / 失败 → 模板拼材料事实，**不编细节**，`source='rules'` + `fail_reason`；
7. 同一天自动任务默认不覆盖；面板「按当前纪要重写」或 `POST .../diaries/rewrite` / 巩固 `force` 可重写（version+1）；
8. 巩固账做过但日记行丢了 → `runNightly` 会走修复只补日记（`repaired`），不整日 skip。

打包构成写入 `context.write.pack`（`n_cluster` / `n_model` / `n_rules` / `prefer_cluster` / `retry_of`…），前端 chip 可见。

文本统一整理成「2026-10-28 周三 + 空行 + 正文」；日记进系统提示只带最近两天。

成文优化计划见 `docs/diary-from-episode-plan-v1.md`（D0–D4）。

## 7. 事实存根（T4 出生照）

一条事实**第一次被蒸馏出来**时，除了写进 `memory_items`，还在 `fact_archive` 留一张原样快照：
同一句话、当时的重要度/显著度/置信度、来源轮次。两者在同一个事务里写，记忆落库它必落库。

为什么要有：`memory_items` 那一行是会变的——热度衰减、档位升降、被冲突推翻（`invalid_at`）、
被去重合并、被软删。半年后想回答“我当时到底记的是什么”，主表已经答不出来，存根还能。

- **只写一次**：`UNIQUE(agent_id, memory_id)`，之后再调 `archiveFact` 直接返回老 id，绝不改写。
- **不参与召回**：它不在 S1 的任何一路上，只走“翻旧账”的显式查询，平时零成本。
- **老库补一次**：启动时 `backfillFactArchive` 把已有事实按当前版本补一张，`source='backfill'` 标明是补的。
- **什么时候会没**：只有“明确硬删”（软删满 7 天后的清理、或删掉整个意识体）才连存根一起清。
  答应要忘的东西必须真忘，不能主表删了、冷库还留着。

## 8. 接口

```
GET  /v1/agents/:id/archive?day=&session=&limit=      # 原文时间线
GET  /v1/agents/:id/archive?q=咖啡                    # 原文检索（只在这里读 T4）
GET  /v1/agents/:id/archive/facts?limit=&offset=      # 事实存根时间线
GET  /v1/agents/:id/archive/facts?q=生日              # 存根检索
GET  /v1/agents/:id/sessions                          # 会话目录
GET  /v1/agents/:id/episodes?day=                     # 纪要
GET  /v1/agents/:id/diaries/:day                      # 单日日记（含 context.write）
POST /v1/agents/:id/diaries/rewrite                   # 按当前纪要 force 重写（body.day）
GET  /v1/agents/:id/diaries/:day                      # 某天日记
GET  /v1/agents/:id/tiers                             # 档位统计 + 最热 10 条
POST /v1/agents/:id/tiers/refresh                     # 重算热度
GET  /v1/agents/:id/memory/as-of?q=&at=               # 某时刻当时（或 from=&to=，axis 可选）
GET  /v1/agents/:id/memory/:mid/history               # 单条记忆的版本时间线
```

工具 `memory_search` 另有 `as_of`（日期或「去年三月」）和 `axis`。

写接口仍要 `Idempotency-Key`。

## 8. 迁移与兼容

- schema 仍是 9：新表、新列都是**增量**，旧库打开即补，不重写旧行。
- 旧行 `band` 默认 `mid`；规则换版时启动按 `tiers.bootstrapped.v2` 重算。只有够烫（heat≥0.52）或钉住的进 `short`。
- `chat_turns` 保留不动（其它模块还在用）；`raw_turns` 是它的冷层副本 + 会话 id。
- 导出/导入包含 `episodes / diaries / raw_turns`，导入后重建 `raw_fts`。

## 9. 怎么验收

- `node test/tiers.test.mjs`：41 条，覆盖热度/档位/原文去重/纪要/日记/召回强化。
- `node test/run-tests.mjs`：404 条，原有功能不回归。
- 手工：`GET /tiers` 看 short/mid/long 分布；`POST /consolidation/run` 补当天 / 补漏；`GET /archive?q=` 搜原话。

## 10. 已知边界

- 日记的“模型版”要 `model.status().primary === 'ok'`（宿主 llm 或外部 OpenAI 兼容接口），否则是模板版（模板不编，但也不润色）。`diaries.source` 会写 `model` / `rules`，前端据此标「模型写的 / 模板拼的」。
- 纪要每 6 轮压一次；超长会话的当天纪要会被后续轮次覆盖更新。
- 原文目前不分文件；到几十万句再考虑 `archive.db` 分库或按月归档。
- 面板还没接这套新接口（旧“日记 / 传记”按钮仍走 `/diary` 摘要）。

## 11. 检索骨架（P1a）

```
用户这句话 ──▶ 路由 ──▶ 分区内取候选 ──▶ 证据门 ──▶ RRF ──▶ top-k
              S1/S2/S3        T1/T2/T3/T4      0.35/0.30/0.20   按名次加权
```

- 路由：规则关键词表。S1 最高分 < 0.25 或一条都不过门 → 升级 S3；S2 无命中 → 也升级 S3（都有 `why` 说明）。
- 证据分 `E = max(FTS 词价, 实义 2-gram 覆盖率)`。实义 = 不含虚词（的/了/这/只/是…）的 gram；
  只有 FTS 套话命中、实义词一个不中时，E 打 4 折——不然「是不是」能骗过门。
- 门只看 E，不看热度：**两门分离**，调新鲜度不会把该想起的整批挡掉。
- RRF：`score = Σ w_p / (60 + rank_p)`，只混名次不混原始分。S1 权重 T1 1.0（T3 到 P4 才挂载）；
  S2 T2 1.0 / T4 0.7；S3 平权。
- 缓冲：内存 20 条，**不直接注入**（运行时已给最近几轮，再塞一遍白花配额）；只用于重启时从 `raw_turns` 重放与调试。
- 触发词（上次 / 说的 / 那个）先剥掉再检索，原句只用于场景判定与解释。
- T4 片段进注入前压到 120 字、去换行（一行长回复能吃掉 200 token）。
- 开关：参数 `memory.retrieve.formula`，默认 `v3`（分层 / RRF / 实体 / 向量）；显式写成 `v2` 才走老 `recall`。
- 调试：`GET /v1/agents/:id/retrieve?q=&scene=&k=` 返回 scene / why / 每分区 counts 与 kept / 每条 E 与 rrf。
- 向量：写入后异步 embed；S1 不带 cold/archived；有 embedding 能力才开通道。
  进程内 IVF 近似索引（`memory.retrieve.vector.index=auto|bruteforce|off`），可回退全量余弦；覆盖率不足时标低覆盖，不假阴性硬挡。
- 未做：T4 按月分表；完整 Graphiti 双时态图（轻量 `memory_links` 见升级规划 U4；硬化见 [memory-upgrade-plan-v2.md](./memory-upgrade-plan-v2.md) H0–U8）。

## 12. 装箱与仲裁（P1b）

```
召回 top-k ──▶ 跨分区去重 ──▶ 分段配额 ──▶ 超总预算按优先级丢 ──▶ 注入行
```

- 去重：去标点后字面相同、或字符集 Jaccard ≥ 0.92 且两边都不短 → 视为同一件事，
  只留优先级高的分区（T0 > T1 > T3 > T2 > T4）。短句（< 8 字）不做模糊匹配，避免误杀。
- 配额：buffer 100 / T1 300 / T3 120（T3 到 P4 才用）；单段超了丢排名靠后的。
- 总预算：默认 800；每轮检索实际只占 400（buffer 100 + T1 300），其余留给 T0 等固定段。
- 丢弃顺序：T4 → T2 → T3 → T1 → buffer（越冷越先丢，固定注入区最后）。
- 估 token：中文按 2 字符 ≈ 1 token，与 `clampInjection` 同一套。

## 13. 回放日志（观测）

- 表 `retrieval_log`：每次召回一行 —— `scene / query / why / counts / kept / dropped / items / tokens / ms`。
- 只写、不读热路径；写失败静默（日志不能成为单点）；默认留 30 天，写入时 2% 概率顺手清旧行。
- `GET /retrieval-log?days=&limit=&scene=` 看明细；`GET /retrieval-stats?days=` 看分场景汇总。
- 汇总给三样东西：调用量、平均召回条数 / token / 耗时、**空手率**。
  空手率高且候选多 = 门槛太紧；候选也少 = 查询太偏（或库里真没有）。
- 面板「记忆分层」页底部显示最近 7 天汇总。
- 调试：`GET /retrieve?q=…&pack=1` 会多返回 `packed`（行、token 数、丢弃清单）。
- 向量 / 实体 / 图一跳均已接入 S1（见 §11、§14）；T0 手写槽位与 T1 抽取的仲裁仍未做（T0 不进检索，由人格段直接注入）。
- 空手率：`GET /retrieval-stats`；CI 金标见 `npm run eval:memory`（中文夹具门槛）。
- 升级批次 U0–U5：见 [memory-upgrade-plan-v1.md](./memory-upgrade-plan-v1.md)。

## 14. 写入侧：门控 / 实体 / 队列（P2 + U0/U2/U3）

```
每轮对话 ──▶ enqueueExtraction（落库，指纹去重）
                 │
                 ▼ 每 30 秒
              worker ──▶ ingest ──▶ model.extract ──▶ 门控 ──▶ addMemory
                                                          │
                              新增 / 合并 / 改写(UPDATE) / 冲突 / 删除 / 丢弃
夜巡另：纪要蒸馏 → 同门控；实体别名合并；事实 consolidate
```

- **门控**（`gate.js`）作用于抽取 / 蒸馏 / remember；纯手写 `addMemory` 可绕过。
  - 极性相反且相似 ≥ 0.50 → 冲突（两条都留，走原有 conflicts 流程）
  - 相似 ≥ 0.92，或同实体 ≥ 0.80 → 合并：只给旧条 `hits+1`、权重 +0.02，不新增
  - 同 `fact_key` 或（同实体 + 相似≥0.72 + 同极性）→ **UPDATE** 改写正文，`version+1`，旧句进 `fact_archive`（`memory.write.reconcile`，可关）
  - 显式 `op=delete|noop` 尊重；默认 add
  - **极性判断排在合并 / UPDATE 之前**；改口默认开冲突（`memory.write.flip_policy=conflict`，U6）
  - 习惯句（每周/每天…）写入抬重要度并打 `habit.*`；S1 可对冷习惯字面窄穿透（`memory.retrieve.habit_cold`，U7）
- **日模型硬顶**（`memory.llm.daily_cap`，默认 16）：refine / cluster / diary / distill / extract 共用；
  distill 满额或总顶见底 → 同日 extract pending 延后（`llm_budget.js`）。
- **实体**（`entities.js` + `entity_resolve.js`）：规则 NER 作底；夜巡可合并别名、回填 `entity_id`。
- **consolidate**：自省仍走模型合并；`memory.consolidate.facts` 另规则合并同 key / 同实体高相似事实（极性相反不吞）。
- **轻量边**（U4）：蒸馏同批 `from_episode`；句式可打 `likes` / `decided`。**不是**双时态 KG。
- **队列**（`extract_queue.js`）：`pending → running → done / failed`；失败退避 30s→60s→…→1h，
  5 次标 failed，可 `POST /extract-queue/retry` 手动重试；done/failed 记录留 7 天。
- 接口：`GET /entities`、`GET /entities/:id`、`GET /extract-queue`、`POST /memory/remember`；
  工具 `memory_search` / `memory_remember`；列表带 `source_badge`。

## 15. 冲突升级与可追溯（P3）

```
写入判定为冲突 ──▶ conflicts(open, high, evidence)
                        │ 3 天没管 → 升 1 级
                        │ 7 天没管 → 满级 + 3 级告警（+R05 降权）
                        ▼
                  人拍板：keep = a / b / both
```

- `evidence`：当时算出的相似度、双方原文片段、严重度、判定种类 —— 让「凭什么判成冲突」可复述。
- 时间线：开案 / 升级 / 解决都写 `events`（`memory.conflict*`），按 `conflict_id` 串成一条。
- 升级**不替人做决定**：只改 `escalation_level` 与告警；已处理的冲突不再升级。
- 严重度：涉及身份 / 禁忌关键词或权重 ≥ 0.8 → `high`；低风险（`low`）两条都留、不进待办。
- 接口：`GET /conflicts`、`GET /conflicts/:id`（详情 + 时间线）、`GET /conflicts/stats`、
  `POST /conflicts/:id`（解决）、`POST /conflicts/escalate {id}`（手动升级）。

## 16. 夜间巩固（P4）

```
每天 23:00 定时器 ──▶ runNightly(当天) ──▶ ① 各会话补纪要(T2)
                                          ② 写当天的日记(T3，有模型用模型)
                                          ③ 重算热度档位
                                          ④ 清过期回放日志 / 抽取队列
                                          ⑤ consolidation_log 记一行

关机 / 休眠 / 挂起错过 23:00
   └─ 下次启动（15 秒后）+ 每 30 分钟兜底 ──▶ dueDiaryDays()
         └─▶ 到点没写、并且有原料的天，逐天 runNightly(补)   （late=1，前端标「补写」）
```

- 补写：定时器晚到不再整天跳过；只要过了当天 23:00 还没写，就在下一次有机会时补，最多回看 7 天（`DSHC_DIARY_BACKFILL_DAYS`，0 = 关掉，只准点写）。
- 只补有原料的天：那天没有原文 / 纪要 / 新事实（一直没开机），就不生成，不编不存在的一天。
- `UNIQUE(agent_id, day)`：同一天只做一次，`force` 才重做（内部补写用）；`GET /consolidation?days=` 看历史。
- **T3 挂进 S1**：`SCENE_WEIGHTS.S1 = { T1: 1.0, T3: 0.6 }`；日记召回窗口 30 天，更老的按日期直取。
- 巩固不调用 LLM（除非日记那段需要）；没有模型时走模板，结果确定性可复现。
- 接口：`GET /consolidation`、`POST /consolidation/run {day, force}`。

## 17. 遗忘区状态机（P5）

```
         30 天内 ≥3 次想起
   cold ────────────────▶ hot        （往上升：一次就生效）
     ▲                      │
     │ 90 天没用             │ 新鲜度掉了
   warm ◀───────────────────┘        （往下降：连续 2 次才迁移）
     │ 180 天没用
     ▼
 archived
```

- 列：`temp_state`（hot / warm / cold / archived）、`state_since`、`state_streak`。
- 迟滞只挡「变冷」，不挡「变热」：记起来的东西立刻回到 hot，避免整批在 hot/warm 之间抖。
- `mark=locked` 永不下沉；taboo / promise 属于 T0，本来就不在这套里。
- **只影响 S1**：`searchFacts(..., {includeCold:false})` 挡掉 cold / archived；S2 / S3 传 true 穿透。
- 推进时机：每晚巩固里跑一次；`POST /temps/tick` 可手动；`GET /temps` 看四档分布。
- 这不是删除：原文、事实、存根都还在，只是不再占每轮注入预算。

## 18. 多天模拟（`npm run sim:days`）

`scripts/sim-memory-days.mjs` 用**假时钟**把整条管线在内存库里跑 N 天：不调 LLM、不连宿主，
每天两轮对话 + 当天抽取 + 入队/worker + 夜间巩固 + 冲突升级，最后跑 5 道召回题、若干「那时」题和不变量检查。
第 130 天会把「改喝手冲」这条冲突按新说法结案，好让后面的「那时」题有一段「有争议 → 已定」的历史。

```
npm run sim:days            # 默认 200 天
npm run sim:days -- 365     # 一年
```

实测（G1 后，2026-11-01，200 天）：原文 600、日记 199、纪要 199、活跃事实 7、时效事件 13、冲突 1 条且已结案、召回 **5/5**、不变量含「那时」探针 **18/18**。60 天跑不考核 day120 之后的改口和「那时」题，召回仍是 5/5。

H0–U8 时的对照：60 天召回 5/5、200 天召回 5/5，那时还没有「某天当时」这一问。

说明：旧表「60 天 4/5 游泳 miss」含剧本日序假阴性（游泳曾埋在 day90）；H0 已校准。

模拟抓到的两个真问题（已修）：

1. **极性判断被「不加糖」带偏**：整句扫否定词会把「喜欢咖啡，不加糖」判成否定句，于是
   「不喜欢咖啡了」和它被判成同极性、不冲突。改成**看共享片段前面**有没有否定词（`polarityFlip`）。
2. **门控判了冲突但没留下冲突记录**：`addMemory` 自己的相似度更低，把这条放过了，结果两条矛盾事实
   并存、却查不到任何冲突。改成门控判冲突时自己落 `conflicts` + 告警 + 事件。
3. **同一次改口开了两条冲突**（G1 仿真抓到）：回调没传 `skipConflict` 时，`addMemory` 和门控各插一行。
   结案只关其中一条，另一条会一直挂着。门控发现同一对已经有待裁记录就复用，不再插第二行。

## 19. 记忆仓库与日记导出（前端）

- `vault.js` 给前端两个能力：`warehouse`（各分区条数 / 字节 / 占比 + 整库大小）与 `exportDocs`（写成人能读的文件夹）。
- 导出结构（默认 `~/.dsh/consciousness/docs`）：

```
docs/
├── 日记/2026/10/2026-10-28.md     ← 一天一篇，带 front matter
├── 纪要/2026/10/2026-10-28.md
├── 事实/事实.md
└── 原文/2026/10/2026-10-28.md
```

- `openFolder` 只允许打开导出根目录内的路径（防越界），Windows 用 `explorer.exe`。
- 日记写的时候快照状态：`diaries.context` = { big5, values, affect, drive, relation }；
  口吻由 `diaryTone(context)` 推出，模板选开句、模型进 prompt。
- 前端组件：`VaultCard`（仓库 + 导出/打开）、`DiaryView`（只读日记 + 状态标签，补写的天带「补写」）。
- 已删除：`DiaryPanel`、`ArchivePanel`、`TierPanel`、`DiaryFolder`（年/月树，入口「所有日记」已去掉）。

## 20. 「浮上来」：开环 / 配额 / 反思 / 观测

前面的召回是**被问才想起来**：`retrieve()` 只在有查询时跑，相关度是硬门，重要但跟这句话无关的东西永远不会出现。
第 20 节加的是「没人问也自己冒出来」的四条通道，全部挂在既有管线上，不替换打分。

### 20.1 开环 `open_loops`（时间通道）

- 表：`open_loops(id, agent_id, kind, text, memory_id, source_turn_id, due_at, stale_after, state, fired_at, fire_count, closed_at, closed_by, created_at, updated_at)`。
- 写入：`features.ingest` 对新落库的条目跑 `detectLoop()`（答应 / 明天 / 回头 / 还没 / 待办 …）；带 due 的按 `parseDue()` 算到点时间，没 due 的两天后算「挂着」。
- 浮现：`index.js` 每轮 `surfaceLoopLine()` 取一条进系统提示（section `loop`），不参与召回打分、不过证据门。
- 节流：同一条 6 小时内只提一次；提满 5 次自动 `expired`；用户说「好了 / 搞定了」且两小时内提过 → `user_done` 关掉。
- 参数：`memory.float.loop`（每轮几条，默认 1）、`memory.float.loop.throttle`（默认 6 小时）。

### 20.2 配额制（重要度锚点 + 24h 新近）

- 相关度照旧（RRF → rerank → MMR → 相对门），但给锚点和今日新近各留一席：`k - anchor - fresh` 条给相关通道。
- `importanceAnchors()`：钉住的（mark=locked）排最前，其次 `type ∈ fact / conflict` 且 `importance ≥ 0.7`。
  **不收 reflection / appraisal**：线上 455 条 reflection 里大半是每日摘要，importance 顶到 0.95 也是流水账，
  让它们占锚点位等于每轮复读摘要。
- `freshFacts()`：`fresh_hours`（默认 24h）内新落的条目，**不收 reflection**（摘要不算「今天发生的」）。
- 自动升级到 S3 的轮次**也算**每轮注入——那正是「什么都没命中」的时候，最需要翻出重要的。
- 工具查询（`keepAll`）不掺配额，它要的是「我要查的那层」。
- 参数：`memory.float.enable`、`memory.float.anchor`、`memory.float.fresh`、`memory.float.fresh_hours`。

### 20.3 累计重要性 → 反思

- 表：`reflect_cursor(agent_id, acc, window_start, last_reflect_at, updated_at)`。
- 每次 ingest 后把新条目的 `importance` 加进游标；过 `memory.reflect.acc`（默认 5.0）就后台 `reflectFrom()`：
  这一段流水账压成一条 `reflection`（≤100 字、跨事件），**只压 `importance < 0.5` 的**——身份 / 偏好 / 承诺原样留着。
- 白天没跑成的，夜间巩固（`nightly` ⑤c）补一次。
- `TYPE_WEIGHT.reflection` 0.55 → 0.75：不然反思写完就被类型权重压死。

### 20.4 注入标注 + 会话续接

- 锚点行带「（一直记着的）」、新近行带「（今天刚发生）」；记忆块标题注明「这几条是你自己先想起来的，可以自然提起」。
- 跨天开场加一行「上次（YYYY-MM-DD）你们聊到…＋没收尾的事」（`archive.sessionBridge`），同一天不重复说。

### 20.5 观测：浮现率

- 表：`surfaced_items(id, agent_id, memory_id, kind, text, at, used, used_at)`。
- 每轮注入后 `recordSurfaced()`；收到回复后 `markSurfacedUsed()` 按 2-gram 覆盖率 ≥0.3 判「用上了」。
- `surfacingStats()` 给出 `surfaced / used / rate`（按 kind 分开：anchor / fresh / related）；观测表只留 60 天，不进任何召回路径。
- `scripts/sim-float.mjs` 做同语料对比（关 / 开配额）；`test/float.test.mjs` **64/64**。

### 20.6 回滚

- `memory.float.enable=off` 退回纯相关度（配额与开环都关）；`reflect_cursor` / `surfaced_items` / `open_loops` 都是加表，删表即可复原，不改任何老字段。
