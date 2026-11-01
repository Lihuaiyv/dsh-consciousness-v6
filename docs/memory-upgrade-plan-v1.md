# 意识体 v6 · 记忆模块升级规划 v1

> 来源：全景对标「仍弱」六条 + P0/P1/P2 升级抓手，收成一条可执行批次链。  
> 前提：P0 日界、L0 护 L1、M0–M3 纪要蒸馏 **已落地**（本规划不再重做）。  
> 原则：点对点补强，不上 Neo4j、不整库重写、不为打榜先重写检索。

---

## 0. 问题 → 批次映射

| # | 仍弱（对标） | 归属批次 | 对标产品 |
|---|--------------|----------|----------|
| W1 | extract 与 distill 预算未互斥 | **U0** | LangMem / 自家长限哲学 |
| W2 | chat 路径可能仍走旧 recall@v2 | **U0** | 自身一致性 |
| W3 | 向量还是扫表，无 ANN | **U1** | Mem0 / Hindsight / Zep |
| W4 | 无 Mem0 式 ADD/UPDATE/DELETE reconcile | **U2** | Mem0 |
| W5 | 实体仍是规则 NER | **U3** | Graphiti NER（轻量版） |
| W6 | consolidate 只合 reflection | **U3** | Letta dream / LangMem |
| W7 | 无双时态实体边图 | **U4（轻量）** | Graphiti（**不做完整双时态**） |
| — | 来源可见 / remember 工具 / 金标 CI / 文档漂移 | **U5** | 产品收口 |

另：「立刻值回票价」三件事拆进 U0 + U1；「事实工业补强」= U2+U3；「产品与评测」= U5。

---

## 1. 范围与不做

**做**

- 日模型硬顶 + extract↔distill 互斥  
- API/chat 召回统一 retrieve@v3  
- 向量近似检索（sqlite 内或轻量索引，不引入新图库）  
- gate 增加 UPDATE 语义（同 fact_key 原地改写 + 存根留痕）  
- 实体夜巡解析（LLM + 别名合并）；consolidate 扩到同 key/实体事实  
- 轻量 `memory_links` 边类型（from_episode / likes…），**不是** Neo4j 双时态  
- 来源徽章、remember 工具、中文金标 CI、文档去漂移  

**不做（本版）**

- 上 Neo4j / FalkorDB / 完整 Graphiti 双时态图  
- 每句默认调模型写纪要  
- 用日记当唯一事实源  
- 公开 LoCoMo harness（可 U5 后另立项）  
- 为 ANN 换整套存储引擎  

---

## 2. 批次总览

| 批 | 主题 | 消化弱点 | 预估 | 依赖 |
|----|------|----------|------|------|
| **U0** | 预算互斥 + chat 统一 v3 | W1 W2 | 0.5～1 天 | 现有 distill/extract |
| **U1** | 向量 ANN | W3 | 1～1.5 天 | vector.js 已有落库 |
| **U2** | gate UPDATE / reconcile | W4 | 1 天 | gate + addMemory |
| **U3** | 实体夜巡 + consolidate 扩事实 | W5 W6 | 1～1.5 天 | U0 限额可并行 |
| **U4** | 轻量边图（非双时态） | W7 折中 | 1 天 | U3 实体 |
| **U5** | 产品收口：徽章 / remember / CI / 文档 | — | 0.5～1 天 | U0～U2 建议先 |

合计约 **5～7 天**；U0∥U1 可并行起手。

---

## 3. 各批细节

### U0 · 日模型硬顶 + 路径统一（P0 前两件）

**做**

1. 参数 `memory.llm.daily_cap`（默认 **16**）：计入 L1 refine + L2 cluster + 日记(≤2) + distill + **按轮 extract 成功调用**  
2. 互斥：当日 distill 已达 `distill.daily_cap`（或总顶剩余 &lt; extract 成本）→ `extract_queue` 同日 pending 降为 `skip` / 延后到次日  
3. `features.chatReply`：`memory.retrieve.formula=v3` 时走 `retrieve` + `packInjection`，与宿主 pre-step 一致；显式 `v2` 才走旧 `recall`  
4. 巩固 log / extract step 可观测：`budget_used` / `extract_skipped`

**验收**

- [x] 关总顶或 distill=off：行为≈今  
- [x] 忙天夹具：extract 调用被 distill 挤掉可观测  
- [x] chatReply 默认走 retrieve@v3  
- [x] `p4` / `episode-distill` / `retrieve` / `upgrade-u` 回归绿  

---

### U1 · 向量 ANN（P0 第三件）

**做**

1. `searchByVector` 去掉全表 O(N) 扫：优先 **sqlite-vec**（若宿主/打包允许）；否则 agent 内 **HNSW 冷启动缓存**（写入 dirty 标记，夜巡重建）  
2. 参数 `memory.retrieve.vector.index` = `auto|off|bruteforce`（默认 auto）  
3. 覆盖率门槛：向量条数 / 活跃事实 &lt; θ（如 0.3）时 S1 不依赖 vec 通道（避免空索引假阴性）  
4. 单测：N=2k 假向量，bruteforce vs index top-k 重叠 ≥ 0.8；延迟有上限断言  

**验收**

- [x] bruteforce 关参可回退  
- [x] 有索引时召回不掉金标（`test:upgrade` / `sim:distill`）  
- [x] 无 embed 能力时静默降级，不抛  

---

### U2 · Mem0 式 reconcile（轻量）

**做**

1. `decideWrite` / `applyWrite` 增加 **`update`**：同 `fact_key` 或（同实体 + 高相似 + 同极性）→ **改写正文**，`version+1`，旧句进 `fact_archive` 或 payload.history（只追加）  
2. 显式 **`delete`/`noop`**：模型/蒸馏返回 `op` 时尊重；默认仍 ADD  
3. 蒸馏与 extract 的 JSON schema 可选带 `op`；无 op 时行为与今兼容  
4. 冲突仍走现有 conflict；UPDATE 不替代 polarityFlip  

**验收**

- [x] 同 key 两次写入：主表 1 行，存根/历史可查旧句  
- [x] 无 key 高相似合并仍走 merge（hits+1）  
- [x] 关参 `memory.write.reconcile=off` → 仅 new/merge/conflict  

---

### U3 · 实体夜巡 + consolidate 扩事实

**做**

1. `nightly` 增 step `entity_resolve`：对当日新事实/纪要 topics 调 1 次模型 → 合并别名、补 `entity_id`（日限额 1～2）  
2. 规则 NER 保留作零模型底；LLM 只做「合并与补洞」  
3. `consolidatePending`：候选扩到 `type=fact` 且（同 `fact_key` 或同 `entity_id` + Jaccard≥θ）；合并结果 `source=consolidate`  
4. 参数：`memory.entity.resolve`、`memory.consolidate.facts`（默认 on + 小 cap）  

**验收**

- [x] 关参：实体/合并行为=今  
- [x] 夹具：两别名并到同一实体；两同 key 事实合并为一条  
- [x] 不误吞冲突对（极性相反不进 consolidate）  

---

### U4 · 轻量边图（W7 折中，非 Graphiti）

**做**

1. 蒸馏成功时写 `memory_links`：`from_episode`（memory↔episode 用 payload 已有 id；链到同批实体记忆）  
2. 可选规则边：`likes` / `decided`（从 fact_key 或句式），**无** valid_at/invalid_at 全套；失效仍用现有 `invalid_at` / supersede  
3. retrieve 图扩散已支持 hops——为新 `kind` 加权，不改 S1 一跳上限  
4. 文档写清：**不是**双时态 KG；要完整 Graphiti 另立项  

**验收**

- [x] 蒸馏事实可经 link 一跳摸到同实体兄弟  
- [x] 无边时检索分数与今一致  
- [x] 面板带来源徽章（接 U5）  

---

### U5 · 产品收口

**做**

1. 记忆列表 / 详情：`source` 徽章（extract / episode / consolidate / manual）+ episode payload 摘要  
2. Agent 工具：`remember`（写入走 gate）配对现有 `recall_tool`  
3. CI：固定中文金标集（可从 `sim-distill-compare` 抽）门槛；`retrieval_log` empty_rate 告警阈值文档化  
4. 修正 `memory-layers.md` §13「未做向量/实体」等过时句；交叉链到本规划  

**验收**

- [x] 技术页与文档一致  
- [x] remember → S1 可召回  
- [x] 金标脚本：`npm run eval:memory` / `npm run test:upgrade` / `npm run sim:upgrade`  

---

## 4. 风险与回滚

| 风险 | 缓解 |
|------|------|
| 总顶过紧导致事实变少 | 分参可调；先 log `extract_skipped` 一周再收紧默认 |
| ANN 召回漂移 | auto 下与 bruteforce 重叠率门禁；可关 index |
| UPDATE 误改 | 仅同 key / 高相似同极性；冲突优先 |
| 实体 LLM 烧钱 | 日 1～2 次；关参回规则 |
| 「轻量边」被当成 Graphiti | 文档+UI 明示；U4 不做 valid/invalid 双时态 |

回滚：各批独立关参（`daily_cap` 极大、`vector.index=bruteforce`、`reconcile=off`、`entity.resolve=off`、`consolidate.facts=off`）。

---

## 5. 建议执行口令

1. 「按 U0 做」→ 预算互斥 + chat v3（当天就能减双烧、消路径分裂）  
2. 「继续 U1」→ ANN  
3. 「继续 U2」→ reconcile UPDATE  
4. 「继续 U3 / U4」→ 实体与轻边  
5. 「U5」→ 收口可见性与评测  

**默认推荐起手：U0 → U1 → U2**；U3 与 U4 可在 U2 后并行意向评审。

---

## 6. 人话摘要

钱先别花两遍（抽取和蒸馏抢额度），聊天召回别走老路，向量别傻扫全表——这三件先做。  
然后让「同一件事」能改写而不是只堆新行，名字能合并，夜里合并别只盯着自省。  
图先用轻边凑合，不上 Neo4j。最后把来源露出来、给 agent 一支笔、用金标盯着别回退。
