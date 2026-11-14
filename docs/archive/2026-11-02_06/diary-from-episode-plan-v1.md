# 意识体 v6 · 纪要→日记规划 v1

> 澄清：优化对象是 **T2 纪要 → T3 日记**（不是纪要→T1 记忆）。  
> 纪要 E0–E4 已把「原料层」做完；本规划专攻 **成文品质、忙天选料、补写正确、可观测**。  
> 原则：继续对齐 L0/L1/L2——少次模型、完整材料 JSON、失败回模板、不编造。

---

## 0. 现状一句话

| 层 | 状态 |
|----|------|
| 纪要 L0/L1/L2 | **已优化**（切段、精修、簇修、importance） |
| 纪要→日记接线 | **已接通**：夜巡 L1→L2→`buildDiary`；打包按分/簇优先；半预算重试；`fail_reason` |
| 日记成文品质 | **半优化**：能写、能降级，但忙天仍混进大量 L0、补写心情错位、UI/修复弱 |

```
episodes (L0/L1/L2) ── packDiaryMaterial ──► tryModelDiary / 模板
         ▲ 已通              ▲ 还有缺口（选料策略、口吻、截断、补写、可观测）
```

---

## 1. 已落地（不再重做）

- `packDiaryMaterial`：预算 5500、完整 JSON、`min_diary_importance`、全低分 Top3 回退  
- 打包排序：`__day_cluster__` > `source=model` > importance  
- `buildDiary`：模型失败 → 半包重试 → 模板；`context.write.fail_reason` + pack meta  
- Nightly 顺序：重算纪要 → L1 → L2 → 日记  
- UI：模型/模板/补写 chip；模板时解释 fail_reason  

**本规划不重复 E0–E4。**

---

## 2. 范围与不做

**做**

- 忙天选料：有簇修时日记材料以 L2+L1 为主，L0 只补洞  
- 成文：按「日记日」取情绪；提示词吃一点 self；输出长度与宿主 token 对齐  
- 韧性：巩固账有了但日记丢了能补；面板可 force 重写  
- 可观测：打包构成（簇/精修/规则各几条）、retry、dropped 上 UI  

**不做**

- 取消规则模板保底  
- 每段纪要再调一次模型写日记（线性烧钱）  
- 用日记反写纪要  
- 上独立「日记产品」式多媒体/日历社交（Day One 全功能）

---

## 3. 主流对照（只比「中间层→日日记/摘要」）

| 产品 | 输入 | 成文怎么做 | 忙天 | 相对你们 | 对齐点 |
|------|------|------------|------|----------|--------|
| **你们现在** | T2 三级纪要 | 打包→1～2 次 summarize / 模板 | 排序优先簇，但仍塞高分 L0 | — | 选料再收紧；补写/UI |
| **Day One** | 人已写好的日记条 | 点一下才 AI 摘要；条数/字数上限 | 超限丢掉可预期 | 输入已是日记，更易 | **预算公开 + 超限行为可预期**（你们已有预算，差展示） |
| **Reflectly / Daylio** | 结构化心情+标签 | 模板/轻模型成篇 | 输入本身短 | 偏情绪打卡 | **补写要用「当日」情绪** |
| **Replika Journal** | 聊天印象 | 感想向日记 | 抽卡不复述全文 | 少「事件流水」 | 你们更偏事件；可学口吻一致性 |
| **ChatGPT / 记忆摘要** | 线程压缩 | 滚动摘要保续聊 | 保窗口不保「一天一篇」 | 不是日记产品 | 不学成文形态 |
| **Mem0 dream / digest** | 批量记忆 | 夜间合并 | 批处理 | 偏事实库 | **夜巡一次成文**你们已有 |
| **Notion AI / Apple Journal** | 选中条目 | 按选中摘要 | 人先选料 | 选料是人 | **自动选料 = 你们的簇+精修** |

**能打**：事件向日日记 + 自动选料 + 无模型可降级——比纯感想日记和「人先写完再摘要」更难，你们骨架已在。  
**还差**：忙天材料纯度、补写时间对齐、成文可观测/可重写——本规划补这些。

---

## 4. 批次总览

| 批 | 主题 | 预估 | 依赖 |
|----|------|------|------|
| **D0** | 对账指标：打包构成写入 meta；巩固 step 可见 | 0.3 天 | 现有 pack |
| **D1** | 忙天选料策略：有簇则 L0 严进；参数可配 | 0.5 天 | L2、pack |
| **D2** | 成文品质：日情绪、提示词、长度/token | 0.5～1 天 | D1 可并行 |
| **D3** | 韧性：缺日记补写、UI force、失败可懂 | 0.5 天 | buildDiary |
| **D4** | 文档 + 抽检（模型日记可读、模板不胡说） | 0.3 天 | D1–D3 |

---

## 5. 各批细节

### D0 · 打包对账（看得见）

**做**

1. `pack.meta` 增加：`n_cluster` / `n_model` / `n_rules` / `chars` / `dropped_episodes` / `fallback_low`（能算的都写上）  
2. `consolidation` 的 diary step 带回上述计数  
3. 单测：忙天夹具 meta 字段齐全  

**验收**

- [x] 巩固记录或 diary.context.write.pack 能看出「日记到底吃了几条簇/精修/规则」（`diary-pack` + nightly diary.pack）

### D1 · 忙天选料（主品质杠杆）

**做**

1. 参数 `memory.diary.prefer_cluster=on`（默认 on）  
   - 当日存在 `__day_cluster__`（或 `opt.chapters`）时：默认池 = 簇 + `source=model`；L0 仅当池字符 &lt; 预算×α（如 0.55）再按 importance 补  
2. 参数 `memory.diary.l0_fill_ratio`（默认 0.45）控制最多补多少预算给 L0  
3. 无簇修：行为与今相同（高分 L0+L1）  

**验收**

- [x] 有簇夹具：进包簇条数 ≥1；L0 条数受 fill_ratio 约束  
- [x] 无簇：回归不烂（`tiers`/`episode-stress`）  
- [x] 关 prefer_cluster：≈当前行为  

### D2 · 成文品质

**做**

1. **日情绪**：补写/force 时优先用该 `day` 的 affect 快照（若有 episode.mood / 当日 affect 日志）；没有再退当前 `affect_state`，并在 context 标 `mood_source=live|day`  
2. **提示词**：`diarySystemPrompt` 轻带 1 行 self（价值观/关系称呼已有 otherName；勿塞整段 JSON 说教）  
3. **长度**：`clean.slice(0,1600)` 与宿主 diary `maxTokens` 对齐检查；尽量在句号处截断；过短判 `too_short` 已有  
4. （可选）两段式：先 5 条 bullet outline（仍用同一 summarize 预算内）再散文——默认 off，防加倍调用  

**验收**

- [x] late=1 夹具：`mood_source` 可观测；有日数据时不误用「今天」心情讲昨天  
- [x] 截断优先句号（`clipDiaryBody` 单测）  
- [ ] 实库模型日记人工抽检（上线后；两段式仍默认 off）

### D3 · 韧性与操作

**做**

1. `runNightly`：若 consolidation 已做过但 **无日记行** 且有原料 → 仍跑 diary（或 `repairDiary`），不整日 skip  
2. API/UI：日记页「按当前纪要重写」→ `force: true`（二次确认）  
3. UI：展示 pack 摘要（簇×N · 精修×N · 规则×N · 若 retry）  

**验收**

- [x] 删掉日记行再 nightly（无 force 整日）：能补回日记  
- [x] 面板 force / `POST diaries/rewrite` 后 version+1  
- [x] 用户能看到为何是模板以及材料构成（chips）

### D4 · 文档与抽检

**做**

1. `memory-layers.md` §日记：写清选料策略与 prefer_cluster  
2. 实库抽 5 天：2 忙天模型篇 + 2 普通 + 1 模板降级——清单勾选  
3. 与 `episode-plan-v1` 交叉链接（E 做原料，D 做成文）  

**验收**

- [x] 文档与参数一致  
- [x] 自动化夹具：`test/diary-pack.test.mjs`（22）  
- [ ] 实库 5 天人工抽检（插件在线带模型时）

---

## 6. 风险与回滚

| 风险 | 缓解 |
|------|------|
| 簇修失败导致日记过空 | 无簇时回退现行高分 L0；fill_ratio 保底 |
| 日情绪表缺失 | mood_source=live；不阻塞成文 |
| force 误触 | UI 二次确认；version 可追溯 |
| 模型仍写成流水账 | D1 减噪比改 prompt 更有效；prompt 只微调 |

回滚：`memory.diary.prefer_cluster=off` → 选料回到 E1 行为。

---

## 7. 建议拍板

1. **「按 D0+D1 做」** → 先把忙天日记材料纯度拉起来（推荐）  
2. **「继续 D2」** → 成文口吻与补写心情  
3. **「继续 D3」** → 可修可重写  
4. **「D4」** → 收口  

预估合计约 **2～2.5 天**；D0∥D1 可一天内落地主收益。
