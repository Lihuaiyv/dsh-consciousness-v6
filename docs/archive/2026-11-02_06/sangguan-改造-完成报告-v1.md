# 三观改造 · 完成报告 v1（2026-11-03）

> 一句话：三列各有各的判据、各有各的生长路径，共用一个只增的史；草稿要人批才入库；注入只带核心三条 + 按情境召回的两条。
>
> 计划：[sangguan-改进计划-v2-代码级.md](sangguan-改进计划-v2-代码级.md)

---

## 1. 做完了什么

| 步 | 内容 | 状态 |
|---|---|---|
| 0.1 | `persona_claims.meta_json` 加列（幂等 ALTER） | ✅ |
| 0.2 | 目录扩 `DERIVES` 边与 `invest` 证据 | ✅ |
| 0.3 | `meta.js`：白名单清洗、缺省补全、可检验性判定 | ✅ |
| 0.4 | 清库：先作废悬空 ν 再收回命题；活库实清 7 条 | ✅ |
| 1.1 | `gateW / gateL / gateV` + 按层分派；默认全关 | ✅ |
| 1.2 | 世界观夜巡批量归纳（J30 + `runLaneW`） | ✅ |
| 1.3 | 人生观周章 + 投入证据（J31 + `runLaneL`） | ✅ |
| 1.4 | 生长序死锁修正：只拦 W 立核心，不拦保护带 | ✅ |
| 2.1 | J32 反事实标注 / J33 起草 | ✅ |
| 2.2 | `draft.js`：按放弃物聚类、五道闸、人批入库 | ✅ |
| 3.1 | `recall.js`：每层一核心 + 按句召回 ≤2 条 | ✅ |
| 3.2 | `constitution.js`：三条核心压成 ≤400 token | ✅ |
| 3.3 | `inject.js`：三列打开时走「宪章 + 召回」，关着逐字不变 | ✅ |
| 4.1 | 合并（只增：新建 + 收回 + variants）与 `DERIVES` 推导边 | ✅ |
| 5.x | 页面三列 / 三个数搬走 / 旧管线收口 | ⬜ 未做 |
| 2.3 | 草稿的 HTTP 接口（`GET /drafts`、`POST /commit`） | ⬜ 未做 |

---

## 2. 数据对比

### 2.1 活库（agt_3977d80f17）

| 项 | 改造前（今早） | 改造后（清退 + 备份） |
|---|---|---|
| 活跃命题 | W 1 · L 3 · V 2 | W 0 · L 1 · V 0 |
| W 那条 | 「主动搭话被额度/沉默门/打扰成本三道门拦下」——系统描述 | 已收回 |
| L 那三条 | 2 篇日记原文 + 1 句「汐是潮水…」 | 日记原文收回；**「潮水」那句保留** |
| V 那两条 | 「排查问题先核对」+ 1 条「我答应…」 | 全部收回 |
| 悬空预见（指向退休命题） | 5 条 pending | **0 条** |
| 每条命题的判据 | 只有一套「像不像立场」 | 三套（预测力 / 解释力+投入 / 排除力+代价） |
| 字段 | 无场景、无预期、无代价 | `meta_json` 可带 10 类字段 |
| 备份 | — | `app.db.bak-prune-20261103033650` |

### 2.2 端到端模拟（`test/sangguan-lanes-e2e.test.mjs`）

| 项 | 改造前（同一套料） | 改造后 |
|---|---|---|
| W | 0 条（只能抽到工程句） | 1 条，带三个场景 + 可检验预期 + ν |
| L | 0 条（日记不进） | 1 章，带方向 + 两天投入证据 |
| V | 0 条（没有取舍） | 1 条，过五道闸、人批后入库 |
| 注入 | 每层 3 条链头，最多 9 条 | 核心 3 行 + 召回 ≤2 行，**48 token**（预算 160） |
| 三列是否分得开 | 否（layer 只是标签） | 是（判据、进料、验证都不同） |

---

## 3. 文件

新增：

```
src/modules/sangguan/meta.js            扩展字段清洗与默认
src/modules/sangguan/lanes.js           W 夜巡归纳 / L 周章 + 投入
src/modules/sangguan/draft.js           聚类、五道闸、人批入库
src/modules/sangguan/recall.js          核心选择 + 按句召回
src/modules/sangguan/constitution.js    常驻三行
src/modules/sangguan/merge.js           合并与 DERIVES
scripts/sangguan-draft.mjs              取料（昨日已有）
```

改动：

```
schema.js     + meta_json 列（幂等）
ledger.js     命题可带 meta；证据收 invest；错误文案
fold.js       命题创建时带上 meta
projection.js 读回 meta
catalog.js    EDGE_TYPES + DERIVES；EVIDENCE_KINDS + invest
theta.js      + w_invest
gates.js      三列闸 + 分派（默认关）
config.js     lanes 开关（默认全关）
night.js      夜里跑 laneW / laneL，失败不影响整夜
fast.js       命题带 meta；移除会死锁的 W 拒绝；按层分派
inject.js     三列打开时走宪章 + 召回
index.js      把这一句传给注入（取不到就退回旧行为）
retire.js     收回命题时先作废悬空 ν
scripts/sangguan-prune-facts.mjs  --lanes / --ids / --keep，先 void 再 retire
```

---

## 4. 测试

`npm run test:sangguan`：**45 套全绿**。新增 9 套、166 项：

| 测试 | 项数 | 管什么 |
|---|---|---|
| `sangguan-meta-json` | 19 | 加列、清洗、落库、重建不丢、DERIVES/invest 可入账 |
| `sangguan-retire-nu` | 11 | 先作废悬空 ν 再收回；重复执行安全；核心不可收回 |
| `sangguan-lanes-gate` | 29 | 三套闸正反例；不串列；开关默认关、非布尔不开 |
| `sangguan-lane-w` | 17 | 夜巡归纳、拒收留账、自动挂 ν、幂等、预算不足不写 |
| `sangguan-lane-l` | 15 | 周章、投入跨度、无证据拒收、幂等 |
| `sangguan-draft` | 24 | 放弃物归类、聚类、五道闸、人批入库 |
| `sangguan-recall` | 22 | 相似度、核心选择、按句召回、宪章预算、注入接线 |
| `sangguan-merge` | 12 | 合并只增、variants、悬空 ν、推导边方向 |
| `sangguan-lanes-e2e` | 17 | 全链路：经历 → 三列 → 草稿 → 宪章 → 注入 |

原有 1086 项一条没掉。长模拟：G3 300 天 20/20、G4 200 天 26/26。

全项目 `node test/run-tests.mjs`：**546 / 546**，退出码 0。

---

## 5. 怎么打开

三列默认全关，关掉时行为与改造前逐字一致：

```
PUT /v1/agents/:id/sangguan/config
{ "lanes": { "W": true, "L": true, "V": true } }
```

建议顺序：先只开 W，跑一周看它能不能从经历里归纳出一条「世界看法」；再开 L（需要至少两周的真实日记与投入）；V 一直可用。

注入仍是 shadow：`inject: "shadow"`，只记录会注入什么。要看效果用技术视图的注入预览，或 `GET /sangguan/inject/preview`。

**改的是服务端模块，要重启 DSH 才生效。**

---

## 6. 还没做 / 已知边界

1. **页面没动**：三观页还是三层竖排，顶部三个数还在。要改成三列、把三个数搬去「靠谱度」。
2. **草稿没有 HTTP 口**：现在只能 `node scripts/sangguan-draft.mjs` 出料，`draft.js` 在代码里可用，但页面上点不了。
3. **召回第二拍没接模型**：现在只有字面二元组，语义相近但用词不同的句子会漏。下一步接 J34（只回编号），并进情绪/关系那一步，不单独加调用。
4. **快环仍会产 W/L 候选**：lanes 打开时会被三套闸拒收（正确行为），但还没把 J1 的 W/L 抽掉；这一步放在页面收口一起做。
5. **月审指标没落库**：被违反次数、边界触发、人改字数还没进 eval。
6. **合并目前只做 V 层**：W/L 的合并等有足够条目再说。

---

## 7. 这次发现并修掉的设计问题

| 问题 | 表现 | 修法 |
|---|---|---|
| 生长序死锁 | V 空 → W 不进 → V 又需要取舍才长 | 只拦 W 立核心；加「两次结算 + 一次 miss」的出路 |
| W 的预见退化成 V | 预期写成「我下次先听完」 | 闸里拒「我…」开头；必须有 observe |
| 置信度与 π 重复 | 同一件事两个数 | 不新增 confidence，用 π 与连续命中 |
| 合并要 UPDATE | 命题表有只增触发器 | 新建一条 + 收回旧的 + variants |
| 清退留悬空 ν | 预见指向退休命题 | 同批先 NU_RESOLVE(void) 再 RETIRE |
| 注入预算装不下 | 160 字装「核心 3 + 召回 2」 | 实测 48 token，够用；超了先丢召回 |
| 工程词一票否决 | 「数据不对就重跑」被误杀 | G4 只用窄的任务词表 |
| 场景计数要向量 | claim 没有 embedding | 归纳挪到夜巡，复用 episode，不存向量 |
