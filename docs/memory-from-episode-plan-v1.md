# 意识体 v6 · 纪要→记忆规划 v1

> 现状：**纪要（T2）已优化；纪要→记忆（T1）尚未优化**。两边是从原文分叉的平行投影，不是一条流水线。  
> 原则：对齐纪要三级（L0 规则 · L1 精修 · L2 簇修）——少次、有上限、失败回退、原文不丢、忙天扛得住。  
> 对照画布：`episode-vs-mainstream` · 本文件配套 `memory-from-episode`。

---

## 0. 一句话现状

```
raw_turns ──┬── L0/L1/L2 ──► episodes (T2) ──► diaries (T3)     ← 已做完
            │                      │
            │                      └── M1/M2 distill ──► memory_items (source=episode)  ← 已落地
            └── 每轮 extract_queue ──► ingest ──► memory_items (source=extract)         ← 仍保留
```

- 夜巡在 L2 之后、日记之前跑 `distillEpisodesForDay`（参数 `memory.episode.distill*`，可关）。
- 按轮抽取仍在；门控 merge 负责去重。忙天可 `prefer_cluster` 只蒸章节。
- 召回：S1 仍以 T1+T3 为主；`source=episode` 的事实正常进 S1；可选 `memory.retrieve.episode_topic_boost`。

---

## 1. 范围与不做

**做**

- 把高分 / 精修 / 簇修纪要当作**蒸馏入口**（对齐 Graphiti `add_episode`、Letta sleep-time）。
- 仍走现有 `applyWrite` / `addMemory` / `fact_archive`（门控、存根、冲突不另起炉灶）。
- 日限额 + 关参；失败保留「仅按轮抽取」旧路径。
- 忙天优先抽纪要、降级或合并按轮抽取，避免双烧模型。
- 检索侧：纪要衍生事实可追溯；可选 S1 轻量蹭最近纪要主题（不做向量大改）。

**不做（本版）**

- 上 Neo4j / 完整 Graphiti 双时态图。
- 每句、每段纪要无脑抽事实（对标「每轮 extract」的线性烧钱）。
- 用日记全文当唯一记忆源（日记是文学投影，事实源仍是纪要+原文）。
- Nomi 式手改图谱整页（可后续另立）。
- 重跑公开 LoCoMo harness（可在 M4 后单独立项评测）。

---

## 2. 产品语义（冻结）

| 点 | 行为 |
|----|------|
| 真相层 | 仍是 T4 `raw_turns`；事实可废可并，原文不动 |
| 纪要 | 仍是「发生了什么」卡片；**不是**事实库本身 |
| 记忆 T1 | 稳定偏好 / 身份 / 决定 / 关系断言；要能回答「你还记得…」 |
| 入口优先级 | L1/L2 纪要 > L0 高分纪要 >（降级）按轮抽取 |
| 写入 | 必须过 `applyWrite`：new / merge / conflict / drop |
| 溯源 | 新事实带 `source=episode`（或 `episode_distill`）+ `payload.episode_id` / day / seg |
| 模型日预算（建议） | 纪要蒸馏 ≤ **6** 次/天；与 L1(8)+L2(1)+日记(2) **分开计数**，总建议硬顶 ≤ **16** |
| 失败 | 蒸馏失败不挡巩固；当天仍可有按轮事实 |

与纪要批次对齐的叫法：

| 纪要 | 记忆侧对应 |
|------|------------|
| L0 规则底稿 | **M0** 候选挑选 + 规则可抽「硬断言」试水（零或极少模型） |
| L1 金标精修 | **M1** 高分纪要 → 模型抽 1～3 条事实 |
| L2 忙天簇修 | **M2** 忙天用簇修章节当批次输入（一天少次） |
| 日记打包 | **M3** 检索/注入对齐（事实进 S1；纪要主题轻助推） |
| 文档 UI | **M4** 来源标签、开关、对账 |

---

## 3. 主流对照（只比「情节→长期记忆」）

| 产品/项目 | 情节单元 | 怎么变成长记忆 | 模型花费 | 相对你们现在 | 你们应对齐什么 |
|-----------|----------|----------------|----------|--------------|----------------|
| **你们现状** | T2 纪要已强 | **没有**吃纪要；按轮 `extract` | 近似随轮次涨 | — | 接上「episode→fact」 |
| **Mem0** | 对话片段 `add()` | LLM 抽事实 + 与旧记忆 reconcile（现倾向 ADD-only） | 每批约 1～2 次 | 事实工业化；缺可读日卡 | **蒸馏+对账**；保留你们门控 |
| **Graphiti / Zep** | 显式 `add_episode` | 实体+边；旧边 invalid；双时态 | 每 episode 常 3+N 次，贵 | 时序/矛盾最强 | **以纪要为 episode 入口**；时态先做轻量 invalid |
| **Letta** | 消息 + archival | Agent 工具写记忆 + **sleep-time** 整理 | 闲时算力 | 自管笔记强 | **夜巡蒸馏**对齐 sleep-time |
| **LangMem** | 热路径工具 + 后台 manager | 后台 extract/consolidate/update | 可后台化 | 框架味重 | 后台队列你们已有，改**输入从轮→纪要** |
| **MemoryOS / Hindsight** | 短中长期分层 | 中期段/观察再提炼 | 分层批处理 | 分层像你们 T1/T2/T3 | 用 T2 当中期再提炼 T1 |
| **Replika / Nomi** | 记忆卡 | 模型抽 + 人可改 | 不透明 | 产品感 | UI 来源说明；手改后置 |

**能打的点（接上之后）**：你们已有 L0 切段+importance+日限额哲学，比「每轮盲抽」更接近 Graphiti 的 episode 入口，又比 Graphiti 便宜（只抽高分卡）。  
**暂不硬刚**：Mem0 LoCoMo 分数——那是抽取+检索 harness，属 M4 后评测项，不是本规划验收门槛。

---

## 4. 批次总览

| 批 | 主题 | 预估 | 依赖 |
|----|------|------|------|
| **M0** | 候选与溯源：谁有资格进蒸馏；payload 字段；关参 | 0.5 天 | 纪要 E0–E3 已落地 |
| **M1** | 夜巡：高分纪要 → `distillEpisodeFacts` → `applyWrite`；日限额 | 0.5～1 天 | M0 |
| **M2** | 忙天：簇修章节一次蒸馏；与按轮抽取的预算互斥/降载 | 0.5 天 | M1、L2 |
| **M3** | 检索对齐：S1 仍以 T1 为主；新事实可召回；可选主题助推 | 0.5 天 | M1 |
| **M4** | 文档 + UI 来源 + 指标（抽了几条、跳过、冲突）+ 抽检 | 0.5 天 | M1–M3 |

每批可关参上线；默认建议 **on + 限额**。

---

## 5. 各批细节

### M0 · 候选与溯源（规则地基）

**做**

1. `shouldDistillEpisode(ep)`：对齐 `shouldRefineEpisode`  
   - `importance ≥ θ`（默认 0.55）或 `source=model` 或 `open_loops.length>0` 且 turns≥4  
   - 排除 `__day_cluster__`（留给 M2）与纯噪声段（importance 地板）
2. 事实写入统一 `source: 'episode'`，`payload: { episode_id, day, seg, session_id }`（或现有 meta 列）
3. 参数：`memory.episode.distill` = on/off；`memory.episode.distill.theta`；`memory.episode.distill.daily_cap`（默认 6）
4. **可选零模型试水**：从 `beats`/`open_loops` 里用规则捞「我是/我喜欢/记住/决定」句 → 低 confidence 候选，仍过门控（可默认 off）

**验收**

- [x] 关参：行为=仅按轮抽取（与今相同）
- [x] 开参但无模型：不抛、巩固不阻塞；可选规则候选条数有单测
- [x] 高分/低分夹具：`shouldDistillEpisode` 真/假符合预期

### M1 · 夜巡金标蒸馏（主路径）

**做**

1. `distillEpisodeFacts(db, aid, ep, extractFn)`  
   - 输入：title + summary + beats + open_loops +（可选）同段 raw 抽样 ≤8 句（复用 refine 抽样）  
   - 输出：1～3 条 `{ text, type, key?, terms? }`；拒收回声/空/超短  
2. `distillEpisodesForDay`：按 importance 排序，吃日限额；写入走 `applyWrite`→`addMemory`
3. 挂进 `runNightly`：在 L1/L2 **之后**、日记**之前或之后**均可；建议 **L2 后、日记前**（日记仍可看见当天新事实）
4. 与按轮队列：若当日已 distill ≥ cap，可把 `extract_queue` 同日低优先级任务标 skip（或降低并发）——实现允许分两小步，第一步只做「加蒸馏、不改轮抽」

**验收**

- [x] mock extract：高分纪要写出 ≥1 条 `source=episode` 事实
- [x] 回声/垃圾 JSON：不写、reason 可观测
- [x] 日限额：第 cap+1 次不再调用
- [x] 门控冲突：走进现有 conflict，不双写
- [x] `tiers`/`p4`/新 `episode-distill` 单测绿

### M2 · 忙天簇修入口 + 预算互斥

**做**

1. 若存在 `__day_cluster__`：对章节 **各至多 1 次** 蒸馏（或整日 1 次批抽），计入同一 daily_cap  
2. 参数 `memory.episode.distill.prefer_cluster=on`：有簇修时跳过同日已覆盖时段的 L0 段，防重复事实  
3. 文档写清：忙天模型预算 = L1+L2+日记+蒸馏，建议总顶

**验收**

- [x] 有簇修：蒸馏调用次数 ≤ 章节数且 ≤ cap  
- [x] 无簇修：回退 M1 逐段高分  
- [x] 重复主题不刷屏（门控 merge / 同 fact_key）

### M3 · 检索与注入对齐

**做**

1. 确认 `source=episode` 的 T1 在 S1 正常进包（应已满足，补回归）  
2. 轻量：**不**把整段 T2 塞进 S1；可选 `memory.retrieve.episode_topic_boost`——用最近 2 天纪要 topics 给命中的 T1 +小分（默认 off 或很小）  
3. 列表/深查：事实详情能看见「来自哪条纪要」

**验收**

- [x] S1 能召回新蒸馏事实  
- [x] 助推关参时分数与今一致  
- [x] 助推开参：相关题不掉、无关题不乱飘（小夹具）

### M4 · 文档 · UI · 对账

**做**

1. 更新 `memory-layers.md` 写入路径图：纪要→事实  
2. 技术页 / 记忆来源说明：`extract` vs `episode` vs `consolidate`  
3. 巩固日志 step：`episode_distill: { refined candidates, written, skipped, capped }`  
4. 人工抽检：忙天 10 条新事实——像人话、能指回纪要、无 Approval 垃圾

**验收**

- [x] 文档与代码一致  
- [x] 巩固记录可见蒸馏计数（`episode_distill` step）  
- [x] 抽检清单勾完（自动化：`test/episode-distill.test.mjs` + `npm run sim:distill` / `eval:memory` + U8 `memory-health`；实库人工抽检可选）

---

## 6. 风险与回滚

| 风险 | 缓解 |
|------|------|
| 与按轮抽取双份事实 | 门控 merge + prefer_cluster + 同日 cap；可关 `memory.auto` 仅夜巡（高级开关，默认不关） |
| 纪要摘要幻觉进 T1 | 材料带 raw 抽样；拒收回声；importance/confidence 下限 |
| 模型费叠加 | 独立 distill cap + 建议总日顶；关参即回旧行为 |
| 名称撞车 | `memory_items.type='episode'`（旧 chat 路径）≠ T2 表；新来源用 `source=episode`，type 仍 fact/preference… |

回滚：`memory.episode.distill=off` → 与今日行为一致。

---

## 7. 建议拍板顺序

1. 「按 M0 做」→ 只落候选与参数，不耗模型  
2. 「继续 M1」→ 夜巡真正开始用纪要养记忆（主收益）  
3. 「继续 M2/M3」→ 忙天与召回打磨  
4. 「M4」→ 说明与抽检  
5. （可选另项）LoCoMo / 自建问答集评测 T1，**不**阻塞本规划

---

## 8. 与纪要规划的关系

| 已完成（纪要） | 本规划补的洞 |
|----------------|--------------|
| E0–E4：切段、精修、簇修、日记、文档 | 高品质 T2 **喂给** T1 |
| 忙天成本可控 | 蒸馏也限额，避免又变线性 |
| 日记可读 | 记忆可答「你还记得」——两条腿才齐 |

**拍板前默认推荐**：M0→M1 必做；M2 与忙天强相关建议做；M3 助推可后置；M4 随 M1 一起勾。
