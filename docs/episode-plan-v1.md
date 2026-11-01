# 意识体 v6 · 纪要生成规划 v1

> 拍板：三级纪要（L0 规则底稿 · L1 金标精修 · L2 忙天簇修）；日记继续吃纪要打包。  
> 原则：品质不靠糊弄；一天上千句也扛得住；模型少次、有上限；失败回 L0，原文不丢。  
> 对照画布：`episode-quality-plan` · `episode-vs-products`。

---

## 0. 范围与不做

**做**

- 纪要 L0：切段、严滤噪、多信号打分抽样、结构化字段、importance 拉开。
- 纪要 L1：高分段可选模型精修（日限额）。
- 纪要 L2：忙天夜间一次簇修，专供日记。
- 日记侧：只吃高分纪要 + 已有预算打包 / fail_reason / force（已部分落地，本规划对齐验收）。

**不做（本版）**

- 每句 / 每会话默认调模型写纪要。
- 用日记模型冒充纪要；或取消规则保底。
- Nomi 式「长期记忆手改图谱」整页（另立事实库规划）。
- 向量化纪要召回大改（沿用现有 retrieve；纪要先服务日记与列表）。

---

## 1. 产品语义（冻结）

| 点 | 行为 |
|----|------|
| 原文 T4 | 只追加，真相层；纪要坏了可重算 |
| 纪要 T2 | 短要点卡，不是美文；默认 `source=rules` |
| L0 | 每段必有；零模型；可重算 |
| L1 | 仅高分/长段/有未闭环；模型 2～3 句；失败保留 L0 |
| L2 | 当天条数 > N 才跑；夜间最多 **1 次** 模型；产出时段要点 |
| 日记 T3 | 优先 L1+L2，否则 L0 高分；材料预算打包，不砍半截 JSON |
| 模型日预算（建议默认） | L1 ≤ 8 次/天/实例；L2 ≤ 1；日记成文 ≤ 1（+1 次缩包重试） |

---

## 2. 批次总览

| 批 | 主题 | 预估 | 依赖 |
|----|------|------|------|
| **E0** | L0 切段 + 打分抽样 + 字段图式 + importance | 0.5～1 天 | 无 |
| **E1** | 巩固重算对齐；日记只吃高分；单测/抽检 | 0.5 天 | E0 |
| **E2** | L1 金标精修（开关 + 日限额 + 校验） | 0.5～1 天 | E0 |
| **E3** | L2 日终簇修接 nightly / consolidation | 0.5 天 | E0、日记打包 |
| **E4** | 文档 + UI 说明（来源标签 / fail 文案） | 0.5 天 | E2、E3 |

每批可独立合并；E2 / E3 可关参上线（默认建议 on，限额兜底）。

---

## 3. 各批细节

### E0 · L0 规则底稿（品质地基）

**改哪里**

- `src/modules/archive.js`：`composeEpisodeFields` / `buildEpisode`
- 新增或抽出：`segmentTurns`（静默≥20min 或每 40 轮切段）、`scoreTurn`（问句/承诺/偏好·人名/长度/位置）、严滤噪扩展

**规则要点**

1. 切段：同 session 可多条纪要（id 策略：`session+day+seg` 或等价唯一键，需迁移兼容旧「一会话一天一条」）。
2. 抽样：按分取对方 1～3 句、助手 1 句；禁止「只取前 3 + 末 1」。
3. 字段：`title` · `beats[]` · `reply` · `open_loops[]` · `topics[]` · `importance` · `source`
4. `summary` 由字段拼出，≤220 字。
5. `importance` 拉开：寒暄低、未闭环+有效长对话高。

**验收**

- [x] 单元：噪声不进 title；切段条数符合夹具；打分抽样含问句。（`tiers` 60 条）
- [x] 人工抽 10 段真实会话：读得懂「发生了什么」；无 Approval/研究助理垃圾标题。（2026-10-30 实库抽 12 段，junk=0；force 巩固后 importance 拉开）
- [x] `tiers.test.mjs` 全绿；旧一会话一条路径不崩（`buildEpisode` 兼容包装 + `seg` 迁移）。

**已落地（E0）**

- `segmentTurns` / `scoreTurn` / `composeEpisodeFields`（beats + reply + importance）
- `buildEpisodes` 多 seg 落库；`episodes.seg` / `beats` 列与唯一键
- `nightly` 按会话重算全部切段

---

### E1 · 接线与日记对齐

**改哪里**

- `nightly.js`：巩固日对当天各段 **重算** L0（已有雏形则对齐切段）。
- `packDiaryMaterial`：按 `importance` 排序；可设日记喂入下限（如 &lt;0.25 不进默认包）。
- 参数（可选）：`memory.episode.min_diary_importance`

**验收**

- [x] 忙天夹具（模拟 30+ 段）：打包不超预算、完整 JSON、低分不占满坑。
- [x] `force` consolidation 后纪要刷新为新算法字段。（E0 nightly + p4 force）
- [x] `p4.test.mjs` / `tiers.test.mjs` 绿。

**已落地（E1）**

- 参数 `memory.episode.min_diary_importance`（默认 0.25）
- 打包跳过低分；全低分回退 Top3；优先用 `beats` 进材料

---

### E2 · L1 金标精修

**改哪里**

- `archive.js`：`refineEpisode(db, aid, epId, summarize)` 或 build 后异步精修
- 触发：`importance≥θ` 或有效轮次≥N 或（open_loops 非空且 turns 大）
- 参数：`memory.episode.refine=on|off`，`memory.episode.refine.daily_cap=8`，`θ` / `N` 可配
- 材料：高分抽样 ≤12 句 + L0 字段；输出 2～3 句；`isPromptEcho` / 过短拒收
- `source=model` 仅精修成功时；失败写 `fail_reason` 类痕迹（可放 context/meta），正文保持 L0

**验收**

- [x] 关参：行为=纯 L0。
- [x] 开参 + mock 模型：高分段变 model；拒收回声不覆盖。
- [x] 日限额：第 9 次不再调用。（测：cap=1 后再跑 refined=0）
- [x] 无模型：不抛、不阻塞巩固。

**已落地（E2）**

- `refineEpisode` / `refineEpisodesForDay`；参数 `memory.episode.refine*`；巩固步骤 `episode_refine`

---

### E3 · L2 忙天簇修

**改哪里**

- `nightly.js` 在写日记前：若当天纪要数 &gt; N（默认 12），聚 3～5 簇 → **1 次** `summarize` → 时段要点（可落临时结构或 `episodes` 标记 `tier=cluster` / 独立小表，选型在实现时取更小改动）
- 日记 `packDiaryMaterial` 优先吃簇要点 + L1

**验收**

- [x] 纪要 ≤N：不调 L2。
- [x] 纪要 &gt;N：恰好 1 次模型（mock 计数）；失败则日记退回 L0 高分包。
- [x] 与日记成文合计模型次数符合 §1 预算表。

**已落地（E3）**

- `clusterRefineForDay` → `session_id=__day_cluster__`；参数 `memory.episode.cluster_at`；巩固步骤 `episode_cluster`

---

### E4 · 文档与界面

**改哪里**

- `docs/memory-layers.md`：T2 三级说明
- 前端纪要/日记：展示 `source`（规则/精修）；日记 fail 文案已有则对齐 L1/L2 原因

**验收**

- [x] 文档与代码一致；用户能区分「模板日记」vs「模型日记」vs「规则纪要」。

**已落地（E4）**

- `memory-layers.md` T2/写入路径更新；日记页说明原料含精修/簇修；低分跳过 chip

---

## 4. 风险与回滚

| 风险 | 缓解 |
|------|------|
| 切段改唯一键导致重复/丢更新 | 迁移测；旧行 upsert 策略写死再动库 |
| L1 拖慢巩固 | 日限额 + 异步队列可选；默认同步但 cap 小 |
| 模型把工具噪声写进精修 | 精修输入已滤噪；回声/禁词校验 |
| 品质主观 | E0 强制人工 10 段抽检门禁，不通过不进 E2 |

回滚：参数关 L1/L2；L0 保持可重算。

---

## 5. 建议执行口令

1. 「按 E0 做」→ 只落地规则品质地基  
2. 「继续 E1」→ 接线日记  
3. 「继续 E2 / E3」→ 模型尖刀  
4. 全程：「跑 tiers + p4」做回归  

---

## 6. 人话摘要

平时机器把聊天切段、扔掉垃圾、挑出真正有用的句子，写成短卡片。  
重要的几段才让模型润成更好懂的两三句。  
一天碎卡片太多时，晚上再花 **一次** 模型收成几个时段要点，专门给写日记用。  
这样一天聊上千句也不崩，日记材料也不糊弄。
