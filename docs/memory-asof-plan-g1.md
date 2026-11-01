# 意识体 v6 · G1「时效索引 + 冷库出证」设计 v1

> 目标：能回答「某天 / 某段时间**当时**记得什么、当时什么算数」，并且每条回答都能拿出**永不改写的原句**作证。  
> 原则：**不新建可变大图**（不是 G2）；可变层只加一张**只追加的时效索引**，正文一律从冷库（`fact_archive` / `raw_turns`）取。  
> 前置：H0–U8 已落地（见 [memory-upgrade-plan-v2.md](./memory-upgrade-plan-v2.md)）。T0↔T1 仲裁不在本版。  
> **状态（2026-11-01）**：G1-0 … G1-6 已落地。`memory.asof` 默认 on（查询可用），`memory.asof.auto` 保持 **off**（对话里不自动插「那时」，开一行参数即生效）。

---

## 0. 一句话

```
问题带时间 ──▶ 解析成时间段 ──▶ 时效索引：那段时间哪些记忆、哪个版本算数
                                   │
                                   ▼
                         冷库出证：版本原句（fact_archive）+ 当时原话（raw_turns）
                                   │
                                   ▼
                    带标签回答：当时有效 / 期间改过 / 当时有争议 / 历史陈述（+「现在：…」）
```

时光机只负责「**定位**」（哪条、哪版、哪段时间），从不保存正文；正文永远从不可改的冷库里取。

---

## 1. 要回答的两种问题（先分清，否则必出逻辑错）

| 问法 | 时间轴 | 例子 | 默认 |
|------|--------|------|------|
| 「那时**我说过/我是**什么样」 | **说话时间**（said，近似世界时间） | 「去年三月我喜欢喝什么？」 | ✅ 默认 |
| 「那时**你记得**什么」 | **入库时间**（recorded，系统时间） | 「三月那会儿你脑子里记的是啥？」 | 参数 `axis=recorded` |

两者通常只差几小时到一天（夜巡 23:00 蒸馏、抽取队列重试会滞后），但改口、补写、导入时会差很多，必须分开算。

**不承诺**的第三种：「现实世界里那件事从哪天起为真」（如「2024 年春天去了西安」里的 2024 春）。那需要从正文里抽时间表达式，留给 G1 之后（§9）。

---

## 2. 现状核对（代码实查）

### 2.1 所有会改「生效 / 作废 / 正文 / 可见性」的写入点

| # | 位置 | 做了什么 | 现在有没有留历史 |
|---|------|----------|------------------|
| W1 | `memory.js` `addMemory` INSERT | 新事实出生 | ✅ 出生存根 `fact_archive` |
| W2 | `memory.js` `addMemory` 高风险冲突 | 旧条 `invalid_at=now` + 开案 | ⚠️ 只有单列时间 |
| W3 | `memory.js` `supersedeByKey` | 同 key 旧条作废 + `superseded_by` | ⚠️ 单列 |
| W4 | `memory.js` `supersedeMany` | 合并作废 | ⚠️ 单列 |
| W5 | `gate.js` `applyWrite` update | **原地改写正文** | ⚠️ 旧句进 `fact_archive`（`id:hist:时间戳`） |
| W6 | `gate.js` `applyWrite` conflict | 旧条作废 + 开案 | ⚠️ 单列 |
| W7 | `gate.js` `applyWrite` delete | `status='deleted'` + 作废 | ⚠️ 单列 |
| W8 | `memory.js` `resolveConflict` | **把 `invalid_at` 清回 NULL**（复活）/ 作废另一条 | ❌ 复活会抹掉作废历史 |
| W9 | `features.js` 过去事实 | 刚写入就作废（「以前养过狗」） | ⚠️ 零宽 |
| W10 | `features.js` 否认句 | 匹配旧条作废（无 `superseded_by`） | ⚠️ 单列 |
| W11 | `memory.js` `softDelete` / `restoreMemory` | 软删 / 恢复 | ⚠️ 单列 `deleted_at` |
| W12 | `consolidate.js` `mergeBatch` 丢弃 | 软删 + 作废 | ⚠️ 单列 |
| W13 | `ops.js` `purgeExpired` / `db.js` `recover` | 硬删（连存根） | — |
| W14 | `ops.js` / `features.js` 导入 | 整行写入，`invalid_at` 置空 | ❌ 历史丢失 |

结论：**只靠现有列推算「当时」是有损的**——`invalid_at` 是一个会被覆盖、会被清空的单列。所以 G1 需要一张只追加的时效索引，而不是 SQL 里临时拼 `created_at <= T AND invalid_at > T`。

### 2.2 实查发现的现有缺陷（G1 必须先修）

| 编号 | 缺陷 | 后果 |
|------|------|------|
| **D1 隐私** | 硬删只删 `fact_archive WHERE memory_id=?`，改写留下的 `id:hist:…` 旧句**没删** | 违反「答应要忘必须真忘」：用户删了，旧版本原句还在冷库里 |
| **D2 丢版本** | 改写存根 id 用 `Date.now()` 毫秒；同毫秒两次改写 → `UNIQUE` 冲突 → 第二版静默丢失 | 版本链断 |
| **D3 丢旧句** | 改写时存根写失败被 `catch` 吞掉，正文照样被覆盖 | 旧版本原句永久丢失，时光机无证可出 |
| D4 | `resolveConflict` 复活把 `invalid_at` 清空 | 「冲突期间它其实是作废的」这段历史消失 |
| D5 | 入库时间 ≠ 说话时间（夜巡 23:00 蒸馏、队列重试） | 按入库时间切，会把「当天说的」算到第二天 |
| D6 | 日界：`created_at` 是 UTC ISO，「3 月 15 日」是本地日 | 跨零点算错一天（H1 里 tiers 单测刚踩过同一个坑） |

---

## 3. 借鉴了谁、拿了什么

| 来源 | 它的长处 | G1 怎么用 |
|------|----------|-----------|
| **Graphiti / Zep** | 双时态；作废不删；**新事实的生效时间 = 旧事实的失效时间**；每条边可回溯到 episode | 失效时刻取「取代它那条的说话时间」；证据链回溯到纪要 / 原文 |
| **Datomic** | 数据只追加，`as-of` 是**过滤视图**不是副本 | 时效索引只追加；查询时投影，不存快照 |
| **SQL:2011 系统版本表** | 半开区间 `[start, end)`；`AS OF` / `FROM…TO` / 区间重叠查询 | 点查 + 区间重叠查两种；统一半开区间 |
| **Mem0** | 每条记忆一条 history（ADD / UPDATE / DELETE） | `GET /memory/:id/history` 版本时间线 |
| **Letta / MemGPT** | 对话与归档按日期范围检索 | 原文出证按时间窗取 |
| **事件溯源** | 事件为真、状态为投影；投影可重放、可自愈 | 夜巡对账：发现投影与现状不一致补一条 `SYNC` |

**不拿**：图数据库、每段对话调模型抽实体边（贵、易错，见 G2）。

---

## 4. 数据模型

### 4.1 时效索引表（只追加、无正文）

```sql
CREATE TABLE IF NOT EXISTS memory_timeline(
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,  -- 全局顺序；同毫秒也能排
  agent_id   TEXT NOT NULL,
  memory_id  TEXT NOT NULL,
  op         TEXT NOT NULL,   -- 见 4.2
  at         TEXT NOT NULL,   -- 入库时间（ISO UTC，= now()）
  valid_from TEXT,            -- 说话时间（可空，空=用 at）
  reason     TEXT,            -- supersede / conflict / negation / past_fact / consolidate / resolve / user / gate …
  cause_id   TEXT,            -- 取代它的记忆 id / 冲突 id
  text_ref   TEXT,            -- fact_archive.id（ADD=出生句；REVISE=被改掉的旧句）
  actor      TEXT,            -- extract / episode / gate / user / consolidate / import / backfill / audit
  approx     INTEGER NOT NULL DEFAULT 0  -- 1 = 补录/对账推算，时间是近似
);
CREATE INDEX IF NOT EXISTS idx_tl_mem ON memory_timeline(agent_id, memory_id, seq);
CREATE INDEX IF NOT EXISTS idx_tl_at  ON memory_timeline(agent_id, at);
```

- **不存正文**：守住「索引只定位、冷库出证」；也让硬删只需删索引行 + 冷库行。
- 只允许三处删行：单条硬删、意识体整删、`journal` 回滚。其余一律只追加。

### 4.2 事件（op）

| op | 含义 | 由谁写 |
|----|------|--------|
| `ADD` | 出生 | W1（W9 的过去事实也先 ADD） |
| `REVISE` | 原地改写正文；`text_ref` 指向**旧句**存根 | W5 |
| `INVALIDATE` | 作废（`reason` 区分原因，`cause_id` 指向取代者/冲突） | W2 W3 W4 W6 W8 W9 W10 W12 |
| `REACTIVATE` | 复活 | W8 |
| `DISPUTE_OPEN` / `DISPUTE_CLOSE` | 冲突开案 / 结案（两条各写一行） | W2 W6 / W8 |
| `HIDE` / `UNHIDE` | 软删 / 恢复 | W11 W12 |
| `DELETE` | 门控删除（`status='deleted'`） | W7 |
| `SYNC` | 对账修正（`approx=1`） | 夜巡 audit |

### 4.3 两个冷库的角色（不改它们的语义）

| 冷库 | 出什么证 | 怎么定位 |
|------|----------|----------|
| `fact_archive` | 某版本当时的**原句** | `ADD.text_ref`（出生）/ `REVISE.text_ref`（被改掉的那版） |
| `raw_turns` | 当时**人说的原话** | `source_turn_id` → `raw_turns.turn_id`；或纪要 `episode_id` → 会话 + 起止时间；兜底按时间窗全文检索 |
| `memory_items.text` | **现行版本**正文 | 只有改写会动它，而改写前必先存旧句（修 D3 后保证），所以它等价于「下一次改写时才入冷库的冷库」 |

---

## 5. 算法

### 5.1 说话时间 `saidAt`（修 D5）

ADD 时计算并写入 `valid_from`，优先级：

1. 调用方显式给出 `valid_at`（预留给 §9 的时间表达式抽取）  
2. `source_turn_id` 命中 `raw_turns.turn_id` → 最早那句的 `created_at`  
3. 来自纪要（`payload.episode_id`，或 `source_turn_id` 以 `ep_` 开头）→ `episodes.start_at`  
4. 都没有 → `at`

最后夹紧：`valid_from = min(valid_from, at)`（不可能先入库后说话）。

### 5.2 事件生效时间 `eff`（单调，杜绝倒挂区间）

按 `seq` 遍历一条记忆的事件：

```
cand_i = 该事件的说话时间：
         ADD                 → valid_from
         INVALIDATE 且有取代者 → 取代者 ADD 的 valid_from     （借 Graphiti：新事实生效即旧事实失效）
         其余                 → at
eff_i  = min(at_i, max(eff_{i-1}, cand_i))       （eff_0 = ADD 的 valid_from）
```

保证：`eff` 随 `seq` 不减，且永远不晚于入库时间。`axis=recorded` 时直接用 `at`。

### 5.3 投影：状态区间

```
状态机（幂等）：
  ADD            → active
  INVALIDATE     → active 时变 inactive；已 inactive 则忽略（保留更早的失效点）
  REACTIVATE     → inactive 时变 active；已 active 则忽略
  DISPUTE_*      → 只改「有争议」标记，不改 active
  HIDE / DELETE  → 整条从 as-of 结果中移除（不论时间）——遗忘优先于历史
  UNHIDE         → 撤销 HIDE
  SYNC           → 按其 reason 等价于上面某个 op
产出：active 区间列表 [start, end)、争议区间列表、版本切点（REVISE 的 eff）
```

**为什么软删/删除整条不出现**：用户或门控说了「忘掉」，时光机不能成为绕过遗忘的后门；恢复后（UNHIDE）再回来。

### 5.4 版本正文：给定时刻 t 的那一版

```
找第一个 eff > t 的 REVISE：
  有 → 正文 = 它的 text_ref（被改掉的旧句，来自 fact_archive）
  无 → 正文 = memory_items.text（现行版）
```

正确性：正文只在 REVISE 时变，且改之前旧句必入冷库 → 任一时刻的版本都可精确还原。  
`text_ref` 缺失（只可能来自 G1 前的老数据）→ 退到出生存根并标「版本近似」。

### 5.5 查询的时间语义（半开区间）

| 输入 | 解析成 | 命中条件 |
|------|--------|----------|
| 精确时刻 | 点 T | `start ≤ T < end` |
| 某天 / 某周 / 某月 / 某季 | 区间 `[F, To)`（本地日界换算成 UTC，修 D6） | 区间重叠：`start < To` 且 `end > F` |
| 零宽区间（过去事实 W9，`start = end = s`） | — | `s < To` 时归入「历史陈述」 |
| 记忆出生前 | — | 不命中 |
| `To` 晚于现在 | — | 截到现在；整段都在未来 → 退回普通检索 |

### 5.6 查询流水线

1. **时间解析**（新模块，纯函数，可注入「现在」）：
   - 绝对：`2026-03-15`、`3月15日`、`2026年3月`
   - 相对：昨天、上周、上个月、去年三月、三个月前（±15 天窗口）、半年前、今年春天
   - 只认**有锚点**的时间；光说「当时 / 那时」不触发（避免劫持日常 S1）
   - 「3 月」不带年：取最近一个已过去（含本月）的 3 月
2. **候选**（跨版本搜，不只搜现行正文）：
   - `memory_fts`（现行）∪ `fact_fts`（出生句 + 改写旧句，`memory_id` 去掉 `:hist:` 后缀映射回主 id）
   - 只要 `status='active'`（作废的仍是 `active` + `invalid_at`，会被区间判断处理）；软删/删除不进
   - 类型默认 `fact` / `appraisal`（承载「状态」的）；`reflection` 等叙事类走纪要/日记层
3. **时间过滤**：对每个候选做 5.3 投影 + 5.5 判断，留下与查询时间重叠的版本
4. **相关性**：沿用 `evidenceOf`，门槛 = S3 的 0.20；纯软匹配沿用 recall-tool 的字面门槛规则（不硬凑）
5. **出证**：版本原句（5.4）+ 原话（4.3 的定位顺序，只取查询时间窗内的；窗外的必须标注）
6. **排序**：证据分 → 区间覆盖比例 → 重要度
7. **渲染**：

```
以下是「2026 年 3 月」那时的记忆，不代表现在：
- [当时有效 03-05 起] 我喜欢喝美式咖啡，不加糖   （现在：已改口为「不喜欢喝美式，改喝手冲」）
    原话 03-05：「我喜欢喝美式咖啡，不加糖」
- [期间改过 03-10→03-20] 每周二游泳 → 每周二、四游泳
- [当时有争议] …
- [历史陈述] 以前养过狗
- [早期记录，时间为近似] …（approx=1）
```

「现在：…」只在当时版本与现行状态不同时出现——这是防止「把三个月前的话当现状讲」的关键（现有 `oldAccountQuery` 的同一顾虑）。

### 5.7 读路径的硬规则

- **as-of 查询绝不 touch**：不加 `hits`、不拨 `last_hit_at`、不改热度/温度。否则翻一次旧账就把作废的旧事实重新加热。
- 不改 S1 / S2 / S3 现有路径与分数；as-of 是旁路。
- 回放日志记一行 `scene='ASOF'`，便于观测。

---

## 6. 逻辑推演（按设计手算，等价于「调试」）

时间轴：天数 = 剧本日，全部本地时间。

| # | 场景 | 事件序列 | 查询 | 期望 | 推演结论 |
|---|------|----------|------|------|----------|
| 1 | 改口 + 冲突 | d5 ADD A「喜欢美式」；d120 ADD B「不喜欢美式」，A INVALIDATE(conflict, cause=B)，DISPUTE_OPEN A,B | d60 | A 当时有效 | ✅ A 区间 [d5, d120)，d60 落入 |
| 2 | 同上 | 同上 | d121 | B 有效；A 标「当时有争议」 | ✅ A inactive 但在争议区间内，按争议展示 |
| 3 | 结案保留新 | d130 resolve keep=b：A 再 INVALIDATE（已 inactive，忽略），DISPUTE_CLOSE | d125 / d131 | d125 仍争议；d131 只有 B | ✅ 幂等规则保住 A 的失效点 d120（修 D4 的同类问题） |
| 4 | 结案保留旧 | 改为 keep=a：A REACTIVATE、B INVALIDATE | d125 / d131 | d125：B 有效、A 争议；d131：A 有效 | ✅ A 区间 [d5,d120) ∪ [d130,∞) |
| 5 | 原地改写 | d10 ADD「每周二游泳」；d50 REVISE→「每周二、四」（text_ref=旧句） | d30 / d60 / 区间 d40–d55 | 周二 / 二四 / 「期间改过」 | ✅ 5.4 取第一个 eff>t 的 REVISE 的旧句 |
| 6 | 过去事实 | d20 ADD「以前养过狗」+ 同刻 INVALIDATE(past_fact) | d10 / d30 | 无 / 历史陈述 | ✅ 零宽规则 `s < To` |
| 7 | 夜巡滞后 | d10 22:00 说话，d10 23:00 蒸馏入库，`episode_id` 可查 | 「d10 那天」 | 命中 | ✅ valid_from=纪要 start_at（修 D5） |
| 8 | 跨零点 | 3/15 00:30 本地说话（UTC 3/14 16:30） | 「3 月 15 日」 | 命中，不算到 3/14 | ✅ 本地日界换 UTC（修 D6） |
| 9 | 软删 / 恢复 | d40 HIDE；d42 UNHIDE | d41 | 正常显示该条 | ✅ 已恢复=没忘；未恢复则任何时间都不显示 |
| 10 | 硬删 | 软删满 7 天 purge | 任意 | 主表、出生句、**所有改写旧句**、索引全无 | ✅ 依赖 D1 修复 |
| 11 | 同毫秒两次改写 | 两次 REVISE | 任意 | 两个旧版本都在 | ✅ 依赖 D2 修复（存根 id 改用版本号） |
| 12 | 取代链 | A→B→C（同 key） | A 与 B 交界 / B 与 C 交界 | 各段正确 | ✅ A 的 end = B 的 valid_from；B 的 end = C 的 valid_from |
| 13 | 取代者说话更早（队列乱序） | B.valid_from < A.valid_from | — | A 不出现倒挂区间 | ✅ 5.2 的 `max(eff_{i-1}, …)` 让 A 变零宽，不会 end<start |
| 14 | 问到出生前 | 实例 d0 创建，问 d-30 | — | 「那时还没有记录」 | ✅ 无 ADD ≤ To |
| 15 | 问未来 / 今天 | — | — | 退回普通检索 | ✅ 5.5 末行 |
| 16 | 冷 / 归档温度 | 某事实 archived | 当时它有效 | 照常显示 | ✅ 温度不是有效性，as-of 不看温度 |
| 17 | 钩子漏写 | 某处作废没记事件 | — | 夜巡对账补 SYNC，标近似 | ✅ 不会永久漂移 |
| 18 | G1 前的老数据 | 无索引 | — | 由补录生成，标「早期记录，时间为近似」 | ✅ 诚实标注，不装精确 |

**推演中找到并已在设计里堵上的漏洞**：
- 复活 / 重复作废会把失效点挪到结案时刻 → 用「幂等投影」保留第一次失效点（#3）。
- 取代者说话时间早于被取代者 → 用单调 `eff` 防倒挂（#13）。
- 只搜现行正文，会漏掉「当时的说法」→ 候选同时搜 `fact_fts` 的旧句（5.6 第 2 步）。
- 翻旧账会给作废事实加热 → 读路径禁止 touch（5.7）。
- 软删后时光机仍能看到 → 遗忘优先（5.3）。
- `LIKE 'mem_x:%'` 里的 `_` 是通配符，可能误删别人的存根 → 前缀比较用 `substr(memory_id,1,n) = 'id:'`，不用 LIKE（§8 G1-0）。

---

## 7. 与现有逻辑的冲突检查

| 现有不变量 / 逻辑 | G1 是否触碰 | 结论 |
|-------------------|-------------|------|
| T4 原文只追加 | 只读 | ✅ |
| `fact_archive` 每个 memory_id 只写一次 | 改写存根 id 从「时间戳」换成「版本号」，仍是新 id、仍只写一次 | ✅ |
| 日记 ≠ 事实源 | as-of 的事实只来自索引 + 存根；日记只作「那天怎么样」的附加层 | ✅ |
| gate 顺序 极性→merge→UPDATE→new | 只在各分支末尾加记事件，不改判定 | ✅ |
| `invalid_at` 现有读者（几十处 `invalid_at IS NULL`） | **列的写法和含义完全不变**，历史另存 | ✅ |
| S1 挡冷层 / 证据门 ⊥ 热度 | as-of 是旁路，不改 S1 | ✅ |
| 答应要忘必须真忘 | 软删即不可见；硬删连索引 + 全部旧句一起删（还顺带修了 D1） | ✅ 更严格 |
| INV10 所有权 | 新表登记到所有权表；新模块按分组归属 | 需登记（G1-1） |
| schema 增量 | 只新增一张表 + 两个索引 | ✅ |
| 改写存根失败 | 现为「吞掉继续改」；改为「整笔回退到 new」——走 `applyWrite` 已有的 `update_failed` 分支 | ⚠️ 行为微调：宁可多一行，不丢旧句 |

---

## 8. 照着执行的步骤

每步独立可关、可回滚；每步做完跑一次全量回归（`test:upgrade` / `test:u6` / `test:u7` / `test:u8` / `test:h1` / `sim:days 60 & 200` / `eval:memory`）再进下一步。

### G1-0 · 先修三处现有缺陷（不依赖 G1，单独也该做）

1. `gate.js` 改写存根 id：`${id}:hist:${version}`（改写前的 version），不再用 `Date.now()`（D2）
2. `gate.js` 改写：存根 + 改正文 + 改 FTS 放进同一个事务；存根写不进 → 回退走已有 `update_failed` → `new`（D3）
3. `ops.js` 单条硬删与 `db.js` `recover`：删 `fact_archive` / `fact_fts` 时条件改为 `memory_id = ? OR substr(memory_id, 1, length(?) + 1) = ? || ':'`（D1，不用 LIKE）

**验收**：新测「同毫秒两次改写，两版旧句都在」「存根写入失败不覆盖正文」「硬删后 `:hist:` 行为 0」；`tiers` 75/75 不回归。

### G1-1 · 时效索引表 + 写入工具

1. `db.js` 增量建 `memory_timeline` + 两个索引
2. 新模块 `src/modules/timeline.js`：
   - `logEvent(db, aid, memId, op, {at, validFrom, reason, causeId, textRef, actor, approx})`——失败静默（与「写入不能被日志卡死」一致，漂移交给对账）
   - `invalidateMemory(db, aid, id, {reason, causeId, supersededBy})`：执行**与现在完全相同**的 `UPDATE`，再记事件
   - `reactivateMemory(db, aid, id, {reason, causeId})`
   - 纯函数 `projectTimeline(events, {axis})` → 区间 / 争议 / 版本切点（§5.2–5.3）
3. `ports/ownership.js` 登记表与模块；整删清单（`ops.js` 与 `features.js` 的 `TABLES`）、记忆导出清单加入新表
4. 参数：`memory.asof`（on/off，默认 on）、`memory.asof.auto`（off/on，默认 **off**）、`memory.asof.axis`（said/recorded，默认 said）

**验收**：`projectTimeline` 纯函数单测覆盖 §6 的 #1–#6、#12、#13；关 `memory.asof` 时读路径完全不碰新表。

### G1-2 · 接上全部写入点（W1–W12）

1. 把散落的 `UPDATE memory_items SET invalid_at=…` 统一换成 `invalidateMemory` / `reactivateMemory`（memory.js、gate.js、consolidate.js、features.js 共 11 处，见 §2.1）
2. `addMemory` 在事务内记 `ADD`（含 `saidAt`）；`softDelete` / `restoreMemory` 记 `HIDE` / `UNHIDE`；gate delete 记 `DELETE`；冲突开案 / 结案记 `DISPUTE_*`；改写记 `REVISE`（`text_ref` = 刚写的旧句存根 id）
3. 新脚本 `scripts/check-timeline.mjs`：除 `timeline.js`、硬删与回滚外，任何文件出现对 `memory_items` 的 `SET invalid_at` / `SET text` / `SET status` 即失败；挂进 `check:arch`

**验收**：每条写入路径一个夹具，断言事件序列；`sim:days 200` 跑完后「投影状态 = 主表现状」全量一致（漂移 0）。

### G1-3 · 老数据补录 + 夜巡对账

1. 启动一次性补录（标记 `timeline.bootstrapped.v1`，参照 `tiers.bootstrapped.v2` 的做法），全部 `approx=1`：
   - `ADD` @ `created_at`（`valid_from` 按 5.1 推）
   - 改写旧句存根（`payload.parent_id`）→ `REVISE` @ `payload.at`
   - `invalid_at` 非空 → `INVALIDATE`（有 `superseded_by` 记 supersede，否则 unknown）
   - `conflicts` 表 → `DISPUTE_OPEN` @ `opened_at` / `DISPUTE_CLOSE` @ `resolved_at`
   - 软删 → `HIDE` @ `deleted_at`
2. 夜巡新增一步 `timeline_audit`：投影现状 vs 主表现状，不一致补 `SYNC`（每晚有上限），计数写进巩固日志
3. `memory-health` 增加 `timeline_drift`

**验收**：在一份 G1 前生成的库上补录后漂移 0；人为删掉一条事件 → 次夜被补回。

### G1-4 · 时间解析

1. 新模块 `src/modules/timeparse.js`：`parseTimeRange(text, {now})` → `{from, to, granularity, phrase} | null`
2. 只认有锚点的表达；本地日界换 UTC；「3 月」取最近已过去的 3 月；未来截到现在

**验收**：固定「现在」的表驱动单测 ≥ 30 条（含跨年、跨零点、闰年 2 月、「三个月前」窗口、无锚点返回 null）。

### G1-5 · as-of 查询与出证

1. 新模块 `src/modules/asof.js`：`retrieveAsOf(db, aid, query, {from, to, axis, k})`，按 §5.6 实现；**不 touch**
2. 接口：
   - `GET /v1/agents/:id/memory/as-of?q=&at=` 或 `&from=&to=`（`axis` 可选）
   - `GET /v1/agents/:id/memory/:mid/history`（Mem0 式版本时间线，带每版原句）
3. 工具 `memory_search` 增加参数 `as_of`（日期或「去年三月」这类短语）与 `axis`；渲染带 §5.6 的标签和「现在：…」

**验收**：§6 全部 18 个场景各一个夹具；as-of 前后对比热度/命中数完全不变；`recall-tool` 原 68 条不回归。

### G1-6 · 接入对话 + 仿真 + 文档

1. 对话预取：`memory.asof.auto=on` 且问句含有锚点的过去时间 → 旁路调用 `retrieveAsOf`，结果作为带「当时」标签的 T1 段进装箱；否则一切照旧
2. `sim-memory-days` 增加 as-of 探针：「第 60 天喜欢喝什么」→ 美式；「第 130 天」→ 手冲 + 争议/结案标注；游泳改写前后版本
3. 金标 `eval:memory` 增加 as-of 题
4. 更新 `memory-layers.md`（新表、读写路径、参数）
5. 仿真与金标全绿后，再评估是否把 `memory.asof.auto` 默认改为 on

**验收**：仿真 as-of 探针全中；日常 S1 探针与金标结果和开启前一致。

**落地记录（2026-11-01）**：G1-0 … G1-6 均已按上面的验收做完。`memory.asof.auto` **维持默认 off**——自动段会占每轮上下文，只有问句带过去时间才有用，需要时再开。实现落在 `src/modules/timeline.js`、`timeparse.js`、`asof.js`；对话入口是宿主 pre-step（`index.js`）和 `chatReply`。顺手修了门控与 `addMemory` 对同一对记忆各开一条冲突、点查询 `at=此刻` 被当成未来。

### 回滚

| 层级 | 做法 |
|------|------|
| 读 | `memory.asof=off`：工具/接口/对话都不走 as-of |
| 对话 | `memory.asof.auto=off`（默认即是） |
| 写 | 事件写入失败本就静默；必要时整表删除，主链路不读它 |
| G1-0 | 三处修复是独立 bug 修复，不建议回滚 |

---

## 9. 之后（不在本版）

- **valid_at 抽取**：从正文抽「2024 年春天」这类时间，填 5.1 第 1 优先级，回答「现实里那件事何时为真」
- **REAFFIRM 提及事件**：门控合并（同一件事又说了一遍）时记一次，用于「那段时间提过几次 / 最后一次提到是哪天」
- **「那时」指代消解**：光说「那时候」时，从上下文里找最近提到的时间
- **G2**：实体关系网 + 双时态（另立项）
