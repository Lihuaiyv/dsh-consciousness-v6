# 概览「它的想法」优化规划 v1

> 拍板：全部采纳——热度对齐 · 四问定向配额 · 补 T2/T3 · 降噪截断 · 提前刷新 + 手动重想  
> 原则：和分层记忆 / 自述同一套「什么重要」；改完 prompt 文案与实现一致；省 token、不半吊子接线。

---

## 0. 范围与不做

**做**

- 重写 `pickMemories`：用 `heat` / `band` / `mark`，排除失效与冲突中条目。
- 四问（self / other / world / want）分桶配额，再拼进 prompt。
- `gather` 补近几天日记（T3）+ 若干纪要（T2，含 open_loops）。
- 按 band 调条数与截断长度；prompt 文案改成真话。
- 提前标 stale 的触发条件；`POST /thoughts` 强制刷新；概览加「重新想一遍」。
- `selfview` 共用新挑选逻辑（已 import `pickMemories`），行为跟着变。

**不做**

- 不上向量检索专门给想法用（仍走账本打分 + 规则配额）。
- 不改四问产品语义（还是自己 / 对方 / 世界 / 想做的事）。
- 不把想法写进 `memory_items`（仍只读展示、落 `thoughts` 表）。
- 不改嘀咕（mutter）链路。

---

## 1. 产品语义（本版冻结）

| 点 | 本版行为 |
|----|----------|
| 四问 | `self` / `other` / `world` / `want`；`other` 标签仍跟 `style.address` |
| 素材真源 | T1 热度账本 + T2 近纪要 + T3 近日记；T4 原文不碰 |
| 打分 | 现算 `heatOf`，不盲信库里过夜快照；`locked` 优先 |
| 配额 | 先按四问定向取，再按 type 轮转补齐；总 cap 仍受 `DSHC_THOUGHTS_MEM` |
| 刷新 | 默认仍 30 天；满足触发条件可提前 stale；UI/API 可强制重生成 |
| 失败 | 模型挂或解析失败 → 现有 `FALLBACK` 模板，界面永不空 |

---

## 2. 批次总览

| 批 | 主题 | 预估 | 依赖 |
|----|------|------|------|
| T0 | 挑选内核：热度 + 过滤 + band 配额 | 0.5d | 无 |
| T1 | 四问定向桶 + prompt / 截断 | 0.5d | T0 |
| T2 | 补日记 / 纪要进 gather | 0.3d | T0 |
| T3 | 提前刷新 + POST + 概览按钮 | 0.4d | T1 |
| T4 | 验收 / 文案 / 调试开关 | 0.2d | 前面 |

建议顺序：**T0 → T1 → T2 → T3 → T4**（T2 可与 T1 并行，但 prompt 合并一次改完更干净）。

---

## 3. 分批明细

### T0 · 挑选内核

| ID | 任务 | 文件 | 做法 |
|----|------|------|------|
| T0.1 | SQL 对齐分层读法 | `thoughts.js` | `SELECT` 带上 `importance,salience,hits,last_hit_at,heat,band,mark,weight,created_at`；条件加 `invalid_at IS NULL` |
| T0.2 | 排除冲突中记忆 | `thoughts.js` + 必要时 `conflict.js` 小查询 | open conflict 两侧 id 进黑名单，不入素材 |
| T0.3 | 用 `heatOf` 打分 | `thoughts.js` | `import { heatOf, bandOf } from './tiers.js'`；`score = heat`（现算）；`mark==='locked'` 强制进 short 优先队列 |
| T0.4 | band 配额 | `thoughts.js` | 默认 cap=22 时：short≈12 / mid≈7 / long≈3（按比例缩放）；钉住不占 long 名额 |
| T0.5 | 保留 type 轮转作补齐 | `thoughts.js` | 定向桶（T1）取完后，不足再用「按 type 轮转 + 总分」补到 cap |

**验收**：同一 agent，新挑选结果里不应出现 `invalid_at` 非空或 open conflict 条目；locked 条应稳定出现在前列。

---

### T1 · 四问定向 + prompt

| ID | 任务 | 文件 | 做法 |
|----|------|------|------|
| T1.1 | 定义四问启发式 | `thoughts.js` | 见 §4 配额表；每问目标 4～6 条（随 cap 缩放），允许跨问复用同一条但 prompt 里只列一次 |
| T1.2 | `pickMemories` 返回 enriched | `thoughts.js` | 每条带 `bucket` 提示（可选）/`band`/`heat`/`at`；`selfview` 忽略多余字段即可 |
| T1.3 | 截断统一 | `thoughts.js` | prompt 行：short 120 / mid 90 / long 60 字；去掉「flat 400 vs prompt 90」两套口径打架 |
| T1.4 | 改 system/user 文案 | `prompt()` | 删掉假「分层」口号；写明：热度账本 + 四问配额 + 近日记/纪要；每字段仍 40～90 字口语 |

**验收**：模型输入里四问相关类型都有代表；边界/钉住类优先进 `self`/`want`；技术视图或 debug 能看到来源说明。

---

### T2 · 补 T2 / T3

| ID | 任务 | 文件 | 做法 |
|----|------|------|------|
| T2.1 | 近日记 | `thoughts.js` → `archive.recentDiaryLines` 或等价 | 最近 **3** 天日记，总字符预算约 400（可调） |
| T2.2 | 近纪要 | `listEpisodes(db,aid,{limit:6})` | 取 title + summary 截断 + `open_loops`（最多列 3 个未闭环） |
| T2.3 | 写入 `gather` / `prompt` | `thoughts.js` | 独立两小节：「近几天日记」「最近纪要/未了之事」；无数据则省略，不占空行噪音 |

**验收**：有日记/纪要的 agent，生成素材里能看见日期行与 open_loops；无数据时行为与现在一致、不报错。

---

### T3 · 刷新策略 + API + UI

| ID | 任务 | 文件 | 做法 |
|----|------|------|------|
| T3.1 | `shouldRefresh(db,aid,latest)` | `thoughts.js` | 除「超过 `intervalDays()`」外，任一成立则 stale：① 最新 `memory_items` 创建晚于 thoughts 且 heat 现算 ≥ 0.55；② 情绪 `primary_label` 相对生成时快照变化（见 T3.2）；③ `style.address` 变更；④ 关系人数或最高 closeness 明显变（阈值：相对 thoughts 行存的快照，见下） |
| T3.2 | 快照列或 flags | `db.js` / `thoughts` 写入 | 生成时把 `{affect_label, address, rel_sig, mem_max_created}` 写入 thoughts 行扩展：优先 `payload TEXT` 新列（ALTER IF NOT EXISTS）；避免另起表 |
| T3.3 | `POST /v1/agents/:id/thoughts` | `api.js` | 调已有 `generateNow`；返回与 GET 同形；生成中防重入（沿用 `running` Set） |
| T3.4 | 概览按钮 | `client.js` Overview「它的想法」 | 仿自述：次要按钮「重新想一遍」→ POST → 进入 generating 轮询；tech 视图仍显示 updated_at / source / interval |

**触发条件细则（冻结）**

| 条件 | 阈值 | 备注 |
|------|------|------|
| 周期 | ≥ `DSHC_THOUGHTS_DAYS`（默认 30） | 现状保留 |
| 高热新记忆 | 存在 `created_at > thoughts.created_at` 且 `heatOf≥0.55` | 钉住也算 |
| 情绪跳变 | `primary_label` ≠ 快照 | 强度抖动不触发，只看 label |
| 称呼变更 | `style.address` ≠ 快照 | other 标题也会变 |
| 关系签名 | `count + max(closeness)` 相对快照变化 | 简单字符串/数字即可 |

**验收**：改称呼后打开概览会重新生成；点「重新想一遍」立刻 generating；30 天内无大事不刷。

---

### T4 · 收尾

| ID | 任务 | 文件 | 做法 |
|----|------|------|------|
| T4.1 | 模块头注释 / catalog 文案 | `thoughts.js`、必要时 `catalog.json` | 与实现一致 |
| T4.2 | `DSHC_THOUGHTS_DEBUG=1` | `thoughts.js` | debug 带回：条数、band 分布、是否含 diary/episode、刷新原因 |
| T4.3 | 手工验收清单 | 本文件 §6 | 跑通后勾选 |

---

## 4. 四问配额表（冻结）

总 cap 默认 22；下列为「目标条数」，随 cap 线性缩放，下限每桶至少 1（有料时）。

| 桶 | 目标 | 优先 type / 信号 | 次优先 |
|----|------|------------------|--------|
| `self` | 5 | appraisal, preference, 高 salience, locked | reflection |
| `other` | 5 | 文本含称呼/`you`、关系人名；fact/episode | preference 里「对你…」 |
| `world` | 4 | episode、外向 fact（少第一人称对象） | appraisal 偏环境 |
| `want` | 5 | open_loops 映射记忆、boundary、承诺口吻、近期未了结 | 高 drive 相关 appraisal |
| 补齐 | 剩余 | type 轮转 + heat 降序 | — |

T2/T3 **不计入** 22 条 T1 cap，单独预算：

| 源 | 条数/字符 | 用途 |
|----|-----------|------|
| 日记 | ≤3 天，合计 ≈400 字 | 叙事背景 → 主要喂 `self`/`want` |
| 纪要 | ≤6 段，每段 title+summary≤80 字；open_loops≤3 | 未了之事 → 主要喂 `want`/`world` |

---

## 5. 接口与参数

| 项 | 约定 |
|----|------|
| `GET .../thoughts` | 不变；`status`: fresh / stale / generating；多返回 `refresh_reason`（可选，tech/debug） |
| `POST .../thoughts` | **新增**；强制 `generateNow` |
| `DSHC_THOUGHTS_DAYS` | 仍默认 30 |
| `DSHC_THOUGHTS_MEM` | 仍默认 22，硬顶 60 |
| 新 env（可选） | `DSHC_THOUGHTS_DIARY_DAYS=3`、`DSHC_THOUGHTS_EP_LIMIT=6` |

---

## 6. 验收清单

- [x] 失效记忆、open conflict 两侧不进素材  
- [x] locked / 高 heat 稳定进前列；long 不被刷屏  
- [x] 四段想法能分别沾上对应桶的细节（有足够记忆时）  
- [x] 有日记/纪要时 prompt 含日期与 open_loops；没有时安静省略  
- [x] 改 `style.address` 或高热新记忆后，打开概览会重新生成  
- [x] 「重新想一遍」→ POST → 轮询 → 四段更新；失败仍有 FALLBACK  
- [x] `selfview` 仍可调用 `pickMemories`，无报错  
- [x] prompt 文案不再谎称「分层」却只按 weight  
- [x] 轻哲学：四段对上「我是谁 / 对面是谁 / 世界怎样 / 还想要什么」，禁止引经据典  

> 自动化：`npm run test:thoughts` + `run-tests.mjs` 想法段。

---

## 9. 修补批 F（全修）

| ID | 项 | 状态 |
|----|----|------|
| F1 | affect/heat/relation 24h 冷却（`DSHC_THOUGHTS_COOLDOWN_H`） | ✅ |
| F2 | 关系真源 `rel_person` → 回落 `relations` | ✅ |
| F3 | other 桶只认具体称呼/人名 | ✅ |
| F4 | `inflight` Promise：GET/POST 不双跑 | ✅ |
| F5 | locked 或 heat≥0.55，受 F1 冷却 | ✅ |
| F6 | selfview 传 `you`/`relNames` | ✅ |
| F7 | 同 agent 只留最近 20 条 thoughts | ✅ |
| F8 | `total` = 可参选（扣冲突） | ✅ |
| F9 | env 热读 `memLimit`/`cooldownHours`/… | ✅ |
| F10 | tech 文案「触发」 | ✅ |


---

## 7. 风险与回滚

| 风险 | 缓解 |
|------|------|
| heat 列为空的老数据 | `heatOf` 纯函数现算，不依赖列；importance 缺省走 weight |
| 提前刷新太勤烧 token | 阈值偏严；强制刷新才无视周期；running Set 防并发 |
| 关系/人名匹配误伤 | other 桶启发式失败时退回 type 轮转，不空桶 |
| DB 加 `payload` 列 | `ALTER` try/catch；读端兼容无列 |

回滚：恢复旧 `pickMemories` + 去掉 POST/按钮即可；`thoughts` 历史行可留。

---

## 8. 建议操控口令

- 「做 T0」——只改挑选内核  
- 「做 T0–T2」——素材侧一次做完（推荐第一刀）  
- 「做 T3」——刷新与按钮  
- 「按 thoughts-plan-v1 全做」——T0→T4 一次落地  
`}
